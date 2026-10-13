// Storage contract for the public snapshot. This is deliberately separate from the
// allocation/model policies: changing the representation must never change a decision.
export const PUBLIC_SNAPSHOT_MAX_BYTES = 3_000_000;
export const HISTORY_RETENTION_DAYS = 730;
export const HISTORY_HOURLY_DAYS = 14;
export const HISTORY_MAX_ROWS = HISTORY_RETENTION_DAYS + HISTORY_HOURLY_DAYS * 24;

const HISTORY_DECISION_FIELDS = [
  "state_hash",
  "decision_hash",
  "status",
  "base_target_pct",
  "target_pct",
  "binding_overlays",
  "quality",
];

// history[].decision used to repeat policy_id, policy_hash and the whole target ladder
// on every hourly row. Those immutable values live at snapshot.policy/policy_components;
// the exact forward record and its hash chain live in monitoring.decision_log. Keep only
// the fields needed to explain and verify the historical decision shown by the dashboard.
export function compactHistoryEntryV1(entry) {
  if (!entry || typeof entry !== "object" || !entry.decision || typeof entry.decision !== "object") return entry;
  const decision = {};
  for (const key of HISTORY_DECISION_FIELDS) {
    if (entry.decision[key] !== undefined) decision[key] = entry.decision[key];
  }
  return { ...entry, decision };
}

export const jsonBytesV1 = value => Buffer.byteLength(JSON.stringify(value));

// Форма ПУБЛИКУЕМОЙ строки истории. Одна функция и для байтового учёта, и для самой
// публикации — иначе они разъедутся, как уже разъезжались дважды в этом файле.
//
// `raw` — внутренние входы прогона, и целиком он в разы больше самой строки; поэтому
// публикация его резала. Но вместе с ним резался `oi_by_venue` — почасовой открытый
// интерес по площадкам, единственный ряд, который проект копит САМ и не может
// перекачать у провайдера. Он жил ровно в одном месте: в `.state/cache.json`, который
// лежит в .gitignore и между прогонами переносился кэшем Actions.
//
// 7 августа сбор переехал на VPS, кэш Actions на другую машину не поехал, сборщик
// честно откатился на опубликованный снимок — а там этого поля нет. Семидневная база
// исчезла, и карточка «Качество движения · цена × OI» ушла в «история накапливается»,
// забрав с собой одну из двадцати голосующих карточек и тактическое покрытие с 1.0 до
// 0.92. Записи удалось достать из ещё живого кэша Actions, но второй раз доставать
// будет неоткуда.
//
// Поэтому OI теперь публикуется — и ряд лечится сам из опубликованного артефакта на
// любой машине, без переноса состояния и без чьего-либо участия. Платим за это только
// внутри почасового окна: дальше него строки прорежены до одной в сутки, а базы, которые
// из них считаются, — семидневная и суточная — целиком лежат внутри окна. Цена замерена
// на живом снимке: 118 байт на строку, ~41 КБ на 14 суток при бюджете истории в 1 МБ.
export function publicHistoryEntryV1(entry, { hourlyCut = null } = {}) {
  if (!entry || typeof entry !== "object") return entry;
  const { raw, ...rest } = entry;
  const byVenue = raw?.oi_by_venue;
  if (!byVenue) return rest;
  const t = Date.parse(entry.t);
  if (hourlyCut !== null && Number.isFinite(t) && t < hourlyCut) return rest;
  return { ...rest, raw: { oi_by_venue: byVenue } };
}

// Детальные входы решения (`daily[].input_summary`, ~2.3 КБ) нужны для аудита СВЕЖИХ решений;
// на 370-дневном окне они дают ~0.87 МБ и в одиночку пробивают кап файла. NAV-серия обязана
// покрывать 365 дней (окна R1/R2/R3 и отставки), а подробные входы — нет: их долгосрочный якорь —
// git-история снимков, а проверяемость каждой строки сохраняет остающийся `input_hash`.
// Ни фронтенд, ни монитор, ни тесты старые input_summary не читают (проверено grep'ом).
export const DAILY_INPUT_SUMMARY_DAYS = 30;

// Форма прореженной дневной строки. Одна функция для прореживания и для проекции размера —
// иначе они разъедутся (тот же класс дрейфа, что зашитый в двух местах порог).
export function prunedDailyRowV1(row) {
  if (!row || typeof row !== "object" || row.input_summary === undefined) return row;
  const { input_summary, ...rest } = row;
  return { ...rest, input_summary_pruned: true };
}

export function pruneDailyInputSummaryV1(daily, { now = Date.now(), keepDays = DAILY_INPUT_SUMMARY_DAYS } = {}) {
  const cut = now - keepDays * 86_400_000;
  return (daily || []).map(row => {
    const t = Date.parse(row?.t || "");
    return Number.isFinite(t) && t < cut ? prunedDailyRowV1(row) : row;
  });
}

// Byte budget for the published history array. The row COUNT retention (days) cannot bound the
// file alone: individual rows grow as the schema evolves, and the steady-state projection then
// breaches the hard cap and deadlocks publication (the 02:50–04:50 2026-07-21 failures, same class
// c913472 fixed). The collector drops the OLDEST rows first — they are the least decision-relevant —
// until the published form fits, so retention becomes «N days OR the byte budget, whichever is smaller».
// Budget derivation against PUBLIC_SNAPSHOT_MAX_BYTES (3.0 MB), measured on the live snapshot
// 2026-07-21: monitoring.daily at limit 370×~3.1KB ≈ 1.15 MB + decision_log 400×~1.06KB ≈ 0.42 MB
// + non-history base ≈ 0.31 MB → ~1.88 MB steady-state without history. 1.0 MB history budget keeps
// ~0.1 MB of slack at every limit simultaneously; a larger budget re-opens the deadlock dead zone.
export const HISTORY_BYTE_BUDGET = 1_000_000;
export function boundedPublicHistoryV1(history, { budget = HISTORY_BYTE_BUDGET, minRows = 48, hourlyCut = null } = {}) {
  const rows = [...(history || [])];
  // Мерить обязано ровно ту форму, которая уедет в файл, — см. publicHistoryEntryV1.
  // Раньше здесь стояло `const {raw,...p}=h`, и это совпадало с публикацией; теперь
  // публикация оставляет OI внутри почасового окна, и повтор правила здесь означал бы
  // бюджет, считающий не то, что публикуется.
  const rowBytes = rows.map(h => jsonBytesV1(publicHistoryEntryV1(h, { hourlyCut })) + 1);
  let total = rowBytes.reduce((a, b) => a + b, 1);
  let drop = 0;
  while (rows.length - drop > minRows && total > budget) { total -= rowBytes[drop]; drop++; }
  return { history: rows.slice(drop), trimmed: drop };
}

// Forecast the largest public file allowed by all retention settings, using the most
// recent row of each log as a conservative size sample. Static audit calls this on the
// compacted representation, including while migrating an older un-compacted snapshot.
export function projectedPublicSnapshotBytesV1({ snapshotBytes, snapshot, dailyLimit, decisionLogLimit, historyMaxRows = HISTORY_MAX_ROWS, dailyInputSummaryDays = DAILY_INPUT_SUMMARY_DAYS }) {
  const daily = snapshot?.monitoring?.daily || [];
  const decisions = snapshot?.monitoring?.decision_log || [];
  const history = snapshot?.history || [];
  const addedBytes = (rows, limit) => rows.length ? Math.max(0, limit - rows.length) * jsonBytesV1(rows.at(-1)) : 0;
  // Daily at the limit: only the freshest `dailyInputSummaryDays` rows carry input_summary, the
  // rest are pruned — projecting the full row size across all 370 days overstates the steady
  // state by ~0.8 MB and would demand a budget the storage policy never actually needs.
  let dailyGrowth = 0;
  if (daily.length) {
    const sample = daily.at(-1);
    const fresh = Math.min(dailyLimit, dailyInputSummaryDays), old = Math.max(0, dailyLimit - dailyInputSummaryDays);
    // Точный размер JSON-массива: элементы + запятые между ними + квадратные скобки.
    const projected = fresh * jsonBytesV1(sample) + old * jsonBytesV1(prunedDailyRowV1(sample)) + (fresh + old) + 1;
    dailyGrowth = Math.max(0, projected - jsonBytesV1(daily));
  }
  // History growth is bounded by the collector's byte budget, not by row count alone: future rows
  // beyond the remaining budget will be evicted oldest-first, so they cannot enlarge the file.
  const historyGrowth = Math.min(addedBytes(history, historyMaxRows), Math.max(0, HISTORY_BYTE_BUDGET - jsonBytesV1(history)));
  return snapshotBytes + dailyGrowth + addedBytes(decisions, decisionLogLimit) + historyGrowth;
}

// ---------------------------------------------------------------------------------------------
// Необязательные поля снимка (правки аудита 10.10.2026): regime_birth, tick_diff, valuation_levels,
// data_warnings, diagnostics и sources.etf.legs.
//
// Правило одно для сборщика и для проверки перед публикацией: поля может не быть вовсе (снимок
// прежней формы, холодный старт, отказ расчёта — null), но если оно есть, оно обязано иметь форму,
// на которую рассчитывают витрина и уведомления. Сборщик прогоняет каждое поле через эту же функцию
// ДО записи снимка и негодное заменяет на null со строкой диагностики, поэтому на живом кандидате
// проверка self-test краснеть не может; она ловит порчу файла и расхождение версий кода.
//
// Бюджет размера — на каждое поле отдельно: строки растут по мере эволюции схемы, а жёсткий кап
// файла однажды уже останавливал публикацию. Обычный снимок несёт во всех этих полях около 1,5 КБ.
// Худший случай на живых именах карточек (все 20 голосующих семей и все семь детекторов сменились в
// одном снимке): tick_diff 3,3 КБ, regime_birth 4,8 КБ, два предупреждения 0,5 КБ, ноги 0,3 КБ.
// Потолки — с запасом в два с половиной раза и больше; их сумма 34 КБ при капе файла в 3 МБ.
export const OPTIONAL_FIELD_MAX_BYTES = {
  regime_birth: 12_000,
  tick_diff: 8_000,
  valuation_levels: 2_000,
  data_warnings: 4_000,
  diagnostics: 6_000,
  etf_legs: 2_000,
};
export const OPTIONAL_SNAPSHOT_FIELDS = ["regime_birth", "tick_diff", "valuation_levels", "data_warnings", "diagnostics"];

const REGIME_LABELS = new Set(["constructive", "unconfirmed_positive", "transition", "deteriorating", "defensive", "insufficient", "emergency",
  "spot_led", "balanced", "overheated_supported", "fragile", "demand_break", "deleveraging", "short_squeeze"]);
const DETECTOR_STATES = new Set(["calm", "watch", "fired", "good"]);
const BLOCK_BANDS = new Set(["supportive", "neutral", "adverse", "unknown"]);
const isObject = x => !!x && typeof x === "object" && !Array.isArray(x);
const isText = x => typeof x === "string" && x.length > 0;
const isIsoTime = x => typeof x === "string" && Number.isFinite(Date.parse(x));
const isNumber = x => typeof x === "number" && Number.isFinite(x);
const numberOrNull = x => x === null || isNumber(x);

function familyRowProblems(rows, path) {
  if (!Array.isArray(rows)) return [`${path}: ожидался массив`];
  const out = [];
  rows.forEach((row, i) => {
    if (!isObject(row) || ![row.block, row.family, row.id, row.name].every(isText)) out.push(`${path}[${i}]: нужны block, family, id и name`);
    else if (!numberOrNull(row.from) || !numberOrNull(row.to) || row.from === row.to) out.push(`${path}[${i}] (${row.id}): from и to — разные баллы либо null`);
  });
  return out;
}
function detectorRowProblems(rows, path) {
  if (!Array.isArray(rows)) return [`${path}: ожидался массив`];
  const out = [];
  rows.forEach((row, i) => {
    if (!isObject(row) || !isText(row.id) || !DETECTOR_STATES.has(row.from) || !DETECTOR_STATES.has(row.to) || row.from === row.to) out.push(`${path}[${i}]: нужны id и два разных состояния детектора`);
  });
  return out;
}
function regimeBirthProblems(value) {
  if (!isObject(value)) return ["regime_birth: ожидался объект"];
  const out = [];
  for (const horizon of ["strategic", "tactical"]) {
    const record = value[horizon], path = `regime_birth.${horizon}`;
    if (record === null || record === undefined) continue;
    if (!isObject(record)) { out.push(`${path}: ожидался объект или null`); continue; }
    if (!isIsoTime(record.t)) out.push(`${path}.t: нужна метка времени`);
    if (!REGIME_LABELS.has(record.candidate) || !REGIME_LABELS.has(record.from_candidate) || record.candidate === record.from_candidate) out.push(`${path}: candidate и from_candidate — две разные известные метки режима`);
    if (!numberOrNull(record.price ?? null)) out.push(`${path}.price: число или null`);
    if (!(record.note === null || record.note === undefined || record.note === "coverage")) out.push(`${path}.note: null или "coverage"`);
    out.push(...familyRowProblems(record.families, `${path}.families`), ...detectorRowProblems(record.detectors, `${path}.detectors`));
    if (horizon === "strategic") {
      if (!isObject(record.blocks)) out.push(`${path}.blocks: ожидался объект`);
      else for (const [key, change] of Object.entries(record.blocks)) {
        if (!["macro", "demand", "cycle"].includes(key) || !isObject(change) || !numberOrNull(change.from) || !numberOrNull(change.to) || !BLOCK_BANDS.has(change.band_from) || !BLOCK_BANDS.has(change.band_to)) out.push(`${path}.blocks.${key}: нужны from, to, band_from и band_to`);
      }
    }
  }
  return out;
}
function tickDiffProblems(value) {
  if (!isObject(value)) return ["tick_diff: ожидался объект"];
  const out = [...familyRowProblems(value.families, "tick_diff.families"), ...detectorRowProblems(value.detectors, "tick_diff.detectors")];
  if (value.mvrv_percentile !== undefined) {
    const m = value.mvrv_percentile;
    if (!isObject(m) || !numberOrNull(m.from) || !numberOrNull(m.to) || m.from === m.to) out.push("tick_diff.mvrv_percentile: from и to — разные числа либо null");
  }
  return out;
}
function valuationLevelsProblems(value) {
  if (!isObject(value)) return ["valuation_levels: ожидался объект"];
  const out = [];
  if (!isIsoTime(value.as_of)) out.push("valuation_levels.as_of: нужна метка времени");
  if (!isNumber(value.mvrv) || value.mvrv <= 0) out.push("valuation_levels.mvrv: положительное число");
  if (!(value.realized_price_usd === null || (isNumber(value.realized_price_usd) && value.realized_price_usd > 0))) out.push("valuation_levels.realized_price_usd: положительное число или null");
  if (!Number.isInteger(value.window_days) || value.window_days <= 0) out.push("valuation_levels.window_days: целое число дней");
  if (!Array.isArray(value.levels) || !value.levels.length) return [...out, "valuation_levels.levels: ожидался непустой массив"];
  let previousPercentile = -Infinity, previousMvrv = -Infinity;
  const keys = new Set();
  value.levels.forEach((level, i) => {
    const path = `valuation_levels.levels[${i}]`;
    if (!isObject(level) || !isText(level.key) || keys.has(level.key)) { out.push(`${path}: нужен уникальный key`); return; }
    keys.add(level.key);
    if (!isNumber(level.percentile) || level.percentile <= previousPercentile || level.percentile <= 0 || level.percentile >= 100) out.push(`${path}.percentile: перцентили обязаны возрастать внутри 0…100`);
    else previousPercentile = level.percentile;
    if (!numberOrNull(level.mvrv) || (isNumber(level.mvrv) && level.mvrv <= 0)) out.push(`${path}.mvrv: положительное число или null`);
    else if (isNumber(level.mvrv)) {
      // Уровень на большем перцентиле не может быть ниже уровня на меньшем.
      if (level.mvrv < previousMvrv) out.push(`${path}.mvrv: уровни обязаны не убывать с перцентилем`);
      previousMvrv = level.mvrv;
    }
    if (!numberOrNull(level.price_usd) || (isNumber(level.price_usd) && level.price_usd <= 0)) out.push(`${path}.price_usd: положительное число или null`);
    // Цена уровня — уровень MVRV, умноженный на реализованную цену; допуск — на округление обоих чисел.
    else if (isNumber(level.price_usd) && isNumber(level.mvrv) && isNumber(value.realized_price_usd) && Math.abs(level.price_usd / (level.mvrv * value.realized_price_usd) - 1) > 0.002) out.push(`${path}.price_usd: не равна уровню MVRV × реализованная цена`);
  });
  return out;
}
function dataWarningsProblems(value) {
  if (!Array.isArray(value)) return ["data_warnings: ожидался массив"];
  const out = [];
  value.forEach((w, i) => {
    const path = `data_warnings[${i}]`;
    if (!isObject(w) || ![w.source, w.code, w.text].every(isText)) { out.push(`${path}: нужны source, code и text`); return; }
    if (!Array.isArray(w.affects) || !w.affects.every(isText)) out.push(`${path}.affects: список id карточек`);
    for (const key of ["value", "threshold", "alive", "total"]) if (w[key] !== undefined && !isNumber(w[key])) out.push(`${path}.${key}: число`);
  });
  return out;
}
function diagnosticsProblems(value) {
  if (!Array.isArray(value)) return ["diagnostics: ожидался массив"];
  return value.flatMap((d, i) => isObject(d) && isText(d.scope) && isText(d.error) ? [] : [`diagnostics[${i}]: нужны scope и error`]);
}
function etfLegsProblems(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8) return ["sources.etf.legs: ожидался список ног источника"];
  const out = [], names = new Set();
  value.forEach((leg, i) => {
    const path = `sources.etf.legs[${i}]`;
    if (!isObject(leg) || !isText(leg.name) || names.has(leg.name)) { out.push(`${path}: нужно уникальное name`); return; }
    names.add(leg.name);
    if (leg.state === "ok") { if (leg.error !== undefined && leg.error !== null) out.push(`${path}: у живой ноги не бывает error`); }
    else if (leg.state === "fail") { if (!isText(leg.error)) out.push(`${path}: у отказавшей ноги обязана быть причина`); }
    else out.push(`${path}.state: ok или fail`);
  });
  return out;
}
const OPTIONAL_FIELD_CHECKS = {
  regime_birth: regimeBirthProblems,
  tick_diff: tickDiffProblems,
  valuation_levels: valuationLevelsProblems,
  data_warnings: dataWarningsProblems,
  diagnostics: diagnosticsProblems,
  etf_legs: etfLegsProblems,
};
// Претензии к одному необязательному полю. Отсутствующее поле (null/undefined) и поле без контракта
// претензий не имеют: первое — законное «нет данных», второе — не публикуется.
export function optionalFieldProblemsV1(name, value) {
  if (value === null || value === undefined) return [];
  const check = OPTIONAL_FIELD_CHECKS[name];
  if (!check) return [];
  const out = check(value), limit = OPTIONAL_FIELD_MAX_BYTES[name], bytes = jsonBytesV1(value);
  if (limit && bytes > limit) out.push(`${name}: ${bytes} байт при бюджете ${limit}`);
  return out;
}
// Претензии ко всем необязательным полям снимка разом — для проверки перед публикацией.
export function optionalSnapshotProblemsV1(snapshot) {
  const out = [];
  for (const name of OPTIONAL_SNAPSHOT_FIELDS) out.push(...optionalFieldProblemsV1(name, snapshot?.[name]));
  out.push(...optionalFieldProblemsV1("etf_legs", snapshot?.sources?.etf?.legs));
  return out;
}
// Сколько байт необязательные поля занимают в публичном снимке — вместе с ключами и запятыми.
export function optionalSnapshotBytesV1(snapshot) {
  const sizes = {};
  for (const name of OPTIONAL_SNAPSHOT_FIELDS) if (snapshot?.[name] !== undefined) sizes[name] = jsonBytesV1(snapshot[name]) + name.length + 4;
  if (snapshot?.sources?.etf?.legs !== undefined) sizes.etf_legs = jsonBytesV1(snapshot.sources.etf.legs) + 8;
  return { ...sizes, total: Object.values(sizes).reduce((a, b) => a + b, 0) };
}
