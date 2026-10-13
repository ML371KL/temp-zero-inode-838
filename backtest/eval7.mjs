/*
  Аудит 2026-10-10, дополнение 13.10: в какой час суток фиксировать суточное решение кандидата v3 и чего
  стоят его правила на тех часах, по которым он живёт.

  Вопрос. eval6.mjs считает на дневной сетке по соглашению архива: наблюдение известно в день, которым оно
  датировано, решение по закрытию дня D исполняется на закрытии D+1. На бою кандидат фиксирует решение в
  заданный час UTC дня D+1, и к этому часу входы разного возраста:
    — ончейн-данные, потоки ETF и закрытая дневная свеча за D на месте к 06:00 UTC;
    — VIX за рабочий день выходит в FRED на следующий рабочий день в 14-м часу UTC, кредитные спреды —
      в 14–16-м, ставки H.15 — в 21-м (зимой всё на час позже);
    — баланс ФРС (среда) выходит в четверг вечером;
    — индекс доллара DTWEXBGS публикуется раз в неделю, по понедельникам: на фиксе он старше закрытого
      дня на 3–10 суток;
    — отчёт CFTC (срез вторника) выходит в пятницу вечером; архив датирует его днём среза.
  Ранний фикс исполняет решение раньше, но читает макровходы старше; поздний — наоборот.

  Как считается. Правила — build из eval6.mjs. Три макросемьи пересчитываются здесь из сырых рядов архива
  (data/fred_*.json) формулами backtest/engine.mjs, но наблюдение становится доступным в момент ПУБЛИКАЦИИ
  (календарь ниже; часы взяты зимние, с запасом в сторону «позже»). Отчёт CFTC сдвигается на первый фикс
  после публикации. Позиция меняется в час фикса по часовым ценам (Bitstamp BTC/USD,
  data/price_bitstamp_hourly.json): сделка — по закрытию предыдущего часа.

  Самопроверки (скрипт падает, если не сошлись): без задержки публикации пересчёт макросемей обязан
  совпасть со строками реконструкции во все сутки; час 24 без задержки — это дневная сетка eval6.

  Первая версия этого файла задавала возраст макро сдвигом на одну календарную строку реконструкции. Ревью
  13.10.2026 показало, что так фикс получает недельный индекс доллара и пятничные ряды раньше, чем они
  выходят, и числа кандидата завышены (45,5 % годовых вместо 42,8 %). Здесь — календарь публикации.

  Запуск: node backtest/eval7.mjs  →  out/audit-2026-10-13-fix-hour.json
*/
import { readFileSync, writeFileSync } from "node:fs";
import { rows, rf, build, simulate, V3, DAY, finite, mean, stdev, clamp, r1, r2 } from "./eval6.mjs";

const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DATA = new URL("./data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const load = name => JSON.parse(readFileSync(`${DATA}${name}.json`, "utf8"));
const hourly = load("price_bitstamp_hourly");
const HOUR = hourly.step_ms, close = hourly.close, T0 = hourly.t0;
const COST = 0.001, FROM = "2018-06-01";

// ---- формулы макросемей из backtest/engine.mjs (равенство реконструкции — самопроверка 1) ----
const pctChange = (a, b) => finite(a) && finite(b) && Number(b) !== 0 ? (Number(a) / Number(b) - 1) * 100 : null;
const percentileRank = (values, value) => { const x = values.filter(finite).map(Number); if (x.length < 30 || !finite(value)) return null; const y = Number(value), less = x.filter(v => v < y).length, equal = x.filter(v => v === y).length; return (less + 0.5 * equal) / x.length * 100; };
const componentScore = parts => { const a = parts.filter(finite).map(Number); return a.length ? clamp(Math.round(mean(a) * 2) / 2, -2, 2) : null; };
const highGood = p => !finite(p) ? null : p >= 90 ? 2 : p >= 65 ? 1 : p >= 35 ? 0 : p >= 10 ? -1 : -2;
const lowGood = p => !finite(p) ? null : p <= 10 ? 2 : p <= 35 ? 1 : p <= 65 ? 0 : p <= 90 ? -1 : -2;
const vixRatioScore = v => !finite(v) ? null : v < 1 ? 0 : v < 1.10 ? -1 : -2;
function trailingChangeSeries(s, days, { difference = false, scale = 1 } = {}) {
  const out = [];
  for (let i = 1, j = 0; i < s.length; i++) {
    const target = s[i].t - days * DAY; while (j + 1 < i && s[j + 1].t <= target) j++;
    const prev = s[j]; if (!prev || prev.t > target || !finite(prev.v) || !finite(s[i].v)) continue;
    const v = difference ? (s[i].v - prev.v) * scale : pctChange(s[i].v, prev.v); if (finite(v)) out.push({ t: s[i].t, v });
  }
  return out;
}
function rollingMeanSeries(s, n) { const out = []; let acc = 0; for (let i = 0; i < s.length; i++) { acc += s[i].v; if (i >= n) acc -= s[i - n].v; if (i >= n - 1) out.push({ t: s[i].t, v: acc / n }); } return out; }
const nearestAtOrBefore = (s, t) => { let lo = 0, hi = s.length - 1, found = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].t <= t) { found = s[m]; lo = m + 1; } else hi = m - 1; } return found; };
const percentileCache = new Map();
function percentileAt(series, index, window) { let c = percentileCache.get(series); if (!c) percentileCache.set(series, (c = new Map())); if (!c.has(index)) c.set(index, percentileRank(series.slice(Math.max(0, index - window + 1), index + 1).map(x => x.v), series[index].v)); return c.get(index); }

const F = Object.fromEntries(["WALCL", "WTREGEN", "RRPONTSYD", "DFII10", "DGS10", "DTWEXBGS", "BAMLH0A0HYM2", "VIXCLS", "VXVCLS"].map(id => [id, load(`fred_${id}`)]));
const net = []; for (const p of F.WALCL) { const a = nearestAtOrBefore(F.WTREGEN, p.t), b = nearestAtOrBefore(F.RRPONTSYD, p.t); if (a && b) net.push({ t: p.t, v: p.v / 1000 - a.v / 1000 - b.v }); }
const S = {
  net4: trailingChangeSeries(net, 28), net13: trailingChangeSeries(net, 91),
  real4: trailingChangeSeries(F.DFII10, 28, { difference: true, scale: 100 }), usd4: trailingChangeSeries(F.DTWEXBGS, 28),
  hy4: trailingChangeSeries(F.BAMLH0A0HYM2, 28, { difference: true, scale: 100 }),
  rateVol: rollingMeanSeries(F.DGS10.slice(1).map((p, i) => ({ t: p.t, v: Math.abs(p.v - F.DGS10[i].v) * 100 })), 20),
  vixRatio: (() => { const far = new Map(F.VXVCLS.map(x => [x.t, x.v])); return F.VIXCLS.map(x => { const b = far.get(x.t); return finite(b) && b !== 0 ? { t: x.t, v: x.v / b } : null; }).filter(Boolean); })(),
};
// Срок годности наблюдения относительно закрытого дня — как в engine.mjs: 10 суток у дневных рядов, 21 у недельных.
// Индексу доллара дано 14 суток, как у сборщика: при недельной публикации 10 суток он не переживает.
const MAX_AGE = { net4: 21 * DAY, net13: 21 * DAY, real4: 10 * DAY, usd4: 14 * DAY, hy4: 10 * DAY, rateVol: 10 * DAY, vixRatio: 10 * DAY };

// ---- календарь публикации ----
// Дневной ряд: наблюдение за рабочий день выходит на следующую дату наблюдения того же ряда (следующий
// рабочий день) в час публикации. Баланс ФРС за среду — в четверг. Индекс доллара — в понедельник следующей
// недели. Часы — UTC, зимнее время (летом на час раньше): сдвиг в сторону «позже» фикс не приукрашивает.
const PUBLICATION_HOUR_UTC = { vix: 15, hy: 17, rates: 22, fed_balance: 22, dollar: 22, cftc: 21 };
const KIND = { hy4: "hy", vixRatio: "vix", rateVol: "rates", real4: "rates", usd4: "dollar", net4: "fed_balance", net13: "fed_balance" };
const SOURCE = { hy4: F.BAMLH0A0HYM2, vixRatio: F.VIXCLS, rateVol: F.DGS10, real4: F.DFII10 };
const nextObservation = Object.fromEntries(Object.entries(SOURCE).map(([name, series]) => [name, new Map(series.map((p, i) => [p.t, i + 1 < series.length ? series[i + 1].t : p.t + DAY]))]));
const mondayAfter = t => t + ((8 - new Date(t).getUTCDay()) % 7 || 7) * DAY;
const CALENDAR = (name, t) => {
  const kind = KIND[name], hour = PUBLICATION_HOUR_UTC[kind] * HOUR;
  if (kind === "dollar") return mondayAfter(t) + hour;
  if (kind === "fed_balance") return t + DAY + hour;
  return (nextObservation[name].get(t) ?? t + DAY) + hour;
};
const ON_OBSERVATION_DATE = (name, t) => t; // соглашение архива: известно в день наблюдения
// Последнее наблюдение ряда, известное к моменту фикса и не новее закрытого дня.
function latestKnown(name, day, fixAt, knownAt) {
  const s = S[name]; let lo = 0, hi = s.length - 1, found = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].t <= day && knownAt(name, s[m].t) <= fixAt) { found = m; lo = m + 1; } else hi = m - 1; }
  return found >= 0 && day - s[found].t <= MAX_AGE[name] ? found : null;
}
// Баллы трёх макросемей по дням при данном правиле публикации и часе фикса. maxAge — срок годности архива.
function macroScores(knownAt, hour, { archiveAges = false } = {}) {
  const out = { liquidity: [], conditions: [], stress: [] }, keep = MAX_AGE.usd4;
  if (archiveAges) MAX_AGE.usd4 = 10 * DAY;
  for (const r of rows) {
    const fixAt = r.t + DAY + hour * HOUR, at = name => latestKnown(name, r.t, fixAt, knownAt);
    { const i4 = at("net4"), i13 = at("net13"); let score = null;
      if (i4 != null && i13 != null) { score = componentScore([highGood(percentileAt(S.net4, i4, 260)), highGood(percentileAt(S.net13, i13, 260))]); if (S.net13[i13].v < 0 && finite(score)) score = Math.min(score, 0); }
      out.liquidity.push(score); }
    { const real = at("real4"), usd = at("usd4"); out.conditions.push(componentScore([lowGood(real != null ? percentileAt(S.real4, real, 750) : null), lowGood(usd != null ? percentileAt(S.usd4, usd, 750) : null)])); }
    { const hy = at("hy4"), vix = at("vixRatio"), rate = at("rateVol"), ratePct = rate != null ? percentileAt(S.rateVol, rate, 750) : null;
      out.stress.push(componentScore([lowGood(hy != null ? percentileAt(S.hy4, hy, 750) : null), vixRatioScore(vix != null ? S.vixRatio[vix].v : null), finite(ratePct) ? Math.min(lowGood(ratePct), 0) : null])); }
  }
  MAX_AGE.usd4 = keep;
  return out;
}
const scoreCache = new Map();
const publishedMacro = hour => { if (!scoreCache.has(hour)) scoreCache.set(hour, macroScores(CALENDAR, hour)); return scoreCache.get(hour); };
// Отчёт CFTC: срез вторника в архиве стоит в строке вторника, публикуется в пятницу вечером. Первый фикс после
// публикации читает его на три строки позже (фикс до 21:00 UTC) либо на две (фикс в 21:00 и позже).
const cftcLag = hour => (hour >= PUBLICATION_HOUR_UTC.cftc ? 2 : 3);
// Правила на фиксе в данный час: макро — по календарю публикации, CFTC — после публикации.
// archiveMacro — макровходы по соглашению архива (известны в день наблюдения) при том же отчёте CFTC: потолок свежести макро.
const onFix = (options, hour, { cftcPublished = true, archiveMacro = false } = {}) => build({ ...options, ...(archiveMacro ? {} : { override: publishedMacro(hour) }), ...(cftcPublished ? { lagBy: { institutional: cftcLag(hour) } } : {}) }).target;

// ---- симуляция: позиция меняется в начале часа фикса и стоит до следующего фикса ----
// Решение по данным дня i фиксируется в rows[i].t + сутки + hour часов.
function simulateHourly(target, { from, to = null, hour }) {
  const start = Date.parse(`${from}T00:00:00Z`), end = to ? Date.parse(`${to}T00:00:00Z`) + DAY : rows.at(-1).t + DAY;
  const fixes = new Map();
  for (let i = 0; i < rows.length; i++) if (finite(target[i])) fixes.set(rows[i].t + DAY + hour * HOUR, clamp(target[i] / 100, 0, 1));
  // Стартовая позиция — последнее решение, зафиксированное до начала окна.
  let pos = null; { let best = -Infinity; for (const [t, w] of fixes) if (t <= start && t > best) { best = t; pos = w; } }
  if (pos == null) pos = 0.5;
  let equity = 1, peak = 1, maxDD = 0, turnover = 0, changes = 0, dayStart = 1, exposureSum = 0, hours = 0; const excess = [];
  const rfAt = t => { const i = Math.min(rows.length - 1, Math.max(0, Math.round((Math.floor(t / DAY) * DAY - rows[0].t) / DAY))); return rf[i] ?? 0; };
  for (let t = start; t < end; t += HOUR) {
    const k = (t - T0) / HOUR; if (k < 1 || k >= close.length) continue;
    const w = fixes.get(t);
    if (w != null && t > start && Math.abs(w - pos) > 1e-9) { equity *= 1 - COST * Math.abs(w - pos); turnover += Math.abs(w - pos); changes++; pos = w; }
    const dayRf = rfAt(t);
    equity *= 1 + pos * (close[k] / close[k - 1] - 1) + (1 - pos) * dayRf / 24;
    peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity / peak - 1); exposureSum += pos; hours++;
    if ((t + HOUR) % DAY === 0) { excess.push(equity / dayStart - 1 - dayRf); dayStart = equity; }
  }
  const years = hours / 24 / 365, vol = stdev(excess) * Math.sqrt(365) * 100;
  return { cagr: r1((equity ** (1 / years) - 1) * 100), vol: r1(vol), sharpe: r2(mean(excess) * 365 * 100 / vol), maxDD: r1(maxDD * 100), avgExposure: r1(exposureSum / hours * 100), turnoverPerYear: r1(turnover / years * 100), changesPerYear: r1(changes / years) };
}

const WINDOWS = [["2018-06-01", null, "2018-06…2026-07"], ["2024-03-01", null, "эра ETF 2024-03…2026-07"], ["2022-01-01", "2022-12-31", "2022"]];
const windows = (target, hour) => Object.fromEntries(WINDOWS.map(([from, to, label]) => [label, simulateHourly(target, { from, to, hour })]));
const iFrom = rows.findIndex(r => r.date >= FROM);
const report = {
  generated_for: "audit 2026-10-10, fix hour study 2026-10-13 (publication calendar)",
  method: "правила eval6 (build); макросемьи пересчитаны из сырых рядов FRED, наблюдение доступно с момента публикации; отчёт CFTC — после публикации; позиция меняется в час фикса по часовым ценам Bitstamp; издержки 10 б.п. на полный оборот; Sharpe по суточным доходностям сверх кэша",
  publication_hour_utc: PUBLICATION_HOUR_UTC,
  publication_rule: "дневные ряды FRED — на следующую дату наблюдения ряда; баланс ФРС за среду — в четверг; индекс доллара — в понедельник следующей недели; CFTC (срез вторника) — в пятницу; часы зимние",
  self_check: {}, lines: {},
};

// ---- самопроверка 1: без задержки публикации пересчёт равен строкам реконструкции ----
{
  const mine = macroScores(ON_OBSERVATION_DATE, 0, { archiveAges: true }), bad = { liquidity: 0, conditions: 0, stress: 0 }; let days = 0;
  for (let i = iFrom; i < rows.length; i++) {
    if (rows[i].insufficientEra) continue; days++;
    const f = rows[i].families, reference = { liquidity: f.liquidity ?? null, conditions: f.conditions ?? null, stress: finite(f.stress28) ? f.stress28 : f.stress ?? null };
    for (const key of Object.keys(bad)) if ((mine[key][i] ?? null) !== (reference[key] ?? null)) bad[key]++;
  }
  report.self_check.macro_recomputation_vs_timeline = { days, mismatches: bad };
  if (Object.values(bad).some(Boolean)) throw new Error(`пересчёт макросемей разошёлся с реконструкцией: ${JSON.stringify(bad)}`);
  // ---- самопроверка 2: час 24 без задержки публикации — дневная сетка eval6 (цены Bitstamp против Coinbase) ----
  const archive = build({ ...V3, override: mine }).target, plain = build(V3).target;
  if (archive.some((v, i) => i >= iFrom && (v ?? null) !== (plain[i] ?? null))) throw new Error("подмена баллов макросемей меняет цель кандидата при соглашении архива");
  const a = simulateHourly(plain, { from: FROM, hour: 24 }), b = simulate(i => plain[i], { from: FROM });
  report.self_check.hour_24_vs_daily_grid = { hourly: [a.cagr, a.sharpe, a.maxDD], daily_grid: [b.cagr, b.sharpe, b.maxDD] };
  if (Math.abs(a.cagr - b.cagr) > 0.6 || Math.abs(a.sharpe - b.sharpe) > 0.03) throw new Error(`час 24 не воспроизводит дневную сетку eval6: ${JSON.stringify(report.self_check.hour_24_vs_daily_grid)}`);
}

// ---- час фикса: кандидат и правила v1, календарь публикации ----
const HOURS = [0, 3, 6, 9, 12, 18, 23, 24];
const RULES = [["кандидат v3", V3], ["правила v1 на суточном фиксе", {}]];
for (const [name, options] of RULES) {
  const line = (report.lines[name] = { by_publication: {}, fresh_macro: {}, archive_convention: {} });
  for (const hour of HOURS) {
    // by_publication — как на бою; fresh_macro — потолок: макровходы известны в день, которым датированы
    // (отчёт CFTC и тут после публикации); archive_convention — всё известно в день датировки, как в eval6.
    line.by_publication[`${hour}h`] = windows(onFix(options, hour), hour);
    line.fresh_macro[`${hour}h`] = windows(onFix(options, hour, { archiveMacro: true }), hour);
    line.archive_convention[`${hour}h`] = windows(build(options).target, hour);
  }
}

// ---- состав кандидата на фиксе 06:00: каждая правка отдельно поверх правил v1 и кандидат целиком ----
const FIX_HOUR = 6;
const COMPONENTS = [
  ["правила v1 на суточном фиксе", {}], ["без CFTC", { drop: ["institutional"] }], ["сеть по 30-дневным средним", { networkV3: true }], ["биржи по остатку", { exchangeV3: true }],
  ["оценка: согласие двух окон", { twoWindows: true }], ["без правил, которые не могут сработать", { noDeadRules: true }], ["пол 40/60/80 по фиксам", { floor: "graduated" }],
  ["пол 40/60/80 + удержание после ухода якоря", { floor: "graduated", carry: true }], ["пол 40/60/80 + хотя бы одна нога > 0", { floor: "graduated", onePositive: true }],
  ["кандидат v3 целиком", V3], ["v3 + удержание после ухода якоря", { ...V3, carry: true }], ["v3 без согласия двух окон", { ...V3, twoWindows: false }], ["v3 с полом v1 (80 % сразу)", { ...V3, floor: "v1" }],
  ["v3 без голоса CFTC", { ...V3, drop: ["institutional"] }],
];
report.components_at_06h = Object.fromEntries(COMPONENTS.map(([name, options]) => [name, windows(onFix(options, FIX_HOUR), FIX_HOUR)]));
// Различает ли история голос семьи CFTC. Отчёт сдвигается на N строк от дня среза (3 — первый фикс после
// публикации): если сдвиг на несколько дней меняет результат сильнее, чем само наличие голоса, вклад
// семьи историей не установлен.
{
  const macro = publishedMacro(FIX_HOUR), shifted = lag => windows(build({ override: macro, lagBy: { institutional: lag } }).target, FIX_HOUR);
  report.cftc_dating_at_06h = {
    "правила v1 без голоса CFTC": windows(onFix({ drop: ["institutional"] }, FIX_HOUR), FIX_HOUR),
    ...Object.fromEntries([0, 1, 2, 3, 4, 5, 7, 10, 14].map(lag => [`правила v1, отчёт CFTC на ${lag} сут. позже дня среза`, shifted(lag)])),
  };
}
// Что даёт недельная публикация индекса доллара: тот же календарь, но доллар как дневной ряд ставок.
{
  const keep = KIND.usd4, source = F.DTWEXBGS; KIND.usd4 = "rates"; SOURCE.usd4 = source;
  nextObservation.usd4 = new Map(source.map((p, i) => [p.t, i + 1 < source.length ? source[i + 1].t : p.t + DAY]));
  const dailyDollar = macroScores(CALENDAR, FIX_HOUR);
  KIND.usd4 = keep; delete SOURCE.usd4; delete nextObservation.usd4;
  report.dollar_publication_at_06h = {
    "кандидат v3, доллар раз в неделю (как на бою)": windows(onFix(V3, FIX_HOUR), FIX_HOUR),
    "кандидат v3, доллар как дневной ряд": windows(build({ ...V3, override: dailyDollar, lagBy: { institutional: cftcLag(FIX_HOUR) } }).target, FIX_HOUR),
  };
}
// Сколько суток решение кандидата на фиксе отличается от решения по входам, известным в день наблюдения.
{
  const fresh = onFix(V3, FIX_HOUR, { archiveMacro: true }), out = (report.days_target_differs_from_archive_convention = {});
  for (const hour of [6, 18, 23]) { const real = onFix(V3, hour); let days = 0, differ = 0; for (let i = iFrom; i < rows.length; i++) { if (!finite(fresh[i]) || !finite(real[i])) continue; days++; if (fresh[i] !== real[i]) differ++; } out[`${hour}h`] = { days, differ, share_pct: r1(differ / days * 100) }; }
}
// Кандидат и правила v1 по годам, фикс 06:00.
{
  const total = (target, from, to) => { const s = simulateHourly(target, { from, to, hour: FIX_HOUR }), start = Date.parse(`${from}T00:00:00Z`), end = Math.min(to ? Date.parse(`${to}T00:00:00Z`) + DAY : rows.at(-1).t + DAY, T0 + close.length * HOUR); return r1(((1 + s.cagr / 100) ** ((end - start) / DAY / 365) - 1) * 100); };
  const candidate = onFix(V3, FIX_HOUR), v1 = onFix({}, FIX_HOUR);
  report.by_year_at_06h = {};
  for (let y = 2018; y <= 2026; y++) { const from = y === 2018 ? FROM : `${y}-01-01`, to = y === 2026 ? null : `${y}-12-31`; report.by_year_at_06h[y] = { candidate_pct: total(candidate, from, to), v1_rules_pct: total(v1, from, to) }; }
}

writeFileSync(`${OUT}audit-2026-10-13-fix-hour.json`, JSON.stringify(report, null, 1));
const cell = s => `${String(s.cagr).padStart(5)} ${String(s.sharpe).padStart(5)} ${String(s.maxDD).padStart(6)}`;
const line = w => WINDOWS.map(([, , l]) => cell(w[l])).join(" | ");
console.log("Самопроверки:", JSON.stringify(report.self_check));
console.log("\nЧас фикса (UTC, день D+1): доходность годовых / Sharpe / макс. просадка — 2018-06+ | эра ETF | 2022\n");
for (const [name, l] of Object.entries(report.lines)) {
  console.log(name);
  for (const hour of HOURS) console.log(`  ${String(hour).padStart(2)}:00  по публикации:`, line(l.by_publication[`${hour}h`]), "   свежее макро:", line(l.fresh_macro[`${hour}h`]), "   соглашение архива:", line(l.archive_convention[`${hour}h`]));
}
console.log("\nСостав кандидата на фиксе 06:00 UTC, календарь публикации:");
for (const [name, w] of Object.entries(report.components_at_06h)) console.log("  " + name.padEnd(44), line(w));
console.log("\nГолос и датировка отчёта CFTC, фикс 06:00:");
for (const [name, w] of Object.entries(report.cftc_dating_at_06h)) console.log("  " + name.padEnd(44), line(w));
console.log("\nПубликация индекса доллара, фикс 06:00:");
for (const [name, w] of Object.entries(report.dollar_publication_at_06h)) console.log("  " + name.padEnd(48), line(w));
console.log("\nСуток, где решение на фиксе отличается от решения по соглашению архива:", JSON.stringify(report.days_target_differs_from_archive_convention));
console.log("По годам, фикс 06:00 (кандидат | правила v1):", Object.entries(report.by_year_at_06h).map(([y, v]) => `${y}: ${v.candidate_pct} | ${v.v1_rules_pct}`).join("; "));
