// Сверка правил кандидата v3 с расчётом аудита на реконструкции 2013–07.2026 (backtest/out/timeline.json).
//   1. Функции модуля подставлены в схему расчёта аудита (work/lead/hist9.mjs): строки таблицы
//      decision_record.evidence обязаны воспроизвестись числами контракта.
//   2. Тот же кандидат «как в движке»: обе ноги бирж по одному ряду остатка, сложность и тренд — из рядов,
//      без подстановки баллов v1 там, где свой счёт невозможен.
//   3. Сам движок evaluateShadowVariantsV1 в эру ETF — день в день против пошагового расчёта.
// Запуск: node scripts/variants-history.mjs [--out <json>]. Читает только архив backtest/ репозитория;
// в `npm run check` не входит (архив — замороженное исследование, а не конфигурация). In-sample.
import { readFileSync, writeFileSync } from "node:fs";
import { POLICY_V1 } from "../docs/policy-v1.mjs";
import { POLICY_V3_CANDIDATE, allocationDecisionV3, componentScoreV1Port, dailyHysteresisStepV3, evaluateShadowVariantsV1, lowGoodV1Port, macroShockStateV1Port, mvrvDeepPercentileV3, recoveryStateV1Port, scoreExchangeSupplyV3, scoreNetworkV3, scoreTrendV3, scoreValuationV3, strategicCandidateV1Port } from "../docs/policy-v3-candidate.mjs";

const DAY = 86_400_000, HOUR = 3_600_000;
const load = rel => JSON.parse(readFileSync(new URL(`../backtest/${rel}`, import.meta.url), "utf8"));
const rows = load("out/timeline.json"), dtb3 = load("data/fred_DTB3.json"), cm = load("data/coinmetrics.json"), cmDeep = load("data/coinmetrics_deep.json");
const clean = s => s.map(p => ({ t: Number(p.t), v: Number(p.v) })).filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
const hash = clean(load("data/bc_hashrate.json")).filter(p => p.v > 0), difficulty = clean(load("data/bc_difficulty.json")).filter(p => p.v > 0);
const reserveShort = clean(cm.SplyExNtv), reserveDeep = clean(cmDeep.SplyExNtv), mvrvDeep = clean(cmDeep.CapMVRVCur);
// Цена реконструкции: Coinbase с 2015 года, раньше — blockchain.info (как в backtest/engine.mjs).
const coinbase = clean(load("data/price_coinbase.json")), price = [...clean(load("data/bc_price_all.json")).filter(p => p.t < coinbase[0].t && p.v > 0.01), ...coinbase];
const finite = v => v !== null && v !== undefined && Number.isFinite(Number(v)), mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };

// Срез «как было известно на закрытии дня»: хвост ряда не позже даты строки.
function tails(series, keep) { let end = 0; return t => { while (end < series.length && series[end].t <= t) end++; return series.slice(Math.max(0, end - keep), end); }; }
const cut = { hash: tails(hash, 220), difficulty: tails(difficulty, 220), reserveShort: tails(reserveShort, 1700), reserveDeep: tails(reserveDeep, 1700), mvrvDeep: tails(mvrvDeep, Infinity), price: tails(price, 1500) };
const leg = v => (!finite(v) ? null : v > -5 ? 0 : v > -15 ? -1 : -2), cappedLowGood = (rank, value) => (finite(rank) ? (finite(value) && value > 0 ? Math.min(lowGoodV1Port(rank), 0) : lowGoodV1Port(rank)) : null);

// Предвычисления на каждую дату: фикс наутро после закрытия дня (06:00 UTC следующих суток).
const X = rows.map(r => {
  const now = r.t + DAY + 6 * HOUR, series = { hashrate: cut.hash(r.t), difficulty: cut.difficulty(r.t), exchange_supply: cut.reserveDeep(r.t), mvrv_deep: cut.mvrvDeep(r.t), price_daily: cut.price(r.t) }, short = cut.reserveShort(r.t);
  const network = scoreNetworkV3({ hashrate: series.hashrate, difficulty: series.difficulty, now }), exchange = scoreExchangeSupplyV3({ reserve: series.exchange_supply, now });
  const flowShort = short.length ? scoreExchangeSupplyV3({ reserve: short, now }) : null, reserveLegAudit = cappedLowGood(r.raw?.res90Pct, r.raw?.res90);
  return {
    now, series,
    deep: mvrvDeepPercentileV3({ mvrvDeep: series.mvrv_deep, now }).percentile,
    trend: scoreTrendV3({ priceDaily: series.price_daily, now }).score,
    network, exchange,
    // Как у аудита: нога хешрейта — модулем, сложность и нога остатка за 90 дней — из реконструкции,
    // нога потоков — по ряду с 2015 года; пока своего счёта нет, голосует балл v1.
    auditNetwork: network.hashrate_leg === null && !finite(r.raw?.d90) ? null : componentScoreV1Port([network.hashrate_leg, leg(r.raw?.d90)]),
    auditExchange: flowShort && flowShort.flow_change_btc !== null ? componentScoreV1Port([flowShort.flow_leg, reserveLegAudit]) : null,
    reserveLegAudit,
  };
});

// Риск-фри и симулятор — как в расчёте аудита: исполнение на следующий день, 10 б.п. на полный оборот.
const rf = []; { let j = 0; for (const r of rows) { while (j + 1 < dtb3.length && dtb3[j + 1].t <= r.t) j++; rf.push(Math.max(0, dtb3[j].v) / 100 / 365); } }
function sim(target, from, lag = 1, cost = 0.001) {
  let equity = 1, position = null, peak = 1, drawdown = 0, n = 0;
  const excess = [];
  for (let i = 1 + lag; i < rows.length; i++) {
    if (rows[i].date < from) continue;
    let t = target[i - 1 - lag];
    if (t === null || t === undefined) t = position === null ? 50 : position * 100;
    const w = t / 100;
    let r = w * (rows[i].price / rows[i - 1].price - 1) + (1 - w) * rf[i];
    if (position !== null && Math.abs(w - position) > 1e-9) r -= cost * Math.abs(w - position);
    position = w; equity *= 1 + r; peak = Math.max(peak, equity); drawdown = Math.min(drawdown, equity / peak - 1); excess.push(r - rf[i]); n++;
  }
  const m = mean(excess), sd = Math.sqrt(mean(excess.map(v => (v - m) ** 2)));
  return [Math.round((equity ** (365 / n) - 1) * 1000) / 10, Math.round(m * 365 / (sd * Math.sqrt(365)) * 100) / 100, Math.round(drawdown * 1000) / 10];
}

// Баллы семей v1 строки реконструкции (как у аудита: stress и биржи — в «боевом» варианте 28).
function familiesV1(r) {
  const f = r.families, pick = (a, b) => (finite(a) ? a : b ?? null);
  return { macro: { liquidity: f.liquidity ?? null, conditions: f.conditions ?? null, stress: pick(f.stress28, f.stress) }, demand: { etf: f.etf ?? null, stablecoins: f.stablecoins ?? null, exchange_supply: pick(f.exchange_supply28, f.exchange_supply), institutional: f.institutional ?? null }, cycle: { valuation: null, network: f.network ?? null, activity: f.activity ?? null, miners: f.miners ?? null, trend: f.trend ?? null } };
}
// Вариант правила. mode: "audit" — подстановки как в расчёте аудита; "engine" — счёт модуля без подстановок.
function build(o, mode = "audit") {
  const exclude = o.noCftc ? POLICY_V3_CANDIDATE.scoring.non_voting_families : [], out = { target: [], state: [], candidate: [], detectors: [] };
  let st = null, closes = 0;
  rows.forEach((r, i) => {
    const families = familiesV1(r), x = X[i];
    if (o.network) families.cycle.network = mode === "engine" ? x.network.score : x.auditNetwork ?? families.cycle.network;
    if (o.exchange) families.demand.exchange_supply = mode === "engine" ? x.exchange.score : x.auditExchange ?? families.demand.exchange_supply;
    if (o.trend && mode === "engine") families.cycle.trend = x.trend;
    const valuation = scoreValuationV3({ percentile: r.families.mvrvPct, percentileDeep: o.twoWindows ? x.deep : null });
    families.cycle.valuation = valuation.score;
    const shock = macroShockStateV1Port(families.macro), recovery = recoveryStateV1Port({ anchor: valuation.anchor, trend: families.cycle.trend, etf: families.demand.etf, exchangeSupply: families.demand.exchange_supply });
    const le = v => finite(v) && v <= -1, distribution = !o.noDead && le(families.cycle.valuation) && le(families.demand.exchange_supply) && le(families.cycle.trend) ? "fired" : "calm";
    const candidate = strategicCandidateV1Port({ families, criticalOk: true, macroShockState: shock, distributionState: distribution, recoveryState: recovery.state, exclude });
    st = st ? dailyHysteresisStepV3(st, candidate) : { s: candidate, p: null, n: 0 };
    const live = recovery.state === "good" && shock !== "fired";
    closes = live ? Math.min(3, closes + 1) : 0;
    let target = allocationDecisionV3({ strategic: st.s, floorCloses: o.floor === "graduated" ? closes : live ? 3 : 0, cheap: valuation.cheap }).target_pct;
    const cap = POLICY_V1.allocation_overlays;
    if (!o.noDead && finite(r.families.mvrvPct) && r.families.mvrvPct >= cap.euphoria_min_mvrv_percentile && target > cap.euphoria_cap_pct) target = cap.euphoria_cap_pct;
    out.target.push(target); out.state.push(st.s); out.candidate.push(candidate); out.detectors.push({ shock, recovery: recovery.state, distribution, live, closes });
  });
  return out;
}

const WINDOWS = ["2013-01-01", "2018-06-01", "2024-03-01"], FULL = { noCftc: true, network: true, exchange: true, twoWindows: true, noDead: true, trend: true, floor: "graduated" };
const VARIANTS = [
  ["v1 как есть", {}], ["без CFTC", { noCftc: true }], ["сеть по 30-дневным средним", { network: true }], ["биржи по остатку", { exchange: true }],
  ["оценка: согласие двух окон", { twoWindows: true }], ["пол 40/60/80 по закрытиям", { floor: "graduated" }], ["кандидат v3 целиком", FULL],
];
const cell = v => `${v[0].toFixed(1).padStart(5)} /${v[1].toFixed(2).padStart(5)} /${v[2].toFixed(1).padStart(6)}`;
const result = { rows: rows.length, from: rows[0].date, to: rows.at(-1).date, audit_scheme: [], engine_scheme: [], legs: {}, engine: {} };

// ---------- 1. Схема аудита ----------
console.log(`Реконструкция ${rows[0].date} … ${rows.at(-1).date}, ${rows.length} дней. Годовая доходность, % / Sharpe / макс. просадка, %; окна: с 2013 · с 06.2018 · эра ETF`);
console.log("\n1. Правила модуля в схеме расчёта аудита против таблицы контракта");
let mismatched = 0;
const built = {};
for (const [name, flags] of VARIANTS) {
  built[name] = build(flags);
  const cells = WINDOWS.map(from => sim(built[name].target, from)), expected = POLICY_V3_CANDIDATE.decision_record.evidence.rows.find(x => x.variant === name).values;
  const same = cells.every((c, w) => c.every((v, k) => Math.abs(v - expected[w][k]) < 1e-9));
  if (!same) mismatched++;
  result.audit_scheme.push({ variant: name, values: cells, contract: expected, same });
  console.log(`   ${name.padEnd(30)} ${cells.map(cell).join("  ·  ")}   ${same ? "= контракт" : "≠ контракт: " + expected.map(cell).join("  ·  ")}`);
}
console.log(`   строк, разошедшихся с контрактом: ${mismatched} из ${VARIANTS.length}`);
result.audit_mismatched = mismatched;

// ---------- 2. Счёт ног модулем против реконструкции ----------
const from2013 = rows.findIndex(r => r.date >= "2013-01-01"), span = rows.slice(from2013).map((r, k) => [r, X[from2013 + k]]);
const share = (list, fn) => { const usable = list.filter(([r, x]) => fn(r, x) !== null); return { days: usable.length, differ: usable.filter(([r, x]) => fn(r, x) === true).length }; };
result.legs = {
  trend_closed_day_vs_reconstruction: share(span, (r, x) => (x.trend === null || !finite(r.families.trend) ? null : x.trend !== r.families.trend)),
  difficulty_leg_vs_reconstruction: share(span, (r, x) => (x.network.difficulty_leg === null || !finite(r.raw?.d90) ? null : x.network.difficulty_leg !== leg(r.raw.d90))),
  reserve_leg_vs_reconstruction: share(span, (r, x) => (x.exchange.reserve_leg === null || x.reserveLegAudit === null ? null : x.exchange.reserve_leg !== x.reserveLegAudit)),
  exchange_family_one_series_vs_audit: share(span, (r, x) => (x.exchange.score === null || x.auditExchange === null ? null : x.exchange.score !== x.auditExchange)),
  network_family_vs_audit: share(span, (r, x) => (x.network.score === null || x.auditNetwork === null ? null : x.network.score !== x.auditNetwork)),
  network_v3_vs_v1_day_to_day_changes: { v1: span.slice(1).filter(([r], k) => r.families.network !== span[k][0].families.network).length, v3: span.slice(1).filter(([, x], k) => x.network.score !== span[k][1].network.score).length },
  exchange_v3_differs_from_v1: share(span, (r, x) => (x.exchange.score === null ? null : x.exchange.score !== (finite(r.families.exchange_supply28) ? r.families.exchange_supply28 : r.families.exchange_supply))),
  deep_window_usable_days: span.filter(([, x]) => x.deep !== null).length,
  cheap_vetoed_by_deep_window_days: span.filter(([r, x]) => finite(r.families.mvrvPct) && r.families.mvrvPct <= 10 && x.deep !== null && x.deep > 10).length,
  anchor_vetoed_by_deep_window_days: span.filter(([r, x]) => finite(r.families.mvrvPct) && r.families.mvrvPct < 25 && x.deep !== null && x.deep >= 25).length,
};
console.log("\n2. Ноги, посчитанные модулем из рядов, против реконструкции (с 2013 года; дней с расхождением из сравнимых)");
for (const [key, v] of Object.entries(result.legs)) console.log(`   ${key.padEnd(40)} ${typeof v === "number" ? v : v.days !== undefined ? `${v.differ} из ${v.days}` : JSON.stringify(v)}`);

// ---------- 3. Кандидат «как в движке» ----------
console.log("\n3. Кандидат целиком «как в движке» (свой счёт всех четырёх семей из рядов, без подстановок)");
const engineScheme = build(FULL, "engine"), auditFull = built["кандидат v3 целиком"], v1Scheme = built["v1 как есть"];
for (const [name, b] of [["кандидат v3, схема аудита", auditFull], ["кандидат v3, как в движке", engineScheme], ["v1 как есть", v1Scheme]]) {
  const cells = WINDOWS.map(from => sim(b.target, from));
  result.engine_scheme.push({ variant: name, values: cells });
  console.log(`   ${name.padEnd(30)} ${cells.map(cell).join("  ·  ")}`);
}
{
  const declared = POLICY_V3_CANDIDATE.decision_record.evidence.as_executed.values, actual = result.engine_scheme[1].values;
  result.as_executed_same = actual.every((c, w) => c.every((v, k) => Math.abs(v - declared[w][k]) < 1e-9));
  console.log(`   строка контракта as_executed: ${result.as_executed_same ? "= расчёт" : "≠ расчёт: " + declared.map(cell).join("  ·  ")}`);
}
const differDays = from => rows.map((r, i) => (r.date >= from && engineScheme.target[i] !== auditFull.target[i] ? 1 : 0)).reduce((a, b) => a + b, 0);
result.engine_vs_audit_target_days = Object.fromEntries(WINDOWS.map(from => [from, differDays(from)]));
console.log(`   дней, где цель «как в движке» отличается от схемы аудита: ${WINDOWS.map(from => `${differDays(from)} (с ${from})`).join(", ")}`);

// ---------- 4. Сам движок в эру ETF ----------
// До ETF движок честно «insufficient» (семья ETF обязательна, как в v1), поэтому сверяется эра ETF.
const start = rows.findIndex(r => r.date >= WINDOWS[2]);
const v1Detectors = v1Scheme.detectors;
function inputsAt(i) {
  const r = rows[i], families = familiesV1(r), valuation = scoreValuationV3({ percentile: r.families.mvrvPct });
  families.cycle.valuation = valuation.score;
  return {
    price: r.price, hard_override: false,
    v1: { state: v1Scheme.state[i], candidate: v1Scheme.candidate[i], critical_ok: true, target_pct: v1Scheme.target[i], recovery_state: v1Detectors[i].recovery, macro_shock_state: v1Detectors[i].shock, distribution_state: v1Detectors[i].distribution, mvrv_percentile: r.families.mvrvPct, valuation_score: valuation.score },
    families, series: X[i].series,
  };
}
// Пошаговый расчёт от того же старта, что и холодный старт движка: состояние и цель v1 на первый день.
function stepwise(flags, fromIndex) {
  const full = build(flags, "engine"), target = [];
  let st = { s: v1Scheme.state[fromIndex], p: null, n: 0 }, closes = v1Detectors[fromIndex].live ? 3 : 0;
  for (let i = fromIndex; i < rows.length; i++) {
    if (i === fromIndex) { target.push(v1Scheme.target[i]); continue; }
    st = dailyHysteresisStepV3(st, full.candidate[i]);
    closes = full.detectors[i].live ? Math.min(3, closes + 1) : 0;
    const valuation = scoreValuationV3({ percentile: rows[i].families.mvrvPct, percentileDeep: flags.twoWindows ? X[i].deep : null });
    let t = allocationDecisionV3({ strategic: st.s, floorCloses: flags.floor === "graduated" ? closes : full.detectors[i].live ? 3 : 0, cheap: valuation.cheap }).target_pct;
    const cap = POLICY_V1.allocation_overlays;
    if (!flags.noDead && finite(rows[i].families.mvrvPct) && rows[i].families.mvrvPct >= cap.euphoria_min_mvrv_percentile && t > cap.euphoria_cap_pct) t = cap.euphoria_cap_pct;
    target.push(t);
  }
  return target;
}
{
  let state = null;
  const engine = { policy_v3_shadow: [], v1_daily_close: [] }, nulls = { policy_v3_shadow: 0, v1_daily_close: 0 };
  for (let i = start; i < rows.length; i++) {
    const out = evaluateShadowVariantsV1({ now: X[i].now, inputs: inputsAt(i), state: state && JSON.parse(JSON.stringify(state)) });
    state = out.state;
    for (const key of Object.keys(engine)) { const t = out.variants[key].target_pct; if (t === null) nulls[key]++; engine[key].push(t); }
  }
  const expected = { policy_v3_shadow: stepwise(FULL, start), v1_daily_close: stepwise({}, start) };
  console.log(`\n4. Движок evaluateShadowVariantsV1 в эру ETF (${rows[start].date} … ${rows.at(-1).date}, ${rows.length - start} фиксов) против пошагового расчёта`);
  for (const key of Object.keys(engine)) {
    const differ = engine[key].filter((t, k) => t !== expected[key][k]).length, padded = Array(start).fill(null).concat(engine[key]);
    const first = engine[key].findIndex((t, k) => t !== expected[key][k]);
    result.engine[key] = { fixes: engine[key].length, differ, null_targets: nulls[key], etf_era: sim(padded, WINDOWS[2]) };
    console.log(`   ${key.padEnd(18)} расхождений цели ${differ} из ${engine[key].length}, цель null ${nulls[key]} раз; результат эры ETF ${cell(result.engine[key].etf_era)}${first >= 0 ? `; первое расхождение ${rows[start + first].date}: движок ${engine[key][first]}, расчёт ${expected[key][first]}` : ""}`);
  }
  // Линия атрибуции против строки «v1 как есть»: расходятся только на старте — холодный старт не наследует
  // начатый счёт повышения, поэтому первое повышение приходит на фикс позже.
  const late = engine.v1_daily_close.map((t, k) => (t !== v1Scheme.target[start + k] ? rows[start + k].date : null)).filter(Boolean);
  result.engine.v1_daily_close.differ_from_v1_scheme = late;
  console.log(`   v1_daily_close против строки «v1 как есть» той же реконструкции: расхождений ${late.length}${late.length ? ` (${late.join(", ")})` : ""}`);
}

const out = arg("--out");
if (out) { writeFileSync(out, JSON.stringify(result, null, 1)); console.log(`\nJSON: ${out}`); }
