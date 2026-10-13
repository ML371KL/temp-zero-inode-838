/*
 * BTC decision suite v3 — теневой кандидат (аудит 2026-10-10) и движок теневых линий.
 *
 * НЕ управляет живым решением. Живую цель по-прежнему задаёт замороженная политика v1; этот модуль
 * форвард-монитор вызывает на каждом снимке, чтобы четыре теневые линии копили форвардные
 * доказательства по процедуре POLICY.md:
 *   policy_v3_shadow — кандидат: суточный такт и исправленные измерения (см. decision_record);
 *   v1_daily_close   — v1 как опубликована, но режим и оверлеи читаются раз в сутки;
 *   v1_floor_handoff — v1, у которой recovery-пол снимается по провалу подтверждений, а не по росту оценки;
 *   v1_no_cftc       — v1 без голоса семьи CFTC.
 * Три последние — линии атрибуции: каждая меняет в v1 ровно одно правило, чтобы на форварде было
 * видно, какое изменение чего стоит.
 *
 * Модуль публикуется как статический файл сайта и импортируется сборщиком на каждом снимке, поэтому
 * в нём нет ввода-вывода, Date.now() и случайности: время приходит параметром now, состояние —
 * параметром state и возвращается обратно. Лестница, полосы, ступени пола и права детекторов взяты
 * импортом из замороженных контрактов. Пороги, которые живут только в запертых секциях сборщика
 * (scoring_and_regimes_v1, hysteresis_v1), перенесены сюда портами с суффиксом V1Port; их равенство
 * оригиналу закреплено тестом scripts/policy-v3-candidate-test.mjs. Импортировать сборщик отсюда
 * нельзя: он тяжёлый и сам импортирует монитор, который импортирует этот файл.
 */
import { POLICY_V1, allocationDecisionV1, applyStrategicDetectorPolicyV1 } from "./policy-v1.mjs";
import { MODEL_POLICY_V1 } from "./model-policy-v1.mjs";
import { POLICY_V2_CANDIDATE } from "./policy-v2-candidate.mjs";

const deepFreeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const OVERLAYS_V1 = POLICY_V1.allocation_overlays;

export const POLICY_V3_CANDIDATE = deepFreeze({
  id: "btc-decision-suite-v3-candidate",
  version: 1,
  status: "shadow_candidate",
  created: "2026-10-10",
  base_suite: "btc-decision-suite-v1",
  lines: {
    policy_v3_shadow: { kind: "candidate", tact: "daily_fix", rule: "суточный такт и исправленные измерения" },
    v1_daily_close: { kind: "attribution", tact: "daily_fix", rule: "v1 как опубликована; кандидат, детекторы и оверлеи читаются только на фиксе" },
    v1_floor_handoff: { kind: "attribution", tact: "every_snapshot", rule: "v1; recovery-пол после включения держится, пока подтверждений не меньше двух и нет макрошока" },
    v1_no_cftc: { kind: "attribution", tact: "every_snapshot", rule: "v1 без голоса семьи CFTC; гистерезис v1 на собственном кандидате" },
  },
  // Суточный такт. К 06:00 UTC на месте вчерашние MVRV, остаток бирж, потоки ETF и закрытая дневная свеча.
  // Дневные ряды FRED за вчера выходят позже (спреды и VIX — около 13:30 UTC, ставки H.15 — около 21:15),
  // поэтому макроблок на фиксе на один рабочий день старше остальных входов. Час выбран по расчёту на
  // часовых ценах (backtest/eval7.mjs): раннее исполнение стоит дороже свежести макровходов.
  // Пропущенные сутки обнуляют счёт подтверждений — ненаблюдённый день ничего не подтверждает.
  daily_fix: { hour_utc: 6, confirm_fixes_down: 1, confirm_fixes_up: 2, missed_day_resets_streaks: true },
  // Существующие числа — ссылками на контракты, которые их ввели.
  ladder: POLICY_V1.ladder,
  floor_ladder_pct: POLICY_V2_CANDIDATE.floor_ladder_pct,
  capitulation_floor_pct: OVERLAYS_V1.capitulation_floor_pct,
  scoring: {
    non_voting_families: ["institutional"],
    network: { hashrate_mean_days: 30, lookback_days: 90, min_points_in_window: 20, max_age_days: 4, difficulty_max_age_days: 21, leg_bands_pct: [-5, -15] },
    exchange_supply: { flow_change_days: 7, flow_max_span_days: 9, reserve_change_days: 90, percentile_points: 1460, max_age_days: 4 },
    valuation: { expensive_min_percentile: 82, extreme_min_percentile: 95, cheap_max_percentile: OVERLAYS_V1.capitulation_max_mvrv_percentile, recovery_anchor_below_percentile: 25, deep_min_points: 2000, deep_max_age_days: 5 },
    trend: { ma_200d_points: 200, ma_20w_points: 140, ma_200w_points: 1400, max_age_days: 4 },
    recovery: { good_min_supports: 2, watch_min_supports: 1 },
    removed_rules: ["euphoria_safety_cap", "distribution_detector"],
  },
  decision_record: {
    objective: "Убрать из решающего правила измерительные артефакты, найденные аудитом 10.10.2026, не меняя лестницу и дерево гейтов: счёт времени в снимках вместо суток, recovery-пол одним снимком, правило CFTC с порогом внутри шума, точечный хешрейт, потоки бирж, расходящиеся с остатком, и порог «дёшево», дрейфующий вместе с окном.",
    risk_budget: "На форварде кандидат вправе отличаться от v1 в пределах предзаявленного: просадка глубже просадки v1 не более чем на 5 п.п.; отставание по чистой доходности больше 10 п.п. на окне от 180 дней отклоняет кандидата.",
    evidence_basis: "Реконструкция 2013–07.2026, 10 б.п. на полный оборот: на дневной сетке с исполнением на следующем закрытии (backtest/eval6.mjs, воспроизведение функциями этого модуля — scripts/variants-history.mjs) и на часовых ценах с исполнением в час фикса (backtest/eval7.mjs); боевое окно 19.07–10.10.2026, 6 694 снимка (scripts/variants-replay.mjs). Реконструкция — in-sample: v1 калибровалась на той же истории. Подбор не проводился: состав кандидата выбран по логике измерения, а не по лучшему результату.",
    evidence: {
      metrics: ["годовая доходность, %", "Sharpe", "макс. просадка, %"],
      windows: ["с 2013", "с 06.2018", "эра ETF (03.2024+)"],
      rows: [
        { variant: "v1 как есть", role: "base", values: [[43.0, 1.39, -40.8], [33.7, 1.15, -40.8], [17.5, 0.74, -15.5]] },
        { variant: "без CFTC", role: "change", values: [[47.3, 1.50, -39.9], [40.9, 1.37, -35.7], [23.7, 0.95, -14.1]] },
        { variant: "сеть по 30-дневным средним", role: "change", values: [[44.6, 1.42, -40.6], [36.3, 1.23, -40.2], [17.5, 0.74, -15.5]] },
        { variant: "биржи по остатку", role: "change", values: [[44.0, 1.42, -40.8], [33.9, 1.16, -40.8], [18.2, 0.78, -15.5]] },
        { variant: "оценка: согласие двух окон", role: "change", values: [[41.3, 1.35, -39.9], [31.0, 1.09, -39.2], [17.5, 0.74, -15.5]] },
        { variant: "пол 40/60/80 по закрытиям", role: "change", values: [[42.5, 1.38, -40.8], [33.4, 1.15, -40.8], [16.7, 0.71, -15.5]] },
        { variant: "кандидат v3 целиком", role: "candidate", values: [[47.4, 1.53, -40.4], [40.5, 1.38, -34.2], [23.4, 0.95, -14.1]] },
        { variant: "v3 + удержание пола после ухода якоря", role: "rejected", values: [[47.7, 1.52, -40.4], [39.1, 1.34, -34.2], [21.4, 0.86, -14.1]] },
        { variant: "пол + «хотя бы одна нога > 0»", role: "rejected", values: [[42.4, 1.38, -40.8], [33.2, 1.14, -40.8], [16.7, 0.71, -15.5]] },
      ],
      // scripts/variants-history.mjs: семь строк (кроме двух отклонённых) воспроизводятся функциями этого
      // модуля в схеме расчёта аудита. В той схеме нога потоков бирж считается по ряду остатка с 2015 года,
      // а до него голосует балл v1; движок считает обе ноги по одному ряду с 2011 года, сложность и тренд —
      // из рядов. Строка ниже — кандидат целиком так, как его исполняет движок.
      as_executed: { variant: "кандидат v3 целиком, как в движке", values: [[46.5, 1.50, -40.4], [40.3, 1.38, -34.2], [23.4, 0.95, -14.1]] },
      // backtest/eval7.mjs: те же правила, но позиция меняется в час фикса по часовым ценам, а макровходы
      // того возраста, какой доступен к этому часу. Таблица выше сравнивает правила на дневной сетке, где
      // сделка идёт на следующем закрытии; эта — на часах, по которым кандидат живёт. Суточный фикс даёт
      // раннее исполнение любому набору правил, поэтому база здесь — правила v1 на том же фиксе.
      at_fix_hour: {
        method: "исполнение в 06:00 UTC по часовым ценам; макровходы на день старше остальных, как на бою",
        windows: ["с 06.2018", "эра ETF (03.2024+)"],
        rows: [
          { variant: "правила v1 на суточном фиксе", role: "base", values: [[43.1, 1.40, -36.7], [19.2, 0.82, -16.1]] },
          { variant: "без CFTC", role: "change", values: [[47.4, 1.53, -37.3], [26.7, 1.06, -17.6]] },
          { variant: "оценка: согласие двух окон", role: "change", values: [[40.4, 1.35, -32.2], [19.2, 0.82, -16.1]] },
          { variant: "пол 40/60/80 по фиксам", role: "change", values: [[42.2, 1.39, -36.7], [18.9, 0.81, -16.1]] },
          { variant: "кандидат v3 целиком", role: "candidate", values: [[45.5, 1.51, -33.0], [25.0, 1.01, -17.6]] },
        ],
        // Кандидат целиком при другом часе фикса; макровходы — по публикации к этому часу.
        fix_hours_utc: { 6: [[45.5, 1.51, -33.0], [25.0, 1.01, -17.6]], 15: [[44.6, 1.49, -35.8], [20.4, 0.82, -18.2]], 22: [[41.8, 1.42, -34.7], [22.7, 0.92, -15.2]], 24: [[40.8, 1.39, -34.9], [23.8, 0.97, -15.5]] },
      },
    },
    changes: [
      {
        id: "daily_fix",
        v1: "Режим пересчитывается на каждом снимке (с 07.08.2026 — каждые 15 минут): понижение — два снимка подряд, повышение — 48 часов и не меньше 12 снимков без единого встречного.",
        v3: "Режим, детекторы и оверлеи читаются раз в сутки, на первом снимке не раньше 06:00 UTC. Понижение принимается на этом же фиксе, повышение — на втором фиксе подряд с тем же кандидатом. Между фиксами цель не меняется; аварийный режим обнуляет её на любом снимке.",
        why: "На истории режим считался раз в сутки, в бою — в снимках, и смысл гистерезиса менялся вместе с тактом сбора. К 06:00 UTC на месте вчерашние MVRV, остаток бирж, потоки ETF и закрытая дневная свеча. Дневные ряды FRED за вчера выходят позже — кредитные спреды и VIX около 13:30 UTC, ставки H.15 около 21:15 UTC, — поэтому макроблок на фиксе на один рабочий день старше остальных входов; даты наблюдений публикуются во входах фикса.",
        numbers: "За 83 дня кандидат 12 раз менялся на один-два снимка и возвращался; семь таких переворотов обнулили идущий 48-часовой отсчёт повышения; оба понижения после перехода на 15-минутный такт подтверждены за 15 минут. Суточный пересчёт тех же сигналов v1 дал за окно +3,9 % при фиксе в 06:00 против +1,4 % у v1; час фикса на 83 днях неразличим: при фиксе в 00, 03, 09, 12, 15, 18 и 21 час те же сигналы дают +4,5, +9,2, +4,0, +4,4, +0,1, +1,9 и +4,3 %. На истории с 06.2018 по часовым ценам кандидат при фиксе в 06:00 с макровходами на день старше даёт 45,5 / 1,51 / −33,0; в 15:00, когда спреды и VIX уже свежие, — 44,6 / 1,49 / −35,8; в 22:00 со всеми свежими входами — 41,8 / 1,42 / −34,7; будь макровходы свежими уже в 06:00 — 45,1 / 1,50. Решение из-за возраста макро отличается в 2 % суток. Правила v1 на том же фиксе дают 43,1 / 1,40 / −36,7: большую часть разрыва дневной сетки (33,7 против 40,5) даёт время исполнения, а не правила.",
      },
      {
        id: "cftc_not_voting",
        v1: "Семья «Качество институционального спроса» (CFTC) — одна из четырёх равновесных семей блока спроса.",
        v3: "Семья не голосует: блок спроса — среднее ETF, стейблкоинов и биржевого предложения.",
        why: "Правило ставит −1, когда чистый шорт фондов вырос больше чем на 3 п.п. OI при положительном потоке ETF, но встречная сторона этого шорта — лонг управляющих активами: −1 выставляется, когда управляющие наращивают лонг. Нейтральная зона уже недельного шума ряда.",
        numbers: "σ недельного изменения 7 п.п. при зоне +1 / −2 / +3 п.п.; ветка −1 выполняется до 55 % недель. На истории без семьи лучше во всех окнах: 47,3 / 1,50 / −39,9 против 43,0 / 1,39 / −40,8 с 2013 года; 40,9 / 1,37 против 33,7 / 1,15 с 06.2018; 23,7 / 0,95 против 17,5 / 0,74 в эру ETF. На боевом окне разницы нет: +1,6 против +1,4 %.",
      },
      {
        id: "network_30d_means",
        v1: "Нога хешрейта — последняя дневная точка против точки 90 дней назад.",
        v3: "Нога хешрейта — среднее за 30 дней против среднего за 30 дней, закончившихся 90 дней назад; пороги −5 и −15 % прежние. Нога сложности — как в v1.",
        why: "Дневной хешрейт оценивается по ~144 блокам: шум одной точки 8 %, разности двух — 12 % при шаге шкалы 10 п.п.",
        numbers: "В бою 66 смен балла семьи за 84 дня, единственная причина 12 из 46 смен кандидата режима; на истории с 06.2018 балл менялся день ко дню 620 раз против 55 по 30-дневным средним. На истории: 44,6 / 1,42 / −40,6 против 43,0 / 1,39 / −40,8 с 2013 года; в эру ETF без изменений.",
      },
      {
        id: "exchange_flow_from_reserve",
        v1: "Нога потоков — сумма FlowInExNtv − FlowOutExNtv за 7 дней.",
        v3: "Нога потоков — изменение остатка бирж SplyExNtv за 7 дней: перцентиль по 1 460 таким изменениям, шкала lowGood, при росте остатка не выше 0. Нога остатка за 90 дней — как в v1.",
        why: "С 05.05.2026 потоки Coin Metrics расходятся с остатком бирж того же поставщика каждый день в одну сторону: две ноги одной семьи описывают разные величины.",
        numbers: "За 158 дней потоки показывают отток на 321 тыс. BTC больше, чем убыл остаток; балл семьи выше счёта по остатку в 113 днях из 190 и ни разу не ниже. На истории: 44,0 / 1,42 / −40,8 против 43,0 / 1,39 / −40,8 с 2013 года; 18,2 / 0,78 против 17,5 / 0,74 в эру ETF.",
      },
      {
        id: "valuation_two_windows",
        v1: "«Дёшево» (балл +1 при перцентиле ≤ 10, якорь recovery < 25, пол капитуляции ≤ 10) определено одним скользящим окном четырёх лет.",
        v3: "«Дешёвая» сторона требует согласия двух окон — четырёх лет и всей истории с 2010 года; «дорогая» (≥ 82 → −1, ≥ 95 → −2) — как в v1. Глубокое окно годно при 2 000 точек и последней точке не старше 5 дней; иначе правило работает по одному окну, и это публикуется.",
        why: "Из 4-летнего окна до января 2027 года уходит дно 2022 года, и пороги «дёшево» поднимаются без изменения рынка. История оценить это не может: раньше каждое 4-летнее окно содержало одно медвежье дно.",
        numbers: "10-й перцентиль MVRV при неизменном рынке: 1,17 на 09.10.2026, 1,24 к 15.01.2027, ≈1,30 к 15.07.2027; якорь recovery — 1,34, 1,43, ≈1,50. Включено вопреки цене на истории: 41,3 / 1,35 / −39,9 против 43,0 / 1,39 / −40,8 с 2013 года; 31,0 / 1,09 против 33,7 / 1,15 с 06.2018 (−2,7 п.п. годовых, в основном 2022 год).",
      },
      {
        id: "trend_closed_day",
        v1: "Тренд сравнивает живую цену снимка со средними, в которые входит незакрытая свеча текущих суток.",
        v3: "Тренд считается по последнему закрытому дню — того же возраста, что MVRV; пороги v1 (200 дней, 20 недель, 200 недель).",
        why: "Включение пола шло на входах разного возраста — тренд по живой цене, MVRV за вчера, — а пересечения средней внутри дня переворачивали кандидата.",
        numbers: "19.08.2026 рост до 69 тыс. $ включил подтверждение по тренду, суточное обновление MVRV через 7 часов сняло якорь. В бою семья была единственной причиной 12 смен кандидата, 11 из них — пересечения 200-недельной средней внутри дня.",
      },
      {
        id: "floor_graduated",
        v1: "Recovery-пол 80 % включается одним снимком.",
        v3: "Пол растёт ступенями 40 / 60 / 80 по числу фиксов подряд с состоянием good; фикс без good или с макрошоком снимает пол.",
        why: "Одно показание не должно двигать цель на 60 п.п.; ступени по закрытиям на истории неотличимы от мгновенных 80 %.",
        numbers: "42,5 / 1,38 / −40,8 против 43,0 / 1,39 / −40,8 с 2013 года; 33,4 / 1,15 против 33,7 / 1,15 с 06.2018; 16,7 / 0,71 против 17,5 / 0,74 в эру ETF. В бою пол v1 включался трижды, 19–20.08 прожил 7 часов и ни разу не заработал.",
      },
      {
        id: "dead_rules_removed",
        v1: "Потолок эйфории 60 % при перцентиле ≥ 95 и детектор «Дистрибуция» с правом понижать вердикт.",
        v3: "Обоих правил нет.",
        why: "Они не могут сработать по построению: потолок требует цели выше 60 %, а гейт оценки уже с 82-го перцентиля не пускает режимы 95 и 100 %; «Дистрибуция» требует высокой оценки и цены ниже обеих средних одновременно.",
        numbers: "Якорь «Дистрибуции» стоял 694 дня с 2013 года, тренд при этом не был отрицательным ни разу; срабатываний потолка ноль. Без обоих правил результат на истории тот же: 43,0 / 1,39 / −40,8.",
      },
    ],
    unchanged: "Лестница 0 / 5 / 20 / 45 / 95 / 100, полосы блоков ±20, дерево гейтов с якорем понижения на спросе, гейт оценки, макрошок и его запрет на пол, право recovery поднимать вердикт до переходного, пол капитуляции 40 %.",
    rejected: [
      {
        id: "floor_carry_after_anchor",
        rule: "Удержание пола после ухода якоря в составе кандидата.",
        numbers: "47,7 / 1,52 / −40,4 с 2013 года, 39,1 / 1,34 / −34,2 с 06.2018, 21,4 / 0,86 / −14,1 в эру ETF против 47,4 / 1,53 / −40,4, 40,5 / 1,38 / −34,2, 23,4 / 0,95 / −14,1 без удержания: Sharpe ниже во всех трёх окнах, доходность выше только на полном.",
        outcome: "Идёт отдельной линией v1_floor_handoff и копит форвардные доказательства само по себе.",
      },
      {
        id: "strictly_positive_leg",
        rule: "Подтверждение recovery строго положительным баллом хотя бы одной ноги.",
        numbers: "42,4 / 1,38 / −40,8 с 2013 года, 33,2 / 1,14 с 06.2018, 16,7 / 0,71 в эру ETF против 42,5 / 1,38, 33,4 / 1,15, 16,7 / 0,71 у пола со ступенями.",
        outcome: "Не улучшает и теряет эпизод марта 2019 года.",
      },
      {
        id: "downgrade_anchor_on_macro",
        rule: "Перенос якоря понижения со спроса на макро.",
        numbers: "Sharpe 1,07–1,16 против 1,15 с 06.2018.",
        outcome: "Дерево гейтов стоит на плато, менять его незачем.",
      },
      {
        id: "sharpe_gap_criterion",
        rule: "Критерий приёмки по разрыву Sharpe с v1.",
        numbers: "Шум разрыва Sharpe на 90 днях — 0,19: при нулевой истинной разнице порог −0,10 проваливается в 30 % случаев.",
        outcome: "В приёмку и фальсификацию разрыв Sharpe не входит.",
      },
    ],
    // Блок acceptance_criteria монитор публикует в каждом снимке и читает по ключам — он короткий.
    acceptance_criteria: {
      shadow_days_min: 180,
      min_target_changes_vs_v1: 3,
      timing_pp_not_worse_than_v1: true,
      max_drawdown_worse_pp_max: 5,
      falsify_net_return_gap_pp: -10,
      falsify_min_days: 180,
      switch_requires_all: [
        "shadow_days >= 180",
        "эпизодов расхождения цели с policy_v1 >= 3",
        "тайминг policy_v3_shadow против собственной постоянной доли не хуже, чем у policy_v1, на общем окне",
        "макс. просадка глубже просадки policy_v1 не более чем на 5 п.п.",
        "все тесты зелёные; ноль операционных инцидентов, вызванных вычислением кандидата",
        "явное решение владельца отдельным релизом",
      ],
      falsified_if: "чистая доходность policy_v3_shadow ниже policy_v1 больше чем на 10 п.п. на общем окне от 180 дней — кандидат отклоняется, запись сохраняется.",
    },
    acceptance_definitions: {
      shadow_days: "Полные сутки от старта стратегии policy_v3_shadow в форвард-мониторе; все сравнения — на общем окне кандидата и policy_v1.",
      target_changes_vs_v1: "Число эпизодов расхождения: непрерывных серий дневных строк монитора, в которых цель policy_v3_shadow отличается от цели policy_v1. Серия засчитывается один раз, в день начала; строка без одной из целей серию не открывает и не закрывает.",
      timing_pp: "Чистая доходность стратегии минус чистая доходность постоянной доли, равной её собственной средневзвешенной по времени доле за то же окно (monitoring.timing_null).",
      max_drawdown_worse_pp: "Модуль максимальной просадки policy_v3_shadow минус модуль максимальной просадки policy_v1, п.п.",
      net_return_gap_pp: "Чистая доходность policy_v3_shadow минус чистая доходность policy_v1, п.п.",
    },
  },
});

export function policyV3CandidateMetadata() {
  const { id, version, status, created, base_suite } = POLICY_V3_CANDIDATE;
  return { id, version, status, created, base_suite };
}

export const SHADOW_VARIANTS_STATE_VERSION = 1;

const DAY = 86_400_000, HOUR = 3_600_000;
const DEGRADED = ["insufficient", "emergency"];
const REGIMES = POLICY_V1.strategic_order.filter(x => !DEGRADED.includes(x));
const SCORING = POLICY_V3_CANDIDATE.scoring, FIX = POLICY_V3_CANDIDATE.daily_fix;
const MACRO_OBSERVED = ["macro_liquidity", "macro_conditions", "macro_stress"], STRESS_MAX_LAG_DAYS = 4;
// Состав блоков и обязательные группы v1 (familyStats и strategicRequired запертой секции сборщика).
const FAMILIES_V1 = deepFreeze({ macro: ["liquidity", "conditions", "stress"], demand: ["etf", "stablecoins", "exchange_supply", "institutional"], cycle: ["valuation", "network", "activity", "miners", "trend"] });
const REQUIRED_GROUPS_V1 = deepFreeze([["macro", ["liquidity"]], ["macro", ["conditions"]], ["demand", ["etf"]], ["demand", ["stablecoins", "exchange_supply"]], ["cycle", ["trend"]], ["cycle", ["network"]]]);

// finite — дословно как в сборщике: порты обязаны совпадать с оригиналом и на мусоре. Входы решения
// читаются строже (isNum): строка или null вместо балла — это отсутствие балла.
const finite = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const isNum = v => typeof v === "number" && Number.isFinite(v);
const num = v => (isNum(v) ? v : null);
const str = v => (typeof v === "string" && v ? v : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = a => (a.length ? a.reduce((s, v) => s + Number(v), 0) / a.length : null);
const last = a => (a?.length ? a[a.length - 1] : null);
const pct = (a, b) => (finite(a) && finite(b) && Number(b) !== 0 ? (Number(a) / Number(b) - 1) * 100 : null);
const round = (v, digits = 2) => { if (!isNum(v)) return null; const r = Math.round(v * 10 ** digits) / 10 ** digits; return r === 0 ? 0 : r; };
const iso = t => { const d = new Date(t); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const dateOf = t => (isNum(t) ? iso(t)?.slice(0, 10) ?? null : null);
const toMs = now => { const t = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now; return isNum(t) && !Number.isNaN(new Date(t).getTime()) ? t : null; };

// ===== Порты запертых секций v1 (равенство оригиналу — в тесте) =====

export function percentileRankV1Port(values, value) {
  const x = (Array.isArray(values) ? values : []).filter(finite).map(Number);
  if (x.length < 30 || !finite(value)) return null;
  const y = Number(value), less = x.filter(v => v < y).length, equal = x.filter(v => v === y).length;
  return (less + 0.5 * equal) / x.length * 100;
}
export function componentScoreV1Port(parts) {
  const a = parts.filter(finite).map(Number);
  if (!a.length) return null;
  const s = clamp(Math.round(mean(a) * 2) / 2, -2, 2);
  return a.length * 2 <= parts.length && s > 0 ? 0 : s;
}
export function lowGoodV1Port(p) { return !finite(p) ? null : p <= 10 ? 2 : p <= 35 ? 1 : p <= 65 ? 0 : p <= 90 ? -1 : -2; }
export function priorByDaysV1Port(s, days) {
  if (!s?.length) return null;
  const target = last(s).t - days * DAY;
  let best = null;
  for (const p of s) { if (p.t <= target) best = p; else break; }
  return best;
}
export function trailingChangeSeriesV1Port(s, days) {
  const out = [];
  for (let i = 1, j = 0; i < s.length; i++) {
    const target = s[i].t - days * DAY;
    while (j + 1 < i && s[j + 1].t <= target) j++;
    const prev = s[j];
    if (!prev || prev.t > target || !finite(prev.v) || !finite(s[i].v)) continue;
    const v = pct(s[i].v, prev.v);
    if (finite(v)) out.push({ t: s[i].t, v });
  }
  return out;
}
// Тяжесть стратегического режима — его место в замороженном порядке v1; insufficient и неизвестное — 0.
export function severityV1Port(x) {
  const order = POLICY_V1.strategic_order, i = order.indexOf(x);
  return i < 0 ? 0 : i - order.indexOf("transition");
}
export function bandV1Port(score) {
  const b = MODEL_POLICY_V1.regime_bands;
  return score == null ? "unknown" : score >= b.supportive_min ? "supportive" : score <= b.adverse_max ? "adverse" : "neutral";
}
export function detectorStateV1Port(hit, total, good = false) {
  const d = MODEL_POLICY_V1.detector_state;
  if (hit >= Math.max(d.fired_min_hits, total - 1, d.fired_all_but_one_min)) return good ? "good" : "fired";
  return hit >= d.watch_min_hits ? "watch" : "calm";
}
// Гистерезис вердикта v1 (stabilizeCore) без веток fresh/mock: движок их не использует.
export function stabilizeCoreV1Port(candidate, prevState, prevMetaIn, now, { hard = false } = {}) {
  const H = MODEL_POLICY_V1.hysteresis, prevMeta = prevMetaIn || {};
  const anchor = DEGRADED.includes(prevState) ? (prevMeta.anchor || null) : prevState;
  if (hard || DEGRADED.includes(candidate))
    return { state: candidate, candidate, count: 1, since: iso(now), anchor, downStreak: prevMeta.downStreak || 0 };
  const count = prevMeta.candidate === candidate ? (prevMeta.count || 0) + 1 : 1, prev = prevState || candidate;
  const prevSince = prevMeta.candidate === candidate && finite(Date.parse(prevMeta.since)) ? prevMeta.since : null;
  const since = prevSince || iso(now);
  const ref = DEGRADED.includes(prev) ? (anchor ?? prev) : prev;
  const sevRef = severityV1Port(ref), worse = severityV1Port(candidate) < sevRef;
  const downStreak = worse ? (prevMeta.downStreak || 0) + 1 : 0;
  const upgrade = severityV1Port(candidate) > sevRef && !DEGRADED.includes(ref);
  const heldLongEnough = now - Date.parse(since) >= H.risk_on_hold_hours * HOUR && count >= H.risk_on_min_snapshots;
  const confirm = H.risk_off_confirm_snapshots;
  const adopt = (count >= confirm && (!upgrade || heldLongEnough)) || (worse && downStreak >= confirm);
  const held = !adopt && DEGRADED.includes(prev) && anchor ? (severityV1Port(candidate) < severityV1Port(anchor) ? candidate : anchor) : prev;
  const state = adopt ? candidate : held;
  const hold_until = !adopt && upgrade ? iso(Date.parse(since) + H.risk_on_hold_hours * HOUR) : undefined;
  return { state, candidate, count, since, downStreak, anchor: DEGRADED.includes(state) ? anchor : state, hold_until };
}

// Балл блока — среднее имеющихся семей (familyStats v1); семьи из exclude не голосуют и не ожидаются.
export function blockScoresV1Port(families, exclude = []) {
  const out = {};
  for (const [block, names] of Object.entries(FAMILIES_V1)) {
    const scores = names.filter(name => !exclude.includes(name)).map(name => families?.[block]?.[name]).filter(v => v != null);
    out[block] = scores.length ? mean(scores) / 2 * 100 : null;
  }
  return out;
}
// Критическое покрытие стратегического горизонта v1: доля имеющихся семей блока и обязательные группы.
export function strategicCriticalV1Port(families, exclude = []) {
  for (const [block, names] of Object.entries(FAMILIES_V1)) {
    const expected = names.filter(name => !exclude.includes(name)), present = expected.filter(name => families?.[block]?.[name] != null);
    if ((expected.length ? present.length / expected.length : 1) < MODEL_POLICY_V1.critical_min[block]) return false;
  }
  return REQUIRED_GROUPS_V1.every(([block, group]) => group.some(name => !exclude.includes(name) && families?.[block]?.[name] != null));
}
// Гейт среднесрочного режима v1 (candidateRegimes) из баллов семей.
export function strategicCandidateV1Port({ families, criticalOk = true, hardOverride = false, macroShockState, distributionState, recoveryState, exclude = [] } = {}) {
  if (hardOverride) return "emergency";
  const blocks = blockScoresV1Port(families, exclude);
  const M = bandV1Port(blocks.macro), D = bandV1Port(blocks.demand), C = bandV1Port(blocks.cycle);
  const adverse = [M, D, C].filter(x => x === "adverse").length;
  let strategic = "transition";
  if (!criticalOk) strategic = "insufficient";
  else if (adverse >= 2) strategic = "defensive";
  else if (D === "adverse") strategic = "deteriorating";
  else if (adverse >= 1) strategic = "transition";
  else if (D === "supportive" && C === "supportive" && M !== "adverse") strategic = "constructive";
  else if (D === "supportive" && M === "supportive") strategic = "constructive";
  else if (M === "supportive" && C === "supportive" && D === "neutral") strategic = "unconfirmed_positive";
  // Гейт оценки: без MVRV или при дорогом MVRV оптимизма не бывает; предупреждению он не мешает.
  const valuation = families?.cycle?.valuation;
  if ((valuation == null || (finite(valuation) && Number(valuation) <= -1)) && ["constructive", "unconfirmed_positive"].includes(strategic)) strategic = "transition";
  return applyStrategicDetectorPolicyV1({ strategic, macroShockState, distributionState, recoveryState });
}
export function macroShockStateV1Port(macro) {
  const hits = FAMILIES_V1.macro.filter(name => finite(macro?.[name]) && Number(macro[name]) <= -1).length;
  return detectorStateV1Port(hits, FAMILIES_V1.macro.length);
}
// Нулевой балл — подтверждение, как в v1: требование строго положительной ноги отклонено с числами.
export function recoveryStateV1Port({ anchor, trend, etf, exchangeSupply } = {}) {
  const R = SCORING.recovery, supports = [trend, etf, exchangeSupply].filter(v => finite(v) && Number(v) >= 0).length;
  const state = !anchor ? "calm" : supports >= R.good_min_supports ? OVERLAYS_V1.recovery_detector_state : supports >= R.watch_min_supports ? "watch" : "calm";
  return { state, anchor: !!anchor, supports };
}

// ===== Счёт изменённых семей кандидата =====

// Ряд приводится к возрастающим {t,v}: мусор и точки из будущего отбрасываются, дубли метки
// времени схлопываются в последнюю. Вход не меняется.
function cleanSeries(rows, now) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const t = typeof r.t === "number" ? r.t : typeof r.t === "string" ? Date.parse(r.t) : NaN;
    const v = typeof r.v === "number" ? r.v : typeof r.v === "string" && r.v !== "" ? Number(r.v) : NaN;
    if (Number.isFinite(t) && Number.isFinite(v) && t <= now) out.push({ t, v });
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((p, i) => i === out.length - 1 || out[i + 1].t !== p.t);
}
function windowMean(s, end, days, minPoints) {
  let sum = 0, n = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i].t > end) continue;
    if (s[i].t <= end - days * DAY) break;
    sum += s[i].v; n++;
  }
  return n >= minPoints ? sum / n : null;
}
const penaltyLeg = (v, [mild, severe]) => (!finite(v) ? null : v > mild ? 0 : v > severe ? -1 : -2);

// «Безопасность сети». Одна дневная точка хешрейта шумит на 8 %, разность двух — на 12 % при шаге
// шкалы 10 п.п., поэтому сравниваются 30-дневные средние. Нога сложности и шкала — как в v1.
export function scoreNetworkV3({ hashrate, difficulty, now } = {}) {
  const P = SCORING.network, t = toMs(now);
  const out = { score: null, hashrate_change_pct: null, difficulty_change_pct: null, hashrate_leg: null, difficulty_leg: null, hashrate_at: null, reason: null };
  if (t === null) { out.reason = "invalid_now"; return out; }
  const h = cleanSeries(hashrate, t), d = cleanSeries(difficulty, t);
  if (!h.length) out.reason = "hashrate_missing";
  else if (t - last(h).t > P.max_age_days * DAY) out.reason = "hashrate_stale";
  else {
    const end = last(h).t;
    out.hashrate_at = end;
    out.hashrate_change_pct = pct(windowMean(h, end, P.hashrate_mean_days, P.min_points_in_window), windowMean(h, end - P.lookback_days * DAY, P.hashrate_mean_days, P.min_points_in_window));
    if (out.hashrate_change_pct === null) out.reason = "hashrate_short";
  }
  // Сборщик сам выбрасывает ряд сложности старше трёх недель; тот же предел здесь — на случай кэша.
  if (d.length && t - last(d).t <= P.difficulty_max_age_days * DAY) out.difficulty_change_pct = pct(last(d).v, priorByDaysV1Port(d, P.lookback_days)?.v);
  out.hashrate_leg = penaltyLeg(out.hashrate_change_pct, P.leg_bands_pct);
  out.difficulty_leg = penaltyLeg(out.difficulty_change_pct, P.leg_bands_pct);
  out.score = componentScoreV1Port([out.hashrate_leg, out.difficulty_leg]);
  return out;
}

// «Биржевое предложение». Нога потоков считается по тому же ряду остатка, что и нога за 90 дней:
// с мая 2026 потоки поставщика расходятся с его же остатком, и две ноги описывали разные величины.
export function scoreExchangeSupplyV3({ reserve, now } = {}) {
  const P = SCORING.exchange_supply, t = toMs(now);
  const out = { score: null, flow_change_btc: null, flow_percentile: null, flow_leg: null, reserve_change_pct: null, reserve_percentile: null, reserve_leg: null, observed_at: null, reason: null };
  if (t === null) { out.reason = "invalid_now"; return out; }
  const s = cleanSeries(reserve, t);
  if (!s.length) { out.reason = "exchange_supply_missing"; return out; }
  if (t - last(s).t > P.max_age_days * DAY) { out.reason = "exchange_supply_stale"; return out; }
  out.observed_at = last(s).t;
  const changes = [];
  for (let i = 0, j = 0; i < s.length; i++) {
    const target = s[i].t - P.flow_change_days * DAY;
    while (j + 1 < i && s[j + 1].t <= target) j++;
    // Дыра в ряду не выдаётся за недельное изменение: база не старше девяти дней.
    if (j < i && s[j].t <= target && s[i].t - s[j].t <= P.flow_max_span_days * DAY) changes.push({ t: s[i].t, v: s[i].v - s[j].v });
  }
  if (changes.length && last(changes).t === last(s).t) {
    const flow = last(changes).v, p = percentileRankV1Port(changes.slice(-P.percentile_points).map(x => x.v), flow);
    out.flow_change_btc = flow;
    out.flow_percentile = p;
    // Экономический ноль: рост остатка не может голосовать «за» только потому, что раньше рос быстрее.
    out.flow_leg = finite(p) ? (flow > 0 ? Math.min(lowGoodV1Port(p), 0) : lowGoodV1Port(p)) : null;
  }
  const change = pct(last(s).v, priorByDaysV1Port(s, P.reserve_change_days)?.v);
  const rank = percentileRankV1Port(trailingChangeSeriesV1Port(s, P.reserve_change_days).slice(-P.percentile_points).map(x => x.v), change);
  out.reserve_change_pct = change;
  out.reserve_percentile = rank;
  out.reserve_leg = finite(rank) ? (finite(change) && change > 0 ? Math.min(lowGoodV1Port(rank), 0) : lowGoodV1Port(rank)) : null;
  out.score = componentScoreV1Port([out.flow_leg, out.reserve_leg]);
  if (out.score === null) out.reason = "exchange_supply_short";
  return out;
}

// Перцентиль MVRV по всей истории. Короткий или протухший ряд честно даёт null: правило тогда
// работает по одному окну, как v1, — деградация данных не выключает и не подменяет защиту.
export function mvrvDeepPercentileV3({ mvrvDeep, now } = {}) {
  const P = SCORING.valuation, t = toMs(now), out = { percentile: null, used: false, points: 0, observed_at: null, reason: null };
  const s = t === null ? [] : cleanSeries(mvrvDeep, t);
  out.points = s.length;
  if (!s.length) out.reason = "mvrv_deep_missing";
  else if (s.length < P.deep_min_points) out.reason = "mvrv_deep_short";
  else if (t - last(s).t > P.deep_max_age_days * DAY) out.reason = "mvrv_deep_stale";
  else { out.percentile = percentileRankV1Port(s.map(x => x.v), last(s).v); out.used = out.percentile !== null; out.observed_at = last(s).t; }
  return out;
}

// Оценка. «Дорого» — одно окно, как в v1: предупреждение не ослабляется. «Дёшево» (балл +1, якорь
// recovery, пол капитуляции) — только при согласии 4-летнего окна и всей истории: из 4-летнего окна
// уходит дно 2022 года, и его пороги растут без изменения рынка.
export function scoreValuationV3({ percentile, percentileDeep = null } = {}) {
  const P = SCORING.valuation, p = num(percentile), deep = num(percentileDeep);
  if (p === null) return { score: null, cheap: false, anchor: false, deep_window_used: false };
  const cheap = p <= P.cheap_max_percentile && (deep === null || deep <= P.cheap_max_percentile);
  const anchor = p < P.recovery_anchor_below_percentile && (deep === null || deep < P.recovery_anchor_below_percentile);
  const score = p >= P.extreme_min_percentile ? -2 : p >= P.expensive_min_percentile ? -1 : cheap ? 1 : 0;
  return { score, cheap, anchor, deep_window_used: deep !== null };
}

// Тренд по последнему закрытому дню. Незакрытая свеча не участвует ни ценой, ни в средних: тренд
// должен быть того же возраста, что MVRV, иначе пол включается на входах разных суток.
export function scoreTrendV3({ priceDaily, now } = {}) {
  const P = SCORING.trend, t = toMs(now), out = { score: null, close: null, closed_at: null, ma_200d: null, ma_20w: null, ma_200w: null, reason: null };
  if (t === null) { out.reason = "invalid_now"; return out; }
  const closed = cleanSeries(priceDaily, t).filter(p => p.t + DAY <= t);
  if (!closed.length) { out.reason = "price_missing"; return out; }
  if (t - last(closed).t > P.max_age_days * DAY) { out.reason = "price_stale"; return out; }
  const price = last(closed).v, ma = points => (closed.length >= points ? mean(closed.slice(-points).map(x => x.v)) : null);
  const ma200 = ma(P.ma_200d_points), ma140 = ma(P.ma_20w_points), ma1400 = ma(P.ma_200w_points);
  Object.assign(out, { close: price, closed_at: last(closed).t, ma_200d: ma200, ma_20w: ma140, ma_200w: ma1400 });
  if (price && ma200 && ma140) out.score = price > ma200 && price > ma140 ? 2 : price > ma200 || price > ma140 ? 0 : !ma1400 || price > ma1400 ? -1 : -2;
  else out.reason = "price_short";
  return out;
}

// ===== Правила суточного такта =====

// Фикс — первый снимок суток UTC не раньше часа фикса. lastFixDay — номер суток последнего фикса.
export function fixClockV3(now, lastFixDay) {
  const day = Math.floor(now / DAY), due = now - day * DAY >= FIX.hour_utc * HOUR && !(lastFixDay >= day);
  return { day, due, next_at: (lastFixDay >= day ? lastFixDay + 1 : day) * DAY + FIX.hour_utc * HOUR };
}
// Гистерезис в фиксах: хуже — сразу, лучше — на втором фиксе подряд с тем же кандидатом. Другой
// «лучший» кандидат и пропущенные сутки (consecutive=false) начинают счёт заново.
export function dailyHysteresisStepV3(prev, candidate, { consecutive = true } = {}) {
  const s = prev?.s, p = consecutive ? prev?.p ?? null : null, n = consecutive ? Number(prev?.n) || 0 : 0;
  const delta = severityV1Port(candidate) - severityV1Port(s);
  if (candidate === s || delta === 0) return { s, p: null, n: 0 };
  const count = p === candidate ? n + 1 : 1;
  return count >= (delta < 0 ? FIX.confirm_fixes_down : FIX.confirm_fixes_up) ? { s: candidate, p: null, n: 0 } : { s, p: candidate, n: count };
}
// Цель кандидата. Потолка эйфории нет: в v1 он не может сработать по построению.
export function allocationDecisionV3({ strategic, floorCloses = 0, cheap = false } = {}) {
  const base = POLICY_V3_CANDIDATE.ladder[strategic], ladder = POLICY_V3_CANDIDATE.floor_ladder_pct;
  if (!REGIMES.includes(strategic) || !isNum(base)) return { base_target_pct: null, target_pct: null, binding_overlays: [], floor_level_pct: null };
  const rung = Math.min(ladder.length, Math.max(0, Math.floor(Number(floorCloses) || 0))), level = rung > 0 ? ladder[rung - 1] : null;
  let target = base;
  const binding = [];
  if (level !== null && target < level) { target = level; binding.push("recovery_floor"); }
  if (cheap && target < POLICY_V3_CANDIDATE.capitulation_floor_pct) { target = POLICY_V3_CANDIDATE.capitulation_floor_pct; binding.push("capitulation_floor"); }
  return { base_target_pct: base, target_pct: target, binding_overlays: binding, floor_level_pct: level };
}

// ===== Движок =====

function normalizeInputs(inputs) {
  if (!inputs || typeof inputs !== "object") return null;
  const v1 = inputs.v1;
  if (!v1 || typeof v1 !== "object") return null;
  const families = {};
  for (const [block, names] of Object.entries(FAMILIES_V1)) {
    families[block] = {};
    for (const name of names) families[block][name] = num(inputs.families?.[block]?.[name]);
  }
  if (families.cycle.valuation === null) families.cycle.valuation = num(v1.valuation_score);
  const state = str(v1.state), candidate = str(v1.candidate);
  const observed = {};
  for (const key of ["mvrv", "coinmetrics", "etf", "network", "market", "macro_liquidity", "macro_conditions", "macro_stress"]) if (str(inputs.observed_at?.[key])) observed[key] = inputs.observed_at[key];
  return {
    hard: inputs.hard_override === true || (typeof inputs.hard_override === "string" && inputs.hard_override !== "") || state === "emergency" || candidate === "emergency",
    v1: { state, candidate, critical_ok: typeof v1.critical_ok === "boolean" ? v1.critical_ok : null, target_pct: num(v1.target_pct), recovery_state: str(v1.recovery_state), macro_shock_state: str(v1.macro_shock_state), distribution_state: str(v1.distribution_state), mvrv_percentile: num(v1.mvrv_percentile) },
    families,
    series: inputs.series && typeof inputs.series === "object" ? inputs.series : {},
    observed_at: observed,
  };
}
// Теневая линия не бывает «достаточной», когда живая политика встала из-за нехватки данных.
const v1Insufficient = inp => inp.v1.critical_ok === false || inp.v1.candidate === "insufficient";
const v1Decision = (strategic, inp, recoveryState = inp.v1.recovery_state) => allocationDecisionV1({ strategic, recoveryState, macroShockState: inp.v1.macro_shock_state, mvrvPercentile: inp.v1.mvrv_percentile });
const coldFixDay = now => Math.floor((now - FIX.hour_utc * HOUR) / DAY);
// Состояние приходит из опубликованного JSON и читается строго: негодное состояние линии — её холодный
// старт, а не полуправда. Фикс «из будущего» (часы шагнули назад больше чем на сутки) — тоже негодное.
const validDaily = (prev, now) => !!prev && typeof prev === "object" && REGIMES.includes(prev.s) && Number.isInteger(prev.d) && prev.d <= Math.floor(now / DAY) && isNum(prev.tg) && prev.tg >= 0 && prev.tg <= 100 && (prev.p == null || REGIMES.includes(prev.p));
const validFloor = prev => Number.isInteger(prev?.fl) && prev.fl >= 0 && prev.fl <= POLICY_V3_CANDIDATE.floor_ladder_pct.length;
const pendingView = st => (st.p ? { candidate: st.p, fixes: Number(st.n) || 0, need: FIX.confirm_fixes_up } : null);
const KNOWN_STATES = [...REGIMES, ...DEGRADED];
const noCftcMeta = prev => (prev && typeof prev === "object" && KNOWN_STATES.includes(prev.state) && KNOWN_STATES.includes(prev.candidate)
  ? { state: prev.state, candidate: prev.candidate, count: Number.isInteger(prev.count) && prev.count > 0 ? prev.count : 0, since: typeof prev.since === "string" ? prev.since : null, downStreak: Number.isInteger(prev.downStreak) && prev.downStreak > 0 ? prev.downStreak : 0, anchor: REGIMES.includes(prev.anchor) ? prev.anchor : null }
  : null);

// Входы решения кандидата на фиксе: семьи, блоки, детекторы и кандидат режима до гистерезиса.
function v3Inputs(now, inp) {
  const exclude = SCORING.non_voting_families, v1 = inp.families, notes = [];
  const network = scoreNetworkV3({ hashrate: inp.series.hashrate, difficulty: inp.series.difficulty, now });
  const exchange = scoreExchangeSupplyV3({ reserve: inp.series.exchange_supply, now });
  const deep = mvrvDeepPercentileV3({ mvrvDeep: inp.series.mvrv_deep, now });
  const valuation = scoreValuationV3({ percentile: inp.v1.mvrv_percentile, percentileDeep: deep.percentile });
  const trend = scoreTrendV3({ priceDaily: inp.series.price_daily, now });
  const families = {
    macro: { ...v1.macro },
    demand: { etf: v1.demand.etf, stablecoins: v1.demand.stablecoins, exchange_supply: exchange.score, institutional: null },
    cycle: { valuation: valuation.score, network: network.score, activity: v1.cycle.activity, miners: v1.cycle.miners, trend: trend.score },
  };
  const blocks = blockScoresV1Port(families, exclude);
  const macroShock = macroShockStateV1Port(families.macro);
  const recovery = recoveryStateV1Port({ anchor: valuation.anchor, trend: trend.score, etf: families.demand.etf, exchangeSupply: exchange.score });
  const critical = !v1Insufficient(inp) && strategicCriticalV1Port(families, exclude);
  const candidate = strategicCandidateV1Port({ families, criticalOk: critical, hardOverride: inp.hard, macroShockState: macroShock, distributionState: "calm", recoveryState: recovery.state, exclude });
  if (v1Insufficient(inp)) notes.push("v1_insufficient");
  if (network.score === null) notes.push(`network_unavailable:${network.reason ?? "no_legs"}`);
  else if (network.reason) notes.push(`network_partial:${network.reason}`);
  if (exchange.score === null) notes.push(`exchange_supply_unavailable:${exchange.reason ?? "no_legs"}`);
  if (trend.score === null) notes.push(`trend_unavailable:${trend.reason ?? "no_data"}`);
  if (valuation.score === null) notes.push("valuation_unavailable");
  else if (!deep.used) notes.push(`mvrv_single_window:${deep.reason ?? "no_percentile"}`);
  // Даты последних наблюдений: к часу фикса ончейн-входы обычно того же дня, что и закрытая свеча.
  // Отставший вход фикс не останавливает, но помечается: решение принято на входах разного возраста.
  const observed = { closed_day: dateOf(trend.closed_at), mvrv: dateOf(last(cleanSeries(inp.series.mvrv, now))?.t), mvrv_deep: dateOf(deep.observed_at), exchange_supply: dateOf(exchange.observed_at), hashrate: dateOf(network.hashrate_at) };
  for (const key of ["mvrv", "exchange_supply"]) if (observed.closed_day && observed[key] && observed[key] < observed.closed_day) notes.push(`${key}_older_than_closed_day`);
  // Макровходы на фиксе старше закрытого дня по построению (FRED публикует вчерашний день после фикса),
  // а в ликвидности и условиях есть недельные ряды: даты карточек публикуются как есть. Помечается
  // только дневной вход — стресс — и только отставание сверх обычного: больше четырёх суток (выходные
  // вместе с праздником дают ровно четыре). Полноту макроблока по-прежнему сторожит покрытие v1.
  for (const key of MACRO_OBSERVED) {
    const t = toMs(inp.observed_at[key]);
    if (t !== null && t <= now) observed[key] = dateOf(t);
  }
  if (observed.closed_day && observed.macro_stress && Date.parse(observed.closed_day) - Date.parse(observed.macro_stress) > STRESS_MAX_LAG_DAYS * DAY) notes.push(`macro_stress_older_than_${STRESS_MAX_LAG_DAYS}d`);
  const record = {
    blocks: { macro: round(blocks.macro), demand: round(blocks.demand), cycle: round(blocks.cycle) },
    bands: { macro: bandV1Port(blocks.macro), demand: bandV1Port(blocks.demand), cycle: bandV1Port(blocks.cycle) },
    families: {
      network: { v3: round(network.score, 1), v1: v1.cycle.network, hashrate_30d_change_pct: round(network.hashrate_change_pct), difficulty_90d_change_pct: round(network.difficulty_change_pct) },
      exchange_supply: { v3: round(exchange.score, 1), v1: v1.demand.exchange_supply, change_7d_btc: round(exchange.flow_change_btc, 0), change_7d_percentile: round(exchange.flow_percentile, 1), reserve_90d_change_pct: round(exchange.reserve_change_pct), reserve_90d_percentile: round(exchange.reserve_percentile, 1) },
      valuation: { v3: valuation.score, v1: v1.cycle.valuation },
      trend: { v3: trend.score, v1: v1.cycle.trend, close: round(trend.close), ma_200d: round(trend.ma_200d), ma_20w: round(trend.ma_20w), ma_200w: round(trend.ma_200w) },
      institutional: { v3: null, v1: v1.demand.institutional },
    },
    mvrv_percentile: round(inp.v1.mvrv_percentile), mvrv_percentile_deep: round(deep.percentile), deep_window_used: deep.used, deep_points: deep.points,
    recovery, macro_shock_state: macroShock, critical_ok: critical,
    observed,
    observed_at: inp.observed_at,
    notes,
  };
  return { candidate, critical_ok: critical, families, blocks, macro_shock_state: macroShock, recovery, valuation, network, exchange_supply: exchange, trend, deep, notes, record };
}
// То же для тестов и сверок на реальных рядах: что кандидат прочитал бы на этом снимке.
export function evaluateV3Inputs({ now, inputs } = {}) {
  const t = toMs(now), inp = normalizeInputs(inputs);
  return t === null || !inp ? null : v3Inputs(t, inp);
}

function waitingView(inp, extra = {}) {
  return { target_pct: inp.hard ? POLICY_V1.ladder.emergency : null, state: inp.hard ? "emergency" : null, candidate: null, ...extra, reason_codes: [inp.hard ? "emergency_override" : "waiting_v1_state"] };
}

// policy_v3_shadow: суточный такт, свой счёт четырёх семей, пол ступенями.
function stepV3(now, inp, prev) {
  const rungs = POLICY_V3_CANDIDATE.floor_ladder_pct.length, reasons = [];
  let st = validDaily(prev, now) && validFloor(prev) ? prev : null, blind = false, tact = "between_fixes";
  if (!st) {
    // Холодный старт: линия наследует состояние и цель v1 и ждёт для этого настоящего режима.
    if (!REGIMES.includes(inp.v1.state)) return { state: null, view: waitingView(inp, { base_target_pct: null, fix_at: null, next_fix_at: null, floor: { active: false, rung: null, level_pct: null, closes: 0 }, binding_overlays: [], pending: null, inputs: null }) };
    const start = v1Decision(inp.v1.state, inp), floorLive = inp.v1.recovery_state === OVERLAYS_V1.recovery_detector_state && inp.v1.macro_shock_state !== OVERLAYS_V1.recovery_blocked_by_macro_shock_state;
    st = { s: inp.v1.state, p: null, n: 0, d: coldFixDay(now), at: iso(now), tg: inp.v1.target_pct ?? start.target_pct, fl: floorLive ? rungs : 0, ov: start.binding_overlays, c: REGIMES.includes(inp.v1.candidate) ? inp.v1.candidate : inp.v1.state, in: null };
    tact = "cold_start";
  } else {
    const clock = fixClockV3(now, st.d);
    if (clock.due && inp.hard) tact = "fix_deferred";
    else if (clock.due) {
      const calc = v3Inputs(now, inp);
      if (!REGIMES.includes(calc.candidate)) { blind = true; tact = "fix_deferred"; reasons.push("insufficient_data", ...calc.notes); }
      else {
        const consecutive = clock.day === st.d + 1, next = dailyHysteresisStepV3(st, calc.candidate, { consecutive });
        const live = calc.recovery.state === OVERLAYS_V1.recovery_detector_state && calc.macro_shock_state !== OVERLAYS_V1.recovery_blocked_by_macro_shock_state;
        const fl = live ? Math.min(rungs, (consecutive ? st.fl : 0) + 1) : 0;
        const alloc = allocationDecisionV3({ strategic: next.s, floorCloses: fl, cheap: calc.valuation.cheap });
        st = { s: next.s, p: next.p, n: next.n, d: clock.day, at: iso(now), tg: alloc.target_pct, fl, ov: alloc.binding_overlays, c: calc.candidate, in: calc.record };
        tact = "fix";
        if (!consecutive) reasons.push("missed_fix_reset");
      }
    }
  }
  const ladder = POLICY_V3_CANDIDATE.floor_ladder_pct, overlays = Array.isArray(st.ov) ? st.ov : [];
  const codes = inp.hard ? ["emergency_override", tact] : [tact, `base:${st.s}`, ...overlays, ...(st.p ? [`upgrade_pending:${st.p}:${st.n}/${FIX.confirm_fixes_up}`] : []), ...reasons, ...(!blind && Array.isArray(st.in?.notes) ? st.in.notes : [])];
  return {
    state: st,
    view: {
      target_pct: inp.hard ? POLICY_V1.ladder.emergency : blind ? null : st.tg,
      base_target_pct: POLICY_V3_CANDIDATE.ladder[st.s],
      state: inp.hard ? "emergency" : st.s,
      candidate: inp.hard ? "emergency" : REGIMES.includes(st.c) ? st.c : st.s,
      fix_at: str(st.at),
      next_fix_at: iso(fixClockV3(now, st.d).next_at),
      floor: { active: st.fl > 0, rung: st.fl > 0 ? st.fl : null, level_pct: st.fl > 0 ? ladder[Math.min(st.fl, ladder.length) - 1] : null, closes: st.fl },
      binding_overlays: inp.hard ? ["emergency_override"] : overlays,
      pending: pendingView(st),
      inputs: st.in ?? null,
      reason_codes: [...new Set(codes)],
    },
  };
}

// v1_daily_close: кандидат и детекторы v1 как опубликованы, но читаются только на фиксе.
function stepDailyClose(now, inp, prev) {
  const reasons = [];
  let st = validDaily(prev, now) ? prev : null, blind = false, tact = "between_fixes";
  if (!st) {
    if (!REGIMES.includes(inp.v1.state)) return { state: null, view: waitingView(inp, { fix_at: null, next_fix_at: null, binding_overlays: [], pending: null }) };
    const start = v1Decision(inp.v1.state, inp);
    st = { s: inp.v1.state, p: null, n: 0, d: coldFixDay(now), at: iso(now), tg: inp.v1.target_pct ?? start.target_pct, ov: start.binding_overlays, c: REGIMES.includes(inp.v1.candidate) ? inp.v1.candidate : inp.v1.state };
    tact = "cold_start";
  } else {
    const clock = fixClockV3(now, st.d);
    if (clock.due && inp.hard) tact = "fix_deferred";
    else if (clock.due && !REGIMES.includes(inp.v1.candidate)) { blind = true; tact = "fix_deferred"; reasons.push("insufficient_data"); }
    else if (clock.due) {
      const consecutive = clock.day === st.d + 1, next = dailyHysteresisStepV3(st, inp.v1.candidate, { consecutive });
      const decision = v1Decision(next.s, inp);
      st = { s: next.s, p: next.p, n: next.n, d: clock.day, at: iso(now), tg: decision.target_pct, ov: decision.binding_overlays, c: inp.v1.candidate };
      tact = "fix";
      if (!consecutive) reasons.push("missed_fix_reset");
    }
  }
  const overlays = Array.isArray(st.ov) ? st.ov : [];
  const codes = inp.hard ? ["emergency_override", tact] : [tact, `base:${st.s}`, ...overlays, ...(st.p ? [`upgrade_pending:${st.p}:${st.n}/${FIX.confirm_fixes_up}`] : []), ...reasons];
  return {
    state: st,
    view: {
      target_pct: inp.hard ? POLICY_V1.ladder.emergency : blind ? null : st.tg,
      state: inp.hard ? "emergency" : st.s,
      candidate: inp.hard ? "emergency" : REGIMES.includes(st.c) ? st.c : st.s,
      fix_at: str(st.at),
      next_fix_at: iso(fixClockV3(now, st.d).next_at),
      binding_overlays: inp.hard ? ["emergency_override"] : overlays,
      pending: pendingView(st),
      reason_codes: [...new Set(codes)],
    },
  };
}

// v1_floor_handoff: включённый пол 80 % переживает уход якоря оценки, пока держатся подтверждения.
function stepFloorHandoff(now, inp, prev) {
  const shock = inp.v1.macro_shock_state === OVERLAYS_V1.recovery_blocked_by_macro_shock_state;
  const live = inp.v1.recovery_state === OVERLAYS_V1.recovery_detector_state && !shock;
  const supports = recoveryStateV1Port({ anchor: true, trend: inp.families.cycle.trend, etf: inp.families.demand.etf, exchangeSupply: inp.families.demand.exchange_supply }).supports;
  // Порог удержания — тот же, что у самого детектора: два подтверждения из трёх.
  const carry = !live && prev?.on === true && !shock && supports >= SCORING.recovery.good_min_supports;
  const on = live || carry;
  const decision = v1Decision(inp.hard ? "emergency" : inp.v1.state, inp, on ? OVERLAYS_V1.recovery_detector_state : inp.v1.recovery_state);
  return {
    state: { on },
    view: { target_pct: decision.target_pct, carry, floor_on: on, state: inp.hard ? "emergency" : inp.v1.state, supports, binding_overlays: decision.binding_overlays, reason_codes: [...decision.reason_codes, ...(carry ? ["floor_handoff"] : [])] },
  };
}

// v1_no_cftc: тот же гейт на баллах семей без CFTC, собственный гистерезис по правилам v1.
function stepNoCftc(now, inp, prev) {
  const exclude = SCORING.non_voting_families, reasons = [];
  let candidate;
  if (inp.hard) candidate = "emergency";
  else if (v1Insufficient(inp)) candidate = "insufficient";
  else if (!strategicCriticalV1Port(inp.families, exclude)) { candidate = "insufficient"; reasons.push("families_incomplete"); }
  else candidate = strategicCandidateV1Port({ families: inp.families, criticalOk: true, macroShockState: inp.v1.macro_shock_state, distributionState: inp.v1.distribution_state, recoveryState: inp.v1.recovery_state, exclude });
  const warm = noCftcMeta(prev);
  // Холодный старт — от опубликованного состояния v1: первое наблюдение своего кандидата его не меняет.
  const meta = warm ? stabilizeCoreV1Port(candidate, warm.state, warm, now, { hard: inp.hard }) : stabilizeCoreV1Port(candidate, KNOWN_STATES.includes(inp.v1.state) ? inp.v1.state : undefined, {}, now, { hard: inp.hard });
  const decision = v1Decision(meta.state, inp);
  const state = { state: meta.state, candidate: meta.candidate, count: meta.count, since: meta.since, downStreak: meta.downStreak, anchor: meta.anchor ?? null };
  if (meta.hold_until) state.hold_until = meta.hold_until;
  return {
    state,
    view: { target_pct: decision.target_pct, base_target_pct: decision.base_target_pct, state: meta.state, candidate: meta.candidate, hold_until: meta.hold_until ?? null, demand_block: round(blockScoresV1Port(inp.families, exclude).demand), binding_overlays: decision.binding_overlays, reason_codes: [...(warm ? [] : ["cold_start"]), ...decision.reason_codes, ...reasons] },
  };
}

const LINES = [["policy_v3_shadow", "v3", stepV3], ["v1_daily_close", "dc", stepDailyClose], ["v1_floor_handoff", "fh", stepFloorHandoff], ["v1_no_cftc", "nc", stepNoCftc]];
const blankState = () => ({ v: SHADOW_VARIANTS_STATE_VERSION, v3: null, dc: null, fh: null, nc: null });

// Чистая функция: никогда не бросает исключений. variants — четыре линии; target_pct === null
// значит «держать прежнюю цель». state — компактный JSON: публикуется в каждом снимке и приходит
// обратно на следующем; чужое, испорченное или пустое состояние — это холодный старт линии.
export function evaluateShadowVariantsV1(args) {
  let prev = blankState();
  try {
    const { now, inputs, state } = args && typeof args === "object" ? args : {};
    if (state && typeof state === "object" && !Array.isArray(state) && state.v === SHADOW_VARIANTS_STATE_VERSION)
      for (const [, slot] of LINES) prev[slot] = state[slot] && typeof state[slot] === "object" && !Array.isArray(state[slot]) ? state[slot] : null;
    const t = toMs(now), inp = normalizeInputs(inputs), next = { ...prev }, variants = {};
    for (const [key, slot, step] of LINES) {
      // Линия, которую нельзя посчитать, держит цель и состояние; отказ одной линии не трогает остальные.
      if (t === null || !inp) { variants[key] = { target_pct: null, reason_codes: [t === null ? "invalid_now" : "no_inputs"] }; continue; }
      try {
        const result = step(t, inp, prev[slot]);
        next[slot] = result.state;
        variants[key] = result.view;
      } catch (error) {
        variants[key] = { target_pct: null, reason_codes: ["engine_error"], error: String(error?.message || error).slice(0, 160) };
      }
    }
    return { state: next, variants };
  } catch (error) {
    const variants = {};
    for (const [key] of LINES) variants[key] = { target_pct: null, reason_codes: ["engine_error"], error: String(error?.message || error).slice(0, 160) };
    return { state: prev, variants };
  }
}

// ===== Приёмка =====

// Критерии приёмки и фальсификации оценивает форвард-монитор: он читает acceptance_criteria по ключам.
// Здесь — исполняемое определение единственного критерия, который нельзя прочитать из числа:
// эпизоды расхождения с v1 по дневным строкам монитора (acceptance_definitions.target_changes_vs_v1).
// Счёт по снимкам для этого не годится: суточная линия отстаёт от каждой внутридневной смены цели v1
// на часы, и такие «расхождения» ничего не говорят о правиле.
export function countTargetDivergenceEpisodesV3(dailyRows, { candidate = "policy_v3_shadow", base = "policy_v1" } = {}) {
  let episodes = 0, days = 0, open = false;
  for (const row of Array.isArray(dailyRows) ? dailyRows : []) {
    const a = row?.targets?.[candidate], b = row?.targets?.[base];
    if (!isNum(a) || !isNum(b)) continue;
    const differs = Math.abs(a - b) > 1e-9;
    if (differs) { days++; if (!open) episodes++; }
    open = differs;
  }
  return { episodes, days };
}
