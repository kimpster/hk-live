#!/usr/bin/env python3
"""Aggregate raw operator data into the single static file the site loads.

Merges bus/minibus stops that are physically the same stopping point:
  - any two stops <= MERGE_M apart (same pole/shelter, same side of the road,
    any combination of KMB/CTB/GMB), or
  - identical normalized names <= NAME_MERGE_M apart (operators record the
    same physical stop once per route group; matching names on the same
    stretch of one side of the road are the same stop group).
Rail (MTR/LR) is never merged with bus stops.

Output: assets/data/stops.json
  s  : bus/minibus clusters [latE6, lngE6, en, tc, [kmb ids], [ctb ids], [gmb ids]]
  cr : {ctb stop id: [route numbers]} (ETA endpoint needs a route param)
  gr : {gmb route id: [code, dest1_en, dest1_tc, dest2_en, dest2_tc]}
  m  : MTR stations [latE6, lngE6, en, tc, code, [lines]]
  lr : Light Rail stops [latE6, lngE6, en, tc, stop_id]
"""
import json
import math
import os
import re

RAW = os.path.join(os.path.dirname(__file__), "..", "assets", "data", "raw")
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "data", "stops.json")
MERGE_M = 20.0
NAME_MERGE_M = 50.0


def load(name):
    with open(os.path.join(RAW, name)) as f:
        return json.load(f)


class DSU:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def dist_m(a, b):
    la1, lo1 = a
    la2, lo2 = b
    r = 6371000.0
    p1, p2 = math.radians(la1), math.radians(la2)
    dp = p2 - p1
    dl = math.radians(lo2 - lo1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))


def norm_name(en):
    """Normalized stop name: drop trailing stop codes, punctuation and case."""
    s = re.sub(r"\s*\([A-Z0-9]{2,6}\)\s*$", "", en or "")
    return re.sub(r"[^A-Z0-9]", "", s.upper())


def main():
    kmb = load("kmb_stops.json")["data"]
    ctb = load("ctb_stops.json")
    gmb = load("gmb_stops.json")

    stops = []  # dicts: op, id, lat, lng, en, tc
    for s in kmb:
        stops.append({"op": "k", "id": s["stop"], "lat": float(s["lat"]), "lng": float(s["long"]),
                      "en": s["name_en"], "tc": s["name_tc"]})
    for sid, s in ctb.items():
        stops.append({"op": "c", "id": sid, "lat": s["lat"], "lng": s["lng"],
                      "en": s["en"], "tc": s["tc"]})
    for sid, s in gmb.items():
        if not s.get("on", True):
            continue
        stops.append({"op": "g", "id": str(sid), "lat": s["lat"], "lng": s["lng"],
                      "en": s["en"], "tc": s["tc"]})
    print(f"bus stops in: kmb {len(kmb)} ctb {len(ctb)} gmb {sum(1 for s in gmb.values() if s.get('on', True))}")

    # Two merge passes (union-find):
    #  1. physical proximity: any two stops <= MERGE_M apart merge (same pole /
    #     shelter cluster, same side of the road, any operator combination);
    #  2. same-name: identical normalized names <= NAME_MERGE_M apart merge
    #     (operators often record the same physical stop as one entry per
    #     route group -- same name on the same side of the road).
    cell = 0.001
    grid = {}
    for i, s in enumerate(stops):
        s["nn"] = norm_name(s["en"])
        key = (round(s["lat"] / cell), round(s["lng"] / cell))
        grid.setdefault(key, []).append(i)

    dsu = DSU(len(stops))
    merged_prox = merged_name = 0
    for (gy, gx), idxs in grid.items():
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                other = grid.get((gy + dy, gx + dx))
                if not other:
                    continue
                for i in idxs:
                    for j in other:
                        if j <= i:
                            continue
                        d = dist_m((stops[i]["lat"], stops[i]["lng"]),
                                   (stops[j]["lat"], stops[j]["lng"]))
                        if d <= MERGE_M:
                            dsu.union(i, j)
                            merged_prox += 1
                        elif (d <= NAME_MERGE_M and stops[i]["nn"] and
                              stops[i]["nn"] == stops[j]["nn"]):
                            dsu.union(i, j)
                            merged_name += 1

    clusters = {}
    for i, s in enumerate(stops):
        clusters.setdefault(dsu.find(i), []).append(s)

    out_s = []
    for members in clusters.values():
        lat = sum(m["lat"] for m in members) / len(members)
        lng = sum(m["lng"] for m in members) / len(members)
        # display name: prefer KMB > CTB > GMB (most descriptive franchise data)
        by_op = {op: [m for m in members if m["op"] == op] for op in "kcg"}
        for op in "kcg":
            by_op[op].sort(key=lambda m: (len(m["en"]), m["id"]), reverse=True)
        name_src = next((by_op[op][0] for op in "kcg" if by_op[op]), None)
        out_s.append([
            round(lat * 1e6), round(lng * 1e6),
            name_src["en"], name_src["tc"],
            [m["id"] for m in by_op["k"]],
            [m["id"] for m in by_op["c"]],
            [m["id"] for m in by_op["g"]],
        ])
    out_s.sort(key=lambda r: (r[0], r[1]))
    multi = sum(1 for r in out_s if sum(1 for x in (r[4], r[5], r[6]) if x) > 1)
    print(f"clusters: {len(out_s)} ({multi} multi-operator, "
          f"{merged_prox} proximity links, {merged_name} same-name links)")

    cr = load("ctb_stop_routes.json")
    gr_raw = load("gmb_routes.json")
    gr = {}
    for rid, m in gr_raw.items():
        gr[str(rid)] = [m.get("code", ""), m.get("d1_en", ""), m.get("d1_tc", ""),
                        m.get("d2_en", ""), m.get("d2_tc", "")]

    mtr = json.load(open(os.path.join(RAW, "..", "mtr.json")))
    out_m = [[round(s["lat"] * 1e6), round(s["lng"] * 1e6), s["en"], s["tc"], s["code"], s["lines"]]
             for s in mtr["stations"]]
    lr = json.load(open(os.path.join(RAW, "..", "lr.json")))
    out_lr = [[round(s["lat"] * 1e6), round(s["lng"] * 1e6), s["en"], s["tc"], str(s["id"])]
              for s in lr["stops"]]

    data = {"v": 1, "s": out_s, "cr": cr, "gr": gr, "m": out_m, "lr": out_lr,
            "c2n": mtr["code2name"]}
    with open(OUT, "w") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"stops.json: {os.path.getsize(OUT)/1024:.0f} KB "
          f"(bus {len(out_s)}, mtr {len(out_m)}, lr {len(out_lr)})")


if __name__ == "__main__":
    main()
