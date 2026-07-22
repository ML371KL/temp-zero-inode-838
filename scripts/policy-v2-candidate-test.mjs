import assert from "node:assert/strict";
import { POLICY_V2_CANDIDATE, allocationTargetV2Candidate, evaluateAcceptanceV2, evaluateReviewV2, policyV2CandidateMetadata, updateV2ShadowState } from "../docs/policy-v2-candidate.mjs";
import { allocationTargetV1 } from "../docs/policy-v1.mjs";

const DAY = 86_400_000, HOUR = 3_600_000;
const T0 = Date.parse("2026-08-03T10:00:00Z");

// --- Контракт кандидата: тень, не живое решение ---
assert.equal(POLICY_V2_CANDIDATE.status, "shadow_candidate");
assert.ok(POLICY_V2_CANDIDATE.decision_record.acceptance_criteria.shadow_days_min >= 90, "предзаявленный теневой срок обязателен");
assert.ok(POLICY_V2_CANDIDATE.decision_record.acceptance_criteria.falsified_if.length > 10, "критерий фальсификации обязателен");
assert.ok(Object.isFrozen(POLICY_V2_CANDIDATE) && Object.isFrozen(POLICY_V2_CANDIDATE.decision_record), "decision record кандидата должен быть заморожен");
assert.equal(policyV2CandidateMetadata().floor_rungs, 3, "число ступеней пола публикуется для UI (знаменатель не хардкодится)");

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
let healthy = null;
for (let i = 170; i < 200; i++) healthy = evaluateReviewV2(healthyRows.slice(0, i + 1), healthy);
assert.equal(healthy.r1_protection.status, "ok", "здоровая защита не тревожит R1");
assert.equal(healthy.r1_protection.violation_streak_days, 0);

// POWER-ТЕСТ R2: сломанный тайминг (политика систематически хуже static-Θ по net И по Sharpe).
const flatTheta = { buy_and_hold: i => 1 + 0.0008 * i, static_theta: i => 1 + 0.0006 * i };
const badTimingRows = mkRows(400, { ...flatTheta, policy_v1: i => 1 + 0.0002 * i });
const perfBadTiming = { policy_v1: { sharpe_excess: 0.1 }, static_theta: { sharpe_excess: 0.9 } };
let badTiming = null;
for (let i = 330; i < 400; i++) badTiming = evaluateReviewV2(badTimingRows.slice(0, i + 1), badTiming, perfBadTiming);
assert.equal(badTiming.r2_timing.status, "investigate", "сломанный тайминг (net-гэп ≥10пп И Sharpe-гэп ≥0.35, 60+ ревью-дней) ОБЯЗАН ловиться R2");
// Без Sharpe-ноги (performance недоступен) R2 не может сработать — оба условия объявлены «И».
let netOnly = null;
for (let i = 330; i < 400; i++) netOnly = evaluateReviewV2(badTimingRows.slice(0, i + 1), netOnly, null);
assert.equal(netOnly.r2_timing.status, "ok", "один net-гэп без вычисленной Sharpe-ноги не триггерит R2 (нога не мёртвый конфиг, а условие)");
// Здоровый тайминг: политика не хуже Θ.
const goodTimingRows = mkRows(400, { ...flatTheta, policy_v1: i => 1 + 0.0007 * i });
let goodTiming = null;
for (let i = 330; i < 400; i++) goodTiming = evaluateReviewV2(goodTimingRows.slice(0, i + 1), goodTiming, { policy_v1: { sharpe_excess: 0.8 }, static_theta: { sharpe_excess: 0.7 } });
assert.equal(goodTiming.r2_timing.status, "ok", "здоровый тайминг не тревожит R2");

// POWER-ТЕСТ R3: бык HODL +100%; политика с захватом 10% — review; с захватом 45% — ok.
const bull = { buy_and_hold: i => 1 + 1.0 * Math.min(1, i / 360), static_theta: i => 1 + 0.4 * Math.min(1, i / 360) };
const noCapture = evaluateReviewV2(mkRows(400, { ...bull, policy_v1: i => 1 + 0.10 * Math.min(1, i / 360) }), null);
assert.equal(noCapture.r3_upside_capture.status, "review", "потерянный бычий захват (<30%) ОБЯЗАН ловиться R3");
const okCapture = evaluateReviewV2(mkRows(400, { ...bull, policy_v1: i => 1 + 0.45 * Math.min(1, i / 360) }), null);
assert.equal(okCapture.r3_upside_capture.status, "ok", "штатная цена тезиса (захват 45%) не тревожит R3");

// Недостаток данных — честный collecting.
const early = evaluateReviewV2(healthyRows.slice(0, 30), null);
assert.equal(early.r1_protection.status, "collecting");
assert.equal(early.r2_timing.status, "collecting");

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

console.log("Policy v2 candidate OK: shadow contract, majority-day graduation, directional floor, two-window capitulation, review-day streaks, R1/R2/R3 power tests, machine acceptance");
