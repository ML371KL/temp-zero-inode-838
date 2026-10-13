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
//  5. МИНИМАЛЬНЫЙ ИНТЕРВАЛ ПОДТВЕРЖДЕНИЯ RISK-OFF (предзаявление, аудит 15 суток прода
//     2026-07-28). Гистерезис v1 считает подтверждение понижения в СНИМКАХ («2 подряд»), а такт
//     нерегулярен: за 464 наблюдённых интервала медиана 59.7 мин, но 66 интервалов короче 10 мин
//     (двойной планировщик, ручные прогоны, пуш+dispatch). 2026-07-24 это материализовалось:
//     переход в «защитный» подтвердился за 24 минуты вместо ~2 часов штатного такта. Правило v2:
//     подтверждающие risk-off снимки обязаны отстоять друг от друга не менее чем на
//     `risk_off_min_confirm_minutes`; 30 мин — минимум, снимающий бурст-артефакты и при этом
//     никогда не задерживающий штатный часовой такт (рассматривалось 45 — отвергнуто: запас над
//     наблюдаемым тактом меньше, выигрыш тот же). ВАЖНО: правило НЕ исполняется тенью и не влияет
//     на её NAV — гистерезис вердикта живёт в замороженной секции v1, тень едет на УЖЕ
//     опубликованном режиме v1. До переключения правило только предзаявлено, а счётчик
//     `monitoring.shadow_hysteresis` копит форвардные свидетельства (сколько понижений было
//     подтверждено быстрее минимального интервала). Порог берётся ОТСЮДА и сборщиком, и монитором:
//     единственный источник правды, иначе публикуемое значение разъедется с исполняемым.
// Лестница, веса, гейты, гистерезис вердикта — НЕ меняются (середина лестницы объявляется
// порядковой: плато det 10–35 / tra 30–60 в пределах 0.06 Sharpe; перекалибровка запрещена).
//
// РЕВИЗИЯ 2 (аудит 2026-10-10, 83 суток форварда). Решающее правило тени не тронуто; исправлено
// то, чем кандидат измеряется:
//  а) «большинство наблюдений дня» — строго больше половины (код засчитывал ровно половину; на
//     истории тени таких дней не было, путь тени не изменился);
//  б) R2 сравнивает политику с ЧЕСТНЫМ нулём — постоянной долей, равной средневзвешенной по времени
//     доле политики ЗА ТО ЖЕ ОКНО, посчитанной задним числом. Прежний нуль static_theta до 90-го дня
//     был скользящим средним целей самой политики, то есть её запаздывающей копией: средняя доля
//     26,6 % против 32,9 % у политики, разрыв показан 4,4 п.п. вместо 8,0. На реконструкции
//     2014–2026 честный нуль ловит уничтоженный тайминг в 63–72 % запусков при 22 % ложных тревог
//     (static_theta: 46–68 % при 16 %);
//  в) R3 — справочное число без статуса: на исправной политике он срабатывал в 57 % запусков, на
//     инвертированной — в 51 %;
//  г) правило 5 переопределено отсчётом от ПЕРВОГО встречного снимка: с 07.08.2026 такт сбора —
//     15 минут, и условие «до предыдущего снимка меньше 30 минут» стало истинным на каждом прогоне
//     (при буквальном исполнении понижение не подтвердилось бы никогда). Теперь: понижение
//     подтверждает встречный снимок, отстоящий от первого встречного снимка серии не меньше чем на
//     `risk_off_min_confirm_minutes`. Часовой такт по-прежнему не задерживается, такт 15 минут
//     подтверждает на один прогон позже, бурст — когда наберётся интервал;
//  д) приёмка: теневые дни — от рождения тени, разрыв Sharpe — на общем с v1 окне.

export const POLICY_V2_CANDIDATE = Object.freeze({
  id: "btc-decision-suite-v2-candidate",
  version: 2,
  revision: 2,
  status: "shadow_candidate",
  created: "2026-07-22",
  revised: "2026-10-10",
  base_suite: "btc-decision-suite-v1",
  floor_ladder_pct: Object.freeze([40, 60, 80]),
  hysteresis: Object.freeze({
    risk_off_min_confirm_minutes: 30,
    risk_off_confirm_reference: "first_counter_snapshot",
    enforcement: "on_switch_only",
    rationale: "Подтверждение понижения в снимках вырождается в минуты (24.07.2026: 24 мин вместо ~2 ч; с 07.08.2026 такт 15 мин — каждое понижение за 15 мин). Интервал отсчитывается от первого встречного снимка серии. Тень исполнять правило не может — гистерезис вердикта в замороженной секции v1; до переключения копится телеметрия shadow_hysteresis.",
  }),
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
// дня, и БОЛЬШИНСТВО его наблюдений — строго больше половины: при ровно половине большинства нет,
// и такой день не подтверждает (ревизия 2); ненаблюдённые сутки (дыры каденса) подтверждений не дают.
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
    const confirmed = state.day_last_good && state.day_good_ticks * 2 > state.day_ticks;
    let closes = confirmed ? Math.min(POLICY_V2_CANDIDATE.floor_ladder_pct.length, state.closes + 1) : 0;
    if (gap > 1) closes = 0; // целые ненаблюдённые сутки не могут ничего подтвердить
    return { closes, day: today, day_ticks: 1, day_good_ticks: recoveryGood ? 1 : 0, day_last_good: !!recoveryGood };
  }
  return { closes: state.closes, day: state.day, day_ticks: state.day_ticks + 1, day_good_ticks: state.day_good_ticks + (recoveryGood ? 1 : 0), day_last_good: !!recoveryGood };
}

// Теневая цель v2. mvrvPercentileDeep — перцентиль по ПОЛНОЙ доступной глубине ряда (см. сборщик:
// без усечения окна, с гардом свежести); null => пол работает по одному окну, как в v1.
export function allocationTargetV2Candidate(input) {
  return allocationDecisionV2Candidate(input).target_pct;
}

// То же решение с разбором: базовая ступень лестницы и связывающие оверлеи. Счётчику
// recovery-эпизодов нужно знать, что цель держит именно градуированный пол, а не лестница:
// сравнение «цель тени выше цели v1» этого не показывает — пол тени не бывает выше пола v1.
export function allocationDecisionV2Candidate({ strategic, recoveryState, macroShockState, mvrvPercentile, mvrvPercentileDeep = null, recoveryCloses = 0 } = {}) {
  const LADDER = { emergency: 0, defensive: 5, deteriorating: 20, transition: 45, unconfirmed_positive: 95, constructive: 100 };
  const none = { target_pct: null, base_target_pct: null, binding_overlays: [] };
  if (strategic === "insufficient") return none;
  if (strategic === "emergency") return { target_pct: 0, base_target_pct: 0, binding_overlays: ["emergency_override"] };
  const base = LADDER[strategic];
  if (!finite(base)) return none;
  let target = base;
  const binding = [];
  const rung = Math.min(POLICY_V2_CANDIDATE.floor_ladder_pct.length, Math.max(0, Math.floor(recoveryCloses)));
  const floorLevel = rung > 0 ? POLICY_V2_CANDIDATE.floor_ladder_pct[rung - 1] : null;
  if (recoveryState === "good" && macroShockState !== "fired" && finite(floorLevel) && target < floorLevel) { target = floorLevel; binding.push("recovery_floor"); }
  const capitulation4y = finite(mvrvPercentile) && Number(mvrvPercentile) <= 10;
  const capitulationDeep = !finite(mvrvPercentileDeep) || Number(mvrvPercentileDeep) <= 10;
  if (capitulation4y && capitulationDeep && target < 40) { target = 40; binding.push("capitulation_floor"); }
  if (finite(mvrvPercentile) && Number(mvrvPercentile) >= 95 && target > 60) { target = 60; binding.push("euphoria_safety_cap"); }
  return { target_pct: target, base_target_pct: base, binding_overlays: binding };
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

// Excess-Sharpe по ряду точек {t, nav, cash}: доходности между соседними точками, избыточная —
// минус доходность кэша за тот же шаг, годовая шкала по фактическому среднему шагу. Одна формула
// на монитор и на триаду: разрыв Sharpe двух линий осмыслен, только если он посчитан одной
// линейкой по одним и тем же суткам. Тождественно нулевой excess — нулевой Sharpe, а не пробел.
export function excessSharpeV2(points) {
  const p = (Array.isArray(points) ? points : []).filter(x => finite(x?.nav) && finite(x?.cash) && finite(x?.t));
  const returns = [], excess = [], dtDays = [];
  for (let i = 1; i < p.length; i++) {
    const nav0 = Number(p[i - 1].nav), cash0 = Number(p[i - 1].cash);
    if (!(nav0 > 0 && cash0 > 0)) continue;
    const r = Number(p[i].nav) / nav0 - 1, c = Number(p[i].cash) / cash0 - 1;
    returns.push(r); excess.push(r - c);
    dtDays.push(Math.max(1, (Number(p[i].t) - Number(p[i - 1].t)) / DAY));
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const stdev = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const perYear = dtDays.length ? 365 / Math.max(1, mean(dtDays)) : 365;
  const sd = stdev(returns), sdExcess = stdev(excess), EPS = 1e-12;
  const sharpe = excess.length >= 2 ? (sdExcess > EPS ? mean(excess) / sdExcess * Math.sqrt(perYear) : (Math.abs(mean(excess)) <= EPS ? 0 : null)) : null;
  return { n: returns.length, sharpe_excess: sharpe, annualized_volatility_pct: sd == null ? null : sd * Math.sqrt(perYear) * 100 };
}

// ЧЕСТНЫЙ НОЛЬ ТАЙМИНГА. Постоянная доля, равная средневзвешенной ПО ВРЕМЕНИ доле стратегии за окно,
// считается задним числом: уровень экспозиции у нуля тот же, что у стратегии, поэтому разница
// между ними — тайминг и издержки, и ничего больше. Окно — от `start` (виртуальная строка начала:
// генезис монитора или рождение линии; без неё — первая дневная строка) до последней строки
// (текущий прогон). Доля — точная, из накопленного интеграла цели (`path[name] = [доля·сутки,
// валовой NAV]` в дневной строке либо `start`/`end`), а без него — по целям дневных строк
// (внутридневные смены в таком счёте теряются; источник назван в `share_source`).
// NAV нуля — по дневной сетке (цена и NAV кэша строк). Все три портфеля открываются в начале окна
// и платят вход со своей стартовой доли: окно «с начала» тогда совпадает с опубликованным NAV.
// Разложение разницы с HODL точное: уровень (ноль − HODL) + тайминг (стратегия − ноль) — оба до
// издержек — + издержки. Sharpe обеих линий — по закрытым суткам окна (последняя строка — текущие).
export function timingNullV2(rows, { name = "policy_v1", start = null, end = null, costRate = 0.001 } = {}) {
  const all = (Array.isArray(rows) ? rows : []).filter(r => finite(Date.parse(r?.t)) && finite(r?.price) && Number(r.price) > 0 && finite(r?.nav?.cash) && Number(r.nav.cash) > 0);
  const pathOf = r => Array.isArray(r?.path?.[name]) && finite(r.path[name][0]) && finite(r.path[name][1]) ? { w_days: Number(r.path[name][0]), gross: Number(r.path[name][1]) } : null;
  const first = start
    ? { t: start.t, price: Number(start.price), cash: Number(start.cash_nav), nav: Number(start.nav), target: start.target_pct, path: finite(start.w_days) && finite(start.gross) ? { w_days: Number(start.w_days), gross: Number(start.gross) } : null, row: false }
    : all.length ? { t: all[0].t, price: Number(all[0].price), cash: Number(all[0].nav.cash), nav: Number(all[0].nav?.[name]), target: all[0].targets?.[name], path: pathOf(all[0]), row: true } : null;
  const t0 = Date.parse(first?.t);
  if (!first || !finite(t0) || !(first.price > 0) || !(first.cash > 0) || !(first.nav > 0)) return null;
  const grid = all.filter(r => Date.parse(r.t) > t0 && finite(r.nav?.[name]));
  if (!grid.length) return null;
  const last = grid.at(-1), t1 = Date.parse(last.t), days = (t1 - t0) / DAY;
  const lastPath = end && finite(end.w_days) && finite(end.gross) ? { w_days: Number(end.w_days), gross: Number(end.gross) } : pathOf(last);
  let share = null, source = null;
  if (first.path && lastPath) { share = (lastPath.w_days - first.path.w_days) / days; source = "exact"; }
  else {
    // Цель дневной строки держится до следующей строки.
    let acc = 0, prevT = t0, prevTarget = first.target, known = true;
    for (const r of grid) {
      if (!finite(prevTarget)) { known = false; break; }
      const t = Date.parse(r.t); acc += Number(prevTarget) * (t - prevT); prevT = t; prevTarget = r.targets?.[name];
    }
    if (known) { share = acc / (t1 - t0); source = "daily_targets"; }
  }
  if (!finite(share)) return null;
  const w = share / 100;
  let constG = 1, prevPrice = first.price, prevCash = first.cash;
  const nullPoints = first.row ? [{ t: t0, nav: 1, cash: first.cash }] : [], policyPoints = first.row ? [{ t: t0, nav: first.nav, cash: first.cash }] : [];
  grid.forEach((r, i) => {
    const price = Number(r.price), cash = Number(r.nav.cash);
    constG *= 1 + w * (price / prevPrice - 1) + (1 - w) * (cash / prevCash - 1);
    prevPrice = price; prevCash = cash;
    if (i < grid.length - 1) { nullPoints.push({ t: Date.parse(r.t), nav: constG, cash }); policyPoints.push({ t: Date.parse(r.t), nav: Number(r.nav[name]), cash }); }
  });
  const navEnd = finite(end?.nav) ? Number(end.nav) : Number(last.nav[name]);
  const entry = finite(first.target) ? 1 - Math.abs(Number(first.target)) / 100 * costRate : 1;
  const hodlG = Number(last.price) / first.price, hodl = hodlG * (1 - costRate);
  const policy = navEnd / first.nav * entry, nullNet = constG * (1 - Math.abs(w) * costRate);
  const policyG = first.path && lastPath && first.path.gross > 0 ? lastPath.gross / first.path.gross : null;
  const nullSharpe = excessSharpeV2(nullPoints).sharpe_excess, policySharpe = excessSharpeV2(policyPoints).sharpe_excess;
  return {
    from: new Date(t0).toISOString(), to: new Date(t1).toISOString(), days,
    share_pct: share, share_source: source,
    policy_net_return_pct: (policy - 1) * 100, null_net_return_pct: (nullNet - 1) * 100, hodl_net_return_pct: (hodl - 1) * 100,
    vs_null_pp: (policy - nullNet) * 100, vs_hodl_pp: (policy - hodl) * 100,
    level_pp: (constG - hodlG) * 100,
    timing_pp: policyG === null ? null : (policyG - constG) * 100,
    costs_pp: policyG === null ? null : ((policy - policyG) - (hodl - hodlG)) * 100,
    capture_ratio: hodl > 1 ? (policy - 1) / (hodl - 1) : null,
    closed_rows: policyPoints.length, policy_sharpe: policySharpe, null_sharpe: nullSharpe,
    sharpe_gap: finite(nullSharpe) && finite(policySharpe) ? nullSharpe - policySharpe : null,
  };
}

// Персистентность в РЕВЬЮ-ДНЯХ: стрик растёт не чаще раза за UTC-день (день берётся из последней
// дневной строки — частые вызовы одного дня не ускоряют выдержку), сбрасывается любым
// ненарушающим вычислением. Третий параметр оставлен ради совместимости вызова: Sharpe-ногу R2
// триада теперь считает сама, по закрытым суткам того же окна, что и net-ногу.
// Числа каждого критерия публикуются рядом со статусом — витрина показывает их, а не голый код.
export function evaluateReviewV2(dailyRows, previousReview, performance = null, { costRate = 0.001 } = {}) {
  const prev = previousReview && typeof previousReview === "object" ? previousReview : {};
  const rows = Array.isArray(dailyRows) ? dailyRows : [];
  const reviewDay = rows.length ? utcDay(Date.parse(rows.at(-1).t)) : null;
  const round = (x, d = 4) => finite(x) ? Number(Number(x).toFixed(d)) + 0 : null;
  const streak = (prevBlock, violated) => {
    const s = { days: Number(prevBlock?.violation_streak_days) || 0, last: Number.isFinite(Number(prevBlock?.last_streak_day)) ? Number(prevBlock.last_streak_day) : null };
    if (!violated) return { days: 0, last: null };
    if (reviewDay === null) return s;
    if (s.last === null || reviewDay > s.last) return { days: s.days + 1, last: reviewDay };
    return s;
  };
  const out = {
    schema: 3,
    r1_protection: { status: "collecting", detail: null, violation_streak_days: 0, last_streak_day: null },
    r2_timing: { status: "collecting", detail: null, violation_streak_days: 0, last_streak_day: null },
    r3_upside_capture: { status: "collecting", detail: null },
    thresholds: T,
  };
  // R1 — тезис-тест защиты: в стрессовом окне просадка политики не глубже dd_ratio_max от HODL.
  const hodl180 = navStats(rows, "buy_and_hold", T.r1.window_days), pol180 = navStats(rows, "policy_v1", T.r1.window_days);
  if (hodl180 && pol180 && hodl180.days >= T.r1.window_days * 0.83) {
    out.r1_protection.hodl_drawdown_pct = round(hodl180.max_dd * 100); out.r1_protection.policy_drawdown_pct = round(pol180.max_dd * 100);
    if (hodl180.max_dd <= T.r1.hodl_dd_min) {
      const ratio = Math.abs(pol180.max_dd) / Math.abs(hodl180.max_dd);
      const s = streak(prev.r1_protection, ratio > T.r1.dd_ratio_max);
      out.r1_protection.violation_streak_days = s.days; out.r1_protection.last_streak_day = s.last;
      out.r1_protection.status = s.days >= T.r1.persist_days ? "investigate" : "ok";
      out.r1_protection.drawdown_ratio = round(ratio);
      out.r1_protection.detail = `стресс-окно: HODL DD ${(hodl180.max_dd * 100).toFixed(1)}%, политика ${(pol180.max_dd * 100).toFixed(1)}%, отношение ${ratio.toFixed(2)} (порог ${T.r1.dd_ratio_max})`;
    } else {
      out.r1_protection.status = "ok";
      out.r1_protection.detail = `не стресс-окно (HODL DD ${(hodl180.max_dd * 100).toFixed(1)}% > ${T.r1.hodl_dd_min * 100}%)`;
    }
  }
  // R2 — тайминг против ЧЕСТНОГО нуля на том же окне: ОБА условия (net-гэп И Sharpe-гэп).
  const cut = rows.length ? Date.parse(rows.at(-1).t) - T.r2.window_days * DAY : 0;
  const honest = timingNullV2(rows.filter(r => Date.parse(r.t) >= cut), { name: "policy_v1", costRate });
  if (honest && honest.days >= T.r2.window_days * 0.82) {
    const netGapPp = -honest.vs_null_pp, sharpeGap = honest.sharpe_gap;
    const violated = netGapPp >= T.r2.net_gap_pp_min && finite(sharpeGap) && sharpeGap >= T.r2.sharpe_gap_min;
    const s = streak(prev.r2_timing, violated);
    Object.assign(out.r2_timing, {
      violation_streak_days: s.days, last_streak_day: s.last, status: s.days >= T.r2.persist_days ? "investigate" : "ok",
      window_days: round(honest.days, 2), null_share_pct: round(honest.share_pct, 2), share_source: honest.share_source,
      net_gap_pp: round(netGapPp), sharpe_gap: round(sharpeGap),
      detail: `честный ноль (доля ${honest.share_pct.toFixed(1)}%) − политика = ${netGapPp.toFixed(1)}пп (порог ${T.r2.net_gap_pp_min}) · Sharpe-гэп ${finite(sharpeGap) ? sharpeGap.toFixed(2) : "—"} (порог ${T.r2.sharpe_gap_min}) · выдержка ${s.days}/${T.r2.persist_days} ревью-дней`,
    });
  }
  // R3 — захват бычьего хода: СПРАВОЧНОЕ число. Статус по нему не выставляется: на исправной
  // политике порог срабатывал в 57 % запусков реконструкции, на инвертированной — в 51 %.
  const pol365 = navStats(rows, "policy_v1", T.r3.window_days), hodl365 = navStats(rows, "buy_and_hold", T.r3.window_days);
  if (hodl365 && pol365 && hodl365.days >= T.r3.window_days * 0.82) {
    const bull = hodl365.net >= T.r3.hodl_net_min, capture = hodl365.net > 0 ? pol365.net / hodl365.net : null;
    Object.assign(out.r3_upside_capture, {
      status: "reference", bull_window: bull, hodl_net_pct: round(hodl365.net * 100, 2), policy_net_pct: round(pol365.net * 100, 2), capture_ratio: round(capture),
      detail: bull
        ? `HODL +${(hodl365.net * 100).toFixed(0)}%, политика ${pol365.net >= 0 ? "+" : ""}${(pol365.net * 100).toFixed(0)}%, захват ${finite(capture) ? (capture * 100).toFixed(0) + "%" : "—"} (ориентир ${T.r3.capture_min * 100}%)`
        : `не бычье окно (HODL ${(hodl365.net * 100).toFixed(0)}% < +${T.r3.hodl_net_min * 100}%)`,
    });
  }
  return out;
}

// Машинная оценка предзаявленных критериев приёмки/фальсификации — чтобы «falsified_if» был
// вычисляемым инвариантом, а не прозой (класс дефекта v1: заявленная чувствительность без кода).
// `sharpeGap` — разрыв Sharpe тени и v1 на ОБЩЕМ окне (от рождения тени), его считает монитор;
// `shadowDays` — возраст самой тени. Без `sharpeGap` разрыв берётся из performance (прежний
// вызов), но тогда окна линий разные — тень родилась на трое суток позже v1.
export function evaluateAcceptanceV2({ performance = null, sharpeGap, shadowDays = 0, recoveryEpisodesObserved = 0 } = {}) {
  const a = POLICY_V2_CANDIDATE.decision_record.acceptance_criteria;
  const sharpeV2 = performance?.policy_v2_shadow?.sharpe_excess, sharpeV1 = performance?.policy_v1?.sharpe_excess;
  const gap = sharpeGap !== undefined ? (finite(sharpeGap) ? Number(sharpeGap) : null) : (finite(sharpeV2) && finite(sharpeV1) ? Number(sharpeV2) - Number(sharpeV1) : null);
  const falsified = finite(gap) && gap < a.falsify_sharpe_gap && shadowDays >= a.falsify_min_days;
  const meets = {
    shadow_days: shadowDays >= a.shadow_days_min,
    sharpe_floor: finite(gap) ? gap >= a.sharpe_floor_vs_v1 : null,
    episode_or_180d: recoveryEpisodesObserved >= 1 || shadowDays >= 180,
  };
  return {
    shadow_days: shadowDays,
    sharpe_gap_vs_v1: finite(gap) ? Number(gap.toFixed(4)) + 0 : null,
    recovery_episodes_observed: recoveryEpisodesObserved,
    falsified,
    meets,
    status: falsified ? "falsified" : (meets.shadow_days && meets.sharpe_floor === true && meets.episode_or_180d ? "switch_ready_pending_owner" : "collecting"),
  };
}

// Предзаявленное правило v2 (пункт 5, ревизия 2): отложило бы v2 это подтверждение понижения?
// Понижение подтверждает встречный снимок, отстоящий от ПЕРВОГО встречного снимка серии не меньше
// чем на `risk_off_min_confirm_minutes`; до этого подтверждение откладывается. Чистый предикат —
// единственный источник порога и для телеметрии, и для публикуемого контракта. На живое решение
// и на NAV тени НЕ влияет (enforcement: on_switch_only): вернуть true значит «это подтверждение
// засчитано v1, но v2 бы его отложил». `previousSnapshotAt` — прежнее имя параметра: v1
// подтверждает вторым встречным снимком подряд, поэтому предыдущий снимок и есть первый встречный.
export function riskOffConfirmationDeferredV2({ firstCounterSnapshotAt, previousSnapshotAt, now } = {}) {
  const first = Date.parse(firstCounterSnapshotAt ?? previousSnapshotAt ?? "");
  const at = Number(now);
  if (!Number.isFinite(first) || !Number.isFinite(at)) return false;
  const minutes = (at - first) / 60_000;
  return minutes >= 0 && minutes < POLICY_V2_CANDIDATE.hysteresis.risk_off_min_confirm_minutes;
}

export function policyV2CandidateMetadata() { return { id: POLICY_V2_CANDIDATE.id, version: POLICY_V2_CANDIDATE.version, revision: POLICY_V2_CANDIDATE.revision, status: POLICY_V2_CANDIDATE.status, created: POLICY_V2_CANDIDATE.created, revised: POLICY_V2_CANDIDATE.revised, base_suite: POLICY_V2_CANDIDATE.base_suite, floor_rungs: POLICY_V2_CANDIDATE.floor_ladder_pct.length, floor_ladder_pct: [...POLICY_V2_CANDIDATE.floor_ladder_pct], hysteresis: { ...POLICY_V2_CANDIDATE.hysteresis } }; }
