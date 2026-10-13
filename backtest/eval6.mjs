/*
  Аудит 2026-10-10: согласованная оценка замороженной политики v1 и обоснование теневого кандидата v3.

  Зачем отдельный файл. В eval.mjs … eval5.mjs капитал считается с задержкой исполнения в один день
  (цель, решённая по закрытию i−1, начинает зарабатывать с дня i+1), а ряд для волатильности и Sharpe
  строится уже с НОВОЙ позицией, то есть без задержки. Доходность/просадка и Sharpe в их отчётах поэтому
  описывают две разные стратегии. Архив заморожен (POLICY.md) и не правится; здесь — один ряд на всё:
  и капитал, и Sharpe считаются по доходности позиции, которая реально стояла, за вычетом издержек и
  сверх кэша (определение Sharpe из POLICY.md).

  Что считает: (1) v1 против простых правил по окнам; (2) чувствительность к задержке исполнения;
  (3) частоты режимов и длительность их жизни; (4) эпизоды recovery-пола и чем они заканчивались;
  (5) политика без одной семьи; (6) варианты теневого кандидата v3; (7) база детекторов;
  (8) информативность блоков по эпохам. Всё — на той же реконструкции (out/timeline.json), на которой
  политика калибровалась: числа описывают, а не доказывают. Живой контур этот файл не читает.

  Запуск: node backtest/eval6.mjs  →  out/audit-2026-10-10.json
*/
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DATA = new URL("./data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const load = name => JSON.parse(readFileSync(`${DATA}${name}.json`, "utf8"));
const rows = JSON.parse(readFileSync(`${OUT}timeline.json`, "utf8"));
const dtb3 = load("fred_DTB3"), cm = load("coinmetrics"), cmDeep = load("coinmetrics_deep"), hashRaw = load("bc_hashrate");

const DAY = 86_400_000;
const finite = v => v != null && Number.isFinite(Number(v));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const stdev = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = v => v == null ? null : Math.round(v * 10) / 10, r2 = v => v == null ? null : Math.round(v * 100) / 100;
const idxAtOrBefore = (s, t) => { let lo = 0, hi = s.length - 1, f = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].t <= t) { f = m; lo = m + 1; } else hi = m - 1; } return f; };
const percentileRank = (values, value) => { if (values.length < 30 || !finite(value)) return null; let less = 0, equal = 0; for (const x of values) { if (x < value) less++; else if (x === value) equal++; } return (less + 0.5 * equal) / values.length * 100; };
const lowGood = p => !finite(p) ? null : p <= 10 ? 2 : p <= 35 ? 1 : p <= 65 ? 0 : p <= 90 ? -1 : -2;
const componentScore = parts => { const a = parts.filter(finite).map(Number); if (!a.length) return null; const s = clamp(Math.round(mean(a) * 2) / 2, -2, 2); return a.length * 2 <= parts.length && s > 0 ? 0 : s; };

// Доходность кэша по дням (DTB3, годовые проценты).
const rf = []; { let j = 0; for (const r of rows) { while (j + 1 < dtb3.length && dtb3[j + 1].t <= r.t) j++; rf.push(Math.max(0, dtb3[j].v) / 100 / 365); } }

// ---- ряды для вариантов кандидата v3 --------------------------------------------------------
// Биржи по остатку: изменение SplyExNtv за 7 дней вместо FlowIn−FlowOut (с мая 2026 потоки и остаток
// Coin Metrics расходятся каждый день в одну сторону).
const sply = cm.SplyExNtv.filter(p => finite(p.v)).sort((a, b) => a.t - b.t);
const supply7 = []; for (let i = 0; i < sply.length; i++) { const j = idxAtOrBefore(sply, sply[i].t - 7 * DAY); if (j >= 0 && sply[i].t - sply[j].t <= 9 * DAY) supply7.push({ t: sply[i].t, v: sply[i].v - sply[j].v }); }
// Вся история MVRV — «глубокое окно».
const mvrvDeep = cmDeep.CapMVRVCur.filter(p => finite(p.v)).sort((a, b) => a.t - b.t);
// Хешрейт: 30-дневное среднее вместо однодневной оценки (шум одной точки ≈ 8 %).
const hash = hashRaw.map(p => ({ t: Number(p.t), v: Number(p.v) })).filter(p => finite(p.t) && p.v > 0).sort((a, b) => a.t - b.t);
const hash30 = []; { let s = 0; const q = []; for (const p of hash) { q.push(p); s += p.v; while (q.length && q[0].t <= p.t - 30 * DAY) s -= q.shift().v; hash30.push({ t: p.t, v: s / q.length, n: q.length }); } }
const hashLeg = v => !finite(v) ? null : v > -5 ? 0 : v > -15 ? -1 : -2;

const extra = rows.map(r => {
  const o = { exchange: null, network: null, deep: null };
  const i = idxAtOrBefore(supply7, r.t);
  if (i >= 0 && r.t - supply7[i].t <= 4 * DAY) {
    const nf7 = supply7[i].v, p = percentileRank(supply7.slice(Math.max(0, i - 1459), i + 1).map(x => x.v), nf7);
    const flowLeg = finite(p) ? (nf7 > 0 ? Math.min(lowGood(p), 0) : lowGood(p)) : null;
    const res90 = r.raw?.res90, rp = r.raw?.res90Pct, reserveLeg = finite(rp) ? (finite(res90) && res90 > 0 ? Math.min(lowGood(rp), 0) : lowGood(rp)) : null;
    o.exchange = componentScore([flowLeg, reserveLeg]);
  }
  const a = idxAtOrBefore(hash30, r.t), b = idxAtOrBefore(hash30, r.t - 90 * DAY);
  const h90 = a >= 0 && b >= 0 && r.t - hash30[a].t <= 4 * DAY && hash30[a].n >= 20 && hash30[b].n >= 20 ? (hash30[a].v / hash30[b].v - 1) * 100 : null;
  const legs = [hashLeg(h90), hashLeg(r.raw?.d90)].filter(finite);
  o.network = legs.length ? clamp(Math.round(mean(legs) * 2) / 2, -2, 2) : null;
  const k = idxAtOrBefore(mvrvDeep, r.t);
  o.deep = k >= 1999 && r.t - mvrvDeep[k].t <= 5 * DAY ? percentileRank(mvrvDeep.slice(0, k + 1).map(x => x.v), mvrvDeep[k].v) : null;
  return o;
});

// ---- порт замороженного гейта v1 с переключателями вариантов ---------------------------------
const SEV = { constructive: 2, unconfirmed_positive: 1, transition: 0, deteriorating: -1, defensive: -2, insufficient: 0 };
const LADDER = { defensive: 5, deteriorating: 20, transition: 45, unconfirmed_positive: 95, constructive: 100 };
const FAMILIES = { macro: ["liquidity", "conditions", "stress"], demand: ["etf", "stablecoins", "exchange_supply", "institutional"], cycle: ["valuation", "network", "activity", "miners", "trend"] };
const band = s => s == null ? "unknown" : s >= 20 ? "supportive" : s <= -20 ? "adverse" : "neutral";

function familyScore(r, i, f, o) {
  if (o.drop?.includes(f)) return null;
  // macroLag — на сколько дней макровходы старше остальных. На бою дневные ряды FRED за день D выходят
  // днём D+1 после 13:30 UTC, то есть ПОСЛЕ суточного фикса 06:00 UTC: фикс читает макро за D−1.
  // Здесь, на дневной сетке, это цена одного возраста входов; вместе со временем исполнения — eval7.mjs.
  // lagBy — то же по семьям: { stress: 0, conditions: 1, liquidity: 1 } для фикса после публикации спредов и VIX.
  const lagDays = o.lagBy?.[f] ?? (o.macroLag && FAMILIES.macro.includes(f) ? o.macroLag : 0);
  if (lagDays) { const j = i - lagDays; if (j < 0 || rows[j].insufficientEra) return null; r = rows[j]; i = j; }
  if (f === "network" && o.networkV3 && finite(extra[i].network)) return extra[i].network;
  if (f === "exchange_supply") { if (o.exchangeV3 && finite(extra[i].exchange)) return extra[i].exchange; return finite(r.families.exchange_supply28) ? r.families.exchange_supply28 : r.families.exchange_supply ?? null; }
  if (f === "stress") return finite(r.families.stress28) ? r.families.stress28 : r.families.stress ?? null;
  if (f === "valuation") {
    const p = r.families.mvrvPct; if (!finite(p)) return null;
    const cheap = p <= 10 && (!o.twoWindows || extra[i].deep == null || extra[i].deep <= 10);
    return p >= 95 ? -2 : p >= 82 ? -1 : cheap ? 1 : 0;
  }
  const s = r.families[f]; return finite(s) ? s : null;
}

function build(o = {}) {
  const candidate = [], facts = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.insufficientEra) { candidate.push("insufficient"); facts.push(null); continue; }
    // Исключённая семья (drop) не голосует в блоке, но остаётся ногой детекторов и гейта оценки: вопрос
    // «что даёт голос семьи», а не «что будет, если данных нет вовсе».
    const vote = f => familyScore(r, i, f, o), g = f => familyScore(r, i, f, { ...o, drop: [] }), block = fs => { const a = fs.map(vote).filter(finite); return a.length ? mean(a) / 2 * 100 : null; };
    const scores = { macro: block(FAMILIES.macro), demand: block(FAMILIES.demand), cycle: block(FAMILIES.cycle) };
    const M = band(scores.macro), D = band(scores.demand), C = band(scores.cycle), adverse = [M, D, C].filter(x => x === "adverse").length;
    let s = "transition";
    if (adverse >= 2) s = "defensive"; else if (D === "adverse") s = "deteriorating"; else if (adverse >= 1) s = "transition";
    else if (D === "supportive" && C === "supportive" && M !== "adverse") s = "constructive"; else if (D === "supportive" && M === "supportive") s = "constructive";
    else if (M === "supportive" && C === "supportive" && D === "neutral") s = "unconfirmed_positive";
    const val = g("valuation"); if ((!finite(val) || val <= -1) && ["constructive", "unconfirmed_positive"].includes(s)) s = "transition";
    const le = (f, x) => finite(g(f)) && g(f) <= x;
    const shock = [le("liquidity", -1), le("conditions", -1), le("stress", -1)].filter(Boolean).length >= 3;
    const p = r.families.mvrvPct, anchor = finite(p) && p < 25 && (!o.twoWindows || extra[i].deep == null || extra[i].deep < 25);
    const legs = [g("trend"), g("etf"), g("exchange_supply")], support = legs.filter(v => finite(v) && v >= 0).length, positive = legs.filter(v => finite(v) && v > 0).length;
    const good = anchor && support >= 2 && (!o.onePositive || positive >= 1);
    const distribution = !o.noDeadRules && le("valuation", -1) && le("exchange_supply", -1) && le("trend", -1);
    const optimistic = ["constructive", "unconfirmed_positive", "transition"];
    if (shock && optimistic.includes(s)) s = "deteriorating";
    if (distribution && optimistic.includes(s)) s = "deteriorating";
    if (good && !shock && ["defensive", "deteriorating"].includes(s)) s = "transition";
    candidate.push(s); facts.push({ shock, anchor, support, good, p, deep: extra[i].deep, scores, bands: { M, D, C }, distribution });
  }
  // Гистерезис архива на дневной сетке: понижение сразу, повышение — на втором закрытии подряд.
  const state = []; { let cur = null, cd = null, n = 0; for (const s of candidate) { if (s === cd) n++; else { cd = s; n = 1; } if (cur == null) cur = s; else if (SEV[s] < SEV[cur]) cur = s; else if (SEV[s] > SEV[cur] && n >= 2) cur = s; state.push(cur); } }
  // Оверлеи. floor: "v1" — 80 % сразу, пока детектор good; "graduated" — 40/60/80 по закрытиям подряд;
  // carry — удержание после ухода якоря, пока подтверждений не меньше двух.
  const target = []; let closes = 0, active = false;
  for (let i = 0; i < rows.length; i++) {
    const st = state[i], d = facts[i];
    if (st === "insufficient" || !d) { target.push(null); closes = 0; active = false; continue; }
    let t = LADDER[st], floor = null;
    const live = d.good && !d.shock;
    if ((o.floor ?? "v1") === "v1" && !o.carry) { if (live) floor = 80; }
    else {
      const carry = !live && active && !d.anchor && d.support >= 2 && !d.shock && o.carry === true;
      if (live || carry) { closes = Math.min(3, closes + 1); active = true; } else { closes = 0; active = false; }
      if (active) floor = o.floor === "graduated" ? [40, 60, 80][closes - 1] : 80;
    }
    if (floor != null && t < floor) t = floor;
    const cheap = finite(d.p) && d.p <= 10 && (!o.twoWindows || d.deep == null || d.deep <= 10);
    if (cheap && t < 40) t = 40;
    if (!o.noDeadRules && finite(d.p) && d.p >= 95 && t > 60) t = 60;
    target.push(t);
  }
  return { candidate, state, target, facts };
}

// ---- согласованная симуляция: один ряд и для капитала, и для Sharpe ---------------------------
// lag — сколько полных дней проходит между закрытием, по которому принято решение, и днём, с которого
// новая позиция зарабатывает (0 — сделка по тому же закрытию, 1 — на следующем).
function simulate(targetFn, { from = "2013-01-01", to = null, lag = 1, cost = 0.001 } = {}) {
  let equity = 1, pos = null, peak = 1, maxDD = 0, n = 0, turnover = 0, changes = 0; const excess = [], exposure = [];
  for (let i = 1 + lag; i < rows.length; i++) {
    if (rows[i].date < from) continue; if (to && rows[i].date > to) break;
    let t = targetFn(i - 1 - lag); if (!finite(t)) t = pos == null ? 50 : pos * 100;
    const w = clamp(t / 100, 0, 1), ret = rows[i].price / rows[i - 1].price - 1;
    let r = w * ret + (1 - w) * rf[i];
    if (pos != null && Math.abs(w - pos) > 1e-9) { r -= cost * Math.abs(w - pos); turnover += Math.abs(w - pos); changes++; }
    pos = w; equity *= 1 + r; peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity / peak - 1);
    excess.push(r - rf[i]); exposure.push(w); n++;
  }
  const years = n / 365, vol = stdev(excess) * Math.sqrt(365) * 100;
  return { cagr: r1((equity ** (1 / years) - 1) * 100), vol: r1(vol), sharpe: r2(mean(excess) * 365 * 100 / vol), maxDD: r1(maxDD * 100), avgExposure: r1(mean(exposure) * 100), turnoverPerYear: r1(turnover / years * 100), changesPerYear: r1(changes / years) };
}
// Метод архива (для сверки расхождения): капитал с задержкой, Sharpe без неё.
function simulateArchiveStyle(target, from) {
  let equity = 1, pos = 0, n = 0; const daily = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].date < from) continue;
    let t = target[i - 1]; if (!finite(t)) t = pos * 100; t /= 100;
    const ret = rows[i].price / rows[i - 1].price - 1;
    equity *= 1 + pos * ret + (1 - pos) * rf[i];
    if (Math.abs(t - pos) > 1e-9) equity *= 1 - 0.001 * Math.abs(t - pos);
    pos = t; daily.push(pos * ret + (1 - pos) * rf[i] - rf[i]); n++;
  }
  const years = n / 365, vol = stdev(daily) * Math.sqrt(365) * 100;
  return { cagr: r1((equity ** (1 / years) - 1) * 100), sharpe: r2(mean(daily) * 365 * 100 / vol) };
}

const closes = rows.map(r => r.price);
const sma = (i, n) => i >= n - 1 ? mean(closes.slice(i - n + 1, i + 1)) : null;
const vol60 = i => { if (i < 60) return null; const r = []; for (let k = i - 59; k <= i; k++) r.push(Math.log(closes[k] / closes[k - 1])); return stdev(r) * Math.sqrt(365) * 100; };
const trendVol25 = i => { const s = sma(i, 200), v = vol60(i); return s != null && v != null && closes[i] >= s ? clamp(25 / v * 100, 0, 100) : 0; };

// Набор переключателей кандидата v3 (раздел 6) — общий с eval7.mjs.
const V3 = { noDeadRules: true, drop: ["institutional"], networkV3: true, exchangeV3: true, twoWindows: true, floor: "graduated" };

// Всё ниже — отчёт; при импорте из eval7.mjs он не строится.
const DIRECT = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (DIRECT) {
const WINDOWS = [["2013-01-01", null, "2013-01…2026-07"], ["2018-06-01", null, "2018-06…2026-07"], ["2022-01-01", "2022-12-31", "2022"], ["2023-01-01", "2024-12-31", "2023–2024"], ["2024-03-01", null, "эра ETF 2024-03…2026-07"], ["2025-01-01", null, "2025…2026-07"]];
const report = { generated_for: "audit 2026-10-10", method: "единый ряд доходности для капитала и Sharpe; Sharpe сверх кэша; издержки 10 б.п. на полный оборот", windows: {} };
const v1 = build();

// (1) v1 против простых правил
for (const [from, to, label] of WINDOWS) {
  report.windows[label] = {
    policy_v1: simulate(i => v1.target[i], { from, to }), buy_and_hold: simulate(() => 100, { from, to }),
    constant_35: simulate(() => 35, { from, to }), trend_vol_25: simulate(trendVol25, { from, to }),
  };
}
// (2) задержка исполнения и сверка с методом архива
report.execution_lag = {}; for (const from of ["2013-01-01", "2018-06-01", "2024-03-01"]) report.execution_lag[from] = Object.fromEntries([0, 1, 2, 3, 5, 10].map(lag => [`${lag}d`, simulate(i => v1.target[i], { from, lag })]));
report.archive_method_vs_consistent = Object.fromEntries(["2013-01-01", "2018-06-01"].map(from => [from, { archive: simulateArchiveStyle(v1.target, from), consistent: (({ cagr, sharpe }) => ({ cagr, sharpe }))(simulate(i => v1.target[i], { from })) }]));
// (3) частоты режимов, цель, длительность
function regimeStats(from) {
  const count = {}, targets = [], runs = []; let run = 0, prev = null;
  for (let i = 0; i < rows.length; i++) { if (rows[i].date < from) continue; const s = v1.state[i]; count[s] = (count[s] || 0) + 1; if (finite(v1.target[i])) targets.push(v1.target[i]); if (s === prev) run++; else { if (prev != null) runs.push(run); run = 1; prev = s; } }
  runs.push(run); const n = Object.values(count).reduce((a, b) => a + b, 0);
  return { share_pct: Object.fromEntries(Object.entries(count).map(([k, v]) => [k, r1(v / n * 100)])), avg_target_pct: r1(mean(targets)), share_target_ge95_pct: r1(targets.filter(x => x >= 95).length / targets.length * 100), share_target_le20_pct: r1(targets.filter(x => x <= 20).length / targets.length * 100), regime_run_days: { median: median(runs), mean: r1(mean(runs)), share_runs_le3d_pct: r1(runs.filter(x => x <= 3).length / runs.length * 100) }, regime_changes_per_year: r1(runs.length / (n / 365)) };
}
report.regimes = { "2018-06+": regimeStats("2018-06-01"), "эра ETF 2024-03+": regimeStats("2024-03-01") };
// (4) эпизоды recovery-пола
{
  const episodes = []; let start = null;
  for (let i = rows.findIndex(r => r.date >= "2013-01-01"); i < rows.length; i++) {
    const d = v1.facts[i], on = !!d && d.good && !d.shock;
    if (on && start == null) start = i;
    if (!on && start != null) {
      const reason = !d ? "n/a" : d.shock ? "macro_shock" : !d.anchor ? "valuation_recovered" : "support_lost", fw = h => i + h < rows.length ? (rows[i + h].price / rows[i].price - 1) * 100 : null;
      episodes.push({ in: rows[start].date, out: rows[i].date, days: i - start, btc_pct: r1((rows[i].price / rows[start].price - 1) * 100), reason, target_after: v1.target[i], fwd30: r1(fw(30)), fwd90: r1(fw(90)) }); start = null;
    }
  }
  const by = {}; for (const e of episodes) { const o = (by[e.reason] ??= { episodes: 0, btc: [], fwd30: [], fwd90: [], after: [] }); o.episodes++; o.btc.push(e.btc_pct); if (e.fwd30 != null) o.fwd30.push(e.fwd30); if (e.fwd90 != null) o.fwd90.push(e.fwd90); if (e.target_after != null) o.after.push(e.target_after); }
  report.recovery_floor = { episodes: episodes.length, by_exit: Object.fromEntries(Object.entries(by).map(([k, o]) => [k, { episodes: o.episodes, mean_btc_during_pct: r1(mean(o.btc)), mean_fwd30_after_exit_pct: r1(mean(o.fwd30)), mean_fwd90_after_exit_pct: r1(mean(o.fwd90)), mean_target_after_exit_pct: r1(mean(o.after)) }])), list: episodes };
}
// (5) политика без одной семьи
report.leave_one_family_out = {};
for (const f of [null, "institutional", "network", "stablecoins", "exchange_supply", "etf", "activity", "miners", "trend", "liquidity", "conditions", "stress"]) {
  const b = build(f ? { drop: [f] } : {});
  report.leave_one_family_out[f ?? "все семьи (v1)"] = { "2018-06+": simulate(i => b.target[i], { from: "2018-06-01" }), "эра ETF": simulate(i => b.target[i], { from: "2024-03-01" }), "2013+": simulate(i => b.target[i], { from: "2013-01-01" }) };
}
// (6) варианты кандидата v3
const VARIANTS = [
  ["v1 как есть", {}], ["без CFTC", { drop: ["institutional"] }], ["сеть по 30-дневным средним", { networkV3: true }], ["биржи по остатку", { exchangeV3: true }],
  ["оценка: согласие двух окон", { twoWindows: true }], ["без правил, которые не могут сработать", { noDeadRules: true }], ["пол 40/60/80 по закрытиям", { floor: "graduated" }],
  ["пол 40/60/80 + удержание после ухода якоря", { floor: "graduated", carry: true }], ["пол 40/60/80 + хотя бы одна нога > 0", { floor: "graduated", onePositive: true }],
  ["кандидат v3 целиком", V3], ["v3 + удержание после ухода якоря", { ...V3, carry: true }],
  ["v3, макровходы на день старше", { ...V3, macroLag: 1 }], ["v3, макровходы на три дня старше", { ...V3, macroLag: 3 }],
  ["v1, макровходы на день старше", { macroLag: 1 }],
];
report.v3_variants = {};
for (const [name, o] of VARIANTS) { const b = build(o); report.v3_variants[name] = Object.fromEntries(WINDOWS.map(([from, to, label]) => [label, simulate(i => b.target[i], { from, to })])); }
// (7) база детекторов
{
  const stat = (pred, from) => { let days = 0; const starts = [], f30 = [], f90 = []; let prev = false; for (let i = 0; i < rows.length; i++) { if (rows[i].date < from) { prev = false; continue; } const on = !!pred(i); if (on) { days++; if (!prev) starts.push(rows[i].t); if (i + 30 < rows.length) f30.push(rows[i + 30].price / rows[i].price - 1); if (i + 90 < rows.length) f90.push(rows[i + 90].price / rows[i].price - 1); } prev = on; } let clusters = 0, last = -1e18; for (const t of starts) if (t - last >= 90 * DAY) { clusters++; last = t; } return { days, episodes: starts.length, clusters_90d_apart: clusters, mean_fwd30_pct: r1(mean(f30) * 100), mean_fwd90_pct: r1(mean(f90) * 100), first: starts.length ? new Date(starts[0]).toISOString().slice(0, 10) : null, last: starts.length ? new Date(starts.at(-1)).toISOString().slice(0, 10) : null }; };
  report.detectors = {
    macro_shock_fired_2019plus: stat(i => v1.facts[i]?.shock, "2019-01-01"), recovery_good_2019plus: stat(i => v1.facts[i]?.good && !v1.facts[i]?.shock, "2019-01-01"), recovery_good_2013plus: stat(i => v1.facts[i]?.good && !v1.facts[i]?.shock, "2013-01-01"),
    distribution_fired_2013plus: stat(i => v1.facts[i]?.distribution, "2013-01-01"),
    distribution_anchor_days_2013plus: rows.filter((r, i) => r.date >= "2013-01-01" && finite(r.families.mvrvPct) && r.families.mvrvPct >= 82).length,
    distribution_anchor_with_trend_le_minus1: rows.filter(r => r.date >= "2013-01-01" && finite(r.families.mvrvPct) && r.families.mvrvPct >= 82 && r.families.trend <= -1).length,
  };
}
// (8) информативность блоков: ранговая корреляция балла блока с доходностью BTC за 90 дней
{
  const spearman = (x, y) => { const n = x.length; if (n < 30) return null; const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Array(n); let i = 0; while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; }; const rx = rank(x), ry = rank(y), mx = mean(rx), my = mean(ry); let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; } return num / Math.sqrt(dx * dy); };
  report.block_rank_correlation_fwd90 = {};
  for (const [from, to, label] of [["2018-06-01", "2024-02-29", "2018-06…2024-02"], ["2024-03-01", "2026-07-14", "эра ETF"]]) {
    const o = {}; for (const b of ["macro", "demand", "cycle"]) { const x = [], y = []; for (let i = 0; i + 90 < rows.length; i++) { if (rows[i].date < from || rows[i].date > to || !v1.facts[i]) continue; const s = v1.facts[i].scores[b]; if (finite(s)) { x.push(s); y.push(rows[i + 90].price / rows[i].price - 1); } } o[b] = { rho: r2(spearman(x, y)), days: x.length, nonoverlapping_windows: Math.floor(x.length / 90) }; }
    report.block_rank_correlation_fwd90[label] = o;
  }
}

writeFileSync(`${OUT}audit-2026-10-10.json`, JSON.stringify(report, null, 1));
const line = s => `${String(s.cagr).padStart(6)} ${String(s.sharpe).padStart(5)} ${String(s.maxDD).padStart(6)}`;
console.log("Доходность годовых / Sharpe сверх кэша / макс. просадка; исполнение на следующий день\n");
for (const [label, w] of Object.entries(report.windows)) console.log(label.padEnd(26), Object.entries(w).map(([k, s]) => `${k}: ${line(s)}`).join("  |  "));
console.log("\nЗадержка исполнения, v1 с 06.2018:", Object.entries(report.execution_lag["2018-06-01"]).map(([k, s]) => `${k} ${s.cagr}/${s.sharpe}`).join("  "));
console.log("Метод архива против согласованного:", JSON.stringify(report.archive_method_vs_consistent));
console.log("\nВарианты кандидата v3 (2013+ | 2018-06+ | эра ETF):");
for (const [name, w] of Object.entries(report.v3_variants)) console.log("  " + name.padEnd(44), line(w["2013-01…2026-07"]), "|", line(w["2018-06…2026-07"]), "|", line(w["эра ETF 2024-03…2026-07"]));
console.log("\nБез одной семьи (2018-06+ | эра ETF):");
for (const [name, w] of Object.entries(report.leave_one_family_out)) console.log("  " + name.padEnd(20), line(w["2018-06+"]), "|", line(w["эра ETF"]));
console.log("\nRecovery-пол:", JSON.stringify(report.recovery_floor.by_exit));
console.log("Детекторы:", JSON.stringify(report.detectors));
console.log("Режимы:", JSON.stringify(report.regimes));
console.log("Блоки, ранговая корреляция с доходностью за 90 дней:", JSON.stringify(report.block_rank_correlation_fwd90));
}

export { rows, rf, build, simulate, V3, FAMILIES, DAY, finite, mean, stdev, clamp, r1, r2 };
