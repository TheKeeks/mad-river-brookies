# Mad River Brookies

A phone-first map of wild brook trout waters around Warren / Waitsfield, Vermont:
the survey points from the Vermont Fish & Wildlife **2017 Upper Winooski Fisheries
Assessment**, the streams drawn as lines, and researched trailheads, lots and river
access with one-tap directions from the inn.

No build step to view, no accounts, no API keys. Plain HTML/CSS/JS + Leaflet.

## View it

* **Open `index.html` directly** (double-click; works from `file://`).
* **On your phone over Wi-Fi:** in this folder run `python3 -m http.server`, then open
  `http://<your-computer's-IP>:8000/` on the phone.
* **GitHub Pages:** https://thekeeks.github.io/mad-river-brookies/ (once enabled, see below).
* `cheatsheet.html` is a printable one-page list: streams by drive time, nearest lot,
  and a QR code that opens driving directions.

Screens: **Map** (presets, layers, tap a point or a stream line for its card), **Plan**
(every stream sorted by drive time from the inn, with the nearest lot and a Go button),
**Layers** (toggles, basemap, filter, exports), **Info** (legend, season, regs, sources).

Deep links: `#f=<feature id>` opens a card (e.g. `#f=s-clay-brook`), `#p=dog` loads a preset.

## Publish on GitHub Pages

Settings → Pages → *Build and deployment* → Source: **Deploy from a branch** → Branch:
**main**, folder **/ (root)** → Save. The site appears at
`https://<user>.github.io/mad-river-brookies/` within a minute or two.

**A Pages site is publicly reachable by anyone with the URL, even if the repository is
private.** Don't put anything on it you wouldn't hand to a stranger at the boat launch.

Served over https the page registers a service worker that caches the app shell and data
(not map tiles), so the Plan list and cards keep working with no signal.

## Edit the data

The CSV files in `data/` are the only source of truth; nothing is hard-coded in the page.

| file | what |
|---|---|
| `data/streams.csv` | the 43 streams: 33 B1 waters + 10 narrative-only tributaries |
| `data/access.csv` | 22 researched trailheads, lots and river-access points |
| `data/pois.csv` | inn, fly shop, Blueberry Lake, hatchery |
| `data/temperature_sites.csv` | 32 report temperature sites |
| `data/drive_times.json` | OSRM drive minutes from the inn, keyed by coordinate |
| `data/overlays/*.geojson` | fetched stream lines, watersheds, public land, fishing access, OSM |

1. Edit the CSV (long-press the map in the app to get a ready-to-paste row).
2. `python3 scripts/build.py` — validates the CSVs (bbox, watershed side, species codes,
   `serves` names, duplicates; a violation fails the build and names the row), then writes
   `data/spots.js`, `data/overlays.js` and `exports/*`.
3. Commit everything, including the generated files, so the raw GitHub links keep working.

`python3 scripts/build.py --check` additionally fails if `exports/` differ from git HEAD.
The exports are produced by the same serializer the browser's Export buttons use
(`exporters.js`, run under Node by the build), so the two are byte-identical.

### Refresh the overlays, geocodes or drive times (optional; outputs are committed)

```
pip install requests
python3 scripts/fetch_overlays.py               # everything
python3 scripts/fetch_overlays.py --overlays    # stream lines, watersheds, public land, access, OSM
python3 scripts/fetch_overlays.py --geocode     # fill blank lat/lng in streams.csv / access.csv
python3 scripts/fetch_overlays.py --drive-times # OSRM demo router, one request per point
python3 scripts/build.py
```

Raw responses are cached under `data/overlays/raw/` (git-ignored); add `--refresh` to
re-download. The script is polite (one request at a time, project User-Agent, stops on a
429) and works with whichever Overpass mirror answers.

### Optional browser test

With Playwright installed (`npm i -D playwright`), `node scripts/test_browser.js` opens the
page at 375×812 over http and `file://`, exercises presets, cards, Plan, search, a line tap,
and checks the in-browser exports match `exports/`. GitHub Actions (`.github/workflows/ci.yml`)
runs the build check and this test on every push.

## Import into other apps

* **Google My Maps:** Create a new map → Import → `exports/spots.kml` (one folder per
  layer, stream lines included) or `exports/spots.csv`.
* **Gaia GPS:** Import file → `exports/spots.gpx` (waypoints + one track per stream).
* **onX Hunt / TroutRoutes:** import GPX or KML if the app supports it — check your version.
* **Apple Maps:** no bulk import. Open a card → *Apple pin* → Save.

Raw links: `https://raw.githubusercontent.com/TheKeeks/mad-river-brookies/main/exports/spots.gpx`
(likewise `.kml`, `.csv`, `.geojson`).

## Data provenance

**Report:** Ladago, B. (2017). *2017 Upper Winooski Fisheries Assessment.* Vermont Fish &
Wildlife Department, 2017-12-15. Copy in `docs/`, original at
https://dec.vermont.gov/sites/dec/files/wsm/mapp/docs/mp_UpperWinooskiWatershedFisheriesSummary_2017-12-15.pdf.
Every report point cites its table and page and links to `<pdf>#page=N`. Data are as of
2017; populations swing year to year.

**Coordinates and confidence.** `high` = straight from the report or a verified
business/trailhead listing; `medium` = Google Places point for a natural feature (roughly
on the stream, not the survey site); `low` = geocoded, estimated or flagged — drawn dashed
with a *verify* badge until confirmed. Blank rows were geocoded on 2026-09-24: streams take
the downstream end of the matching VT Hydrography line (cross-checked against the Nominatim
OSM waterway of the same name where one exists); access points via Nominatim. Each row's
`coord_source` says exactly how.

**Rejected report coordinate.** Table 11 gives 44.175722, −72.661631 for *Mad River (above
Warren Village)*, which lands in the Dog River valley about 10 miles east — almost
certainly a transcription error. The pin sits at Warren village (confidence `low`) and the
card says so; the reach above Warren is drawn from the hydrography.

**Overlays** (all clipped to lat 43.95–44.60, lng −73.10 to −72.20, simplified, WGS84):

| layer | source |
|---|---|
| stream lines | Vermont Open Geodata Portal, *VT Hydrography Dataset – cartographic extract lines* (VCGI). Context = perennial/unspecified lines and river centerlines of order ≥ 2; named = lines matched to the 43 streams by GNIS name, disambiguated by watershed and distance; "(above …)" records keep only the reach upstream of the point |
| watersheds | USGS Watershed Boundary Dataset, HUC10 (the Mad River, Dog River and the HUC10s containing report points) |
| public land | Vermont Open Geodata Portal, *Vermont Protected Lands Database* (VCGI): parcels ≥ 3 acres that are publicly owned or carry public access |
| state fishing access | Vermont Open Geodata Portal, *Fishing Access Areas* (VT ANR); merged into the access layer, deduplicated within 150 m of a researched point |
| OSM trailheads, parking, trails | OpenStreetMap via Overpass (ODbL); parking only within 300 m of a listed stream; shown hollow and labelled unverified |
| drive times | OSRM demo router (router.project-osrm.org); points without a cached time fall back to straight-line × 1.35 at 30 mph, labelled "est." |
| live readouts | USGS Water Services (gauge 04288000, Mad River near Moretown) and NOAA/NWS forecast for the inn; fetched at runtime, fail silently offline |

Basemaps: OpenStreetMap and OpenTopoMap tiles, used per their tile policies (no bulk
downloads, attribution kept, tiles never cached by the service worker).

Leaflet 1.9.4 and qrcode-generator 1.4.4 are vendored under `vendor/` so the page works with
no signal and no CDN.

## Layout

```
index.html  style.css  app.js  exporters.js  sw.js  cheatsheet.html
data/        CSVs (canonical), drive_times.json, spots.js + overlays.js (generated), overlays/*.geojson
exports/     spots.gpx / .kml / .csv / .geojson (generated, committed)
scripts/     build.py, fetch_overlays.py, export_node.js, test_browser.js
docs/        the report PDF
vendor/      Leaflet, qrcode-generator
```
