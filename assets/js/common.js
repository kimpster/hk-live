/* Shared helpers: i18n, formatting, fetching, icons. */

export const I18N = {
  en: {
    title: "HK Live", subtitle: "Transport & rain",
    fMtr: "MTR", fLr: "Light Rail", fBus: "Bus", fGmb: "Minibus",
    zoomHint: "Zoom in to see bus & minibus stops",
    rainTitle: "Rainfall",
    rainHere: "Map centre (next 30 min)",
    opacity: "Opacity",
    psrTitle: "Probability of rain (daily)",
    psrNote: "HKO open data provides the daily probability of significant rain for the next 9 days; hourly probabilities are not published.",
    nearbyTitle: "Nearby stops",
    updated: "Updated",
    refresh: "Refresh",
    arriving: "Arriving", departing: "Departing", min: "min",
    to: "to", Platform: "Platform",
    noEta: "No upcoming departures",
    loadFail: "Failed to load — will retry",
    locating: "Locating…",
    locDenied: "Location unavailable — showing Central",
    scheduled: "Scheduled",
    delayed: "Service delayed",
    rainStale: "Rainfall nowcast data is stale — GitHub Action may be disabled",
    rainMissing: "Rainfall nowcast unavailable (data file missing)",
    attrib: "Data: MTR · KMB · CTB · TD GMB · HKO — Map © OpenStreetMap contributors",
    error: "error",
    km: "km", m: "m",
    today: "Today",
  },
  tc: {
    title: "HK Live", subtitle: "交通 · 雨量",
    fMtr: "港鐵", fLr: "輕鐵", fBus: "巴士", fGmb: "專線小巴",
    zoomHint: "放大地圖以顯示巴士及小巴站",
    rainTitle: "雨量",
    rainHere: "地圖中心（未來 30 分鐘）",
    opacity: "透明度",
    psrTitle: "降雨概率（每日）",
    psrNote: "香港天文台開放資料提供未來九天的「顯著降雨概率」（每日）；並未提供每小時數據。",
    nearbyTitle: "附近車站",
    updated: "更新",
    refresh: "重新整理",
    arriving: "即將到站", departing: "即將開出", min: "分鐘",
    to: "往", Platform: "月台",
    noEta: "暫無班次資料",
    loadFail: "載入失敗——將自動重試",
    locating: "定位中…",
    locDenied: "無法取得位置——顯示中環",
    scheduled: "未開出",
    delayed: "班次延誤",
    rainStale: "降雨臨近預報資料過舊——GitHub Action 可能未啟用",
    rainMissing: "降雨臨近預報無法使用（缺少資料檔）",
    attrib: "資料：港鐵 · 九巴 · 城巴 · 運輸署專線小巴 · 天文台 — 地圖 © OpenStreetMap 貢獻者",
    error: "錯誤",
    km: "公里", m: "米",
    today: "今天",
  },
};

let _lang = localStorage.getItem("hkfg-lang") ||
  (navigator.language && navigator.language.toLowerCase().startsWith("zh") ? "tc" : "en");

export function lang() { return _lang; }

export function setLang(l) {
  _lang = l;
  localStorage.setItem("hkfg-lang", l);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    if (I18N[l][k] != null) el.innerHTML = I18N[l][k];
  });
  document.documentElement.lang = l === "tc" ? "zh-Hant" : "en";
}

export function t(key) {
  return I18N[_lang][key] ?? I18N.en[key] ?? key;
}

/** pick field for current language: obj has {en:.., tc:..} */
export function L(en, tc) { return _lang === "tc" ? (tc || en) : (en || tc); }

export function cleanName(en, tc) {
  let s = L(en, tc) || "";
  s = s.replace(/\s*\([A-Z0-9]{3,6}\)\s*$/, ""); // KMB/CTB stop codes like (WT916)
  if (_lang === "en") {
    s = s.toLowerCase().replace(/(^|[\s'’\-])([a-z])/g, (m, p, c) => p + c.toUpperCase())
      // keep short acronyms like MTR / KCRC as typed
      .replace(/\b([A-Za-z]{1,3})\b/g, (w) => (en && en.includes(w.toUpperCase()) ? w.toUpperCase() : w));
  }
  return s;
}

export function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const p1 = a.lat * r, p2 = b.lat * r;
  const dp = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function fmtDist(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} ${t("m")}`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} ${t("km")}`;
}

export function fmtClock(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtHHMMSS(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function fetchJSON(url, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* Marker glyphs */
export const GLYPH = {
  train: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2c-4.4 0-7 1.8-7 5v9.5c0 1.4 1.1 2.5 2.5 2.5H8l-1.7 2.3c-.3.4 0 .7.4.7h1.6c.3 0 .6-.1.8-.4L10.5 19h3l1.4 2.6c.2.3.5.4.8.4h1.6c.4 0 .7-.3.4-.7L16 19h.5c1.4 0 2.5-1.1 2.5-2.5V7c0-3.2-2.6-5-7-5zm-4 5h8v5H8V7zm1.5 9c-.8 0-1.5-.7-1.5-1.5S8.7 13 9.5 13s1.5.7 1.5 1.5S10.3 16 9.5 16zm5 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5z"/></svg>',
  bus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 2C4.3 2 3 3.3 3 5v13c0 .9.4 1.7 1 2.2V22c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h10v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1.8c.6-.5 1-1.3 1-2.2V5c0-1.7-1.3-3-3-3H6zm-1 4h14v7H5V6zm2 9c.8 0 1.5.7 1.5 1.5S7.8 18 7 18s-1.5-.7-1.5-1.5S6.2 15 7 15zm10 0c.8 0 1.5.7 1.5 1.5S17.8 18 17 18s-1.5-.7-1.5-1.5.7-1.5 1.5-1.5z"/></svg>',
  mini: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 3C5.3 3 4 4.3 4 6v12c0 .6.4 1 1 1h1.2c.5 0 .9-.3 1-.8l.3-1.2h9l.3 1.2c.1.5.5.8 1 .8H19c.6 0 1-.4 1-1V6c0-1.7-1.3-3-3-3H7zm-1 4h12v5H6V7zm1.5 7.5c.6 0 1 .4 1 1s-.4 1-1 1-1-.4-1-1 .4-1 1-1zm9 0c.6 0 1 .4 1 1s-.4 1-1 1-1-.4-1-1 .4-1 1-1z"/></svg>',
  mixed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4c-1.1 0-2 .9-2 2v8c0 .6.4 1 1 1h.3c.5 0 .8-.3.9-.8l.2-.7h7.2l.2.7c.1.5.4.8.9.8h.3c.6 0 1-.4 1-1V6c0-1.1-.9-2-2-2H4zm.5 2.5h9v4h-9v-4zm1 5.5c.5 0 .8.4.8.8s-.3.7-.8.7-.7-.3-.7-.7.2-.8.7-.8zm6.5 0c.5 0 .8.4.8.8s-.3.7-.8.7-.7-.3-.7-.7.2-.8.7-.8z"/><path fill="currentColor" d="M16 9c-.8 0-1.4.6-1.4 1.4v6c0 .4.3.7.7.7h.2c.3 0 .6-.2.6-.5l.2-.5h4.4l.2.5c.1.3.3.5.6.5h.2c.4 0 .7-.3.7-.7v-6c0-.8-.6-1.4-1.4-1.4H16zm.4 1.8h6.2v2.8h-6.2v-2.8zm.6 3.7c.3 0 .6.3.6.6s-.3.6-.6.6-.6-.3-.6-.6.3-.6.6-.6zm4.6 0c.3 0 .6.3.6.6s-.3.6-.6.6-.6-.3-.6-.6.3-.6.6-.6z"/></svg>',
  railM: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="none" stroke="currentColor" stroke-width="3"/><rect x="6" y="10" width="12" height="4" rx="1.5" fill="currentColor"/></svg>',
};
