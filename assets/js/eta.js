/* ETA fetching + rendering for a selected stop.
   All calls hit the operators' open data APIs directly (they send CORS *). */

import { t, L, cleanName, fetchJSON, sleep, fmtClock } from "./common.js";

const KMB = (id) => `https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/${id}`;
const CTB = (stop, route) => `https://rt.data.gov.hk/v1/transport/citybus-nwfb/eta/ctb/${stop}/${route}`;
const GMB = (id) => `https://data.etagmb.gov.hk/eta/stop/${id}`;
const MTR = (line, sta) => `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${line}&sta=${sta}`;
const LR = (id) => `https://rt.data.gov.hk/v1/transport/mtr/lrt/getSchedule?station_id=${id}`;

export const LINE_NAMES = {
  AEL: { en: "Airport Express", tc: "機場快綫" },
  TCL: { en: "Tung Chung Line", tc: "東涌綫" },
  TML: { en: "Tuen Ma Line", tc: "屯馬綫" },
  TKL: { en: "Tseung Kwan O Line", tc: "將軍澳綫" },
  EAL: { en: "East Rail Line", tc: "東鐵綫" },
  ISL: { en: "Island Line", tc: "港島綫" },
  KTL: { en: "Kwun Tong Line", tc: "觀塘綫" },
  TWL: { en: "Tsuen Wan Line", tc: "荃灣綫" },
  SIL: { en: "South Island Line", tc: "南港島綫" },
  DRL: { en: "Disneyland Resort Line", tc: "迪士尼綫" },
};

const OP_ORDER = { mtr: 0, lr: 1, kmb: 2, ctb: 3, gmb: 4 };
const routeNum = (s) => parseFloat(String(s).replace(/^[A-Z]+/, "")) || 0;

function minutesFrom(ts) {
  if (!ts) return null;
  const m = Math.round((new Date(ts).getTime() - Date.now()) / 60000);
  return Number.isFinite(m) ? Math.max(0, m) : null;
}

function group(push, op, route, dest, plat, entries, note) {
  if (!entries.length && !note) return;
  entries.sort((a, b) => (a.min ?? 999) - (b.min ?? 999));
  push({ op, route, dest, plat, entries, note });
}

/* ---- per-operator normalizers: response -> groups[] ---- */

function normKMB(json) {
  const out = [];
  const map = new Map();
  for (const e of json.data || []) {
    const dest = cleanName(e.dest_en, e.dest_tc);
    const key = `${e.route}|${e.dir}|${dest}`;
    if (!map.has(key)) map.set(key, []);
    const min = minutesFrom(e.eta);
    map.get(key).push({ min, at: e.eta ? new Date(e.eta) : null, note: e.eta ? null : L(e.rmk_en, e.rmk_tc) });
  }
  for (const [key, entries] of map) {
    const [route, , dest] = key.split("|");
    group((g) => out.push(g), "kmb", route, dest, null, entries);
  }
  return out;
}

function normCTB(json) {
  const out = [];
  const map = new Map();
  for (const e of json.data || []) {
    const key = `${e.route}|${cleanName(e.dest_en, e.dest_tc)}`;
    if (!map.has(key)) map.set(key, []);
    const min = minutesFrom(e.eta);
    map.get(key).push({ min, at: e.eta ? new Date(e.eta) : null, note: e.eta ? null : L(e.rmk_en, e.rmk_tc) });
  }
  for (const [key, entries] of map) {
    const [route, dest] = key.split("|");
    group((g) => out.push(g), "ctb", route, dest, null, entries);
  }
  return out;
}

function normGMB(json, gr) {
  const out = [];
  for (const d of json.data || []) {
    if (d.enabled === false) continue;
    const meta = gr[String(d.route_id)] || [String(d.route_id), "", "", "", ""];
    const dest = d.route_seq === 1 ? cleanName(meta[1], meta[2]) : cleanName(meta[3], meta[4]);
    const entries = (d.eta || []).map((e) => ({
      min: e.diff != null ? e.diff : minutesFrom(e.timestamp),
      at: e.timestamp ? new Date(e.timestamp) : null,
      note: null,
    })).filter((e) => e.min != null);
    if (!entries.length) entries.push({ min: null, at: null, note: null });
    group((g) => out.push(g), "gmb", meta[0], dest, null, entries);
  }
  return out;
}

function normMTR(json, line, c2n) {
  const out = [];
  const node = Object.values(json.data || {})[0];
  if (!node) return out;
  const map = new Map();
  for (const dir of ["UP", "DOWN"]) {
    for (const e of node[dir] || []) {
      if (e.valid !== "Y") continue;
      const key = `${dir}|${e.dest}`;
      if (!map.has(key)) map.set(key, []);
      const m = parseInt(e.ttnt, 10);
      map.get(key).push({
        min: Number.isFinite(m) ? Math.max(0, m) : null,
        at: null, plat: e.plat && e.plat !== "-" ? e.plat : null,
        hkt: (e.time || "").slice(11, 16), note: null,
      });
    }
  }
  const lineName = L(LINE_NAMES[line]?.en || line, LINE_NAMES[line]?.tc || line);
  for (const [key, entries] of map) {
    const destCode = key.split("|")[1];
    const destName = (c2n[destCode] && L(c2n[destCode].en, c2n[destCode].tc)) || destCode;
    const plats = [...new Set(entries.map((e) => e.plat).filter(Boolean))].join("/");
    entries.sort((a, b) => (a.min ?? 999) - (b.min ?? 999));
    out.push({ op: "mtr", route: lineName, dest: destName, plat: plats || null, entries, note: null });
  }
  out.delay = json.isdelay === "Y";
  return out;
}

function normLR(json) {
  const out = [];
  for (const p of json.platform_list || []) {
    const map = new Map();
    for (const r of p.route_list || []) {
      const key = `${r.route_no}|${r.dest_en}`;
      if (!map.has(key)) map.set(key, []);
      const txt = L(r.time_en, r.time_ch).replace(/ ?mins?/i, "");
      const m = parseInt(txt, 10);
      map.get(key).push({
        min: Number.isFinite(m) ? m : 0,
        at: null, text: Number.isFinite(m) ? null : L(r.time_en, r.time_ch), note: null,
      });
    }
    for (const [key, entries] of map) {
      const [route, dest] = key.split("|");
      entries.sort((a, b) => (a.min ?? 999) - (b.min ?? 999));
      out.push({ op: "lr", route, dest, plat: `${t("Platform")} ${p.platform_id}`, entries, note: null });
    }
  }
  return out;
}

/* ---- orchestrator ---- */

export function streamETAs(stop, D, onUpdate) {
  let cancelled = false;
  const res = { groups: [], errors: [] };
  const flush = () => { if (!cancelled) onUpdate({ groups: sortGroups(res.groups), errors: res.errors, busy: true }); };
  const done = () => { if (!cancelled) onUpdate({ groups: sortGroups(res.groups), errors: res.errors, busy: false }); };
  const jobs = [];

  const run = async (label, fn) => {
    try {
      const groups = await fn();
      if (groups && groups.delay) res.delay = true;
      res.groups.push(...groups);
    } catch (e) {
      console.warn("ETA fetch failed:", label, e);
      res.errors.push(label);
    }
    flush();
  };

  if (stop.kind === "mtr") {
    for (const line of stop.lines) jobs.push(run(`mtr:${line}`, async () => normMTR(await fetchJSON(MTR(line, stop.code)), line, D.c2n)));
  } else if (stop.kind === "lr") {
    jobs.push(run("lr", async () => normLR(await fetchJSON(LR(stop.id)))));
  } else {
    for (const id of stop.k || []) jobs.push(run(`kmb:${id}`, async () => normKMB(await fetchJSON(KMB(id)))));
    for (const id of stop.c || []) {
      const routes = (D.cr[id] || []).slice(0, 15);
      jobs.push(run(`ctb:${id}`, async () => {
        const parts = [];
        // stagger to stay friendly with rt.data.gov.hk rate limiting
        for (const r of routes) {
          parts.push(...normCTB(await fetchJSON(CTB(id, r))));
          await sleep(90);
        }
        return parts;
      }));
    }
    for (const id of stop.g || []) jobs.push(run(`gmb:${id}`, async () => normGMB(await fetchJSON(GMB(id)), D.gr)));
  }

  Promise.allSettled(jobs).then(done);
  return { cancel() { cancelled = true; } };
}

function sortGroups(groups) {
  return groups.slice().sort((a, b) => {
    const d = OP_ORDER[a.op] - OP_ORDER[b.op];
    if (d) return d;
    const ra = routeNum(a.route), rb = routeNum(b.route);
    if (ra !== rb) return ra - rb;
    if (a.route !== b.route) return String(a.route).localeCompare(String(b.route));
    const ma = a.entries[0]?.min ?? 999, mb = b.entries[0]?.min ?? 999;
    return ma - mb;
  });
}

/* ---- rendering ---- */

export function renderETAs(body, { groups, errors, busy }, { updatedAt, delay } = {}) {
  body.innerHTML = "";
  if (delay) {
    const el = document.createElement("div");
    el.className = "eta-note";
    el.textContent = `⚠ ${t("delayed")}`;
    body.appendChild(el);
  }
  if (!groups.length && !errors.length) {
    body.appendChild(emptyState(busy));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const sec = document.createElement("div");
    sec.className = "eta-group";
    const row = document.createElement("div");
    row.className = "eta-route-row";
    const no = document.createElement("span");
    no.className = `route-no rn-${g.op}`;
    no.textContent = g.route;
    row.appendChild(no);
    if (g.dest) {
      const d = document.createElement("span");
      d.className = "eta-dest";
      d.textContent = `${t("to")} ${g.dest}`;
      row.appendChild(d);
    }
    if (g.plat) {
      const p = document.createElement("span");
      p.className = "eta-plat";
      p.textContent = g.plat;
      row.appendChild(p);
    }
    sec.appendChild(row);

    const chips = document.createElement("div");
    chips.className = "eta-chips";
    const shown = g.entries.slice(0, 3);
    if (!shown.length) {
      const c = document.createElement("span");
      c.className = "eta-chip none";
      c.textContent = g.note || t("noEta");
      chips.appendChild(c);
    }
    for (const e of shown) {
      const c = document.createElement("span");
      c.className = "eta-chip" + (e.min != null && e.min <= 3 ? " soon" : "");
      if (e.text) {
        c.textContent = e.text;
      } else if (e.min != null) {
        const label = e.min <= 0 ? t("arriving") : `${e.min} ${t("min")}`;
        c.textContent = label;
        const sub = document.createElement("span");
        sub.className = "t";
        sub.textContent = e.hkt || (e.at ? fmtClock(e.at) : "");
        if (sub.textContent) c.appendChild(sub);
      } else {
        c.classList.add("none");
        c.textContent = e.note || "–";
      }
      chips.appendChild(c);
    }
    sec.appendChild(chips);

    const notes = [...new Set(g.entries.filter((e) => e.note).map((e) => e.note).concat(g.note ? [g.note] : []))];
    if (notes.length) {
      const n = document.createElement("div");
      n.className = "eta-note";
      n.textContent = notes.join(" · ");
      sec.appendChild(n);
    }
    frag.appendChild(sec);
  }
  for (const err of errors) {
    const el = document.createElement("div");
    el.className = "eta-error";
    el.textContent = `⚠ ${err}: ${t("loadFail")}`;
    frag.appendChild(el);
  }
  body.appendChild(frag);
  if (busy && !groups.length) body.appendChild(emptyState(true));
}

function emptyState(busy) {
  const el = document.createElement("div");
  el.className = "eta-loading";
  if (busy) {
    const sp = document.createElement("div");
    sp.className = "spinner";
    el.appendChild(sp);
    el.appendChild(document.createTextNode("…"));
  } else {
    el.textContent = t("noEta");
  }
  return el;
}
