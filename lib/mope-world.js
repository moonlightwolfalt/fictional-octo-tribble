// lib/mope-world.js — a small game world for the archived mope.io client.
//
// The real 2017 server code was never published, so this is a stand-in built
// from what client.js reads. It generates a map with the three biomes the
// client knows how to draw, streams objects to each player's view, and lets
// you spawn as a mouse, run around, drink and eat.
//
// Map layout (what client.js's minimap expects):
//
//   +--------------------------------------+  y = 0
//   |               ARCTIC                 |
//   +-------+----------------------+-------+  y = ARCTIC_H
//   |       |                      |       |
//   | OCEAN |         LAND         | OCEAN |
//   |       |                      |       |
//   +-------+----------------------+-------+  y = MAP_H
//   0    OCEAN_W            MAP_W-OCEAN_W  MAP_W
//
// All numbers on the wire are big-endian. Positions/radii are sent x4 (u16),
// update radii x10, zoom x1000.

"use strict";

// --- object types (from client.js's draw code) -----------------------------
const T = {
  BERRY: 3,          // small green circle
  PLANKTON: 4,       // small blue circle (ocean food)
  MUSHROOM: 5,       // red circle
  ANIMAL: 2,         // players
  HOLE: 9,           // brown burrow (mouse hole)
  HILL: 10,          // green bobbing hill
  MUD: 11,           // brown mud pool
  BIG_HOLE: 13,      // larger burrow
  KELP: 25,          // green ocean plant
  LAKE: 22,          // blue lake
  OCEAN: 19,         // ocean rectangle (rectW/rectH)
  ARCTIC: 27,        // arctic rectangle (rectW/rectH)
  ARCTIC_LAKE: 28,   // icy lake
};

const ANIMAL_MOUSE = 1;

const MAP_W = 6000;
const MAP_H = 6000;
const OCEAN_W = 800;
const ARCTIC_H = 1200;

const TICK_MS = 150;            // client interpolates over 175 ms
const SPEED = 230;              // world units / second for a mouse
const RUN_BOOST = 1.45;
const PLAYER_RAD = 22;
const PLAYER_ZOOM = 1.3;
const SPECTATOR_ZOOM = 0.8;
const VIEW_MARGIN = 250;
const XP_PER_LEVEL = 100;       // client shows "100 xp Next Animal"; upgrades aren't implemented

// --- binary writer -----------------------------------------------------------

class Writer {
  constructor(size = 256) {
    this.buf = Buffer.alloc(size);
    this.len = 0;
  }
  _need(n) {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  u8(v) { this._need(1); this.buf.writeUInt8(clampInt(v, 0, 0xff), this.len); this.len += 1; return this; }
  u16(v) { this._need(2); this.buf.writeUInt16BE(clampInt(v, 0, 0xffff), this.len); this.len += 2; return this; }
  u32(v) { this._need(4); this.buf.writeUInt32BE(clampInt(v, 0, 0xffffffff), this.len); this.len += 4; return this; }
  // Server->client strings: u16 length + UTF-8 bytes + a NUL terminator that
  // the length counts. client.js's readString drops the last byte it reads,
  // so without the terminator every name loses its final letter. (Strings the
  // client sends to us have no terminator; see Reader.str.)
  str(s) {
    const b = Buffer.from(String(s), "utf8").subarray(0, 0xfffe);
    this.u16(b.length + 1);
    this._need(b.length + 1);
    b.copy(this.buf, this.len);
    this.len += b.length;
    this.buf[this.len++] = 0;
    return this;
  }
  // reserve a u16 to fill in later (for counts)
  placeholder16() { const at = this.len; this.u16(0); return at; }
  patch16(at, v) { this.buf.writeUInt16BE(clampInt(v, 0, 0xffff), at); }
  done() { return this.buf.subarray(0, this.len); }
}

function clampInt(v, lo, hi) {
  v = Math.round(Number(v) || 0);
  return v < lo ? lo : v > hi ? hi : v;
}

class Reader {
  constructor(buf) { this.buf = buf; this.off = 0; }
  get left() { return this.buf.length - this.off; }
  u8() { if (this.left < 1) return 0; return this.buf.readUInt8(this.off++); }
  u16() { if (this.left < 2) return 0; const v = this.buf.readUInt16BE(this.off); this.off += 2; return v; }
  i16() { if (this.left < 2) return 0; const v = this.buf.readInt16BE(this.off); this.off += 2; return v; }
  str() {
    const n = this.u16();
    const s = this.buf.subarray(this.off, this.off + n).toString("utf8");
    this.off += n;
    return s;
  }
}

// --- geometry ----------------------------------------------------------------

const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

const BIOME = {
  land: { x0: OCEAN_W, x1: MAP_W - OCEAN_W, y0: ARCTIC_H, y1: MAP_H },
  arctic: { x0: 0, x1: MAP_W, y0: 0, y1: ARCTIC_H },
  oceanL: { x0: 0, x1: OCEAN_W, y0: ARCTIC_H, y1: MAP_H },
  oceanR: { x0: MAP_W - OCEAN_W, x1: MAP_W, y0: ARCTIC_H, y1: MAP_H },
};

function biomeAt(x, y) {
  if (y < ARCTIC_H) return "arctic";
  if (x < OCEAN_W || x > MAP_W - OCEAN_W) return "ocean";
  return "land";
}

function randomIn(area, pad) {
  return { x: rand(area.x0 + pad, area.x1 - pad), y: rand(area.y0 + pad, area.y1 - pad) };
}

// --- world -------------------------------------------------------------------

class World {
  constructor({ name = "mope.io", log = console.log } = {}) {
    this.name = name;
    this.log = log;
    this.nextId = 1;
    this.objects = new Map(); // id -> object
    this.clients = new Set();
    this.timer = null;
    this.tickNo = 0;
    this._generate();
  }

  // ---- map generation ----

  _add(o) {
    o.id = this.nextId++;
    this.objects.set(o.id, o);
    return o;
  }

  // Place a round object inside `area`, not overlapping existing features.
  _place(type, area, rad, { avoid = true, food = false } = {}) {
    for (let tries = 0; tries < 40; tries++) {
      const p = randomIn(area, rad + 20);
      if (avoid && this._overlapsFeature(p.x, p.y, rad + 30)) continue;
      return this._add({ type, x: p.x, y: p.y, rad, static: true, food, area });
    }
    return null;
  }

  _overlapsFeature(x, y, rad) {
    for (const o of this.objects.values()) {
      if (!o.feature) continue;
      if (dist2(x, y, o.x, o.y) < (rad + o.rad) ** 2) return true;
    }
    return false;
  }

  _feature(type, area, rMin, rMax, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const o = this._place(type, area, rand(rMin, rMax));
      if (o) { o.feature = true; out.push(o); }
    }
    return out;
  }

  _generate() {
    // Biome rectangles; x/y are the rectangle's centre.
    this.arctic = this._add({ type: T.ARCTIC, x: MAP_W / 2, y: ARCTIC_H / 2, rad: 1,
      rectW: MAP_W, rectH: ARCTIC_H, static: true, always: true });
    this.oceans = [BIOME.oceanL, BIOME.oceanR].map((a) => this._add({
      type: T.OCEAN, x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2, rad: 1,
      rectW: a.x1 - a.x0, rectH: a.y1 - a.y0, static: true, always: true }));

    // Terrain features.
    this.lakes = this._feature(T.LAKE, BIOME.land, 90, 160, 12);
    this.mud = this._feature(T.MUD, BIOME.land, 90, 140, 8);
    this.hills = this._feature(T.HILL, BIOME.land, 90, 150, 16);
    this.holes = this._feature(T.HOLE, BIOME.land, 35, 45, 14);
    this._feature(T.BIG_HOLE, BIOME.land, 55, 70, 4);
    this.arcticLakes = this._feature(T.ARCTIC_LAKE, BIOME.arctic, 100, 160, 6);

    // Food, per biome.
    this.foodPlan = [
      { type: T.BERRY, area: BIOME.land, rad: 12, count: 260, xp: 8 },
      { type: T.MUSHROOM, area: BIOME.land, rad: 14, count: 50, xp: 15 },
      { type: T.BERRY, area: BIOME.arctic, rad: 12, count: 70, xp: 8 },
      { type: T.KELP, area: BIOME.oceanL, rad: 16, count: 35, xp: 12 },
      { type: T.KELP, area: BIOME.oceanR, rad: 16, count: 35, xp: 12 },
      { type: T.PLANKTON, area: BIOME.oceanL, rad: 10, count: 30, xp: 6 },
      { type: T.PLANKTON, area: BIOME.oceanR, rad: 10, count: 30, xp: 6 },
    ];
    for (const plan of this.foodPlan) {
      for (let i = 0; i < plan.count; i++) this._spawnFood(plan);
    }
    this.log(`[world] ${this.name}: generated ${MAP_W}x${MAP_H} map, ${this.objects.size} objects ` +
      `(land, ${this.oceans.length} oceans, arctic; ${this.lakes.length} lakes, ${this.hills.length} hills, ` +
      `${this.mud.length} mud, ${this.arcticLakes.length} arctic lakes)`);
  }

  _spawnFood(plan) {
    const o = this._place(plan.type, plan.area, plan.rad, { food: true });
    if (o) o.plan = plan;
  }

  // ---- connections ----

  addClient(conn) {
    const client = {
      conn, player: null, spectating: true, known: new Set(),
      screenW: 1280, screenH: 720, joined: false,
      camX: MAP_W / 2, camY: (ARCTIC_H + MAP_H) / 2,
    };
    this.clients.add(client);
    this._ensureTicking();
    return client;
  }

  removeClient(client) {
    this.clients.delete(client);
    if (client.player) this._removeObject(client.player, null);
    if (this.clients.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status() {
    const players = [...this.clients].filter((c) => c.player).map((c) => ({
      id: c.player.id, name: c.player.name, x: Math.round(c.player.x), y: Math.round(c.player.y),
      biome: biomeAt(c.player.x, c.player.y), water: Math.round(c.player.water), xp: c.player.xp,
    }));
    const counts = {};
    for (const o of this.objects.values()) counts[o.type] = (counts[o.type] || 0) + 1;
    return {
      world: this.name, map: { width: MAP_W, height: MAP_H, oceanWidth: OCEAN_W, arcticHeight: ARCTIC_H },
      connections: this.clients.size, players, objectsByType: counts,
    };
  }

  get playerCount() {
    let n = 0;
    for (const c of this.clients) if (c.player) n++;
    return n;
  }

  // [2][str name][u16 w][u16 h][u8 party][u8 ?][u8 spectate]([str partyCode])
  handleJoin(client, msg) {
    const r = new Reader(msg);
    r.u8();
    const nick = r.str().replace(/[\u0000-\u001f]/g, "").slice(0, 20);
    client.screenW = r.u16() || client.screenW;
    client.screenH = r.u16() || client.screenH;
    r.u8(); r.u8();
    const spectate = r.u8() === 1;

    if (client.player) this._removeObject(client.player, null);
    client.player = null;
    client.known = new Set(); // the client wipes its objects on join

    if (spectate) {
      client.spectating = true;
      this._sendJoin(client);
      return;
    }

    const spot = this._spawnPoint();
    client.player = this._add({
      type: T.ANIMAL, animal: ANIMAL_MOUSE, name: nick, x: spot.x, y: spot.y, rad: PLAYER_RAD,
      angle: 0, targetX: spot.x, targetY: spot.y, running: false,
      water: 100, xp: 0, client,
    });
    client.spectating = false;
    this.log(`[world] ${this.name}: "${nick || "mope.io"}" spawned as a mouse at ` +
      `(${Math.round(spot.x)}, ${Math.round(spot.y)}) in the land biome`);
    this._sendJoin(client);
  }

  handleMessage(client, msg) {
    const r = new Reader(msg);
    switch (r.u8()) {
      case 5: { // mouse position in world coordinates
        const p = client.player;
        if (p) { p.targetX = r.i16(); p.targetY = r.i16(); }
        return true;
      }
      case 17: // screen resize
        client.screenW = r.u16() || client.screenW;
        client.screenH = r.u16() || client.screenH;
        return true;
      case 21: // left click: run
        if (client.player) client.player.running = r.u8() === 1;
        return true;
      case 20: // W: ability (none for a mouse)
        return true;
      case 19: { // chat
        const text = r.str().slice(0, 60);
        const p = client.player;
        if (!p || !text) return true;
        for (const c of this.clients) {
          if (!c.known.has(p.id)) continue;
          c.conn.send(new Writer(16).u8(19).u32(p.id).str(text).done());
        }
        return true;
      }
      default:
        return false;
    }
  }

  _spawnPoint() {
    for (let i = 0; i < 50; i++) {
      const p = randomIn(BIOME.land, 120);
      if (!this._overlapsFeature(p.x, p.y, PLAYER_RAD + 20)) return p;
    }
    return { x: MAP_W / 2, y: (ARCTIC_H + MAP_H) / 2 };
  }

  // [2][1][mode][u32 myId][u16 room][u16 mapW][u16 mapH][u8 gameMode]
  // [u16 camX*4][u16 camY*4][u16 zoom*1000] + minimap when playing
  _sendJoin(client) {
    const p = client.player;
    const w = new Writer(512)
      .u8(2).u8(1).u8(p ? 1 : 2)
      .u32(p ? p.id : 0).u16(1)
      .u16(MAP_W).u16(MAP_H).u8(0);
    const cam = this._camera(client);
    w.u16(cam.x * 4).u16(cam.y * 4).u16(cam.zoom * 1000);
    if (p) this._writeMinimap(w);
    client.conn.send(w.done());
    client.joined = true;
    this._sendUpdate(client);
  }

  // Minimap: biome sizes, then 8 lists of features in 0..200 map coords.
  _writeMinimap(w) {
    const mx = (x) => (x / MAP_W) * 200;
    const my = (y) => (y / MAP_H) * 200;
    w.u16(OCEAN_W).u16(MAP_W).u16(ARCTIC_H);
    w.u16(this.lakes.length);
    for (const o of this.lakes) w.u8(mx(o.x)).u8(my(o.y)).u8(o.rad / 5);
    const dots = (list) => { w.u16(list.length); for (const o of list) w.u8(mx(o.x)).u8(my(o.y)); };
    dots(this.mud);
    dots(this.arcticLakes);
    dots(this.hills);
    dots([]); dots([]); dots([]); dots([]);
  }

  // ---- simulation ----

  _ensureTicking() {
    if (!this.timer) this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  _tick() {
    this.tickNo++;
    const dt = TICK_MS / 1000;
    for (const c of this.clients) {
      const p = c.player;
      if (!p) continue;
      this._movePlayer(p, dt);
      this._drinkAndEat(p);
    }
    for (const c of this.clients) if (c.joined) this._sendUpdate(c);
    if (this.tickNo % 7 === 0) this._sendLeaderboard();
  }

  _movePlayer(p, dt) {
    const dx = p.targetX - p.x;
    const dy = p.targetY - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 4) {
      let speed = SPEED * (p.running && p.water > 5 ? RUN_BOOST : 1);
      const biome = biomeAt(p.x, p.y);
      if (biome === "ocean") speed *= 0.6;           // mice are poor swimmers
      if (this._inside(p, this.mud)) speed *= 0.7;
      const step = Math.min(d, speed * dt, d * 0.9);
      p.x += (dx / d) * step;
      p.y += (dy / d) * step;
      p.angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (p.running) p.water = Math.max(0, p.water - 0.4);
    }
    p.x = Math.min(MAP_W - p.rad, Math.max(p.rad, p.x));
    p.y = Math.min(MAP_H - p.rad, Math.max(p.rad, p.y));
  }

  _inside(p, list) {
    return list.some((o) => dist2(p.x, p.y, o.x, o.y) < o.rad * o.rad);
  }

  _drinkAndEat(p) {
    const wet = biomeAt(p.x, p.y) === "ocean" || this._inside(p, this.lakes) || this._inside(p, this.arcticLakes);
    p.water = wet ? Math.min(100, p.water + 4) : Math.max(0, p.water - 0.35);

    for (const o of this.objects.values()) {
      if (!o.food) continue;
      if (dist2(p.x, p.y, o.x, o.y) > (p.rad + o.rad * 0.5) ** 2) continue;
      p.xp += o.plan.xp;
      this._removeObject(o, p);
      const plan = o.plan;
      setTimeout(() => this._spawnFood(plan), rand(3000, 9000));
    }
  }

  _removeObject(o, killer) {
    if (!this.objects.delete(o.id)) return;
    o.removed = true;
    o.killer = killer;
    this.pendingRemovals = this.pendingRemovals || [];
    this.pendingRemovals.push(o);
    setTimeout(() => {
      const i = this.pendingRemovals.indexOf(o);
      if (i !== -1) this.pendingRemovals.splice(i, 1);
    }, TICK_MS * 4);
  }

  _camera(client) {
    const p = client.player;
    if (p) return { x: p.x, y: p.y, zoom: PLAYER_ZOOM };
    // Spectators drift slowly around the land, like the real menu backdrop.
    const t = Date.now() / 20000;
    client.camX = MAP_W / 2 + Math.cos(t) * 1200;
    client.camY = (ARCTIC_H + MAP_H) / 2 + Math.sin(t * 0.7) * 1200;
    return { x: client.camX, y: client.camY, zoom: SPECTATOR_ZOOM };
  }

  _visible(client, cam, o) {
    if (o.always) return true;
    const halfW = client.screenW / 2 / cam.zoom + VIEW_MARGIN;
    const halfH = client.screenH / 2 / cam.zoom + VIEW_MARGIN;
    return Math.abs(o.x - cam.x) < halfW + o.rad && Math.abs(o.y - cam.y) < halfH + o.rad;
  }

  // [4][cam][flags](stats)[u16 n]{new}[u16 n]{moved}[u16 n]{removed}
  _sendUpdate(client) {
    const cam = this._camera(client);
    const p = client.player;
    const w = new Writer(2048);
    w.u8(4).u16(cam.x * 4).u16(cam.y * 4).u16(cam.zoom * 1000);
    if (p) {
      w.u8(0);                         // flags: has stats, no abilities
      w.u8(p.water);                   // water bar 0..100
      w.u32(p.xp);
      w.u8(((p.xp % XP_PER_LEVEL) / XP_PER_LEVEL) * 100);
    } else {
      w.u8(1);                         // spectating: no stats
    }

    const visibleNow = [];
    for (const o of this.objects.values()) if (this._visible(client, cam, o)) visibleNow.push(o);

    const newAt = w.placeholder16();
    let nNew = 0;
    for (const o of visibleNow) {
      if (client.known.has(o.id)) continue;
      client.known.add(o.id);
      nNew++;
      w.u8(o.type).u32(o.id).u16(o.rad * 4).u16(o.x * 4).u16(o.y * 4).u8(0);
      if (o.type === T.ANIMAL) w.u8(o.animal).str(o.name || "").u8(0);
      if (o.type === T.OCEAN || o.type === T.ARCTIC) w.u16(o.rectW).u16(o.rectH);
    }
    w.patch16(newAt, nNew);

    const movedAt = w.placeholder16();
    let nMoved = 0;
    for (const o of visibleNow) {
      if (o.type !== T.ANIMAL) continue;
      nMoved++;
      w.u32(o.id).u16(o.x * 4).u16(o.y * 4).u16(o.rad * 10);
      w.u8(o.animal).u16((((o.angle + 90) % 360) + 360) % 360);
      w.u8(o.water < 25 ? 1 << 6 : 0);  // flag_lowWat
    }
    w.patch16(movedAt, nMoved);

    const visibleIds = new Set(visibleNow.map((o) => o.id));
    const gone = [];
    for (const id of client.known) if (!visibleIds.has(id)) gone.push(id);
    const removedAt = w.placeholder16();
    for (const id of gone) {
      client.known.delete(id);
      const dead = (this.pendingRemovals || []).find((o) => o.id === id);
      const killer = dead && dead.killer && client.known.has(dead.killer.id) ? dead.killer.id : 0;
      w.u32(id).u8(killer ? 1 : 0);
      if (killer) w.u32(killer);
    }
    w.patch16(removedAt, gone.length);

    client.conn.send(w.done());
  }

  // [8][u16 myRank][u8 n]{[u16 rank][str name][u32 score]}
  _sendLeaderboard() {
    const players = [...this.clients].map((c) => c.player).filter(Boolean)
      .sort((a, b) => b.xp - a.xp);
    if (!players.length) return;
    const top = players.slice(0, 10);
    for (const c of this.clients) {
      if (!c.player) continue;
      const w = new Writer(256).u8(8).u16(players.indexOf(c.player) + 1).u8(top.length);
      top.forEach((p, i) => w.u16(i + 1).str(p.name || "mope.io").u32(p.xp));
      c.conn.send(w.done());
    }
  }
}

module.exports = { World, T, MAP_W, MAP_H, OCEAN_W, ARCTIC_H, biomeAt };
