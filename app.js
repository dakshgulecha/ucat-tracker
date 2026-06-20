/* =========================================================================
   UCAT SCORE TRACKER — app.js
   All data lives in localStorage. Nothing is sent anywhere.
   ========================================================================= */

(function () {
  "use strict";

  /* ----------------------------- CONSTANTS ----------------------------- */
  const STORAGE_KEY = "ucatTrackerData_v1";
  const SECTIONS = ["QR", "DM", "VR", "SJT"];
  const SECTION_NAMES = {
    QR: "Quantitative Reasoning",
    DM: "Decision Making",
    VR: "Verbal Reasoning",
    SJT: "Situational Judgement",
  };
  const SECTION_COLORS = {
    QR: "#2563EB",
    DM: "#7C3AED",
    VR: "#0D9488",
    SJT: "#D97706",
  };
  const SECTION_SOFT = {
    QR: "#DCE6FD",
    DM: "#EAE0FC",
    VR: "#D6F1EC",
    SJT: "#FBE7C9",
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

  /* ------------------------------ STORAGE ------------------------------ */
  function defaultData() {
    return {
      entries: [],
      targets: { QR: 700, DM: 700, VR: 700, SJT: 700 },
      settings: { lastSource: "" },
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultData();
      const parsed = JSON.parse(raw);
      if (!parsed.entries) parsed.entries = [];
      if (!parsed.targets) parsed.targets = defaultData().targets;
      if (!parsed.settings) parsed.settings = defaultData().settings;
      return parsed;
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
  function suggestScaled(raw, maxRaw) {
    if (raw === null || raw === undefined || raw === "" || !maxRaw) return null;
    const pct = clamp(raw / maxRaw, 0, 1);
    return clamp(round10(300 + pct * 600), 300, 900);
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

  // Group entries sharing a sittingId into a single "mock sitting" row
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
        };
      }
      map[key].sections[e.section] = e.scaled;
    });
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
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
    const arr = bySection(section).map((e) => e.scaled);
    return mean(arr);
  }

  /* ------------------------------ CHART REGISTRY ------------------------- */
  const charts = {};
  function makeChart(canvas, config) {
    if (!canvas) return null;
    const id = canvas.id;
    if (charts[id]) { charts[id].destroy(); }
    charts[id] = new Chart(canvas.getContext("2d"), config);
    return charts[id];
  }

  const baseFont = { family: "Inter, sans-serif", size: 11 };
  Chart.defaults.font = baseFont;
  Chart.defaults.color = "#4B5563";
  Chart.defaults.borderColor = "#E1E3D6";

  function emptyState(canvas) {
    if (!canvas) return;
    if (charts[canvas.id]) { charts[canvas.id].destroy(); delete charts[canvas.id]; }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.font = "13px Inter, sans-serif";
    ctx.fillStyle = "#9AA3B2";
    ctx.textAlign = "center";
    ctx.fillText("No data logged yet", canvas.width / 2, canvas.height / 2);
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
  function dialSVG(value, color) {
    const pct = value ? clamp((value - 300) / 600, 0, 1) : 0;
    const arcLen = 150.8; // approx semicircle length for r=48
    const dash = (pct * arcLen).toFixed(1);
    return (
      '<svg class="dial-arc" viewBox="0 0 108 60">' +
      '<path d="M10,56 A48,48 0 0 1 98,56" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="9" stroke-linecap="round"/>' +
      '<path d="M10,56 A48,48 0 0 1 98,56" fill="none" stroke="' + color + '" stroke-width="9" stroke-linecap="round" ' +
      'stroke-dasharray="' + dash + ' ' + arcLen + '"/>' +
      "</svg>"
    );
  }

  function renderScorecard() {
    const wrap = document.getElementById("scorecard");
    wrap.innerHTML = "";
    let total = 0, anyData = false;
    SECTIONS.forEach((sec) => {
      const latest = latestEntryFor(sec);
      const prev = previousEntryFor(sec);
      const val = latest ? latest.scaled : null;
      if (val) { total += val; anyData = true; }
      let deltaHTML = '<div class="dial-delta delta-flat">No data yet</div>';
      if (latest && prev) {
        const d = latest.scaled - prev.scaled;
        const cls = d > 0 ? "delta-up" : d < 0 ? "delta-down" : "delta-flat";
        const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "■";
        deltaHTML = '<div class="dial-delta ' + cls + '">' + arrow + " " + (d > 0 ? "+" : "") + d + " vs last</div>";
      } else if (latest) {
        deltaHTML = '<div class="dial-delta delta-flat">First attempt logged</div>';
      }
      const bandHTML = sec === "SJT" && latest && latest.band ? '<div class="dial-total">Band ' + latest.band + "</div>" : "";
      wrap.innerHTML +=
        '<div class="dial">' +
        '<div class="dial-label">' + sec + "</div>" +
        dialSVG(val, SECTION_COLORS[sec]) +
        '<div class="dial-value">' + (val || "—") + "</div>" +
        deltaHTML +
        bandHTML +
        "</div>";
    });
    wrap.innerHTML +=
      '<div class="dial">' +
      '<div class="dial-label">Combined</div>' +
      dialSVG(anyData ? total / 4 : null, "#F5C26B") +
      '<div class="dial-value">' + (anyData ? total : "—") + "</div>" +
      '<div class="dial-total">sum of latest sections</div>' +
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
      return;
    }

    const allScaled = entries.map((e) => e.scaled);
    const latest = entries[entries.length - 1];
    const prev = entries.length > 1 ? entries[entries.length - 2] : null;

    const sectionAverages = SECTIONS.map((s) => ({ s, avg: sectionAverage(s) })).filter((x) => x.avg !== null);
    const best = sectionAverages.length ? sectionAverages.reduce((a, b) => (b.avg > a.avg ? b : a)) : null;
    const worst = sectionAverages.length ? sectionAverages.reduce((a, b) => (b.avg < a.avg ? b : a)) : null;

    // current score = avg of last-3-per-section ability, averaged across sections with data
    const currentPerSection = SECTIONS.map((s) => {
      const arr = bySection(s).slice(-3).map((e) => e.scaled);
      return arr.length ? mean(arr) : null;
    }).filter((v) => v !== null);
    const currentScore = currentPerSection.length ? mean(currentPerSection) : null;

    const overallSlope = linregSlope(allScaled);
    const overallTrend = trendLabel(overallSlope);

    const recent5 = allScaled.slice(-5);
    const prior5 = allScaled.slice(-10, -5);
    let recentTrend = { label: "Not enough data", cls: "neutral" };
    if (prior5.length >= 2 && recent5.length >= 2) {
      recentTrend = trendLabel(mean(recent5) - mean(prior5), 5);
    }

    const change = prev ? latest.scaled - prev.scaled : null;

    const kpis = [
      { label: "Current score", value: fmt0(currentScore), sub: "avg of last 3 per section", cls: "neutral" },
      { label: "Latest attempt", value: latest.scaled + " (" + latest.section + ")", sub: fmtDate(latest.date), cls: "neutral" },
      { label: "All-time average", value: fmt0(mean(allScaled)), sub: entries.length + " attempts", cls: "neutral" },
      { label: "Highest score", value: fmt0(Math.max(...allScaled)), sub: "personal best", cls: "good" },
      { label: "Lowest score", value: fmt0(Math.min(...allScaled)), sub: "personal worst", cls: "bad" },
      { label: "Total attempts", value: entries.length, sub: "all sections combined", cls: "neutral" },
      { label: "Best section", value: best ? best.s : "—", sub: best ? fmt0(best.avg) + " avg" : "", cls: "good" },
      { label: "Weakest section", value: worst ? worst.s : "—", sub: worst ? fmt0(worst.avg) + " avg" : "", cls: "bad" },
      { label: "Overall trend", value: overallTrend.label, sub: "across full history", cls: overallTrend.cls },
      { label: "Recent trend", value: recentTrend.label, sub: "last 5 vs prior 5", cls: recentTrend.cls },
      {
        label: "Change vs previous",
        value: change === null ? "—" : (change > 0 ? "+" : "") + change,
        sub: change === null ? "first attempt" : change > 0 ? "improved" : change < 0 ? "declined" : "no change",
        cls: change === null ? "neutral" : change > 0 ? "good" : change < 0 ? "bad" : "neutral",
      },
    ];

    kpis.forEach((k) => {
      grid.innerHTML +=
        '<div class="kpi"><div class="kpi-label">' + k.label + '</div><div class="kpi-value">' + k.value + '</div>' +
        '<span class="kpi-sub ' + k.cls + '">' + k.sub + "</span></div>";
    });

    renderOverallTrendChart(entries);
    renderRadarChart();
    renderStackedChart();
    renderMedifyOfficialChart();
  }

  function renderOverallTrendChart(entries) {
    const canvas = document.getElementById("chartOverallTrend");
    const datasets = SECTIONS.map((sec) => {
      const arr = bySection(sec);
      return {
        label: sec,
        data: arr.map((e) => ({ x: e.date, y: e.scaled })),
        borderColor: SECTION_COLORS[sec],
        backgroundColor: SECTION_COLORS[sec],
        tension: 0.3,
        spanGaps: true,
        pointRadius: 3,
      };
    });
    makeChart(canvas, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        scales: {
          x: { type: "time", time: { unit: "week" }, title: { display: false } },
          y: { min: 300, max: 900, title: { display: true, text: "Scaled score" } },
        },
        plugins: { legend: { position: "bottom" } },
      },
    });
  }

  function renderRadarChart() {
    const canvas = document.getElementById("chartRadar");
    const current = SECTIONS.map((s) => {
      const l = latestEntryFor(s);
      return l ? l.scaled : 300;
    });
    const target = SECTIONS.map((s) => DB.targets[s] || 700);
    makeChart(canvas, {
      type: "radar",
      data: {
        labels: SECTIONS,
        datasets: [
          { label: "Current", data: current, borderColor: "#16243A", backgroundColor: "rgba(22,36,58,0.18)" },
          { label: "Target", data: target, borderColor: "#D97706", backgroundColor: "rgba(217,119,6,0.1)", borderDash: [4, 4] },
        ],
      },
      options: { scales: { r: { min: 300, max: 900, ticks: { stepSize: 150 } } }, plugins: { legend: { position: "bottom" } } },
    });
  }

  function renderStackedChart() {
    const canvas = document.getElementById("chartStacked");
    const sittings = getSittings().slice(-10);
    const labels = sittings.map((s) => fmtDate(s.date) + " · " + s.testName);
    const datasets = SECTIONS.map((sec) => ({
      label: sec,
      data: sittings.map((s) => s.sections[sec] || 0),
      backgroundColor: SECTION_COLORS[sec],
    }));
    makeChart(canvas, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        scales: { x: { stacked: true, ticks: { autoSkip: false, maxRotation: 60, minRotation: 30 } }, y: { stacked: true, title: { display: true, text: "Combined scaled score" } } },
        plugins: { legend: { position: "bottom" } },
      },
    });
  }

  function renderMedifyOfficialChart() {
    const canvas = document.getElementById("chartMedifyOfficial");
    const medify = filterEntries({ categories: ["Medify Mock"] });
    const official = filterEntries({ categories: ["UCAT Official Mock"] });
    const labels = SECTIONS;
    makeChart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Medify avg", data: SECTIONS.map((s) => fmt0(mean(medify.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: "#2563EB" },
          { label: "UCAT Official avg", data: SECTIONS.map((s) => fmt0(mean(official.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: "#D97706" },
        ],
      },
      options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { position: "bottom" } } },
    });
  }

  /* =========================================================================
     SECTION ANALYTICS PAGES
     ========================================================================= */
  function renderSectionPage(sec) {
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

    // improvement rate: % of consecutive transitions that improved
    let improves = 0, transitions = 0, biggestJump = -Infinity, streak = 0, longestStreak = 0;
    for (let i = 1; i < scaledArr.length; i++) {
      transitions++;
      const d = scaledArr[i] - scaledArr[i - 1];
      if (d > 0) { improves++; streak++; longestStreak = Math.max(longestStreak, streak); } else { streak = 0; }
      biggestJump = Math.max(biggestJump, d);
    }
    const improvementRate = transitions ? (improves / transitions) * 100 : null;

    // points lost to weakest-vs-strongest comparison
    const otherAverages = SECTIONS.filter((s) => s !== sec).map((s) => sectionAverage(s)).filter((v) => v !== null);
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

    // trend chart with rolling average
    const roll = rollingAverage(scaledArr, 3);
    makeChart(page.querySelector(".chart-trend"), {
      type: "line",
      data: {
        labels: entries.map((e) => fmtDate(e.date)),
        datasets: [
          { label: "Scaled score", data: scaledArr, borderColor: SECTION_COLORS[sec], backgroundColor: SECTION_COLORS[sec], tension: 0.25, pointRadius: 3 },
          { label: "Rolling avg (3)", data: roll, borderColor: "#9AA3B2", borderDash: [5, 4], pointRadius: 0, tension: 0.25 },
        ],
      },
      options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { position: "bottom" } } },
    });

    // distribution chart (histogram by 50pt buckets)
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

    // recent performance (last 8)
    const recent = entries.slice(-8);
    makeChart(page.querySelector(".chart-recent"), {
      type: "bar",
      data: {
        labels: recent.map((e) => fmtDate(e.date)),
        datasets: [{ label: "Scaled score", data: recent.map((e) => e.scaled), backgroundColor: recent.map((e, i, a) => (i === 0 ? SECTION_COLORS[sec] : a[i - 1].scaled <= e.scaled ? "#16A34A" : "#DC2626")) }],
      },
      options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { display: false } } },
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
      emptyState(document.getElementById("chartTimedUntimed"));
      document.getElementById("sittingsBody").innerHTML = "";
      return;
    }
    const totals = sittings.map((s) => SECTIONS.reduce((sum, sec) => sum + (s.sections[sec] || 0), 0)).filter((t) => t > 0);
    const latest = sittings[sittings.length - 1];
    const latestTotal = SECTIONS.reduce((sum, sec) => sum + (latest.sections[sec] || 0), 0);
    const kpis = [
      { label: "Mocks sat", value: sittings.length, sub: "full sittings logged", cls: "neutral" },
      { label: "Latest total", value: latestTotal, sub: fmtDate(latest.date), cls: "neutral" },
      { label: "Best total", value: Math.max(...totals), sub: "personal best sitting", cls: "good" },
      { label: "Average total", value: fmt0(mean(totals)), sub: "across all sittings", cls: "neutral" },
    ];
    kpis.forEach((k) => {
      kpiGrid.innerHTML += '<div class="kpi"><div class="kpi-label">' + k.label + '</div><div class="kpi-value">' + k.value + '</div><span class="kpi-sub ' + k.cls + '">' + k.sub + "</span></div>";
    });

    makeChart(document.getElementById("chartFmOverall"), {
      type: "line",
      data: {
        labels: sittings.map((s) => fmtDate(s.date) + " · " + s.testName),
        datasets: [{ label: "Total scaled score", data: sittings.map((s) => SECTIONS.reduce((sum, sec) => sum + (s.sections[sec] || 0), 0)), borderColor: "#16243A", backgroundColor: "#16243A", tension: 0.25, pointRadius: 3 }],
      },
      options: { plugins: { legend: { display: false } } },
    });

    const timed = filterEntries({ categories: ["Timed Practice"] });
    const untimed = filterEntries({ categories: ["Untimed Practice"] });
    makeChart(document.getElementById("chartTimedUntimed"), {
      type: "bar",
      data: {
        labels: SECTIONS,
        datasets: [
          { label: "Timed avg", data: SECTIONS.map((s) => fmt0(mean(timed.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: "#2563EB" },
          { label: "Untimed avg", data: SECTIONS.map((s) => fmt0(mean(untimed.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: "#9AA3B2" },
        ],
      },
      options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { position: "bottom" } } },
    });

    const body = document.getElementById("sittingsBody");
    body.innerHTML = "";
    [...sittings].reverse().forEach((s) => {
      const total = SECTIONS.reduce((sum, sec) => sum + (s.sections[sec] || 0), 0);
      body.innerHTML +=
        "<tr><td>" + fmtDate(s.date) + "</td><td>" + esc(s.testName) + "</td><td>" + s.category + "</td><td>" + esc(s.source || "—") + "</td>" +
        SECTIONS.map((sec) => "<td>" + (s.sections[sec] || "—") + "</td>").join("") +
        "<td><strong>" + total + "</strong></td></tr>";
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
    makeChart(trendCanvas, {
      type: "line",
      data: {
        datasets: SECTIONS.map((sec) => ({
          label: sec,
          data: entries.filter((e) => e.section === sec).map((e) => ({ x: e.date, y: e.scaled })),
          borderColor: SECTION_COLORS[sec],
          backgroundColor: SECTION_COLORS[sec],
          tension: 0.25,
          spanGaps: true,
        })),
      },
      options: { scales: { x: { type: "time", time: { unit: "week" } }, y: { min: 300, max: 900 } }, plugins: { legend: { position: "bottom" } } },
    });
    makeChart(avgCanvas, {
      type: "bar",
      data: { labels: SECTIONS, datasets: [{ label: "Mini-mock average", data: SECTIONS.map((s) => fmt0(mean(entries.filter((e) => e.section === s).map((e) => e.scaled))) || 0), backgroundColor: SECTIONS.map((s) => SECTION_COLORS[s]) }] },
      options: { scales: { y: { min: 300, max: 900 } }, plugins: { legend: { display: false } } },
    });
    const body = document.getElementById("miniBody");
    body.innerHTML = "";
    [...entries].reverse().forEach((e) => {
      body.innerHTML += "<tr><td>" + fmtDate(e.date) + "</td><td>" + esc(e.testName) + "</td><td>" + esc(e.source || "—") + "</td><td><span class='tag tag-" + e.section.toLowerCase() + "'>" + e.section + "</span></td><td>" + e.raw + "/" + e.maxRaw + "</td><td>" + e.scaled + "</td><td>" + fmt0(e.accuracy) + "%</td><td>" + (e.time || "—") + "m</td></tr>";
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

    makeChart(accCanvas, {
      type: "line",
      data: {
        datasets: SECTIONS.map((sec) => ({
          label: sec,
          data: practiceEntries.filter((e) => e.section === sec).map((e) => ({ x: e.date, y: e.accuracy })),
          borderColor: SECTION_COLORS[sec], backgroundColor: SECTION_COLORS[sec], tension: 0.25, spanGaps: true,
        })),
      },
      options: { scales: { x: { type: "time", time: { unit: "week" } }, y: { min: 0, max: 100, title: { display: true, text: "Accuracy %" } } }, plugins: { legend: { position: "bottom" } } },
    });

    makeChart(compCanvas, {
      type: "line",
      data: {
        datasets: SECTIONS.map((sec) => ({
          label: sec,
          data: practiceEntries.filter((e) => e.section === sec && e.completion !== null).map((e) => ({ x: e.date, y: e.completion })),
          borderColor: SECTION_COLORS[sec], backgroundColor: SECTION_COLORS[sec], tension: 0.25, spanGaps: true,
        })),
      },
      options: { scales: { x: { type: "time", time: { unit: "week" } }, y: { min: 0, max: 100, title: { display: true, text: "Completion %" } } }, plugins: { legend: { position: "bottom" } } },
    });

    makeChart(timeCanvas, {
      type: "line",
      data: {
        datasets: SECTIONS.map((sec) => ({
          label: sec,
          data: practiceEntries.filter((e) => e.section === sec && e.time && e.qCount).map((e) => ({ x: e.date, y: Math.round((e.time * 60) / e.qCount) })),
          borderColor: SECTION_COLORS[sec], backgroundColor: SECTION_COLORS[sec], tension: 0.25, spanGaps: true,
        })),
      },
      options: { scales: { x: { type: "time", time: { unit: "week" } }, y: { title: { display: true, text: "Seconds / question" } } }, plugins: { legend: { position: "bottom" } } },
    });

    const mistakeCounts = {};
    practiceEntries.forEach((e) => (e.mistakes || []).forEach((m) => { mistakeCounts[m] = (mistakeCounts[m] || 0) + 1; }));
    const labels = Object.keys(mistakeCounts);
    makeChart(mistakeCanvas, {
      type: "bar",
      data: { labels, datasets: [{ label: "Times logged", data: labels.map((l) => mistakeCounts[l]), backgroundColor: "#7C3AED" }] },
      options: { indexAxis: "y", plugins: { legend: { display: false } } },
    });
  }

  /* =========================================================================
     TARGETS & PREDICTION PAGE
     ========================================================================= */
  function renderTargetsPage() {
    SECTIONS.forEach((s) => { document.getElementById("t_" + s).value = DB.targets[s] || ""; });

    const bars = document.getElementById("progressBars");
    bars.innerHTML = "";
    SECTIONS.forEach((sec) => {
      const latest = latestEntryFor(sec);
      const target = DB.targets[sec] || 700;
      const current = latest ? latest.scaled : 300;
      const pct = clamp(((current - 300) / (target - 300)) * 100, 0, 100);
      const gap = target - current;
      bars.innerHTML +=
        '<div class="progress-item"><div class="top-row"><span>' + SECTION_NAMES[sec] + '</span><span>' + current + " / " + target + " (" + (gap > 0 ? "gap " + gap : "target reached") + ')</span></div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + pct + "%; background:" + SECTION_COLORS[sec] + ';"></div></div></div>';
    });

    const predBlock = document.getElementById("predictionBlock");
    predBlock.innerHTML = "";
    const weights = [5, 4, 3, 2, 1];
    let predTotal = 0, predCount = 0;
    SECTIONS.forEach((sec) => {
      const arr = filterEntries({ section: sec, categories: FULLMOCK_LIKE }).slice(-5).reverse(); // most recent first
      let predicted = null;
      if (arr.length) {
        let wsum = 0, wtotal = 0;
        arr.forEach((e, i) => { const w = weights[i] || 1; wsum += e.scaled * w; wtotal += w; });
        predicted = round10(wsum / wtotal);
        predTotal += predicted; predCount++;
      }
      predBlock.innerHTML += '<div class="pred-item"><div class="v" style="color:' + SECTION_COLORS[sec] + '">' + (predicted || "—") + '</div><div class="k">' + sec + " predicted</div></div>";
    });
    predBlock.innerHTML += '<div class="pred-item"><div class="v">' + (predCount ? fmt0(predTotal / predCount) : "—") + '</div><div class="k">Predicted average</div></div>';
    predBlock.innerHTML += '<div class="pred-item"><div class="v">' + (predCount ? predTotal : "—") + '</div><div class="k">Predicted combined total</div></div>';
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
      body.innerHTML = '<tr><td colspan="12" style="text-align:center; color:#9aa0a8; padding:20px;">No entries match these filters.</td></tr>';
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
        "<td>" + e.raw + "</td>" +
        "<td>" + e.maxRaw + "</td>" +
        "<td><strong>" + e.scaled + "</strong></td>" +
        "<td>" + fmt0(e.accuracy) + "%</td>" +
        "<td>" + (e.time || "—") + "m</td>" +
        "<td>" + esc((e.notes || "").slice(0, 40)) + "</td>" +
        "<td><button class='del-btn' data-del='" + e.id + "'>Delete</button></td>" +
        "</tr>";
    });
    body.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!confirm("Delete this entry? This cannot be undone.")) return;
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

  function buildMultiTable() {
    const tbody = document.querySelector("#multiTable tbody");
    tbody.innerHTML = "";
    SECTIONS.forEach((sec) => {
      const info = STANDARD_SECTION_INFO[sec];
      const row = document.createElement("tr");
      row.dataset.section = sec;
      row.innerHTML =
        "<td><span class='tag tag-" + sec.toLowerCase() + "'>" + sec + "</span></td>" +
        "<td><input type='number' class='m_raw' min='0' placeholder='raw'></td>" +
        "<td><input type='number' class='m_max' min='1' value='" + info.maxRaw + "'></td>" +
        "<td><input type='number' class='m_time' min='0' value='" + info.time + "'></td>" +
        "<td><output class='m_scaled'>—</output></td>";
      tbody.appendChild(row);
      row.querySelector(".m_raw").addEventListener("input", () => updateMultiRowScaled(row));
      row.querySelector(".m_max").addEventListener("input", () => updateMultiRowScaled(row));
    });
  }
  function updateMultiRowScaled(row) {
    const raw = parseFloat(row.querySelector(".m_raw").value);
    const max = parseFloat(row.querySelector(".m_max").value);
    const s = suggestScaled(raw, max);
    row.querySelector(".m_scaled").textContent = s || "—";
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

  // Mock type drives whether "log all four sections" is auto-checked, and whether a
  // standard section time is assumed (full mocks & timed practice are timed; mini-mocks
  // and untimed practice are left blank for the person to fill in if relevant).
  function applyCategoryDefaults() {
    const category = document.getElementById("f_category").value;
    if (!multiManuallyToggled) {
      document.getElementById("f_multiSection").checked = FULLMOCK_LIKE.includes(category);
      toggleMultiSection();
    }
    applyTestNameSuggestion();
    applyTimeDefault();
  }

  function applyTimeDefault() {
    if (timeManuallyEdited) return;
    const category = document.getElementById("f_category").value;
    const section = document.getElementById("f_section").value;
    document.getElementById("f_time").value = TIMED_LIKE.includes(category) ? STANDARD_SECTION_INFO[section].time : "";
  }

  // Section dropdown drives the standard raw-mark structure. Switching sections always
  // refreshes these to that section's standard, since a new section means a fresh attempt.
  function applySectionDefaults() {
    const section = document.getElementById("f_section").value;
    const info = STANDARD_SECTION_INFO[section];
    maxManuallyEdited = false;
    qManuallyEdited = false;
    scaledManuallyEdited = false;
    document.getElementById("f_maxRaw").value = info.maxRaw;
    syncQuestionsInSet();
    applyTimeDefault();
    toggleSjtBand();
    updateScaledSuggestion();
    updateAccuracyPreview();
  }

  function syncQuestionsInSet() {
    if (qManuallyEdited) return;
    document.getElementById("f_qCount").value = document.getElementById("f_maxRaw").value;
    document.getElementById("f_attempted").placeholder = "defaults to " + document.getElementById("f_qCount").value;
  }

  function resetLogForm() {
    document.getElementById("logForm").reset();
    document.getElementById("f_date").value = new Date().toISOString().slice(0, 10);
    document.getElementById("f_source").value = DB.settings.lastSource || "";
    scaledManuallyEdited = false;
    maxManuallyEdited = false;
    qManuallyEdited = false;
    timeManuallyEdited = false;
    multiManuallyToggled = false;
    lastAutoTestName = "";
    document.querySelectorAll("#mistakeChips input").forEach((c) => (c.checked = false));
    buildMultiTable();
    applyTestNameSuggestion();
    applySectionDefaults();
    applyCategoryDefaults();
    document.getElementById("advancedFields").open = false;
  }

  function toggleMultiSection() {
    const multi = document.getElementById("f_multiSection").checked;
    document.getElementById("singleSectionBlock").classList.toggle("hidden", multi);
    document.getElementById("multiSectionBlock").classList.toggle("hidden", !multi);
  }

  function toggleSjtBand() {
    const isSjt = document.getElementById("f_section").value === "SJT";
    document.getElementById("sjtBandWrap").classList.toggle("hidden", !isSjt);
  }

  function updateScaledSuggestion() {
    if (scaledManuallyEdited) return;
    const raw = parseFloat(document.getElementById("f_raw").value);
    const max = parseFloat(document.getElementById("f_maxRaw").value);
    const s = suggestScaled(raw, max);
    document.getElementById("f_scaled").value = s || "";
  }

  function updateAccuracyPreview() {
    const raw = parseFloat(document.getElementById("f_raw").value);
    const max = parseFloat(document.getElementById("f_maxRaw").value);
    const out = document.getElementById("f_accuracyPreview");
    out.textContent = !isNaN(raw) && max ? fmt0(clamp((raw / max) * 100, 0, 100)) + "%" : "—";
  }

  function handleLogSubmit(ev) {
    ev.preventDefault();
    const date = document.getElementById("f_date").value;
    const testName = document.getElementById("f_testName").value.trim() || "Untitled";
    const category = document.getElementById("f_category").value;
    const source = document.getElementById("f_source").value.trim();
    const notes = document.getElementById("f_notes").value.trim();
    const mistakes = Array.from(document.querySelectorAll("#mistakeChips input:checked")).map((c) => c.value);
    const sittingId = uid();
    const createdAt = Date.now();

    if (!date) { alert("Please pick a date."); return; }

    const isMulti = document.getElementById("f_multiSection").checked;
    let created = 0;

    if (isMulti) {
      document.querySelectorAll("#multiTable tbody tr").forEach((row) => {
        const sec = row.dataset.section;
        const raw = parseFloat(row.querySelector(".m_raw").value);
        const max = parseFloat(row.querySelector(".m_max").value);
        if (isNaN(raw) || isNaN(max) || max <= 0) return; // skip blank rows
        const time = parseFloat(row.querySelector(".m_time").value) || null;
        const scaled = suggestScaled(raw, max);
        DB.entries.push({
          id: uid(), sittingId, date, testName, category, source, section: sec,
          raw, maxRaw: max, qCount: max, attempted: max, time, scaled,
          accuracy: (raw / max) * 100, completion: 100, band: null, mistakes: [], notes, createdAt,
        });
        created++;
      });
    } else {
      const section = document.getElementById("f_section").value;
      const raw = parseFloat(document.getElementById("f_raw").value);
      const maxRaw = parseFloat(document.getElementById("f_maxRaw").value);
      const qCount = parseFloat(document.getElementById("f_qCount").value) || maxRaw;
      const attemptedRaw = document.getElementById("f_attempted").value;
      const attempted = attemptedRaw !== "" ? parseFloat(attemptedRaw) : qCount;
      const time = parseFloat(document.getElementById("f_time").value) || null;
      let scaled = parseFloat(document.getElementById("f_scaled").value);
      if (isNaN(scaled)) scaled = suggestScaled(raw, maxRaw);
      const band = section === "SJT" ? (parseFloat(document.getElementById("f_band").value) || null) : null;
      if (isNaN(raw) || isNaN(maxRaw) || maxRaw <= 0 || !scaled) {
        alert("Please enter at least raw score, max raw mark, so a scaled score can be calculated (or enter scaled score directly).");
        return;
      }
      DB.entries.push({
        id: uid(), sittingId: uid(), date, testName, category, source, section,
        raw, maxRaw, qCount, attempted, time, scaled,
        accuracy: (raw / maxRaw) * 100, completion: qCount ? (attempted / qCount) * 100 : null,
        band, mistakes, notes, createdAt,
      });
      created++;
    }

    if (!created) { alert("No valid section scores were entered."); return; }

    if (source) DB.settings.lastSource = source;
    save();
    document.getElementById("saveMsg").textContent = "Saved " + created + " entr" + (created === 1 ? "y" : "ies") + " ✓";
    setTimeout(() => (document.getElementById("saveMsg").textContent = ""), 3000);
    resetLogForm();
    refreshAllAfterDataChange();
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
        DB = parsed;
        if (!DB.targets) DB.targets = defaultData().targets;
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
      btn.addEventListener("click", () => showPage(btn.dataset.page));
    });
    document.getElementById("quickAddBtn").addEventListener("click", () => showPage("log"));

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
    document.getElementById("f_raw").addEventListener("input", () => { updateScaledSuggestion(); updateAccuracyPreview(); });
    document.getElementById("f_maxRaw").addEventListener("input", () => {
      maxManuallyEdited = true;
      syncQuestionsInSet();
      updateScaledSuggestion();
      updateAccuracyPreview();
    });
    document.getElementById("f_qCount").addEventListener("input", () => { qManuallyEdited = true; });
    document.getElementById("f_time").addEventListener("input", () => { timeManuallyEdited = true; });
    document.getElementById("f_scaled").addEventListener("input", () => (scaledManuallyEdited = true));
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
      SECTIONS.forEach((s) => {
        const v = parseFloat(document.getElementById("t_" + s).value);
        if (!isNaN(v)) DB.targets[s] = clamp(round10(v), 300, 900);
      });
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
