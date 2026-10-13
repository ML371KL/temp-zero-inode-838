import assert from "node:assert/strict";
import { POLICY_V2_CANDIDATE, allocationDecisionV2Candidate, allocationTargetV2Candidate, evaluateAcceptanceV2, evaluateReviewV2, excessSharpeV2, policyV2CandidateMetadata, riskOffConfirmationDeferredV2, timingNullV2, updateV2ShadowState } from "../docs/policy-v2-candidate.mjs";
import { allocationTargetV1 } from "../docs/policy-v1.mjs";

const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const T0 = Date.parse("2026-08-03T10:00:00Z");

// --- Контракт кандидата: тень, не живое решение ---
assert.equal(POLICY_V2_CANDIDATE.status, "shadow_candidate");
assert.ok(POLICY_V2_CANDIDATE.decision_record.acceptance_criteria.shadow_days_min >= 90, "предзаявленный теневой срок обязателен");
assert.ok(POLICY_V2_CANDIDATE.decision_record.acceptance_criteria.falsified_if.length > 10, "критерий фальсификации обязателен");
assert.ok(Object.isFrozen(POLICY_V2_CANDIDATE) && Object.isFrozen(POLICY_V2_CANDIDATE.decision_record), "decision record кандидата должен быть заморожен");
assert.equal(policyV2CandidateMetadata().floor_rungs, 3, "число ступеней пола публикуется для UI (знаменатель не хардкодится)");
assert.equal(POLICY_V2_CANDIDATE.version, 2, "номер сьюта кандидата не меняется ревизией измерений");
assert.equal(policyV2CandidateMetadata().revision, 2, "ревизия измерений публикуется рядом с версией");

// --- Предзаявленный минимальный интервал подтверждения risk-off (пункт 5) ---
assert.equal(POLICY_V2_CANDIDATE.hysteresis.risk_off_min_confirm_minutes, 30, "порог предзаявлен в контракте, а не зашит в сборщике");
assert.equal(POLICY_V2_CANDIDATE.hysteresis.risk_off_confirm_reference, "first_counter_snapshot", "интервал отсчитывается от первого встречного снимка серии");
assert.equal(POLICY_V2_CANDIDATE.hysteresis.enforcement, "on_switch_only", "правило НЕ исполняется тенью: гистерезис вердикта в замороженной секции v1");
assert.ok(Object.isFrozen(POLICY_V2_CANDIDATE.hysteresis));
assert.equal(policyV2CandidateMetadata().hysteresis.risk_off_min_confirm_minutes, 30, "порог публикуется в снимке");
{
  const now = Date.parse("2026-07-24T03:15:00.000Z");
  // Живой случай 24.07: подтверждение через 24 минуты — v2 отложил бы.
  assert.equal(riskOffConfirmationDeferredV2({ previousSnapshotAt: "2026-07-24T02:51:00.000Z", now }), true);
  // Штатный часовой такт не задерживается никогда.
  assert.equal(riskOffConfirmationDeferredV2({ previousSnapshotAt: "2026-07-24T02:15:00.000Z", now }), false);
  // Ровно на пороге — не откладываем (строгое «меньше»).
  assert.equal(riskOffConfirmationDeferredV2({ previousSnapshotAt: "2026-07-24T02:45:00.000Z", now }), false);
  // Мусорные и будущие метки не должны молча включать отсрочку.
  assert.equal(riskOffConfirmationDeferredV2({ previousSnapshotAt: "не дата", now }), false);
  assert.equal(riskOffConfirmationDeferredV2({ previousSnapshotAt: null, now }), false);
  assert.equal(riskOffConfirmationDeferredV2({ previousSnapshotAt: "2026-07-24T04:00:00.000Z", now }), false, "снимок из будущего не считается быстрым подтверждением");
  assert.equal(riskOffConfirmationDeferredV2(), false);
  // ТАКТ 15 МИНУТ (с 07.08.2026). Отсчёт — от первого встречного снимка серии: второй встречный
  // снимок (15 мин) откладывается, третий (30 мин) подтверждает — на один прогон позже, а не никогда.
  const first = "2026-09-16T01:53:44.000Z", firstMs = Date.parse(first);
  assert.equal(riskOffConfirmationDeferredV2({ firstCounterSnapshotAt: first, now: firstMs + 15 * MIN }), true, "15 минут от первого встречного снимка — рано");
  assert.equal(riskOffConfirmationDeferredV2({ firstCounterSnapshotAt: first, now: firstMs + 30 * MIN }), false, "30 минут от первого встречного снимка — подтверждение, хотя до ПРЕДЫДУЩЕГО снимка всего 15 минут");
  // Первый встречный снимок главнее предыдущего: серия длиной 40 минут подтверждена, даже если
  // последний снимок был 10 минут назад (при старом определении понижение не подтвердилось бы никогда).
  assert.equal(riskOffConfirmationDeferredV2({ firstCounterSnapshotAt: first, previousSnapshotAt: new Date(firstMs + 30 * MIN).toISOString(), now: firstMs + 40 * MIN }), false, "интервал считается от первого встречного снимка, а не от предыдущего");
}

// --- Машина дневных закрытий: мажоритарное подтверждение дня ---
// День подтверждает good только если good на ПОСЛЕДНЕМ наблюдении И на большинстве наблюдений дня.
let st = updateV2ShadowState(null, T0, true);
for (let h = 1; h <= 6; h++) st = updateV2ShadowState(st, T0 + h * HOUR, true);
assert.equal(st.closes, 0, "внутри дня градуировка не растёт");
st = updateV2ShadowState(st, T0 + DAY, true);
assert.equal(st.closes, 1, "день с good-большинством и good-закрытием подтверждён");
st = updateV2ShadowState(st, T0 + 2 * DAY, true);
assert.equal(st.closes, 2);
st = updateV2ShadowState(st, T0 + 3 * DAY, true);
assert.equal(st.closes, 3);
st = updateV2ShadowState(st, T0 + 30 * DAY - HOUR, true);
assert.ok(st.closes <= POLICY_V2_CANDIDATE.floor_ladder_pct.length, "счётчик насыщается на числе ступеней — «12/3» на панели невозможно");

// Одинокий поздний тик НЕ подтверждает день (23 часа watch + 1 час good).
let lone = updateV2ShadowState(null, T0, false);
for (let h = 1; h <= 12; h++) lone = updateV2ShadowState(lone, T0 + h * HOUR, false);
lone = updateV2ShadowState(lone, T0 + 13 * HOUR, true); // единственный good — последним наблюдением
lone = updateV2ShadowState(lone, T0 + DAY, true);
assert.equal(lone.closes, 0, "день с good-меньшинством не подтверждается, даже если закрылся good (однотиковый вход — класс, который v2 устраняет)");

// РОВНО ПОЛОВИНА — не большинство (ревизия 2: код и POLICY.md приведены к одному).
let half = updateV2ShadowState(null, T0, false);
for (let h = 1; h <= 3; h++) half = updateV2ShadowState(half, T0 + h * HOUR, h >= 2); // наблюдения: false,false,true,true
assert.deepEqual([half.day_ticks, half.day_good_ticks, half.day_last_good], [4, 2, true]);
half = updateV2ShadowState(half, T0 + DAY, true);
assert.equal(half.closes, 0, "ровно половина good-наблюдений при good-закрытии день НЕ подтверждает");
let overHalf = updateV2ShadowState(null, T0, false);
for (let h = 1; h <= 4; h++) overHalf = updateV2ShadowState(overHalf, T0 + h * HOUR, h >= 2); // false,false,true,true,true
overHalf = updateV2ShadowState(overHalf, T0 + DAY, true);
assert.equal(overHalf.closes, 1, "три good из пяти — уже большинство");

// Good-большинство, но срыв на закрытии — тоже не подтверждение (risk-off свежее).
let lateBreak = updateV2ShadowState(null, T0, true);
for (let h = 1; h <= 10; h++) lateBreak = updateV2ShadowState(lateBreak, T0 + h * HOUR, true);
lateBreak = updateV2ShadowState(lateBreak, T0 + 11 * HOUR, false);
lateBreak = updateV2ShadowState(lateBreak, T0 + DAY, true);
assert.equal(lateBreak.closes, 0, "день, закрывшийся не-good, не подтверждается");

// Дыра каденса >1 суток обнуляет (ненаблюдённые закрытия не подтверждаются).
let gap = updateV2ShadowState(null, T0, true);
gap = updateV2ShadowState(gap, T0 + DAY, true);
assert.equal(gap.closes, 1);
gap = updateV2ShadowState(gap, T0 + 3 * DAY + HOUR, true);
assert.equal(gap.closes, 0, "ненаблюдённые сутки не засчитываются");

// --- Направленность пола: вход ступенями, выход мгновенный ---
const base = { strategic: "deteriorating", macroShockState: "calm", mvrvPercentile: 20 };
assert.equal(allocationTargetV2Candidate({ ...base, recoveryState: "good", recoveryCloses: 0 }), 20, "до первого подтверждённого закрытия пол не применяется");
assert.equal(allocationTargetV2Candidate({ ...base, recoveryState: "good", recoveryCloses: 1 }), 40);
assert.equal(allocationTargetV2Candidate({ ...base, recoveryState: "good", recoveryCloses: 2 }), 60);
assert.equal(allocationTargetV2Candidate({ ...base, recoveryState: "good", recoveryCloses: 3 }), 80);
assert.equal(allocationTargetV2Candidate({ ...base, recoveryState: "watch", recoveryCloses: 3 }), 20, "risk-off мгновенен: без good пол снят этим же снимком");
assert.equal(allocationTargetV2Candidate({ ...base, recoveryState: "good", recoveryCloses: 3, macroShockState: "fired" }), 20, "макрошок блокирует пол, как в v1");
assert.equal(allocationTargetV2Candidate({ strategic: "constructive", recoveryState: "good", macroShockState: "calm", mvrvPercentile: 20, recoveryCloses: 1 }), 100, "пол никогда не опускает базу выше себя");
// Разбор решения: базовая ступень и связывающий оверлей — основа счётчика recovery-эпизодов.
assert.deepEqual(allocationDecisionV2Candidate({ ...base, recoveryState: "good", recoveryCloses: 2 }), { target_pct: 60, base_target_pct: 20, binding_overlays: ["recovery_floor"] });
assert.deepEqual(allocationDecisionV2Candidate({ ...base, recoveryState: "good", recoveryCloses: 0 }).binding_overlays, [], "без подтверждённых закрытий пол не связывает");
assert.deepEqual(allocationDecisionV2Candidate({ strategic: "transition", recoveryState: "good", macroShockState: "calm", mvrvPercentile: 20, recoveryCloses: 1 }).binding_overlays, [], "ступень 40 ниже базы 45 — пол цель не держит");
assert.deepEqual(allocationDecisionV2Candidate({ strategic: "defensive", recoveryState: "calm", macroShockState: "calm", mvrvPercentile: 8, mvrvPercentileDeep: 9 }).binding_overlays, ["capitulation_floor"], "40 от пола капитуляции — не recovery-эпизод");
assert.deepEqual(allocationDecisionV2Candidate({ strategic: "insufficient" }), { target_pct: null, base_target_pct: null, binding_overlays: [] });

// --- Двухоконная капитуляция ---
assert.equal(allocationTargetV2Candidate({ strategic: "defensive", recoveryState: "calm", macroShockState: "calm", mvrvPercentile: 8, mvrvPercentileDeep: 9 }), 40, "оба окна согласны → пол 40");
assert.equal(allocationTargetV2Candidate({ strategic: "defensive", recoveryState: "calm", macroShockState: "calm", mvrvPercentile: 8, mvrvPercentileDeep: 30 }), 5, "глубокое окно не согласно → пола нет");
assert.equal(allocationTargetV2Candidate({ strategic: "defensive", recoveryState: "calm", macroShockState: "calm", mvrvPercentile: 8, mvrvPercentileDeep: null }), 40, "недоступное глубокое окно не отключает защитный пол (fallback v1, публикуется в inputs)");
assert.equal(allocationTargetV2Candidate({ strategic: "constructive", recoveryState: "calm", macroShockState: "calm", mvrvPercentile: 97 }), 60, "euphoria-потолок остаётся одноконным safety-правилом");
assert.equal(allocationTargetV2Candidate({ strategic: "emergency", recoveryState: "good", macroShockState: "calm", mvrvPercentile: 1, recoveryCloses: 3 }), 0, "emergency поверх всего");
assert.equal(allocationTargetV2Candidate({ strategic: "insufficient", recoveryState: "calm", macroShockState: "calm", mvrvPercentile: 50 }), null);

// --- Паритет с v1 там, где отличия v2 неактивны ---
for (const strategic of ["defensive", "deteriorating", "transition", "unconfirmed_positive", "constructive"]) {
  for (const mv of [30, 50, 94]) {
    const v1 = allocationTargetV1({ strategic, recoveryState: "calm", macroShockState: "calm", mvrvPercentile: mv });
    const v2 = allocationTargetV2Candidate({ strategic, recoveryState: "calm", macroShockState: "calm", mvrvPercentile: mv, mvrvPercentileDeep: mv, recoveryCloses: 0 });
    assert.equal(v2, v1, `вне оверлеев v2 обязан совпадать с v1: ${strategic}/${mv}`);
  }
}

// --- Ревью-триада: выдержка в РЕВЬЮ-ДНЯХ, не в вызовах коллектора ---
const mkRows = (days, navFns) => Array.from({ length: days }, (_, i) => {
  const t = new Date(Date.parse("2026-01-01T00:00:00Z") + i * DAY).toISOString();
  const nav = {}; for (const [k, fn] of Object.entries(navFns)) nav[k] = fn(i);
  return { t, nav };
});
const stress = {
  buy_and_hold: i => 1 - 0.40 * Math.min(1, i / 150),
  static_theta: i => 1 - 0.15 * Math.min(1, i / 150),
};
const healthyRows = mkRows(200, { ...stress, policy_v1: i => 1 - 0.12 * Math.min(1, i / 150) });
const brokenRows = mkRows(200, { ...stress, policy_v1: i => 1 - 0.40 * Math.min(1, i / 150) });

// ЧАСОВАЯ КАДЕНЦИЯ: 24 вызова на один и тот же дневной срез НЕ ускоряют выдержку —
// ловушка «стрик по вызовам» (ревью 2026-07-22; тест обязан звать чаще раза в день).
let hourly = null;
for (let i = 170; i < 176; i++) for (let h = 0; h < 24; h++) hourly = evaluateReviewV2(brokenRows.slice(0, i + 1), hourly);
assert.equal(hourly.r1_protection.status, "ok", "6 дней нарушения × 24 вызова = 6 ревью-дней, НЕ 144");
assert.equal(hourly.r1_protection.violation_streak_days, 6, "стрик деноминирован в ревью-днях");

// POWER-ТЕСТ R1: сломанная защита ловится, здоровая — нет.
let broken = null;
for (let i = 170; i < 200; i++) broken = evaluateReviewV2(brokenRows.slice(0, i + 1), broken);
assert.equal(broken.r1_protection.status, "investigate", "отключенная защита ОБЯЗАНА ловиться R1");
assert.ok(broken.r1_protection.drawdown_ratio > 0.7 && broken.r1_protection.hodl_drawdown_pct <= -25, "числа R1 публикуются рядом со статусом");
let healthy = null;
for (let i = 170; i < 200; i++) healthy = evaluateReviewV2(healthyRows.slice(0, i + 1), healthy);
assert.equal(healthy.r1_protection.status, "ok", "здоровая защита не тревожит R1");
assert.equal(healthy.r1_protection.violation_streak_days, 0);

// --- Честный ноль тайминга и R2 ---
// Синтетический рынок: детерминированный ряд дневных доходностей (LCG), кэш 4 % годовых.
// Монитор собирается так же, как настоящий: цель дня i держится до закрытия дня i+1, издержки
// 10 б.п. на оборот, в строке — цена, цели, NAV и накопленный путь политики [доля·сутки, валовой NAV].
const COST = 0.001;
function market(days, seed = 7, drift = 0.0006, vol = 0.03) {
  let x = seed >>> 0; const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
  const returns = [0], prices = [50_000];
  for (let i = 1; i < days; i++) { const r = drift + vol * (rnd() + rnd() + rnd() - 1.5) * 1.1547; returns.push(r); prices.push(prices[i - 1] * (1 + r)); }
  return { returns, prices };
}
function monitorRows(mkt, targetOf, { withPath = true, extraNav = null } = {}) {
  const cashStep = 1.04 ** (1 / 365.25) - 1, rows = [];
  let nav = 1, gross = 1, wDays = 0, cash = 1, hodl = 1 - COST, held = null;
  for (let i = 0; i < mkt.prices.length; i++) {
    const target = targetOf(i);
    if (i === 0) nav *= 1 - target / 100 * COST;
    else {
      const g = held / 100 * mkt.returns[i] + (1 - held / 100) * cashStep;
      nav *= (1 + g) * (1 - Math.abs(target - held) / 100 * COST); gross *= 1 + g; wDays += held; cash *= 1 + cashStep; hodl *= 1 + mkt.returns[i];
    }
    held = target;
    const row = { t: new Date(Date.parse("2026-01-01T23:52:00Z") + i * DAY).toISOString(), price: mkt.prices[i], targets: { policy_v1: target, buy_and_hold: 100 }, nav: { policy_v1: nav, buy_and_hold: hodl, cash } };
    if (withPath) row.path = { policy_v1: [wDays, gross] };
    if (extraNav) Object.assign(row.nav, extraNav(i, row));
    rows.push(row);
  }
  return rows;
}
const mkt = market(420, 3, 0.002, 0.03);
// Тайминг: «прозорливый» держит 70 % перед ростом и 10 % перед падением; «инвертированный» — наоборот.
const foresight = i => mkt.returns[i + 1] === undefined ? 40 : mkt.returns[i + 1] > 0 ? 70 : 10;
const inverted = i => 80 - foresight(i);
const runReview = (rows, from = 330) => { let r = null; for (let i = from; i < rows.length; i++) r = evaluateReviewV2(rows.slice(0, i + 1), r); return r; };

// Разложение точное, доля — по времени.
{
  const rows = monitorRows(mkt, inverted);
  const tn = timingNullV2(rows, { costRate: COST });
  assert.equal(tn.share_source, "exact");
  const exactShare = (rows.at(-1).path.policy_v1[0] - rows[0].path.policy_v1[0]) / (rows.length - 1);
  assert.ok(Math.abs(tn.share_pct - exactShare) < 1e-9, "доля нуля — накопленный интеграл цели, делённый на длину окна");
  assert.ok(Math.abs(tn.level_pp + tn.timing_pp + tn.costs_pp - tn.vs_hodl_pp) < 1e-9, "уровень + тайминг + издержки обязаны давать разницу с HODL точно");
  assert.ok(tn.timing_pp < -50, `инвертированный путь долей обязан давать большой отрицательный тайминг: ${tn.timing_pp}`);
  assert.ok(tn.level_pp < 0 && Math.abs(tn.vs_null_pp - (tn.policy_net_return_pct - tn.null_net_return_pct)) < 1e-9);
  // Виртуальная строка начала (генезис монитора не совпадает с дневной строкой): окно «с начала»
  // обязано возвращать опубликованный NAV стратегии, а вход платится один раз.
  const genesis = { t: new Date(Date.parse(rows[0].t) - 6 * HOUR).toISOString(), price: rows[0].price, cash_nav: rows[0].nav.cash, nav: rows[0].nav.policy_v1, target_pct: rows[0].targets.policy_v1, w_days: 0, gross: 1 };
  const since = timingNullV2(rows.slice(1), { start: genesis, costRate: COST });
  assert.ok(Math.abs(since.policy_net_return_pct - (rows.at(-1).nav.policy_v1 - 1) * 100) < 1e-9, "окно с рождения: доходность стратегии равна опубликованному NAV − 1");
  assert.ok(Math.abs(since.hodl_net_return_pct - (rows.at(-1).nav.buy_and_hold - 1) * 100) < 1e-9, "HODL окна с рождения равен опубликованному HODL (вход 10 б.п. один раз)");
  // Внутридневные смены: доля берётся из пути, а не из целей закрытия. День с целью закрытия 10 %,
  // но 18 часов из 24 проведённый в 90 %, даёт долю по времени 70 %, а не 10 %.
  const two = [
    { t: "2026-03-01T00:00:00.000Z", price: 100, targets: { policy_v1: 10 }, nav: { policy_v1: 1, cash: 1 }, path: { policy_v1: [0, 1] } },
    { t: "2026-03-02T00:00:00.000Z", price: 110, targets: { policy_v1: 10 }, nav: { policy_v1: 1.07, cash: 1 }, path: { policy_v1: [70, 1.0705] } },
  ];
  assert.ok(Math.abs(timingNullV2(two, { costRate: COST }).share_pct - 70) < 1e-9, "средневзвешенная ПО ВРЕМЕНИ доля, а не цель закрытия");
  const twoNoPath = two.map(({ path, ...r }) => r);
  const fallback = timingNullV2(twoNoPath, { costRate: COST });
  assert.equal(fallback.share_source, "daily_targets");
  assert.ok(Math.abs(fallback.share_pct - 10) < 1e-9 && fallback.timing_pp === null, "без пути доля приблизительна, а тайминг и издержки честно не публикуются");
  assert.equal(timingNullV2([], {}), null);
  assert.equal(timingNullV2([two[0]], {}), null, "одной строки для окна мало");
}

// Постоянная доля — свой собственный ноль: разрыв нулевой при ЛЮБОМ уровне экспозиции.
for (const share of [10, 35, 80]) {
  const tn = timingNullV2(monitorRows(mkt, () => share), { costRate: COST });
  assert.ok(Math.abs(tn.share_pct - share) < 1e-9 && Math.abs(tn.timing_pp) < 1e-9 && Math.abs(tn.vs_null_pp) < 1e-9 && Math.abs(tn.sharpe_gap) < 1e-9, `постоянная доля ${share}% неотличима от своего нуля`);
}

// POWER-ТЕСТ R2: уничтоженный тайминг ловится, исправный и отсутствующий — нет.
const badTiming = runReview(monitorRows(mkt, inverted));
assert.equal(badTiming.r2_timing.status, "investigate", "инвертированный тайминг (net-гэп ≥10пп И Sharpe-гэп ≥0.35, 60+ ревью-дней) ОБЯЗАН ловиться R2");
assert.ok(badTiming.r2_timing.net_gap_pp >= 10 && badTiming.r2_timing.sharpe_gap >= 0.35 && badTiming.r2_timing.null_share_pct > 0, "числа R2 публикуются рядом со статусом");
assert.equal(badTiming.r2_timing.share_source, "exact");
const goodTiming = runReview(monitorRows(mkt, foresight));
assert.equal(goodTiming.r2_timing.status, "ok", "исправный тайминг не тревожит R2");
assert.ok(goodTiming.r2_timing.net_gap_pp < 0, "исправная политика обгоняет свой ноль");
// Ключевое свойство честного нуля: низкая доля на растущем рынке — это уровень экспозиции, а не
// тайминг. Постоянные 10 % проигрывают HODL и любой «средней» линии десятки пунктов, и R2 молчит.
// Прежний нуль static_theta (здесь он держит 60 %) давал на той же линии ложный investigate.
const bull = market(420, 11, 0.004, 0.02);
const lowShare = monitorRows(bull, () => 10, { extraNav: (i, row) => ({ static_theta: 1 + 0.6 * (row.nav.buy_and_hold - 1) }) });
const lowReview = runReview(lowShare);
assert.ok(lowShare.at(-1).nav.static_theta - lowShare.at(-1).nav.policy_v1 > 0.10, "фикстура: старый нуль обгоняет политику больше чем на 10 п.п.");
assert.equal(lowReview.r2_timing.status, "ok", "низкая, но постоянная доля — не сломанный тайминг");
assert.ok(Math.abs(lowReview.r2_timing.net_gap_pp) < 0.01 && Math.abs(lowReview.r2_timing.null_share_pct - 10) < 1e-6);
// Обратная ловушка: static_theta, повторяющая политику (до 90-го дня она и была её запаздывающей
// копией), маскировала уничтоженный тайминг. Честный ноль считается по своему окну и не маскирует.
const masked = runReview(monitorRows(mkt, inverted, { extraNav: (i, row) => ({ static_theta: row.nav.policy_v1 }) }));
assert.equal(masked.r2_timing.status, "investigate", "ноль-копия политики не имеет права гасить R2");
// Sharpe-ногу триада считает сама: внешний performance её не подменяет и не выключает.
assert.equal(runReview(monitorRows(mkt, inverted)).r2_timing.sharpe_gap, evaluateReviewV2(monitorRows(mkt, inverted), null, { policy_v1: { sharpe_excess: 9 }, static_theta: { sharpe_excess: -9 } }).r2_timing.sharpe_gap);
// Оба условия объявлены «И»: большой net-гэп при малом Sharpe-гэпе R2 не включает. Политика с
// плечом 2× к своему нулю на падающем рынке теряет больше нуля, но Sharpe у них одинаковый.
{
  const rows = monitorRows(market(420, 5, -0.002, 0.02), () => 50);
  let nav = 1; const doubled = rows.map((r, i) => { if (i) nav *= 1 + 2 * (r.nav.policy_v1 / rows[i - 1].nav.policy_v1 - 1); return { ...r, nav: { ...r.nav, policy_v1: nav } }; });
  const review = runReview(doubled);
  assert.ok(review.r2_timing.net_gap_pp >= 10 && review.r2_timing.sharpe_gap < 0.35, `фикстура: net-гэп большой, Sharpe-гэп малый: ${review.r2_timing.net_gap_pp} / ${review.r2_timing.sharpe_gap}`);
  assert.equal(review.r2_timing.status, "ok", "один net-гэп без Sharpe-гэпа R2 не включает");
}
// Без пути (строки старой формы) R2 работает по целям дневных строк и говорит об этом.
const legacyForm = runReview(monitorRows(mkt, inverted, { withPath: false }));
assert.equal(legacyForm.r2_timing.status, "investigate");
assert.equal(legacyForm.r2_timing.share_source, "daily_targets");

// МОЩНОСТЬ R2 НА РЕАЛЬНОЙ ИСТОРИИ. Полный расчёт — scripts/monitor-power-r2.mjs: реконструкция policy v1
// на 2014–2026 из исследовательского архива, 550 запусков монитора по 730 дней, критерий — этот же
// код триады. Здесь два запуска (ноябрь 2017 и октябрь 2019) как регрессия: инвертированный тайминг
// ловится в обоих, постоянная доля — ни в одном, исправная политика даёт одну ложную тревогу из
// двух (ложные тревоги у R2 есть, и тест их не прячет). Архив только читается; числа закреплены за
// архивом 2012-01-01 … 2026-07-14 (5 309 дней) — без него или на другом архиве проверка пропускается.
{
  const { r2PowerOnHistoryV1, reconstructPolicyHistoryV1 } = await import("./monitor-power-r2.mjs");
  const history = reconstructPolicyHistoryV1();
  if (history && history.rows.length === 5309 && history.rows.at(-1).date === "2026-07-14") {
    const sample = r2PowerOnHistoryV1({ history, starts: [history.first + 1400, history.first + 2100], variants: ["healthy", "const", "inverted"] });
    assert.deepEqual([sample.first, sample.last], ["2017-11-01", "2019-10-02"]);
    assert.deepEqual(sample.fired, { healthy: 1, const: 0, inverted: 2 }, "мощность R2 на истории изменилась — сверить с полным расчётом monitor-power-r2.mjs");
  }
}

// R3 — справочное число: захват публикуется, статус «review» не выставляется никогда.
const bullNav = { buy_and_hold: i => 1 + 1.0 * Math.min(1, i / 360), static_theta: i => 1 + 0.4 * Math.min(1, i / 360) };
const noCapture = evaluateReviewV2(mkRows(400, { ...bullNav, policy_v1: i => 1 + 0.10 * Math.min(1, i / 360) }), null);
assert.equal(noCapture.r3_upside_capture.status, "reference", "потерянный бычий захват остаётся числом, а не вердиктом");
assert.equal(noCapture.r3_upside_capture.bull_window, true);
assert.ok(noCapture.r3_upside_capture.capture_ratio > 0.05 && noCapture.r3_upside_capture.capture_ratio < 0.30, "захват ниже ориентира обязан быть опубликован числом");
const okCapture = evaluateReviewV2(mkRows(400, { ...bullNav, policy_v1: i => 1 + 0.45 * Math.min(1, i / 360) }), null);
assert.equal(okCapture.r3_upside_capture.status, "reference");
assert.ok(okCapture.r3_upside_capture.capture_ratio > 0.30 && okCapture.r3_upside_capture.capture_ratio < 0.60);
const flatMarket = evaluateReviewV2(mkRows(400, { buy_and_hold: i => 1 + 0.2 * Math.min(1, i / 360), policy_v1: i => 1 + 0.05 * Math.min(1, i / 360) }), null);
assert.equal(flatMarket.r3_upside_capture.bull_window, false, "не бычье окно помечается явно");
for (const r of [noCapture, okCapture, flatMarket, badTiming, goodTiming]) assert.notEqual(r.r3_upside_capture.status, "review");

// Недостаток данных — честный collecting.
const early = evaluateReviewV2(healthyRows.slice(0, 30), null);
assert.equal(early.r1_protection.status, "collecting");
assert.equal(early.r2_timing.status, "collecting");
assert.equal(early.r3_upside_capture.status, "collecting");
assert.equal(runReview(monitorRows(market(200), inverted), 150).r2_timing.status, "collecting", "окно короче 0,82·365 суток R2 не вычисляет");

// Excess-Sharpe: одна формула на монитор и триаду.
{
  const pts = [0, 1, 2, 3].map(i => ({ t: i * DAY, nav: [1, 1.02, 1.01, 1.04][i], cash: 1 + 0.0001 * i }));
  const s = excessSharpeV2(pts);
  assert.equal(s.n, 3);
  assert.ok(Number.isFinite(s.sharpe_excess) && s.sharpe_excess > 0 && s.annualized_volatility_pct > 0);
  assert.equal(excessSharpeV2(pts.map(p => ({ ...p, nav: p.cash }))).sharpe_excess, 0, "стратегия в ногу с кэшем — нулевой Sharpe, а не пробел");
  assert.equal(excessSharpeV2(pts.slice(0, 2)).sharpe_excess, null, "одной доходности для Sharpe мало");
}

// --- Машинная приёмка/фальсификация ---
const accOk = evaluateAcceptanceV2({ performance: { policy_v1: { sharpe_excess: 1.0 }, policy_v2_shadow: { sharpe_excess: 0.95 } }, shadowDays: 120, recoveryEpisodesObserved: 1 });
assert.equal(accOk.status, "switch_ready_pending_owner", "выполненные критерии дают только pending-owner, никогда авто-переключение");
assert.equal(accOk.falsified, false);
const accFalsified = evaluateAcceptanceV2({ performance: { policy_v1: { sharpe_excess: 1.0 }, policy_v2_shadow: { sharpe_excess: 0.6 } }, shadowDays: 130, recoveryEpisodesObserved: 2 });
assert.equal(accFalsified.status, "falsified", "гэп −0.4 на 130 днях ОБЯЗАН фальсифицировать кандидата (машинно, не прозой)");
const accEarlyGap = evaluateAcceptanceV2({ performance: { policy_v1: { sharpe_excess: 1.0 }, policy_v2_shadow: { sharpe_excess: 0.6 } }, shadowDays: 60, recoveryEpisodesObserved: 0 });
assert.equal(accEarlyGap.status, "collecting", "ранний гэп до falsify_min_days — ещё не фальсификация");
const accNoData = evaluateAcceptanceV2({ performance: null, shadowDays: 10, recoveryEpisodesObserved: 0 });
assert.equal(accNoData.sharpe_gap_vs_v1, null);
assert.equal(accNoData.status, "collecting");
// Разрыв на ОБЩЕМ окне главнее разрыва performance (линии родились в разные дни): монитор передаёт
// его явно, и приёмка обязана судить по нему.
const accCommon = evaluateAcceptanceV2({ performance: { policy_v1: { sharpe_excess: 1.0 }, policy_v2_shadow: { sharpe_excess: 1.2 } }, sharpeGap: -0.4, shadowDays: 130, recoveryEpisodesObserved: 1 });
assert.equal(accCommon.sharpe_gap_vs_v1, -0.4);
assert.equal(accCommon.status, "falsified", "приёмка судит по разрыву на общем окне, а не по Sharpe с разных окон");
assert.equal(evaluateAcceptanceV2({ performance: { policy_v1: { sharpe_excess: 1.0 }, policy_v2_shadow: { sharpe_excess: 1.2 } }, sharpeGap: null, shadowDays: 130, recoveryEpisodesObserved: 1 }).meets.sharpe_floor, null, "общее окно ещё не набралось — критерий честно не оценён");

console.log("Policy v2 candidate OK: shadow contract, strict-majority graduation, directional floor, two-window capitulation, review-day streaks, honest timing null, R1/R2 power tests, R3 reference, machine acceptance");
