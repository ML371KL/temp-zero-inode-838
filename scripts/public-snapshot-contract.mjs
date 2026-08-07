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
