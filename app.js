/* =========================================================================
   UCAT SCORE TRACKER — app.js
   All data lives in localStorage. Nothing is sent anywhere.

   SCORING MODEL (important):
   - QR, DM, VR are each scaled 300–900. Your "cognitive total" is the SUM
     of these three, out of 2700. This is the number UCAT Consortium uses.
   - SJT is NOT scaled 300–900 and is NEVER added into that total. It is
     reported only as a Band (1 = best, 4 = lowest), derived from raw marks.
   ========================================================================= */

(function () {
  "use strict";

  const CHART_LIB_MISSING = typeof Chart === "undefined";
  if (CHART_LIB_MISSING) {
    console.error("Chart.js did not load — chart.umd.js may be missing or blocked. All graphs will show an error instead of your data.");
  }

  /* ----------------------------- CONSTANTS ----------------------------- */
  const STORAGE_KEY = "ucatTrackerData_v2";
  const SECTIONS = ["QR", "DM", "VR", "SJT"];
  const COGNITIVE_SECTIONS = ["QR", "DM", "VR"]; // the three that sum to the 2700 total
  const SECTION_NAMES = {
    QR: "Quantitative Reasoning",
    DM: "Decision Making",
    VR: "Verbal Reasoning",
    SJT: "Situational Judgement",
  };
  const SECTION_COLORS = {
    QR: "#DB7F8E",  // Old Rose
    DM: "#604D53",  // Taupe Grey
    VR: "#7C8284",  // Cool Steel (deepened)
    SJT: "#A85D68", // Terracotta — deliberately distinct: different scoring system
  };
  const SECTION_SOFT = {
    QR: "#F8DEE2",
    DM: "#E3D9DB",
    VR: "#E4E7E7",
    SJT: "#EFD9DC",
  };
  const MOCK_CATEGORIES = [
    "Full Mock",
    "Medify Mock",
    "UCAT Official Mock",
    "Mini-Mock",
    "Timed Practice",
    "Untimed Practice",
  ];
  const FULLMOCK_LIKE = ["Full Mock", "Medify Mock", "UCAT Official Mock"];
  const TIMED_LIKE = ["Full Mock", "Medify Mock", "UCAT Official Mock", "Timed Practice"];

  // Standard UCAT section structure — used to pre-fill defaults (editable for non-standard practice sets)
  const STANDARD_SECTION_INFO = {
    QR: { maxRaw: 36, time: 25 },
    DM: { maxRaw: 29, time: 31 },
    VR: { maxRaw: 44, time: 21 },
    SJT: { maxRaw: 69, time: 26 },
  };

  // Per-mock-type behaviour: drives whether "log all four at once" auto-enables,
  // and whether raw/max defaults assume the standard structure or are left for
  // the person to fill in (mini-mocks vary a lot in length by platform).
  const MOCK_PROFILES = {
    "Full Mock": { forceMulti: true, timed: true, note: "Standard full sitting — all four sections back-to-back at standard UCAT timing." },
    "Medify Mock": { forceMulti: true, timed: true, note: "Medify full mock — standard section structure, using Medify's own scaling curve." },
    "UCAT Official Mock": { forceMulti: true, timed: true, note: "Official UCAT mock — the closest available conditions and scaling to the real exam." },
    "Mini-Mock": { forceMulti: false, timed: true, customCounts: true, note: "Mini‑mocks vary in length by platform — raw/max default to blank so you can match your set's actual size." },
    "Timed Practice": { forceMulti: false, timed: true, note: "Single-section practice under standard UCAT timing." },
    "Untimed Practice": { forceMulti: false, timed: false, note: "Untimed practice — useful for isolating accuracy from speed." },
  };

  // SJT band thresholds — approximate, based on raw marks out of 69 (scaled
  // proportionally for non-standard set sizes, e.g. mini-mocks).
  const SJT_BAND_INFO = {
    1: { rangeLabel: "~57 – 69", label: "Excellent", desc: "Your judgment closely matches a panel of experts." },
    2: { rangeLabel: "~45 – 56", label: "Good", desc: "Solid performance, with many answers matching model guidelines." },
    3: { rangeLabel: "~35 – 44", label: "Modest", desc: "Appropriate judgment on some questions, but differs on others." },
    4: { rangeLabel: "< 35", label: "Low", desc: "Substantial differences compared to ideal responses." },
  };

  function computeSjtBand(raw, maxRaw) {
    if (raw === null || raw === undefined || raw === "" || isNaN(raw)) return null;
    const ref = 69;
    const norm = maxRaw ? raw * (ref / maxRaw) : raw;
    if (norm >= 57) return 1;
    if (norm >= 45) return 2;
    if (norm >= 35) return 3;
    return 4;
  }
  function sjtBandShort(band) { return band ? "Band " + band + " · " + SJT_BAND_INFO[band].label : "No data yet"; }
  function sjtBandLabel(band) { return band ? "Band " + band : "—"; }

  /* --------------------- QR / DM / VR SCALED-SCORE CURVES ---------------------
     Raw-to-scaled conversion is NOT linear in practice — prep platforms publish
     banded "estimated scaled score" tables because the real UCAT scaling shifts
     per sitting. These piecewise-linear curves are built from each band's raw
     boundary -> scaled boundary, which tracks the published tables far more
     closely than a single straight line from 0–max to 300–900.
     QR and VR curves are defined against the *standard* raw count (36, 44) and
     normalised proportionally for non-standard sets (e.g. mini-mocks). DM's
     published table is in raw-percentage terms, so it's applied directly to
     percentage rather than a fixed raw count.                                  */
  const QR_CURVE = [[0, 300], [16, 490], [17, 500], [22, 590], [23, 600], [27, 690], [28, 700], [31, 790], [32, 800], [36, 900]];
  const VR_CURVE = [[0, 300], [18, 490], [19, 500], [24, 590], [25, 600], [31, 690], [32, 700], [37, 790], [38, 800], [44, 900]];
  const DM_PCT_CURVE = [[0, 300], [39, 490], [40, 500], [54, 590], [55, 600], [69, 690], [70, 700], [84, 790], [85, 800], [100, 900]];

  // Human-readable versions of the same curves, for the in-app reference tables.
  const SCORE_CONVERSION_TABLES = {
    QR: { unitLabel: "Raw mark (out of 36)", rows: [["32 – 36", "800 – 900", "Exceptional"], ["28 – 31", "700 – 790", "Excellent"], ["23 – 27", "600 – 690", "Good / Average"], ["17 – 22", "500 – 590", "Below average"], ["0 – 16", "300 – 490", "Low"]] },
    VR: { unitLabel: "Raw mark (out of 44)", rows: [["38 – 44", "800 – 900", "86% – 100%"], ["32 – 37", "700 – 790", "73% – 84%"], ["25 – 31", "600 – 690", "57% – 70%"], ["19 – 24", "500 – 590", "43% – 55%"], ["0 – 18", "300 – 490", "0% – 41%"]] },
    DM: { unitLabel: "Raw score %", rows: [["85% – 100%", "800 – 900", "—"], ["70% – 84%", "700 – 790", "—"], ["55% – 69%", "600 – 690", "—"], ["40% – 54%", "500 – 590", "—"], ["0% – 39%", "300 – 490", "—"]] },
  };

  function interpolate(x, points) {
    if (x <= points[0][0]) return points[0][1];
    const last = points[points.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 0; i < points.length - 1; i++) {
      const [x0, y0] = points[i], [x1, y1] = points[i + 1];
      if (x >= x0 && x <= x1) return x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    return last[1];
  }

  /* ------------------------------ STORAGE ------------------------------ */
  function defaultData() {
    return {
      entries: [],
      targets: { QR: 700, DM: 700, VR: 700, SJT: 2 }, // SJT target is a Band (1 best – 4 lowest)
      settings: { lastSource: "", lastCategory: "Full Mock" },
    };
  }

  // Shared fix-up logic for data loaded from anywhere (fresh localStorage read,
  // or an imported backup file) — keeps both paths behaving identically.
  function normalizeDB(parsed) {
    if (!parsed || typeof parsed !== "object") return defaultData();
    if (!parsed.entries) parsed.entries = [];
    if (!parsed.targets) parsed.targets = defaultData().targets;
    if (parsed.targets.SJT === undefined || parsed.targets.SJT > 4) parsed.targets.SJT = 2; // migrate old 300-900 SJT target
    if (!parsed.settings) parsed.settings = defaultData().settings;
    if (parsed.settings.lastCategory === undefined) parsed.settings.lastCategory = "Full Mock";
    // Fix up any legacy SJT entries: no scaled score, band derived from raw if missing.
    parsed.entries.forEach((e) => {
      if (e.section === "SJT") {
        if (e.band === null || e.band === undefined) e.band = computeSjtBand(e.raw, e.maxRaw);
        e.scaled = null;
      }
    });
    return parsed;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      let parsed;
      if (!raw) {
        // try migrating from the old v1 key
        const oldRaw = localStorage.getItem("ucatTrackerData_v1");
        parsed = oldRaw ? JSON.parse(oldRaw) : defaultData();
      } else {
        parsed = JSON.parse(raw);
      }
      return normalizeDB(parsed);
    } catch (e) {
      console.error("Failed to load data, starting fresh.", e);
      return defaultData();
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
  }

  let DB = load();

  function uid() {
    return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  /* ------------------------------ MATH UTIL ----------------------------- */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round10(v) { return Math.round(v / 10) * 10; }

  function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function stdev(arr) {
    if (arr.length < 2) return null;
    const m = mean(arr);
    const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }
  function mode(arr) {
    if (!arr.length) return null;
    const counts = {};
    arr.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
    let best = null, bestCount = -1;
    Object.keys(counts).forEach((k) => { if (counts[k] > bestCount) { bestCount = counts[k]; best = parseInt(k, 10); } });
    return best;
  }
  function linregSlope(values) {
    const n = values.length;
    if (n < 2) return 0;
    const xs = values.map((_, i) => i);
    const mx = mean(xs), my = mean(values);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (values[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    return den === 0 ? 0 : num / den;
  }
  function rollingAverage(values, window) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - window + 1);
      const slice = values.slice(start, i + 1);
      out.push(mean(slice));
    }
    return out;
  }
  function trendLabel(slope, threshold) {
    threshold = threshold || 2;
    if (slope > threshold) return { label: "Improving", cls: "good" };
    if (slope < -threshold) return { label: "Declining", cls: "bad" };
    return { label: "Stable", cls: "neutral" };
  }
  function fmt1(v) { return v === null || v === undefined || isNaN(v) ? "—" : Math.round(v * 10) / 10; }
  function fmt0(v) { return v === null || v === undefined || isNaN(v) ? "—" : Math.round(v); }
  function fmtDate(d) {
    if (!d) return "—";
    const dt = new Date(d + "T00:00:00");
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  }

  /* --------------------------- CONVERSION HELPER ------------------------ */
  function suggestScaled(raw, maxRaw, section) {
    if (raw === null || raw === undefined || raw === "" || !maxRaw || isNaN(raw)) return null;
    if (section === "DM") {
      const pct = clamp((raw / maxRaw) * 100, 0, 100);
      return clamp(round10(interpolate(pct, DM_PCT_CURVE)), 300, 900);
    }
    if (section === "QR" || section === "VR") {
      const standardMax = STANDARD_SECTION_INFO[section].maxRaw;
      const normRaw = maxRaw === standardMax ? raw : raw * (standardMax / maxRaw);
      const curve = section === "QR" ? QR_CURVE : VR_CURVE;
      return clamp(round10(interpolate(clamp(normRaw, 0, standardMax), curve)), 300, 900);
    }
    // fallback for anything unexpected — simple proportional scaling
    const pct = clamp(raw / maxRaw, 0, 1);
    return clamp(round10(300 + pct * 600), 300, 900);
  }

  /* ----------------------------- RESULT DISPLAY -------------------------- */
  function resultShort(e) {
    if (e.section === "SJT") return e.band ? "Band " + e.band : "—";
    return e.scaled !== null && e.scaled !== undefined ? e.scaled : "—";
  }

  /* ------------------------------ DERIVED DATA --------------------------- */
  function allEntriesSorted() {
    return [...DB.entries].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  }

  function filterEntries(opts) {
    opts = opts || {};
    return allEntriesSorted().filter((e) => {
      if (opts.section && e.section !== opts.section) return false;
      if (opts.category && e.category !== opts.category) return false;
      if (opts.source && e.source !== opts.source) return false;
      if (opts.from && e.date < opts.from) return false;
      if (opts.to && e.date > opts.to) return false;
      if (opts.categories && !opts.categories.includes(e.category)) return false;
      return true;
    });
  }

  function bySection(section, opts) {
    return filterEntries(Object.assign({}, opts, { section }));
  }

  // Group entries sharing a sittingId into a single "mock sitting" row.
  // SJT is tracked separately on the sitting (band/raw) — never folded into `sections`.
  function getSittings() {
    const map = {};
    allEntriesSorted().forEach((e) => {
      if (!FULLMOCK_LIKE.includes(e.category)) return;
      const key = e.sittingId;
      if (!map[key]) {
        map[key] = {
          sittingId: key,
          date: e.date,
          testName: e.testName,
          category: e.category,
          source: e.source,
          sections: {},
          sjtBand: null,
          sjtRaw: null,
        };
      }
      if (e.section === "SJT") {
        map[key].sjtBand = e.band;
        map[key].sjtRaw = e.raw;
      } else {
        map[key].sections[e.section] = e.scaled;
      }
    });
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
  }

  function cognitiveTotal(sectionsObj) {
    return COGNITIVE_SECTIONS.reduce((sum, sec) => sum + (sectionsObj[sec] || 0), 0);
  }

  function latestEntryFor(section) {
    const arr = bySection(section);
    return arr.length ? arr[arr.length - 1] : null;
  }

  function previousEntryFor(section) {
    const arr = bySection(section);
    return arr.length > 1 ? arr[arr.length - 2] : null;
  }

  function sectionAverage(section) {
    const arr = bySection(section).map((e) => e.scaled).filter((v) => v !== null && v !== undefined);
    return mean(arr);
  }

  /* --------------------- PER-ATTEMPT TIMELINE AXIS HELPERS ---------------------
     Chart.js's "time" scale requires a date adapter (date-fns/luxon/moment) to
     work — this project deliberately doesn't load one (no extra CDN dependency
     for a local-only tool). Multi-section line charts instead share one
     chronologically-sorted timeline built from the underlying ENTRIES (not
     dates) being charted, and each section's series is aligned to it by entry
     id. This matters because more than one attempt can be logged on the same
     calendar date (e.g. backfilling several mocks in one sitting) — aligning
     by date string alone would let a later same-day entry silently overwrite
     an earlier one's slot. Aligning by entry id instead gives every logged
     attempt its own point, even when several share a date; the date simply
     repeats as the tick label for adjacent points. Chart.js skips nulls and
     (with spanGaps) draws straight through them, so each line still reads as
     a continuous trend even when sections were logged at different times.    */
  function buildAttemptTimeline(entriesList) {
    return [...entriesList].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
  }
  function seriesAlignedToTimeline(entries, timeline, valueFn) {
    const byId = {};
    entries.forEach((e) => { byId[e.id] = valueFn(e); });
    return timeline.map((slot) => (Object.prototype.hasOwnProperty.call(byId, slot.id) ? byId[slot.id] : null));
  }
  function timelineLabels(timeline) {
    return timeline.map((e) => e.date);
  }
  function dateAxisOptions() {
    return { ticks: { callback: function (value) { return fmtDate(this.getLabelForValue(value)); } } };
  }

  /* ------------------------------ CHART REGISTRY ------------------------- */
  const charts = {};
  function makeChart(canvas, config) {
    if (!canvas) return null;
    if (CHART_LIB_MISSING) { chartLibErrorState(canvas); return null; }
    const id = canvas.id;
    if (charts[id]) { charts[id].destroy(); }
    charts[id] = new Chart(canvas.getContext("2d"), config);
    return charts[id];
  }

  const baseFont = { family: "Inter, sans-serif", size: 11 };
  if (!CHART_LIB_MISSING) {
    Chart.defaults.font = baseFont;
    Chart.defaults.color = "#7C6A6F";
    Chart.defaults.borderColor = "#D5C5C8";
  }

  function emptyState(canvas) {
    if (!canvas) return;
    if (charts[canvas.id]) { charts[canvas.id].destroy(); delete charts[canvas.id]; }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.font = "13px Inter, sans-serif";
    ctx.fillStyle = "#A6898E";
    ctx.textAlign = "center";
    ctx.fillText("No data logged yet", canvas.width / 2, canvas.height / 2);
    ctx.restore();
  }

  function chartLibErrorState(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.font = "13px Inter, sans-serif";
    ctx.fillStyle = "#AD4A48";
    ctx.textAlign = "center";
    ctx.fillText("Charting library failed to load — check chart.umd.js is present", canvas.width / 2, canvas.height / 2);
    ctx.restore();
  }

  /* =========================================================================
     NAVIGATION
     ========================================================================= */
  const pages = {}; // pageKey -> DOM element

  function initSectionPages() {
    const tpl = document.getElementById("sectionPageTemplate");
    SECTIONS.forEach((sec) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.id = "page-" + sec;
      node.querySelector(".sec-eyebrow").textContent = sec + " — section analytics";
      node.querySelector(".sec-title").textContent = SECTION_NAMES[sec];
      node.querySelector(".chart-trend").id = "chart-" + sec + "-trend";
      node.querySelector(".chart-dist").id = "chart-" + sec + "-dist";
      node.querySelector(".chart-recent").id = "chart-" + sec + "-recent";
      if (sec === "SJT") {
        node.querySelector(".card-head h3").textContent = "Raw mark trend over time";
        node.querySelectorAll(".card-sub")[0].textContent = "raw marks (out of 69) with rolling average — banded, not scaled";
        node.querySelectorAll(".card-head h3")[1].textContent = "Band distribution";
      }
      document.querySelector(".main").appendChild(node);
      pages[sec] = node;
    });
  }

  function initStaticPages() {
    document.querySelectorAll(".page[id^='page-']").forEach((el) => {
      const key = el.id.replace("page-", "");
      pages[key] = el;
    });
  }

  function showPage(key) {
    Object.values(pages).forEach((p) => p.classList.remove("active"));
    if (pages[key]) pages[key].classList.add("active");
    document.querySelectorAll(".nav-link").forEach((b) => {
      b.classList.toggle("active", b.dataset.page === key);
    });
    renderPage(key);
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  function renderPage(key) {
    if (key === "dashboard") renderDashboard();
    else if (key === "entries") renderEntriesPage();
    else if (key === "fullmocks") renderFullMocksPage();
    else if (key === "minimocks") renderMiniMocksPage();
    else if (key === "practice") renderPracticePage();
    else if (key === "targets") renderTargetsPage();
    else if (key === "data") renderDataPage();
    else if (SECTIONS.includes(key)) renderSectionPage(key);
  }

  /* =========================================================================
     DIAL / SCORECARD SVG
     ========================================================================= */
  function dialSVG(value, color, min, max) {
    min = min === undefined ? 300 : min;
    max = max === undefined ? 900 : max;
    const pct = value ? clamp((value - min) / (max - min), 0, 1) : 0;
    const arcLen = 150.8; // approx semicircle length for r=48
    const dash = (pct * arcLen).toFixed(1);
    return (
      '<svg class="dial-arc" viewBox="0 0 108 60">' +
      '<path d="M10,56 A48,48 0 0 1 98,56" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="9" stroke-linecap="round"/>' +
      '<path d="M10,56 A48,48 0 0 1 98,56" fill="none" stroke="' + color + '" stroke-width="9" stroke-linecap="round" ' +
      'stroke-dasharray="' + dash + ' ' + arcLen + '"/>' +
      "</svg>"
    );
  }

  function bandBadgeHTML(band) {
    const filled = band ? 5 - band : 0;
    let tiers = "";
    for (let i = 1; i <= 4; i++) tiers += '<div class="band-tier' + (i <= filled ? " filled" : "") + '"></div>';
    const pillClass = band ? "b" + band : "bnone";
    return (
      '<div class="band-badge"><div class="band-tiers">' + tiers + "</div>" +
      '<span class="band-pill ' + pillClass + '">' + sjtBandShort(band) + "</span></div>"
    );
  }

  function renderScorecard() {
    const wrap = document.getElementById("scorecard");
    wrap.innerHTML = "";
    let total = 0, anyCognitive = false;

    COGNITIVE_SECTIONS.forEach((sec) => {
      const latest = latestEntryFor(sec);
      const prev = previousEntryFor(sec);
      const val = latest ? latest.scaled : null;
      if (val) { total += val; anyCognitive = true; }
      let deltaHTML = '<div class="dial-delta delta-flat">No data yet</div>';
      if (latest && prev) {
        const d = latest.scaled - prev.scaled;
        const cls = d > 0 ? "delta-up" : d < 0 ? "delta-down" : "delta-flat";
        const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "■";
        deltaHTML = '<div class="dial-delta ' + cls + '">' + arrow + " " + (d > 0 ? "+" : "") + d + " vs last</div>";
      } else if (latest) {
        deltaHTML = '<div class="dial-delta delta-flat">First attempt logged</div>';
      }
      wrap.innerHTML +=
        '<div class="dial">' +
        '<div class="dial-label">' + sec + "</div>" +
        dialSVG(val, SECTION_COLORS[sec]) +
        '<div class="dial-value">' + (val || "—") + "</div>" +
        deltaHTML +
        "</div>";
    });

    // Cognitive total dial — out of 2700, the real reported number
    wrap.innerHTML +=
      '<div class="dial">' +
      '<div class="dial-label">Cognitive total</div>' +
      dialSVG(anyCognitive ? total : null, "#C05F70", 900, 2700) +
      '<div class="dial-value">' + (anyCognitive ? total : "—") + "</div>" +
      '<div class="dial-total">QR + DM + VR, out of 2700</div>' +
      "</div>";

    // SJT — band badge, never summed into the total above
    const sjtLatest = latestEntryFor("SJT");
    const sjtPrev = previousEntryFor("SJT");
    let sjtDeltaHTML = '<div class="dial-delta delta-flat">No data yet</div>';
    if (sjtLatest && sjtPrev && sjtLatest.band && sjtPrev.band) {
      const d = sjtPrev.band - sjtLatest.band; // band going DOWN is an improvement
      const cls = d > 0 ? "delta-up" : d < 0 ? "delta-down" : "delta-flat";
      const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "■";
      sjtDeltaHTML = '<div class="dial-delta ' + cls + '">' + arrow + " " + (d !== 0 ? Math.abs(d) + " band" + (Math.abs(d) > 1 ? "s" : "") + (d > 0 ? " better" : " lower") : "same band") + "</div>";
    } else if (sjtLatest) {
      sjtDeltaHTML = '<div class="dial-delta delta-flat">First attempt logged</div>';
    }
    wrap.innerHTML +=
      '<div class="dial">' +
      '<div class="dial-label">SJT</div>' +
      bandBadgeHTML(sjtLatest ? sjtLatest.band : null) +
      sjtDeltaHTML +
      "</div>";

    const last = allEntriesSorted();
    const asOf = document.getElementById("dashAsOf");
    asOf.textContent = last.length ? "Last logged: " + fmtDate(last[last.length - 1].date) + " · " + last.length + " attempts total" : "No attempts logged yet";
  }

  /* =========================================================================
     DASHBOARD
     ========================================================================= */
  function renderDashboard() {
    renderScorecard();
    const entries = allEntriesSorted();
    const grid = document.getElementById("kpiGrid");
    grid.innerHTML = "";

    if (!entries.length) {
      grid.innerHTML = '<div class="kpi"><div class="kpi-label">Get started</div><div class="kpi-value" style="font-size:15px;">Log your first attempt to populate this dashboard.</div></div>';
      ["chartOverallTrend", "chartRadar", "chartStacked", "chartMedifyOfficial"].forEach((id) => emptyState(document.getElementById(id)));
      document.getElementById("radarSjtNote").textContent = "";
      document.getElementById("medOffSjtNote").textContent = "";
      return;
    }

    const cognitiveEntries = entries.filter((e) => e.scaled !== null && e.scaled !== undefined);
    const allScaled = cognitiveEntries.map((e) => e.scaled);
    const latest = entries[entries.length - 1];
    const prevOfLatestSection = previousEntryFor(latest.section);

    const sectionAverages = COGNITIVE_SECTIONS.map((s) => ({ s, avg: sectionAverage(s) })).filter((x) => x.avg !== null);
    const best = sectionAverages.length ? sectionAverages.reduce((a, b) => (b.avg > a.avg ? b : a)) : null;
    const worst = sectionAverages.length ? sectionAverages.reduce((a, b) => (b.avg < a.avg ? b : a)) : null;

    const currentPerSection = COGNITIVE_SECTIONS.map((s) => {
      const arr = bySection(s).slice(-3).map((e) => e.scaled);
      return arr.length ? mean(arr) : null;
    }).filter((v) => v !== null);
    const currentScore = currentPerSection.length ? mean(currentPerSection) : null;

    const overallSlope = allScaled.length ? linregSlope(allScaled) : 0;
    const overallTrend = trendLabel(overallSlope);

    const recent5 = allScaled.slice(-5);
    const prior5 = allScaled.slice(-10, -5);
    let recentTrend = { label: "Not enough data", cls: "neutral" };
    if (prior5.length >= 2 && recent5.length >= 2) {
      recentTrend = trendLabel(mean(recent5) - mean(prior5), 5);
    }

    const latestResult = latest.section === "SJT" ? sjtBandShort(latest.band) + " (SJT)" : latest.scaled + " (" + latest.section + ")";
    const change = latest.section === "SJT" || !prevOfLatestSection
      ? null
      : latest.scaled - prevOfLatestSection.scaled;

    const sjtAll = bySection("SJT");
    const sjtLatest = sjtAll.length ? sjtAll[sjtAll.length - 1] : null;

    const kpis = [
      { label: "Current cognitive score", value: fmt0(currentScore), sub: "avg of last 3 per section (QR/DM/VR)", cls: "neutral" },
      { label: "Latest attempt", value: latestResult, sub: fmtDate(latest.date), cls: "neutral" },
      { label: "Cognitive all-time avg", value: fmt0(mean(allScaled)), sub: cognitiveEntries.length + " QR/DM/VR attempts", cls: "neutral" },
      { label: "Highest score", value: allScaled.length ? Math.max(...allScaled) : "—", sub: "personal best (QR/DM/VR)", cls: "good" },
      { label: "Lowest score", value: allScaled.length ? Math.min(...allScaled) : "—", sub: "personal worst (QR/DM/VR)", cls: "bad" },
      { label: "Total attempts", value: entries.length, sub: "all sections combined", cls: "neutral" },
      { label: "Best section", value: best ? best.s : "—", sub: best ? fmt0(best.avg) + " avg" : "", cls: "good" },
      { label: "Weakest section", value: worst ? worst.s : "—", sub: worst ? fmt0(worst.avg) + " avg" : "", cls: "bad" },
      { label: "Overall trend", value: overallTrend.label, sub: "QR/DM/VR, full history", cls: overallTrend.cls },
      { label: "Recent trend", value: recentTrend.label, sub: "last 5 vs prior 5", cls: recentTrend.cls },
      {
        label: "Change vs previous",
        value: change === null ? "—" : (change > 0 ? "+" : "") + change,
        sub: change === null ? (latest.section === "SJT" ? "SJT is band-based" : "first attempt") : change > 0 ? "improved" : change < 0 ? "declined" : "no change",
        cls: change === null ? "neutral" : change > 0 ? "good" : change < 0 ? "bad" : "neutral",
      },
      { label: "Latest SJT band", value: sjtLatest ? sjtBandLabel(sjtLatest.band) : "—", sub: sjtLatest ? fmtDate(sjtLatest.date) : "no SJT logged yet", cls: "neutral" },
    ];

    kpis.forEach((k) => {
      grid.innerHTML +=
        '<div class="kpi"><div class="kpi-label">' + k.label + '</div><div class="kpi-value">' + k.value + '</div>' +
        '<span class="kpi-sub ' + k.cls + '">' + k.sub + "</span></div>";
    });

    renderOverallTrendChart();
    renderRadarChart();
    renderStackedChart();
    renderMedifyOfficialChart();
  }

  function renderOverallTrendChart() {
    const canvas = document.getElementById("chartOverallTrend");
    const allCognitive = COGNITIVE_SECTIONS.flatMap((sec) => bySection(sec));
    if (!allCognitive.length) { emptyState(canvas); return; }
    const timeline = buildAttemptTimeline(allCognitive);
    const labels = timelineLabels(timeline);
    const datasets = COGNITIVE_SECTIONS.map((sec) => ({
      label: sec,
      data: seriesAlignedToTimeline(bySection(sec), timeline, (e) => e.scaled),
      borderColor: SECTION_COLORS[sec],
      backgroundColor: SECTION_COLORS[sec],
      tension: 0.3,
      spanGaps: true,
      pointRadius: 3,
    }));
    makeChart(canvas, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        scales: {
          x: dateAxisOptions(),
          y: { min: 300, max: 900, title: { display: true, text: "Scaled score" } },
        },
        plugins: { legend: { position: "bottom" } },
      },
    });
  }

  function renderRadarChart() {
    const canvas = document.getElementById("chartRadar");
    const current = COGNITIVE_SECTIONS.map((s) => {
      const l = latestEntryFor(s);
      return l ? l.scaled : 300;
    });
    const target = COGNITIVE_SECTIONS.map((s) => DB.targets[s] || 700);
    makeChart(canvas, {
      type: "radar",
      data: {
        labels: COGNITIVE_SECTIONS,
        datasets: [
          { label: "Current", data: current, borderColor: "#3F3136", backgroundColor: "rgba(63,49,54,0.16)" },
          { label: "Target", data: target, borderColor: "#C05F70", backgroundColor: "rgba(192,95,112,0.10)", borderDash: [4, 4] },
        ],
      },
      options: { scales: { r: { min: 300, max: 900, ticks: { stepSize: 150 } } }, plugins: { legend: { position: "bottom" } } },
    });

    const sjtLatest = latestEntryFor("SJT");
    const targetBand = DB.targets.SJT || 2;
    document.getElementById("radarSjtNote").textContent =
      "SJT: " + (sjtLatest ? sjtBandShort(sjtLatest.band) : "no data yet") + " · target Band " + targetBand + " or better";
  }

  function renderStackedChart() {
    const canvas = document.getElementById("chartStacked");
    const sittings = getSittings().slice(-10);
    if (!sittings.length) { emptyState(canvas); return; }
    const labels = sittings.map((s) => fmtDate(s.date) + " · " + s.testName);
    const datasets = COGNITIVE_SECTIONS.map((sec) => ({
      label: sec,
      data: sittings.map((s) => s.sections[sec] || 0),
      backgroundColor: SECTION_COLORS[sec],
    }));
    makeChart(canvas, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        scales: { x: { stacked: true, ticks: { autoSkip: false, maxRotation: 60, minRotation: 30 } }, y: { stacked: true, title: { display: true, text: "Cognitive total (out of 2700)" } } },
        plugins: { legend: { position: "bottom" } },
      },
    });
  }

  function renderMedifyOfficialChart() {
    const canvas = document.getElementById("chartMedifyOfficial");
    const medify = filterEntries({ categories: ["Medify Mock"] });
    const official = filterEntries({ categories: ["UCAT Official Mock"] });
    const labels = COGNITIVE_SECTIONS;
    makeChart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Medify avg", data: COGNITIVE_SECTIONS.map((s) => fmt0(mean(medify.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: "#DB7F8E" },
          { label: "UCAT Official avg", data: COGNITIVE_SECTIONS.map((s) => fmt0(mean(official.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: "#604D53" },
        ],
      },
      options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { position: "bottom" } } },
    });

    const medifySjt = medify.filter((e) => e.section === "SJT").map((e) => e.band).filter(Boolean);
    const officialSjt = official.filter((e) => e.section === "SJT").map((e) => e.band).filter(Boolean);
    const medB = mode(medifySjt), offB = mode(officialSjt);
    document.getElementById("medOffSjtNote").textContent =
      "Most common SJT band — Medify: " + (medB ? "Band " + medB : "—") + " · UCAT Official: " + (offB ? "Band " + offB : "—");
  }

  /* =========================================================================
     SECTION ANALYTICS PAGES
     ========================================================================= */
  function renderSectionPage(sec) {
    if (sec === "SJT") { renderSjtSectionPage(); return; }

    const page = pages[sec];
    const entries = bySection(sec);
    const kpiGrid = page.querySelector(".sec-kpis");
    const statList = page.querySelector(".sec-stats");
    kpiGrid.innerHTML = "";
    statList.innerHTML = "";

    if (!entries.length) {
      kpiGrid.innerHTML = '<div class="kpi"><div class="kpi-label">No data yet</div><div class="kpi-value" style="font-size:14px;">Log a ' + sec + " attempt to see analytics.</div></div>";
      ["trend", "dist", "recent"].forEach((t) => emptyState(page.querySelector(".chart-" + t)));
      return;
    }

    const scaledArr = entries.map((e) => e.scaled);
    const latest = entries[entries.length - 1];
    const prev = entries.length > 1 ? entries[entries.length - 2] : null;
    const avg = mean(scaledArr);
    const med = median(scaledArr);
    const sd = stdev(scaledArr);
    const slope = linregSlope(scaledArr);
    const trend = trendLabel(slope);

    let improves = 0, transitions = 0, biggestJump = -Infinity, streak = 0, longestStreak = 0;
    for (let i = 1; i < scaledArr.length; i++) {
      transitions++;
      const d = scaledArr[i] - scaledArr[i - 1];
      if (d > 0) { improves++; streak++; longestStreak = Math.max(longestStreak, streak); } else { streak = 0; }
      biggestJump = Math.max(biggestJump, d);
    }
    const improvementRate = transitions ? (improves / transitions) * 100 : null;

    const otherAverages = COGNITIVE_SECTIONS.filter((s) => s !== sec).map((s) => sectionAverage(s)).filter((v) => v !== null);
    const bestOtherOrSelf = Math.max(avg, ...(otherAverages.length ? otherAverages : [avg]));
    const gapToStrongest = bestOtherOrSelf - avg;

    const change = prev ? latest.scaled - prev.scaled : null;
    const target = DB.targets[sec];

    const kpis = [
      { label: "Latest score", value: latest.scaled, sub: fmtDate(latest.date), cls: "neutral" },
      { label: "Change vs previous", value: change === null ? "—" : (change > 0 ? "+" : "") + change, sub: change === null ? "first attempt" : change > 0 ? "improved" : change < 0 ? "declined" : "no change", cls: change === null ? "neutral" : change > 0 ? "good" : change < 0 ? "bad" : "neutral" },
      { label: "Average", value: fmt0(avg), sub: entries.length + " attempts", cls: "neutral" },
      { label: "Highest / Lowest", value: Math.max(...scaledArr) + " / " + Math.min(...scaledArr), sub: "range", cls: "neutral" },
      { label: "Trend", value: trend.label, sub: "linear fit slope " + fmt1(slope), cls: trend.cls },
      { label: "Target gap", value: target ? fmt0(target - latest.scaled) : "—", sub: target ? "to reach " + target : "set a target", cls: target && latest.scaled >= target ? "good" : "bad" },
    ];
    kpis.forEach((k) => {
      kpiGrid.innerHTML += '<div class="kpi"><div class="kpi-label">' + k.label + '</div><div class="kpi-value">' + k.value + '</div><span class="kpi-sub ' + k.cls + '">' + k.sub + "</span></div>";
    });

    const stats = [
      { k: "Mean", v: fmt0(avg) },
      { k: "Median", v: fmt0(med) },
      { k: "Std deviation", v: sd === null ? "—" : fmt1(sd) },
      { k: "Improvement rate", v: improvementRate === null ? "—" : fmt0(improvementRate) + "%" },
      { k: "Biggest single jump", v: biggestJump === -Infinity ? "—" : (biggestJump > 0 ? "+" : "") + biggestJump },
      { k: "Longest improvement streak", v: longestStreak + " attempts" },
      { k: "Gap to strongest section", v: fmt0(gapToStrongest) + " pts" },
      { k: "Recent 5-attempt average", v: fmt0(mean(scaledArr.slice(-5))) },
    ];
    stats.forEach((s) => {
      statList.innerHTML += '<div class="stat-item"><div class="v">' + s.v + '</div><div class="k">' + s.k + "</div></div>";
    });

    const roll = rollingAverage(scaledArr, 3);
    makeChart(page.querySelector(".chart-trend"), {
      type: "line",
      data: {
        labels: entries.map((e) => fmtDate(e.date)),
        datasets: [
          { label: "Scaled score", data: scaledArr, borderColor: SECTION_COLORS[sec], backgroundColor: SECTION_COLORS[sec], tension: 0.25, pointRadius: 3 },
          { label: "Rolling avg (3)", data: roll, borderColor: "#9DA3A4", borderDash: [5, 4], pointRadius: 0, tension: 0.25 },
        ],
      },
      options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { position: "bottom" } } },
    });

    const buckets = {};
    for (let b = 300; b < 900; b += 50) buckets[b] = 0;
    scaledArr.forEach((v) => {
      const b = clamp(Math.floor((v - 300) / 50) * 50 + 300, 300, 850);
      buckets[b] = (buckets[b] || 0) + 1;
    });
    makeChart(page.querySelector(".chart-dist"), {
      type: "bar",
      data: {
        labels: Object.keys(buckets).map((b) => b + "–" + (parseInt(b) + 50)),
        datasets: [{ label: "Attempts", data: Object.values(buckets), backgroundColor: SECTION_SOFT[sec], borderColor: SECTION_COLORS[sec], borderWidth: 1 }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { stepSize: 1 } } } },
    });

    const recent = entries.slice(-8);
    makeChart(page.querySelector(".chart-recent"), {
      type: "bar",
      data: {
        labels: recent.map((e) => fmtDate(e.date)),
        datasets: [{ label: "Scaled score", data: recent.map((e) => e.scaled), backgroundColor: recent.map((e, i, a) => (i === 0 ? SECTION_COLORS[sec] : a[i - 1].scaled <= e.scaled ? "#4F7A5B" : "#AD4A48")) }],
      },
      options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { display: false } } },
    });
  }

  function renderSjtSectionPage() {
    const page = pages.SJT;
    const entries = bySection("SJT");
    const kpiGrid = page.querySelector(".sec-kpis");
    const statList = page.querySelector(".sec-stats");
    kpiGrid.innerHTML = "";
    statList.innerHTML = "";

    if (!entries.length) {
      kpiGrid.innerHTML = '<div class="kpi"><div class="kpi-label">No data yet</div><div class="kpi-value" style="font-size:14px;">Log an SJT attempt to see analytics.</div></div>';
      ["trend", "dist", "recent"].forEach((t) => emptyState(page.querySelector(".chart-" + t)));
      return;
    }

    const withRaw = entries.filter((e) => e.raw !== null && e.raw !== undefined);
    const rawArr = withRaw.map((e) => e.raw);
    const bandArr = entries.map((e) => e.band).filter(Boolean);
    const latest = entries[entries.length - 1];
    const prev = entries.length > 1 ? entries[entries.length - 2] : null;
    const avgRaw = mean(rawArr);
    const medRaw = median(rawArr);
    const sdRaw = stdev(rawArr);
    const slope = rawArr.length > 1 ? linregSlope(rawArr) : 0;
    const trend = trendLabel(slope, 1);
    const commonBand = mode(bandArr);

    const bandChange = prev && latest.band && prev.band ? prev.band - latest.band : null; // positive = improvement
    const targetBand = DB.targets.SJT || 2;

    const kpis = [
      { label: "Latest band", value: sjtBandLabel(latest.band), sub: fmtDate(latest.date), cls: "neutral" },
      { label: "Change vs previous", value: bandChange === null ? "—" : (bandChange > 0 ? "improved " + bandChange + " band" + (bandChange > 1 ? "s" : "") : bandChange < 0 ? "down " + Math.abs(bandChange) + " band" + (Math.abs(bandChange) > 1 ? "s" : "") : "no change"), sub: "lower band number is better", cls: bandChange === null ? "neutral" : bandChange > 0 ? "good" : bandChange < 0 ? "bad" : "neutral" },
      { label: "Average raw mark", value: fmt0(avgRaw), sub: withRaw.length + " attempts with raw marks", cls: "neutral" },
      { label: "Most common band", value: commonBand ? sjtBandLabel(commonBand) : "—", sub: SJT_BAND_INFO[commonBand] ? SJT_BAND_INFO[commonBand].label : "", cls: "neutral" },
      { label: "Raw mark trend", value: trend.label, sub: "linear fit slope " + fmt1(slope), cls: trend.cls },
      { label: "Target gap", value: latest.band ? (latest.band <= targetBand ? "Reached" : "Band " + (latest.band - targetBand) + " to go") : "—", sub: "target Band " + targetBand, cls: latest.band && latest.band <= targetBand ? "good" : "bad" },
    ];
    kpis.forEach((k) => {
      kpiGrid.innerHTML += '<div class="kpi"><div class="kpi-label">' + k.label + '</div><div class="kpi-value">' + k.value + '</div><span class="kpi-sub ' + k.cls + '">' + k.sub + "</span></div>";
    });

    const stats = [
      { k: "Mean raw mark", v: fmt0(avgRaw) },
      { k: "Median raw mark", v: fmt0(medRaw) },
      { k: "Std deviation (raw)", v: sdRaw === null ? "—" : fmt1(sdRaw) },
      { k: "Band 1 attempts", v: bandArr.filter((b) => b === 1).length },
      { k: "Band 2 attempts", v: bandArr.filter((b) => b === 2).length },
      { k: "Band 3 attempts", v: bandArr.filter((b) => b === 3).length },
      { k: "Band 4 attempts", v: bandArr.filter((b) => b === 4).length },
      { k: "Total SJT attempts logged", v: entries.length },
    ];
    stats.forEach((s) => {
      statList.innerHTML += '<div class="stat-item"><div class="v">' + s.v + '</div><div class="k">' + s.k + "</div></div>";
    });

    if (withRaw.length) {
      const roll = rollingAverage(rawArr, 3);
      makeChart(page.querySelector(".chart-trend"), {
        type: "line",
        data: {
          labels: withRaw.map((e) => fmtDate(e.date)),
          datasets: [
            { label: "Raw mark", data: rawArr, borderColor: SECTION_COLORS.SJT, backgroundColor: SECTION_COLORS.SJT, tension: 0.25, pointRadius: 3 },
            { label: "Rolling avg (3)", data: roll, borderColor: "#9DA3A4", borderDash: [5, 4], pointRadius: 0, tension: 0.25 },
          ],
        },
        options: { scales: { y: { min: 0, max: 69, title: { display: true, text: "Raw mark (/69)" } } }, plugins: { legend: { position: "bottom" } } },
      });
    } else {
      emptyState(page.querySelector(".chart-trend"));
    }

    const bandCounts = [1, 2, 3, 4].map((b) => bandArr.filter((x) => x === b).length);
    makeChart(page.querySelector(".chart-dist"), {
      type: "bar",
      data: {
        labels: ["Band 1", "Band 2", "Band 3", "Band 4"],
        datasets: [{ label: "Attempts", data: bandCounts, backgroundColor: ["#E1ECE2", "#F3EAD2", "#F6E2D7", "#F6E0DE"], borderColor: SECTION_COLORS.SJT, borderWidth: 1 }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { stepSize: 1 } } } },
    });

    const recent = entries.slice(-8);
    makeChart(page.querySelector(".chart-recent"), {
      type: "bar",
      data: {
        labels: recent.map((e) => fmtDate(e.date)),
        datasets: [{ label: "Band (1=best)", data: recent.map((e) => e.band || null), backgroundColor: SECTION_COLORS.SJT }],
      },
      options: { scales: { y: { min: 1, max: 4, reverse: true, ticks: { stepSize: 1 } } }, plugins: { legend: { display: false } } },
    });
  }

  /* =========================================================================
     FULL MOCKS PAGE
     ========================================================================= */
  function renderFullMocksPage() {
    const sittings = getSittings();
    const kpiGrid = document.getElementById("fmKpis");
    kpiGrid.innerHTML = "";
    if (!sittings.length) {
      kpiGrid.innerHTML = '<div class="kpi"><div class="kpi-label">No mocks yet</div><div class="kpi-value" style="font-size:14px;">Log a Full Mock, Medify Mock or UCAT Official Mock to populate this page.</div></div>';
      emptyState(document.getElementById("chartFmOverall"));
      emptyState(document.getElementById("chartFmSjtBand"));
      emptyState(document.getElementById("chartTimedUntimed"));
      document.getElementById("sittingsBody").innerHTML = "";
      document.getElementById("sjtSummaryBlock").innerHTML = "";
      return;
    }
    const totals = sittings.map((s) => cognitiveTotal(s.sections)).filter((t) => t > 0);
    const latest = sittings[sittings.length - 1];
    const latestTotal = cognitiveTotal(latest.sections);
    const kpis = [
      { label: "Mocks sat", value: sittings.length, sub: "full sittings logged", cls: "neutral" },
      { label: "Latest cognitive total", value: latestTotal + " / 2700", sub: fmtDate(latest.date), cls: "neutral" },
      { label: "Best total", value: (totals.length ? Math.max(...totals) : "—") + " / 2700", sub: "personal best sitting", cls: "good" },
      { label: "Average total", value: fmt0(mean(totals)) + " / 2700", sub: "across all sittings", cls: "neutral" },
      { label: "Latest SJT band", value: latest.sjtBand ? sjtBandLabel(latest.sjtBand) : "—", sub: "from latest full sitting", cls: "neutral" },
    ];
    kpis.forEach((k) => {
      kpiGrid.innerHTML += '<div class="kpi"><div class="kpi-label">' + k.label + '</div><div class="kpi-value">' + k.value + '</div><span class="kpi-sub ' + k.cls + '">' + k.sub + "</span></div>";
    });

    makeChart(document.getElementById("chartFmOverall"), {
      type: "line",
      data: {
        labels: sittings.map((s) => fmtDate(s.date) + " · " + s.testName),
        datasets: [{ label: "Cognitive total (/2700)", data: sittings.map((s) => cognitiveTotal(s.sections)), borderColor: "#3F3136", backgroundColor: "#3F3136", tension: 0.25, pointRadius: 3 }],
      },
      options: { scales: { y: { min: 900, max: 2700 } }, plugins: { legend: { display: false } } },
    });

    const sjtSittings = sittings.filter((s) => s.sjtBand);
    if (sjtSittings.length) {
      makeChart(document.getElementById("chartFmSjtBand"), {
        type: "line",
        data: {
          labels: sittings.map((s) => fmtDate(s.date) + " · " + s.testName),
          datasets: [{ label: "SJT band", data: sittings.map((s) => s.sjtBand || null), borderColor: SECTION_COLORS.SJT, backgroundColor: SECTION_COLORS.SJT, stepped: true, pointRadius: 4, spanGaps: true }],
        },
        options: { scales: { y: { min: 1, max: 4, reverse: true, ticks: { stepSize: 1 } } }, plugins: { legend: { display: false } } },
      });
    } else {
      emptyState(document.getElementById("chartFmSjtBand"));
    }

    const timed = filterEntries({ categories: ["Timed Practice"] });
    const untimed = filterEntries({ categories: ["Untimed Practice"] });
    makeChart(document.getElementById("chartTimedUntimed"), {
      type: "bar",
      data: {
        labels: COGNITIVE_SECTIONS,
        datasets: [
          { label: "Timed avg", data: COGNITIVE_SECTIONS.map((s) => fmt0(mean(timed.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: "#DB7F8E" },
          { label: "Untimed avg", data: COGNITIVE_SECTIONS.map((s) => fmt0(mean(untimed.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: "#9DA3A4" },
        ],
      },
      options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { position: "bottom" } } },
    });

    const allSjt = bySection("SJT");
    const sjtSummary = document.getElementById("sjtSummaryBlock");
    const avgRaw = mean(allSjt.filter((e) => e.raw !== null && e.raw !== undefined).map((e) => e.raw));
    const commonBand = mode(allSjt.map((e) => e.band).filter(Boolean));
    sjtSummary.innerHTML =
      '<div class="pred-item"><div class="v" style="color:' + SECTION_COLORS.SJT + '">' + fmt0(avgRaw) + '</div><div class="k">Average raw mark</div></div>' +
      '<div class="pred-item"><div class="v" style="color:' + SECTION_COLORS.SJT + '">' + (commonBand ? sjtBandLabel(commonBand) : "—") + '</div><div class="k">Most common band</div></div>';

    const body = document.getElementById("sittingsBody");
    body.innerHTML = "";
    [...sittings].reverse().forEach((s) => {
      const total = cognitiveTotal(s.sections);
      body.innerHTML +=
        "<tr><td>" + fmtDate(s.date) + "</td><td>" + esc(s.testName) + "</td><td>" + s.category + "</td><td>" + esc(s.source || "—") + "</td>" +
        COGNITIVE_SECTIONS.map((sec) => "<td>" + (s.sections[sec] || "—") + "</td>").join("") +
        "<td><strong>" + total + "</strong></td>" +
        "<td>" + (s.sjtBand ? sjtBandLabel(s.sjtBand) : "—") + "</td></tr>";
    });
  }

  /* =========================================================================
     MINI MOCKS PAGE
     ========================================================================= */
  function renderMiniMocksPage() {
    const entries = filterEntries({ categories: ["Mini-Mock"] });
    const trendCanvas = document.getElementById("chartMiniTrend");
    const avgCanvas = document.getElementById("chartMiniAvg");
    if (!entries.length) {
      emptyState(trendCanvas); emptyState(avgCanvas);
      document.getElementById("miniBody").innerHTML = "";
      return;
    }
    const cognitive = entries.filter((e) => e.section !== "SJT");
    if (cognitive.length) {
      const timeline = buildAttemptTimeline(cognitive);
      const labels = timelineLabels(timeline);
      makeChart(trendCanvas, {
        type: "line",
        data: {
          labels,
          datasets: COGNITIVE_SECTIONS.map((sec) => ({
            label: sec,
            data: seriesAlignedToTimeline(entries.filter((e) => e.section === sec), timeline, (e) => e.scaled),
            borderColor: SECTION_COLORS[sec],
            backgroundColor: SECTION_COLORS[sec],
            tension: 0.25,
            spanGaps: true,
          })),
        },
        options: { scales: { x: dateAxisOptions(), y: { min: 300, max: 900 } }, plugins: { legend: { position: "bottom" } } },
      });
      makeChart(avgCanvas, {
        type: "bar",
        data: { labels: COGNITIVE_SECTIONS, datasets: [{ label: "Mini-mock average", data: COGNITIVE_SECTIONS.map((s) => fmt0(mean(entries.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: COGNITIVE_SECTIONS.map((s) => SECTION_COLORS[s]) }] },
        options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { display: false } } },
      });
    } else {
      emptyState(trendCanvas); emptyState(avgCanvas);
    }

    const sjtMini = entries.filter((e) => e.section === "SJT");
    if (sjtMini.length) {
      const avgRaw = mean(sjtMini.filter((e) => e.raw !== null && e.raw !== undefined).map((e) => e.raw));
      const commonBand = mode(sjtMini.map((e) => e.band).filter(Boolean));
      document.getElementById("miniSjtNote").textContent =
        sjtMini.length + " SJT mini-mock(s) logged · average raw " + fmt0(avgRaw) + " · most common " + (commonBand ? sjtBandLabel(commonBand) : "band: —");
    } else {
      document.getElementById("miniSjtNote").textContent = "";
    }

    const body = document.getElementById("miniBody");
    body.innerHTML = "";
    [...entries].reverse().forEach((e) => {
      body.innerHTML += "<tr><td>" + fmtDate(e.date) + "</td><td>" + esc(e.testName) + "</td><td>" + esc(e.source || "—") + "</td><td><span class='tag tag-" + e.section.toLowerCase() + "'>" + e.section + "</span></td><td>" + (e.raw !== null ? e.raw + "/" + e.maxRaw : "—") + "</td><td>" + resultShort(e) + "</td><td>" + fmt0(e.accuracy) + "%</td><td>" + (e.time || "—") + "m</td></tr>";
    });
  }

  /* =========================================================================
     PRACTICE LAB PAGE
     ========================================================================= */
  function renderPracticePage() {
    const practiceEntries = filterEntries({ categories: ["Timed Practice", "Untimed Practice", "Mini-Mock"] });
    const accCanvas = document.getElementById("chartAccuracyTrend");
    const compCanvas = document.getElementById("chartCompletionTrend");
    const timeCanvas = document.getElementById("chartTimingTrend");
    const mistakeCanvas = document.getElementById("chartMistakes");

    if (!practiceEntries.length) {
      [accCanvas, compCanvas, timeCanvas, mistakeCanvas].forEach((c) => emptyState(c));
      return;
    }

    const timeline = buildAttemptTimeline(practiceEntries);
    const labels = timelineLabels(timeline);

    makeChart(accCanvas, {
      type: "line",
      data: {
        labels,
        datasets: SECTIONS.map((sec) => ({
          label: sec,
          data: seriesAlignedToTimeline(practiceEntries.filter((e) => e.section === sec), timeline, (e) => e.accuracy),
          borderColor: SECTION_COLORS[sec], backgroundColor: SECTION_COLORS[sec], tension: 0.25, spanGaps: true,
        })),
      },
      options: { scales: { x: dateAxisOptions(), y: { min: 0, max: 100, title: { display: true, text: "Raw mark %" } } }, plugins: { legend: { position: "bottom" } } },
    });

    makeChart(compCanvas, {
      type: "line",
      data: {
        labels,
        datasets: SECTIONS.map((sec) => ({
          label: sec,
          data: seriesAlignedToTimeline(practiceEntries.filter((e) => e.section === sec && e.completion !== null), timeline, (e) => e.completion),
          borderColor: SECTION_COLORS[sec], backgroundColor: SECTION_COLORS[sec], tension: 0.25, spanGaps: true,
        })),
      },
      options: { scales: { x: dateAxisOptions(), y: { min: 0, max: 100, title: { display: true, text: "Completion %" } } }, plugins: { legend: { position: "bottom" } } },
    });

    makeChart(timeCanvas, {
      type: "line",
      data: {
        labels,
        datasets: SECTIONS.map((sec) => ({
          label: sec,
          data: seriesAlignedToTimeline(practiceEntries.filter((e) => e.section === sec && e.time && e.qCount), timeline, (e) => Math.round((e.time * 60) / e.qCount)),
          borderColor: SECTION_COLORS[sec], backgroundColor: SECTION_COLORS[sec], tension: 0.25, spanGaps: true,
        })),
      },
      options: { scales: { x: dateAxisOptions(), y: { title: { display: true, text: "Seconds / question" } } }, plugins: { legend: { position: "bottom" } } },
    });

    const mistakeCounts = {};
    practiceEntries.forEach((e) => (e.mistakes || []).forEach((m) => { mistakeCounts[m] = (mistakeCounts[m] || 0) + 1; }));
    const mistakeLabels = Object.keys(mistakeCounts);
    if (mistakeLabels.length) {
      makeChart(mistakeCanvas, {
        type: "bar",
        data: { labels: mistakeLabels, datasets: [{ label: "Times logged", data: mistakeLabels.map((l) => mistakeCounts[l]), backgroundColor: "#604D53" }] },
        options: { indexAxis: "y", plugins: { legend: { display: false } } },
      });
    } else {
      emptyState(mistakeCanvas);
    }
  }

  /* =========================================================================
     TARGETS & PREDICTION PAGE
     ========================================================================= */
  function renderScoreRefTable(section) {
    const wrap = document.getElementById("scoreRefDetails");
    const table = document.getElementById("scoreRefTable");
    const label = document.getElementById("scoreRefSectionLabel");
    if (!wrap) return;
    const data = SCORE_CONVERSION_TABLES[section];
    wrap.classList.toggle("hidden", !data);
    if (!data) return;
    label.textContent = "(" + SECTION_NAMES[section] + ")";
    table.innerHTML =
      "<tr><th>" + data.unitLabel + "</th><th>Estimated scaled score</th>" + (section !== "DM" ? "<th>Level</th>" : "") + "</tr>" +
      data.rows.map((r) => "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td>" + (section !== "DM" ? "<td>" + r[2] + "</td>" : "") + "</tr>").join("");
  }

  function renderBandRefTable(el) {
    if (!el) return;
    el.innerHTML =
      "<tr><th>Band</th><th>Raw marks (/69)</th><th>What it represents</th></tr>" +
      [1, 2, 3, 4].map((b) =>
        "<tr><td><span class='band-pill b" + b + "'>Band " + b + "</span></td><td>" + SJT_BAND_INFO[b].rangeLabel + "</td>" +
        "<td><strong>" + SJT_BAND_INFO[b].label + ":</strong> " + SJT_BAND_INFO[b].desc + "</td></tr>"
      ).join("");
  }

  function renderTargetsPage() {
    COGNITIVE_SECTIONS.forEach((s) => { document.getElementById("t_" + s).value = DB.targets[s] || ""; });
    document.getElementById("t_SJT").value = DB.targets.SJT || 2;

    const bars = document.getElementById("progressBars");
    bars.innerHTML = "";
    COGNITIVE_SECTIONS.forEach((sec) => {
      const latest = latestEntryFor(sec);
      const target = DB.targets[sec] || 700;
      const current = latest ? latest.scaled : 300;
      const pct = clamp(((current - 300) / (target - 300)) * 100, 0, 100);
      const gap = target - current;
      bars.innerHTML +=
        '<div class="progress-item"><div class="top-row"><span>' + SECTION_NAMES[sec] + '</span><span>' + current + " / " + target + " (" + (gap > 0 ? "gap " + gap : "target reached") + ')</span></div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + pct + "%; background:" + SECTION_COLORS[sec] + ';"></div></div></div>';
    });

    // SJT progress — band scale, lower is better, so map Band1=100%, Band4=25%
    const sjtLatest = latestEntryFor("SJT");
    const targetBand = DB.targets.SJT || 2;
    const currentBand = sjtLatest ? sjtLatest.band : null;
    const pctOf = (b) => b ? ((4 - b + 1) / 4) * 100 : 0;
    const reached = currentBand && currentBand <= targetBand;
    bars.innerHTML +=
      '<div class="progress-item"><div class="top-row"><span>' + SECTION_NAMES.SJT + '</span><span>' +
      (currentBand ? "Band " + currentBand : "No data") + " (target Band " + targetBand + ") — " + (currentBand ? (reached ? "target reached" : "Band " + (currentBand - targetBand) + " to go") : "log an attempt") +
      '</span></div><div class="progress-track"><div class="progress-fill" style="width:' + pctOf(currentBand) + "%; background:" + SECTION_COLORS.SJT + ';"></div></div></div>';

    const predBlock = document.getElementById("predictionBlock");
    predBlock.innerHTML = "";
    const weights = [5, 4, 3, 2, 1];
    let predTotal = 0, predCount = 0;
    COGNITIVE_SECTIONS.forEach((sec) => {
      const arr = filterEntries({ section: sec, categories: FULLMOCK_LIKE }).slice(-5).reverse();
      let predicted = null;
      if (arr.length) {
        let wsum = 0, wtotal = 0;
        arr.forEach((e, i) => { const w = weights[i] || 1; wsum += e.scaled * w; wtotal += w; });
        predicted = round10(wsum / wtotal);
        predTotal += predicted; predCount++;
      }
      predBlock.innerHTML += '<div class="pred-item"><div class="v" style="color:' + SECTION_COLORS[sec] + '">' + (predicted || "—") + '</div><div class="k">' + sec + " predicted</div></div>";
    });
    predBlock.innerHTML += '<div class="pred-item"><div class="v">' + (predCount ? fmt0(predTotal / predCount) : "—") + '</div><div class="k">Predicted average (scaled)</div></div>';
    predBlock.innerHTML += '<div class="pred-item"><div class="v">' + (predCount === 3 ? predTotal : "—") + '</div><div class="k">Predicted cognitive total /2700</div></div>';

    // predicted SJT band — weighted average of recent full-mock bands, rounded
    const sjtArr = filterEntries({ section: "SJT", categories: FULLMOCK_LIKE }).slice(-5).reverse().filter((e) => e.band);
    let predictedBand = null;
    if (sjtArr.length) {
      let wsum = 0, wtotal = 0;
      sjtArr.forEach((e, i) => { const w = weights[i] || 1; wsum += e.band * w; wtotal += w; });
      predictedBand = clamp(Math.round(wsum / wtotal), 1, 4);
    }
    predBlock.innerHTML += '<div class="pred-item"><div class="v" style="color:' + SECTION_COLORS.SJT + '">' + (predictedBand ? sjtBandLabel(predictedBand) : "—") + '</div><div class="k">SJT predicted band</div></div>';

    renderBandRefTable(document.getElementById("bandRefTableTargets"));
  }

  /* =========================================================================
     ALL ENTRIES PAGE
     ========================================================================= */
  function populateFilterOptions() {
    const catSel = document.getElementById("filt_category");
    const catPrev = catSel.value;
    catSel.innerHTML = '<option value="">All</option>' + MOCK_CATEGORIES.map((c) => '<option value="' + c + '">' + c + "</option>").join("");
    catSel.value = catPrev;

    const sources = [...new Set(DB.entries.map((e) => e.source).filter(Boolean))].sort();
    const srcSel = document.getElementById("filt_source");
    const srcPrev = srcSel.value;
    srcSel.innerHTML = '<option value="">All</option>' + sources.map((s) => '<option value="' + esc(s) + '">' + esc(s) + "</option>").join("");
    srcSel.value = srcPrev;
  }

  function currentFilters() {
    return {
      section: document.getElementById("filt_section").value || undefined,
      category: document.getElementById("filt_category").value || undefined,
      source: document.getElementById("filt_source").value || undefined,
      from: document.getElementById("filt_from").value || undefined,
      to: document.getElementById("filt_to").value || undefined,
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderEntriesPage() {
    populateFilterOptions();
    const filters = currentFilters();
    const entries = [...filterEntries(filters)].reverse();
    const body = document.getElementById("entriesBody");
    body.innerHTML = "";
    if (!entries.length) {
      body.innerHTML = '<tr><td colspan="12" style="text-align:center; color:#A6898E; padding:20px;">No entries match these filters.</td></tr>';
      return;
    }
    entries.forEach((e) => {
      body.innerHTML +=
        "<tr>" +
        "<td>" + fmtDate(e.date) + "</td>" +
        "<td>" + esc(e.testName) + "</td>" +
        "<td>" + e.category + "</td>" +
        "<td>" + esc(e.source || "—") + "</td>" +
        "<td><span class='tag tag-" + e.section.toLowerCase() + "'>" + e.section + "</span></td>" +
        "<td>" + (e.raw !== null && e.raw !== undefined ? e.raw : "—") + "</td>" +
        "<td>" + (e.maxRaw !== null && e.maxRaw !== undefined ? e.maxRaw : "—") + "</td>" +
        "<td><strong>" + resultShort(e) + "</strong></td>" +
        "<td>" + (e.accuracy !== null && e.accuracy !== undefined ? fmt0(e.accuracy) + "%" : "—") + "</td>" +
        "<td>" + (e.time || "—") + "m</td>" +
        "<td>" + esc((e.notes || "").slice(0, 40)) + "</td>" +
        "<td class='entry-actions'><button class='edit-btn' data-edit='" + e.id + "'>Edit</button><button class='del-btn' data-del='" + e.id + "'>Delete</button></td>" +
        "</tr>";
    });
    body.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => startEditEntry(btn.dataset.edit));
    });
    body.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!confirm("Delete this entry? This cannot be undone.")) return;
        if (editingEntryId === btn.dataset.del) exitEditMode();
        DB.entries = DB.entries.filter((x) => x.id !== btn.dataset.del);
        save();
        renderEntriesPage();
      });
    });
  }

  /* =========================================================================
     DATA / BACKUP PAGE
     ========================================================================= */
  function renderDataPage() {
    const bytes = new Blob([JSON.stringify(DB)]).size;
    document.getElementById("storageStatus").textContent =
      DB.entries.length + " entries stored · approx " + (bytes / 1024).toFixed(1) + " KB used in this browser's local storage.";
  }

  /* =========================================================================
     LOG FORM
     ========================================================================= */
  let scaledManuallyEdited = false;
  let maxManuallyEdited = false;
  let qManuallyEdited = false;
  let timeManuallyEdited = false;
  let multiManuallyToggled = false;
  let lastAutoTestName = "";
  let editingEntryId = null;

  function buildMultiTable() {
    const tbody = document.querySelector("#multiTable tbody");
    tbody.innerHTML = "";
    SECTIONS.forEach((sec) => {
      const info = STANDARD_SECTION_INFO[sec];
      const row = document.createElement("tr");
      row.dataset.section = sec;
      row.dataset.resultEdited = "false";
      const resultCell = sec === "SJT"
        ? "<select class='m_band'><option value=''>auto</option><option value='1'>Band 1</option><option value='2'>Band 2</option><option value='3'>Band 3</option><option value='4'>Band 4</option></select>"
        : "<input type='number' class='m_scaled' min='300' max='900' step='10' placeholder='auto'>";
      row.innerHTML =
        "<td><span class='tag tag-" + sec.toLowerCase() + "'>" + sec + "</span></td>" +
        "<td><input type='number' class='m_raw' min='0' step='any' placeholder='raw'></td>" +
        "<td><input type='number' class='m_max' min='1' step='any' value='" + info.maxRaw + "'></td>" +
        "<td><input type='number' class='m_time' min='0' value='" + info.time + "'></td>" +
        "<td><input type='number' class='m_attempted' min='0' placeholder='all'></td>" +
        "<td>" + resultCell + "</td>";
      tbody.appendChild(row);
      row.querySelector(".m_raw").addEventListener("input", () => updateMultiRowScaled(row, sec));
      row.querySelector(".m_max").addEventListener("input", () => updateMultiRowScaled(row, sec));
      row.querySelector(sec === "SJT" ? ".m_band" : ".m_scaled").addEventListener("input", () => { row.dataset.resultEdited = "true"; });
      row.querySelector(sec === "SJT" ? ".m_band" : ".m_scaled").addEventListener("change", () => { row.dataset.resultEdited = "true"; });
    });
  }
  // Auto-fills the editable Result cell from the conversion algorithm — but only
  // while the person hasn't typed/selected their own override for that row.
  function updateMultiRowScaled(row, sec) {
    if (row.dataset.resultEdited === "true") return;
    const raw = parseFloat(row.querySelector(".m_raw").value);
    const max = parseFloat(row.querySelector(".m_max").value);
    if (sec === "SJT") {
      const band = computeSjtBand(raw, max);
      row.querySelector(".m_band").value = band || "";
    } else {
      const s = suggestScaled(raw, max, sec);
      row.querySelector(".m_scaled").value = s || "";
    }
  }

  // Suggests "Category N" as a test name unless the person has typed their own.
  function suggestTestName(category) {
    const count = FULLMOCK_LIKE.includes(category)
      ? getSittings().filter((s) => s.category === category).length
      : DB.entries.filter((e) => e.category === category).length;
    return category + " " + (count + 1);
  }
  function applyTestNameSuggestion() {
    const field = document.getElementById("f_testName");
    const category = document.getElementById("f_category").value;
    if (field.value === "" || field.value === lastAutoTestName) {
      lastAutoTestName = suggestTestName(category);
      field.value = lastAutoTestName;
    }
  }

  // Mock type drives whether "log all four sections" is auto-checked, whether a
  // standard section time/raw count is assumed, and shows a short contextual note —
  // this is what makes the form adapt to full mocks vs mini-mocks vs practice sets.
  function applyCategoryDefaults() {
    const category = document.getElementById("f_category").value;
    const profile = MOCK_PROFILES[category] || {};
    if (!multiManuallyToggled) {
      document.getElementById("f_multiSection").checked = !!profile.forceMulti;
      toggleMultiSection();
    }
    document.getElementById("categoryInfo").textContent = profile.note || "";
    applyTestNameSuggestion();
    applyTimeDefault();
    applySectionDefaults();
    DB.settings.lastCategory = category;
  }

  function applyTimeDefault() {
    if (timeManuallyEdited) return;
    const category = document.getElementById("f_category").value;
    const section = document.getElementById("f_section").value;
    document.getElementById("f_time").value = TIMED_LIKE.includes(category) ? STANDARD_SECTION_INFO[section].time : "";
  }

  // Section dropdown drives the standard raw-mark structure (unless the mock type
  // calls for custom counts, e.g. mini-mocks), and toggles SJT-specific UI.
  function applySectionDefaults() {
    const section = document.getElementById("f_section").value;
    const category = document.getElementById("f_category").value;
    const profile = MOCK_PROFILES[category] || {};
    const info = STANDARD_SECTION_INFO[section];
    maxManuallyEdited = false;
    qManuallyEdited = false;
    scaledManuallyEdited = false;
    if (profile.customCounts) {
      document.getElementById("f_maxRaw").value = "";
      document.getElementById("f_maxRaw").placeholder = "e.g. " + info.maxRaw + " (varies by platform)";
    } else {
      document.getElementById("f_maxRaw").value = info.maxRaw;
    }
    syncQuestionsInSet();
    applyTimeDefault();
    toggleSectionUI(section);
    updateScaledSuggestion();
    updateAccuracyPreview();
    updateBandPreview();
  }

  function syncQuestionsInSet() {
    if (qManuallyEdited) return;
    document.getElementById("f_qCount").value = document.getElementById("f_maxRaw").value;
    document.getElementById("f_attempted").placeholder = "defaults to " + (document.getElementById("f_qCount").value || "max");
  }

  function resetLogForm() {
    document.getElementById("logForm").reset();
    document.getElementById("f_date").value = new Date().toISOString().slice(0, 10);
    document.getElementById("f_source").value = DB.settings.lastSource || "";
    document.getElementById("f_category").value = DB.settings.lastCategory || "Full Mock";
    document.getElementById("f_sjtBandOnly").checked = false;
    scaledManuallyEdited = false;
    maxManuallyEdited = false;
    qManuallyEdited = false;
    timeManuallyEdited = false;
    multiManuallyToggled = false;
    lastAutoTestName = "";
    document.querySelectorAll("#mistakeChips input").forEach((c) => (c.checked = false));
    buildMultiTable();
    applyTestNameSuggestion();
    applyCategoryDefaults();
    document.getElementById("advancedFields").open = false;
    document.getElementById("completionDetails").open = false;
    document.getElementById("bandRefDetails").open = false;
    document.getElementById("scoreRefDetails").open = false;
  }

  function toggleMultiSection() {
    const multi = document.getElementById("f_multiSection").checked;
    document.getElementById("singleSectionBlock").classList.toggle("hidden", multi);
    document.getElementById("multiSectionBlock").classList.toggle("hidden", !multi);
  }

  function toggleSectionUI(section) {
    const isSjt = section === "SJT";
    document.getElementById("scaledWrap").classList.toggle("hidden", isSjt);
    document.getElementById("sjtBandOnlyRow").classList.toggle("hidden", !isSjt);
    document.getElementById("bandRefDetails").classList.toggle("hidden", !isSjt);
    renderScoreRefTable(section);
    if (!isSjt) document.getElementById("f_sjtBandOnly").checked = false;
    toggleSjtBandOnly();
  }

  function toggleSjtBandOnly() {
    const section = document.getElementById("f_section").value;
    const isSjt = section === "SJT";
    const bandOnly = document.getElementById("f_sjtBandOnly").checked;
    document.getElementById("sjtManualBandWrap").classList.toggle("hidden", !(isSjt && bandOnly));
    document.getElementById("f_raw").closest("label").classList.toggle("hidden", isSjt && bandOnly);
    document.getElementById("f_maxRaw").closest("label").classList.toggle("hidden", isSjt && bandOnly);
    document.getElementById("f_time").closest("label").classList.toggle("hidden", isSjt && bandOnly);
    document.getElementById("sjtBandWrap").classList.toggle("hidden", !(isSjt && !bandOnly));
    updateBandPreview();
  }

  function updateScaledSuggestion() {
    if (scaledManuallyEdited) return;
    const section = document.getElementById("f_section").value;
    if (section === "SJT") { document.getElementById("f_scaled").value = ""; return; }
    const raw = parseFloat(document.getElementById("f_raw").value);
    const max = parseFloat(document.getElementById("f_maxRaw").value);
    const s = suggestScaled(raw, max, section);
    document.getElementById("f_scaled").value = s || "";
  }

  function updateAccuracyPreview() {
    const raw = parseFloat(document.getElementById("f_raw").value);
    const max = parseFloat(document.getElementById("f_maxRaw").value);
    const out = document.getElementById("f_accuracyPreview");
    out.textContent = !isNaN(raw) && max ? fmt0(clamp((raw / max) * 100, 0, 100)) + "%" : "—";
  }

  function updateBandPreview() {
    const section = document.getElementById("f_section").value;
    const out = document.getElementById("f_bandPreview");
    if (!out || section !== "SJT") return;
    const raw = parseFloat(document.getElementById("f_raw").value);
    const max = parseFloat(document.getElementById("f_maxRaw").value) || STANDARD_SECTION_INFO.SJT.maxRaw;
    const band = computeSjtBand(raw, max);
    out.innerHTML = band ? '<span class="band-pill b' + band + '">Band ' + band + "</span> " + SJT_BAND_INFO[band].label : "—";
  }

  // Builds the data for a single (non-multi) section entry from the current form
  // fields. Returns null (and shows an alert) if the form isn't validly filled in.
  // Shared by both "create new entry" and "update existing entry" flows so the
  // two stay in sync.
  function buildSingleSectionEntryData() {
    const section = document.getElementById("f_section").value;
    const time = parseFloat(document.getElementById("f_time").value) || null;
    const qCountRaw = document.getElementById("f_qCount").value;
    const attemptedRaw = document.getElementById("f_attempted").value;

    if (section === "SJT") {
      const bandOnly = document.getElementById("f_sjtBandOnly").checked;
      if (bandOnly) {
        const band = parseInt(document.getElementById("f_bandManual").value, 10);
        return {
          section, raw: null, maxRaw: null, qCount: null, attempted: null, time, scaled: null,
          accuracy: null, completion: null, band,
        };
      }
      const raw = parseFloat(document.getElementById("f_raw").value);
      const maxRaw = parseFloat(document.getElementById("f_maxRaw").value) || STANDARD_SECTION_INFO.SJT.maxRaw;
      if (isNaN(raw) || !maxRaw) {
        alert('Please enter a raw SJT score, or tick "I only have a Band".');
        return null;
      }
      const qCount = parseFloat(qCountRaw) || maxRaw;
      const attempted = attemptedRaw !== "" ? parseFloat(attemptedRaw) : qCount;
      const band = computeSjtBand(raw, maxRaw);
      return {
        section, raw, maxRaw, qCount, attempted, time, scaled: null,
        accuracy: (raw / maxRaw) * 100, completion: qCount ? (attempted / qCount) * 100 : null, band,
      };
    }

    const raw = parseFloat(document.getElementById("f_raw").value);
    const maxRaw = parseFloat(document.getElementById("f_maxRaw").value);
    const qCount = parseFloat(qCountRaw) || maxRaw;
    const attempted = attemptedRaw !== "" ? parseFloat(attemptedRaw) : qCount;
    let scaled = parseFloat(document.getElementById("f_scaled").value);
    if (isNaN(scaled)) scaled = suggestScaled(raw, maxRaw, section);
    if (isNaN(raw) || isNaN(maxRaw) || maxRaw <= 0 || !scaled) {
      alert("Please enter at least raw score, max raw mark, so a scaled score can be calculated (or enter scaled score directly).");
      return null;
    }
    return {
      section, raw, maxRaw, qCount, attempted, time, scaled,
      accuracy: (raw / maxRaw) * 100, completion: qCount ? (attempted / qCount) * 100 : null, band: null,
    };
  }

  function handleLogSubmit(ev) {
    ev.preventDefault();
    const date = document.getElementById("f_date").value;
    const testName = document.getElementById("f_testName").value.trim() || "Untitled";
    const category = document.getElementById("f_category").value;
    const source = document.getElementById("f_source").value.trim();
    const notes = document.getElementById("f_notes").value.trim();
    const mistakes = Array.from(document.querySelectorAll("#mistakeChips input:checked")).map((c) => c.value);

    if (!date) { alert("Please pick a date."); return; }

    // ---- EDITING AN EXISTING ENTRY: always single-section, update in place ----
    if (editingEntryId) {
      const existing = DB.entries.find((e) => e.id === editingEntryId);
      if (!existing) { exitEditMode(); return; }
      const data = buildSingleSectionEntryData();
      if (!data) return;
      Object.assign(existing, { date, testName, category, source, notes, mistakes }, data);
      existing.updatedAt = Date.now();

      if (source) DB.settings.lastSource = source;
      DB.settings.lastCategory = category;
      save();
      const finishedEditId = editingEntryId;
      exitEditMode();
      showPage("entries");
      document.getElementById("entriesMsg").textContent = "Entry updated ✓";
      setTimeout(() => (document.getElementById("entriesMsg").textContent = ""), 3000);
      return;
    }

    // ---- CREATING NEW ENTRY/ENTRIES ----
    const sittingId = uid();
    const createdAt = Date.now();
    const isMulti = document.getElementById("f_multiSection").checked;
    let created = 0;

    if (isMulti) {
      document.querySelectorAll("#multiTable tbody tr").forEach((row) => {
        const sec = row.dataset.section;
        const raw = parseFloat(row.querySelector(".m_raw").value);
        const max = parseFloat(row.querySelector(".m_max").value);
        if (isNaN(raw) || isNaN(max) || max <= 0) return; // skip blank rows
        const time = parseFloat(row.querySelector(".m_time").value) || null;
        const attemptedVal = row.querySelector(".m_attempted").value;
        const attempted = attemptedVal !== "" ? parseFloat(attemptedVal) : max;
        const completion = max ? (attempted / max) * 100 : null;
        const accuracy = (raw / max) * 100;
        if (sec === "SJT") {
          const manualBand = parseInt(row.querySelector(".m_band").value, 10);
          const band = !isNaN(manualBand) ? manualBand : computeSjtBand(raw, max);
          DB.entries.push({
            id: uid(), sittingId, date, testName, category, source, section: sec,
            raw, maxRaw: max, qCount: max, attempted, time, scaled: null,
            accuracy, completion, band, mistakes, notes, createdAt,
          });
        } else {
          const manualScaled = parseFloat(row.querySelector(".m_scaled").value);
          const scaled = !isNaN(manualScaled) ? clamp(manualScaled, 300, 900) : suggestScaled(raw, max, sec);
          DB.entries.push({
            id: uid(), sittingId, date, testName, category, source, section: sec,
            raw, maxRaw: max, qCount: max, attempted, time, scaled,
            accuracy, completion, band: null, mistakes, notes, createdAt,
          });
        }
        created++;
      });
    } else {
      const data = buildSingleSectionEntryData();
      if (data) {
        DB.entries.push(Object.assign({ id: uid(), sittingId: uid(), date, testName, category, source, mistakes, notes, createdAt }, data));
        created++;
      } else {
        return;
      }
    }

    if (!created) { alert("No valid section scores were entered."); return; }

    if (source) DB.settings.lastSource = source;
    DB.settings.lastCategory = category;
    save();
    document.getElementById("saveMsg").textContent = "Saved " + created + " entr" + (created === 1 ? "y" : "ies") + " ✓";
    setTimeout(() => (document.getElementById("saveMsg").textContent = ""), 3000);
    resetLogForm();
    refreshAllAfterDataChange();
  }

  // "Edit" on an entries-table row — loads that entry back into the (forced
  // single-section) log form so it can be corrected, then updates it in place
  // on save instead of creating a new entry.
  function startEditEntry(id) {
    const entry = DB.entries.find((e) => e.id === id);
    if (!entry) return;

    showPage("log");
    editingEntryId = id;

    // Editing is always single-section — force that mode and hide the toggle
    // so it can't be flipped mid-edit.
    multiManuallyToggled = true;
    document.getElementById("f_multiSection").checked = false;
    toggleMultiSection();
    document.getElementById("multiSectionToggleRow").classList.add("hidden");

    document.getElementById("f_date").value = entry.date;
    document.getElementById("f_testName").value = entry.testName;
    document.getElementById("f_category").value = entry.category;
    document.getElementById("f_source").value = entry.source || "";
    lastAutoTestName = entry.testName;
    document.getElementById("categoryInfo").textContent = (MOCK_PROFILES[entry.category] || {}).note || "";

    document.getElementById("f_section").value = entry.section;
    timeManuallyEdited = true; // about to set time explicitly; don't let defaults clobber it
    applySectionDefaults();

    if (entry.section === "SJT" && entry.raw === null) {
      document.getElementById("f_sjtBandOnly").checked = true;
      toggleSjtBandOnly();
      document.getElementById("f_bandManual").value = entry.band || 1;
    } else {
      document.getElementById("f_sjtBandOnly").checked = false;
      toggleSjtBandOnly();
      document.getElementById("f_raw").value = entry.raw;
      document.getElementById("f_maxRaw").value = entry.maxRaw;
      document.getElementById("f_qCount").value = entry.qCount || entry.maxRaw;
      document.getElementById("f_attempted").value = entry.attempted !== null && entry.attempted !== undefined ? entry.attempted : "";
      maxManuallyEdited = true;
      qManuallyEdited = true;
      if (entry.section !== "SJT") {
        document.getElementById("f_scaled").value = entry.scaled;
        scaledManuallyEdited = true;
      }
    }
    document.getElementById("f_time").value = entry.time !== null && entry.time !== undefined ? entry.time : "";
    updateAccuracyPreview();
    updateBandPreview();

    document.querySelectorAll("#mistakeChips input").forEach((c) => { c.checked = (entry.mistakes || []).includes(c.value); });
    document.getElementById("f_notes").value = entry.notes || "";
    if ((entry.mistakes && entry.mistakes.length) || entry.notes) document.getElementById("advancedFields").open = true;

    document.getElementById("editingBanner").textContent =
      "Editing the " + fmtDate(entry.date) + " " + SECTION_NAMES[entry.section] + " entry — saving will update it instead of creating a new one.";
    document.querySelector('#logForm button[type="submit"]').textContent = "Update attempt";
    document.getElementById("cancelEditBtn").classList.remove("hidden");
    document.getElementById("f_testName").focus();
  }

  function exitEditMode() {
    editingEntryId = null;
    document.getElementById("multiSectionToggleRow").classList.remove("hidden");
    document.getElementById("editingBanner").textContent = "";
    document.querySelector('#logForm button[type="submit"]').textContent = "Save attempt";
    document.getElementById("cancelEditBtn").classList.add("hidden");
    resetLogForm();
  }

  // "Repeat last setup" — copies the most recent entry's category/source/section so
  // the next attempt of the same kind is a couple of clicks away from saved.
  function repeatLastSetup() {
    const entries = allEntriesSorted();
    if (!entries.length) return;
    const last = entries[entries.length - 1];
    document.getElementById("f_category").value = last.category;
    document.getElementById("f_source").value = last.source || "";
    multiManuallyToggled = false;
    applyCategoryDefaults();
    if (!document.getElementById("f_multiSection").checked) {
      document.getElementById("f_section").value = last.section;
      applySectionDefaults();
    }
    document.getElementById("f_testName").focus();
  }

  /* =========================================================================
     EXPORT / IMPORT / RESET
     ========================================================================= */
  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportJSON() {
    downloadFile("ucat-tracker-backup-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(DB, null, 2), "application/json");
  }

  function exportCSV() {
    const headers = ["date", "testName", "category", "source", "section", "raw", "maxRaw", "qCount", "attempted", "time", "scaled", "accuracy", "completion", "band", "mistakes", "notes"];
    const rows = allEntriesSorted().map((e) => headers.map((h) => {
      let v = e[h];
      if (Array.isArray(v)) v = v.join("|");
      if (v === null || v === undefined) v = "";
      v = String(v).replace(/"/g, '""');
      return '"' + v + '"';
    }).join(","));
    downloadFile("ucat-tracker-entries-" + new Date().toISOString().slice(0, 10) + ".csv", headers.join(",") + "\n" + rows.join("\n"), "text/csv");
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.entries || !Array.isArray(parsed.entries)) throw new Error("Invalid file format");
        if (!confirm("Import will replace all current data in this browser. Continue?")) return;
        DB = normalizeDB(parsed);
        save();
        document.getElementById("dataMsg").textContent = "Import successful ✓";
        refreshAllAfterDataChange();
      } catch (e) {
        document.getElementById("dataMsg").textContent = "Import failed: " + e.message;
      }
    };
    reader.readAsText(file);
  }

  function resetAll() {
    if (!confirm("This will permanently erase all logged attempts and targets from this browser. Export a backup first if unsure. Continue?")) return;
    DB = defaultData();
    save();
    refreshAllAfterDataChange();
    document.getElementById("dataMsg").textContent = "All data erased.";
  }

  /* =========================================================================
     GLOBAL REFRESH
     ========================================================================= */
  function refreshAllAfterDataChange() {
    const activeBtn = document.querySelector(".nav-link.active");
    const key = activeBtn ? activeBtn.dataset.page : "dashboard";
    renderPage(key || "dashboard");
  }

  /* =========================================================================
     INIT
     ========================================================================= */
  function init() {
    initStaticPages();
    initSectionPages();

    document.querySelectorAll(".nav-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (editingEntryId && btn.dataset.page !== "log") exitEditMode();
        showPage(btn.dataset.page);
      });
    });
    document.getElementById("quickAddBtn").addEventListener("click", () => { exitEditMode(); showPage("log"); });
    document.getElementById("repeatLastBtn").addEventListener("click", () => { exitEditMode(); showPage("log"); repeatLastSetup(); });
    document.getElementById("cancelEditBtn").addEventListener("click", exitEditMode);

    renderBandRefTable(document.getElementById("bandRefTable"));

    // log form wiring — every field starts pre-filled with a sensible default;
    // manual edits are tracked so defaults never silently overwrite what the person typed.
    document.getElementById("f_source").value = DB.settings.lastSource || "";
    buildMultiTable();
    document.getElementById("f_multiSection").addEventListener("change", () => {
      multiManuallyToggled = true;
      toggleMultiSection();
    });
    document.getElementById("f_category").addEventListener("change", applyCategoryDefaults);
    document.getElementById("f_section").addEventListener("change", applySectionDefaults);
    document.getElementById("f_raw").addEventListener("input", () => { updateScaledSuggestion(); updateAccuracyPreview(); updateBandPreview(); });
    document.getElementById("f_maxRaw").addEventListener("input", () => {
      maxManuallyEdited = true;
      syncQuestionsInSet();
      updateScaledSuggestion();
      updateAccuracyPreview();
      updateBandPreview();
    });
    document.getElementById("f_qCount").addEventListener("input", () => { qManuallyEdited = true; });
    document.getElementById("f_time").addEventListener("input", () => { timeManuallyEdited = true; });
    document.getElementById("f_scaled").addEventListener("input", () => (scaledManuallyEdited = true));
    document.getElementById("f_sjtBandOnly").addEventListener("change", toggleSjtBandOnly);
    document.getElementById("logForm").addEventListener("submit", handleLogSubmit);
    resetLogForm();

    // filters
    ["filt_section", "filt_category", "filt_source", "filt_from", "filt_to"].forEach((id) => {
      document.getElementById(id).addEventListener("change", renderEntriesPage);
    });
    document.getElementById("filt_clear").addEventListener("click", () => {
      ["filt_section", "filt_category", "filt_source", "filt_from", "filt_to"].forEach((id) => (document.getElementById(id).value = ""));
      renderEntriesPage();
    });

    // targets
    document.getElementById("saveTargets").addEventListener("click", () => {
      COGNITIVE_SECTIONS.forEach((s) => {
        const v = parseFloat(document.getElementById("t_" + s).value);
        if (!isNaN(v)) DB.targets[s] = clamp(round10(v), 300, 900);
      });
      const sjtTarget = parseInt(document.getElementById("t_SJT").value, 10);
      if (!isNaN(sjtTarget)) DB.targets.SJT = clamp(sjtTarget, 1, 4);
      save();
      document.getElementById("targetMsg").textContent = "Targets saved ✓";
      setTimeout(() => (document.getElementById("targetMsg").textContent = ""), 2500);
      renderTargetsPage();
    });

    // data page
    document.getElementById("exportBtn").addEventListener("click", exportJSON);
    document.getElementById("exportCsvBtn").addEventListener("click", exportCSV);
    document.getElementById("importInput").addEventListener("change", (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); });
    document.getElementById("resetBtn").addEventListener("click", resetAll);

    showPage("dashboard");
  }

  document.addEventListener("DOMContentLoaded", init);
})();