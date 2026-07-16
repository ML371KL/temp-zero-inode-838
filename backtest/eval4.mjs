/*
  Strategy-strip backtest: the user's allocation ladder (share of BTC limit B by medium-term regime,
  act only on step change, execute next session, idle cash earns T-bill yield) vs baselines,
  a systematic ladder grid search, and detector/valuation/volatility overlays.
  Regime sequence = v2.8 engine semantics (half-steps, demand-anchored gates, detector power,
  asymmetric hysteresis) reconstructed walk-forward; execution lag = next day everywhere.
*/
import { readFileSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DATA = new URL("./data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const rows = JSON.parse(readFileSync(`${OUT}timeline.json`, "utf8"));
const dtb3 = JSON.parse(readFileSync(`${DATA}fred_DTB3.json`, "utf8"));
const finite = v => v != null && Number.isFinite(Number(v));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const stdev = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const r2 = v => v == null ? null : Math.round(v * 100) / 100;

// daily cash yield lookup (T-bill, act/365, decimal)
const rfByDay = new Map(); {
  let j = 0;
  for (const r of rows) {
    while (j + 1 < dtb3.length && dtb3[j + 1].t <= r.t) j++;
    rfByDay.set(r.date, Math.max(0, dtb3[j].v) / 100 / 365);
  }
}

// ---- v2.8 candidate + acted regime (same semantics as eval3 v28) ----
const FAMS = { macro: ["liquidity", "conditions", "stress"], demand: ["etf", "stablecoins", "exchange_supply", "institutional"], cycle: ["valuation", "network", "activity", "miners", "trend"] };
const SEV = { constructive: 2, unconfirmed_positive: 1, transition: 0, deteriorating: -1, defensive: -2, insufficient: 0 };
function famScore(r, f) {
  let s = r.families[f];
  if (f === "valuation" && finite(r.families.mvrvPct)) { const p = r.families.mvrvPct; s = p >= 95 ? -2 : p >= 82 ? -1 : p <= 10 ? 1 : 0; }
  if (f === "stress" && finite(r.families.stress28)) s = r.families.stress28;
  if (f === "exchange_supply" && finite(r.families.exchange_supply28)) s = r.families.exchange_supply28;
  return finite(s) ? s : null;
}
function candidate(r) {
  if (r.regimeRelaxed === "insufficient") return "insufficient";
  const bs = {};
  for (const [b, fams] of Object.entries(FAMS)) { const a = fams.map(f => famScore(r, f)).filter(finite); bs[b] = a.length ? mean(a) / 2 * 100 : null; }
  const B = s => s == null ? "unknown" : s >= 20 ? "supportive" : s <= -20 ? "adverse" : "neutral";
  const M = B(bs.macro), D = B(bs.demand), C = B(bs.cycle);
  const adv = [M, D, C].filter(x => x === "adverse").length;
  let s = "transition";
  if (adv >= 2) s = "defensive";
  else if (D === "adverse") s = "deteriorating";
  else if (adv >= 1) s = "transition";
  else if (D === "supportive" && C === "supportive" && M !== "adverse") s = "constructive";
  else if (D === "supportive" && M === "supportive") s = "constructive";
  else if (M === "supportive" && C === "supportive" && D === "neutral") s = "unconfirmed_positive";
  const val = famScore(r, "valuation");
  if ((!finite(val) || val <= -1) && ["constructive", "unconfirmed_positive"].includes(s)) s = "transition";
  if (r.detectors.macro_shock === "fired" && ["constructive", "unconfirmed_positive", "transition"].includes(s)) s = "deteriorating";
  if (r.detectors.recovery === "good" && r.detectors.macro_shock !== "fired" && ["defensive", "deteriorating"].includes(s)) s = "transition";
  return s;
}
const acted = []; {
  let cur = null, cand = null, count = 0;
  for (const r of rows) {
    const c = candidate(r);
    if (c === cand) count++; else { cand = c; count = 1; }
    if (cur == null) cur = c;
    else if (SEV[c] < SEV[cur]) cur = c;
    else if (SEV[c] > SEV[cur] && count >= 2) cur = c;
    acted.push(cur);
  }
}

// ---- simulator: targetFn(rowIndex, prevTarget) -> share of limit; next-day execution; cash yield ----
function simulate(targetFn, { from = "2019-07-01", to = null, cost = 0.001, cash = true } = {}) {
  let equity = 1, pos = 0, peak = 1, maxDD = 0, turnover = 0, changes = 0, n = 0, prevTarget = null;
  const daily = [], stepDays = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.date < from) continue; if (to && r.date > to) break;
    let target = targetFn(i - 1, prevTarget);
    if (!finite(target)) target = prevTarget ?? 0.5;
    target = Math.max(0, Math.min(1, target));
    const ret = r.price / rows[i - 1].price - 1;
    const rf = cash ? (rfByDay.get(r.date) || 0) : 0;
    equity *= 1 + pos * ret + (1 - pos) * rf;
    if (prevTarget == null || Math.abs(target - pos) > 1e-9) {
      if (prevTarget != null && Math.abs(target - prevTarget) > 1e-9) changes++;
      equity *= 1 - cost * Math.abs(target - pos);
      turnover += Math.abs(target - pos);
    }
    pos = target; prevTarget = target;
    peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity / peak - 1);
    daily.push(pos * ret + (1 - pos) * rf); n++;
    const key = Math.round(target * 100); stepDays[key] = (stepDays[key] || 0) + 1;
  }
  const years = n / 365, vol = stdev(daily) * Math.sqrt(365) * 100;
  return { total: r1((equity - 1) * 100), cagr: r1(years > .5 ? (equity ** (1 / years) - 1) * 100 : null), vol: r1(vol), sharpe: r2(vol ? mean(daily) * 365 * 100 / vol : null), maxDD: r1(maxDD * 100), turnover: r1(turnover), changesPerYear: r1(changes / years), stepDays };
}

const USER = { constructive: 1, unconfirmed_positive: .75, transition: .55, deteriorating: .25, defensive: .10, insufficient: null }; // null => carry forward
const ladderFn = L => (i, prev) => { const t = L[acted[i]]; return t == null ? prev : t; };

const report = {};
const PERIODS = [["2019-07-01", null, "full"], ["2019-07-01", "2021-12-31", "2019-2021"], ["2022-01-01", "2022-12-31", "2022"], ["2023-01-01", "2024-12-31", "2023-2024"], ["2025-01-01", null, "2025-2026"]];

// ---- 1. user ladder vs baselines (with and without cash yield) ----
const BASE = {
  hodl: () => 1,
  userLadder: ladderFn(USER),
  faithful: ladderFn({ constructive: 1, unconfirmed_positive: .8, transition: .6, deteriorating: .5, defensive: .15, insufficient: null }),
  binaryAdverse: ladderFn({ constructive: 1, unconfirmed_positive: 1, transition: 1, deteriorating: 0, defensive: 0, insufficient: null }),
  scoreLinear: i => finite(rows[i].strategicScore) ? Math.max(0, Math.min(1, .5 + rows[i].strategicScore / 40)) : null,
};
report.baselines = {};
for (const [from, to, label] of PERIODS) {
  report.baselines[label] = {};
  for (const [name, fn] of Object.entries(BASE)) report.baselines[label][name] = simulate(fn, { from, to, cost: name === "hodl" ? 0 : 0.001 });
}
report.userNoCashYield = simulate(BASE.userLadder, { cash: false });

// ---- 2. ladder grid search (full period Sharpe + sub-period robustness) ----
const grid = [];
for (const unc of [.7, .8, .9, 1]) for (const tra of [.45, .55, .65, .75]) for (const det of [.15, .25, .35, .5]) for (const def of [0, .1, .2]) {
  const L = { constructive: 1, unconfirmed_positive: unc, transition: tra, deteriorating: det, defensive: def, insufficient: null };
  const full = simulate(ladderFn(L));
  grid.push({ unc, tra, det, def, sharpe: full.sharpe, cagr: full.cagr, maxDD: full.maxDD, total: full.total });
}
grid.sort((a, b) => b.sharpe - a.sharpe);
report.gridTop10 = grid.slice(0, 10);
report.gridUserRank = grid.findIndex(g => g.unc === .75 || g.unc === .8 ? false : false); // placeholder replaced below
{
  // user ladder exact values are not on the coarse grid (unc .75); simulate directly for rank context
  const userFull = simulate(BASE.userLadder);
  const better = grid.filter(g => g.sharpe > userFull.sharpe).length;
  report.gridUserRank = { sharpe: userFull.sharpe, cagr: userFull.cagr, maxDD: userFull.maxDD, beatenBy: better, of: grid.length };
}
// robustness of top-5: min sub-period sharpe
report.gridTop5Robust = grid.slice(0, 5).map(g => {
  const L = { constructive: 1, unconfirmed_positive: g.unc, transition: g.tra, deteriorating: g.det, defensive: g.def, insufficient: null };
  const subs = PERIODS.slice(1).map(([f, t, l]) => ({ l, s: simulate(ladderFn(L), { from: f, to: t }).sharpe }));
  return { ...g, subSharpes: subs };
});

// ---- 3. overlays on the user ladder ----
function overlayFn(base, mods) {
  return (i, prev) => {
    let t = base[acted[i]]; if (t == null) t = prev ?? .5;
    const r = rows[i];
    if (mods.recovBoost && r.detectors.recovery === "good") t = Math.max(t, mods.recovBoost);
    if (mods.cheapFloor && finite(r.families.mvrvPct) && r.families.mvrvPct <= 10) t = Math.max(t, mods.cheapFloor);
    if (mods.cheap25Floor && finite(r.families.mvrvPct) && r.families.mvrvPct <= 25) t = Math.max(t, mods.cheap25Floor);
    if (mods.rvCut && finite(r.families.realized_vol) && r.families.realized_vol <= -1) t = Math.min(t, mods.rvCut);
    if (mods.expCap && finite(r.families.mvrvPct) && r.families.mvrvPct >= 95) t = Math.min(t, mods.expCap);
    return t;
  };
}
report.overlays = {};
const OV = {
  "recovBoost.70": { recovBoost: .70 },
  "cheapFloor.40": { cheapFloor: .40 },
  "cheap25Floor.30": { cheap25Floor: .30 },
  "rvCut.50": { rvCut: .50 },
  "expCap.60": { expCap: .60 },
  "recov+cheap": { recovBoost: .70, cheapFloor: .40 },
  "recov+cheap+expCap": { recovBoost: .70, cheapFloor: .40, expCap: .60 },
};
for (const [name, mods] of Object.entries(OV)) {
  const fn = overlayFn(USER, mods);
  report.overlays[name] = { full: simulate(fn) };
  for (const [f, t, l] of PERIODS.slice(1)) report.overlays[name][l] = simulate(fn, { from: f, to: t }).total;
}

// ---- 4. step dynamics of the user ladder ----
{
  const sim = simulate(BASE.userLadder);
  report.userStepDays = sim.stepDays; report.userChangesPerYear = sim.changesPerYear;
  // multi-step jumps in the acted sequence (does the regime ever skip a step day-over-day?)
  const stepOf = { constructive: 5, unconfirmed_positive: 4, transition: 3, deteriorating: 2, defensive: 1, insufficient: null };
  let multi = 0, moves = 0, prevStep = null;
  for (let i = 0; i < acted.length; i++) {
    if (rows[i].date < "2019-07-01") continue;
    const s = stepOf[acted[i]]; if (s == null) continue;
    if (prevStep != null && s !== prevStep) { moves++; if (Math.abs(s - prevStep) > 1) multi++; }
    prevStep = s;
  }
  report.userStepMoves = { moves, multiStepJumps: multi };
}
console.log(JSON.stringify(report, null, 1));
