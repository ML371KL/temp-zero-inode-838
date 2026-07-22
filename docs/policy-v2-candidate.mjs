// btc-decision-suite-v2-candidate — ИСПОЛНЯЕМЫЙ ТЕНЕВОЙ КАНДИДАТ. НЕ управляет живым решением.
// Живая цель по-прежнему задаётся замороженной policy v1; этот модуль вычисляется параллельно
// в форвард-мониторе (стратегия policy_v2_shadow) и копит форвардные доказательства по процедуре
// POLICY.md. Переключение на v2 — только по предзаявленным критериям приёмки (см. decision_record
// и раздел «Policy v2 candidate» в POLICY.md) и явному решению владельца отдельным релизом.
//
// Отличия v2 от v1 — ровно те, что выдержали адверсариальный челлендж 2026-07-22
// (76 агентов, каждое high-утверждение проверено двумя независимыми линзами):
//  1. НАПРАВЛЕННОЕ ПРАВИЛО РАЗРЕШЕНИЯ: risk-on переходы подтверждаются ДНЕВНЫМИ ЗАКРЫТИЯМИ UTC
//     (v1 валидирован дневным бэктестом, но исполнял пол одним часовым тиком — нетестированная
//     семантика); risk-off остаётся мгновенным (там разрыв разрешения работает в сторону защиты).
//     День подтверждает good НЕ одним последним тиком: требуется good на последнем наблюдении дня
//     И на большинстве его наблюдений — иначе один снимок в 23:xx снова давал бы однотиковый вход.
//  2. ВРЕМЕННАЯ ГРАДУИРОВКА recovery-пола 40/60/80 по последовательным подтверждённым закрытиям
//     (метрически неотличима от мгновенного 80: Sharpe p≈0.76 — но убирает скачок +60пп по одному
//     неподтверждённому тику; сработка 22.07 дала бы 40, не 80). Отвергнутые с числами
//     альтернативы НЕ применять: строгий порог ног >0 (теряет 2019-03, fwd90 +222%), градуировка
//     по ЧИСЛУ ног (верхняя ступень не встречалась в истории ни разу), dwell-фильтры ≥5 дней
//     (режут fwd30 с +10.2% до +0.5%).
//  3. КАПИТУЛЯЦИОННЫЙ ПОЛ — согласие двух окон MVRV: 4-летнего и ПОЛНОЙ доступной глубины ряда
//     (якоря критически неустойчивы к укорочению окна; двухоконное согласие режет хвост произвола
//     ценой 1.5–7.7% флипов). При недоступном/протухшем глубоком окне пол честно работает по
//     одному окну (поведение v1) — деградация данных не отключает защиту; факт публикуется в
//     v2_candidate.inputs. Euphoria-потолок остаётся одноконным (safety-правило не ослабляется).
//  4. РЕВЬЮ-ТРИАДА R1/R2/R3 вместо investigate/retirement v1, у которых измеренная мощность
//     нулевая и инвертированная (сломанная политика тревожит РЕЖЕ здоровой; 44.5% ложных дней).
//     Выдержки триады деноминированы в РЕВЬЮ-ДНЯХ (UTC-день меняется), не в вызовах коллектора —
//     ежечасный прогон не ускоряет течение персистентности. Каждый критерий обязан проходить
//     power-тест на сломанных вариантах (см. тест модуля: R1, R2 и R3).
// Лестница, веса, гейты, гистерезис вердикта — НЕ меняются (середина лестницы объявляется
// порядковой: плато det 10–35 / tra 30–60 в пределах 0.06 Sharpe; перекалибровка запрещена).

export const POLICY_V2_CANDIDATE = Object.freeze({
  id: "btc-decision-suite-v2-candidate",
  version: 2,
  status: "shadow_candidate",
  created: "2026-07-22",
  base_suite: "btc-decision-suite-v1",
  floor_ladder_pct: Object.freeze([40, 60, 80]),
  decision_record: Object.freeze({
    objective: "Устранить три подтверждённых дефекта v1 (нетестированное часовое исполнение risk-on оверлея; скачок +60пп одним тиком; ревью-критерии с нулевой/инвертированной мощностью), не трогая источник ценности — режимный тайминг и структуру лестницы.",
    risk_budget: "Ожидаемое отличие от v1 по Sharpe в пределах шума (градуировка неотличима, p≈0.76); допустимая цена — до +0.33% упущенного хода на recovery-эпизод (медиана отрицательная).",
    evidence_basis: "Челлендж 2026-07-22: дневной архив 5309 дней, 38 recovery-эпизодов (11 binding 2019+), скользящие ревью-окна 2019–2026, live-история 262 часовых снимков.",
    acceptance_criteria: Object.freeze({
      shadow_days_min: 90,
      sharpe_floor_vs_v1: -0.10,
      falsify_sharpe_gap: -0.25,
      falsify_min_days: 120,
      switch_requires_all: Object.freeze([
        "shadow_days >= 90",
        "sharpe(policy_v2_shadow) - sharpe(policy_v1) >= -0.10 на всём теневом окне",
        "зафиксирован >=1 recovery-эпизод в тени ИЛИ прошло >=180 дней",
        "все тесты зелёные; ноль операционных инцидентов, вызванных вычислением v2",
        "явное решение владельца отдельным релизом",
      ]),
      falsified_if: "sharpe(policy_v2_shadow) < sharpe(policy_v1) - 0.25 на окне >=120 дней — кандидат отклоняется, запись сохраняется.",
    }),
  }),
});

const finite = x => x !== null && x !== "" && Number.isFinite(Number(x));
const DAY = 86_400_000;
const utcDay = t => Math.floor(t / DAY);

// Состояние градуировки. Счётчик закрытий насыщается на длине лестницы (публикуется как есть —
// «12/3» на панели невозможно). День подтверждает good, только если good и ПОСЛЕДНЕЕ наблюдение
// дня, и БОЛЬШИНСТВО его наблюдений; ненаблюдённые сутки (дыры каденса) подтверждений не дают.
// Применение пола дополнительно требует good прямо сейчас (risk-off мгновенен) — см. allocation.
export function updateV2ShadowState(previousState, now, recoveryGood) {
  const p = previousState && typeof previousState === "object" ? previousState : null;
  const state = {
    closes: Math.min(POLICY_V2_CANDIDATE.floor_ladder_pct.length, Number(p?.closes) || 0),
    day: Number.isFinite(Number(p?.day)) && p?.day !== null ? Number(p.day) : null,
    day_ticks: Number(p?.day_ticks) || 0,
    day_good_ticks: Number(p?.day_good_ticks) || 0,
    day_last_good: !!p?.day_last_good,
  };
  const today = utcDay(now);
  if (state.day === null) return { closes: 0, day: today, day_ticks: 1, day_good_ticks: recoveryGood ? 1 : 0, day_last_good: !!recoveryGood };
  if (today > state.day) {
    const gap = today - state.day;
    const confirmed = state.day_last_good && state.day_good_ticks * 2 >= state.day_ticks && state.day_ticks > 0;
    let closes = confirmed ? Math.min(POLICY_V2_CANDIDATE.floor_ladder_pct.length, state.closes + 1) : 0;
    if (gap > 1) closes = 0; // целые ненаблюдённые сутки не могут ничего подтвердить
    return { closes, day: today, day_ticks: 1, day_good_ticks: recoveryGood ? 1 : 0, day_last_good: !!recoveryGood };
  }
  return { closes: state.closes, day: state.day, day_ticks: state.day_ticks + 1, day_good_ticks: state.day_good_ticks + (recoveryGood ? 1 : 0), day_last_good: !!recoveryGood };
}

// Теневая цель v2. mvrvPercentileDeep — перцентиль по ПОЛНОЙ доступной глубине ряда (см. сборщик:
// без усечения окна, с гардом свежести); null => пол работает по одному окну, как в v1.
export function allocationTargetV2Candidate({ strategic, recoveryState, macroShockState, mvrvPercentile, mvrvPercentileDeep = null, recoveryCloses = 0 }) {
  const LADDER = { emergency: 0, defensive: 5, deteriorating: 20, transition: 45, unconfirmed_positive: 95, constructive: 100 };
  if (strategic === "insufficient") return null;
  if (strategic === "emergency") return 0;
  let target = LADDER[strategic];
  if (!finite(target)) return null;
  const rung = Math.min(POLICY_V2_CANDIDATE.floor_ladder_pct.length, Math.max(0, Math.floor(recoveryCloses)));
  const floorLevel = rung > 0 ? POLICY_V2_CANDIDATE.floor_ladder_pct[rung - 1] : null;
  if (recoveryState === "good" && macroShockState !== "fired" && finite(floorLevel) && target < floorLevel) target = floorLevel;
  const capitulation4y = finite(mvrvPercentile) && Number(mvrvPercentile) <= 10;
  const capitulationDeep = !finite(mvrvPercentileDeep) || Number(mvrvPercentileDeep) <= 10;
  if (capitulation4y && capitulationDeep && target < 40) target = 40;
  if (finite(mvrvPercentile) && Number(mvrvPercentile) >= 95 && target > 60) target = 60;
  return target;
}

// Оконная статистика по ДНЕВНЫМ закрытиям NAV. R1 сознательно меряет просадку по закрытиям, а не
// по интрадей-пикам монитора: порог 0.7 откалиброван челленджем на дневном архиве, и его нуль
// обязан считаться той же линейкой (в performance-блоке живёт другая, интрадей-метрика — это
// разные определения по построению, не рассинхрон).
const navStats = (rows, name, windowDays) => {
  const cut = rows.length ? Date.parse(rows.at(-1).t) - windowDays * DAY : 0;
  const w = rows.filter(r => Date.parse(r.t) >= cut && finite(r.nav?.[name]));
  if (w.length < 2) return null;
  const navs = w.map(r => Number(r.nav[name]));
  let peak = navs[0], maxDd = 0;
  for (const v of navs) { peak = Math.max(peak, v); maxDd = Math.min(maxDd, v / peak - 1); }
  return { net: navs.at(-1) / navs[0] - 1, max_dd: maxDd, days: (Date.parse(w.at(-1).t) - Date.parse(w[0].t)) / DAY };
};

const T = Object.freeze({
  r1: Object.freeze({ hodl_dd_min: -0.25, dd_ratio_max: 0.7, persist_days: 14, window_days: 180 }),
  r2: Object.freeze({ sharpe_gap_min: 0.35, net_gap_pp_min: 10, persist_days: 60, window_days: 365 }),
  r3: Object.freeze({ hodl_net_min: 0.80, capture_min: 0.30, window_days: 365 }),
});

// Персистентность в РЕВЬЮ-ДНЯХ: стрик растёт не чаще раза за UTC-день (день берётся из последней
// дневной строки — ежечасные вызовы одного дня не ускоряют выдержку), сбрасывается любым
// ненарушающим вычислением. performance (опционально) даёт Sharpe-ногу R2: без него нога честно
// не оценивается, и R2 не может сработать по одному net-гэпу — оба условия объявлены «И».
export function evaluateReviewV2(dailyRows, previousReview, performance = null) {
  const prev = previousReview && typeof previousReview === "object" ? previousReview : {};
  const rows = Array.isArray(dailyRows) ? dailyRows : [];
  const reviewDay = rows.length ? utcDay(Date.parse(rows.at(-1).t)) : null;
  const streak = (prevBlock, violated) => {
    const s = { days: Number(prevBlock?.violation_streak_days) || 0, last: Number.isFinite(Number(prevBlock?.last_streak_day)) ? Number(prevBlock.last_streak_day) : null };
    if (!violated) return { days: 0, last: null };
    if (reviewDay === null) return s;
    if (s.last === null || reviewDay > s.last) return { days: s.days + 1, last: reviewDay };
    return s;
  };
  const out = {
    schema: 2,
    r1_protection: { status: "collecting", detail: null, violation_streak_days: 0, last_streak_day: null },
    r2_timing: { status: "collecting", detail: null, violation_streak_days: 0, last_streak_day: null },
    r3_upside_capture: { status: "collecting", detail: null },
    thresholds: T,
  };
  // R1 — тезис-тест защиты: в стрессовом окне просадка политики не глубже dd_ratio_max от HODL.
  const hodl180 = navStats(rows, "buy_and_hold", T.r1.window_days), pol180 = navStats(rows, "policy_v1", T.r1.window_days);
  if (hodl180 && pol180 && hodl180.days >= T.r1.window_days * 0.83) {
    if (hodl180.max_dd <= T.r1.hodl_dd_min) {
      const ratio = Math.abs(pol180.max_dd) / Math.abs(hodl180.max_dd);
      const s = streak(prev.r1_protection, ratio > T.r1.dd_ratio_max);
      out.r1_protection.violation_streak_days = s.days; out.r1_protection.last_streak_day = s.last;
      out.r1_protection.status = s.days >= T.r1.persist_days ? "investigate" : "ok";
      out.r1_protection.detail = `стресс-окно: HODL DD ${(hodl180.max_dd * 100).toFixed(1)}%, политика ${(pol180.max_dd * 100).toFixed(1)}%, отношение ${ratio.toFixed(2)} (порог ${T.r1.dd_ratio_max})`;
    } else {
      out.r1_protection.status = "ok";
      out.r1_protection.detail = `не стресс-окно (HODL DD ${(hodl180.max_dd * 100).toFixed(1)}% > ${T.r1.hodl_dd_min * 100}%)`;
    }
  }
  // R2 — тайминг против честного нуля static-Θ: ОБА условия (net-гэп И Sharpe-гэп).
  const pol365 = navStats(rows, "policy_v1", T.r2.window_days), theta365 = navStats(rows, "static_theta", T.r2.window_days);
  if (pol365 && theta365 && pol365.days >= T.r2.window_days * 0.82) {
    const netGapPp = (theta365.net - pol365.net) * 100;
    const sharpePol = performance?.policy_v1?.sharpe_excess, sharpeTheta = performance?.static_theta?.sharpe_excess;
    const sharpeGap = finite(sharpePol) && finite(sharpeTheta) ? Number(sharpeTheta) - Number(sharpePol) : null;
    const violated = netGapPp >= T.r2.net_gap_pp_min && finite(sharpeGap) && sharpeGap >= T.r2.sharpe_gap_min;
    const s = streak(prev.r2_timing, violated);
    out.r2_timing.violation_streak_days = s.days; out.r2_timing.last_streak_day = s.last;
    out.r2_timing.status = s.days >= T.r2.persist_days ? "investigate" : "ok";
    out.r2_timing.detail = `net static-Θ − политика = ${netGapPp.toFixed(1)}пп (порог ${T.r2.net_gap_pp_min}) · Sharpe-гэп ${finite(sharpeGap) ? sharpeGap.toFixed(2) : "—"} (порог ${T.r2.sharpe_gap_min}) · выдержка ${s.days}/${T.r2.persist_days} ревью-дней`;
  }
  // R3 — захват бычьего хода.
  const hodl365 = navStats(rows, "buy_and_hold", T.r3.window_days);
  if (hodl365 && pol365 && hodl365.days >= T.r3.window_days * 0.82) {
    if (hodl365.net >= T.r3.hodl_net_min) {
      const capture = hodl365.net > 0 ? pol365.net / hodl365.net : null;
      out.r3_upside_capture.status = finite(capture) && capture < T.r3.capture_min ? "review" : "ok";
      out.r3_upside_capture.detail = `HODL +${(hodl365.net * 100).toFixed(0)}%, политика +${(pol365.net * 100).toFixed(0)}%, захват ${finite(capture) ? (capture * 100).toFixed(0) + "%" : "—"} (порог ${T.r3.capture_min * 100}%)`;
    } else {
      out.r3_upside_capture.status = "ok";
      out.r3_upside_capture.detail = `не бычье окно (HODL ${(hodl365.net * 100).toFixed(0)}% < +${T.r3.hodl_net_min * 100}%)`;
    }
  }
  return out;
}

// Машинная оценка предзаявленных критериев приёмки/фальсификации — чтобы «falsified_if» был
// вычисляемым инвариантом, а не прозой (класс дефекта v1: заявленная чувствительность без кода).
export function evaluateAcceptanceV2({ performance = null, shadowDays = 0, recoveryEpisodesObserved = 0 } = {}) {
  const a = POLICY_V2_CANDIDATE.decision_record.acceptance_criteria;
  const sharpeV2 = performance?.policy_v2_shadow?.sharpe_excess, sharpeV1 = performance?.policy_v1?.sharpe_excess;
  const gap = finite(sharpeV2) && finite(sharpeV1) ? Number(sharpeV2) - Number(sharpeV1) : null;
  const falsified = finite(gap) && gap < a.falsify_sharpe_gap && shadowDays >= a.falsify_min_days;
  const meets = {
    shadow_days: shadowDays >= a.shadow_days_min,
    sharpe_floor: finite(gap) ? gap >= a.sharpe_floor_vs_v1 : null,
    episode_or_180d: recoveryEpisodesObserved >= 1 || shadowDays >= 180,
  };
  return {
    shadow_days: shadowDays,
    sharpe_gap_vs_v1: finite(gap) ? Number(gap.toFixed(4)) : null,
    recovery_episodes_observed: recoveryEpisodesObserved,
    falsified,
    meets,
    status: falsified ? "falsified" : (meets.shadow_days && meets.sharpe_floor === true && meets.episode_or_180d ? "switch_ready_pending_owner" : "collecting"),
  };
}

export function policyV2CandidateMetadata() { return { id: POLICY_V2_CANDIDATE.id, version: POLICY_V2_CANDIDATE.version, status: POLICY_V2_CANDIDATE.status, created: POLICY_V2_CANDIDATE.created, base_suite: POLICY_V2_CANDIDATE.base_suite, floor_rungs: POLICY_V2_CANDIDATE.floor_ladder_pct.length, floor_ladder_pct: [...POLICY_V2_CANDIDATE.floor_ladder_pct] }; }
