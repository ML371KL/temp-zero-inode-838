/*
  Аудит 2026-10-10, дополнение 13.10: в какой час суток фиксировать суточное решение кандидата v3.

  Вопрос. eval6.mjs считает на дневной сетке: решение по закрытию дня D, сделка на закрытии D+1. На бою
  кандидат фиксирует решение в заданный час UTC дня D+1, и к этому часу входы разного возраста:
    — ончейн-данные, потоки ETF и закрытая дневная свеча за D на месте к 06:00 UTC;
    — кредитные спреды и VIX за D выходят в FRED днём D+1 около 13:30 UTC (12:30 летом);
    — ставки H.15 и счёт Минфина за D — около 21:15 UTC (20:15 летом).
  Ранний фикс исполняет решение раньше, но читает макровходы на день старше; поздний — наоборот.
  Дневная сетка эти два эффекта не разделяет. Здесь — те же правила (eval6: build), но позиция меняется
  в час фикса по часовым ценам (Bitstamp BTC/USD, data/price_bitstamp_hourly.json).

  Что считается. Для каждого часа фикса — две строки: «по публикации» (макровходы того возраста, который
  реально доступен к этому часу) и «все входы за D» (потолок: чего стоил бы этот час, будь макро свежим).
  Час 24 со свежим макро — дневная сетка eval6 (сверка), час 0 — сделка по тому же закрытию (недостижимо).

  Запуск: node backtest/eval7.mjs  →  out/audit-2026-10-13-fix-hour.json
*/
import { readFileSync, writeFileSync } from "node:fs";
import { rows, rf, build, V3, DAY, finite, mean, stdev, clamp, r1, r2 } from "./eval6.mjs";

const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DATA = new URL("./data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const hourly = JSON.parse(readFileSync(`${DATA}price_bitstamp_hourly.json`, "utf8"));
const HOUR = hourly.step_ms, close = hourly.close, T0 = hourly.t0;
const COST = 0.001;

// Возраст макровходов к часу фикса (в днях сверх закрытого дня D): что реально опубликовано.
// Пороги взяты с запасом на зимнее время: спреды и VIX — к 15:00 UTC, H.15 и счёт Минфина — к 22:00 UTC.
const publicationLag = hour => ({ stress: hour >= 15 ? 0 : 1, conditions: hour >= 22 ? 0 : 1, liquidity: hour >= 22 ? 0 : 1 });

// Позиция меняется в начале часа фикса (цена — закрытие предыдущего часа) и стоит до следующего фикса.
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
const HOURS = [0, 3, 6, 9, 12, 15, 18, 22, 24];
const report = { generated_for: "audit 2026-10-10, fix hour study 2026-10-13", method: "правила eval6 (build); позиция меняется в час фикса по часовым ценам Bitstamp; издержки 10 б.п. на полный оборот; Sharpe по суточным доходностям сверх кэша", publication_lag_days: Object.fromEntries(HOURS.map(h => [`${h}h`, publicationLag(h)])), lines: {} };

const targets = new Map();
const targetOf = (name, options) => { const key = name + JSON.stringify(options); if (!targets.has(key)) targets.set(key, build(options).target); return targets.get(key); };
for (const [name, base] of [["кандидат v3", V3], ["v1 на суточном фиксе", {}]]) {
  const line = (report.lines[name] = { by_publication: {}, all_inputs_of_closed_day: {} });
  for (const hour of HOURS) {
    const real = targetOf(name, { ...base, lagBy: publicationLag(hour) }), ideal = targetOf(name, base);
    line.by_publication[`${hour}h`] = Object.fromEntries(WINDOWS.map(([from, to, label]) => [label, simulateHourly(real, { from, to, hour })]));
    line.all_inputs_of_closed_day[`${hour}h`] = Object.fromEntries(WINDOWS.map(([from, to, label]) => [label, simulateHourly(ideal, { from, to, hour })]));
  }
}
// Сколько суток решение «по публикации» отличается от решения по всем входам закрытого дня.
report.days_target_differs_from_fresh = {};
for (const [name, base] of [["кандидат v3", V3], ["v1 на суточном фиксе", {}]]) {
  const ideal = targetOf(name, base), out = (report.days_target_differs_from_fresh[name] = {});
  for (const hour of [6, 15]) {
    const real = targetOf(name, { ...base, lagBy: publicationLag(hour) }); let n = 0, differ = 0;
    for (let i = 0; i < rows.length; i++) { if (rows[i].date < "2018-06-01" || !finite(ideal[i]) || !finite(real[i])) continue; n++; if (ideal[i] !== real[i]) differ++; }
    out[`${hour}h`] = { days: n, differ, share_pct: r1(differ / n * 100) };
  }
}

// Состав кандидата на часе фикса 06:00 UTC: каждая правка отдельно и кандидат целиком, макровходы по публикации.
const COMPONENTS = [
  ["v1 на суточном фиксе", {}], ["без CFTC", { drop: ["institutional"] }], ["сеть по 30-дневным средним", { networkV3: true }], ["биржи по остатку", { exchangeV3: true }],
  ["оценка: согласие двух окон", { twoWindows: true }], ["без правил, которые не могут сработать", { noDeadRules: true }], ["пол 40/60/80 по фиксам", { floor: "graduated" }],
  ["пол 40/60/80 + удержание после ухода якоря", { floor: "graduated", carry: true }], ["пол 40/60/80 + хотя бы одна нога > 0", { floor: "graduated", onePositive: true }],
  ["кандидат v3 целиком", V3], ["v3 + удержание после ухода якоря", { ...V3, carry: true }], ["v3 без согласия двух окон", { ...V3, twoWindows: false }], ["v3 с полом v1 (80 % сразу)", { ...V3, floor: "v1" }],
];
report.components_at_06h = {};
for (const [name, options] of COMPONENTS) { const target = build({ ...options, lagBy: publicationLag(6) }).target; report.components_at_06h[name] = Object.fromEntries(WINDOWS.map(([from, to, label]) => [label, simulateHourly(target, { from, to, hour: 6 })])); }

writeFileSync(`${OUT}audit-2026-10-13-fix-hour.json`, JSON.stringify(report, null, 1));
const cell = s => `${String(s.cagr).padStart(5)} ${String(s.sharpe).padStart(5)} ${String(s.maxDD).padStart(6)}`;
console.log("Час фикса (UTC, день D+1): доходность годовых / Sharpe / макс. просадка — 2018-06+ | эра ETF | 2022\n");
for (const [name, line] of Object.entries(report.lines)) {
  console.log(name);
  for (const hour of HOURS) {
    const a = line.by_publication[`${hour}h`], b = line.all_inputs_of_closed_day[`${hour}h`], lag = publicationLag(hour);
    console.log(`  ${String(hour).padStart(2)}:00  по публикации (стресс ${lag.stress}д, ставки ${lag.conditions}д):`, WINDOWS.map(([, , l]) => cell(a[l])).join(" | "), "   все входы за D:", WINDOWS.map(([, , l]) => cell(b[l])).join(" | "));
  }
}
console.log("\nСостав кандидата на фиксе 06:00 UTC (2018-06+ | эра ETF | 2022):");
for (const [name, w] of Object.entries(report.components_at_06h)) console.log("  " + name.padEnd(44), WINDOWS.map(([, , l]) => cell(w[l])).join(" | "));
console.log("\nСуток, где решение по публикации отличается от решения по свежим входам:", JSON.stringify(report.days_target_differs_from_fresh));
