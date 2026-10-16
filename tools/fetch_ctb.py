#!/usr/bin/env python3
"""Crawl Citybus (CTB) open data to build a static stop list + stop->routes map.

Outputs (assets/data/raw/):
  ctb_stops.json       {stop_id: {lat, lng, en, tc}}
  ctb_stop_routes.json {stop_id: [route numbers]}

Run occasionally to refresh; the site ships these as static files so users'
browsers never crawl anything.
"""
import json
import os
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

BASE = "https://rt.data.gov.hk/v1/transport/citybus-nwfb"
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
            time.sleep(1.5 * (attempt + 1))  # back off; rt.data.gov.hk WAF rate-limits bursts
    return None


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    rl = get("/route/ctb")
    routes = [r["route"] for r in rl["data"]]
    print(f"{len(routes)} routes")

    stop_ids = {}
    def crawl_route(route):
        for direction in ("outbound", "inbound"):
            d = get(f"/route-stop/ctb/{route}/{direction}")
            if d and d.get("data"):
                ids = [rs["stop"] for rs in d["data"]]
                stop_ids.setdefault(route, []).extend(ids)
            time.sleep(0.05)

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(crawl_route, routes))
    print(f"route-stop crawl done in {time.time()-t0:.0f}s")

    stops, stop_routes = {}, {}
    for route, ids in stop_ids.items():
        for sid in set(ids):
            stop_routes.setdefault(str(sid), []).append(route)

    uniq = list(stop_routes.keys())
    print(f"{len(uniq)} unique stops to fetch")
    t0 = time.time()
    def crawl_stop(sid):
        d = get(f"/stop/{sid}")
        if d and d.get("data"):
            s = d["data"]
            stops[str(sid)] = {"lat": float(s["lat"]), "lng": float(s["long"]),
                               "en": s.get("name_en", ""), "tc": s.get("name_tc", "")}
    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(crawl_stop, uniq))
    print(f"stop crawl done in {time.time()-t0:.0f}s, got {len(stops)}")

    with open(os.path.join(OUT_DIR, "ctb_stops.json"), "w") as f:
        json.dump(stops, f, ensure_ascii=False)
    with open(os.path.join(OUT_DIR, "ctb_stop_routes.json"), "w") as f:
        json.dump(stop_routes, f, ensure_ascii=False)
    print("saved", len(stops), "stops /", len(stop_routes), "stop-route entries")


if __name__ == "__main__":
    main()
