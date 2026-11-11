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
//     client -> [2][str name][u16 w][u16 h]...  join/spectate request (logged only:
//                                               the gameplay protocol isn't built yet)
//
// The browser can't reach those IPs, so server.js injects a shim that turns
// ws://<ip>:<port> into ws://<this host>/ws/<port>/<ip>.

"use strict";

const fs = require("fs");

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
    this.players = new Map(); // ip -> Set of game connections
  }

  get totalPlayers() {
    let n = 0;
    for (const set of this.players.values()) n += set.size;
    return n;
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
        o = out.writeUInt16BE(this.players.get(s.ip)?.size || 0, o);
      }
      conn.send(out);
    });
  }

  _game(conn, ip) {
    const name = this.servers.find((s) => s.ip === ip)?.name || ip;
    let welcomed = false;
    let pings = 0;

    // The region ping test opens a socket and immediately sends [255]; a real
    // game connection sends nothing until it gets the welcome. Wait a moment
    // so ping-test sockets aren't counted as players.
    const welcomeTimer = setTimeout(() => {
      if (!conn.open) return;
      welcomed = true;
      if (!this.players.has(ip)) this.players.set(ip, new Set());
      this.players.get(ip).add(conn);
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
        case 2: {
          const nick = readString(msg, 1);
          this.log(`[game] ${name}: join request from "${nick}" (gameplay not implemented yet)`);
          return;
        }
        default:
          this.log(`[game] ${name}: unhandled message type ${msg[0]} (${msg.length} bytes)`);
      }
    });

    conn.on("close", () => {
      clearTimeout(welcomeTimer);
      if (welcomed) {
        this.players.get(ip)?.delete(conn);
        this.log(`[game] client left ${name}`);
      } else if (pings) {
        this.log(`[ping] region test for ${name} (${pings} pings)`);
      }
    });
  }

  _welcome(ip) {
    const out = Buffer.alloc(5);
    out.writeUInt8(1, 0);
    out.writeUInt16BE(this.players.get(ip)?.size || 0, 1);
    out.writeUInt16BE(this.version, 3);
    return out;
  }
}

// mope.io strings: [u16 length] then one byte per char (UTF-8 bytes).
function readString(buf, offset) {
  if (buf.length < offset + 2) return "";
  const len = buf.readUInt16BE(offset);
  return buf.subarray(offset + 2, offset + 2 + len).toString("utf8");
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
