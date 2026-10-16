#!/usr/bin/env python3
"""Crawl TD's GMB (green minibus) open data to build a static stop list.

The ETA-by-stop endpoint only returns numeric route_ids, so we also save a
route_id -> {code, dest} mapping for display.

Outputs (assets/data/raw/):
  gmb_stops.json   {stop_id: {lat, lng, en, tc, on}}
  gmb_routes.json  {route_id: {code, seq1_dest_en, ...}}
"""
import json
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://data.etagmb.gov.hk"
UA = "hkfg-static-builder/1.0 (GitHub Pages transport map; contact via repo)"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "data", "raw")


def get(path, retries=4):
    url = f"{BASE}{path}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            if attempt == retries - 1:
                print(f"FAIL {url}: {e}")
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    route_ids = {}   # route_id -> meta
    stop_ids = {}    # stop_id -> None placeholder
    t0 = time.time()

    for region in ("NT", "KLN", "HKI"):
        d = get(f"/route/{region}")
        codes = d["data"]["routes"] if d else []
        print(region, len(codes), "routes")

        def fetch_route_meta(code):
            rd = get(f"/route/{region}/{code}")
            if not rd or not rd.get("data"):
                return
            for entry in rd["data"]:
                rid = entry["route_id"]
                meta = {"code": entry["route_code"]}
                for dr in entry.get("directions", []):
                    meta[f"d{dr['route_seq']}_en"] = dr.get("dest_en", "")
                    meta[f"d{dr['route_seq']}_tc"] = dr.get("dest_tc", "")
                route_ids[rid] = meta
            time.sleep(0.03)

        with ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(fetch_route_meta, codes))
        print(f"  meta done ({time.time()-t0:.0f}s), {len(route_ids)} route ids so far")

    pairs = []
    for rid in route_ids:
        pairs.append((rid, 1))
        pairs.append((rid, 2))
    print(len(pairs), "route-stop lists")

    def fetch_route_stops(pair):
        rid, seq = pair
        d = get(f"/route-stop/{rid}/{seq}")
        if d and d.get("data"):
            for s in d["data"]["route_stops"]:
                # /stop/{id} gives coords but no names; take names from here
                stop_ids[s["stop_id"]] = {"en": s.get("name_en", ""), "tc": s.get("name_tc", "")}
        time.sleep(0.02)

    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(fetch_route_stops, pairs))
    print(f"{len(stop_ids)} unique stops ({time.time()-t0:.0f}s)")

    stops = {}
    uniq = list(stop_ids.keys())

    def fetch_stop(sid):
        d = get(f"/stop/{sid}")
        if d and d.get("data"):
            s = d["data"]
            c = s["coordinates"]["wgs84"]
            nm = stop_ids.get(sid, {})
            stops[str(sid)] = {"lat": c["latitude"], "lng": c["longitude"],
                               "en": nm.get("en", ""), "tc": nm.get("tc", ""),
                               "on": bool(s.get("enabled", True))}
        time.sleep(0.02)

    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(fetch_stop, uniq))
    print(f"got coords for {len(stops)} stops ({time.time()-t0:.0f}s)")

    # names came from route-stop crawl; merge them in
    with open(os.path.join(OUT_DIR, "gmb_routes.json"), "w") as f:
        json.dump({str(k): v for k, v in route_ids.items()}, f, ensure_ascii=False)
    with open(os.path.join(OUT_DIR, "gmb_stops.json"), "w") as f:
        json.dump(stops, f, ensure_ascii=False)
    print("saved")


if __name__ == "__main__":
    main()
