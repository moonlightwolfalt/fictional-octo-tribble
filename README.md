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
answers those sockets itself (no dependencies):

- `lib/websocket.js`: minimal RFC 6455 WebSocket server on Node built-ins.
- `lib/mope-server.js`: region ping test, master server list, game server welcome.
- `lib/mope-world.js`: the game world, a stand-in for the unpublished 2017 server.

| Step | Client sends | Stand-in replies |
|---|---|---|
| Region ping test (7020) | `[255]` | `[255]` |
| Master (7500) | `[200]` | `[100][u32 players][u16 n]{[u32 ip][u16 players]}` |
| Game (7020) | (connects) | `[1][u16 players][u16 version=178]` → start menu |
| Join | `[2][str name][u16 w][u16 h][u8 party][u8 ?][u8 spectate]` | `[2][1][mode][u32 myId]…[minimap]` |
| Every 150 ms | `[5][i16 mouseX][i16 mouseY]`, `[21][u8 run]`, `[17]` resize, `[19]` chat | `[4][camera][stats]{new}{moved}{removed}`, `[8]` leaderboard |

Server→client strings end with a NUL byte counted in the length: the client's
`readString` drops the last byte, so without it every name loses its last letter.

### The world

The map is generated at startup (6000×6000) with the three biomes the client draws:

```
+--------------------------------------+
|               ARCTIC                 |  1200 tall, white (type 27)
+-------+----------------------+-------+
| OCEAN |         LAND         | OCEAN |  oceans 800 wide (type 19)
+-------+----------------------+-------+
```

Land gets lakes, mud, hills, burrows, berries and mushrooms; the oceans get kelp and
plankton; the arctic gets icy lakes and berries. All of it shows on the minimap.

Behind the start menu you spectate a slowly drifting camera. Press **Play** to spawn as a
mouse on land: steer with the mouse, hold left-click to run, eat food for XP, and drink
from lakes/the ocean to refill the water bar. Everyone shares one world, whichever old
server the client picks. `http://localhost:8080/status.json` lists the players and object
counts.

Not implemented yet: upgrading to other animals, abilities, combat and damage, and most
artwork (only the menu images were archived, so animals are drawn as plain circles).
