/*
  Full-depth (2013-2026) strategy-strip evaluation.
  Regime = v2.8 gate tree over walk-forward family scores; era-aware insufficiency
  (families that did not exist as products are excluded from expected coverage).
  Tests: deployed ladder+overlays vs original vs alternatives; grid re-optimization on the
  full depth AND per era bucket; overlay contribution across all cycle bottoms/tops.
  Cash earns DTB3; execution next day; costs 10 bp.
*/
import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DATA = new URL("./data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const rows = JSON.parse(readFileSync(`${OUT}timeline.json`, "utf8"));
const dtb3 = JSON.parse(readFileSync(`${DATA}fred_DTB3.json`, "utf8"));
const finite = v => v != null && Number.isFinite(Number(v));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const stdev = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const r2 = v => v == null ? null : Math.round(v * 100) / 100;

const rfByDay = new Map(); {
  let j = 0;
  for (const r of rows) { while (j + 1 < dtb3.length && dtb3[j + 1].t <= r.t) j++; rfByDay.set(r.date, Math.max(0, dtb3[j].v) / 100 / 365); }
}

// ---- v2.8 candidate over full depth, era-aware insufficiency ----
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
  if (r.insufficientEra) return "insufficient";
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

function simulate(targetFn, { from = "2013-01-01", to = null, cost = 0.001 } = {}) {
  let equity = 1, pos = 0, peak = 1, maxDD = 0, changes = 0, n = 0, prevTarget = null;
  const daily = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.date < from) continue; if (to && r.date > to) break;
    let target = targetFn(i - 1, prevTarget);
    if (!finite(target)) target = prevTarget ?? 0.5;
    target = Math.max(0, Math.min(1, target));
    const ret = r.price / rows[i - 1].price - 1, rf = rfByDay.get(r.date) || 0;
    equity *= 1 + pos * ret + (1 - pos) * rf;
    if (prevTarget == null || Math.abs(target - pos) > 1e-9) {
      if (prevTarget != null && Math.abs(target - prevTarget) > 1e-9) changes++;
      equity *= 1 - cost * Math.abs(target - pos);
    }
    pos = target; prevTarget = target;
    peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity / peak - 1);
    daily.push(pos * ret + (1 - pos) * rf); n++;
  }
  const years = n / 365, vol = stdev(daily) * Math.sqrt(365) * 100;
  return { total: r1((equity - 1) * 100), cagr: r1(years > .5 ? (equity ** (1 / years) - 1) * 100 : null), vol: r1(vol), sharpe: r2(vol ? mean(daily) * 365 * 100 / vol : null), maxDD: r1(maxDD * 100), changesPerYear: r1(changes / years) };
}
function mk(L, mods = {}) {
  return (i, prev) => {
    const st = acted[i];
    let t = L[st]; if (t == null) t = prev ?? .5;
    if (st !== "insufficient" && st !== "emergency") {
      const r = rows[i];
      if (mods.recovBoost && r.detectors.recovery === "good") t = Math.max(t, mods.recovBoost);
      if (mods.cheapFloor && finite(r.families.mvrvPct) && r.families.mvrvPct <= 10) t = Math.max(t, mods.cheapFloor);
      if (mods.expCap && finite(r.families.mvrvPct) && r.families.mvrvPct >= 95) t = Math.min(t, mods.expCap);
    }
    return t;
  };
}

const ORIG = { constructive: 1, unconfirmed_positive: .75, transition: .55, deteriorating: .25, defensive: .10, insufficient: null };
const DEPLOYED = { constructive: 1, unconfirmed_positive: .9, transition: .55, deteriorating: .20, defensive: .10, insufficient: null };
const OVER = { recovBoost: .7, cheapFloor: .4, expCap: .6 };
const PERIODS = [
  ["2013-01-01", null, "full 2013-2026"],
  ["2013-01-01", "2016-12-31", "2013-2016"],
  ["2017-01-01", "2018-12-31", "2017-2018"],
  ["2019-01-01", "2021-12-31", "2019-2021"],
  ["2022-01-01", "2022-12-31", "2022"],
  ["2023-01-01", "2024-12-31", "2023-2024"],
  ["2025-01-01", null, "2025-2026"],
];

const report = { regimeDays: {}, variants: {}, grid: {}, overlays: {} };

// regime day counts + fwd90 across full depth
{
  const stats = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; if (r.date < "2013-01-01") continue;
    const reg = candidate(r), j = i + 90;
    (stats[reg] ??= { n: 0, f: [] }); stats[reg].n++;
    if (j < rows.length) stats[reg].f.push((rows[j].price / r.price - 1) * 100);
  }
  report.regimeDays = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { days: v.n, fwd90: r1(mean(v.f)), hit: r2(v.f.filter(x => x > 0).length / (v.f.length || 1)) }]));
}

// main variants across all periods
const VARIANTS = {
  hodl: () => 1,
  origNoOvl: mk(ORIG),
  origOvl: mk(ORIG, OVER),
  deployed: mk(DEPLOYED, OVER),
  deployedNoOvl: mk(DEPLOYED),
};
for (const [name, fn] of Object.entries(VARIANTS)) {
  report.variants[name] = {};
  for (const [f, t, l] of PERIODS) report.variants[name][l] = simulate(fn, { from: f, to: t, cost: name === "hodl" ? 0 : .001 });
}

// grid re-optimization on FULL depth + per-era rank consistency
const grid = [];
for (const unc of [.7, .8, .9, 1]) for (const tra of [.45, .55, .65, .75]) for (const det of [.1, .2, .3, .5]) for (const def of [0, .1, .2]) {
  const L = { constructive: 1, unconfirmed_positive: unc, transition: tra, deteriorating: det, defensive: def, insufficient: null };
  const fn = mk(L, OVER);
  const full = simulate(fn);
  const eras = PERIODS.slice(1).map(([f, t, l]) => ({ l, sharpe: simulate(fn, { from: f, to: t }).sharpe }));
  const minEra = Math.min(...eras.map(e => e.sharpe ?? -9));
  grid.push({ unc, tra, det, def, sharpe: full.sharpe, cagr: full.cagr, maxDD: full.maxDD, minEraSharpe: r2(minEra) });
}
grid.sort((a, b) => b.sharpe - a.sharpe);
report.grid.topBySharpe = grid.slice(0, 8);
const robust = [...grid].sort((a, b) => b.minEraSharpe - a.minEraSharpe || b.sharpe - a.sharpe);
report.grid.topByRobustness = robust.slice(0, 8);
{
  const dep = simulate(mk(DEPLOYED, OVER));
  report.grid.deployedRank = { sharpe: dep.sharpe, beatenBy: grid.filter(g => g.sharpe > dep.sharpe).length, of: grid.length };
}

// overlay contribution decomposition on full depth (deployed ladder)
for (const [name, mods] of Object.entries({ none: {}, recov: { recovBoost: .7 }, cheap: { cheapFloor: .4 }, cap: { expCap: .6 }, all: OVER, "cheap50": { cheapFloor: .5 }, "cheap30": { cheapFloor: .3 }, "recov60": { recovBoost: .6 }, "recov80": { recovBoost: .8 }, "cap50": { expCap: .5 }, "cap75": { expCap: .75 } })) {
  const fn = mk(DEPLOYED, mods);
  const full = simulate(fn);
  report.overlays[name] = { full: { total: full.total, sharpe: full.sharpe, maxDD: full.maxDD } };
  for (const [f, t, l] of PERIODS.slice(1)) report.overlays[name][l] = simulate(fn, { from: f, to: t }).total;
}

// expCap binding days across history (does the euphoria cap finally engage pre-2019?)
{
  let capDays = 0, capEpisodes = [];
  let inEp = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; if (r.date < "2013-01-01") continue;
    const st = acted[i];
    const t0 = { constructive: 1, unconfirmed_positive: .9, transition: .55, deteriorating: .2, defensive: .1 }[st];
    const binds = t0 != null && finite(r.families.mvrvPct) && r.families.mvrvPct >= 95 && t0 > .6 && st !== "insufficient" && st !== "emergency";
    if (binds) { capDays++; if (!inEp) { capEpisodes.push(r.date); inEp = true; } } else inEp = false;
  }
  report.expCapBinding = { days: capDays, episodes: capEpisodes.slice(0, 12) };
}
// cheap floor binding episodes
{
  let days = 0; const eps = []; let inEp = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; if (r.date < "2013-01-01") continue;
    const st = acted[i];
    const t0 = { constructive: 1, unconfirmed_positive: .9, transition: .55, deteriorating: .2, defensive: .1 }[st];
    const binds = t0 != null && t0 < .4 && finite(r.families.mvrvPct) && r.families.mvrvPct <= 10;
    if (binds) { days++; if (!inEp) { eps.push(r.date); inEp = true; } } else inEp = false;
  }
  report.cheapFloorBinding = { days, episodes: eps.slice(0, 12) };
}
writeFileSync(`${OUT}strategy-deep.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.regimeDays));
console.log("deployedRank:", JSON.stringify(report.grid.deployedRank));
