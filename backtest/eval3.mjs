/*
  Final head-to-head: v2.7.3 (as deployed) vs v2.8.0 (proposed) on identical reconstructed data.
  v2.7.3: integer-amplified family scores, "any adverse => deteriorating" ladder, no detector power,
          symmetric 2-snapshot hysteresis (negligible at daily resolution).
  v2.8.0: half-step scores, demand-anchored ladder, macro_shock cap + recovery lift,
          valuation +1 at <=10th pct, asymmetric 2-day upgrade hold.
  Position maps follow the dashboard's own behavior texts.
*/
import { readFileSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const rows = JSON.parse(readFileSync(`${OUT}timeline.json`, "utf8"));
const finite = v => v != null && Number.isFinite(Number(v));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const stdev = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const r2 = v => v == null ? null : Math.round(v * 100) / 100;
const roundSym = v => v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const FAMS = { macro: ["liquidity", "conditions", "stress"], demand: ["etf", "stablecoins", "exchange_supply", "institutional"], cycle: ["valuation", "network", "activity", "miners", "trend"] };
const SEV = { constructive: 2, unconfirmed_positive: 1, transition: 0, deteriorating: -1, defensive: -2, insufficient: 0 };
const MAP = { constructive: 1, unconfirmed_positive: 0.8, transition: 0.6, deteriorating: 0.5, defensive: 0.15, insufficient: 0.5 };

function famScore(r, f, version) {
  let s = r.families[f];
  if (version === "v28") {
    if (f === "valuation" && finite(r.families.mvrvPct)) { const p = r.families.mvrvPct; s = p >= 95 ? -2 : p >= 82 ? -1 : p <= 10 ? 1 : 0; }
    if (f === "stress" && finite(r.families.stress28)) s = r.families.stress28;
    if (f === "exchange_supply" && finite(r.families.exchange_supply28)) s = r.families.exchange_supply28;
  }
  if (!finite(s)) return null;
  return version === "v27" ? clamp(roundSym(s), -2, 2) : s; // v2.7.3 integer amplification
}
function blockScores(r, version) {
  const out = {};
  for (const [b, fams] of Object.entries(FAMS)) {
    const avail = fams.map(f => famScore(r, f, version)).filter(finite);
    out[b] = avail.length ? mean(avail) / 2 * 100 : null;
  }
  return out;
}
function candidate(r, version) {
  if (r.regimeRelaxed === "insufficient") return "insufficient";
  const bs = blockScores(r, version);
  const B = s => s == null ? "unknown" : s >= 20 ? "supportive" : s <= -20 ? "adverse" : "neutral";
  const M = B(bs.macro), D = B(bs.demand), C = B(bs.cycle);
  const adv = [M, D, C].filter(x => x === "adverse").length;
  let s = "transition";
  if (version === "v27") {
    if ((D === "adverse" && C === "adverse") || (M === "adverse" && D === "adverse")) s = "defensive";
    else if (adv >= 1) s = "deteriorating";
    else if (D === "supportive" && C === "supportive" && M !== "adverse") s = "constructive";
    else if (D === "supportive" && M === "supportive") s = "constructive";
    else if (M === "supportive" && C === "supportive" && D === "neutral") s = "unconfirmed_positive";
  } else {
    if (adv >= 2) s = "defensive";
    else if (D === "adverse") s = "deteriorating";
    else if (adv >= 1) s = "transition";
    else if (D === "supportive" && C === "supportive" && M !== "adverse") s = "constructive";
    else if (D === "supportive" && M === "supportive") s = "constructive";
    else if (M === "supportive" && C === "supportive" && D === "neutral") s = "unconfirmed_positive";
  }
  const val = famScore(r, "valuation", version);
  if ((!finite(val) || val <= -1) && ["constructive", "unconfirmed_positive"].includes(s)) s = "transition";
  if (version === "v28") {
    // detector states in timeline were computed with half-step families = v28 semantics
    if (r.detectors.macro_shock === "fired" && ["constructive", "unconfirmed_positive", "transition"].includes(s)) s = "deteriorating";
    if (r.detectors.recovery === "good" && r.detectors.macro_shock !== "fired" && ["defensive", "deteriorating"].includes(s)) s = "transition";
  }
  return s;
}
// acted regime with hysteresis: v27 = act next day; v28 = downgrades instant, upgrades hold 2 days
function actedSeries(version) {
  const out = new Array(rows.length);
  let acted = null, cand = null, count = 0;
  for (let i = 0; i < rows.length; i++) {
    const c = candidate(rows[i], version);
    if (c === cand) count++; else { cand = c; count = 1; }
    if (acted == null) acted = c;
    else if (version === "v27") acted = c;
    else if (SEV[c] < SEV[acted]) acted = c;
    else if (SEV[c] > SEV[acted] && count >= 2) acted = c;
    out[i] = acted;
  }
  return out;
}

function simulate(seq, from, to, cost = 0.001) {
  let equity = 1, pos = 0, peak = 1, maxDD = 0, turnover = 0, n = 0;
  const daily = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.date < from) continue; if (to && r.date > to) break;
    const target = MAP[seq[i - 1]] ?? 0.5;
    const ret = r.price / rows[i - 1].price - 1;
    equity *= 1 + pos * ret;
    if (Math.abs(target - pos) > 1e-9) { equity *= 1 - cost * Math.abs(target - pos); turnover += Math.abs(target - pos); }
    pos = target; peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity / peak - 1);
    daily.push(pos * ret); n++;
  }
  const years = n / 365, vol = stdev(daily) * Math.sqrt(365) * 100;
  return { total: r1((equity - 1) * 100), cagr: r1(years > .5 ? (equity ** (1 / years) - 1) * 100 : null), vol: r1(vol), sharpe: r2(vol ? mean(daily) * 365 * 100 / vol : null), maxDD: r1(maxDD * 100), turnover: r1(turnover) };
}
function whipsaw(seq) {
  const i0 = rows.findIndex(r => r.date >= "2019-07-01");
  let cur = null, changes = 0; const runs = []; let len = 0;
  for (let i = i0; i < rows.length; i++) { if (seq[i] === cur) len++; else { if (cur) runs.push(len); cur = seq[i]; len = 1; changes++; } }
  runs.push(len);
  return { changesPerYear: r1(changes / ((rows.length - i0) / 365)), medianDwellDays: [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)] };
}
function regimeFwd(version) {
  const stats = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; if (r.date < "2019-07-01") continue;
    const reg = candidate(r, version), j = i + 90;
    (stats[reg] ??= { n: 0, f: [] }); stats[reg].n++;
    if (j < rows.length) stats[reg].f.push((rows[j].price / r.price - 1) * 100);
  }
  return Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { days: v.n, fwd90: r1(mean(v.f)), hit: r2(v.f.filter(x => x > 0).length / (v.f.length || 1)) }]));
}

const seq27 = actedSeries("v27"), seq28 = actedSeries("v28");
const out = { regimes27: regimeFwd("v27"), regimes28: regimeFwd("v28"), whipsaw27: whipsaw(seq27), whipsaw28: whipsaw(seq28), sim: {} };
for (const [from, to, label] of [["2019-07-01", null, "full"], ["2019-07-01", "2021-12-31", "2019-2021"], ["2022-01-01", "2022-12-31", "2022"], ["2023-01-01", "2024-12-31", "2023-2024"], ["2025-01-01", null, "2025-2026"]]) {
  out.sim[label] = { hodl: simulate(rows.map(() => "constructive"), from, to, 0), v27: simulate(seq27, from, to), v28: simulate(seq28, from, to) };
}
console.log(JSON.stringify(out, null, 1));
// compact chart export: [date, price, v27 code, v28 code, strategicScore]
import { writeFileSync } from "node:fs";
const CODE = { constructive: 2, unconfirmed_positive: 1, transition: 0, deteriorating: -1, defensive: -2, insufficient: 0 };
const chart = [];
for (let i = 0; i < rows.length; i += 3) {
  const r = rows[i]; if (r.date < "2019-07-01") continue;
  chart.push([r.date, Math.round(r.price), CODE[seq27[i]], CODE[seq28[i]], r.strategicScore == null ? null : Math.round(r.strategicScore)]);
}
writeFileSync(`${OUT}chart-data.json`, JSON.stringify(chart));
