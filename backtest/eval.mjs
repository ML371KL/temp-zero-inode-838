/*
  Evaluation of the reconstructed 21M scoring timeline:
  - forward returns conditioned on regime / score
  - per-family predictive power (IC) and redundancy
  - strategy simulations vs buy&hold
  - whipsaw statistics
  - sensitivity variants (gate bands, MVRV symmetric, weights)
*/
import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const rows = JSON.parse(readFileSync(`${OUT}timeline.json`, "utf8"));
const DAY = 86_400_000;
const finite = v => v !== null && v !== undefined && Number.isFinite(Number(v));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { const x = [...a].sort((p, q) => p - q); return x.length ? (x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2) : null; };
const stdev = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const r2 = v => v == null ? null : Math.round(v * 100) / 100;
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

// forward returns
const byT = new Map(rows.map((r, i) => [r.date, i]));
function fwdRet(i, days) {
  const target = rows[i].t + days * DAY;
  let j = i + days; // daily grid, approximately
  if (j >= rows.length) {
    return null;
  }
  // adjust to nearest at/after target
  while (j > i && rows[j].t > target) j--;
  while (j < rows.length - 1 && rows[j].t < target) j++;
  if (Math.abs(rows[j].t - target) > 3 * DAY) return null;
  return (rows[j].price / rows[i].price - 1) * 100;
}
const HORIZONS = [7, 14, 30, 60, 90, 180];
for (let i = 0; i < rows.length; i++) { rows[i].fwd = {}; for (const h of HORIZONS) rows[i].fwd[h] = fwdRet(i, h); }

function spearman(pairs) {
  const n = pairs.length; if (n < 30) return null;
  const rank = arr => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const out = new Array(n); let i = 0; while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) out[idx[k][1]] = r; i = j + 1; } return out; };
  const ra = rank(pairs.map(p => p[0])), rb = rank(pairs.map(p => p[1]));
  const ma = mean(ra), mb = mean(rb);
  const cov = mean(ra.map((v, i) => (v - ma) * (rb[i] - mb)));
  const sa = stdev(ra), sb = stdev(rb);
  return sa && sb ? cov / (sa * sb) : null;
}
function pearson(pairs) {
  const n = pairs.length; if (n < 30) return null;
  const a = pairs.map(p => p[0]), b = pairs.map(p => p[1]);
  const ma = mean(a), mb = mean(b), sa = stdev(a), sb = stdev(b);
  return sa && sb ? mean(a.map((v, i) => (v - ma) * (b[i] - mb))) / (sa * sb) : null;
}

const report = {};

// ---------- 1. Regime -> forward returns ----------
function regimeStats(field, from = "2019-07-01", step = 1) {
  const out = {};
  for (let i = 0; i < rows.length; i += step) {
    const r = rows[i];
    if (r.date < from) continue;
    const reg = r[field];
    (out[reg] ??= { n: 0, f30: [], f60: [], f90: [], f180: [] });
    out[reg].n++;
    for (const h of [30, 60, 90, 180]) if (finite(r.fwd[h])) out[reg]["f" + h].push(r.fwd[h]);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, {
    days: v.n,
    fwd30: { mean: r1(mean(v.f30)), med: r1(median(v.f30)), hit: r2(v.f30.filter(x => x > 0).length / (v.f30.length || 1)) },
    fwd90: { mean: r1(mean(v.f90)), med: r1(median(v.f90)), hit: r2(v.f90.filter(x => x > 0).length / (v.f90.length || 1)) },
    fwd180: { mean: r1(mean(v.f180)), med: r1(median(v.f180)), hit: r2(v.f180.filter(x => x > 0).length / (v.f180.length || 1)) },
  }]));
}
report.regimeStatsRelaxed = regimeStats("regimeRelaxed");
report.regimeStatsStrict2024 = regimeStats("regimeStrict", "2024-04-01");

// ---------- 2. Score IC ----------
function ic(scoreFn, from = "2019-07-01", step = 7) {
  const out = {};
  for (const h of [7, 14, 30, 60, 90, 180]) {
    const pairs = [];
    for (let i = 0; i < rows.length; i += step) {
      const r = rows[i]; if (r.date < from) continue;
      const s = scoreFn(r);
      if (finite(s) && finite(r.fwd[h])) pairs.push([s, r.fwd[h]]);
    }
    out["h" + h] = { ic: r2(spearman(pairs)), n: pairs.length };
  }
  return out;
}
report.icStrategic = ic(r => r.strategicScore);
report.icTactical = ic(r => r.tacticalScore);
report.icStrategic2022plus = ic(r => r.strategicScore, "2022-01-01");
report.icStrategic2024plus = ic(r => r.strategicScore, "2024-04-01");

// score quintiles -> fwd returns
function quintiles(scoreFn, h, from = "2019-07-01") {
  const pts = rows.filter(r => r.date >= from && finite(scoreFn(r)) && finite(r.fwd[h])).map(r => [scoreFn(r), r.fwd[h]]);
  pts.sort((a, b) => a[0] - b[0]);
  const q = 5, out = [];
  for (let k = 0; k < q; k++) {
    const seg = pts.slice(Math.floor(k * pts.length / q), Math.floor((k + 1) * pts.length / q));
    out.push({ q: k + 1, scoreRange: [r1(seg[0]?.[0]), r1(seg[seg.length - 1]?.[0])], meanFwd: r1(mean(seg.map(p => p[1]))), hit: r2(seg.filter(p => p[1] > 0).length / (seg.length || 1)) });
  }
  return out;
}
report.strategicQuintiles30 = quintiles(r => r.strategicScore, 30);
report.strategicQuintiles90 = quintiles(r => r.strategicScore, 90);
report.tacticalQuintiles14 = quintiles(r => r.tacticalScore, 14);
report.tacticalQuintiles30 = quintiles(r => r.tacticalScore, 30);

// ---------- 3. Family-level IC + conditional returns ----------
const FAMILIES = ["liquidity", "conditions", "stress", "etf", "stablecoins", "exchange_supply", "institutional", "valuation", "network", "activity", "miners", "trend", "realized_vol", "volatility", "volume"];
report.familyIC = {};
for (const f of FAMILIES) {
  const e = {};
  for (const h of [30, 90]) {
    const pairs = [];
    for (let i = 0; i < rows.length; i += 7) { const r = rows[i]; if (r.date < "2019-07-01") continue; const s = r.families[f]; if (finite(s) && finite(r.fwd[h])) pairs.push([s, r.fwd[h]]); }
    e["ic" + h] = r2(spearman(pairs));
    e.n = pairs.length;
  }
  // conditional means (daily, 30d fwd)
  const neg = [], zer = [], pos = [];
  for (const r of rows) { if (r.date < "2019-07-01") continue; const s = r.families[f]; if (!finite(s) || !finite(r.fwd[30])) continue; (s < 0 ? neg : s > 0 ? pos : zer).push(r.fwd[30]); }
  e.fwd30 = { neg: r1(mean(neg)), zero: r1(mean(zer)), pos: r1(mean(pos)), nNeg: neg.length, nZero: zer.length, nPos: pos.length };
  report.familyIC[f] = e;
}

// raw-value ICs for key gates (does the percentile grading add value over the raw signal?)
report.rawIC = {};
for (const [name, fn] of Object.entries({
  net13: r => r.raw?.net13, st90: r => r.raw?.st90, etf20Btc: r => r.raw?.etf20Btc,
  mvrvPct: r => r.families?.mvrvPct, pVsMa200: r => r.raw?.pVsMa200, rvPct: r => r.raw?.rvPct, dvolPct: r => r.raw?.dvolPct,
})) {
  report.rawIC[name] = { ic30: ic(fn)["h30"], ic90: ic(fn)["h90"], ic180: ic(fn)["h180"] };
}

// ---------- 4. Family redundancy (score correlation) ----------
report.familyCorr = {};
for (let a = 0; a < FAMILIES.length; a++) for (let b = a + 1; b < FAMILIES.length; b++) {
  const fa = FAMILIES[a], fb = FAMILIES[b], pairs = [];
  for (let i = 0; i < rows.length; i += 7) { const r = rows[i]; const x = r.families[fa], y = r.families[fb]; if (finite(x) && finite(y)) pairs.push([x, y]); }
  const c = pearson(pairs);
  if (c != null && Math.abs(c) >= 0.4) report.familyCorr[`${fa}~${fb}`] = r2(c);
}

// ---------- 5. Strategy simulations ----------
const POS_MAPS = {
  mapA: { constructive: 1, unconfirmed_positive: 0.75, transition: 0.5, deteriorating: 0.25, defensive: 0, insufficient: 0.5 },
  binaryDefensive: { constructive: 1, unconfirmed_positive: 1, transition: 1, deteriorating: 1, defensive: 0, insufficient: 1 },
  binaryAdverse: { constructive: 1, unconfirmed_positive: 1, transition: 1, deteriorating: 0, defensive: 0, insufficient: 0.5 },
};
function simulate(posAt, from = "2019-07-01", to = null, cost = 0.001) {
  let equity = 1, pos = 0, peak = 1, maxDD = 0, turnover = 0, tim = 0, n = 0;
  const daily = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], prev = rows[i - 1];
    if (r.date < from) continue;
    if (to && r.date > to) break;
    const target = posAt(prev); // decide on yesterday's snapshot -> hold today
    if (target == null) continue;
    const ret = r.price / prev.price - 1;
    equity *= 1 + pos * ret;
    if (Math.abs(target - pos) > 1e-9) { equity *= 1 - cost * Math.abs(target - pos); turnover += Math.abs(target - pos); }
    pos = target;
    peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity / peak - 1);
    daily.push(pos * ret); tim += pos; n++;
  }
  const years = n / 365;
  const cagr = years > 0.5 ? (equity ** (1 / years) - 1) * 100 : null;
  const vol = stdev(daily) * Math.sqrt(365) * 100;
  const sharpe = vol ? (mean(daily) * 365 * 100) / vol : null;
  return { total: r1((equity - 1) * 100), cagr: r1(cagr), vol: r1(vol), sharpe: r2(sharpe), maxDD: r1(maxDD * 100), turnover: r1(turnover), timeInMkt: r2(tim / (n || 1)), days: n };
}
const PERIODS = [["2019-07-01", null, "full"], ["2019-07-01", "2021-12-31", "2019-2021"], ["2022-01-01", "2022-12-31", "2022"], ["2023-01-01", "2024-12-31", "2023-2024"], ["2025-01-01", null, "2025-2026"]];
report.strategies = {};
for (const [from, to, label] of PERIODS) {
  const seg = { hodl: simulate(() => 1, from, to, 0) };
  for (const [mname, m] of Object.entries(POS_MAPS)) seg[mname] = simulate(r => m[r.regimeRelaxed] ?? 0.5, from, to);
  seg.scoreLinear = simulate(r => finite(r.strategicScore) ? Math.max(0, Math.min(1, 0.5 + r.strategicScore / 40)) : null, from, to);
  seg.scoreBand = simulate(r => finite(r.strategicScore) ? (r.strategicScore >= 20 ? 1 : r.strategicScore <= -20 ? 0 : 0.5) : null, from, to);
  // tactical overlay: strategic map A scaled by tactical score sign
  seg.tacticalOverlay = simulate(r => {
    const base = POS_MAPS.mapA[r.regimeRelaxed] ?? 0.5;
    if (!finite(r.tacticalScore)) return base;
    return Math.max(0, Math.min(1, base * (r.tacticalScore <= -25 ? 0.5 : 1)));
  }, from, to);
  report.strategies[label] = seg;
}

// ---------- 6. Whipsaw ----------
{
  const runs = []; let cur = null, len = 0, changes = 0;
  const seg = rows.filter(r => r.date >= "2019-07-01");
  for (const r of seg) { if (r.regimeRelaxed === cur) len++; else { if (cur) runs.push(len); cur = r.regimeRelaxed; len = 1; changes++; } }
  runs.push(len);
  report.whipsaw = { regimeChanges: changes, perYear: r1(changes / (seg.length / 365)), medianDwellDays: median(runs), meanDwellDays: r1(mean(runs)), shortRuns_lt7d: runs.filter(x => x < 7).length, totalRuns: runs.length };
}

// ---------- 7. Detector evaluation ----------
report.detectors = {};
for (const det of ["demand_break", "macro_shock", "distribution", "recovery"]) {
  const states = {};
  for (const r of rows) {
    if (r.date < "2019-07-01") continue;
    const st = r.detectors[det];
    (states[st] ??= { n: 0, f30: [], f90: [] });
    states[st].n++;
    if (finite(r.fwd[30])) states[st].f30.push(r.fwd[30]);
    if (finite(r.fwd[90])) states[st].f90.push(r.fwd[90]);
  }
  report.detectors[det] = Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { days: v.n, fwd30: r1(mean(v.f30)), fwd90: r1(mean(v.f90)), hit30: r2(v.f30.filter(x => x > 0).length / (v.f30.length || 1)) }]));
}

// ---------- 8. Sensitivity: gate bands ----------
function regimeFromBlocks(r, bandLim, valuationVariant = null) {
  const B = s => s == null ? "unknown" : s >= bandLim ? "supportive" : s <= -bandLim ? "adverse" : "neutral";
  let cyc = r.blockS.cycle;
  let val = r.families.valuation;
  if (valuationVariant) {
    val = valuationVariant(r.families.mvrvPct);
    const fams = ["network", "activity", "miners", "trend"].map(f => r.families[f]).filter(finite);
    if (finite(val)) fams.push(val);
    cyc = fams.length ? mean(fams) / 2 * 100 : null;
  }
  const M = B(r.blockS.macro), D = B(r.blockS.demand), C = B(cyc);
  if (r.regimeRelaxed === "insufficient") return "insufficient";
  let s = "transition";
  if ((D === "adverse" && C === "adverse") || (M === "adverse" && D === "adverse")) s = "defensive";
  else if ([M, D, C].filter(x => x === "adverse").length >= 1) s = "deteriorating";
  else if (D === "supportive" && C === "supportive" && M !== "adverse") s = "constructive";
  else if (D === "supportive" && M === "supportive") s = "constructive";
  else if (M === "supportive" && C === "supportive" && D === "neutral") s = "unconfirmed_positive";
  const mvrvAvailable = finite(r.families.valuation) || (valuationVariant && finite(val));
  if ((!mvrvAvailable || (finite(val) && val <= -1)) && ["constructive", "unconfirmed_positive"].includes(s)) s = "transition";
  return s;
}
report.bandSensitivity = {};
for (const band of [10, 15, 20, 25, 30]) {
  const sim = simulate(r => POS_MAPS.mapA[regimeFromBlocks(r, band)] ?? 0.5, "2019-07-01", null);
  // whipsaw for this band
  let cur = null, changes = 0; const seg = rows.filter(r => r.date >= "2019-07-01");
  for (const r of seg) { const reg = regimeFromBlocks(r, band); if (reg !== cur) { cur = reg; changes++; } }
  report.bandSensitivity["band" + band] = { ...sim, regimeChangesPerYear: r1(changes / (seg.length / 365)) };
}

// ---------- 9. Sensitivity: MVRV symmetric vs penalty-only ----------
const MVRV_VARIANTS = {
  penaltyOnly: p => !finite(p) ? null : p >= 95 ? -2 : p >= 82 ? -1 : 0,
  symmetric: p => !finite(p) ? null : p >= 95 ? -2 : p >= 82 ? -1 : p <= 10 ? 2 : p <= 25 ? 1 : 0,
};
report.mvrvVariants = {};
for (const [name, fn] of Object.entries(MVRV_VARIANTS)) {
  report.mvrvVariants[name] = simulate(r => POS_MAPS.mapA[regimeFromBlocks(r, 20, fn)] ?? 0.5, "2019-07-01", null);
}
// MVRV percentile zones -> fwd returns (is cheap MVRV really not predictive?)
{
  const zones = { "p<=10": [], "10-25": [], "25-50": [], "50-82": [], "82-95": [], ">=95": [] };
  for (const r of rows) { const p = r.families.mvrvPct; if (!finite(p) || !finite(r.fwd[90]) || r.date < "2019-07-01") continue; const z = p <= 10 ? "p<=10" : p <= 25 ? "10-25" : p <= 50 ? "25-50" : p <= 82 ? "50-82" : p < 95 ? "82-95" : ">=95"; zones[z].push(r.fwd[90]); }
  report.mvrvZones90 = Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, { n: v.length, mean: r1(mean(v)), med: r1(median(v)), hit: r2(v.filter(x => x > 0).length / (v.length || 1)) }]));
}

// ---------- 10. Block-level IC (which block deserves the weight?) ----------
report.blockIC = {};
for (const b of ["macro", "demand", "cycle"]) report.blockIC[b] = ic(r => r.blockS[b]);
report.blockIC.leverageT = ic(r => r.blockT.leverage);
report.blockIC.cycleT = ic(r => r.blockT.cycle);

writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
