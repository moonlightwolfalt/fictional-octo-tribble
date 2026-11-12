// lib/websocket.js — a small RFC 6455 WebSocket server using only Node
// built-ins. Enough for mope.io's binary protocol: handshake, masked client
// frames (with fragmentation), binary/text messages, ping/pong and close.

"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 1 << 20; // 1 MiB is plenty for this game

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSocketConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._parse();
    });
    socket.on("close", () => this._finish());
    socket.on("error", () => this._finish());
    if (this.buffer.length) setImmediate(() => this._parse());
  }

  get open() {
    return !this.closed && !this.socket.destroyed;
  }

  // Send a Buffer/Uint8Array as a binary frame, or a string as a text frame.
  send(data) {
    if (!this.open) return;
    const isText = typeof data === "string";
    const payload = isText ? Buffer.from(data, "utf8") : Buffer.from(data);
    this._sendFrame(isText ? OP.TEXT : OP.BINARY, payload);
  }

  close(code = 1000, reason = "") {
    if (!this.open) return;
    const r = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._sendFrame(OP.CLOSE, payload);
    this.closed = true;
    this.socket.end();
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _parse() {
    while (this.open) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, "Message too big");
        len = Number(big);
        offset = 10;
      }
      if (!masked) return this.close(1002, "Client frames must be masked");
      if (len > MAX_MESSAGE) return this.close(1009, "Message too big");
      if (b.length < offset + 4 + len) return;

      const mask = b.subarray(offset, offset + 4);
      const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(offset + 4 + len);

      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP.PING:
        return this._sendFrame(OP.PONG, payload);
      case OP.PONG:
        return undefined;
      case OP.CLOSE:
        if (!this.closed) {
          this._sendFrame(OP.CLOSE, payload.subarray(0, 2));
          this.closed = true;
          this.socket.end();
        }
        return undefined;
      case OP.TEXT:
      case OP.BINARY:
        if (fin) return this._emitMessage(opcode, payload);
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return undefined;
      case OP.CONT:
        if (this.fragmentOpcode === null) return this.close(1002, "Unexpected continuation");
        this.fragments.push(payload);
        if (fin) {
          const op = this.fragmentOpcode;
          const whole = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentOpcode = null;
          this._emitMessage(op, whole);
        }
        return undefined;
      default:
        return this.close(1002, "Unknown opcode");
    }
  }

  _emitMessage(opcode, payload) {
    this.emit("message", opcode === OP.TEXT ? payload.toString("utf8") : payload);
  }

  _finish() {
    if (this._done) return;
    this._done = true;
    this.closed = true;
    this.emit("close");
  }
}

// Complete the HTTP upgrade. Returns a WebSocketConnection, or null after
// rejecting the request.
function acceptUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  const isWs = String(req.headers.upgrade || "").toLowerCase() === "websocket";
  if (!isWs || !key || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return new WebSocketConnection(socket, head);
}

module.exports = { acceptUpgrade, WebSocketConnection };
