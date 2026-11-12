// lib/snapshots.js — find the archived mope.io snapshots and describe them.
//
// A snapshot is any folder (under archive/ by default) holding a host folder
// such as mope.io/ with an index.html in it: what mope_archive.rb and
// mope_snapshots.py both produce. For each one we read its manifest(s) and
// its own client.js to say when its files were really captured and whether
// the stand-in game server can play it.

"use strict";

const fs = require("fs");
const path = require("path");
const { readClientInfo } = require("./mope-server");

const HOST_RANK = (n) => (n === "mope.io" ? 0 : n === "www.mope.io" ? 1 : 2);

function hostRoots(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.includes(".") && !n.startsWith("."))   // host folders look like domains
    .sort((a, b) => HOST_RANK(a) - HOST_RANK(b) || a.localeCompare(b))
    .map((n) => path.join(dir, n));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function walk(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { files++; bytes += fs.statSync(p).size; }
    }
  }
  return { files, bytes };
}

const isoDay = (ts) => (ts && /^\d{8}/.test(ts) ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : null);
const daysBetween = (a, b) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86400000);

function describe(dir) {
  const id = path.basename(dir);
  const roots = hostRoots(dir);
  const root = roots.find((r) => fs.existsSync(path.join(r, "index.html")));
  if (!root) return null;

  const snap = readJson(path.join(dir, "snapshot-manifest.json"));   // mope_snapshots.py
  const rubyManifest = readJson(path.join(dir, "manifest.json"));     // mope_archive.rb
  const files = snap?.files || [];
  const entry = (p) => files.find((f) => f.path === p);

  const digits = id.match(/(\d{8})/);
  const date = isoDay(snap?.target_date || (digits && digits[1]));

  // When the start page and client.js were really captured.
  let pageTs = entry(`${path.basename(root)}/index.html`)?.capture;
  let clientTs = entry(`${path.basename(root)}/client.js`)?.capture;
  if (Array.isArray(rubyManifest)) {
    const r = (re) => rubyManifest.find((m) => m.saved && re.test(m.url || ""))?.timestamp;
    pageTs = pageTs || r(/^https?:\/\/(www\.)?mope\.io\/?$/);
    clientTs = clientTs || r(/\/client\.js(\?|$)/);
  }
  const sources = [...new Set(files.map((f) => f.source || "arquivo.pt"))];
  if (!sources.length && Array.isArray(rubyManifest)) sources.push("web archive");

  const clientJsPath = roots.map((r) => path.join(r, "client.js")).find((f) => fs.existsSync(f)) || null;
  const client = clientJsPath ? readClientInfo(clientJsPath) : null;
  const { files: fileCount, bytes } = walk(dir);

  return {
    id,
    dir,
    date,
    label: date ? new Date(`${date}T00:00:00Z`).toUTCString().slice(5, 16) : id,
    sources,
    page: pageTs ? { captured: isoDay(pageTs), daysOff: date ? daysBetween(isoDay(pageTs), date) : null } : null,
    client: client && {
      version: client.versionKnown ? client.version : null,
      servers: client.servers.length,
      captured: isoDay(clientTs),
      daysOff: date && clientTs ? daysBetween(isoDay(clientTs), date) : null,
      path: clientJsPath,
    },
    playable: Boolean(client && client.supported),
    files: fileCount,
    bytes,
    notArchived: Array.isArray(snap?.not_archived) ? snap.not_archived.length : null,
    captureDays: (snap?.capture_days_used || []).map(isoDay),
  };
}

// Scan `archiveRoot` (and any extra folders) for snapshots, oldest first.
function discoverSnapshots(archiveRoot, extraDirs = []) {
  const dirs = [];
  try {
    for (const d of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith(".")) dirs.push(path.join(archiveRoot, d.name));
    }
  } catch { /* no archive folder */ }
  for (const d of extraDirs) if (d && !dirs.includes(d)) dirs.push(d);
  const seen = new Set();
  return dirs
    .map(describe)
    .filter((s) => s && !seen.has(s.id) && seen.add(s.id))
    .sort((a, b) => (a.date || a.id).localeCompare(b.date || b.id));
}

// The public (JSON) view of a snapshot: no server paths.
function publicView(s) {
  const { dir, client, ...rest } = s;
  return { ...rest, client: client && { ...client, path: undefined }, playUrl: `/play/${s.id}/` };
}

module.exports = { discoverSnapshots, hostRoots, publicView };
