// Теневой кандидат v3 и движок теневых линий: контракт, равенство портов запертым секциям v1,
// суточный такт, правила четырёх линий, устойчивость к мусору и мутации ключевых правил.
// Сети нет, от даты запуска тест не зависит: время приходит в движок параметром now, а обращение
// модуля к Date.now(), new Date() без аргумента или Math.random() — провал теста.
import nodeAssert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { POLICY_V1, allocationDecisionV1, applyStrategicDetectorPolicyV1 } from "../docs/policy-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { POLICY_V2_CANDIDATE } from "../docs/policy-v2-candidate.mjs";
import { POLICY_SUITE_V1 } from "../docs/policy-suite-v1.mjs";
import * as REAL from "../docs/policy-v3-candidate.mjs";
import { componentScore, percentileRank, priorByDays, severity, stabilizeCore } from "./fetch-snapshot.mjs";

const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const T0 = Date.parse("2026-11-02T00:00:00.000Z"); // понедельник
const at = (day, hour = 0, minute = 0) => T0 + day * DAY + hour * HOUR + minute * MIN;
const clone = x => JSON.parse(JSON.stringify(x));
const iso = t => new Date(t).toISOString();
const deepFreeze = x => { if (x && typeof x === "object" && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) deepFreeze(v); } return x; };
const REGIMES = ["defensive", "deteriorating", "transition", "unconfirmed_positive", "constructive"];
const LINE_KEYS = ["policy_v3_shadow", "v1_daily_close", "v1_floor_handoff", "v1_no_cftc"], DAILY = ["policy_v3_shadow", "v1_daily_close"];
const C = REAL.POLICY_V3_CANDIDATE;
// Счётчик честный: считается каждый вызов проверки, в том числе на мутантах.
let assertions = 0;
const assert = new Proxy(nodeAssert, { get: (target, key) => (typeof target[key] === "function" ? (...args) => { assertions++; return target[key](...args); } : target[key]) });

// ---------- Страж чистоты: движок не читает часы и случайность ----------
const RealDate = Date, realRandom = Math.random;
let impure = null;
class GuardedDate extends RealDate {
  constructor(...args) { if (!args.length) impure = "new Date() без аргумента"; super(...args); }
  static now() { impure = "Date.now()"; return RealDate.now(); }
  static [Symbol.hasInstance](x) { return x instanceof RealDate; }
}
function pure(fn) {
  impure = null;
  globalThis.Date = GuardedDate;
  Math.random = () => { impure = "Math.random()"; return realRandom(); };
  try { return fn(); } finally { globalThis.Date = RealDate; Math.random = realRandom; }
}
const call = (m, args) => { const out = pure(() => m.evaluateShadowVariantsV1(args)); assert.equal(impure, null, `движок обратился к ${impure}`); return out; };

// ---------- Синтетические входы ----------
const daily = (lastT, n, fn) => Array.from({ length: n }, (_, i) => ({ t: lastT - (n - 1 - i) * DAY, v: fn(i, n) }));
const PRICE = {
  // выше обеих средних → +2
  up: i => 50_000 + 20 * i,
  // выше 20-недельной, ниже 200-дневной → 0
  mixed: (i, n) => (i === n - 1 ? 95_000 : i >= n - 140 ? 90_000 : i >= n - 200 ? 120_000 : 100_000),
  // ниже обеих, выше 200-недельной → −1
  below: (i, n) => (i === n - 1 ? 95_000 : i >= n - 200 ? 100_000 : 90_000),
  // ниже 200-недельной → −2
  below200w: (i, n) => (i === n - 1 ? 95_000 : 100_000),
};
const seriesCache = new Map();
// deep — перцентиль последней точки глубокого ряда (≈), null — ряда нет, "short" / "stale" — негодный ряд.
function seriesFor(now, { deep = 50, price = "up", unclosed, hash, reserve, noHash = false, noDifficulty = false, noPrice = false, noReserve = false } = {}) {
  const today = Math.floor(now / DAY) * DAY, key = JSON.stringify([today, deep, price, unclosed ?? null, hash ?? null, reserve ?? null, noHash, noDifficulty, noPrice, noReserve]);
  if (seriesCache.has(key)) return seriesCache.get(key);
  const closes = daily(today - DAY, 1500, PRICE[price]);
  const deepN = deep === "short" ? 1999 : 2400, deepLast = deep === "stale" ? today - 6 * DAY : today - DAY, deepPct = typeof deep === "number" ? deep : 50;
  const out = {
    hashrate: noHash ? [] : daily(today, 200, hash === "dip" ? (i, n) => (i === n - 1 ? 7.2e20 : 9e20) : hash === "base_spike" ? (i, n) => (i === n - 91 ? 11.25e20 : 9e20) : typeof hash === "number" ? (i, n) => (i >= n - 30 ? 9e20 * (1 + hash / 100) : 9e20) : () => 9e20),
    difficulty: noDifficulty ? [] : Array.from({ length: 20 }, (_, i) => ({ t: today - 2 * DAY - (19 - i) * 14 * DAY, v: 1.3e14 })),
    exchange_supply: noReserve ? [] : reserve ?? daily(today - DAY, 1700, () => 2_700_000),
    price_daily: noPrice ? [] : [...closes, { t: today, v: unclosed ?? closes.at(-1).v }],
    mvrv: daily(today - DAY, 10, () => 1.5),
    mvrv_deep: deep === null ? null : daily(deepLast, deepN, (i, n) => (i === n - 1 ? 1 + deepPct / 100 + 0.001 : 1 + (i % 200) / 200)),
  };
  // Ряды заморожены на всю глубину: любая попытка движка изменить вход уронит сценарий.
  seriesCache.set(key, deepFreeze(out));
  return out;
}
const PRESET = {
  transition: { macro: [0, 0, 0], demand: [0, 0] },
  deteriorating: { macro: [0, 0, 0], demand: [-1, -1] },
  defensive: { macro: [-2, -1, 0], demand: [-1, -1] },
  unconfirmed_positive: { macro: [1, 1, 1], demand: [0, 0] },
  constructive: { macro: [0, 0, 0], demand: [1, 1] },
};
// Баллы семей v1, при которых и гейт v1, и гейт без CFTC, и кандидат v3 (на нейтральных рядах) дают названный режим.
function familiesOf(preset, { macro = {}, demand = {}, cycle = {} } = {}) {
  const p = PRESET[preset];
  return { macro: { liquidity: p.macro[0], conditions: p.macro[1], stress: p.macro[2], ...macro }, demand: { etf: p.demand[0], stablecoins: p.demand[1], exchange_supply: 0, institutional: 0, ...demand }, cycle: { valuation: 0, network: 0, activity: 0, miners: 0, trend: 2, ...cycle } };
}
function mk(now, o = {}) {
  const cand = o.cand ?? "transition", state = o.state ?? cand;
  const families = o.families ?? familiesOf(REGIMES.includes(cand) ? cand : "transition", o.fam);
  const v1 = { state, candidate: cand, critical_ok: o.critical ?? cand !== "insufficient", recovery_state: o.recovery ?? "calm", macro_shock_state: o.shock ?? "calm", distribution_state: o.distribution ?? "calm", mvrv_percentile: o.mvrv === undefined ? 50 : o.mvrv, valuation_score: families.cycle.valuation };
  v1.target_pct = o.target !== undefined ? o.target : allocationDecisionV1({ strategic: state, recoveryState: v1.recovery_state, macroShockState: v1.macro_shock_state, mvrvPercentile: v1.mvrv_percentile }).target_pct;
  const yesterday = iso(Math.floor(now / DAY) * DAY - DAY);
  return { price: o.price ?? 80_000, hard_override: o.hard ?? false, v1, families, series: o.series === undefined ? seriesFor(now, o.s) : o.series, observed_at: { mvrv: yesterday, coinmetrics: yesterday, etf: yesterday, network: iso(Math.floor(now / DAY) * DAY), market: iso(Math.floor(now / DAY) * DAY) } };
}
// Прогон последовательности снимков: состояние каждый раз проходит через JSON, как в опубликованном снимке.
function drive(m, steps, state = null) {
  const outs = [];
  for (const [now, o] of steps) {
    const out = call(m, { now, inputs: mk(now, o), state: deepFreeze(clone(state)) });
    assert.deepEqual(clone(out.state), out.state, "состояние обязано переживать JSON без потерь");
    state = out.state;
    outs.push(out.variants);
  }
  return { outs, state };
}
const targets = (variants, keys = LINE_KEYS) => keys.map(k => variants[k].target_pct);

// =====================================================================================
// 1. Контракт
// =====================================================================================
{
  assert.equal(C.id, "btc-decision-suite-v3-candidate");
  assert.equal(C.version, 1);
  assert.equal(C.status, "shadow_candidate", "кандидат — тень, а не живое решение");
  assert.equal(C.created, "2026-10-10");
  assert.equal(C.base_suite, POLICY_SUITE_V1.id);
  assert.deepEqual(REAL.policyV3CandidateMetadata(), { id: C.id, version: 1, status: "shadow_candidate", created: "2026-10-10", base_suite: POLICY_SUITE_V1.id });
  const frozen = x => !x || typeof x !== "object" || (Object.isFrozen(x) && Object.values(x).every(frozen));
  assert.ok(frozen(C), "контракт заморожен на всю глубину");
  assert.deepEqual(Object.keys(C.lines), LINE_KEYS);
  // Существующие числа — ссылками на контракты v1/v2, а не копиями.
  assert.equal(C.ladder, POLICY_V1.ladder);
  assert.equal(C.floor_ladder_pct, POLICY_V2_CANDIDATE.floor_ladder_pct);
  assert.deepEqual([...C.floor_ladder_pct], [40, 60, 80]);
  assert.equal(C.capitulation_floor_pct, POLICY_V1.allocation_overlays.capitulation_floor_pct);
  assert.equal(C.scoring.valuation.cheap_max_percentile, POLICY_V1.allocation_overlays.capitulation_max_mvrv_percentile);
  assert.deepEqual(C.daily_fix, { hour_utc: 6, confirm_fixes_down: 1, confirm_fixes_up: 2, missed_day_resets_streaks: true });
  assert.deepEqual(C.scoring.non_voting_families, ["institutional"]);
  assert.deepEqual(C.scoring.removed_rules, ["euphoria_safety_cap", "distribution_detector"]);
  assert.deepEqual([C.scoring.valuation.deep_min_points, C.scoring.valuation.deep_max_age_days], [2000, 5]);
  const a = C.decision_record.acceptance_criteria;
  assert.deepEqual([a.shadow_days_min, a.min_target_changes_vs_v1, a.timing_pp_not_worse_than_v1, a.max_drawdown_worse_pp_max, a.falsify_net_return_gap_pp, a.falsify_min_days], [180, 3, true, 5, -10, 180]);
  assert.ok(a.switch_requires_all.length >= 6 && a.falsified_if.length > 20, "предзаявлены и приёмка, и фальсификация");
  assert.doesNotMatch(JSON.stringify(a), /sharpe/i, "разрыв Sharpe в критерии не входит: на 90 днях его шум 0,19");
  assert.ok(JSON.stringify(a).length < 1200, "критерии публикуются в каждом снимке — блок обязан оставаться коротким");
  assert.deepEqual(Object.keys(C.decision_record.acceptance_definitions), ["shadow_days", "target_changes_vs_v1", "timing_pp", "max_drawdown_worse_pp", "net_return_gap_pp"]);
  assert.deepEqual(C.decision_record.changes.map(x => x.id), ["daily_fix", "cftc_not_voting", "network_30d_means", "exchange_flow_from_reserve", "valuation_two_windows", "trend_closed_day", "floor_graduated", "dead_rules_removed"]);
  for (const change of C.decision_record.changes) for (const field of ["v1", "v3", "why", "numbers"]) assert.ok(change[field].length > 10, `изменение ${change.id}: поле ${field}`);
  assert.deepEqual(C.decision_record.rejected.map(x => x.id), ["floor_carry_after_anchor", "strictly_positive_leg", "downgrade_anchor_on_macro", "sharpe_gap_criterion"]);
  for (const item of C.decision_record.rejected) assert.ok(/\d/.test(item.numbers) && item.outcome.length > 10, `отклонённое ${item.id} записано с числами`);
  const ev = C.decision_record.evidence;
  assert.equal(ev.rows.length, 9);
  for (const row of ev.rows) { assert.equal(row.values.length, ev.windows.length); for (const cell of row.values) assert.ok(cell.length === 3 && cell.every(Number.isFinite)); }
  assert.deepEqual(clone(ev.rows.find(r => r.role === "candidate").values), [[47.4, 1.53, -40.4], [40.5, 1.38, -34.2], [23.4, 0.95, -14.1]]);
  assert.deepEqual(clone(ev.rows.find(r => r.role === "base").values), [[43.0, 1.39, -40.8], [33.7, 1.15, -40.8], [17.5, 0.74, -15.5]]);
  // Обе строки воспроизводит scripts/variants-history.mjs из архива backtest/ функциями этого же модуля.
  assert.deepEqual(clone(ev.as_executed.values), [[46.5, 1.5, -40.4], [40.3, 1.38, -34.2], [23.4, 0.95, -14.1]]);
  assert.match(C.decision_record.evidence_basis, /in-sample/);
  assert.match(C.decision_record.objective, /не меняя лестницу и дерево гейтов/);
  // Числа записи решения — не копия руками: они равны выводу воспроизводимых расчётов архива.
  // backtest/eval6.mjs — дневная сетка, backtest/eval7.mjs — исполнение в час фикса по часовым ценам.
  const cell = x => [x.cagr, x.sharpe, x.maxDD];
  const grid = JSON.parse(readFileSync(new URL("../backtest/out/audit-2026-10-10.json", import.meta.url), "utf8")).v3_variants;
  const GRID_ROW = { "v1 как есть": "v1 как есть", "без CFTC": "без CFTC", "сеть по 30-дневным средним": "сеть по 30-дневным средним", "биржи по остатку": "биржи по остатку", "оценка: согласие двух окон": "оценка: согласие двух окон", "пол 40/60/80 по закрытиям": "пол 40/60/80 по закрытиям", "кандидат v3 целиком": "кандидат v3 целиком", "v3 + удержание пола после ухода якоря": "v3 + удержание после ухода якоря", "пол + «хотя бы одна нога > 0»": "пол 40/60/80 + хотя бы одна нога > 0" };
  const GRID_WINDOWS = ["2013-01…2026-07", "2018-06…2026-07", "эра ETF 2024-03…2026-07"];
  for (const row of ev.rows) { const source = grid[GRID_ROW[row.variant]]; assert.ok(source, `строка «${row.variant}» есть в выводе eval6`); assert.deepEqual(clone(row.values), GRID_WINDOWS.map(w => cell(source[w])), `строка «${row.variant}» равна выводу eval6`); }
  const hourly = JSON.parse(readFileSync(new URL("../backtest/out/audit-2026-10-13-fix-hour.json", import.meta.url), "utf8"));
  const HOUR_WINDOWS = ["2018-06…2026-07", "эра ETF 2024-03…2026-07"], HOUR_ROW = { "правила v1 на суточном фиксе": "v1 на суточном фиксе", "без CFTC": "без CFTC", "оценка: согласие двух окон": "оценка: согласие двух окон", "пол 40/60/80 по фиксам": "пол 40/60/80 по фиксам", "кандидат v3 целиком": "кандидат v3 целиком" };
  const fix = ev.at_fix_hour;
  assert.deepEqual([...fix.windows], ["с 06.2018", "эра ETF (03.2024+)"]);
  assert.deepEqual(fix.rows.map(r => r.role), ["base", "change", "change", "change", "candidate"]);
  for (const row of fix.rows) assert.deepEqual(clone(row.values), HOUR_WINDOWS.map(w => cell(hourly.components_at_06h[HOUR_ROW[row.variant]][w])), `строка «${row.variant}» равна выводу eval7`);
  assert.deepEqual(Object.keys(fix.fix_hours_utc), ["6", "15", "22", "24"]);
  for (const [hour, values] of Object.entries(fix.fix_hours_utc)) assert.deepEqual(clone(values), HOUR_WINDOWS.map(w => cell(hourly.lines["кандидат v3"].by_publication[`${hour}h`][w])), `час фикса ${hour} равен выводу eval7`);
  assert.deepEqual(clone(fix.rows.at(-1).values), clone(fix.fix_hours_utc[C.daily_fix.hour_utc]), "строка кандидата — его собственный час фикса");
  // Возраст макровходов к часу фикса в расчёте — тот, что заявлен в контракте: до 15:00 UTC всё макро на день старше.
  assert.deepEqual(hourly.publication_lag_days[`${C.daily_fix.hour_utc}h`], { stress: 1, conditions: 1, liquidity: 1 });
  // Ревью 13.10.2026: контракт утверждал, что к 06:00 UTC приходит и FRED и фикс читает входы одного
  // возраста. Это неверно — вчерашние спреды и VIX выходят около 13:30 UTC, ставки — около 21:15.
  const clock = C.decision_record.changes[0];
  assert.ok(!clock.why.includes("одного возраста") && !clock.why.includes("одного\nвозраста"), "на фиксе макровходы старше остальных — контракт не вправе утверждать обратное");
  assert.ok(clock.why.includes("на один рабочий день старше"));
  assert.ok(clock.numbers.includes("45,5 / 1,51 / −33,0") && clock.numbers.includes("43,1 / 1,40 / −36,7"), "числа расчёта по часовым ценам записаны в обоснование такта");
  assert.ok(!JSON.stringify(C).includes("work/lead") && !JSON.stringify(C).includes("work\\\\lead"), "запись решения ссылается только на файлы репозитория");
}

// =====================================================================================
// 2. Порты запертых секций v1 равны оригиналам
// =====================================================================================
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// 2.1. Примитивы — против экспортов сборщика.
{
  const rand = rng(838), junk = [null, undefined, "", "x", NaN, Infinity, "3", true];
  for (let k = 0; k < 400; k++) {
    const n = Math.floor(rand() * 80), values = Array.from({ length: n }, () => (rand() < 0.08 ? pick(rand, junk) : Math.round(rand() * 40) / 4 - 5));
    const value = rand() < 0.1 ? pick(rand, junk) : Math.round(rand() * 40) / 4 - 5;
    assert.ok(Object.is(REAL.percentileRankV1Port(values, value), percentileRank(values, value)), "percentileRank: порт расходится с оригиналом");
  }
  const scores = [null, undefined, "", "x", -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, "1"];
  for (const a of scores) for (const b of scores) {
    assert.ok(Object.is(REAL.componentScoreV1Port([a, b]), componentScore([a, b])), `componentScore: [${a}, ${b}]`);
    for (const c of [null, -2, -0.5, 0, 0.5, 2]) assert.ok(Object.is(REAL.componentScoreV1Port([a, b, c]), componentScore([a, b, c])), `componentScore: [${a}, ${b}, ${c}]`);
  }
  assert.ok(Object.is(REAL.componentScoreV1Port([]), componentScore([])) && Object.is(REAL.componentScoreV1Port([1]), componentScore([1])));
  for (let k = 0; k < 200; k++) {
    let t = at(0) - Math.floor(rand() * 400) * DAY;
    const series = Array.from({ length: Math.floor(rand() * 150) }, () => ({ t: (t += Math.ceil(rand() * 4) * DAY * (rand() < 0.2 ? 0.37 : 1)), v: rand() * 100 }));
    for (const days of [0, 1, 7, 30, 90, 400]) assert.deepEqual(REAL.priorByDaysV1Port(series, days), priorByDays(series, days), "priorByDays: порт расходится с оригиналом");
  }
  for (const empty of [null, undefined, []]) assert.equal(REAL.priorByDaysV1Port(empty, 90), priorByDays(empty, 90));
  for (const name of [...POLICY_V1.strategic_order, "insufficient", "нет такого", undefined, null]) assert.equal(REAL.severityV1Port(name), severity(name), `severity: ${name}`);
}

// 2.2. Гистерезис — порт против экспортированного stabilizeCore на случайных блужданиях.
{
  const rand = rng(1658), states = [...REGIMES, "insufficient", "emergency"];
  let steps = 0, upgrades = 0, holds = 0;
  for (let run = 0; run < 400; run++) {
    let now = at(0) + Math.floor(rand() * DAY), state = rand() < 0.15 ? undefined : pick(rand, states), meta = rand() < 0.3 ? {} : { candidate: pick(rand, states), count: Math.floor(rand() * 20), since: rand() < 0.1 ? "мусор" : iso(now - Math.floor(rand() * 60) * HOUR), downStreak: Math.floor(rand() * 3), anchor: rand() < 0.5 ? pick(rand, REGIMES) : null };
    let candidate = pick(rand, states);
    for (let i = 0; i < 70; i++) {
      now += pick(rand, [MIN, 15 * MIN, 15 * MIN, 15 * MIN, HOUR, 13 * HOUR, 30 * HOUR]);
      if (rand() > 0.75) candidate = rand() < 0.12 ? pick(rand, ["insufficient", "emergency"]) : pick(rand, REGIMES);
      const hard = rand() < 0.03, expected = stabilizeCore(candidate, state, meta, now, { hard }), actual = REAL.stabilizeCoreV1Port(candidate, state, meta, now, { hard });
      assert.deepEqual(actual, expected, `stabilizeCore: прогон ${run}, шаг ${i}, ${state} → ${candidate}`);
      if (expected.hold_until) holds++;
      if (severity(expected.state) > severity(state) && REGIMES.includes(state)) upgrades++;
      state = expected.state; meta = clone(expected); steps++;
    }
  }
  assert.ok(upgrades > 50 && holds > 500, "сетка обязана проходить и удержания, и состоявшиеся повышения");
}

// 2.3. Гейт, полосы, покрытие и детекторы — против запертой секции сборщика. Её функции не экспортируются,
// поэтому текст секции между маркерами POLICY-LOCK исполняется как есть (он же закреплён хэшем в policy-lock-test).
const finite = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const collectorSource = readFileSync(new URL("./fetch-snapshot.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const lockFrom = collectorSource.indexOf("// POLICY-LOCK:scoring_and_regimes_v1:START"), lockTo = collectorSource.indexOf("// POLICY-LOCK:scoring_and_regimes_v1:END");
assert.ok(lockFrom > 0 && lockTo > lockFrom, "запертая секция scoring_and_regimes_v1 не найдена в сборщике");
const LOCKED = new Function("finite", "clamp", "mean", "MODEL_POLICY_V1", "CRITICAL_MIN", "applyStrategicDetectorPolicyV1", "data", "quoteDispersion", "classifyIntegrity",
  `"use strict";${collectorSource.slice(lockFrom, lockTo)}\nreturn{componentScore,lowGood,familyStats,band,detectorState,buildDetectors,candidateRegimes};`)(
  finite, (v, a, b) => Math.max(a, Math.min(b, v)), a => (a.length ? a.reduce((s, v) => s + Number(v), 0) / a.length : null), MODEL_POLICY_V1, MODEL_POLICY_V1.critical_min, applyStrategicDetectorPolicyV1, () => ({}), () => null, () => "calm");
const METRIC_ID = { liquidity: "liquidity_regime", conditions: "financial_conditions", stress: "system_stress", etf: "etf_regime", stablecoins: "stablecoin_regime", exchange_supply: "exchange_supply", institutional: "institutional_quality", valuation: "mvrv_cycle", network: "network_security", activity: "network_activity", miners: "miner_regime", trend: "trend_regime" };
const FAMILY_ORDER = { macro: ["liquidity", "conditions", "stress"], demand: ["etf", "stablecoins", "exchange_supply", "institutional"], cycle: ["valuation", "network", "activity", "miners", "trend"] };
const famObject = (macro, demand, cycle) => ({ macro: Object.fromEntries(FAMILY_ORDER.macro.map((k, i) => [k, macro[i]])), demand: Object.fromEntries(FAMILY_ORDER.demand.map((k, i) => [k, demand[i]])), cycle: Object.fromEntries(FAMILY_ORDER.cycle.map((k, i) => [k, cycle[i]])) });
function lockedMetrics(families, mvrvPercentile = null) {
  const out = [];
  for (const [block, group] of Object.entries(families)) for (const [family, score] of Object.entries(group)) out.push({ id: METRIC_ID[family], block, family, score, vote: true, strategic: true, tactical: false, value_num: family === "valuation" ? mvrvPercentile : score });
  // Тактические карточки нужны только затем, чтобы candidateRegimes дошёл до конца.
  for (const [id, block, family] of [["spot_integrity", "market", "integrity"], ["stablecoin_peg", "market", "stablecoin_integrity"], ["realized_volatility", "leverage", "realized_vol"], ["us_spot_premium", "demand", "us_spot"]]) out.push({ id, block, family, score: 0, vote: true, strategic: false, tactical: true, value_num: 0 });
  return out;
}
function lockedBlocks(metrics) {
  const blocks = {};
  for (const k of ["macro", "demand", "cycle", "leverage", "market"]) blocks[k] = { strategic: LOCKED.familyStats(metrics, k, "strategic"), tactical: LOCKED.familyStats(metrics, k, "tactical") };
  return blocks;
}
{
  for (let p = -5; p <= 105; p += 0.25) assert.equal(REAL.lowGoodV1Port(p), LOCKED.lowGood(p), `lowGood(${p})`);
  for (const p of [null, undefined, "", NaN, "x"]) assert.equal(REAL.lowGoodV1Port(p), LOCKED.lowGood(p));
  for (let s = -100; s <= 100; s += 0.5) assert.equal(REAL.bandV1Port(s), LOCKED.band(s), `band(${s})`);
  for (const s of [null, undefined, 19.999999, 20, -19.999999, -20, 20.000000000000004]) assert.equal(REAL.bandV1Port(s), LOCKED.band(s));
  for (let total = 1; total <= 5; total++) for (let hit = 0; hit <= total; hit++) for (const good of [false, true]) assert.equal(REAL.detectorStateV1Port(hit, total, good), LOCKED.detectorState(hit, total, good), `detectorState(${hit}, ${total}, ${good})`);
  const MACRO = [[2, 2, 2], [1, 0, 0.5], [0.5, 0.5, 0], [0, 0, 0], [-0.5, -0.5, 0], [-1, 0, -0.5], [-1, -1, -1], [-2, -1, 0], [null, 0, 0], [0, null, 0], [1, 1, null], [null, null, null]];
  const DEMAND = [[1, 1, 1, 1], [0.5, 0.5, 0.5, 0], [1, 1, 0, -0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 0, 0], [-0.5, -0.5, -0.5, 0], [-0.5, -0.5, -0.5, -0.5], [-1, -1, -1, -1], [null, 1, 1, 1], [1, null, null, 1], [1, null, 1, 1], [1, 1, null, null], [0, 0, 0, null], [-1, -1, null, 1]];
  const CYCLE = [[0, 0, 0, 0, 2], [0, 0, 0, -0.5, 2], [1, 0, 0.5, 1, 2], [0, 0, 0, 0, 0], [0, -1, 0, 0, -1], [0, -0.5, 0, 0, -1], [-1, 0, 0, 0, 2], [-2, 0, 1, 1, 2], [null, 0, 1, 1, 2], [1, 0, 0, 0, 2], [0, null, 0, 0, 2], [0, 0, 0, 0, null], [null, 0, null, null, 2], [-1.5, -2, -1, -1, -2]];
  const outcomes = new Set(), detectorStates = [];
  for (const shock of ["calm", "watch", "fired"]) for (const distribution of ["calm", "watch", "fired"]) for (const recovery of ["calm", "watch", "good"])
    detectorStates.push({ shock, distribution, recovery, list: [{ id: "macro_shock", state: shock }, { id: "distribution", state: distribution }, { id: "recovery", state: recovery }, { id: "leverage", state: "calm" }, { id: "demand_break", state: "calm" }, { id: "short_squeeze", state: "calm" }] });
  let compared = 0;
  for (const macro of MACRO) for (const demand of DEMAND) for (const cycle of CYCLE) {
    const families = famObject(macro, demand, cycle), metrics = lockedMetrics(families), blocks = lockedBlocks(metrics), port = REAL.blockScoresV1Port(families);
    for (const k of ["macro", "demand", "cycle"]) assert.ok(Object.is(port[k], blocks[k].strategic.score), `балл блока ${k}: ${JSON.stringify(families[k])}`);
    assert.equal(REAL.strategicCriticalV1Port(families), LOCKED.candidateRegimes(blocks, metrics, detectorStates[0].list, null).criticalStrategic, `покрытие: ${JSON.stringify(families)}`);
    for (const { shock, distribution, recovery, list } of detectorStates) for (const hard of [null, "НАРУШЕНИЕ ЦЕЛОСТНОСТИ РЫНКА"]) {
      const locked = LOCKED.candidateRegimes(blocks, metrics, list, hard);
      const candidate = REAL.strategicCandidateV1Port({ families, criticalOk: locked.criticalStrategic, hardOverride: !!hard, macroShockState: shock, distributionState: distribution, recoveryState: recovery });
      if (candidate !== locked.strategic) assert.fail(`гейт: порт ${candidate}, оригинал ${locked.strategic} при ${JSON.stringify({ families, shock, distribution, recovery, hard })}`);
      outcomes.add(locked.strategic);
      compared++;
    }
  }
  assertions += compared; // каждое сравнение гейта — проверка, просто без вызова assert на удаче
  assert.deepEqual([...outcomes].sort(), [...REGIMES, "insufficient", "emergency"].sort(), "сетка обязана проходить все режимы гейта");
  // Детекторы: макрошок из баллов макро-семей и recovery из якоря и трёх ног.
  const half = [null, -2, -1.5, -1, -0.5, 0, 0.5, 1, 2];
  for (const liquidity of half) for (const conditions of half) for (const stress of half) {
    const families = famObject([liquidity, conditions, stress], [0, 0, 0, 0], [0, 0, 0, 0, 0]);
    assert.equal(REAL.macroShockStateV1Port(families.macro), LOCKED.buildDetectors(lockedMetrics(families)).detectors.find(x => x.id === "macro_shock").state, `макрошок: ${liquidity}/${conditions}/${stress}`);
  }
  const leg = [null, -2, -1, -0.5, 0, 0.5, 2];
  for (const percentile of [null, 0, 10, 24.999, 25, 25.001, 60]) for (const trend of leg) for (const etf of leg) for (const exchange of leg) {
    const families = famObject([0, 0, 0], [etf, 0, exchange, 0], [0, 0, 0, 0, trend]);
    const locked = LOCKED.buildDetectors(lockedMetrics(families, percentile)).detectors.find(x => x.id === "recovery");
    const port = REAL.recoveryStateV1Port({ anchor: Number.isFinite(percentile) && percentile < C.scoring.valuation.recovery_anchor_below_percentile, trend, etf, exchangeSupply: exchange });
    assert.equal(port.state, locked.state, `recovery: ${percentile}/${trend}/${etf}/${exchange}`);
    assert.equal(`оценка ${port.anchor ? "низкая" : "не низкая"} · подтверждений ${port.supports}/3`, locked.inputs);
  }
}

// 2.4. Приёмка порта на боевой ленте: кандидат, пересчитанный из баллов ВСЕХ семей, равен опубликованному
// на каждом снимке окна форвард-монитора (уникальные сочетания входов — scripts/variants-gate-fixture.json).
const fixture = JSON.parse(readFileSync(new URL("./variants-gate-fixture.json", import.meta.url), "utf8"));
{
  let snapshots = 0, changedWithoutCftc = 0;
  const seen = new Set();
  for (const [macro, demand, cycle, critical, anchor, shock, distribution, recovery, published, n] of fixture.rows) {
    const families = famObject(macro, demand, cycle), detectors = { macroShockState: shock, distributionState: distribution, recoveryState: recovery };
    assert.equal(REAL.strategicCandidateV1Port({ families, criticalOk: !!critical, ...detectors }), published, `лента: ${JSON.stringify([macro, demand, cycle, shock, recovery])}`);
    assert.equal(REAL.strategicCriticalV1Port(families), !!critical);
    assert.equal(REAL.macroShockStateV1Port(families.macro), shock);
    assert.equal(REAL.recoveryStateV1Port({ anchor: !!anchor, trend: families.cycle.trend, etf: families.demand.etf, exchangeSupply: families.demand.exchange_supply }).state, recovery);
    if (REAL.strategicCandidateV1Port({ families, criticalOk: true, ...detectors, exclude: C.scoring.non_voting_families }) !== published) changedWithoutCftc += n;
    seen.add(published);
    snapshots += n;
  }
  assert.equal(snapshots, fixture.snapshots, "фикстура покрывает каждый снимок окна");
  assert.ok(fixture.rows.length >= 150 && fixture.snapshots >= 6694 && seen.size >= 4);
  assert.ok(changedWithoutCftc > 100, "на ленте есть снимки, где голос CFTC менял кандидата: линия v1_no_cftc не тождественна v1");
}

// =====================================================================================
// 3. Счёт изменённых семей
// =====================================================================================
const checks = {};

// 3.1. Сеть: одна шумная точка не двигает балл; устойчивое падение — двигает; нога сложности — как в v1.
checks.hashrateSmoothed = m => {
  const now = at(10, 6), today = at(10), v1Leg = v => (v > -5 ? 0 : v > -15 ? -1 : -2), v1Point = s => (s.at(-1).v / priorByDays(s, 90).v - 1) * 100;
  const dip = seriesFor(now, { hash: "dip" }), spike = seriesFor(now, { hash: "base_spike" });
  for (const s of [dip, spike]) {
    const r = m.scoreNetworkV3({ hashrate: s.hashrate, difficulty: s.difficulty, now });
    assert.equal(v1Leg(v1Point(s.hashrate)), -2, "точка к точке: −20 % — у v1 это −2");
    assert.equal(r.hashrate_leg, 0, "30-дневные средние: одна точка — это меньше 1 %");
    assert.ok(Math.abs(r.hashrate_change_pct) < 1 && r.score === 0);
  }
  for (const [change, leg] of [[-4.9, 0], [-5.1, -1], [-14.9, -1], [-15.1, -2], [8, 0], [30, 0]]) {
    const r = m.scoreNetworkV3({ ...seriesFor(now, { hash: change }), now });
    assert.ok(Math.abs(r.hashrate_change_pct - change) < 1e-9, "изменение — отношение двух 30-дневных средних");
    assert.equal(r.hashrate_leg, leg, `порог ноги хешрейта при ${change} %`);
    assert.equal(r.score, componentScore([leg, 0]));
  }
  // Сложность: формула и шкала v1 на ряде ретаргетов.
  const base = seriesFor(now, {});
  for (const [change, leg] of [[-4.9, 0], [-5.1, -1], [-15.1, -2]]) {
    const difficulty = base.difficulty.map((p, i, a) => ({ t: p.t, v: i >= a.length - 6 ? p.v * (1 + change / 100) : p.v }));
    const r = m.scoreNetworkV3({ hashrate: base.hashrate, difficulty, now });
    assert.ok(Math.abs(r.difficulty_change_pct - (difficulty.at(-1).v / priorByDays(difficulty, 90).v - 1) * 100) < 1e-12);
    assert.equal(r.difficulty_leg, leg);
    assert.equal(r.score, componentScore([0, leg]));
  }
  // Окно короче двадцати точек, протухший или пустой ряд — ноги нет; семья живёт на оставшейся ноге.
  const sparse = base.hashrate.filter(p => p.t > today - 19 * DAY || p.t <= today - 30 * DAY);
  assert.equal(m.scoreNetworkV3({ hashrate: sparse, difficulty: base.difficulty, now }).hashrate_leg, null);
  assert.equal(m.scoreNetworkV3({ hashrate: base.hashrate.filter(p => p.t > today - 20 * DAY || p.t <= today - 30 * DAY), difficulty: base.difficulty, now }).hashrate_leg, 0);
  const stale = m.scoreNetworkV3({ hashrate: base.hashrate, difficulty: base.difficulty, now: today + 4 * DAY + 1 });
  assert.deepEqual([stale.hashrate_leg, stale.reason, stale.score], [null, "hashrate_stale", 0]);
  assert.equal(m.scoreNetworkV3({ hashrate: base.hashrate, difficulty: base.difficulty, now: today + 4 * DAY }).hashrate_leg, 0, "ровно четыре дня — ещё годен");
  assert.deepEqual([m.scoreNetworkV3({ hashrate: [], difficulty: [], now }).score, m.scoreNetworkV3({ now }).reason], [null, "hashrate_missing"]);
  assert.equal(m.scoreNetworkV3({ hashrate: base.hashrate, difficulty: base.difficulty, now: today - 2 * DAY + 21 * DAY }).difficulty_leg, 0, "ровно три недели — ещё годен");
  assert.equal(m.scoreNetworkV3({ hashrate: base.hashrate, difficulty: base.difficulty, now: today - 2 * DAY + 21 * DAY + 1 }).difficulty_leg, null, "ряд сложности старше трёх недель не голосует");
};

// 3.2. Биржевое предложение: обе ноги по остатку.
function walk(seed, n, lastT, { step = 3000, drift = -40 } = {}) { const rand = rng(seed); let v = 2_700_000; return daily(lastT, n, () => (v = Math.max(1_000_000, Math.round(v + drift + (rand() - 0.5) * 2 * step)))); }
// Независимый счёт: только экспортированные примитивы сборщика и запертый lowGood.
function referenceExchange(s) {
  const changes = [];
  for (let i = 0; i < s.length; i++) { let base = null; for (let j = i - 1; j >= 0; j--) if (s[j].t <= s[i].t - 7 * DAY) { base = s[j]; break; } if (base && s[i].t - base.t <= 9 * DAY) changes.push({ t: s[i].t, v: s[i].v - base.v }); }
  const flow = changes.length && changes.at(-1).t === s.at(-1).t ? changes.at(-1).v : null, flowPct = flow === null ? null : percentileRank(changes.slice(-1460).map(x => x.v), flow);
  const flowLeg = flowPct === null ? null : flow > 0 ? Math.min(LOCKED.lowGood(flowPct), 0) : LOCKED.lowGood(flowPct);
  const history = [];
  for (let i = 1; i < s.length; i++) { const prior = priorByDays(s.slice(0, i + 1), 90); if (prior) history.push((s[i].v / prior.v - 1) * 100); }
  const prior = priorByDays(s, 90), reserve = prior ? (s.at(-1).v / prior.v - 1) * 100 : null, reservePct = percentileRank(history.slice(-1460), reserve);
  const reserveLeg = reservePct === null ? null : reserve > 0 ? Math.min(LOCKED.lowGood(reservePct), 0) : LOCKED.lowGood(reservePct);
  return { flow, flowPct, flowLeg, reserve, reservePct, reserveLeg, score: componentScore([flowLeg, reserveLeg]) };
}
checks.exchangeMatchesReference = m => {
  const now = at(10, 6), seenScores = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6]) for (const n of [1700, 1500, 400, 120]) {
    const series = walk(seed, n, at(9), { drift: [-40, 60, 0, -300, 300, -5][seed - 1] }), ref = referenceExchange(series), r = m.scoreExchangeSupplyV3({ reserve: series, now });
    assert.deepEqual([r.flow_change_btc, r.flow_percentile, r.flow_leg, r.reserve_change_pct, r.reserve_percentile, r.reserve_leg, r.score], [ref.flow, ref.flowPct, ref.flowLeg, ref.reserve, ref.reservePct, ref.reserveLeg, ref.score], `биржи: зерно ${seed}, длина ${n}`);
    seenScores.add(r.score);
  }
  assert.ok(seenScores.size >= 4, "эталонные ряды дают разные баллы");
  // Скользим концом растущего ряда: среди срезов обязаны быть и такие, где рост остатка упирается в экономический ноль.
  let capped = 0;
  for (const [seed, drift] of [[21, 1500], [22, 800]]) {
    const series = walk(seed, 420, at(9), { drift });
    for (let k = 0; k < 40; k++) {
      const part = series.slice(0, series.length - k), ref = referenceExchange(part), r = m.scoreExchangeSupplyV3({ reserve: part, now: part.at(-1).t + DAY + 6 * HOUR });
      assert.deepEqual([r.flow_leg, r.reserve_leg, r.score], [ref.flowLeg, ref.reserveLeg, ref.score], `биржи: зерно ${seed}, срез −${k}`);
      if (ref.flow > 0 && LOCKED.lowGood(ref.flowPct) > 0) capped++;
    }
  }
  assert.ok(capped >= 3, "срезы проходят ветку экономического нуля");
  // На согласованных потоках (поток дня = изменение остатка) нога v3 равна ноге v1: сумма потоков за 7 дней.
  for (const seed of [11, 12, 13]) {
    const series = walk(seed, 1700, at(9)), netflow = series.slice(1).map((p, i) => ({ t: p.t, v: p.v - series[i].v }));
    const sums = netflow.map((p, i) => (i >= 6 ? netflow.slice(i - 6, i + 1).reduce((a, x) => a + x.v, 0) : null)).filter(v => v !== null);
    const nf7 = sums.at(-1), rank = percentileRank(sums.slice(-1460), nf7), v1Leg = nf7 > 0 ? Math.min(LOCKED.lowGood(rank), 0) : LOCKED.lowGood(rank);
    const r = m.scoreExchangeSupplyV3({ reserve: series, now });
    assert.deepEqual([r.flow_change_btc, r.flow_percentile, r.flow_leg], [nf7, rank, v1Leg], "согласованные потоки: v3 обязана совпасть с v1");
  }
};
checks.exchangeEconomicZero = m => {
  const now = at(10, 6);
  // Остаток годами рос по 1 000 BTC в день, последние восемь дней — по 10: рост «рекордно малый», но это рост.
  const rising = daily(at(9), 1700, (i, n) => 2_000_000 + 1000 * Math.min(i, n - 9) + 10 * Math.max(0, i - (n - 9)));
  const r = m.scoreExchangeSupplyV3({ reserve: rising, now });
  assert.ok(r.flow_change_btc > 0 && r.flow_percentile < 10, "малый рост на фоне большого — нижний хвост перцентилей");
  assert.equal(LOCKED.lowGood(r.flow_percentile), 2);
  assert.equal(r.flow_leg, 0, "рост остатка не голосует «за» — экономический ноль");
  assert.ok(r.reserve_change_pct > 0 && r.reserve_leg <= 0);
  assert.equal(r.score, 0);
  // Зеркало: остаток падает быстрее обычного — нога положительна.
  const falling = daily(at(9), 1700, (i, n) => 4_000_000 - 100 * Math.min(i, n - 9) - 3000 * Math.max(0, i - (n - 9)));
  const f = m.scoreExchangeSupplyV3({ reserve: falling, now });
  assert.ok(f.flow_change_btc < 0 && f.flow_leg === 2 && f.score > 0);
  // Дыра в ряду: базы для недельного изменения нет — ноги потоков нет, семья на одной ноге не поддерживает.
  const holed = falling.filter(p => p.t > at(9) - DAY || p.t <= at(9) - 11 * DAY), h = m.scoreExchangeSupplyV3({ reserve: holed, now });
  assert.deepEqual([h.flow_leg, h.flow_change_btc], [null, null]);
  assert.equal(h.score, componentScore([null, h.reserve_leg]));
  assert.ok(h.reserve_leg > 0 && h.score === 0, "семья, потерявшая половину ног, вправе предупреждать, но не поддерживать");
  // Короткий, пустой и протухший ряд.
  assert.deepEqual([m.scoreExchangeSupplyV3({ reserve: falling.slice(-30), now }).score, m.scoreExchangeSupplyV3({ reserve: falling.slice(-30), now }).reason], [null, "exchange_supply_short"]);
  assert.equal(m.scoreExchangeSupplyV3({ reserve: null, now }).reason, "exchange_supply_missing");
  assert.equal(m.scoreExchangeSupplyV3({ reserve: falling, now: at(9) + 4 * DAY + 1 }).reason, "exchange_supply_stale");
  assert.notEqual(m.scoreExchangeSupplyV3({ reserve: falling, now: at(9) + 4 * DAY }).score, null);
};

// 3.3. Оценка: «дёшево» — согласием двух окон, «дорого» — одним окном, как в v1.
checks.valuationTwoWindows = m => {
  const v = (percentile, percentileDeep) => m.scoreValuationV3({ percentile, percentileDeep });
  for (const deep of [null, 0, 5, 50, 99]) {
    assert.equal(v(95, deep).score, -2); assert.equal(v(94.99, deep).score, -1); assert.equal(v(82, deep).score, -1); assert.equal(v(81.99, deep).score, 0);
    assert.deepEqual([v(99, deep).cheap, v(99, deep).anchor], [false, false]);
  }
  assert.deepEqual(v(10, 10), { score: 1, cheap: true, anchor: true, deep_window_used: true });
  assert.deepEqual(v(10, 10.01), { score: 0, cheap: false, anchor: true, deep_window_used: true }, "4-летнее окно говорит «дёшево», история — нет: балла +1 и пола капитуляции нет");
  assert.deepEqual(v(10.01, 5), { score: 0, cheap: false, anchor: true, deep_window_used: true });
  assert.deepEqual(v(24.99, 24.99).anchor, true);
  assert.deepEqual(v(24.99, 25).anchor, false, "якорь recovery тоже требует согласия");
  assert.deepEqual(v(25, 5).anchor, false);
  // Честный откат: глубокого окна нет — правило работает по одному окну, как v1, и говорит об этом.
  assert.deepEqual(v(8, null), { score: 1, cheap: true, anchor: true, deep_window_used: false });
  assert.deepEqual(v(20, undefined), { score: 0, cheap: false, anchor: true, deep_window_used: false });
  for (const junk of [null, undefined, NaN, "42", Infinity]) assert.deepEqual(v(junk, 5), { score: null, cheap: false, anchor: false, deep_window_used: false });
  assert.deepEqual(v(8, NaN).deep_window_used, false);
};
checks.deepWindowGuards = m => {
  const now = at(10, 6), series = (n, lastT) => daily(lastT, n, i => 0.5 + (i * 7919 % 1000) / 400);
  const good = series(2000, at(9)), r = m.mvrvDeepPercentileV3({ mvrvDeep: good, now });
  assert.deepEqual([r.used, r.points, r.reason, r.observed_at], [true, 2000, null, at(9)]);
  assert.equal(r.percentile, percentileRank(good.map(p => p.v), good.at(-1).v), "перцентиль по всей истории — тем же percentileRank");
  assert.deepEqual([m.mvrvDeepPercentileV3({ mvrvDeep: series(1999, at(9)), now }).percentile, m.mvrvDeepPercentileV3({ mvrvDeep: series(1999, at(9)), now }).reason], [null, "mvrv_deep_short"]);
  assert.equal(m.mvrvDeepPercentileV3({ mvrvDeep: good, now: at(9) + 5 * DAY }).used, true, "ровно пять дней — ещё годно");
  assert.deepEqual([m.mvrvDeepPercentileV3({ mvrvDeep: good, now: at(9) + 5 * DAY + 1 }).used, m.mvrvDeepPercentileV3({ mvrvDeep: good, now: at(9) + 5 * DAY + 1 }).reason], [false, "mvrv_deep_stale"]);
  for (const missing of [null, undefined, [], "ряд", 5]) assert.deepEqual([m.mvrvDeepPercentileV3({ mvrvDeep: missing, now }).used, m.mvrvDeepPercentileV3({ mvrvDeep: missing, now }).reason], [false, "mvrv_deep_missing"]);
};

// 3.4. Тренд: по последнему закрытому дню, пороги v1.
checks.trendClosedDay = m => {
  const now = at(10, 6), today = at(10);
  for (const [shape, score] of [["up", 2], ["mixed", 0], ["below", -1], ["below200w", -2]]) {
    const closed = seriesFor(now, { price: shape }).price_daily.slice(0, -1), expected = m.scoreTrendV3({ priceDaily: closed, now });
    assert.equal(expected.score, score, `форма ряда ${shape}`);
    assert.deepEqual([expected.closed_at, expected.close], [today - DAY, closed.at(-1).v]);
    // Незакрытая свеча — любая, вплоть до абсурдной — на счёт не влияет.
    for (const unclosed of [1, closed.at(-1).v, 500_000]) assert.deepEqual(m.scoreTrendV3({ priceDaily: [...closed, { t: today, v: unclosed }], now }), expected, `незакрытая свеча ${unclosed}`);
  }
  // v1 на тех же рядах считала бы по живой цене и средним с незакрытой свечой: внутридневной всплеск менял балл.
  const below = seriesFor(now, { price: "below", unclosed: 130_000 }).price_daily, mean = a => a.reduce((s, x) => s + x.v, 0) / a.length;
  const live = below.at(-1).v, v1 = live > mean(below.slice(-200)) && live > mean(below.slice(-140)) ? 2 : 0;
  assert.equal(v1, 2);
  assert.equal(m.scoreTrendV3({ priceDaily: below, now }).score, -1, "по закрытому дню рынок всё ещё ниже обеих средних");
  // Свеча становится закрытой ровно в полночь следующих суток.
  assert.equal(m.scoreTrendV3({ priceDaily: below, now: today + DAY - 1 }).closed_at, today - DAY);
  assert.deepEqual([m.scoreTrendV3({ priceDaily: below, now: today + DAY }).closed_at, m.scoreTrendV3({ priceDaily: below, now: today + DAY }).score], [today, 2]);
  // Средние — по точкам закрытых дней; короче 200 дней тренда нет, короче 1 400 — нет ступени −2.
  const closedBelow = seriesFor(now, { price: "below200w" }).price_daily.slice(0, -1);
  assert.deepEqual([m.scoreTrendV3({ priceDaily: closedBelow.slice(-199), now }).score, m.scoreTrendV3({ priceDaily: closedBelow.slice(-199), now }).reason], [null, "price_short"]);
  assert.equal(m.scoreTrendV3({ priceDaily: closedBelow.slice(-200), now }).score, -1);
  assert.equal(m.scoreTrendV3({ priceDaily: closedBelow.slice(-1399), now }).score, -1);
  assert.equal(m.scoreTrendV3({ priceDaily: closedBelow.slice(-1400), now }).score, -2);
  assert.equal(m.scoreTrendV3({ priceDaily: closedBelow, now: today + 3 * DAY + 1 }).reason, "price_stale");
  assert.equal(m.scoreTrendV3({ priceDaily: [], now }).reason, "price_missing");
  assert.equal(m.scoreTrendV3({ priceDaily: [{ t: today, v: 90_000 }], now }).reason, "price_missing", "одна незакрытая свеча — это ещё не ряд");
};

// =====================================================================================
// 4. Суточный такт
// =====================================================================================
const isFix = (variants, key) => variants[key].reason_codes.includes("fix");

// 4.1. Ровно один фикс в сутки при такте 15 минут — на всех днях недели и через границу года.
checks.fixOncePerDayAtSix = m => {
  for (const startDay of [0, 1, 2, 3, 4, 5, 6, 57]) { // 57 → вторник 29.12.2026: окно уходит в 2027 год
    const steps = Array.from({ length: 4 * 96 + 30 }, (_, k) => [at(startDay, 0, 7) + k * 15 * MIN, {}]), { outs } = drive(m, steps);
    for (const key of DAILY) {
      const fixes = steps.filter((_, i) => isFix(outs[i], key)).map(([now]) => now);
      assert.deepEqual(fixes, [0, 1, 2, 3, 4].map(d => at(startDay + d, 6, 7)), `${key}: фикс — первый снимок суток не раньше 06:00 UTC (старт в день ${startDay})`);
      steps.forEach(([now], i) => {
        const v = outs[i][key], day = Math.floor(now / DAY), done = now - day * DAY >= 6 * HOUR + 7 * MIN;
        assert.equal(v.fix_at, i === 0 || !done && day === Math.floor(steps[0][0] / DAY) ? iso(steps[0][0]) : iso((done ? day : day - 1) * DAY + 6 * HOUR + 7 * MIN), `${key}: момент последнего фикса`);
        assert.equal(v.next_fix_at, iso((done ? day + 1 : day) * DAY + 6 * HOUR), `${key}: момент следующего фикса`);
        assert.equal(v.target_pct, 45);
      });
    }
    assert.ok(outs[0].policy_v3_shadow.reason_codes.includes("cold_start") && outs[1].policy_v3_shadow.reason_codes.includes("between_fixes"));
  }
  if (m === REAL) assert.equal(iso(at(57 + 4, 6, 7)).slice(0, 10), "2027-01-02");
};

// 4.2. Пропуск снимков в 06:00, дыры больше суток, холодный старт до и после часа фикса.
checks.fixClockEdges = m => {
  const clock = (now, last) => m.fixClockV3(now, last), day = Math.floor(at(3) / DAY);
  assert.deepEqual(clock(at(3, 5, 59), day - 1), { day, due: false, next_at: at(3, 6) });
  assert.deepEqual(clock(at(3, 6), day - 1), { day, due: true, next_at: at(3, 6) });
  assert.deepEqual(clock(at(3, 6), day), { day, due: false, next_at: at(4, 6) }, "сегодня фикс уже был");
  assert.deepEqual(clock(at(3, 23, 59), day - 3), { day, due: true, next_at: at(3, 6) });
  assert.deepEqual(clock(at(3, 3), day - 3).due, false, "снимок до 06:00 фиксом не бывает даже после дыры");
  for (const garbage of [null, undefined, NaN]) assert.equal(clock(at(3, 7), garbage).due, true);
  // Снимков между 05:45 и 09:30 не было: фикс — в 09:30; следующий — завтра не раньше 06:00.
  let { outs } = drive(m, [[at(0, 12), {}], [at(1, 5, 45), { cand: "defensive" }], [at(1, 9, 30), { cand: "defensive" }], [at(1, 9, 45), { cand: "transition" }], [at(2, 5, 59), { cand: "transition" }], [at(2, 6, 1), { cand: "defensive" }]]);
  for (const key of DAILY) {
    assert.deepEqual(outs.map(v => isFix(v, key)), [false, false, true, false, false, true], `${key}: пропуск 06:00`);
    assert.deepEqual(outs.map(v => v[key].target_pct), [45, 45, 5, 5, 5, 5]);
    assert.equal(outs[2][key].fix_at, iso(at(1, 9, 30)));
  }
  // Дыра 2,5 суток: первый же снимок не раньше 06:00 — фикс; снимок в 03:00 после дыры — нет.
  ({ outs } = drive(m, [[at(0, 12), {}], [at(3, 3), { cand: "defensive" }], [at(3, 6, 15), { cand: "defensive" }]]));
  for (const key of DAILY) {
    assert.deepEqual(outs.map(v => isFix(v, key)), [false, false, true], `${key}: дыра больше суток`);
    assert.ok(outs[2][key].reason_codes.includes("missed_fix_reset"));
    assert.deepEqual(outs.map(v => v[key].target_pct), [45, 45, 5]);
  }
  // Границы суток и часа фикса с точностью до миллисекунды, в том числе в новогоднюю ночь.
  for (const d of [1, 59]) { // 59 → 31.12.2026: полночь — уже 2027 год
    ({ outs } = drive(m, [[at(d, 12), {}], [at(d + 1) - 1, { cand: "defensive" }], [at(d + 1), { cand: "defensive" }], [at(d + 1, 6) - 1, { cand: "defensive" }], [at(d + 1, 6), { cand: "defensive" }], [at(d + 2) - 1, { cand: "constructive" }], [at(d + 2), { cand: "constructive" }]]));
    for (const key of DAILY) {
      assert.deepEqual(outs.map(v => isFix(v, key)), [false, false, false, false, true, false, false], `${key}: границы суток (день ${d})`);
      assert.deepEqual(outs.map(v => v[key].next_fix_at), [iso(at(d + 1, 6)), iso(at(d + 1, 6)), iso(at(d + 1, 6)), iso(at(d + 1, 6)), iso(at(d + 2, 6)), iso(at(d + 2, 6)), iso(at(d + 2, 6))]);
    }
  }
  if (m === REAL) assert.equal(iso(at(60)), "2027-01-01T00:00:00.000Z");
  // Холодный старт — сам фикс: старт в 03:00 ждёт 06:00 тех же суток, старт в 07:00 — следующих.
  ({ outs } = drive(m, [[at(0, 3), {}], [at(0, 6), { cand: "defensive" }]]));
  for (const key of DAILY) assert.deepEqual([outs[0][key].next_fix_at, isFix(outs[1], key), outs[1][key].target_pct], [iso(at(0, 6)), true, 5]);
  ({ outs } = drive(m, [[at(0, 7), {}], [at(0, 23), { cand: "defensive" }], [at(1, 6), { cand: "defensive" }]]));
  for (const key of DAILY) assert.deepEqual([outs[0][key].next_fix_at, isFix(outs[1], key), outs[1][key].target_pct, isFix(outs[2], key), outs[2][key].target_pct], [iso(at(1, 6)), false, 45, true, 5]);
  // Время — параметром в любой законной форме.
  const inputs = mk(at(0, 7));
  assert.deepEqual(call(m, { now: iso(at(0, 7)), inputs, state: null }), call(m, { now: at(0, 7), inputs, state: null }));
  assert.deepEqual(call(m, { now: new Date(at(0, 7)), inputs, state: null }), call(m, { now: at(0, 7), inputs, state: null }));
};

// 4.3. Гистерезис в фиксах: лучше — на втором фиксе подряд с тем же кандидатом.
checks.upgradeNeedsTwoFixes = m => {
  const { outs } = drive(m, [
    [at(0, 6), { cand: "deteriorating" }],                                    // холодный старт: 20 %
    [at(1, 6), { cand: "transition", state: "deteriorating" }],               // первый фикс с «лучше»
    [at(1, 12), { cand: "transition", state: "deteriorating" }],              // внутри суток счёт не идёт
    [at(2, 6), { cand: "transition", state: "deteriorating" }],               // второй подряд — принят
    [at(3, 6), { cand: "unconfirmed_positive", state: "transition" }],        // «лучше» №1
    [at(4, 6), { cand: "constructive", state: "transition" }],                // другой «лучший» — счёт заново
    [at(5, 6), { cand: "constructive", state: "transition" }],                // принят
    [at(6, 6), { cand: "defensive", state: "constructive" }],                 // вниз — сразу
    [at(7, 6), { cand: "transition", state: "defensive" }],                   // «лучше» №1
    [at(8, 6), { cand: "defensive", state: "defensive" }],                    // вернулся — счёт сброшен
    [at(9, 6), { cand: "transition", state: "defensive" }],                   // снова №1, не принят
    [at(10, 6), { cand: "transition", state: "defensive" }],                  // принят
  ]);
  for (const key of DAILY) {
    assert.deepEqual(outs.map(v => v[key].target_pct), [20, 20, 20, 45, 45, 45, 100, 5, 5, 5, 5, 45], `${key}: путь цели`);
    assert.deepEqual(outs.map(v => v[key].state), ["deteriorating", "deteriorating", "deteriorating", "transition", "transition", "transition", "constructive", "defensive", "defensive", "defensive", "defensive", "transition"]);
    assert.deepEqual(outs[1][key].pending, { candidate: "transition", fixes: 1, need: 2 });
    assert.ok(outs[1][key].reason_codes.includes("upgrade_pending:transition:1/2"));
    assert.deepEqual(outs[2][key].pending, { candidate: "transition", fixes: 1, need: 2 });
    assert.equal(outs[3][key].pending, null);
    assert.deepEqual([outs[4][key].pending.candidate, outs[5][key].pending], ["unconfirmed_positive", { candidate: "constructive", fixes: 1, need: 2 }]);
    assert.deepEqual([outs[8][key].pending.candidate, outs[9][key].pending, outs[10][key].pending.fixes], ["transition", null, 1]);
  }
  const step = m.dailyHysteresisStepV3;
  assert.deepEqual(step({ s: "defensive", p: "transition", n: 1 }, "transition"), { s: "transition", p: null, n: 0 });
  assert.deepEqual(step({ s: "defensive", p: "transition", n: 1 }, "transition", { consecutive: false }), { s: "defensive", p: "transition", n: 1 });
  assert.deepEqual(step({ s: "defensive", p: "transition", n: 1 }, "deteriorating"), { s: "defensive", p: "deteriorating", n: 1 });
};
checks.downgradeImmediate = m => {
  const { outs } = drive(m, [
    [at(0, 6), { cand: "constructive" }],
    [at(1, 6), { cand: "transition", state: "constructive" }],                // хуже — на этом же фиксе
    [at(2, 6), { cand: "constructive", state: "transition" }],                // идёт повышение…
    [at(3, 6), { cand: "defensive", state: "transition" }],                   // …но пришло «хуже»: сразу и без остатка счёта
    [at(4, 6), { cand: "deteriorating", state: "defensive" }],
  ]);
  for (const key of DAILY) {
    assert.deepEqual(outs.map(v => v[key].target_pct), [100, 45, 45, 5, 5], `${key}: понижение принимается на том же фиксе`);
    assert.deepEqual([outs[2][key].pending.candidate, outs[3][key].pending, outs[4][key].pending], ["constructive", null, { candidate: "deteriorating", fixes: 1, need: 2 }]);
  }
};
checks.betweenFixesHold = m => {
  const steps = [[at(0, 6), {}]];
  for (const [hour, cand] of [[7, "defensive"], [9, "constructive"], [13, "deteriorating"], [23, "defensive"]]) steps.push([at(0, hour), { cand, state: "transition" }]);
  steps.push([at(1, 0, 15), { cand: "defensive", state: "transition" }], [at(1, 5, 45), { cand: "defensive", state: "transition" }], [at(1, 6), { cand: "deteriorating", state: "transition" }], [at(1, 6, 15), { cand: "constructive", state: "transition" }]);
  const { outs } = drive(m, steps);
  for (const key of DAILY) {
    assert.deepEqual(outs.map(v => v[key].target_pct), [45, 45, 45, 45, 45, 45, 45, 20, 20], `${key}: между фиксами цель не меняется`);
    assert.deepEqual(outs.map(v => v[key].reason_codes[0]), ["cold_start", "between_fixes", "between_fixes", "between_fixes", "between_fixes", "between_fixes", "between_fixes", "fix", "between_fixes"]);
    assert.equal(outs[7][key].candidate, "deteriorating", "фикс читает кандидата своего снимка, а не дневную историю");
  }
};

// 4.4. Недостаток данных: цель не меняется, фикс откладывается, подтверждение не проскакивает.
checks.insufficientHolds = m => {
  const dead = { cand: "insufficient", state: "insufficient", critical: false };
  let { outs } = drive(m, [
    [at(0, 6), { cand: "deteriorating" }],
    [at(1, 6), { cand: "transition", state: "deteriorating" }],               // повышение: 1/2
    [at(2, 6), dead],                                                          // в час фикса данных нет
    [at(2, 6, 15), dead],
    [at(2, 6, 30), { cand: "transition", state: "deteriorating" }],           // данные вернулись — это и есть фикс суток
    [at(2, 9), dead],                                                          // после фикса провал уже ничего не меняет
  ]);
  for (const key of DAILY) {
    assert.deepEqual(outs.map(v => v[key].target_pct), [20, 20, null, null, 45, 45], `${key}: отложенный фикс`);
    for (const i of [2, 3]) assert.ok(["fix_deferred", "insufficient_data"].every(code => outs[i][key].reason_codes.includes(code)), "причина названа кодом");
    assert.deepEqual([isFix(outs[4], key), outs[4][key].fix_at, outs[5][key].reason_codes[0]], [true, iso(at(2, 6, 30)), "between_fixes"]);
  }
  assert.deepEqual([outs[2].v1_no_cftc.target_pct, outs[2].v1_no_cftc.state, outs[2].v1_floor_handoff.target_pct], [null, "insufficient", null]);
  assert.ok(outs[2].v1_no_cftc.reason_codes.includes("insufficient_data"));
  // Сутки без данных целиком: возврат не проскакивает подтверждение — счёт повышения начинается заново.
  ({ outs } = drive(m, [
    [at(0, 6), { cand: "deteriorating" }],
    [at(1, 6), { cand: "transition", state: "deteriorating" }],
    [at(2, 6), dead], [at(2, 14), dead], [at(2, 23, 45), dead],
    [at(3, 6), { cand: "transition", state: "deteriorating" }],
    [at(4, 6), { cand: "transition", state: "deteriorating" }],
  ]));
  for (const key of DAILY) {
    assert.deepEqual(outs.map(v => v[key].target_pct), [20, 20, null, null, null, 20, 45], `${key}: возврат из insufficient`);
    assert.deepEqual(outs[5][key].pending, { candidate: "transition", fixes: 1, need: 2 });
    assert.ok(outs[5][key].reason_codes.includes("missed_fix_reset"));
  }
  // Своя слепота кандидата: v1 считается, а рядов сети нет — обязательная семья не посчитана.
  ({ outs } = drive(m, [[at(0, 6), {}], [at(1, 6), { cand: "defensive", state: "transition", s: { noHash: true, noDifficulty: true } }], [at(1, 7), { cand: "defensive", state: "transition" }]]));
  assert.deepEqual(outs.map(v => v.v1_daily_close.target_pct), [45, 5, 5]);
  assert.deepEqual(outs.map(v => v.policy_v3_shadow.target_pct), [45, null, 5]);
  assert.ok(["fix_deferred", "insufficient_data", "network_unavailable:hashrate_missing"].every(code => outs[1].policy_v3_shadow.reason_codes.includes(code)));
  assert.equal(outs[1].policy_v3_shadow.state, "transition", "слепая линия держит состояние");
  // Одна нога семьи жива — семья считается по ней, как в v1, и фикс состоится; потеря ноги помечена.
  ({ outs } = drive(m, [[at(0, 6), {}], [at(1, 6), { cand: "defensive", state: "transition", s: { noHash: true } }]]));
  assert.deepEqual([outs[1].policy_v3_shadow.target_pct, outs[1].policy_v3_shadow.reason_codes.includes("network_partial:hashrate_missing")], [5, true]);
  ({ outs } = drive(m, [[at(0, 6), {}], [at(1, 6), { cand: "defensive", state: "transition", s: { noPrice: true } }]]));
  assert.ok(outs[1].policy_v3_shadow.target_pct === null && outs[1].policy_v3_shadow.reason_codes.includes("trend_unavailable:price_missing"));
  // Необязательная семья (биржи при живых стейблкоинах) фикс не останавливает: блок усредняется по имеющимся.
  ({ outs } = drive(m, [[at(0, 6), {}], [at(1, 6), { cand: "deteriorating", state: "transition", s: { noReserve: true } }]]));
  assert.deepEqual([outs[1].policy_v3_shadow.target_pct, outs[1].policy_v3_shadow.inputs.blocks.demand], [5 + 15, -50]);
  assert.ok(outs[1].policy_v3_shadow.reason_codes.includes("exchange_supply_unavailable:exchange_supply_missing"));
};

// 4.5. Пропущенные сутки обнуляют счёт подтверждений и ступени пола.
const RECOVERY = { cand: "defensive", mvrv: 20, s: { deep: 20 } }; // якорь в обоих окнах; тренд +2 и биржи 0 — два подтверждения
checks.gapResetsStreaks = m => {
  let { outs } = drive(m, [
    [at(0, 6), { cand: "deteriorating" }],
    [at(1, 6), { cand: "transition", state: "deteriorating" }],               // 1/2
    [at(3, 6), { cand: "transition", state: "deteriorating" }],               // суток 2 не было — снова 1/2
    [at(4, 6), { cand: "transition", state: "deteriorating" }],
  ]);
  for (const key of DAILY) {
    assert.deepEqual(outs.map(v => v[key].target_pct), [20, 20, 20, 45], `${key}: ненаблюдённые сутки ничего не подтверждают`);
    assert.deepEqual([outs[2][key].pending, outs[2][key].reason_codes.includes("missed_fix_reset")], [{ candidate: "transition", fixes: 1, need: 2 }, true]);
  }
  ({ outs } = drive(m, [[at(0, 6), { cand: "defensive" }], [at(1, 6), RECOVERY], [at(2, 6), RECOVERY], [at(4, 6), RECOVERY], [at(5, 6), RECOVERY]]));
  assert.deepEqual(outs.map(v => v.policy_v3_shadow.floor.closes), [0, 1, 2, 1, 2], "пол после дыры начинает с первой ступени");
  assert.deepEqual(outs.map(v => v.policy_v3_shadow.target_pct), [5, 40, 60, 45, 60]);
};

// =====================================================================================
// 5. Правила линий
// =====================================================================================

// 5.1. Аварийный режим: ноль сразу на любом снимке у всех линий; фикс во время аварии не тратится.
checks.emergencyImmediate = m => {
  const hard = { cand: "emergency", state: "emergency", hard: true, target: 0 };
  const { outs } = drive(m, [
    [at(0, 6), {}],
    [at(0, 14), hard],
    [at(0, 14, 15), {}],
    [at(1, 5, 45), hard], [at(1, 6), hard], [at(1, 6, 15), hard],
    [at(1, 6, 30), { cand: "deteriorating", state: "transition" }],
  ]);
  // После аварии v1_no_cftc ведёт себя как stabilizeCore: возвращается к якорю, но не выше сегодняшнего кандидата.
  assert.deepEqual(outs.map(v => targets(v)), [[45, 45, 45, 45], [0, 0, 0, 0], [45, 45, 45, 45], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [20, 20, 45, 20]]);
  for (const key of LINE_KEYS) {
    assert.deepEqual([outs[1][key].state, outs[1][key].binding_overlays], ["emergency", ["emergency_override"]], `${key}: аварийный режим`);
    assert.ok(outs[1][key].reason_codes.includes("emergency_override"));
  }
  for (const key of DAILY) {
    assert.deepEqual([outs[3][key].reason_codes.includes("fix_deferred"), outs[4][key].reason_codes.includes("fix_deferred"), isFix(outs[4], key), isFix(outs[6], key)], [false, true, false, true], `${key}: фикс ждёт конца аварии`);
    assert.equal(outs[6][key].fix_at, iso(at(1, 6, 30)));
  }
  // Флаг аварии при ещё не сменившемся кандидате v1: фикс всё равно не тратится на аварийный снимок.
  const flagged = drive(m, [[at(0, 6), {}], [at(1, 6), { cand: "defensive", state: "transition", hard: true }], [at(1, 6, 15), { cand: "transition" }]]).outs;
  for (const key of DAILY) assert.deepEqual(flagged.map(v => [v[key].target_pct, isFix(v, key)]), [[45, false], [0, false], [45, true]], `${key}: авария в час фикса`);
  // Признак аварии читается и из режима v1, и из флага — в любой из форм, в которых его может прислать сборщик.
  for (const inputs of [{ ...mk(at(2, 9)), hard_override: "НАРУШЕНИЕ ЦЕЛОСТНОСТИ РЫНКА" }, mk(at(2, 9), { state: "emergency", cand: "transition" }), mk(at(2, 9), { state: "transition", cand: "emergency" })])
    assert.deepEqual(targets(call(m, { now: at(2, 9), inputs, state: null }).variants), [0, 0, 0, 0]);
};

// 5.2. Пол кандидата: ступени 40 / 60 / 80 по фиксам подряд, сброс, макрошок, без удержания.
checks.floorGraduates = m => {
  const { outs } = drive(m, [[at(0, 6), { cand: "defensive" }], [at(1, 6), RECOVERY], [at(1, 18), RECOVERY], [at(2, 6), RECOVERY], [at(3, 6), RECOVERY], [at(4, 6), RECOVERY]]);
  const v3 = outs.map(v => v.policy_v3_shadow);
  assert.deepEqual(v3.map(v => v.target_pct), [5, 40, 40, 60, 80, 80], "пол растёт по фиксу, а не по снимку");
  assert.deepEqual(v3.map(v => v.floor), [
    { active: false, rung: null, level_pct: null, closes: 0 }, { active: true, rung: 1, level_pct: 40, closes: 1 }, { active: true, rung: 1, level_pct: 40, closes: 1 },
    { active: true, rung: 2, level_pct: 60, closes: 2 }, { active: true, rung: 3, level_pct: 80, closes: 3 }, { active: true, rung: 3, level_pct: 80, closes: 3 }]);
  // Право recovery поднимать вердикт — как в v1: кандидат «переходный», принят на втором фиксе.
  assert.deepEqual(v3.map(v => [v.candidate, v.state, v.base_target_pct]), [["defensive", "defensive", 5], ["transition", "defensive", 5], ["transition", "defensive", 5], ["transition", "transition", 45], ["transition", "transition", 45], ["transition", "transition", 45]]);
  for (const i of [1, 3, 4]) assert.deepEqual([v3[i].binding_overlays, v3[i].inputs.recovery], [["recovery_floor"], { state: "good", anchor: true, supports: 2 }]);
  // Нулевые баллы всех трёх ног — подтверждение (требования строго положительной ноги нет).
  const zeros = drive(m, [[at(0, 6), { cand: "defensive" }], [at(1, 6), { ...RECOVERY, fam: { demand: { etf: 0, stablecoins: -2 } }, s: { deep: 20, price: "mixed" } }]]).outs[1].policy_v3_shadow;
  assert.deepEqual([zeros.inputs.families.trend.v3, zeros.inputs.recovery, zeros.floor.closes], [0, { state: "good", anchor: true, supports: 3 }, 1]);
  // Пол не опускает базу, которая выше ступени.
  const high = drive(m, [[at(0, 6), { cand: "constructive" }], [at(1, 6), { cand: "constructive", mvrv: 20, s: { deep: 20 } }]]).outs[1].policy_v3_shadow;
  assert.deepEqual([high.target_pct, high.floor.closes, high.binding_overlays], [100, 1, []]);
  // Макрошок запрещает и пол, и подъём вердикта.
  const shock = drive(m, [[at(0, 6), { cand: "defensive" }], [at(1, 6), { ...RECOVERY, fam: { macro: { liquidity: -1, conditions: -1, stress: -1 } } }]]).outs[1].policy_v3_shadow;
  assert.deepEqual([shock.target_pct, shock.floor.closes, shock.candidate, shock.inputs.macro_shock_state, shock.inputs.recovery.state], [5, 0, "defensive", "fired", "good"]);
};
checks.floorResets = m => {
  const lost = { cand: "defensive", mvrv: 30, s: { deep: 20 } }; // оценка выросла выше 25-го перцентиля: якоря нет, подтверждения на месте
  const { outs } = drive(m, [[at(0, 6), { cand: "defensive" }], [at(1, 6), RECOVERY], [at(2, 6), RECOVERY], [at(3, 6), RECOVERY], [at(4, 6), lost], [at(5, 6), RECOVERY], [at(6, 6), RECOVERY]]);
  const v3 = outs.map(v => v.policy_v3_shadow);
  assert.deepEqual(v3.map(v => v.target_pct), [5, 40, 60, 80, 5, 40, 60], "удержания после ухода якоря нет: пол снят тем же фиксом и заново растёт с первой ступени");
  assert.deepEqual(v3.map(v => v.floor.closes), [0, 1, 2, 3, 0, 1, 2]);
  assert.deepEqual([v3[4].inputs.recovery, v3[4].binding_overlays, v3[4].state], [{ state: "calm", anchor: false, supports: 2 }, [], "defensive"]);
  // Подтверждения потеряны при живом якоре — то же самое.
  const weak = drive(m, [[at(0, 6), { cand: "defensive" }], [at(1, 6), RECOVERY], [at(2, 6), { ...RECOVERY, s: { deep: 20, price: "below" } }]]).outs[2].policy_v3_shadow;
  assert.deepEqual([weak.target_pct, weak.floor.closes, weak.inputs.recovery], [5, 0, { state: "watch", anchor: true, supports: 1 }]);
};

// 5.3. Согласие двух окон в движке: якорь recovery и пол капитуляции; честный откат на одно окно.
checks.twoWindowsInEngine = m => {
  const fix = o => drive(m, [[at(0, 6), { cand: "defensive" }], [at(1, 6), { cand: "defensive", ...o }]]).outs[1].policy_v3_shadow;
  const agree = fix({ mvrv: 8, s: { deep: 5, price: "below" } });
  assert.deepEqual([agree.target_pct, agree.binding_overlays, agree.inputs.families.valuation.v3, agree.inputs.deep_window_used], [40, ["capitulation_floor"], 1, true]);
  const disagree = fix({ mvrv: 8, s: { deep: 30, price: "below" } });
  assert.deepEqual([disagree.target_pct, disagree.binding_overlays, disagree.inputs.families.valuation.v3], [5, [], 0], "4-летнее окно «дёшево», история — нет: пола капитуляции нет");
  assert.ok(disagree.inputs.mvrv_percentile_deep > 25 && disagree.inputs.mvrv_percentile === 8);
  for (const deep of [null, "short", "stale"]) {
    const fallback = fix({ mvrv: 8, s: { deep, price: "below" } });
    assert.deepEqual([fallback.target_pct, fallback.binding_overlays, fallback.inputs.deep_window_used, fallback.inputs.mvrv_percentile_deep], [40, ["capitulation_floor"], false, null], `откат на одно окно (${deep})`);
    assert.ok(fallback.reason_codes.some(code => code.startsWith("mvrv_single_window:mvrv_deep_")), "откат помечен кодом");
    assert.ok(drive(m, [[at(0, 6), {}], [at(1, 6), { s: { deep } }], [at(1, 9), {}]]).outs[2].policy_v3_shadow.reason_codes.some(code => code.startsWith("mvrv_single_window")), "пометка видна и между фиксами");
  }
  // Якорь recovery: одно окно ниже 25, другое выше — восстановления нет.
  assert.deepEqual([fix({ mvrv: 20, s: { deep: 40 } }).inputs.recovery, fix({ mvrv: 20, s: { deep: 40 } }).target_pct], [{ state: "calm", anchor: false, supports: 2 }, 5]);
  assert.deepEqual([fix({ mvrv: 20, s: { deep: 20 } }).inputs.recovery.state, fix({ mvrv: 20, s: { deep: null } }).inputs.recovery.state], ["good", "good"]);
  // Без MVRV оценки нет вовсе: оптимизма быть не может (гейт оценки v1), линия при этом считается.
  const blind = drive(m, [[at(0, 6), {}], [at(1, 6), { cand: "constructive", state: "transition", mvrv: null }], [at(2, 6), { cand: "constructive", state: "transition", mvrv: null }]]).outs[2].policy_v3_shadow;
  assert.deepEqual([blind.candidate, blind.target_pct, blind.inputs.families.valuation.v3], ["transition", 45, null]);
  assert.ok(blind.reason_codes.includes("valuation_unavailable"));
  const pricey = drive(m, [[at(0, 6), {}], [at(1, 6), { cand: "constructive", state: "transition", mvrv: 85 }], [at(2, 6), { cand: "constructive", state: "transition", mvrv: 85 }]]).outs[2];
  assert.deepEqual([pricey.policy_v3_shadow.candidate, pricey.policy_v3_shadow.target_pct, pricey.policy_v3_shadow.inputs.families.valuation.v3], ["transition", 45, -1], "дорогая сторона — по одному окну, как в v1");
};

// 5.4. CFTC не голосует — ни в кандидате, ни в линии v1_no_cftc.
checks.cftcDoesNotVote = m => {
  const exclude = m.POLICY_V3_CANDIDATE.scoring.non_voting_families;
  const bear = familiesOf("transition", { demand: { etf: -0.5, stablecoins: -0.5, institutional: -1 } }), bull = familiesOf("transition", { demand: { etf: 0.5, stablecoins: 0.5, institutional: 1 } });
  const gate = (families, ex) => m.strategicCandidateV1Port({ families, criticalOk: true, macroShockState: "calm", distributionState: "calm", recoveryState: "calm", exclude: ex });
  assert.deepEqual([gate(bear, []), gate(bear, exclude)], ["deteriorating", "transition"], "−1 от CFTC доводил спрос до −25; без него −16,7");
  assert.deepEqual([gate(bull, []), gate(bull, exclude)], ["constructive", "transition"], "+1 от CFTC доводил спрос до +25; без него +16,7");
  assert.deepEqual([m.blockScoresV1Port(bear).demand, m.blockScoresV1Port(bear, exclude).demand], [-25, (-1 / 3) / 2 * 100]);
  const { outs } = drive(m, [[at(0, 6), { cand: "deteriorating", families: bear }], [at(1, 6), { cand: "deteriorating", families: bear }], [at(2, 6), { cand: "deteriorating", families: bear }]]);
  assert.deepEqual(outs.map(v => v.v1_daily_close.target_pct), [20, 20, 20]);
  assert.deepEqual(outs.map(v => v.policy_v3_shadow.target_pct), [20, 20, 45], "кандидат видит «переходный» и принимает его на втором фиксе");
  assert.deepEqual([outs[1].policy_v3_shadow.candidate, outs[1].policy_v3_shadow.inputs.families.institutional, outs[1].policy_v3_shadow.inputs.blocks.demand], ["transition", { v3: null, v1: -1 }, -16.67]);
  assert.deepEqual(outs.map(v => [v.v1_no_cftc.candidate, v.v1_no_cftc.demand_block]), [["transition", -16.67], ["transition", -16.67], ["transition", -16.67]]);
  // Семьи CFTC нет вовсе (источник лёг): блок по-прежнему среднее имеющихся.
  const missing = familiesOf("deteriorating", { demand: { institutional: null } });
  assert.equal(call(m, { now: at(0, 6), inputs: mk(at(0, 6), { cand: "deteriorating", families: missing }), state: null }).variants.v1_no_cftc.candidate, "deteriorating");
};

// 5.5. Потолка эйфории и «Дистрибуции» у кандидата нет.
checks.noDeadRules = m => {
  const { outs } = drive(m, [[at(0, 6), {}], [at(1, 6), { cand: "deteriorating", state: "transition", families: familiesOf("transition"), distribution: "fired" }], [at(1, 7), { cand: "deteriorating", state: "transition", families: familiesOf("transition"), distribution: "fired" }]]);
  assert.deepEqual([outs[1].policy_v3_shadow.candidate, outs[1].policy_v3_shadow.target_pct], ["transition", 45], "«Дистрибуция» вердикт кандидата не понижает");
  assert.deepEqual([outs[1].v1_daily_close.target_pct, outs[2].v1_no_cftc.candidate, outs[2].v1_no_cftc.target_pct], [20, "deteriorating", 20], "линии атрибуции живут по правам детекторов v1");
  for (const strategic of REGIMES) {
    const decision = m.allocationDecisionV3({ strategic });
    assert.deepEqual(decision, { base_target_pct: POLICY_V1.ladder[strategic], target_pct: POLICY_V1.ladder[strategic], binding_overlays: [], floor_level_pct: null });
    for (const closes of [1, 2, 3, 7]) assert.equal(m.allocationDecisionV3({ strategic, floorCloses: closes }).target_pct, Math.max(POLICY_V1.ladder[strategic], [40, 60, 80][Math.min(closes, 3) - 1]));
    assert.equal(m.allocationDecisionV3({ strategic, cheap: true }).target_pct, Math.max(POLICY_V1.ladder[strategic], 40));
  }
  assert.equal(allocationDecisionV1({ strategic: "constructive", recoveryState: "calm", macroShockState: "calm", mvrvPercentile: 97 }).target_pct, 60);
  assert.equal(m.allocationDecisionV3({ strategic: "constructive" }).target_pct, 100, "потолка эйфории нет: в v1 он не может сработать по построению");
  for (const junk of ["emergency", "insufficient", "нет", null, undefined]) assert.equal(m.allocationDecisionV3({ strategic: junk, floorCloses: 3, cheap: true }).target_pct, null);
};

// 5.6. v1_floor_handoff: включённый пол держится на подтверждениях, а не на якоре оценки.
checks.handoffRules = m => {
  const base = { cand: "defensive", state: "defensive" }, live = { ...base, recovery: "good", mvrv: 20 };
  const supports = n => ({ fam: { demand: { etf: n >= 2 ? 0 : -1, exchange_supply: n >= 3 ? 0 : -1 }, cycle: { trend: n >= 1 ? 2 : -1 } } });
  const steps = [
    [{ ...base, ...supports(3) }, 5, false, false],                           // пол не включался — держать нечего
    [{ ...live, ...supports(3) }, 80, false, true],                           // включился, как в v1
    [{ ...base, mvrv: 27, ...supports(3) }, 80, true, true],                  // якорь ушёл из-за роста оценки — пол держится
    [{ ...base, mvrv: 40, ...supports(2) }, 80, true, true],
    [{ ...base, mvrv: 40, ...supports(1) }, 5, false, false],                 // подтверждений меньше двух — снят
    [{ ...base, mvrv: 40, ...supports(3) }, 5, false, false],                 // сам по себе не возвращается
    [{ ...live, ...supports(2) }, 80, false, true],
    [{ ...base, mvrv: 40, ...supports(3), shock: "fired" }, 5, false, false], // макрошок снимает
    [{ ...live, ...supports(3) }, 80, false, true],
    [{ ...base, recovery: "watch", mvrv: 20, ...supports(1) }, 5, false, false], // якорь на месте, подтверждения — нет
  ];
  const { outs, state } = drive(m, steps.map(([o], i) => [at(0, 6) + i * 15 * MIN, o]));
  steps.forEach(([, target, carry, on], i) => assert.deepEqual([outs[i].v1_floor_handoff.target_pct, outs[i].v1_floor_handoff.carry, outs[i].v1_floor_handoff.floor_on], [target, carry, on], `передача пола, шаг ${i}`));
  assert.ok(outs[2].v1_floor_handoff.reason_codes.includes("floor_handoff") && outs[2].v1_floor_handoff.binding_overlays.includes("recovery_floor"));
  assert.deepEqual(state.fh, { on: false });
  // Состояние v1 — как опубликовано: при режиме выше пола удержание цель не трогает; остальные оверлеи v1 на месте.
  const high = drive(m, [[at(0, 6), { ...live, state: "constructive", cand: "constructive" }], [at(0, 7), { state: "constructive", cand: "constructive", mvrv: 97 }]]).outs;
  assert.deepEqual(high.map(v => [v.v1_floor_handoff.target_pct, v.v1_floor_handoff.carry]), [[100, false], [60, true]], "потолок эйфории v1 в линии атрибуции сохранён");
  const cap = drive(m, [[at(0, 6), { ...base, mvrv: 8 }]]).outs[0].v1_floor_handoff;
  assert.deepEqual([cap.target_pct, cap.binding_overlays], [40, ["capitulation_floor"]]);
};

// 5.7. v1_no_cftc: собственный гистерезис по правилам v1 — шаг в шаг с оригинальным stabilizeCore.
checks.noCftcHysteresis = m => {
  const plan = [["transition", 3], ["deteriorating", 1], ["transition", 1], ["deteriorating", 2], ["defensive", 2], ["deteriorating", 8], ["insufficient", 2], ["deteriorating", 200], ["transition", 9], ["deteriorating", 1], ["transition", 199], ["constructive", 30], ["emergency", 1], ["constructive", 195]];
  const steps = [];
  let now = at(0, 6);
  for (const [cand, n] of plan) for (let i = 0; i < n; i++, now += 15 * MIN) steps.push([now, cand === "emergency" ? { cand, state: "emergency", hard: true, target: 0 } : cand === "insufficient" ? { cand, state: "insufficient", critical: false } : { cand, state: "transition" }]);
  const { outs } = drive(m, steps);
  let state = "transition", meta = {};
  const path = [];
  steps.forEach(([t, o], i) => {
    meta = clone(stabilizeCore(o.cand, state, meta, t, { hard: !!o.hard }));
    state = meta.state;
    const view = outs[i].v1_no_cftc;
    assert.deepEqual([view.state, view.candidate, view.hold_until], [meta.state, meta.candidate, meta.hold_until ?? null], `шаг ${i}: ${o.cand}`);
    assert.equal(view.target_pct, allocationDecisionV1({ strategic: meta.state, recoveryState: "calm", macroShockState: "calm", mvrvPercentile: 50 }).target_pct);
    if (path.at(-1) !== meta.state) path.push(meta.state);
  });
  assert.deepEqual(path, ["transition", "deteriorating", "defensive", "insufficient", "defensive", "deteriorating", "transition", "emergency", "transition", "constructive"], "путь проходит понижение в два снимка, повышение за 48 часов, возврат к якорю и оба вырожденных режима");
  assert.ok(outs[0].v1_no_cftc.reason_codes.includes("cold_start") && !outs[1].v1_no_cftc.reason_codes.includes("cold_start"));
  // Покрытие — из входа; при живом флаге, но пустых баллах обязательных семей линия не выдумывает режим.
  const gapped = call(m, { now: at(0, 6), inputs: mk(at(0, 6), { families: familiesOf("transition", { cycle: { trend: null } }) }), state: null }).variants.v1_no_cftc;
  assert.deepEqual([gapped.candidate, gapped.state, gapped.target_pct, gapped.reason_codes.includes("families_incomplete")], ["insufficient", "insufficient", null, true], "недостаток данных принимается сразу, как в v1");
  const flagged = drive(m, [[at(0, 6), {}], [at(0, 6, 15), { critical: false }]]).outs[1].v1_no_cftc;
  assert.deepEqual([flagged.state, flagged.target_pct], ["insufficient", null]);
};

// 5.8. Холодный старт: линии наследуют цель и состояние v1.
checks.coldStartFromV1 = m => {
  for (const state of REGIMES) for (const recovery of ["calm", "good"]) for (const mvrv of [5, 50, 97]) {
    const now = at(1, 9), inputs = mk(now, { cand: state, recovery, mvrv, s: { deep: null } }), out = call(m, { now, inputs, state: null });
    assert.deepEqual(targets(out.variants), Array(4).fill(inputs.v1.target_pct), `старт с цели v1: ${state}/${recovery}/${mvrv}`);
    for (const key of DAILY) assert.deepEqual([out.variants[key].state, out.variants[key].fix_at, out.variants[key].next_fix_at, out.variants[key].reason_codes[0]], [state, iso(now), iso(at(2, 6)), "cold_start"]);
    assert.deepEqual([out.variants.policy_v3_shadow.floor.closes, out.variants.v1_floor_handoff.floor_on, out.variants.v1_no_cftc.state], [recovery === "good" ? 3 : 0, recovery === "good", state]);
    assert.equal(out.variants.policy_v3_shadow.inputs, null, "до первого фикса у кандидата нет своих входов решения");
  }
  // Пока у v1 нет настоящего режима, суточные линии не стартуют; стартуют на первом же настоящем.
  const { outs, state } = drive(m, [[at(0, 6), { cand: "insufficient", state: "insufficient", critical: false }], [at(0, 6, 15), { cand: "defensive", state: "insufficient", critical: true, target: null }], [at(0, 6, 30), { cand: "defensive" }]]);
  for (const key of DAILY) {
    assert.deepEqual(outs.map(v => v[key].target_pct), [null, null, 5], `${key}: ожидание режима v1`);
    assert.deepEqual([outs[0][key].reason_codes, outs[2][key].reason_codes[0]], [["waiting_v1_state"], "cold_start"]);
  }
  // Чужое, испорченное и пустое состояние — холодный старт той линии, чьё состояние негодно.
  const now = at(1, 9), fresh = call(m, { now, inputs: mk(now), state: null });
  for (const garbage of [undefined, {}, [], "state", 7, { v: 2, dc: state.dc }, { v: 1 }, { v: 1, dc: "x", v3: 5, fh: [], nc: null }, { v: 1, dc: { s: "нет" }, v3: { s: "transition", d: 1.5, tg: 45 }, fh: { on: "да" }, nc: { state: 5 } }, { v: 1, dc: { s: "transition", d: Math.floor(now / DAY) + 3, tg: 45 }, v3: { s: "transition", d: 0, tg: null, fl: 0 } }])
    assert.deepEqual(call(m, { now, inputs: mk(now), state: garbage }), fresh, `состояние ${JSON.stringify(garbage)} — холодный старт`);
  const mixed = call(m, { now: at(0, 7), inputs: mk(at(0, 7), { cand: "defensive", state: "transition" }), state: { v: 1, dc: state.dc, v3: "мусор" } }).variants;
  assert.deepEqual([mixed.v1_daily_close.reason_codes[0], mixed.v1_daily_close.target_pct, mixed.policy_v3_shadow.reason_codes[0], mixed.policy_v3_shadow.target_pct], ["between_fixes", 5, "cold_start", 45], "годное состояние одной линии не теряется из-за мусора у другой");
};

// 5.9. Что публикует кандидат: входы решения, возраст входов, компактное состояние.
checks.publishedShape = m => {
  const { outs, state } = drive(m, [[at(0, 6), { cand: "defensive" }], [at(1, 6), RECOVERY], [at(1, 6, 15), {}]]);
  const v3 = outs[1].policy_v3_shadow, yesterday = iso(at(0)).slice(0, 10);
  assert.deepEqual(Object.keys(v3), ["target_pct", "base_target_pct", "state", "candidate", "fix_at", "next_fix_at", "floor", "binding_overlays", "pending", "inputs", "reason_codes"]);
  assert.deepEqual(Object.keys(v3.inputs), ["blocks", "bands", "families", "mvrv_percentile", "mvrv_percentile_deep", "deep_window_used", "deep_points", "recovery", "macro_shock_state", "critical_ok", "observed", "observed_at", "notes"]);
  assert.deepEqual(v3.inputs.blocks, { macro: -50, demand: -33.33, cycle: 20 });
  assert.deepEqual(v3.inputs.bands, { macro: "adverse", demand: "adverse", cycle: "supportive" });
  assert.deepEqual(Object.keys(v3.inputs.families), ["network", "exchange_supply", "valuation", "trend", "institutional"]);
  assert.deepEqual(v3.inputs.families.network, { v3: 0, v1: 0, hashrate_30d_change_pct: 0, difficulty_90d_change_pct: 0 });
  assert.deepEqual(v3.inputs.families.exchange_supply, { v3: 0, v1: 0, change_7d_btc: 0, change_7d_percentile: 50, reserve_90d_change_pct: 0, reserve_90d_percentile: 50 });
  assert.deepEqual([v3.inputs.mvrv_percentile, v3.inputs.deep_window_used, v3.inputs.deep_points, v3.inputs.critical_ok, v3.inputs.notes], [20, true, 2400, true, []]);
  assert.ok(Math.abs(v3.inputs.mvrv_percentile_deep - 20) < 1);
  // Входы фикса — одного возраста: тренд, MVRV и остаток бирж — за вчера.
  assert.deepEqual(v3.inputs.observed, { closed_day: yesterday, mvrv: yesterday, mvrv_deep: yesterday, exchange_supply: yesterday, hashrate: iso(at(1)).slice(0, 10) });
  assert.deepEqual(Object.keys(v3.inputs.observed_at), ["mvrv", "coinmetrics", "etf", "network", "market"]);
  // Даты макрокарточек: на фиксе они старше закрытого дня по построению и публикуются как есть.
  {
    const macro = (stressDaysBack, extra = {}) => { const inputs = mk(at(1, 6)); inputs.observed_at = { ...inputs.observed_at, macro_liquidity: iso(at(-5)), macro_conditions: iso(at(-11)), macro_stress: iso(at(0) - stressDaysBack * DAY), ...extra }; return m.evaluateV3Inputs({ now: at(1, 6), inputs }).record; };
    const usual = macro(1);
    assert.deepEqual([usual.observed.closed_day, usual.observed.macro_stress, usual.observed.macro_liquidity, usual.observed.macro_conditions], [iso(at(0)).slice(0, 10), iso(at(-1)).slice(0, 10), iso(at(-5)).slice(0, 10), iso(at(-11)).slice(0, 10)]);
    assert.deepEqual(usual.notes.filter(x => x.startsWith("macro")), [], "обычное отставание макро на рабочий день и недельные ряды пометкой не считаются");
    assert.deepEqual(macro(4).notes.filter(x => x.startsWith("macro")), [], "выходные с праздником — четыре дня — ещё не отставание");
    assert.deepEqual(macro(5).notes.filter(x => x.startsWith("macro")), ["macro_stress_older_than_4d"]);
    assert.equal(macro(-2).observed.macro_stress, undefined, "дата наблюдения из будущего не публикуется");
    assert.equal(macro(1, { macro_stress: "мусор" }).observed.macro_stress, undefined);
    assert.equal(macro(1, { macro_stress: 12345 }).observed.macro_stress, undefined, "дата приходит строкой; число — не дата");
  }
  assert.deepEqual(v3.reason_codes, ["fix", "base:defensive", "recovery_floor", "upgrade_pending:transition:1/2"]);
  // Ончейн-вход опоздал к фиксу на сутки: фикс состоится, а разный возраст входов помечен.
  const lagging = { ...seriesFor(at(1, 6), { deep: 20 }) };
  lagging.mvrv = lagging.mvrv.slice(0, -1);
  lagging.exchange_supply = lagging.exchange_supply.slice(0, -1);
  const late = drive(m, [[at(0, 6), { cand: "defensive" }], [at(1, 6), { ...RECOVERY, series: lagging }]]).outs[1].policy_v3_shadow;
  assert.deepEqual([late.target_pct, late.inputs.notes, late.inputs.observed.mvrv, late.inputs.observed.closed_day], [40, ["mvrv_older_than_closed_day", "exchange_supply_older_than_closed_day"], iso(at(-1)).slice(0, 10), yesterday]);
  assert.ok(late.reason_codes.includes("mvrv_older_than_closed_day"));
  // Между фиксами публикуется решение фикса: те же входы, тот же пол.
  assert.deepEqual({ ...outs[2].policy_v3_shadow, reason_codes: null }, { ...v3, reason_codes: null });
  assert.deepEqual(outs[2].policy_v3_shadow.reason_codes, ["between_fixes", "base:defensive", "recovery_floor", "upgrade_pending:transition:1/2"]);
  assert.deepEqual(Object.keys(outs[1].v1_daily_close), ["target_pct", "state", "candidate", "fix_at", "next_fix_at", "binding_overlays", "pending", "reason_codes"]);
  assert.deepEqual(Object.keys(outs[1].v1_floor_handoff), ["target_pct", "carry", "floor_on", "state", "supports", "binding_overlays", "reason_codes"]);
  assert.deepEqual(Object.keys(outs[1].v1_no_cftc), ["target_pct", "base_target_pct", "state", "candidate", "hold_until", "demand_block", "binding_overlays", "reason_codes"]);
  assert.deepEqual(Object.keys(state), ["v", "v3", "dc", "fh", "nc"]);
  assert.equal(state.v, m.SHADOW_VARIANTS_STATE_VERSION);
  assert.ok(JSON.stringify(state).length < 2200, `состояние публикуется в каждом снимке и обязано быть компактным: ${JSON.stringify(state).length} байт`);
  // Чистая функция от входов кандидата — то же, что прочитал фикс.
  const direct = pure(() => m.evaluateV3Inputs({ now: at(1, 6), inputs: mk(at(1, 6), RECOVERY) }));
  assert.equal(impure, null);
  assert.deepEqual([direct.candidate, direct.record], ["transition", v3.inputs]);
  assert.equal(m.evaluateV3Inputs({ now: "не время", inputs: mk(at(1, 6)) }), null);
  assert.equal(m.evaluateV3Inputs({ now: at(1, 6), inputs: null }), null);
};

for (const [name, check] of Object.entries(checks)) { try { check(REAL); } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }

// =====================================================================================
// 6. Устойчивость: мусор во входах и состоянии, неизменность аргументов
// =====================================================================================
{
  const rand = rng(404), junk = [null, undefined, NaN, Infinity, -Infinity, "", "строка", 0, -1, 1e308, true, false, [], {}, [null], { t: "x" }, () => 1, Symbol.iterator, new Date(NaN)];
  const shapeOk = out => {
    assert.deepEqual(Object.keys(out), ["state", "variants"]);
    assert.deepEqual(Object.keys(out.variants), LINE_KEYS);
    for (const key of LINE_KEYS) {
      const v = out.variants[key];
      assert.ok(v.target_pct === null || (Number.isFinite(v.target_pct) && v.target_pct >= 0 && v.target_pct <= 100), `${key}: цель — число 0…100 или null`);
      assert.ok(Array.isArray(v.reason_codes) && v.reason_codes.length > 0 && v.reason_codes.every(code => typeof code === "string"), `${key}: коды причины`);
      assert.ok(!v.reason_codes.includes("engine_error"), `${key}: внутренний отказ на входе, который обязан разбираться: ${v.error}`);
    }
    assert.deepEqual(clone(out), JSON.parse(JSON.stringify(out)));
    assert.doesNotThrow(() => JSON.stringify(out));
    assert.equal(out.state.v, 1);
  };
  // Вызовы без аргументов и с негодными аргументами.
  for (const args of [undefined, null, 5, "x", [], {}, { now: at(0, 6) }, { inputs: mk(at(0, 6)) }, { now: "вчера", inputs: mk(at(0, 6)) }, { now: at(0, 6), inputs: null }, { now: at(0, 6), inputs: "нет" }, { now: at(0, 6), inputs: {} }, { now: at(0, 6), inputs: { v1: null } }, { now: 8.64e15 + 1, inputs: mk(at(0, 6)) }, { now: NaN, inputs: mk(at(0, 6)) }]) {
    const out = pure(() => REAL.evaluateShadowVariantsV1(args));
    shapeOk(out);
    assert.deepEqual(targets(out.variants), [null, null, null, null]);
    assert.deepEqual(out.state, { v: 1, v3: null, dc: null, fh: null, nc: null });
  }
  // Негодный вызов не стирает состояние линий.
  const warm = drive(REAL, [[at(0, 6), {}], [at(1, 6), RECOVERY]]).state;
  for (const args of [{ now: at(1, 7), inputs: null, state: warm }, { now: "x", inputs: mk(at(1, 7)), state: warm }]) assert.deepEqual(REAL.evaluateShadowVariantsV1(args).state, warm);
  // Случайный мусор в любом поле входов, в рядах и в состоянии: исключений нет, форма ответа цела.
  const poisonSeries = series => (series ?? []).map(p => (rand() < 0.02 ? pick(rand, junk) : rand() < 0.02 ? { t: pick(rand, junk), v: pick(rand, junk) } : p));
  let state = null, calls = 0;
  for (let k = 0; k < 600; k++) {
    const now = at(0, 5) + k * 53 * MIN, base = mk(now, { cand: pick(rand, [...REGIMES, "insufficient"]), recovery: pick(rand, ["calm", "watch", "good"]), shock: pick(rand, ["calm", "watch", "fired"]), mvrv: Math.round(rand() * 100), s: { deep: pick(rand, [null, 5, 50, "short", "stale"]), price: pick(rand, Object.keys(PRICE)) } });
    // Копия без рядов: сами ряды общие с кэшем фикстур и здесь только заменяются, а не правятся.
    const inputs = { ...base, v1: { ...base.v1 }, families: clone(base.families), series: { ...base.series }, observed_at: { ...base.observed_at } };
    for (const path of [["price"], ["hard_override"], ["v1"], ["v1", "state"], ["v1", "candidate"], ["v1", "critical_ok"], ["v1", "target_pct"], ["v1", "recovery_state"], ["v1", "macro_shock_state"], ["v1", "mvrv_percentile"], ["families"], ["families", "macro"], ["families", "demand", "etf"], ["families", "cycle", "trend"], ["series"], ["series", "hashrate"], ["series", "difficulty"], ["series", "exchange_supply"], ["series", "price_daily"], ["series", "mvrv"], ["series", "mvrv_deep"], ["observed_at"], ["observed_at", "mvrv"]]) {
      if (rand() > 0.07) continue;
      let node = inputs;
      for (const key of path.slice(0, -1)) node = node && typeof node === "object" ? node[key] : null;
      if (node && typeof node === "object") node[path.at(-1)] = pick(rand, junk);
    }
    if (inputs.series && typeof inputs.series === "object") for (const key of Object.keys(inputs.series)) if (Array.isArray(inputs.series[key]) && rand() < 0.3) inputs.series[key] = poisonSeries(inputs.series[key]);
    if (rand() < 0.05) state = pick(rand, [...junk, { v: 1, dc: pick(rand, junk), v3: pick(rand, junk), fh: pick(rand, junk), nc: pick(rand, junk) }]);
    let out;
    assert.doesNotThrow(() => { out = pure(() => REAL.evaluateShadowVariantsV1({ now: rand() < 0.02 ? pick(rand, junk) : now, inputs: rand() < 0.02 ? pick(rand, junk) : inputs, state })); }, `прогон ${k}`);
    assert.equal(impure, null);
    shapeOk(out);
    state = clone(out.state);
    calls++;
  }
  // Аргументы не меняются: входы и состояние заморожены на всю глубину, ряды поданы в обратном порядке и с дублями.
  const now = at(3, 6), inputs = mk(now, RECOVERY), shuffled = { ...inputs, series: Object.fromEntries(Object.entries(inputs.series).map(([k, s]) => [k, Array.isArray(s) ? [...s].reverse().concat(s.slice(-3)) : s])) };
  const frozenState = deepFreeze(clone(drive(REAL, [[at(1, 6), { cand: "defensive" }], [at(2, 6), RECOVERY]]).state)), before = JSON.stringify(shuffled);
  const strict = call(REAL, { now, inputs: deepFreeze(shuffled), state: frozenState });
  assert.equal(JSON.stringify(shuffled), before);
  assert.deepEqual(strict, call(REAL, { now, inputs, state: clone(frozenState) }), "порядок точек и дубли метки времени на счёт не влияют");
  assert.equal(strict.variants.policy_v3_shadow.target_pct, 60);
  // Отказ одной линии не трогает остальные: getter, бросающий исключение, ловится на уровне линии.
  const trap = { ...mk(now), series: { get hashrate() { throw new Error("сломанный ряд"); } } };
  const trapped = REAL.evaluateShadowVariantsV1({ now, inputs: trap, state: frozenState });
  assert.deepEqual([trapped.variants.policy_v3_shadow.target_pct, trapped.variants.policy_v3_shadow.reason_codes, trapped.variants.policy_v3_shadow.error], [null, ["engine_error"], "сломанный ряд"]);
  assert.deepEqual([trapped.state.v3, trapped.variants.v1_daily_close.target_pct, isFix(trapped.variants, "v1_daily_close"), trapped.variants.v1_no_cftc.target_pct, trapped.variants.v1_floor_handoff.target_pct], [frozenState.v3, 5, true, 5, 45], "состояние отказавшей линии сохранено, остальные линии посчитаны");
}

// =====================================================================================
// 7. Мутации: возврат старого поведения обязан ронять поведенческий тест
// =====================================================================================
const SOURCE = readFileSync(new URL("../docs/policy-v3-candidate.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
{
  const imports = [...SOURCE.matchAll(/^import .* from "([^"]+)";$/gm)].map(x => x[1]);
  assert.deepEqual(imports, ["./policy-v1.mjs", "./model-policy-v1.mjs", "./policy-v2-candidate.mjs"], "модуль — статический файл сайта: только соседние контракты, ни одного импорта Node и сборщика");
  assert.doesNotMatch(SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /\bimport\s*\(|\brequire\s*\(|\bprocess\b|\bfetch\s*\(/);
  const rewired = text => text.replace(/from "\.\/([\w.-]+\.mjs)"/g, (_, file) => `from "${new URL(`../docs/${file}`, import.meta.url).href}"`);
  // Мутант грузится как data:-модуль, без файлов; если среда так не умеет — из временного каталога.
  let tempDir = null, serial = 0;
  const load = async text => {
    const code = rewired(text);
    try { return await import("data:text/javascript;base64," + Buffer.from(code).toString("base64")); } catch {
      tempDir ??= mkdtempSync(join(tmpdir(), "btc21m-v3-mutants-"));
      const file = join(tempDir, `mutant-${serial++}.mjs`);
      writeFileSync(file, code);
      return import(pathToFileURL(file).href);
    }
  };
  // Контроль стенда: немутированная копия проходит все проверки.
  const copy = await load(SOURCE);
  for (const check of Object.values(checks)) check(copy);
  const MUTATIONS = [
    ["фикс в полночь вместо 06:00", "hour_utc: 6,", "hour_utc: 0,", 1, ["fixOncePerDayAtSix", "fixClockEdges"]],
    ["фикс на каждом снимке", "&& !(lastFixDay >= day);", "&& true;", 1, ["fixOncePerDayAtSix", "betweenFixesHold"]],
    ["фикс раньше 06:00", "now - day * DAY >= FIX.hour_utc * HOUR &&", "", 1, ["fixOncePerDayAtSix", "fixClockEdges"]],
    ["повышение на первом фиксе", "confirm_fixes_up: 2,", "confirm_fixes_up: 1,", 1, ["upgradeNeedsTwoFixes", "gapResetsStreaks"]],
    ["понижение с задержкой", "confirm_fixes_down: 1,", "confirm_fixes_down: 2,", 1, ["downgradeImmediate"]],
    ["другой «лучший» кандидат продолжает счёт", "const count = p === candidate ? n + 1 : 1;", "const count = n + 1;", 1, ["upgradeNeedsTwoFixes"]],
    ["пропущенные сутки не обнуляют счёт", "const consecutive = clock.day === st.d + 1,", "const consecutive = true,", 2, ["gapResetsStreaks", "insufficientHolds"]],
    ["фикс при недостатке данных", "if (!REGIMES.includes(calc.candidate)) {", "if (false) {", 1, ["insufficientHolds"]],
    ["аварийный режим не обнуляет цель", "target_pct: inp.hard ? POLICY_V1.ladder.emergency : blind ? null : st.tg,", "target_pct: blind ? null : st.tg,", 2, ["emergencyImmediate"]],
    ["фикс во время аварии", "if (clock.due && inp.hard) tact = \"fix_deferred\";\n    else if (clock.due && !REGIMES.includes(inp.v1.candidate)) {", "if (clock.due && !REGIMES.includes(inp.v1.candidate)) {", 1, ["emergencyImmediate"]],
    ["CFTC снова голосует", "non_voting_families: [\"institutional\"],", "non_voting_families: [],", 1, ["cftcDoesNotVote"]],
    ["хешрейт точка к точке", "hashrate_mean_days: 30, lookback_days: 90, min_points_in_window: 20,", "hashrate_mean_days: 1, lookback_days: 90, min_points_in_window: 1,", 1, ["hashrateSmoothed"]],
    ["шкала хешрейта сдвинута", "leg_bands_pct: [-5, -15]", "leg_bands_pct: [-10, -15]", 1, ["hashrateSmoothed"]],
    ["рост остатка голосует «за»", "out.flow_leg = finite(p) ? (flow > 0 ? Math.min(lowGoodV1Port(p), 0) : lowGoodV1Port(p)) : null;", "out.flow_leg = finite(p) ? lowGoodV1Port(p) : null;", 1, ["exchangeEconomicZero", "exchangeMatchesReference"]],
    ["недельное изменение через дыру в ряду", "&& s[i].t - s[j].t <= P.flow_max_span_days * DAY", "", 1, ["exchangeEconomicZero"]],
    ["окно потоков 30 дней", "flow_change_days: 7,", "flow_change_days: 30,", 1, ["exchangeMatchesReference"]],
    ["«дёшево» по одному окну", "const cheap = p <= P.cheap_max_percentile && (deep === null || deep <= P.cheap_max_percentile);", "const cheap = p <= P.cheap_max_percentile;", 1, ["valuationTwoWindows", "twoWindowsInEngine"]],
    ["якорь recovery по одному окну", "&& (deep === null || deep < P.recovery_anchor_below_percentile);", ";", 1, ["valuationTwoWindows", "twoWindowsInEngine"]],
    ["«дорого» требует согласия окон", "const score = p >= P.extreme_min_percentile ? -2 : p >= P.expensive_min_percentile ? -1 : cheap ? 1 : 0;", "const score = p >= P.extreme_min_percentile && deep >= P.extreme_min_percentile ? -2 : p >= P.expensive_min_percentile && deep >= P.expensive_min_percentile ? -1 : cheap ? 1 : 0;", 1, ["valuationTwoWindows"]],
    ["короткое глубокое окно годится", "else if (s.length < P.deep_min_points) out.reason = \"mvrv_deep_short\";", "", 1, ["deepWindowGuards", "twoWindowsInEngine"]],
    ["протухшее глубокое окно годится", "else if (t - last(s).t > P.deep_max_age_days * DAY) out.reason = \"mvrv_deep_stale\";", "", 1, ["deepWindowGuards", "twoWindowsInEngine"]],
    ["нет глубокого окна — нет «дёшево»", "(deep === null || deep <= P.cheap_max_percentile)", "(deep !== null && deep <= P.cheap_max_percentile)", 1, ["valuationTwoWindows", "twoWindowsInEngine"]],
    ["тренд с незакрытой свечой", ".filter(p => p.t + DAY <= t);", ";", 1, ["trendClosedDay"]],
    ["пол 80 % одним фиксом", "const fl = live ? Math.min(rungs, (consecutive ? st.fl : 0) + 1) : 0;", "const fl = live ? rungs : 0;", 1, ["floorGraduates", "floorResets"]],
    ["пол держится после ухода якоря", "const fl = live ? Math.min(rungs, (consecutive ? st.fl : 0) + 1) : 0;", "const fl = live ? Math.min(rungs, (consecutive ? st.fl : 0) + 1) : st.fl;", 1, ["floorResets"]],
    ["пол при макрошоке", "&& calc.macro_shock_state !== OVERLAYS_V1.recovery_blocked_by_macro_shock_state;", ";", 1, ["floorGraduates"]],
    ["строго положительная нога", "filter(v => finite(v) && Number(v) >= 0).length;", "filter(v => finite(v) && Number(v) >= 0).length * ([trend, etf, exchangeSupply].some(v => Number(v) > 0) ? 1 : 0);", 1, ["floorGraduates"]],
    ["«Дистрибуция» понижает вердикт кандидата", "distributionState: \"calm\", recoveryState: recovery.state, exclude", "distributionState: inp.v1.distribution_state, recoveryState: recovery.state, exclude", 1, ["noDeadRules"]],
    ["передача пола без подтверждений", "&& supports >= SCORING.recovery.good_min_supports;", ";", 1, ["handoffRules"]],
    ["передача пола на одном подтверждении", "supports >= SCORING.recovery.good_min_supports;", "supports >= SCORING.recovery.watch_min_supports;", 1, ["handoffRules"]],
    ["recovery на одном подтверждении", "good_min_supports: 2,", "good_min_supports: 1,", 1, ["floorResets", "handoffRules"]],
    ["передача пола при макрошоке", "prev?.on === true && !shock &&", "prev?.on === true &&", 1, ["handoffRules"]],
    ["передача пола без включения", "const carry = !live && prev?.on === true &&", "const carry = !live &&", 1, ["handoffRules"]],
    ["v1_no_cftc без своего гистерезиса", "const decision = v1Decision(meta.state, inp);\n  const state = { state: meta.state,", "const decision = v1Decision(candidate, inp);\n  const state = { state: meta.state,", 1, ["noCftcHysteresis"]],
    ["холодный старт не от v1", "tg: inp.v1.target_pct ?? start.target_pct, fl:", "tg: 50, fl:", 1, ["coldStartFromV1"]],
    ["отставший стресс не помечается", "> STRESS_MAX_LAG_DAYS * DAY) notes.push", "> 99 * DAY) notes.push", 1, ["publishedShape"]],
    ["обычные четыре дня отставания стресса помечаются", "> STRESS_MAX_LAG_DAYS * DAY) notes.push", ">= STRESS_MAX_LAG_DAYS * DAY) notes.push", 1, ["publishedShape"]],
    ["дата макровхода из будущего публикуется", "if (t !== null && t <= now) observed[key] = dateOf(t);", "if (t !== null) observed[key] = dateOf(t);", 1, ["publishedShape"]],
    ["даты макровходов не публикуются", "for (const key of MACRO_OBSERVED) {", "for (const key of []) {", 1, ["publishedShape"]],
  ];
  const used = new Set();
  for (const [name, from, to, occurrences, failing] of MUTATIONS) {
    assert.equal(SOURCE.split(from).length - 1, occurrences, `мутация «${name}»: образец должен встречаться в модуле ${occurrences} раз`);
    const mutant = await load(SOURCE.split(from).join(to));
    for (const check of failing) {
      assert.throws(() => checks[check](mutant), `мутация «${name}» обязана ронять проверку ${check}`);
      used.add(check);
    }
  }
  assert.deepEqual(Object.keys(checks).filter(name => !used.has(name)), [], "у каждой поведенческой проверки есть мутация, которая её роняет");
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

// =====================================================================================
// 8. Приёмка: эпизоды расхождения с v1 (критерий min_target_changes_vs_v1)
// =====================================================================================
{
  const rows = (pairs) => pairs.map(([candidate, base], i) => ({ date: iso(at(i)).slice(0, 10), targets: { policy_v3_shadow: candidate, policy_v1: base } }));
  assert.deepEqual(REAL.countTargetDivergenceEpisodesV3(rows([[45, 45], [20, 45], [20, 45], [45, 45], [5, 20], [null, 20], [5, 20], [20, 20], [45, 45.0000000001], [80, 45]])), { episodes: 3, days: 5 }, "серия расхождения считается один раз; строка без цели серию не рвёт");
  assert.deepEqual(REAL.countTargetDivergenceEpisodesV3(rows([[20, 45]])), { episodes: 1, days: 1 });
  for (const junk of [null, undefined, "x", [null, 5, {}], [{ targets: null }]]) assert.deepEqual(REAL.countTargetDivergenceEpisodesV3(junk), { episodes: 0, days: 0 });
  assert.deepEqual(REAL.countTargetDivergenceEpisodesV3(rows([[20, 45]]).map(r => ({ targets: { a: r.targets.policy_v3_shadow, b: r.targets.policy_v1 } })), { candidate: "a", base: "b" }), { episodes: 1, days: 1 });
  // Суточная линия догоняет внутридневную смену цели v1 на ближайшем фиксе: на дневных строках это не расхождение.
  const lag = drive(REAL, [[at(0, 6), {}], [at(1, 2), { cand: "defensive", state: "defensive" }], [at(1, 6), { cand: "defensive", state: "defensive" }], [at(1, 23, 45), { cand: "defensive", state: "defensive" }]]).outs;
  assert.deepEqual(lag.map(v => v.policy_v3_shadow.target_pct), [45, 45, 5, 5], "четыре часа цель кандидата отстаёт от v1");
  const dailyRows = [[45, 45], [lag.at(-1).policy_v3_shadow.target_pct, 5]].map(([candidate, base]) => ({ targets: { policy_v3_shadow: candidate, policy_v1: base } }));
  assert.deepEqual(REAL.countTargetDivergenceEpisodesV3(dailyRows), { episodes: 0, days: 0 });
}

// =====================================================================================
// 9. Закоммиченный снимок: входы, собранные из него, движок принимает без отказов
// =====================================================================================
// Снимок в репозитории меняется каждые 15 минут и бывает обеих форм: старой (рядов и состояния вариантов
// в нём нет) и новой. Жёсткие ожидания поэтому стоят только там, где они следуют из самого снимка.
{
  let snapshot = null;
  try { snapshot = JSON.parse(readFileSync(new URL("../docs/snapshot.json", import.meta.url), "utf8")); } catch { /* снимка нет — проверять нечего */ }
  const now = Date.parse(snapshot?.generated_at ?? "");
  if (snapshot?.regime && snapshot?.blocks && Array.isArray(snapshot.detectors) && Number.isFinite(now)) {
    const detector = id => snapshot.detectors.find(x => x.id === id)?.state ?? null, mvrv = (snapshot.metrics || []).find(x => x.id === "mvrv_cycle");
    const inputs = {
      price: snapshot.price, hard_override: !!snapshot.override,
      v1: { state: snapshot.regime.strategic, candidate: snapshot.regime_meta?.strategic?.candidate ?? snapshot.regime.strategic, critical_ok: snapshot.scores?.critical_coverage_ok ?? null, target_pct: snapshot.decision?.target_pct ?? null, recovery_state: detector("recovery"), macro_shock_state: detector("macro_shock"), distribution_state: detector("distribution"), mvrv_percentile: mvrv?.value_num ?? null, valuation_score: mvrv?.score ?? null },
      families: Object.fromEntries(["macro", "demand", "cycle"].map(k => [k, snapshot.blocks[k]?.strategic?.families ?? {}])),
    };
    const known = snapshot.monitoring?.variants_state, first = call(REAL, { now, inputs, state: known });
    const second = call(REAL, { now: (Math.floor(now / DAY) + 1) * DAY + 7 * HOUR, inputs, state: clone(first.state) });
    for (const out of [first, second]) for (const key of LINE_KEYS) {
      const v = out.variants[key];
      assert.ok(!v.reason_codes.includes("engine_error"), `${key}: ${v.error}`);
      assert.ok(v.target_pct === null || (v.target_pct >= 0 && v.target_pct <= 100));
    }
    // Старая форма при обычном режиме: холодный старт с цели v1; на следующем фиксе кандидат без рядов слеп и держит цель.
    if (known === undefined && !inputs.hard_override && inputs.v1.critical_ok === true && REGIMES.includes(inputs.v1.state) && REGIMES.includes(inputs.v1.candidate) && Number.isFinite(inputs.v1.target_pct)) {
      assert.deepEqual(targets(first.variants), Array(4).fill(inputs.v1.target_pct), "на снимке старой формы линии стартуют с цели v1");
      assert.deepEqual([second.variants.policy_v3_shadow.target_pct, second.variants.policy_v3_shadow.reason_codes.includes("insufficient_data"), isFix(second.variants, "v1_daily_close")], [null, true, true]);
      assert.equal(typeof second.variants.v1_daily_close.target_pct, "number");
    }
  }
}

console.log(`Policy v3 candidate OK: ${assertions.toLocaleString("en-US")} assertions — contract, v1 ports vs locked sections and published ledger, daily fix clock, hysteresis in fixes, four shadow lines, garbage tolerance, mutations`);
