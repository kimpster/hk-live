/* Rainfall nowcast overlay + HKO 9-day probability of significant rain. */

import { t, lang, fetchJSON } from "./common.js";

const FND = () => `https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=${lang() === "tc" ? "tc" : "en"}`;

const STOPS = [
  [0.05, [125, 211, 252], 0.00],
  [2, [59, 130, 246], 0.62],
  [10, [250, 204, 21], 0.78],
  [30, [249, 115, 22], 0.88],
  [70, [239, 68, 68], 0.95],
];

function colorFor(v) {
  if (!(v > 0.03)) return null;
  let lo = STOPS[0], hi = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (v >= STOPS[i][0] && v <= STOPS[i + 1][0]) { lo = STOPS[i]; hi = STOPS[i + 1]; break; }
  }
  if (v >= STOPS[STOPS.length - 1][0]) { lo = hi = STOPS[STOPS.length - 1]; }
  const f = hi[0] === lo[0] ? 0 : (v - lo[0]) / (hi[0] - lo[0]);
  const c = lo[1].map((x, i) => Math.round(x + (hi[1][i] - x) * f));
  const a = lo[2] + (hi[2] - lo[2]) * f;
  return `rgba(${c[0]},${c[1]},${c[2]},${Math.min(0.95, 0.25 + a)})`;
}

function gridCanvas(d) {
  const cv = document.createElement("canvas");
  cv.width = d.nx; cv.height = d.ny;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, d.nx, d.ny);
  for (let y = 0; y < d.ny; y++) {
    for (let x = 0; x < d.nx; x++) {
      const col = colorFor(d.v[y * d.nx + x]);
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x - 0.5, y - 0.5, 2, 2); // slight overlap avoids hairline seams
    }
  }
  return cv;
}

function parseStamp(s) {
  // "202610161048" -> Date (HKT)
  if (!s || s.length < 12) return null;
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+08:00`);
}

function fmtStamp(s) {
  const d = parseStamp(s);
  return d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "–";
}

export class RainLayer {
  constructor(map, url = "assets/data/rainfall.json") {
    this.map = map;
    this.url = url;
    this.on = false;
    this.data = null;
    this.overlay = null;
    this.opacity = 0.7;
    this.timer = null;
    this.onChange = null;
  }

  async load() {
    const d = await fetchJSON(`${this.url}?t=${Date.now()}`, 10000);
    if (!d || !d.nx || !d.v) throw new Error("bad rainfall data");
    this.data = d;
    this.render();
    return d;
  }

  render() {
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    if (!this.data || !this.on) return;
    const d = this.data;
    const cv = gridCanvas(d);
    const south = d.lat0 - d.dlat / 2;
    const west = d.lon0 - d.dlon / 2;
    const north = d.lat0 + (d.ny - 0.5) * d.dlat;
    const east = d.lon0 + (d.nx - 0.5) * d.dlon;
    this.overlay = L.imageOverlay(cv.toDataURL("image/png"),
      [[south, west], [north, east]],
      { opacity: this.opacity, interactive: false, className: "rain-overlay" });
    this.overlay.addTo(this.map);
  }

  setOpacity(o) {
    this.opacity = o;
    if (this.overlay) this.overlay.setOpacity(o);
  }

  sample(lat, lng) {
    const d = this.data;
    if (!d) return null;
    const fy = (lat - d.lat0) / d.dlat;
    const fx = (lng - d.lon0) / d.dlon;
    const y = Math.min(d.ny - 1, Math.max(0, Math.round(d.ny - 1 - fy)));
    const x = Math.min(d.nx - 1, Math.max(0, Math.round(fx)));
    const v = d.v[y * d.nx + x];
    return v;
  }

  async enable() {
    this.on = true;
    if (!this.data) await this.load();
    else this.render();
    this.timer = setInterval(() => this.load().catch(() => {}), 6 * 60 * 1000);
  }

  disable() {
    this.on = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.render();
  }

  staleMinutes() {
    const u = parseStamp(this.data?.u);
    if (!u) return Infinity;
    return (Date.now() - u.getTime()) / 60000;
  }
}

/* ---- panel: PSR (probability of significant rain) ---- */

export async function loadPSR(onDone) {
  try {
    const d = await fetchJSON(FND(), 12000);
    onDone((d.weatherForecast || []).map((w) => ({
      date: w.forecastDate,
      week: w.week,
      psr: w.PSR || "–",
    })));
  } catch (e) {
    console.warn("fnd failed", e);
    onDone(null);
  }
}

export function renderPSR(list) {
  const ul = document.getElementById("psrList");
  if (!ul) return;
  ul.innerHTML = "";
  if (!list) {
    const li = document.createElement("li");
    li.className = "muted small";
    li.textContent = "HKO —";
    ul.appendChild(li);
    return;
  }
  const today = new Date();
  const dd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  for (const w of list) {
    const li = document.createElement("li");
    const left = document.createElement("span");
    const isToday = w.date === dd;
    left.innerHTML = `<span class="psr-date">${isToday ? t("today") : fmtDate(w.date)}</span>` +
      (w.week && !isToday ? `<span class="psr-sub">${w.week}</span>` : "");
    const b = document.createElement("span");
    b.className = `psr-badge psr-${w.psr}`;
    b.textContent = w.psr;
    li.appendChild(left);
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function fmtDate(s) {
  return `${s.slice(4, 6)}/${s.slice(6, 8)}`;
}
