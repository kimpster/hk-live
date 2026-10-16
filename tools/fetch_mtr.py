#!/usr/bin/env python3
"""Build MTR (heavy rail) + Light Rail station data from MTR's own CSVs,
geocoded via OpenStreetMap Overpass.

Outputs (assets/data/):
  mtr.json  {"stations":[{code,en,tc,lat,lng,lines:[LINE]}], "code2name":{...}}
  lr.json   {"stops":[{id,code,en,tc,lat,lng}]}
"""
import csv
import io
import json
import os
import re
import time
import urllib.request

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "data")
UA = "hkfg-static-builder/1.0 (GitHub Pages transport map)"

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# OSM name -> MTR English name fixes where auto-match fails (filled after runs)
NAME_OVERRIDES = {
    "mtr": {
        # OSM name : MTR CSV english name
        "University Station": "University",
        "Mong Kok East": "Mong Kok East",
    },
    "lr": {},
}

# Coordinates for stations Overpass didn't return (verified via Nominatim/OSM)
COORD_OVERRIDES = {
    "DIH": (22.3407327, 114.2018845),  # Diamond Hill
    "HOK": (22.2840984, 114.1589198),  # Hong Kong
}

QUERY = r"""
[out:json][timeout:120];
(
  node["railway"="station"](22.05,113.70,22.62,114.55);
  node["railway"="halt"](22.05,113.70,22.62,114.55);
  node["railway"="tram_stop"](22.05,113.70,22.62,114.55);
  way["railway"="station"](22.05,113.70,22.62,114.55);
);
out center;
"""


def http(url, data=None, headers=None, timeout=90):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def overpass():
    for mirror in OVERPASS_MIRRORS:
        try:
            print("trying", mirror)
            return json.loads(http(mirror, data=QUERY.encode(), headers={"Content-Type": "text/plain"}))
        except Exception as e:
            print("  failed:", e)
            time.sleep(2)
    raise SystemExit("all Overpass mirrors failed")


def norm(s):
    s = s.lower()
    s = re.sub(r"[^a-z0-9]", "", s)
    return s


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    mtr_csv = http("https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv").decode("utf-8-sig")
    lr_csv = http("https://opendata.mtr.com.hk/data/light_rail_routes_and_stops.csv").decode("utf-8-sig")

    # heavy rail: station code -> {en, tc, lines set}; keep direction-independent
    stations = {}
    for row in csv.DictReader(io.StringIO(mtr_csv)):
        code = row["Station Code"].strip()
        if not code:
            continue
        st = stations.setdefault(code, {"code": code, "en": row["English Name"],
                                        "tc": row["Chinese Name"], "lines": set()})
        st["lines"].add(row["Line Code"])

    lr_stops = {}
    for row in csv.DictReader(io.StringIO(lr_csv)):
        sid = row["Stop ID"]
        lr_stops.setdefault(sid, {"id": sid, "code": row["Stop Code"],
                                  "en": row["English Name"], "tc": row["Chinese Name"],
                                  "lines": set()})["lines"].add(row["Line Code"])

    ov = overpass()
    osm = []
    for el in ov.get("elements", []):
        tags = el.get("tags", {})
        if el["type"] == "way":
            c = el.get("center") or {}
            lat, lon = c.get("lat"), c.get("lon")
        else:
            lat, lon = el.get("lat"), el.get("lon")
        if lat is None:
            continue
        osm.append({
            "lat": lat, "lon": lon, "is_node": el["type"] == "node",
            "name": tags.get("name:en") or tags.get("name") or "",
            "zh": tags.get("name:zh") or tags.get("name") or "",
            "light": tags.get("station") == "light_rail" or tags.get("light_rail") == "yes"
                     or tags.get("railway") == "tram_stop",
        })
    print("OSM nodes:", len(osm))
    by_norm = {}
    for o in osm:
        by_norm.setdefault(norm(o["name"]), []).append(o)

    def geocode(name, prefer_light):
        cands = by_norm.get(norm(name), [])
        if len(cands) == 1:
            return cands[0]
        if len(cands) > 1:
            for c in cands:
                if c["light"] == prefer_light and c["is_node"]:
                    return c
            for c in cands:
                if c["light"] == prefer_light:
                    return c
            return cands[0]
        return None

    unmatched = []
    mtr_out = []
    for code, st in sorted(stations.items()):
        if code in COORD_OVERRIDES:
            lat, lon = COORD_OVERRIDES[code]
            mtr_out.append({"code": code, "en": st["en"], "tc": st["tc"],
                            "lat": round(lat, 6), "lng": round(lon, 6),
                            "lines": sorted(st["lines"])})
            continue
        hit = geocode(st["en"], prefer_light=False)
        if not hit:
            unmatched.append(("mtr", code, st["en"]))
            continue
        mtr_out.append({"code": code, "en": st["en"], "tc": st["tc"],
                        "lat": round(hit["lat"], 6), "lng": round(hit["lon"], 6),
                        "lines": sorted(st["lines"])})

    lr_out = []
    for sid, st in sorted(lr_stops.items(), key=lambda kv: int(kv[0])):
        hit = geocode(st["en"], prefer_light=True)
        if not hit:
            unmatched.append(("lr", sid, st["en"]))
            continue
        lr_out.append({"id": sid, "code": st["code"], "en": st["en"], "tc": st["tc"],
                       "lat": round(hit["lat"], 6), "lng": round(hit["lon"], 6)})

    print(f"MTR matched {len(mtr_out)}/{len(stations)}; LR matched {len(lr_out)}/{len(lr_stops)}")
    for u in unmatched:
        print("  UNMATCHED:", u)

    code2name = {s["code"]: {"en": s["en"], "tc": s["tc"]} for s in mtr_out}
    for s in lr_out:  # LR route dests come as text already; MTR dests need code lookup
        code2name.setdefault(s["code"], {"en": s["en"], "tc": s["tc"]})

    with open(os.path.join(OUT_DIR, "mtr.json"), "w") as f:
        json.dump({"stations": mtr_out, "code2name": code2name}, f, ensure_ascii=False)
    with open(os.path.join(OUT_DIR, "lr.json"), "w") as f:
        json.dump({"stops": lr_out}, f, ensure_ascii=False)
    print("saved mtr.json / lr.json")


if __name__ == "__main__":
    main()
