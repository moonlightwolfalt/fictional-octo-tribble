// lib/mope-server.js — a stand-in for mope.io's 2017 servers, enough for the
// archived client.js to connect.
//
// The client talks to two kinds of server, all binary and big-endian:
//
//   master  ws://45.63.15.119:7500
//     client -> [200]                       "send me the server list"
//     server -> [100][u32 total players][u16 n] n x ([u32 ip][u16 players])
//
//   game    ws://<server ip>:7020  (also used for the region ping test)
//     client -> [255]                       ping;  server -> [255]
//     server -> [1][u16 players][u16 version]   welcome; version must be <= the
//                                               client's (178) or it asks to reload
//     client -> [2][str name][u16 w][u16 h]...  join (spectate or play)
//     server -> [2][1]... then [4]... every tick  join reply + world updates
//                                               (see lib/mope-world.js)
//
// The browser can't reach those IPs, so server.js injects a shim that turns
// ws://<ip>:<port> into ws://<this host>/ws/<port>/<ip>.

"use strict";

const fs = require("fs");
const { World } = require("./mope-world");

const CLIENT_VERSION_FALLBACK = 178;

// Pull the server list and client version out of the archived client.js so
// the master server can report on exactly the servers the client knows.
function readClientInfo(clientJsPath) {
  let src = "";
  try {
    src = fs.readFileSync(clientJsPath, "utf8");
  } catch {
    return { version: CLIENT_VERSION_FALLBACK, servers: [] };
  }
  const servers = [];
  for (const m of src.matchAll(/\bc\("([^"]+)","(\d{1,3}(?:\.\d{1,3}){3})",g\)/g)) {
    servers.push({ name: m[1], ip: m[2] });
  }
  const ver = src.match(/for\(var t=(\d+),a=!?[01],i="/);
  return { version: ver ? Number(ver[1]) : CLIENT_VERSION_FALLBACK, servers };
}

function ipToUInt32(ip) {
  return ip.split(".").reduce((acc, part) => acc * 256 + (Number(part) & 255), 0);
}

class MopeServer {
  constructor({ clientJsPath, log = console.log } = {}) {
    const info = readClientInfo(clientJsPath);
    this.version = info.version;
    this.servers = info.servers;
    this.log = log;
    // Every old server address now points at this machine, so all of them
    // share one world: whichever "server" the client picks, players meet.
    this.sharedWorld = new World({ name: "mope.io (local)", log: this.log });
  }

  world(ip) {
    return this.sharedWorld;
  }

  playersOn(ip) {
    return this.world(ip).playerCount;
  }

  get totalPlayers() {
    return this.sharedWorld.playerCount;
  }

  status() {
    return this.sharedWorld.status();
  }

  // port: "7500" (master) or "7020" (game); ip: the address the client asked for.
  handle(conn, port, ip) {
    if (port === "7500") return this._master(conn);
    if (port === "7020") return this._game(conn, ip);
    return conn.close(1008, "Unknown service");
  }

  _master(conn) {
    conn.on("message", (msg) => {
      if (!Buffer.isBuffer(msg) || msg[0] !== 200) return;
      const list = this.servers;
      const out = Buffer.alloc(1 + 4 + 2 + list.length * 6);
      let o = 0;
      o = out.writeUInt8(100, o);
      o = out.writeUInt32BE(this.totalPlayers, o);
      o = out.writeUInt16BE(list.length, o);
      for (const s of list) {
        o = out.writeUInt32BE(ipToUInt32(s.ip), o);
        o = out.writeUInt16BE(this.playersOn(s.ip), o);
      }
      conn.send(out);
    });
  }

  _game(conn, ip) {
    const name = this.servers.find((s) => s.ip === ip)?.name || ip;
    let client = null; // set once welcomed
    let pings = 0;

    // The region ping test opens a socket and immediately sends [255]; a real
    // game connection sends nothing until it gets the welcome. Wait a moment
    // so ping-test sockets aren't counted as players.
    const welcomeTimer = setTimeout(() => {
      if (!conn.open) return;
      client = this.world(ip).addClient(conn);
      this.log(`[game] client connected to ${name}`);
      conn.send(this._welcome(ip));
    }, 150);

    conn.on("message", (msg) => {
      if (!Buffer.isBuffer(msg) || msg.length === 0) return;
      switch (msg[0]) {
        case 255: // latency ping
          pings += 1;
          conn.send(Buffer.from([255]));
          return;
        case 2:
          if (client) this.world(ip).handleJoin(client, msg);
          return;
        default:
          if (client && this.world(ip).handleMessage(client, msg)) return;
          this.log(`[game] ${name}: unhandled message type ${msg[0]} (${msg.length} bytes)`);
      }
    });

    conn.on("close", () => {
      clearTimeout(welcomeTimer);
      if (client) {
        this.world(ip).removeClient(client);
        this.log(`[game] client left ${name}`);
      } else if (pings) {
        this.log(`[ping] region test for ${name} (${pings} pings)`);
      }
    });
  }

  _welcome(ip) {
    const out = Buffer.alloc(5);
    out.writeUInt8(1, 0);
    out.writeUInt16BE(this.playersOn(ip), 1);
    out.writeUInt16BE(this.version, 3);
    return out;
  }
}

// Runs in the browser before client.js: reroute the hard-coded server IPs to
// this host. Kept as a string so server.js can inline it into index.html.
const BROWSER_SHIM = `<script>
(function () {
  var Native = window.WebSocket;
  function MopeSocket(url, protocols) {
    var m = /^wss?:\\/\\/(\\d{1,3}(?:\\.\\d{1,3}){3}):(\\d+)\\/?$/.exec(url);
    if (m) {
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      url = proto + location.host + "/ws/" + m[2] + "/" + m[1];
    }
    return protocols === undefined ? new Native(url) : new Native(url, protocols);
  }
  MopeSocket.prototype = Native.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { MopeSocket[k] = Native[k]; });
  window.WebSocket = MopeSocket;
})();
</script>`;

module.exports = { MopeServer, BROWSER_SHIM, readClientInfo, ipToUInt32 };
