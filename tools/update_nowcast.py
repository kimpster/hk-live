#!/usr/bin/env python3
"""Fetch HKO's gridded rainfall nowcast CSV (next-30-minute accumulated rainfall),
crop it to Hong Kong and write a compact JSON the site can overlay.

The upstream CSV is a 121x121 point grid (~2.16 km spacing) covering the
greater PRD area and has no CORS headers, so it cannot be fetched from the
browser. A GitHub Action runs this every 10 minutes and commits the crop.

Usage: python3 tools/update_nowcast.py [--dry]
"""
import csv
import io
import json
import os
import sys
import urllib.request

URL = ("https://data.weather.gov.hk/weatherAPI/hko_data/F3/"
       "Gridded_rainfall_nowcast.csv")
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "data", "rainfall.json")
UA = "hkfg-nowcast-updater/1.0 (GitHub Pages transport map)"

# HK + small buffer; grid rows outside this box are dropped
LAT_MIN, LAT_MAX = 22.05, 22.60
LON_MIN, LON_MAX = 113.72, 114.55


def main():
    dry = "--dry" in sys.argv
    req = urllib.request.Request(URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = r.read().decode("utf-8-sig")

    rows = list(csv.reader(io.StringIO(text)))
    updated, ending = rows[1][0], rows[1][1]  # YYYYMMDDHHmm (HKT)

    lats, lons, vals = [], [], []
    for row in rows[1:]:
        la, lo = float(row[2]), float(row[3])
        if not (LAT_MIN <= la <= LAT_MAX and LON_MIN <= lo <= LON_MAX):
            continue
        lats.append(la)
        lons.append(lo)
        vals.append(round(float(row[4]), 2))

    uniq_lat = sorted(set(lats), reverse=True)  # grid runs north -> south
    uniq_lon = sorted(set(lons))
    dlat = round(uniq_lat[0] - uniq_lat[1], 6)
    dlon = round(uniq_lon[1] - uniq_lon[0], 6)
    lat0, lon0 = uniq_lat[-1], uniq_lon[0]      # south-west corner
    ny, nx = len(uniq_lat), len(uniq_lon)

    # rows come lat-major (lat constant per row block); build v[lat_idx][lon_idx]
    v = [0.0] * (nx * ny)
    lat_idx = {la: i for i, la in enumerate(uniq_lat)}
    lon_idx = {lo: i for i, lo in enumerate(uniq_lon)}
    for la, lo, val in zip(lats, lons, vals):
        v[(ny - 1 - lat_idx[la]) * nx + lon_idx[lo]] = val  # row 0 = northernmost

    data = {
        "u": updated,
        "e": ending,
        "lat0": round(lat0, 4),
        "lon0": round(lon0, 4),
        "dlat": dlat,
        "dlon": dlon,
        "nx": nx,
        "ny": ny,
        "v": v,
    }
    if dry:
        print(json.dumps({k: data[k] for k in data if k != "v"}))
        print("max mm/30min:", max(v), "grid:", nx, "x", ny)
        return

    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"wrote {OUT}: {nx}x{ny} grid, updated {updated}, "
          f"max {max(v)} mm, {os.path.getsize(OUT)/1024:.1f} KB")


if __name__ == "__main__":
    main()
