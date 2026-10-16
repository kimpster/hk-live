# HK Live — Hong Kong Transport & Rain (GitHub Pages)

A dependency-light static site (plain JS + [Leaflet](https://leafletjs.com)) showing **live
public transport arrivals** and **rainfall nowcast** for Hong Kong. Works on desktop and
mobile, in English and 繁體中文.

Live ETA data is fetched **only when you tap a stop**, directly from the operators'
open-data APIs — the map itself runs off static data files in this repo, so browsing
the map costs the public APIs nothing.

## Features

- **Map of every stop**: MTR (97 stations), Light Rail (68 stops), KMB + CTB bus stops
  and GMB green-minibus stops (~13,700 raw stops, merged into ~11,100 markers).
  Co-located stops from *different* operators within **12 m** are merged into one marker
  (same pole / shelter); same-operator and rail stops are never merged.
- **Tap a stop → live arrivals** from:
  - MTR heavy rail — [Next Train data](https://data.gov.hk/en-data/dataset/mtr-data2-nexttrain-data)
  - Light Rail — [LR Next Train](https://data.gov.hk/en-data/dataset/mtr-lrnt_data-light-rail-nexttrain-data)
  - KMB — [ETA](https://data.gov.hk/en-data/dataset/hk-td-tis_21-etakmb)
  - CTB — [real-time ETA](https://data.gov.hk/en-data/dataset/ctb-eta-transport-realtime-eta)
  - GMB — [real-time arrival](https://data.gov.hk/en-data/dataset/hk-td-sm_7-real-time-arrival-data-of-gmb)
  ETAs auto-refresh every 30 s while the panel is open.
- **Geolocation**: asks on load; if denied/unavailable the map falls back to Central.
  The view is deep-linkable via the URL hash (`#lat,lng,zoom`).
- **Rainfall nowcast overlay** from
  [HKO gridded rainfall nowcast](https://data.gov.hk/en-data/dataset/hk-hko-rss-gridded-rainfall-nowcast-in-hong-kong)
  (next-30-minute accumulated rainfall, ~2 km grid), plus the 9-day **probability of
  significant rain** from HKO's forecast API. Hourly probabilities are not published in
  HKO open data, so daily values are shown.
- **Nearby stops list** sorted by distance from you (or the map centre).

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch `main`, folder `/ (root)`.
3. Enable Actions (repo **Settings → Actions → General → Allow all actions**) so
   `.github/workflows/update-rainfall.yml` can run. It fetches HKO's nowcast CSV every
   10 minutes, crops it to Hong Kong and commits `assets/data/rainfall.json` — the
   upstream CSV has no CORS headers, so the browser cannot fetch it directly. Without
   the Action the rain overlay simply reports that data is unavailable.

The site is fully static: no build step, no server, no API keys.

## Refreshing the static stop data

Occasionally (operators add/move stops):

```sh
python3 tools/fetch_kmb.py     # KMB stop list (single request)
python3 tools/fetch_ctb.py     # Citybus routes/stops (crawls the route-stop API)
python3 tools/fetch_gmb.py     # GMB routes/stops (crawls route-stop lists)
python3 tools/fetch_mtr.py     # MTR + Light Rail stations (MTR CSVs + OSM coords)
python3 tools/build_stops.py   # aggregates everything into assets/data/stops.json
```

`fetch_ctb.py` / `fetch_gmb.py` take a few minutes each and are throttled to be polite
to the government APIs.

## Notes

- All runtime API calls go to CORS-enabled government endpoints; nothing is proxied.
- Coordinates for MTR/LR stations come from OpenStreetMap (via Overpass), matched
  against MTR's official station-code CSVs.
- Data sources: MTR Corporation, KMB, CTB, Transport Department (GMB), Hong Kong
  Observatory, OpenStreetMap contributors.
