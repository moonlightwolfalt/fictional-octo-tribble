#!/usr/bin/env python3
"""mope_snapshots.py: rebuild mope.io as it was on given dates from arquivo.pt.

For each target date (YYYYMMDD) this script:

  1. fetches the copy of the mope.io start page nearest that date;
  2. fetches every file arquivo.pt captured under mope.io within --window days
     of the date (that period's folders: skins, img, shop, assets/...);
  3. reads the HTML, CSS and JavaScript it got (client.js above all) and
     rebuilds every asset name the game builds at runtime: animal skins
     ("skins/" + skinName + ".png"), their alternate frames, winter skins,
     food with its "_e" outlined variant, ability and effect images, sounds;
  4. downloads each of those from arquivo.pt's nearest copy, whatever its date.

Which files exist is decided from arquivo.pt's capture index (CDX), fetched
once and cached, so guessed names that were never archived cost no requests.
Everything lands in  <out>/arquivo-<date>/mope.io/...  with a
snapshot-manifest.json recording, for every file, the capture it came from,
how many days that is from the target, and why it was included; plus every
name that was looked for but never archived.

Usage:
  python3 mope_snapshots.py                       # the four default dates
  python3 mope_snapshots.py 20170702 20201218     # just these
  python3 mope_snapshots.py --window 30 --delay 2 --out archive
  python3 mope_snapshots.py --all                 # + every file arquivo.pt has
  python3 mope_snapshots.py --all --all-clients   # + names from every client version
  python3 mope_snapshots.py --commoncrawl ...     # + Common Crawl as a second source
  python3 mope_snapshots.py --dry-run             # plan only, download nothing

Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import threading
from concurrent.futures import ThreadPoolExecutor
import gzip
import zlib
import itertools
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

DEFAULT_DATES = ["20170702", "20181119", "20190808", "20201218"]
DOMAIN = "mope.io"
CDX_URL = "https://arquivo.pt/wayback/cdx"
REPLAY = "https://arquivo.pt/wayback"
CC_INDEX = "https://index.commoncrawl.org"
CC_DATA = "https://data.commoncrawl.org"
USER_AGENT = "mope-snapshot-fetcher/1.0 (python)"

ASSET_EXT = r"(?:png|jpe?g|gif|svg|webp|ico|mp3|ogg|wav|m4a|json|js|css|woff2?|ttf|txt|xml|html?)"
GUESS = "guess:"  # marks names built by filling an unknown template slot
TEXT_TYPES = ("text/", "application/javascript", "application/x-javascript", "application/json")


# --- small helpers ---------------------------------------------------------


def log(msg: str) -> None:
    print(msg, flush=True)


def ts_to_dt(ts: str) -> datetime:
    ts = (ts + "000000")[:14]
    return datetime.strptime(ts, "%Y%m%d%H%M%S")


def days_between(a: str, b: str) -> float:
    return abs((ts_to_dt(a) - ts_to_dt(b)).total_seconds()) / 86400


def url_key(url: str) -> str | None:
    """Scheme-, www- and query-insensitive key: 'mope.io/skins/mouse.png'."""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host != DOMAIN:
        return None
    path = urllib.parse.unquote(u.path or "/")
    path = re.sub(r"/{2,}", "/", path)
    # resolve ./ and ../
    parts: list[str] = []
    for seg in path.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
            continue
        parts.append(seg)
    return host + "/" + "/".join(parts)


def local_path(root: Path, key: str) -> Path:
    host, _, path = key.partition("/")
    if path == "" or key.endswith("/"):
        path = (path + "/index.html").lstrip("/")
    safe = [re.sub(r"[^\w.@+-]", "_", p) for p in path.split("/") if p]
    return root.joinpath(host, *safe)


@dataclass
class Capture:
    timestamp: str
    url: str
    mime: str
    status: str
    source: str = "arquivo.pt"
    # Common Crawl only: where the record sits inside its WARC file
    filename: str = ""
    offset: int = 0
    length: int = 0


@dataclass
class Http:
    delay: float
    retries: int
    last: float = 0.0
    timeout: float = 90
    backoff: float = 5    # first wait after a failure; doubles each retry

    def get(self, url: str, headers: dict | None = None) -> tuple[int, bytes, dict]:
        """GET with politeness delay and backoff on 429/5xx."""
        for attempt in range(self.retries + 1):
            wait = self.last + self.delay - time.time()
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    return res.status, res.read(), dict(res.headers)
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt < self.retries:
                    retry_after = e.headers.get("Retry-After")
                    pause = float(retry_after) if retry_after and retry_after.isdigit() else self.backoff * 2**attempt
                    log(f"    {e.code} from {urllib.parse.urlsplit(url).hostname}, waiting {pause:.0f}s")
                    time.sleep(pause)
                    continue
                return e.code, b"", dict(e.headers or {})
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < self.retries:
                    pause = self.backoff * 2**attempt
                    log(f"    network error ({e}), waiting {pause}s")
                    time.sleep(pause)
                    continue
                return 0, b"", {}
        return 0, b"", {}


# --- capture index ---------------------------------------------------------


class CaptureIndex:
    def __init__(self, rows: list[dict]):
        self.by_key: dict[str, list[Capture]] = {}
        self.add_rows(rows, "arquivo.pt")

    def add_rows(self, rows: list[dict], source: str) -> int:
        added = 0
        for r in rows:
            if str(r.get("status")) != "200":
                continue
            key = url_key(r["url"])
            if not key:
                continue
            self.by_key.setdefault(key, []).append(Capture(
                r["timestamp"], r["url"], r.get("mime", ""), "200", source,
                r.get("filename", ""), int(r.get("offset") or 0), int(r.get("length") or 0)))
            added += 1
        for caps in self.by_key.values():
            caps.sort(key=lambda c: c.timestamp)
        return added

    @classmethod
    def load(cls, http: Http, cache: Path, refresh: bool) -> "CaptureIndex":
        if cache.exists() and not refresh:
            rows = [json.loads(l) for l in cache.read_text().splitlines() if l.strip()]
            log(f"Capture index: {len(rows)} rows from cache {cache}")
            return cls(rows)
        q = urllib.parse.urlencode({"url": DOMAIN, "matchType": "domain", "output": "json",
                                    "fl": "timestamp,url,mime,status"})
        status, body, _ = http.get(f"{CDX_URL}?{q}")
        if status != 200:
            sys.exit(f"Could not read arquivo.pt's capture index (HTTP {status}).")
        text = body.decode("utf-8", "replace")
        rows = [json.loads(l) for l in text.splitlines() if l.strip().startswith("{")]
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
        log(f"Capture index: {len(rows)} rows fetched from arquivo.pt")
        return cls(rows)

    def nearest(self, key: str, target: str) -> Capture | None:
        caps = self.by_key.get(key)
        if not caps:
            return None
        return min(caps, key=lambda c: days_between(c.timestamp, target))

    def within(self, target: str, window_days: float) -> list[str]:
        return sorted(k for k, caps in self.by_key.items()
                      if any(days_between(c.timestamp, target) <= window_days for c in caps))


# --- Common Crawl ------------------------------------------------------------


def commoncrawl_rows(http: Http, out: Path, since: str, refresh: bool,
                     workers: int = 4, passes: int = 3) -> list[dict]:
    """Every Common Crawl capture under mope.io from crawls ending after `since`.

    The index server is flaky, so each crawl's result is cached as soon as it
    arrives and finished crawls are skipped on the next run."""
    cache = out / ".commoncrawl-cdx-mope.io.jsonl"
    done_file = out / ".commoncrawl-crawls-done.json"
    crawls_file = out / ".commoncrawl-collinfo.json"
    if refresh:
        for f in (cache, done_file):
            f.unlink(missing_ok=True)
    rows = [json.loads(l) for l in cache.read_text().splitlines() if l.strip()] if cache.exists() else []
    done = set(json.loads(done_file.read_text())) if done_file.exists() else set()

    if crawls_file.exists() and not refresh:
        crawls = json.loads(crawls_file.read_text())
    else:
        status, body, _ = http.get(f"{CC_INDEX}/collinfo.json")
        if status != 200:
            log(f"Common Crawl: list of crawls unavailable (HTTP {status}); using {len(rows)} cached rows")
            return rows
        crawls = json.loads(body)
        crawls_file.write_text(json.dumps(crawls, indent=1))
    todo = [c for c in crawls if c.get("to", "")[:4] >= since[:4] and c["id"] not in done]
    log(f"Common Crawl: {len(crawls)} crawls, {len(todo)} to search since {since[:4]} "
        f"({len(done)} already searched, {len(rows)} cached rows)")

    lock = threading.Lock()
    q = urllib.parse.urlencode({"url": DOMAIN, "matchType": "domain", "output": "json"})

    def search(c) -> bool:
        # each worker has its own connection pacing; fail fast, retry in a later pass
        h = Http(delay=http.delay, retries=2, timeout=30, backoff=3)
        status, body, _ = h.get(f"{c['cdx-api']}?{q}")
        if status == 404:   # "No Captures found"
            found = []
        elif status != 200:
            return False
        else:
            found = [json.loads(l) for l in body.decode("utf-8", "replace").splitlines()
                     if l.strip().startswith("{")]
            # only real page fetches; skip crawl-diagnostics records
            found = [dict(r, crawl=c["id"]) for r in found
                     if "/crawldiagnostics/" not in r.get("filename", "")]
        with lock:
            rows.extend(found)
            done.add(c["id"])
            with cache.open("a") as fh:
                for r in found:
                    fh.write(json.dumps(r) + "\n")
            done_file.write_text(json.dumps(sorted(done)))
            if found:
                log(f"  {c['id']}: {len(found)} captures")
        return True

    for n in range(1, passes + 1):
        todo = sorted((c for c in todo if c["id"] not in done), key=lambda c: c["id"])
        if not todo:
            break
        log(f"Common Crawl: pass {n}, searching {len(todo)} crawls, {workers} at a time")
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(search, todo))
        failed = [c["id"] for c, ok in zip(todo, results) if not ok]
        if failed:
            log(f"Common Crawl: pass {n}: {len(failed)} crawls unavailable: {' '.join(failed)}")
    left = [c["id"] for c in todo if c["id"] not in done]
    if left:
        log(f"Common Crawl: {len(left)} crawls still unsearched; rerun to retry them")
    return rows


def parse_warc_record(raw: bytes) -> tuple[int, bytes]:
    """A gzipped WARC 'response' record -> (HTTP status, decoded body)."""
    data = gzip.decompress(raw)
    head, _, rest = data.partition(b"\r\n\r\n")          # WARC headers
    http_head, _, body = rest.partition(b"\r\n\r\n")     # HTTP status + headers
    lines = http_head.split(b"\r\n")
    try:
        status = int(lines[0].split()[1])
    except (IndexError, ValueError):
        return 0, b""
    hdrs = {}
    for line in lines[1:]:
        k, _, v = line.partition(b":")
        hdrs[k.strip().lower()] = v.strip().lower()
    if hdrs.get(b"transfer-encoding") == b"chunked":
        out, i = b"", 0
        while i < len(body):
            j = body.find(b"\r\n", i)
            if j < 0:
                break
            size = int(body[i:j].split(b";")[0] or b"0", 16)
            if size == 0:
                break
            out += body[j + 2:j + 2 + size]
            i = j + 2 + size + 2
        body = out
    enc = hdrs.get(b"content-encoding")
    if enc in (b"gzip", b"x-gzip"):
        body = gzip.decompress(body)
    elif enc == b"deflate":
        body = zlib.decompress(body)
    return status, body


def fetch_capture(http: Http, cap: Capture) -> tuple[int, bytes]:
    """Download the raw file a capture holds, from whichever archive has it."""
    if cap.source == "commoncrawl":
        rng = {"Range": f"bytes={cap.offset}-{cap.offset + cap.length - 1}"}
        status, raw, _ = http.get(f"{CC_DATA}/{cap.filename}", headers=rng)
        if status not in (200, 206):
            return status, b""
        try:
            code, body = parse_warc_record(raw)
        except (OSError, EOFError, zlib.error, ValueError) as e:
            log(f"    could not unpack Common Crawl record ({e})")
            return 0, b""
        return (200, body) if code == 200 else (code, b"")
    status, data, _ = http.get(f"{REPLAY}/{cap.timestamp}id_/{cap.url}")
    return status, data


# --- asset-name extraction -------------------------------------------------

STR_LIT = re.compile(r'"((?:[^"\\\n]|\\.)*)"|\'((?:[^\'\\\n]|\\.)*)\'')


def _lit_at(text: str, i: int):
    m = STR_LIT.match(text, i)
    if not m:
        return None, i
    return (m.group(1) if m.group(1) is not None else m.group(2)), m.end()


def _skip_ws(text: str, i: int) -> int:
    while i < len(text) and text[i] in " \t\r\n":
        i += 1
    return i


def _match_paren(text: str, i: int) -> int:
    """text[i] == '('; return index after the matching ')' (strings aware)."""
    depth = 0
    j = i
    while j < len(text):
        ch = text[j]
        if ch in "\"'":
            _, j = _lit_at(text, j)
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return len(text)


TERNARY = re.compile(r'\?\s*(["\'])(.*?)\1\s*:\s*(["\'])(.*?)\3\s*\)?\s*$', re.S)
# identifiers with .prop, ['prop'] and call() chains: a.b(c)['skinName']
_ACCESS = r'(?:\s*\.\s*[\w$]+|\s*\[[^\[\]]*\]|\s*\([^()]*\))'
IDENT_EXPR = re.compile(r'[\w$]+' + _ACCESS + '*')


def _operand(text: str, i: int):
    """Parse one '+' operand at i. Returns (kind, value, end)."""
    i = _skip_ws(text, i)
    while i < len(text) and text[i] == "+":   # unary plus: 'a'+ +x
        i = _skip_ws(text, i + 1)
    if i >= len(text):
        return None, None, i
    ch = text[i]
    if ch in "\"'":
        s, end = _lit_at(text, i)
        return ("lit", s, end) if s is not None else (None, None, i)
    if ch == "(":
        end = _match_paren(text, i)
        inner = text[i + 1:end - 1]
        m = TERNARY.search(inner)
        if m:
            return "choice", [m.group(2), m.group(4)], end
        return "var", inner.strip(), end
    m = IDENT_EXPR.match(text, i)
    if m:
        return "var", m.group(0), m.end()
    return None, None, i


def extract_templates(js: str) -> list[list[tuple[str, object]]]:
    """Find string concatenations like "skins/"+x.skinName+"2.png"."""
    found = []
    for m in STR_LIT.finditer(js):
        s = m.group(1) if m.group(1) is not None else m.group(2)
        # Start only at a literal that begins a concatenation and looks like a path.
        before = js[:m.start()].rstrip()[-1:] if m.start() else ""
        if before == "+":
            continue
        after = _skip_ws(js, m.end())
        if after >= len(js) or js[after] != "+":
            continue
        if not s or ("/" not in s and not re.search(r"\." + ASSET_EXT + "$", s)):
            continue
        parts: list[tuple[str, object]] = [("lit", s)]
        i = after
        while i < len(js) and js[i] == "+" and len(parts) < 8:
            kind, val, end = _operand(js, i + 1)
            if not kind:
                break
            parts.append((kind, val))
            i = _skip_ws(js, end)
        if parts[-1][0] == "lit" and re.search(r"\." + ASSET_EXT + r"$", str(parts[-1][1]), re.I):
            if any(k != "lit" for k, _ in parts):
                found.append(parts)
    return found


SMALL_GUESSES = [""] + [str(i) for i in range(0, 13)]


def expand_template(parts, skin_names: list[str], guesses: list[str], cap: int = 4000):
    """Return (names, guessed): guessed is True when a slot held an unknown
    variable and was filled with guesses (skin names, small numbers)."""
    options = []
    guessed = False
    if any(k == "var" and "skinName" in str(v) for k, v in parts):
        guesses = SMALL_GUESSES  # the skinName slot is the real variable; keep others small
    for kind, val in parts:
        if kind == "lit":
            options.append([val])
        elif kind == "choice":
            options.append(list(val))
        elif "skinName" in str(val):
            options.append(skin_names)
        else:
            options.append(guesses)
            guessed = True
    out = []
    for combo in itertools.product(*options):
        out.append("".join(combo))
        if len(out) >= cap:
            break
    return out, guessed


def plain_literals(text: str) -> list[str]:
    """Quoted asset paths that aren't fragments of a concatenation."""
    out = []
    for m in STR_LIT.finditer(text):
        s = m.group(1) if m.group(1) is not None else m.group(2)
        if not s or not re.search(r"[A-Za-z0-9]\." + ASSET_EXT + r"(?:\?[^\s]*)?$", s, re.I):
            continue
        before = text[:m.start()].rstrip()[-1:]
        after = text[_skip_ws(text, m.end()):][:1]
        if before == "+" or after == "+":
            continue
        if s.startswith(("_", ".png", "data:")) or " " in s:
            continue
        out.append(s)
    return out


def html_css_refs(text: str) -> list[str]:
    refs = re.findall(r'(?:src|href|data-src)\s*=\s*["\']([^"\'#]+)["\']', text, re.I)
    refs += re.findall(r'url\(\s*["\']?([^"\')]+)["\']?\s*\)', text, re.I)
    return [r.strip() for r in refs if not r.strip().startswith(("data:", "javascript:", "mailto:", "#"))]


SKIN_NAME = re.compile(r"""(?:\.skinName|\[\s*["']skinName["']\s*\])\s*=\s*["']([\w/.-]+)["']""")


def skin_names_in(js: str) -> list[str]:
    """.skinName="x" (2017/2018) and ['skinName']='x' (obfuscated 2025)."""
    return sorted(set(SKIN_NAME.findall(js)))


def decode_js(text: str) -> str:
    r"""Undo the \xNN / \uNNNN escapes obfuscated clients (2025) use for strings."""
    if "\\x" not in text and "\\u" not in text:
        return text

    def ch(m):
        c = chr(int(m.group(1), 16))
        # Keep characters that would end or break a string literal escaped.
        return {"'": "\\'", '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r"}.get(c, c)

    text = re.sub(r"\\x([0-9a-fA-F]{2})", ch, text)
    return re.sub(r"\\u([0-9a-fA-F]{4})", ch, text)


def extract_js_names(text: str):
    """Every asset name a JS client asks for.

    Returns (refs, skin_names, templates); refs are relative names, prefixed
    with GUESS when a template slot had to be guessed."""
    text = decode_js(text)
    refs = plain_literals(text)
    names = skin_names_in(text)
    templates = []
    guesses = sorted(set(names) | {n.split("/")[-1] for n in names} | set(SMALL_GUESSES))
    for parts in extract_templates(text):
        shown = "+".join(repr(v) if k == "lit" else ("(" + "|".join(v) + ")" if k == "choice"
                         else "<" + str(v)[:30] + ">") for k, v in parts)
        expanded, guessed = expand_template(parts, names, guesses)
        templates.append({"template": shown, "candidates": len(expanded), "guessed_slot": guessed})
        tag = GUESS if guessed else ""
        refs += [tag + e for e in expanded]
    return refs, names, templates


# --- per-date snapshot -----------------------------------------------------


@dataclass
class Snapshot:
    target: str
    root: Path
    index: CaptureIndex
    http: Http
    window: float
    dry_run: bool
    cache: dict
    take_all: bool = False
    pooled: list = field(default_factory=list)  # (key, reason) named by every client
    files: list = field(default_factory=list)
    missing: dict = field(default_factory=dict)
    templates: list = field(default_factory=list)
    done: set = field(default_factory=set)
    skins: set = field(default_factory=set)

    def run(self) -> None:
        log(f"\n=== {self.target} -> {self.root}")
        queue: list[tuple[str, str]] = [(f"{DOMAIN}/", "start page nearest the date"),
                                        (f"{DOMAIN}/client.js", "game client (loaded with a cache-busting ?x=)")]
        for key in self.index.within(self.target, self.window):
            queue.append((key, f"captured within {self.window:g} days"))
        if self.take_all:
            for key in sorted(self.index.by_key):
                queue.append((key, "--all: every file arquivo.pt has, nearest copy"))
        queue += self.pooled

        while queue:
            key, reason = queue.pop(0)
            if key in self.done:
                # A name first reached through a guessed template slot may also
                # be named for certain (e.g. skins/fox.png via skinName); keep
                # the certain reason so it's reported as genuinely missing.
                old = self.missing.get(key)
                if old and old.startswith(GUESS) and not reason.startswith(GUESS):
                    self.missing[key] = reason
                continue
            self.done.add(key)
            cap = self.index.nearest(key, self.target)
            if not cap:
                self.missing.setdefault(key, reason)
                continue
            data = self._download(key, cap, reason)
            if data is None:
                continue
            mime = (cap.mime or "").lower()
            if mime.startswith(TEXT_TYPES) or key.endswith((".js", ".css", ".html", "/")):
                for ref_key, why in self._extract(key, cap, data):
                    if ref_key not in self.done:
                        queue.append((ref_key, why))
        self._write_manifest()

    def _download(self, key: str, cap: Capture, reason: str) -> bytes | None:
        dest = local_path(self.root, key)
        off = days_between(cap.timestamp, self.target)
        entry = {"url": cap.url, "capture": cap.timestamp, "source": cap.source,
                 "days_from_target": round(off, 1),
                 "reason": reason, "path": str(dest.relative_to(self.root))}
        cache_id = (cap.timestamp, cap.url)
        is_text = (cap.mime or "").lower().startswith(TEXT_TYPES) or key.endswith((".js", ".css", ".html", "/"))
        if self.dry_run:
            log(f"  plan   {key}  <- {cap.timestamp} ({off:.0f}d)")
            self.files.append(entry)
            if not is_text:
                return None
            if cache_id not in self.cache:
                status, data = fetch_capture(self.http, cap)
                self.cache[cache_id] = data if status == 200 else b""
            return self.cache[cache_id] or None
        if dest.exists() and dest.stat().st_size > 0 and self.cache.get(cache_id) is None:
            data = dest.read_bytes()
            log(f"  have   {key}")
        elif cache_id in self.cache:
            src = self.cache[cache_id]
            dest.parent.mkdir(parents=True, exist_ok=True)
            if Path(src) != dest:
                shutil.copyfile(src, dest)
            data = dest.read_bytes()
            log(f"  copy   {key}  ({cap.timestamp}, already downloaded)")
        else:
            status, data = fetch_capture(self.http, cap)
            if status != 200:
                log(f"  fail   {key} (HTTP {status})")
                self.missing.setdefault(key, f"{reason}; download failed with HTTP {status}")
                return None
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            log(f"  saved  {key}  <- {cap.source} {cap.timestamp} ({off:.0f}d off, {len(data)} bytes)")
        self.cache[cache_id] = str(dest)
        entry["bytes"] = len(data)
        self.files.append(entry)
        return data

    def _extract(self, key: str, cap: Capture, data: bytes):
        text = data.decode("utf-8", "replace")
        base = cap.url if not key.endswith("/") else cap.url.rstrip("/") + "/"
        if key.endswith((".js",)) or "javascript" in (cap.mime or ""):
            refs, names, templates = extract_js_names(text)
            self.skins.update(names)
            self.templates += [dict(t, **{"from": key}) for t in templates]
            why = f"named in {key.split('/', 1)[1] or 'index.html'}"
        else:
            refs = html_css_refs(text) + plain_literals(text)
            why = f"referenced by {key.split('/', 1)[1] or 'index.html'}"
        out = []
        for ref in refs:
            reason = why
            if ref.startswith(GUESS):
                ref, reason = ref[len(GUESS):], GUESS + why
            ref = ref.replace("\\/", "/")
            absolute = urllib.parse.urljoin(base, ref)
            k = url_key(absolute)
            if k and k != key:
                out.append((k, reason))
        return out

    def _write_manifest(self) -> None:
        if self.dry_run:
            real = sum(1 for v in self.missing.values() if not v.startswith(GUESS))
            log(f"  {len(self.files)} files would be downloaded; {real} named files never archived")
            return
        self.root.mkdir(parents=True, exist_ok=True)
        captures = sorted({f["capture"][:8] for f in self.files})
        manifest = {
            "target_date": self.target,
            "source": "arquivo.pt (nearest capture per file)",
            "window_days": self.window,
            "capture_days_used": captures,
            "files": sorted(self.files, key=lambda f: f["path"]),
            "skin_names_from_client_js": sorted(self.skins),
            "templates_expanded": self.templates,
            "not_archived": [{"name": k, "reason": v} for k, v in sorted(self.missing.items())
                             if not v.startswith(GUESS)],
            "guessed_names_not_archived": sum(1 for v in self.missing.values() if v.startswith(GUESS)),
        }
        (self.root / "snapshot-manifest.json").write_text(json.dumps(manifest, indent=2))
        total = sum(f.get("bytes", 0) for f in self.files)
        log(f"  {len(self.files)} files ({total / 1e6:.1f} MB) from capture days {', '.join(captures)}; "
            f"{len(manifest['not_archived'])} names never archived")


# --- every client, every version --------------------------------------------

CLIENT_FILES = ("client.js", "ui_bundle.js")


def all_clients(index: CaptureIndex, http: Http, out: Path, dry_run: bool) -> list:
    """Download every archived version of the game clients into out/clients/,
    pool every asset name they ask for, and write out/asset-catalog.json.
    Returns (key, reason) pairs to add to every snapshot."""
    folder = out / "clients"
    folder.mkdir(parents=True, exist_ok=True)
    named: dict = {}   # key -> {"clients": set, "guessed": bool}
    versions = []
    for key, caps in sorted(index.by_key.items()):
        if not key.endswith(CLIENT_FILES):
            continue
        for cap in caps:
            stem = key.rsplit("/", 1)[-1][:-3]
            tag = "" if cap.source == "arquivo.pt" else "-cc"
            dest = folder / f"{stem}.js@{cap.timestamp}{tag}.js"
            if dest.exists() and dest.stat().st_size > 0:
                data = dest.read_bytes()
            elif dry_run:
                log(f"  plan   {dest.name}")
                continue
            else:
                status, data = fetch_capture(http, cap)
                if status != 200:
                    log(f"  fail   {dest.name} (HTTP {status})")
                    continue
                dest.write_bytes(data)
                log(f"  saved  {dest.name} ({len(data)} bytes)")
            refs, skins, templates = extract_js_names(data.decode("utf-8", "replace"))
            base = cap.url.split("?")[0]
            certain = set()
            for ref in refs:
                guessed = ref.startswith(GUESS)
                if guessed:
                    ref = ref[len(GUESS):]
                k = url_key(urllib.parse.urljoin(base, ref.replace("\\/", "/")))
                if not k:
                    continue
                entry = named.setdefault(k, {"clients": set(), "guessed": True})
                entry["clients"].add(dest.name)
                if not guessed:
                    entry["guessed"] = False
                    certain.add(k)
            versions.append({"client": dest.name, "capture": cap.timestamp, "skin_names": len(skins),
                             "templates": len(templates), "asset_names": len(certain),
                             "path_patterns": sorted({t["template"] for t in templates})})
            log(f"  {dest.name}: {len(certain)} asset names, {len(skins)} skin names, "
                f"{len(templates)} templates")

    pooled, catalog = [], []
    for k, e in sorted(named.items()):
        caps = index.by_key.get(k, [])
        if e["guessed"] and not caps:
            continue  # a guessed combination that matches nothing archived
        clients = sorted(e["clients"])
        reason = ("guessed from " if e["guessed"] else "named in ") + ", ".join(clients)
        pooled.append((k, (GUESS if e["guessed"] else "") + "all clients: " + reason))
        catalog.append({"name": k, "clients": clients, "guessed": e["guessed"],
                        "archived_captures": [f"{c.timestamp} {c.source}" for c in caps]})
    have = sum(1 for c in catalog if c["archived_captures"])
    if not dry_run:
        (out / "asset-catalog.json").write_text(json.dumps({
            "source": "asset names extracted from every archived mope.io client version",
            "client_versions": versions, "names": len(catalog), "archived_by_arquivo_pt": have,
            "never_archived": len(catalog) - have, "assets": catalog}, indent=2))
    log(f"All clients: {len(catalog)} asset names; {have} archived by arquivo.pt, "
        f"{len(catalog) - have} never archived")
    return pooled


# --- main ------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Rebuild mope.io for given dates from arquivo.pt.")
    ap.add_argument("dates", nargs="*", default=DEFAULT_DATES, help="target dates, YYYYMMDD")
    ap.add_argument("--out", default="archive", help="output folder (default: archive)")
    ap.add_argument("--window", type=float, default=45, help="also take every file captured within N days (default 45)")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between requests (default 1.5)")
    ap.add_argument("--retries", type=int, default=5)
    ap.add_argument("--refresh-index", action="store_true", help="re-download the capture indexes")
    ap.add_argument("--commoncrawl", action="store_true",
                    help="also search Common Crawl's crawls for mope.io and use its captures as a second source")
    ap.add_argument("--cc-since", default="2016", help="only Common Crawl crawls from this year on (default 2016)")
    ap.add_argument("--cc-workers", type=int, default=4, help="Common Crawl crawls to search at once (default 4)")
    ap.add_argument("--all", action="store_true",
                    help="also include every mope.io file arquivo.pt ever captured (nearest copy to each date)")
    ap.add_argument("--all-clients", action="store_true",
                    help="download every archived client.js/ui_bundle.js version into <out>/clients/, "
                         "extract every asset name from all of them for every date, and write "
                         "<out>/asset-catalog.json")
    ap.add_argument("--dry-run", action="store_true", help="show what would be fetched")
    args = ap.parse_args(argv)

    for d in args.dates:
        if not re.fullmatch(r"\d{8}", d):
            ap.error(f"bad date {d!r}; use YYYYMMDD")

    out = Path(args.out)
    http = Http(delay=args.delay, retries=args.retries)
    index = CaptureIndex.load(http, out / ".arquivo-cdx-mope.io.jsonl", args.refresh_index)
    if args.commoncrawl:
        cc = commoncrawl_rows(Http(delay=args.delay, retries=args.retries), out,
                              args.cc_since, args.refresh_index, workers=args.cc_workers)
        n = index.add_rows(cc, "commoncrawl")
        log(f"Common Crawl: {n} usable captures added "
            f"({len({url_key(r['url']) for r in cc if str(r.get('status')) == '200'} - {None})} distinct files)")
    pooled = all_clients(index, http, out, args.dry_run) if args.all_clients else []
    cache: dict = {}
    for d in args.dates:
        Snapshot(target=d, root=out / f"arquivo-{d}", index=index, http=http,
                 window=args.window, dry_run=args.dry_run, cache=cache, take_all=args.all,
                 pooled=list(pooled)).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
