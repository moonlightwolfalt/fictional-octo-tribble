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

Options: `--date YYYYMMDD`, `--out DIR`, `--domain HOST`, `--delay SECONDS`
(be kind to archive.org), `--retries N`, `--force` (re-download), `--crawl`, `--list`.

Files are fetched raw (`id_` mode), so you get the original HTML/JS/PNGs without
the Wayback toolbar or rewritten links. With `--crawl`, files that weren't captured
on that exact day come from the nearest capture; `manifest.json` records the real
timestamp of each file.
