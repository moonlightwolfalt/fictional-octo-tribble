#!/usr/bin/env node
// server.js — serve the archived mope.io snapshots, with a picker.
//
//   node server.js                     # http://localhost:8080
//   PORT=3000 node server.js
//   ARCHIVE_ROOT=archive node server.js            # where snapshots live
//   ARCHIVE_DIR=mope_archive node server.js        # add (and default to) one folder
//   DEFAULT_SNAPSHOT=arquivo-20170213 node server.js
//
// Routes:
//   /                               snapshot picker
//   /play/<snapshot>/...            that snapshot's files (start page at /play/<id>/)
//   /api/snapshots.json             snapshot details
//   /api/snapshots/<id>/manifest.json   its fetch manifest
//   /status.json                    players and worlds per snapshot
//   /ws/<snapshot>/<port>/<ip>      game/master WebSockets (see lib/mope-server.js)
//
// Archived pages also ask for absolute paths ("/assets/...", "/adblockdet/ads.js");
// those are served from the snapshot last opened, remembered in a cookie.
//
// Each snapshot's index.html is served with a WebSocket shim that reroutes the
// client's hard-coded ws://<ip>:7020 / :7500 sockets to this server, plus a
// small switcher for jumping between snapshots. No dependencies: Node built-ins.

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { acceptUpgrade } = require("./lib/websocket");
const { MopeServer, browserShim } = require("./lib/mope-server");
const { discoverSnapshots, hostRoots, publicView } = require("./lib/snapshots");
const { renderPicker, renderSwitcher } = require("./lib/picker");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const ARCHIVE_ROOT = path.resolve(__dirname, process.env.ARCHIVE_ROOT || "archive");
const EXTRA_DIR = process.env.ARCHIVE_DIR ? path.resolve(__dirname, process.env.ARCHIVE_DIR) : null;
const COOKIE = "mope_snapshot";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// --- snapshots ---------------------------------------------------------------

const snapshots = discoverSnapshots(ARCHIVE_ROOT, EXTRA_DIR ? [EXTRA_DIR] : []);
const byId = new Map(snapshots.map((s) => [s.id, s]));
const defaultId =
  (process.env.DEFAULT_SNAPSHOT && byId.has(process.env.DEFAULT_SNAPSHOT) && process.env.DEFAULT_SNAPSHOT) ||
  (EXTRA_DIR && byId.has(path.basename(EXTRA_DIR)) && path.basename(EXTRA_DIR)) ||
  (snapshots.find((s) => s.playable) || snapshots[0] || {}).id;

// One stand-in game server (and world) per snapshot, created on first use.
const gameServers = new Map();
function gameServer(id) {
  if (!gameServers.has(id)) {
    const s = byId.get(id);
    gameServers.set(id, new MopeServer({
      clientJsPath: s.client?.path,
      log: (msg) => console.log(`[${id}] ${msg}`),
    }));
  }
  return gameServers.get(id);
}

// Same naming rules mope_archive.rb uses when saving files.
function candidates(urlPath, query) {
  let p = decodeURIComponent(urlPath);
  if (p === "" || p === "/") p = "/index.html";
  if (p.endsWith("/")) p += "index.html";
  const parts = p.split("/").filter(Boolean).map((s) => s.replace(/[^\w.@-]/g, "_"));
  const out = [];
  if (query) {
    const q = [...parts];
    q[q.length - 1] += "__" + query.replace(/[^\w.-]+/g, "_");
    out.push(q);
  }
  out.push(parts);
  return out;
}

function resolveFile(snap, urlPath, query) {
  for (const root of hostRoots(snap.dir)) {
    for (const parts of candidates(urlPath, query)) {
      const file = path.join(root, ...parts);
      if (!file.startsWith(root + path.sep)) continue; // no path traversal
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch { /* try next */ }
    }
  }
  return null;
}

function cookieSnapshot(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w.-]+)`).exec(req.headers.cookie || "");
  return m && byId.has(m[1]) ? m[1] : null;
}

function refererSnapshot(req) {
  try {
    const m = /^\/play\/([\w.-]+)\//.exec(new URL(req.headers.referer || "").pathname);
    return m && byId.has(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

// --- HTTP ----------------------------------------------------------------------

function send(res, req, status, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-cache", ...extra });
  res.end(req.method === "HEAD" ? undefined : buf);
}

function serveFile(req, res, snap, file, extraHeaders) {
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  if (type.startsWith("text/html")) {
    // Shim the WebSockets before any page script runs; add the switcher at the end.
    let html = fs.readFileSync(file, "utf8");
    const shim = browserShim(`/ws/${snap.id}`);
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${shim}`) : shim + html;
    const switcher = renderSwitcher(snapshots, snap.id);
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${switcher}\n</body>`) : html + switcher;
    return send(res, req, 200, type, html, extraHeaders);
  }
  const stat = fs.statSync(file);
  res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "no-cache", ...extraHeaders });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const done = (status) => console.log(`${status} ${req.method} ${req.url} (${Date.now() - started}ms)`);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return done(405);
  }

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    send(res, req, 400, "text/plain; charset=utf-8", "Bad request\n");
    return done(400);
  }
  const p = url.pathname;
  const json = (status, obj) => { send(res, req, status, "application/json; charset=utf-8", JSON.stringify(obj, null, 2)); done(status); };

  if (p === "/" || p === "/index.html") {
    const def = byId.get(defaultId);
    const logo = def && resolveFile(def, "/img/logo.png", "") ? `/play/${def.id}/img/logo.png` : null;
    send(res, req, 200, "text/html; charset=utf-8", renderPicker(snapshots, defaultId, logo));
    return done(200);
  }
  if (p === "/healthz") return json(200, { ok: true, snapshots: snapshots.length });
  if (p === "/api/snapshots.json") return json(200, { default: defaultId, snapshots: snapshots.map(publicView) });

  let m = /^\/api\/snapshots\/([\w.-]+)\/manifest\.json$/.exec(p);
  if (m) {
    const s = byId.get(m[1]);
    const file = s && ["snapshot-manifest.json", "manifest.json"].map((f) => path.join(s.dir, f)).find((f) => fs.existsSync(f));
    if (!file) return json(404, { error: "no manifest for this snapshot" });
    send(res, req, 200, "application/json; charset=utf-8", fs.readFileSync(file));
    return done(200);
  }

  if (p === "/status.json") {
    const status = {};
    for (const [id, gs] of gameServers) status[id] = gs.status();
    return json(200, { default: defaultId, worlds: status });
  }

  m = /^\/play\/([\w.-]+)(\/.*)?$/.exec(p);
  if (m) {
    const snap = byId.get(m[1]);
    if (!snap) {
      send(res, req, 404, "text/plain; charset=utf-8", `No snapshot called ${m[1]}\n`);
      return done(404);
    }
    if (!m[2]) {
      res.writeHead(302, { Location: `/play/${snap.id}/${url.search}` });
      res.end();
      return done(302);
    }
    let file = null;
    try { file = resolveFile(snap, m[2], url.search.slice(1)); } catch { /* bad %-encoding */ }
    if (!file) {
      send(res, req, 404, "text/plain; charset=utf-8", `Not in the archive: ${m[2]}\n`);
      return done(404);
    }
    serveFile(req, res, snap, file, { "Set-Cookie": `${COOKIE}=${snap.id}; Path=/; SameSite=Lax` });
    return done(200);
  }

  // Absolute paths asked for by an archived page: use the snapshot it came from.
  const snapId = refererSnapshot(req) || cookieSnapshot(req);
  const snap = snapId && byId.get(snapId);
  let file = null;
  if (snap) {
    try { file = resolveFile(snap, p, url.search.slice(1)); } catch { /* bad %-encoding */ }
  }
  if (!file) {
    send(res, req, 404, "text/plain; charset=utf-8", `Not found: ${p}\n`);
    return done(404);
  }
  serveFile(req, res, snap, file, {});
  done(200);
});

// --- game / master servers over WebSocket ------------------------------------

server.on("upgrade", (req, socket, head) => {
  const p = req.url.split("?")[0];
  // /ws/<snapshot>/<port>/<ip>, or the older /ws/<port>/<ip> for the default snapshot
  let m = /^\/ws\/([\w.-]+)\/(\d+)\/(\d{1,3}(?:\.\d{1,3}){3})\/?$/.exec(p);
  let id = m && m[1];
  let port = m && m[2];
  let ip = m && m[3];
  if (!m) {
    m = /^\/ws\/(\d+)\/(\d{1,3}(?:\.\d{1,3}){3})\/?$/.exec(p);
    if (m) [id, port, ip] = [defaultId, m[1], m[2]];
  }
  if (!m || !byId.has(id)) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const conn = acceptUpgrade(req, socket, head);
  if (conn) gameServer(id).handle(conn, port, ip);
});

if (!snapshots.length) {
  console.error(`No snapshots found in ${ARCHIVE_ROOT}${EXTRA_DIR ? ` or ${EXTRA_DIR}` : ""}.\n` +
    "Run mope_snapshots.py or mope_archive.rb first, or set ARCHIVE_ROOT / ARCHIVE_DIR.");
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`${snapshots.length} snapshots in ${ARCHIVE_ROOT}:`);
  for (const s of snapshots) {
    console.log(`  ${s.id.padEnd(20)} ${s.playable ? "playable " : "page only"} client v${s.client?.version ?? "?"}` +
      `${s.id === defaultId ? "  (default)" : ""}`);
  }
  console.log(`mope.io archive at http://localhost:${PORT}/`);
});
