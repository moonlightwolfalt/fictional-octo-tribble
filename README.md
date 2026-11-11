# fictional-octo-tribble

A little mope.io project. 🐭🦊🦁

## `mope_archive.rb` — fetch mope.io from the Wayback Machine

Downloads the files of mope.io as archived on **October 2nd, 2016** (the default)
into `mope_archive/<host>/...`, plus a `manifest.json` of what was fetched.
Only Ruby's standard library is needed.

```sh
ruby mope_archive.rb --list          # show what the archive has for that day
ruby mope_archive.rb                 # download those captures
ruby mope_archive.rb --crawl         # also chase sprites/scripts the pages reference
ruby mope_archive.rb --date 20161015 --out other_day
```

Options: `--archive wayback|arquivo`, `--date YYYYMMDD`, `--out DIR`, `--domain HOST`, `--delay SECONDS`
(be kind to archive.org), `--retries N`, `--force` (re-download), `--crawl`, `--list`.

Files are fetched raw (`id_` mode), so you get the original HTML/JS/PNGs without
the Wayback toolbar or rewritten links. With `--crawl`, files that weren't captured
on that exact day come from the nearest capture; `manifest.json` records the real
timestamp of each file.

### Other archives: arquivo.pt

`web.archive.org` can be unreachable from some networks, so the script can also use
[arquivo.pt](https://arquivo.pt), the Portuguese web archive. Its earliest mope.io
capture is **2017-02-13** (it has none from 2016):

```sh
ruby mope_archive.rb --archive arquivo --date 20170213 --crawl --out archive/arquivo-20170213
```

That copy is committed in [`archive/arquivo-20170213/`](archive/arquivo-20170213/):
`index.html`, `client.js`, `main.css`, `favicon.ico`, `robots.txt` and the UI images.
The audio, ability sprites and a few other files referenced by `client.js` were never
captured by arquivo.pt; `manifest.json` lists every hit and miss.

## `server.js`: play back the archive locally

Serves the fetched files with plain Node (no dependencies):

```sh
node server.js                                   # http://localhost:8080
PORT=3000 node server.js
ARCHIVE_DIR=mope_archive node server.js          # serve another fetched capture
```

It serves `<ARCHIVE_DIR>/mope.io/` first, then `www.mope.io/` and any other host
folder, uses the same file-naming rules as `mope_archive.rb` (so `?query` URLs
resolve), and returns 404 for files the archive never captured. Requests are logged,
which makes it easy to see what's missing.

`client.js` opens WebSockets to mope.io's original servers by IP (game on port 7020,
master on 7500), which no longer exist. `server.js` therefore injects a small shim into
`index.html` that reroutes `ws://<ip>:<port>` to `ws://<this host>/ws/<port>/<ip>`, and
answers those sockets itself (`lib/websocket.js`, `lib/mope-server.js`, no dependencies):

| Step | Client sends | Stand-in replies |
|---|---|---|
| Region ping test (7020) | `[255]` | `[255]` |
| Master (7500) | `[200]` | `[100][u32 players][u16 n]{[u32 ip][u16 players]}` |
| Game (7020) | (connects) | `[1][u16 players][u16 version=178]` → start menu |

The client connects and reaches the start menu. Joining a game (`[2][name]...`) is only
logged so far: the world/gameplay protocol isn't implemented yet.
