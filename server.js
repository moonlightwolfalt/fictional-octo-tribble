#!/usr/bin/env node
// server.js — serve the fetched mope.io files locally, exactly as archived.
//
//   node server.js                         # http://localhost:8080
//   PORT=3000 node server.js
//   ARCHIVE_DIR=archive/<other-capture> node server.js
//
// Files come from <ARCHIVE_DIR>/mope.io/ (falling back to www.mope.io/ and any
// other host folder mope_archive.rb wrote). No dependencies: Node built-ins only.
//
// Note: this serves the client only. The archived client.js connects over
// WebSocket to mope.io's original game servers, which are long gone, so the
// menu loads but you can't join a game.

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const ARCHIVE_DIR = path.resolve(__dirname, process.env.ARCHIVE_DIR || "archive/arquivo-20170213");

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
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// Host folders to search, mope.io first, then www.mope.io, then any others.
function hostRoots() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const rank = (n) => (n === "mope.io" ? 0 : n === "www.mope.io" ? 1 : 2);
  return dirs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((d) => path.join(ARCHIVE_DIR, d));
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

function resolveFile(urlPath, query) {
  for (const root of hostRoots()) {
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

const server = http.createServer((req, res) => {
  const started = Date.now();
  const log = (status) =>
    console.log(`${status} ${req.method} ${req.url} (${Date.now() - started}ms)`);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return log(405);
  }

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return log(400);
  }

  let file;
  try {
    file = resolveFile(url.pathname, url.search.slice(1));
  } catch {
    file = null; // malformed %-encoding
  }
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Not in the archive: ${url.pathname}\n`);
    return log(404);
  }

  const stat = fs.statSync(file);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    fs.createReadStream(file).pipe(res);
  }
  log(200);
});

if (!fs.existsSync(ARCHIVE_DIR)) {
  console.error(`Archive folder not found: ${ARCHIVE_DIR}\nRun mope_archive.rb first or set ARCHIVE_DIR.`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ARCHIVE_DIR}`);
  console.log(`mope.io archive at http://localhost:${PORT}/`);
});
