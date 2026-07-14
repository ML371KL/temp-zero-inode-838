/*
  Second-round evaluation: design-improvement variants suggested by round 1.
  - dashboard-faithful position map (deteriorating = hold, not sell)
  - recovery-detector override
  - stricter "deteriorating" (needs 2 adverse or demand adverse)
  - dwell filter (regime must persist N days)
  - score distribution / reachable bounds
  - regime transition matrix
*/
import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const rows = JSON.parse(readFileSync(`${OUT}timeline.json`, "utf8"));
const finite = v => v !== null && v !== undefined && Number.isFinite(Number(v));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const stdev = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const r2 = v => v == null ? null : Math.round(v * 100) / 100;
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

function simulate(posAt, from = "2019-07-01", to = null, cost = 0.001) {
  let equity = 1, pos = 0, peak = 1, maxDD = 0, turnover = 0, tim = 0, n = 0;
  const daily = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], prev = rows[i - 1];
    if (r.date < from) continue;
    if (to && r.date > to) break;
    const target = posAt(prev, i - 1);
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
  return { total: r1((equity - 1) * 100), cagr: r1(cagr), vol: r1(vol), sharpe: r2(sharpe), maxDD: r1(maxDD * 100), turnover: r1(turnover), timeInMkt: r2(tim / (n || 1)) };
}

const report = {};

// dashboard-faithful map: deteriorating = "hold, don't add" (not sell); defensive = capital preservation
const FAITHFUL = { constructive: 1, unconfirmed_positive: 0.8, transition: 0.6, deteriorating: 0.5, defensive: 0.15, insufficient: 0.5 };
// recovery override: capitulation->recovery detector good lifts floor to 0.6
function posFaithful(r) { return FAITHFUL[r.regimeRelaxed] ?? 0.5; }
function posRecovery(r) {
  const base = FAITHFUL[r.regimeRelaxed] ?? 0.5;
  if (r.detectors?.recovery === "good") return Math.max(base, 0.7);
  return base;
}
// macro_shock override: fired cuts position hard (it was the only predictive bearish detector)
function posMacroShock(r) {
  let base = FAITHFUL[r.regimeRelaxed] ?? 0.5;
  if (r.detectors?.recovery === "good") base = Math.max(base, 0.7);
  if (r.detectors?.macro_shock === "fired") base = Math.min(base, 0.1);
  return base;
}

// stricter deteriorating: recompute regime requiring demand-adverse OR >=2 adverse for risk-off
function regimeStrict2(r) {
  const B = s => s == null ? "unknown" : s >= 20 ? "supportive" : s <= -20 ? "adverse" : "neutral";
  const M = B(r.blockS.macro), D = B(r.blockS.demand), C = B(r.blockS.cycle);
  if (r.regimeRelaxed === "insufficient") return "insufficient";
  const advCount = [M, D, C].filter(x => x === "adverse").length;
  let s = "transition";
  if (advCount >= 2) s = "defensive";
  else if (D === "adverse" || advCount >= 1 && (M === "adverse" && C === "adverse")) s = "deteriorating";
  else if (advCount >= 1) s = "transition"; // single non-demand adverse block -> just transition
  else if (D === "supportive" && (C === "supportive" || M === "supportive")) s = "constructive";
  else if (M === "supportive" && C === "supportive" && D === "neutral") s = "unconfirmed_positive";
  const val = r.families.valuation;
  if ((!finite(val) || val <= -1) && ["constructive", "unconfirmed_positive"].includes(s)) s = "transition";
  return s;
}

// dwell filter: candidate must persist N days before the acted-on regime switches
function dwellSeries(regFn, N) {
  const out = new Array(rows.length); let acted = null, cand = null, count = 0;
  for (let i = 0; i < rows.length; i++) {
    const c = regFn(rows[i]);
    if (c === cand) count++; else { cand = c; count = 1; }
    if (acted == null || count >= N) acted = cand;
    out[i] = acted;
  }
  return out;
}

report.maps = {};
for (const [from, to, label] of [["2019-07-01", null, "full"], ["2022-01-01", "2022-12-31", "2022"], ["2023-01-01", "2024-12-31", "2023-2024"], ["2025-01-01", null, "2025-2026"]]) {
  report.maps[label] = {
    hodl: simulate(() => 1, from, to, 0),
    faithful: simulate(posFaithful, from, to),
    faithfulRecovery: simulate(posRecovery, from, to),
    faithfulRecoveryMacroShock: simulate(posMacroShock, from, to),
    strict2: simulate(r => FAITHFUL[regimeStrict2(r)] ?? 0.5, from, to),
    strict2Recovery: simulate(r => { let b = FAITHFUL[regimeStrict2(r)] ?? 0.5; if (r.detectors?.recovery === "good") b = Math.max(b, 0.7); if (r.detectors?.macro_shock === "fired") b = Math.min(b, 0.1); return b; }, from, to),
  };
  for (const N of [3, 5, 10]) {
    const seq = dwellSeries(r => regimeStrict2(r), N);
    report.maps[label]["strict2Dwell" + N] = simulate((r, i) => { let b = FAITHFUL[seq[i]] ?? 0.5; if (r.detectors?.recovery === "good") b = Math.max(b, 0.7); if (r.detectors?.macro_shock === "fired") b = Math.min(b, 0.1); return b; }, from, to);
  }
}

// whipsaw for strict2 + dwell
function whipsaw(regAt) {
  let cur = null, changes = 0; const runs = []; let len = 0;
  const seg = rows.filter(r => r.date >= "2019-07-01");
  let i0 = rows.findIndex(r => r.date >= "2019-07-01");
  for (let i = i0; i < rows.length; i++) {
    const reg = regAt(rows[i], i);
    if (reg === cur) len++; else { if (cur) runs.push(len); cur = reg; len = 1; changes++; }
  }
  runs.push(len);
  const med = [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  return { changesPerYear: r1(changes / (seg.length / 365)), medianDwell: med };
}
report.whipsaw = {
  original: whipsaw(r => r.regimeRelaxed),
  strict2: whipsaw(r => regimeStrict2(r)),
};
for (const N of [3, 5, 10]) { const seq = dwellSeries(r => regimeStrict2(r), N); report.whipsaw["strict2Dwell" + N] = whipsaw((r, i) => seq[i]); }

// regime day counts + fwd for strict2
{
  const stats = {};
  const DAYMS = 86400000;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; if (r.date < "2019-07-01") continue;
    const reg = regimeStrict2(r);
    (stats[reg] ??= { n: 0, f90: [] }); stats[reg].n++;
    if (finite(r.fwd?.[90])) stats[reg].f90.push(r.fwd[90]);
  }
  // fwd was not persisted in timeline.json; recompute quickly
  const idx = new Map(rows.map((r, i) => [r.date, i]));
  const fwd90 = i => { const j = i + 90; if (j >= rows.length) return null; return (rows[j].price / rows[i].price - 1) * 100; };
  const stats2 = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; if (r.date < "2019-07-01") continue;
    const reg = regimeStrict2(r);
    (stats2[reg] ??= { n: 0, f: [] }); stats2[reg].n++;
    const f = fwd90(i); if (f != null) stats2[reg].f.push(f);
  }
  report.strict2Regimes = Object.fromEntries(Object.entries(stats2).map(([k, v]) => [k, { days: v.n, fwd90mean: r1(mean(v.f)), fwd90hit: r2(v.f.filter(x => x > 0).length / (v.f.length || 1)) }]));
}

// score distribution
{
  const s = rows.filter(r => r.date >= "2019-07-01" && finite(r.strategicScore)).map(r => r.strategicScore).sort((a, b) => a - b);
  const q = p => s[Math.floor(p * (s.length - 1))];
  report.scoreDistribution = { min: r1(s[0]), p5: r1(q(.05)), p25: r1(q(.25)), median: r1(q(.5)), p75: r1(q(.75)), p95: r1(q(.95)), max: r1(s[s.length - 1]), daysAbove20: s.filter(x => x >= 20).length, daysBelowMinus20: s.filter(x => x <= -20).length, total: s.length };
}

// regime transition matrix (original relaxed)
{
  const m = {};
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].date < "2019-07-01") continue;
    const a = rows[i - 1].regimeRelaxed, b = rows[i].regimeRelaxed;
    if (a !== b) { (m[a] ??= {}); m[a][b] = (m[a][b] || 0) + 1; }
  }
  report.transitions = m;
}

writeFileSync(`${OUT}report2.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
