#!/usr/bin/env python3
"""Download KMB's full stop list (one request) into assets/data/raw/kmb_stops.json."""
import json
import os
import urllib.request

URL = "https://data.etabus.gov.hk/v1/transport/kmb/stop"
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "data", "raw", "kmb_stops.json")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
req = urllib.request.Request(URL, headers={"User-Agent": "hkfg-static-builder/1.0"})
with urllib.request.urlopen(req, timeout=60) as r:
    d = json.loads(r.read().decode("utf-8"))
with open(OUT, "w") as f:
    json.dump(d, f, ensure_ascii=False)
print(f"saved {len(d['data'])} KMB stops")
