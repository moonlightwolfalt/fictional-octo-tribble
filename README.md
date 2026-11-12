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

## `mope_snapshots.py`: rebuild mope.io for any date from arquivo.pt

Fetches the copy of mope.io nearest each date, plus every asset its `client.js` builds at
runtime. Only the Python standard library is needed.

```sh
python3 mope_snapshots.py                    # 20170702 20181119 20190808 20201218
python3 mope_snapshots.py --all 20170213     # + every file arquivo.pt ever saved
python3 mope_snapshots.py --all --all-clients 20170213 20170702 20181119 20190808 20201218
python3 mope_snapshots.py --dry-run          # plan only
```

For each date it takes:
1. the start page nearest that date, and `client.js` (the page loads it as `client.js?x=…`);
2. every file captured within `--window` days (default 45), i.e. that period's folders;
3. every name it can rebuild from the HTML, CSS and `client.js`:
   - `"skins/" + skinName + ".png"` and `+ "2.png"`, for each animal in `client.js`;
   - `"./skins/winter/" + name + ".png"`;
   - each food in normal and `_e` (edible outline) versions;
   - ability, effect and sound files;
4. with `--all`, every one of the ~96 mope.io files arquivo.pt holds.

Each file comes from arquivo.pt's capture **nearest the date**, so a date's folder mixes
captures. `snapshot-manifest.json` records each file's real capture date and how far that
is from the target. It also lists every name the game asks for that arquivo.pt never
saved. Existence is checked against arquivo.pt's capture index (cached in
`archive/.arquivo-cdx-mope.io.jsonl`), so guessed names cost no requests.

### Every client, every version (`--all-clients`)

`--all-clients` downloads every archived game client into `archive/clients/`:
`client.js` from 2017-02-13, 2018-04-21, 2025-09-05 and 2025-12-10, plus `ui_bundle.js`
from June 2021. The 2025 clients are obfuscated (every string is `\x..` escaped), so the
script decodes them first. It then extracts every asset name from all of them, using
the 2025 `['skinName']=` and `obj['prop']` syntax as well as the older forms, and looks
for each in every date.

`archive/asset-catalog.json` lists each name, which clients ask for it, and the
arquivo.pt captures that hold it. It also has every raw path pattern per client (329
in the 2025 client), for paths with a part that can't be known for certain (species
number, season ID).

Result: the clients name **340 assets**: 183 skins, 53 food and simple objects, 19
ability images, 17 seasonal objects, 7 sounds, and more. **arquivo.pt holds only 9 of
them**, all already in the snapshots. The live mope.io site is a 2026 rewrite with new
artwork (`assets/animals/...`) and answers old paths with its own page. Its item
storage host (`s3.mope.io`) refuses access. So the other 331 can only come from the
Wayback Machine (`mope_archive.rb`, run somewhere `web.archive.org` is reachable).

### Common Crawl as a second source (`--commoncrawl`)

`--commoncrawl` searches every [Common Crawl](https://commoncrawl.org) crawl since
2016 (`--cc-since`) for mope.io. It merges those captures with arquivo.pt's, so each file
comes from whichever archive has the capture nearest the date (each manifest entry
says which). Common Crawl files are read by byte range from `data.commoncrawl.org`, then
unpacked from their archive record (gzip, then the stored HTTP response, de-chunked and
decompressed).

Common Crawl's search server is flaky. Each crawl's result is cached as it arrives
(`archive/.commoncrawl-cdx-mope.io.jsonl`, `.commoncrawl-crawls-done.json`), so a rerun
only searches the crawls that failed.

```sh
python3 mope_snapshots.py --all --all-clients --commoncrawl 20170213 20170702 20181119 20190808 20201218
```

arquivo.pt saved `client.js` only on 2017-02-13 and 2018-04-21 (and in 2025), so the
2017 date uses the 2017-02-13 client and the 2018–2020 dates use the 2018-04-21 client.

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
An Android app written in Kotlin with Jetpack Compose.

- Compile/target SDK 35, min SDK 24
- Android Gradle Plugin 8.13.2, Kotlin 2.2.21, Gradle 8.14.3 (via the wrapper)
- Requires JDK 17 or newer and the Android SDK (`platforms;android-35`, `build-tools;35.0.0`)

## Build and test

```sh
./gradlew assembleDebug        # build the debug APK -> app/build/outputs/apk/debug/
./gradlew testDebugUnitTest    # run unit tests
./gradlew lintDebug            # run Android lint
```

Point Gradle at your SDK with `ANDROID_HOME` or a `local.properties` file containing `sdk.dir=/path/to/sdk`.
