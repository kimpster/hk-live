/* Main app: map, stop index, markers, geolocation, sheet, nearby, rain wiring. */

import { t, L as LK, setLang, lang, cleanName, haversine, fmtDist, fmtHHMMSS, fetchJSON, GLYPH } from "./common.js";
import { streamETAs, renderETAs } from "./eta.js";
import { RainLayer, loadPSR, renderPSR } from "./rain.js";

/* ---------------- state ---------------- */
const CENTRAL = [22.2819, 114.1583];
const BUS_MIN_ZOOM = 15;
const LR_MIN_ZOOM = 11;
const MAX_BUS_MARKERS = 700;
const CELL = 0.002; // grid cell ~220m for viewport queries
const cellKey = (la, ln) => `${Math.round(la / CELL)},${Math.round(ln / CELL)}`;

const D = { cr: {}, gr: {}, c2n: {} };
let bus = [], mtr = [], lr = [];
const gridIdx = new Map();

const filters = new Set(["mtr", "lr", "bus", "gmb"]);
let userPos = null, userAt = 0;
let currentStop = null, currentMarkerEl = null, etaHandle = null, etaTimer = null;
let markerCache = new Map(); // key -> {marker, kind}
const activeKeys = new Set();
let isMobile = window.matchMedia("(max-width: 899px)").matches;

const $ = (id) => document.getElementById(id);
const map = L.map("map", {
  zoomControl: false, attributionControl: true, maxZoom: 19, minZoom: 10,
  worldCopyJump: false, preferCanvas: false,
});

// deep-link support: #lat,lng,zoom (shared views / direct testing)
{
  const m = location.hash.match(/^#(-?[\d.]+),(-?[\d.]+),(\d{1,2})$/);
  if (m) map.setView([+m[1], +m[2]], Math.min(19, Math.max(10, +m[3])));
  else map.setView(CENTRAL, 15.5);
  let hashT;
  map.on("moveend", () => {
    clearTimeout(hashT);
    hashT = setTimeout(() => {
      const c = map.getCenter(), z = map.getZoom();
      history.replaceState(null, "", `#${c.lat.toFixed(5)},${c.lng.toFixed(5)},${Math.round(z)}`);
    }, 600);
  });
}

L.control.zoom({ position: "bottomleft" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

/* ---------------- data load ---------------- */
async function loadStops() {
  const d = await fetchJSON("assets/data/stops.json", 20000);
  D.cr = d.cr || {};
  D.gr = d.gr || {};
  D.c2n = d.c2n || {};
  bus = d.s.map((r, i) => ({
    i, la: r[0] / 1e6, ln: r[1] / 1e6, en: r[2], tc: r[3], k: r[4], c: r[5], g: r[6],
  }));
  mtr = d.m.map((r, i) => ({ i, la: r[0] / 1e6, ln: r[1] / 1e6, en: r[2], tc: r[3], code: r[4], lines: r[5] }));
  lr = d.lr.map((r, i) => ({ i, la: r[0] / 1e6, ln: r[1] / 1e6, en: r[2], tc: r[3], id: r[4] }));
  for (const s of bus) {
    const key = cellKey(s.la, s.ln);
    let a = gridIdx.get(key);
    if (!a) gridIdx.set(key, (a = []));
    a.push(s.i);
  }
  refreshMarkers();
}

/* ---------------- markers ---------------- */
function busModes(s) {
  const hasBus = s.k.length || s.c.length;
  const hasGmb = s.g.length > 0;
  return { hasBus, hasGmb };
}

function makeMarker(key, obj) {
  let cls, glyph, size, name, labelCls;
  if (key[0] === "m") {
    cls = "mk-mtr"; glyph = GLYPH.railM; size = 30; name = LK(obj.en, obj.tc);
    labelCls = "mk-label-rail";
  } else if (key[0] === "l") {
    cls = "mk-lr"; glyph = GLYPH.train; size = 26; name = LK(obj.en, obj.tc);
    labelCls = "mk-label-rail";
  } else {
    const { hasBus, hasGmb } = busModes(obj);
    // simple colour language: black = bus, green = minibus, split = both
    if (hasBus && hasGmb) { cls = "mk-bus-gmb"; glyph = GLYPH.bus; }
    else if (hasGmb) { cls = "mk-gmb"; glyph = GLYPH.mini; }
    else { cls = "mk-bus"; glyph = GLYPH.bus; }
    size = 26;
    name = cleanName(obj.en, obj.tc);
    labelCls = "mk-label-bus";
  }
  const icon = L.divIcon({
    className: "mk-wrap",
    html: `<div class="mk ${cls}">${glyph}</div><div class="mk-label ${labelCls}">${name}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });
  const m = L.marker([obj.la, obj.ln], { icon, riseOnHover: true, keyboard: false });
  m.on("click", () => selectStop(obj, key, m));
  return m;
}

function refreshMarkers() {
  const z = map.getZoom();
  const wanted = new Set();
  const b = map.getBounds().pad(0.12);

  if (filters.has("mtr")) {
    for (const s of mtr) if (b.contains([s.la, s.ln])) wanted.add(`m${s.i}`);
  }
  if (filters.has("lr") && z >= LR_MIN_ZOOM) {
    for (const s of lr) if (b.contains([s.la, s.ln])) wanted.add(`l${s.i}`);
  }
  if (z >= BUS_MIN_ZOOM) {
    const center = map.getCenter();
    const cand = [];
    const lat0 = Math.round(b.getSouth() / CELL), lat1 = Math.round(b.getNorth() / CELL);
    const lng0 = Math.round(b.getWest() / CELL), lng1 = Math.round(b.getEast() / CELL);
    for (let la = lat0; la <= lat1; la++) {
      for (let ln = lng0; ln <= lng1; ln++) {
        const arr = gridIdx.get(`${la},${ln}`);
        if (!arr) continue;
        for (const i of arr) {
          const s = bus[i];
          const { hasBus, hasGmb } = busModes(s);
          if (hasBus ? !filters.has("bus") : !filters.has("gmb")) continue;
          if (!hasBus && !hasGmb) continue;
          cand.push(s);
        }
      }
    }
    cand.sort((p, q) => haversine(center, toLL(p)) - haversine(center, toLL(q)));
    for (const s of cand.slice(0, MAX_BUS_MARKERS)) wanted.add(`b${s.i}`);
  }

  document.body.classList.toggle("z-labels", z >= 16);       // rail labels
  document.body.classList.toggle("z-labels-bus", z >= 18);   // bus/minibus labels
  const showHint = (filters.has("bus") || filters.has("gmb")) && z < BUS_MIN_ZOOM;
  $("zoomHint").classList.toggle("hidden", !showHint);

  // add new
  for (const key of wanted) {
    if (activeKeys.has(key)) continue;
    const obj = key[0] === "b" ? bus[+key.slice(1)] : key[0] === "m" ? mtr[+key.slice(1)] : lr[+key.slice(1)];
    const entry = markerCache.get(key);
    if (entry) entry.marker.addTo(map);
    else {
      const entry = { marker: makeMarker(key, obj) };
      markerCache.set(key, entry);
      entry.marker.addTo(map);
    }
    activeKeys.add(key);
  }
  // remove stale
  for (const key of [...activeKeys]) {
    if (wanted.has(key)) continue;
    const entry = markerCache.get(key);
    if (entry) entry.marker.remove();
    activeKeys.delete(key);
  }
  // bound marker cache
  if (markerCache.size > 2600) {
    for (const [key, entry] of markerCache) {
      if (!activeKeys.has(key)) { entry.marker.remove(); markerCache.delete(key); }
      if (markerCache.size <= 2000) break;
    }
  }
}

map.on("moveend zoomend", () => { refreshMarkers(); updateRainHere(); });

/* ---------------- selection / sheet ---------------- */
function selectStop(obj, key, marker) {
  if (currentMarkerEl) currentMarkerEl.classList.remove("selected");
  const el = marker.getElement()?.querySelector(".mk");
  currentMarkerEl = el || null;
  if (el) el.classList.add("selected");

  currentStop = key[0] === "b"
    ? { kind: "bus", ...obj }
    : key[0] === "m" ? { kind: "mtr", ...obj } : { kind: "lr", ...obj };
  currentStop.key = key;

  $("sheetTitle").textContent = key[0] === "b" ? cleanName(obj.en, obj.tc) : LK(obj.en, obj.tc);
  const ops = $("sheetOps");
  ops.innerHTML = "";
  const opList = key[0] === "m" ? [["mtr", "MTR"]] : key[0] === "l" ? [["lr", "Light Rail"]]
    : [...obj.k.length ? [["kmb", "KMB"]] : [], ...obj.c.length ? [["ctb", "CTB"]] : [], ...obj.g.length ? [["gmb", "GMB"]] : []];
  for (const [op, label] of opList) {
    const s = document.createElement("span");
    s.className = `op-badge op-${op}`;
    s.textContent = label;
    ops.appendChild(s);
  }
  openSheet();
  startETAs();
  panForSheet([obj.la, obj.ln]);
}

function openSheet() {
  $("sheet").classList.remove("is-closed");
  $("sheet").classList.add("is-open");
  $("sheet").classList.remove("is-peek");
}
function closeSheet() {
  const sh = $("sheet");
  sh.classList.add("is-closed");
  sh.classList.remove("is-open", "is-peek");
  if (currentMarkerEl) currentMarkerEl.classList.remove("selected");
  currentMarkerEl = null;
  currentStop = null;
  stopETAs();
}
function panForSheet(latlng) {
  if (!latlng) return;
  if (isMobile) map.panBy([0, -Math.round(window.innerHeight * 0.18)]);
  else map.panBy([-210, 0]);
}

function startETAs() {
  stopETAs();
  if (!currentStop) return;
  const body = $("sheetBody");
  renderETAs(body, { groups: [], errors: [], busy: true }, {});
  etaHandle = streamETAs(currentStop, D, (res) => {
    if (!currentStop) return;
    renderETAs(body, res, { delay: res.delay });
    $("sheetUpdated").textContent = `${t("updated")} ${fmtHHMMSS(new Date())}`;
  });
  // CTB is multi-call per refresh (one request per route) — space it out to
  // 2.5 min; single-call operators (KMB/GMB/MTR/LR) can stay at 30 s.
  const refreshMs = currentStop.c && currentStop.c.length ? 150000 : 30000;
  etaTimer = setInterval(() => {
    if (document.hidden || !currentStop) return;
    startETAs();
  }, refreshMs);
}
function stopETAs() {
  if (etaHandle) etaHandle.cancel();
  etaHandle = null;
  if (etaTimer) clearInterval(etaTimer);
  etaTimer = null;
}

map.on("click", () => { if (currentStop) closeSheet(); });

/* sheet handle: collapse / expand by tap or drag */
{
  const handle = $("sheetHandle");
  let startY = null;
  handle.addEventListener("click", () => {
    const sh = $("sheet");
    sh.classList.toggle("is-peek");
  });
  handle.addEventListener("pointerdown", (e) => { startY = e.clientY; handle.setPointerCapture(e.pointerId); });
  handle.addEventListener("pointermove", (e) => {
    if (startY == null) return;
    const sh = $("sheet");
    if (e.clientY - startY > 55) { sh.classList.add("is-peek"); startY = e.clientY; }
    if (startY - e.clientY > 55) { sh.classList.remove("is-peek"); startY = e.clientY; }
  });
  handle.addEventListener("pointerup", () => { startY = null; });
}

/* ---------------- geolocation ---------------- */
let userDot = null;
function locate(interactive) {
  if (!navigator.geolocation) { if (interactive) toast(t("locDenied")); return; }
  // Browsers block geolocation on insecure origins: the published GitHub Pages
  // site (HTTPS) is fine, but http://LAN-IP previews are not.
  if (!window.isSecureContext) {
    if (interactive) toast(t("locHttps"), 5000);
    return;
  }
  $("locBtn").classList.add("locating");
  navigator.geolocation.getCurrentPosition((pos) => {
    $("locBtn").classList.remove("locating");
    userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    userAt = Date.now();
    if (!userDot) {
      userDot = L.marker([userPos.lat, userPos.lng], {
        icon: L.divIcon({
          className: "mk-wrap",
          html: '<div class="user-dot"><span></span></div>',
          iconSize: [18, 18], iconAnchor: [9, 9],
        }),
        interactive: false, zIndexOffset: 1000,
      }).addTo(map);
    } else userDot.setLatLng([userPos.lat, userPos.lng]);
    map.setView([userPos.lat, userPos.lng], Math.max(map.getZoom(), 16), { animate: true });
    updateRainHere();
    if (nearbyOpen) renderNearby();
  }, (err) => {
    $("locBtn").classList.remove("locating");
    if (!interactive) return;
    if (err && err.code === 1) toast(t("locDeniedSet"), 5000);       // permission denied
    else if (err && err.code === 3) toast(t("locTimeout"));          // timed out
    else toast(t("locDenied"));
  }, { enableHighAccuracy: true, timeout: 9000, maximumAge: 20000 });
}
locate(false);

/* ---------------- nearby panel ---------------- */
let nearbyOpen = false;
const toLL = (s) => ({ lat: s.la ?? s.lat, lng: s.ln ?? s.lng });

function nearestStops(origin, n) {
  const out = [];
  const cy = Math.round(origin.lat / CELL), cx = Math.round(origin.lng / CELL);
  for (let r = 0; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const arr = gridIdx.get(`${cy + dy},${cx + dx}`);
        if (!arr) continue;
        for (const i of arr) {
          const s = bus[i];
          out.push({ stop: s, kind: "b", d: haversine(origin, toLL(s)) });
        }
      }
    }
    if (out.length > 250) break;
  }
  for (const s of mtr) out.push({ stop: s, kind: "m", d: haversine(origin, toLL(s)) });
  for (const s of lr) out.push({ stop: s, kind: "l", d: haversine(origin, toLL(s)) });
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, n);
}

function renderNearby() {
  const origin = (userPos && Date.now() - userAt < 30 * 60000)
    ? userPos
    : (map.getCenter());
  const list = nearestStops({ lat: origin.lat, lng: origin.lng }, 24);
  const ul = $("nearbyList");
  ul.innerHTML = "";
  for (const { stop, kind, d } of list) {
    const li = document.createElement("li");
    li.setAttribute("role", "button");
    const dots = document.createElement("span");
    dots.className = "dots";
    if (kind === "m") dots.innerHTML = `<span class="dot dot-mtr"></span>`;
    else if (kind === "l") dots.innerHTML = `<span class="dot dot-lr"></span>`;
    else {
      const { hasBus, hasGmb } = busModes(stop);
      dots.innerHTML = (hasBus ? `<span class="dot dot-bus"></span>` : "") +
        (hasGmb ? `<span class="dot dot-gmb"></span>` : "");
    }
    dots.style.display = "inline-flex"; dots.style.gap = "3px";
    li.appendChild(dots);
    const nm = document.createElement("span");
    nm.className = "nearby-name";
    nm.textContent = kind === "b" ? cleanName(stop.en, stop.tc) : LK(stop.en, stop.tc);
    li.appendChild(nm);
    const dist = document.createElement("span");
    dist.className = "nearby-dist";
    dist.textContent = fmtDist(d);
    li.appendChild(dist);
    li.addEventListener("click", () => {
      map.setView([stop.la, stop.ln], Math.max(map.getZoom(), 17), { animate: true });
      refreshMarkers();
      const key = `${kind}${stop.i}`;
      // marker may not exist yet at this zoom; ensure it by direct creation
      setTimeout(() => {
        const entry = markerCache.get(key);
        const mk = entry ? entry.marker : makeMarker(key, stop);
        if (!entry) { markerCache.set(key, { marker: mk }); activeKeys.add(key); mk.addTo(map); }
        else if (!activeKeys.has(key)) { mk.addTo(map); activeKeys.add(key); }
        selectStop(stop, key, mk);
      }, 350);
    });
    ul.appendChild(li);
  }
}

/* ---------------- rain ---------------- */
const rain = new RainLayer(map);
let rainOn = false, psrLoaded = false;

async function toggleRain() {
  rainOn = !rainOn;
  $("rainBtn").classList.toggle("is-on", rainOn);
  $("rainPanel").classList.toggle("hidden", !rainOn);
  if (rainOn) {
    try {
      await rain.enable();
      updateRainMeta();
      updateRainHere();
    } catch {
      $("rainUpdated").textContent = t("rainMissing");
    }
    if (!psrLoaded) { psrLoaded = true; loadPSR(renderPSR); }
  } else {
    rain.disable();
  }
}

function updateRainMeta() {
  if (!rain.data) return;
  const stale = rain.staleMinutes();
  const base = `${t("updated")} ${fmtStamp(rain.data.u)} → ${fmtStamp(rain.data.e)}`;
  $("rainUpdated").textContent = stale > 45 ? `${base} · ${t("rainStale")}` : base;
}
function fmtStamp(s) {
  return s ? `${s.slice(8, 10)}:${s.slice(10, 12)}` : "–";
}
function updateRainHere() {
  if (!rainOn || !rain.data) return;
  const p = (userPos && Date.now() - userAt < 15 * 60000) ? userPos : map.getCenter();
  const v = rain.sample(p.lat, p.lng);
  const el = $("rainHereVal");
  const lbl = $("rainHereLabel");
  if (v == null) { el.textContent = "–"; return; }
  if (userPos && Date.now() - userAt < 15 * 60000) {
    lbl.textContent = lang() === "tc" ? "你的位置（未來 30 分鐘）" : "Your location (next 30 min)";
  } else {
    lbl.textContent = t("rainHere");
  }
  el.textContent = v <= 0.05 ? (lang() === "tc" ? "無雨" : "No rain")
    : `${v.toFixed(1)} mm`;
  const c = v > 30 ? "#b91c1c" : v > 10 ? "#b45309" : v > 2 ? "#1d4ed8" : "#334155";
  el.style.color = c;
}

/* ---------------- filters ---------------- */
document.querySelectorAll(".chip-filter").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    if (filters.has(mode)) filters.delete(mode); else filters.add(mode);
    btn.classList.toggle("is-on", filters.has(mode));
    refreshMarkers();
  });
});

/* ---------------- misc UI ---------------- */
function toast(msg, ms = 3200) {
  const el = $("statusMsg");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

$("locBtn").addEventListener("click", () => locate(true));
$("nearbyBtn").addEventListener("click", () => {
  nearbyOpen = true;
  $("nearbyPanel").classList.remove("hidden");
  renderNearby();
});
$("nearbyClose").addEventListener("click", () => { nearbyOpen = false; $("nearbyPanel").classList.add("hidden"); });
$("rainBtn").addEventListener("click", toggleRain);
$("rainPanelClose").addEventListener("click", () => { rainOn = false; rain.disable(); $("rainBtn").classList.remove("is-on"); $("rainPanel").classList.add("hidden"); });
$("rainOpacity").addEventListener("input", (e) => rain.setOpacity(e.target.value / 100));
$("sheetClose").addEventListener("click", closeSheet);
$("sheetRefresh").addEventListener("click", () => startETAs());
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (currentStop) closeSheet();
  $("nearbyPanel").classList.add("hidden"); nearbyOpen = false;
  if (rainOn) { rainOn = false; rain.disable(); $("rainBtn").classList.remove("is-on"); $("rainPanel").classList.add("hidden"); }
});

/* language toggle */
$("langBtn").addEventListener("click", () => {
  setLang(lang() === "en" ? "tc" : "en");
  $("langBtn").textContent = lang() === "en" ? "繁中" : "EN";
  markerCache.forEach((entry) => entry.marker.remove());
  markerCache.clear();
  activeKeys.clear();
  refreshMarkers();
  if (currentStop) { const s = currentStop; startETAs(); $("sheetTitle").textContent = s.kind === "bus" ? cleanName(s.en, s.tc) : LK(s.en, s.tc); }
  if (psrLoaded) loadPSR(renderPSR);
  updateRainMeta(); updateRainHere();
  if (nearbyOpen) renderNearby();
});

/* ---------------- boot ---------------- */
setLang(lang());
$("langBtn").textContent = lang() === "en" ? "繁中" : "EN";
loadStops().catch((e) => {
  console.error(e);
  toast(t("loadFail"));
  setTimeout(() => loadStops().catch(() => {}), 5000);
});
