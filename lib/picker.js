// lib/picker.js — the snapshot picker page served at "/", and the small
// snapshot switcher injected into every archived game page.

"use strict";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

function offText(daysOff) {
  if (daysOff == null) return "";
  if (daysOff === 0) return "same day";
  return `${daysOff} day${daysOff === 1 ? "" : "s"} off`;
}

function dayLabel(iso) {
  return iso ? new Date(`${iso}T00:00:00Z`).toUTCString().slice(5, 16) : "unknown";
}

// --- picker page -------------------------------------------------------------

function card(s, isDefault) {
  const status = s.playable
    ? `<span class="badge play" title="The stand-in game server speaks this client's protocol">Playable</span>`
    : `<span class="badge menu" title="The archived page loads, but its game client (v${esc(s.client?.version ?? "?")}) stops before connecting: the nearest archived client doesn't match this page, and the stand-in server doesn't speak its protocol yet">Page only</span>`;
  const page = s.page
    ? `${esc(dayLabel(s.page.captured))} <span class="off">${esc(offText(s.page.daysOff))}</span>`
    : "unknown";
  const client = s.client
    ? `v${esc(s.client.version ?? "?")} · ${esc(dayLabel(s.client.captured))} <span class="off">${esc(offText(s.client.daysOff))}</span>`
    : "not archived";
  return `
  <article class="card" id="snap-${esc(s.id)}">
    <header>
      <div>
        <p class="eyebrow">${isDefault ? "Default snapshot" : "Snapshot"}</p>
        <h2>${esc(s.label)}</h2>
      </div>
      ${status}
    </header>
    <dl>
      <dt>Start page</dt><dd>${page}</dd>
      <dt>Game client</dt><dd>${client}</dd>
      <dt>Files</dt><dd>${esc(s.files)} files · ${esc(mb(s.bytes))}</dd>
      ${s.notArchived != null ? `<dt>Never archived</dt><dd>${esc(s.notArchived)} names the game asks for</dd>` : ""}
      <dt>Source</dt><dd>${esc(s.sources.join(", ") || "unknown")}</dd>
    </dl>
    <div class="actions">
      <a class="btn primary" href="/play/${esc(s.id)}/">${s.playable ? "Play" : "Open"}</a>
      <a class="btn" href="/api/snapshots/${esc(s.id)}/manifest.json">Manifest</a>
    </div>
  </article>`;
}

function timeline(snaps) {
  const dated = snaps.filter((s) => s.date);
  if (!dated.length) return "";
  const years = dated.map((s) => Number(s.date.slice(0, 4)));
  const y0 = Math.min(...years);
  const y1 = Math.max(...years) + 1;
  const t0 = Date.parse(`${y0}-01-01`);
  const t1 = Date.parse(`${y1}-01-01`);
  const pct = (iso) => ((Date.parse(iso) - t0) / (t1 - t0)) * 100;
  const ticks = [];
  for (let y = y0; y <= y1; y++) {
    ticks.push(`<span class="tick" style="left:${pct(`${y}-01-01`).toFixed(2)}%"><span>${y}</span></span>`);
  }
  const marks = dated.map((s) =>
    `<a class="mark${s.playable ? " playable" : ""}" href="#snap-${esc(s.id)}" style="left:${pct(s.date).toFixed(2)}%" title="${esc(s.label)}"><span class="sr">${esc(s.label)}</span></a>`);
  return `<div class="timeline" aria-label="Snapshot dates">${ticks.join("")}${marks.join("")}</div>`;
}

function renderPicker(snaps, defaultId, logoUrl) {
  const playable = snaps.filter((s) => s.playable).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mope.io archive</title>
<style>
  :root {
    --grass: #3fba54;
    --grass-deep: #09992f;
    --grid: rgba(0, 0, 0, 0.06);
    --card: #ffffff;
    --ink: #13361b;
    --muted: #4c6b52;
    --line: #09992f;
    --play: #09992f;
    --menu: #c67019;
    --btn-ink: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --grass: #1f6e2e;
      --grass-deep: #0b4f1c;
      --grid: rgba(0, 0, 0, 0.18);
      --card: #142a19;
      --ink: #e7f6ea;
      --muted: #a6c7ad;
      --line: #2f9e47;
      --play: #45d157;
      --menu: #ff9b3d;
      --btn-ink: #06240e;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Arial Rounded MT Bold", "Nunito", system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
    color: var(--ink);
    background-color: var(--grass);
    background-image:
      linear-gradient(var(--grid) 2px, transparent 2px),
      linear-gradient(90deg, var(--grid) 2px, transparent 2px);
    background-size: 40px 40px;
    min-height: 100vh;
  }
  main { max-width: 1080px; margin: 0 auto; padding: 32px 16px 48px; }
  .hero { text-align: center; color: #fff; }
  .hero img { max-width: min(340px, 80vw); height: auto; display: block; margin: 0 auto 8px; }
  .hero h1 {
    margin: 0; font-size: clamp(28px, 6vw, 44px); letter-spacing: 0.5px;
    -webkit-text-stroke: 1.5px var(--grass-deep); paint-order: stroke fill;
    text-shadow: 0 3px 0 var(--grass-deep);
  }
  .hero p { margin: 10px auto 0; max-width: 640px; font-size: 16px; line-height: 1.5;
    text-shadow: 0 1px 2px rgba(0,0,0,.35); }
  .timeline {
    position: relative; height: 54px; margin: 28px 8px 8px;
    border-bottom: 4px solid rgba(255,255,255,.75);
  }
  .tick { position: absolute; bottom: -4px; width: 2px; height: 12px; background: rgba(255,255,255,.75); }
  .tick span { position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
    color: #fff; font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,.4); }
  .mark {
    position: absolute; bottom: -12px; width: 20px; height: 20px; margin-left: -10px;
    border-radius: 50%; background: var(--menu); border: 3px solid #fff;
    box-shadow: 0 2px 4px rgba(0,0,0,.3); transition: transform .15s;
  }
  .mark.playable { background: var(--play); }
  .mark:hover, .mark:focus-visible { transform: scale(1.25); outline: none; }
  .legend { display: flex; gap: 16px; justify-content: center; margin: 30px 0 22px;
    color: #fff; font-size: 13px; text-shadow: 0 1px 2px rgba(0,0,0,.4); flex-wrap: wrap; }
  .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid #fff; vertical-align: -1px; margin-right: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 18px; }
  .card {
    background: var(--card); border: 4px solid var(--line); border-radius: 18px;
    padding: 18px 18px 16px; box-shadow: 0 6px 0 rgba(0,0,0,.18);
    display: flex; flex-direction: column; scroll-margin-top: 16px;
  }
  .card:target { outline: 4px solid #fff; outline-offset: 3px; }
  .card header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .eyebrow { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); }
  .card h2 { margin: 2px 0 0; font-size: 26px; }
  .badge { font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; color: #fff; white-space: nowrap; }
  .badge.play { background: var(--play); }
  .badge.menu { background: var(--menu); }
  @media (prefers-color-scheme: dark) { .badge { color: var(--btn-ink); } }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 16px 0; font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  .off { color: var(--muted); font-size: 12px; }
  .actions { display: flex; gap: 10px; margin-top: auto; }
  .btn {
    flex: 1; text-align: center; text-decoration: none; font-weight: 700; font-size: 15px;
    padding: 10px 12px; border-radius: 12px; border: 3px solid var(--line); color: var(--ink);
  }
  .btn.primary { background: var(--line); color: #fff; box-shadow: 0 4px 0 var(--grass-deep); }
  @media (prefers-color-scheme: dark) { .btn.primary { color: var(--btn-ink); background: var(--play); } }
  .btn:hover { filter: brightness(1.06); }
  .btn:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
  .note { margin: 26px auto 0; max-width: 760px; color: #fff; font-size: 13px; line-height: 1.55;
    text-align: center; text-shadow: 0 1px 2px rgba(0,0,0,.4); }
  .note a { color: #fff; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
</head>
<body>
<main>
  <section class="hero">
    ${logoUrl ? `<img src="${esc(logoUrl)}" alt="">` : ""}
    <h1>mope.io archive</h1>
    <p>Pick a snapshot of mope.io to load. Each one is rebuilt from web archives, with every
    file taken from the capture nearest that date.</p>
  </section>
  ${timeline(snaps)}
  <div class="legend">
    <span><i style="background:var(--play)"></i>Playable (${playable})</span>
    <span><i style="background:var(--menu)"></i>Page only (${snaps.length - playable})</span>
  </div>
  <section class="grid">
    ${snaps.map((s) => card(s, s.id === defaultId)).join("")}
  </section>
  <p class="note">
    <strong>Playable</strong> snapshots run against a stand-in game server with a generated
    land, ocean and arctic map. <strong>Page only</strong> snapshots show the archived page
    (with that period's changelog), but their game client stops before connecting: no
    client.js was archived for those dates, the nearest one (v209, April 2018) doesn't
    match their pages, and the stand-in server doesn't speak v209 yet. Most artwork was
    never archived, so animals may show as plain circles.
    <a href="/api/snapshots.json">All snapshot details (JSON)</a>
  </p>
</main>
</body>
</html>`;
}

// --- in-game switcher ------------------------------------------------------------

function renderSwitcher(snaps, currentId) {
  const current = snaps.find((s) => s.id === currentId);
  const items = snaps.map((s) => `<li><a href="/play/${esc(s.id)}/"${s.id === currentId ? ' aria-current="page"' : ""}>`
    + `${esc(s.label)}<small>${s.playable ? "playable" : "page only"}</small></a></li>`).join("");
  return `
<div id="mope-snap-switcher">
<style>
  #mope-snap-switcher { position: fixed; top: 6px; left: 50%; transform: translateX(-50%); z-index: 2147483000;
    font: 700 13px/1.2 "Arial Rounded MT Bold", Arial, sans-serif; }
  #mope-snap-switcher details { position: relative; }
  #mope-snap-switcher summary { list-style: none; cursor: pointer; user-select: none; color: #fff;
    background: rgba(9, 153, 47, .92); border: 2px solid rgba(255,255,255,.8); border-radius: 999px;
    padding: 5px 12px; box-shadow: 0 2px 6px rgba(0,0,0,.3); white-space: nowrap; }
  #mope-snap-switcher summary::-webkit-details-marker { display: none; }
  #mope-snap-switcher summary::after { content: " \\25BE"; }
  #mope-snap-switcher details[open] summary::after { content: " \\25B4"; }
  #mope-snap-switcher .panel { position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    min-width: 210px; background: #fff; color: #13361b; border: 3px solid #09992f; border-radius: 12px;
    box-shadow: 0 6px 16px rgba(0,0,0,.3); padding: 6px; }
  #mope-snap-switcher ul { list-style: none; margin: 0; padding: 0; }
  #mope-snap-switcher a { display: flex; justify-content: space-between; gap: 12px; padding: 7px 9px;
    border-radius: 8px; color: inherit; text-decoration: none; }
  #mope-snap-switcher a:hover, #mope-snap-switcher a:focus-visible { background: #e3f6e6; outline: none; }
  #mope-snap-switcher a[aria-current] { background: #09992f; color: #fff; }
  #mope-snap-switcher small { font-weight: 400; opacity: .75; }
  #mope-snap-switcher .all { border-top: 2px solid #e3f6e6; margin-top: 4px; padding-top: 4px; }
</style>
<details>
  <summary title="Switch snapshot">Snapshot: ${esc(current ? current.label : currentId)}</summary>
  <div class="panel">
    <ul>${items}</ul>
    <div class="all"><a href="/">All snapshots</a></div>
  </div>
</details>
</div>`;
}

module.exports = { renderPicker, renderSwitcher };
