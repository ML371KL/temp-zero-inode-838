// Сверка движка вариантов на боевом окне 19.07–10.10.2026: приёмка портов на каждом снимке ленты,
// прогон четырёх теневых линий с учётом NAV по правилам монитора, чувствительность суточной линии
// к часу фикса и разбор того, что делала бы policy_v3_shadow.
// Запуск: node scripts/variants-replay.mjs [--audit <dir>] [--out <json>] [--write-fixture] [--fixes].
// В `npm run check` не входит: лента и сырьё лежат вне репозитория (папка аудита).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { POLICY_V3_CANDIDATE, countTargetDivergenceEpisodesV3, dailyHysteresisStepV3, evaluateShadowVariantsV1, macroShockStateV1Port, recoveryStateV1Port, stabilizeCoreV1Port, strategicCandidateV1Port, strategicCriticalV1Port } from "../docs/policy-v3-candidate.mjs";
import { DAY, HOUR, MONITOR_START, NavBook, arg, auditDir, changeLine, divergenceSegments, flag, inputsFromTick, loadRawSeries, pad, readTicks, vintageSlicer } from "./variants-lib.mjs";

const AUDIT = auditDir();
const all = await readTicks(join(AUDIT, "work", "ticks.jsonl"));
const ticks = all.filter(x => Date.parse(x.t) >= MONITOR_START && Number.isFinite(x.price));
const first = ticks[0], lastTick = ticks.at(-1);
console.log(`Лента: ${all.length} снимков; окно монитора: ${ticks.length} снимков, ${first.t.slice(0, 16)} → ${lastTick.t.slice(0, 16)}, BTC ${Math.round(first.price)} → ${Math.round(lastTick.price)} (${((lastTick.price / first.price - 1) * 100).toFixed(1)} %)`);
const v1Target = (state, x) => allocationDecisionV1({ strategic: state, recoveryState: x.detectors.recovery[0], macroShockState: x.detectors.macro_shock[0], mvrvPercentile: x.metrics.mvrv_cycle[1] }).target_pct;

// ---------- 1. Приёмка портов на каждом снимке ----------
const anchorLow = x => /оценка низкая/.test(x.detectors?.recovery?.[1] || "");
function portChecks(set) {
  const miss = { candidate: 0, critical: 0, macro_shock: 0, recovery: 0, target: 0 };
  for (const x of set) {
    const inp = inputsFromTick(x), published = x.regime_meta?.strategic?.candidate ?? x.regime?.strategic;
    const candidate = strategicCandidateV1Port({ families: inp.families, criticalOk: inp.v1.critical_ok, hardOverride: inp.hard_override, macroShockState: inp.v1.macro_shock_state, distributionState: inp.v1.distribution_state, recoveryState: inp.v1.recovery_state });
    if (candidate !== published) miss.candidate++;
    if (strategicCriticalV1Port(inp.families) !== inp.v1.critical_ok) miss.critical++;
    if (macroShockStateV1Port(inp.families.macro) !== inp.v1.macro_shock_state) miss.macro_shock++;
    const mvrv = inp.v1.mvrv_percentile, recovery = recoveryStateV1Port({ anchor: Number.isFinite(mvrv) && mvrv < POLICY_V3_CANDIDATE.scoring.valuation.recovery_anchor_below_percentile, trend: inp.families.cycle.trend, etf: inp.families.demand.etf, exchangeSupply: inp.families.demand.exchange_supply });
    // До заморозки v1 (версии 2.7.x) подпись детектора была другой — якорь по ней не сверяется.
    if (recovery.state !== inp.v1.recovery_state || (/оценка/.test(x.detectors?.recovery?.[1] || "") && recovery.anchor !== anchorLow(x))) miss.recovery++;
    if (x.decision?.status && v1Target(inp.v1.state, x) !== (x.decision.target ?? null)) miss.target++;
  }
  return miss;
}
const portWindow = portChecks(ticks), portAll = portChecks(all);
// Гистерезис: порт на опубликованных кандидатах от опубликованной меты первого снимка окна.
const hysteresis = { mismatches: 0, at: [] }, portState = [first.regime.strategic];
{
  let meta = first.regime_meta.strategic, state = first.regime.strategic;
  for (let i = 1; i < ticks.length; i++) {
    const x = ticks[i], next = stabilizeCoreV1Port(x.regime_meta.strategic.candidate, state, meta, Date.parse(x.t), { hard: !!x.override });
    if (next.state !== x.regime.strategic) { hysteresis.mismatches++; if (hysteresis.at.length < 6) hysteresis.at.push(`${x.t}: порт ${next.state}, опубликовано ${x.regime.strategic}`); }
    meta = next; state = next.state; portState.push(state);
  }
}
console.log("\n1. Приёмка портов (расхождений с опубликованным)");
console.log(`   окно монитора, ${ticks.length} снимков: кандидат из баллов всех семей ${portWindow.candidate}, покрытие ${portWindow.critical}, макрошок ${portWindow.macro_shock}, recovery ${portWindow.recovery}, цель v1 ${portWindow.target}`);
console.log(`   вся лента, ${all.length} снимков:        кандидат ${portAll.candidate}, покрытие ${portAll.critical}, макрошок ${portAll.macro_shock}, recovery ${portAll.recovery}, цель v1 ${portAll.target}`);
console.log(`   гистерезис (порт stabilizeCore от опубликованной меты): ${hysteresis.mismatches} из ${ticks.length - 1}${hysteresis.at.length ? " — " + hysteresis.at.join("; ") : ""}`);

// Фикстура теста: уникальные сочетания входов гейта и опубликованный кандидат.
if (flag("--write-fixture")) {
  const rows = new Map();
  for (const x of ticks) {
    const inp = inputsFromTick(x), f = inp.families, order = (obj, keys) => keys.map(k => obj[k] ?? null);
    const row = [order(f.macro, ["liquidity", "conditions", "stress"]), order(f.demand, ["etf", "stablecoins", "exchange_supply", "institutional"]), order(f.cycle, ["valuation", "network", "activity", "miners", "trend"]), inp.v1.critical_ok ? 1 : 0, anchorLow(x) ? 1 : 0, inp.v1.macro_shock_state, inp.v1.distribution_state, inp.v1.recovery_state, x.regime_meta?.strategic?.candidate ?? x.regime?.strategic];
    const key = JSON.stringify(row);
    rows.set(key, (rows.get(key) || 0) + 1);
  }
  const fixture = { note: "Уникальные сочетания входов гейта v1 из ленты опубликованных снимков окна форвард-монитора (scripts/variants-replay.mjs --write-fixture). Строка: [макро: liquidity, conditions, stress], [спрос: etf, stablecoins, exchange_supply, institutional], [цикл: valuation, network, activity, miners, trend], покрытие, якорь MVRV<25, макрошок, дистрибуция, recovery, опубликованный кандидат, число снимков.", snapshots: ticks.length, from: first.t, to: lastTick.t, rows: [...rows].map(([key, n]) => [...JSON.parse(key), n]) };
  const path = fileURLToPath(new URL("./variants-gate-fixture.json", import.meta.url));
  writeFileSync(path, JSON.stringify(fixture).replace(/\],\[\[/g, "],\n[[") + "\n");
  console.log(`   фикстура: ${fixture.rows.length} сочетаний → ${path}`);
}

// ---------- 2. Прогон линий движка ----------
const raw = loadRawSeries(AUDIT);
const cut = { exchange: vintageSlicer(raw.exchange_supply), mvrv: vintageSlicer(raw.mvrv), deep: vintageSlicer(raw.mvrv_deep), hash: vintageSlicer(raw.hashrate), diff: vintageSlicer(raw.difficulty), price: vintageSlicer(raw.price_daily) };
// Ряды «как были известны на снимке» — по отметкам наблюдения карточек; незакрытая свеча — цена снимка.
function seriesAt(x) {
  const now = Date.parse(x.t), today = Math.floor(now / DAY) * DAY, obs = id => Date.parse(x.metrics?.[id]?.[3] ?? "");
  return {
    hashrate: cut.hash(obs("network_security")), difficulty: cut.diff(now),
    exchange_supply: cut.exchange(obs("exchange_supply")), mvrv: cut.mvrv(obs("mvrv_cycle")), mvrv_deep: cut.deep(obs("mvrv_cycle")),
    price_daily: [...cut.price(today - DAY), { t: today, v: x.price }],
  };
}
const LINES = ["policy_v3_shadow", "v1_daily_close", "v1_floor_handoff", "v1_no_cftc"];
// seedNoCftc — стартовать v1_no_cftc от опубликованного отсчёта гистерезиса первого снимка (так считал аудит);
// portStates — подать состояние v1 по порту гистерезиса вместо опубликованного (без двух переворотов инцидента 21.07).
function runEngine({ seedNoCftc = false, portStates = false } = {}) {
  const books = Object.fromEntries(LINES.map(k => [k, new NavBook()])), fixes = [], nulls = Object.fromEntries(LINES.map(k => [k, 0]));
  let state = null, stateBytes = 0;
  if (seedNoCftc) { const m = first.regime_meta.strategic; state = { v: 1, nc: { state: first.regime.strategic, candidate: m.candidate, count: Math.max(0, (m.count || 1) - 1), since: m.since, downStreak: m.downStreak || 0, anchor: m.anchor ?? null } }; }
  ticks.forEach((x, i) => {
    const now = Date.parse(x.t), inputs = inputsFromTick(x, seriesAt(x));
    if (portStates) { inputs.v1.state = portState[i]; inputs.v1.target_pct = v1Target(portState[i], x); }
    const out = evaluateShadowVariantsV1({ now, inputs, state: state && JSON.parse(JSON.stringify(state)) });
    state = out.state;
    stateBytes = Math.max(stateBytes, JSON.stringify(state).length);
    for (const key of LINES) { const v = out.variants[key]; if (v.target_pct === null) nulls[key]++; books[key].step(now, x.price, v.target_pct); }
    const v3 = out.variants.policy_v3_shadow;
    if (v3.reason_codes.includes("fix") || v3.reason_codes.includes("cold_start")) fixes.push({ t: x.t, price: x.price, v1_state: x.regime.strategic, v1_candidate: x.regime_meta.strategic.candidate, v1_target: x.decision?.target ?? null, v3 });
  });
  return { books, fixes, nulls, stateBytes };
}
const cold = runEngine(), warm = runEngine({ seedNoCftc: true }), ported = runEngine({ portStates: true });

// ---------- 3. Опорные расчёты ----------
function book(targetAt) { const b = new NavBook(); ticks.forEach((x, i) => b.step(Date.parse(x.t), x.price, targetAt(x, i))); return b; }
const published = book(x => x.decision?.target ?? null), portV1 = book((x, i) => v1Target(portState[i], x));
// Суточная v1 с произвольным моментом фикса — на тех же функциях модуля. hour === "last" — последний
// снимок суток (так считал аудит); число — первый снимок суток не раньше этого часа.
function dailyReference(hour) {
  const dayOf = t => Math.floor(t / DAY), t0 = Date.parse(first.t);
  let st = { s: first.regime.strategic, p: null, n: 0 }, target = first.decision.target, fixesDone = 0;
  // Старт считается фиксом — как в движке: при часе фикса позже старта первый фикс придёт в те же сутки.
  let lastFixDay = hour === "last" ? dayOf(t0) - 1 : Math.floor((t0 - hour * HOUR) / DAY);
  const b = book((x, i) => {
    const now = Date.parse(x.t), day = dayOf(now);
    const due = i > 0 && day > lastFixDay && (hour === "last" ? i < ticks.length - 1 && dayOf(Date.parse(ticks[i + 1].t)) !== day : now - day * DAY >= hour * HOUR);
    if (due) {
      st = dailyHysteresisStepV3(st, x.regime_meta.strategic.candidate, { consecutive: day === lastFixDay + 1 });
      target = v1Target(st.s, x);
      lastFixDay = day; fixesDone++;
    }
    return target;
  });
  return { book: b, fixes: fixesDone };
}
// Тайминг: доход линии минус доход постоянной доли, равной её собственной средней доле за окно.
const timing = b => +((b.nav - book(() => b.avgShare * 100).nav) * 100).toFixed(2);
const row = (name, b, extra = "") => { const s = { ...b.summary(), timing_pp: timing(b) }; console.log(`   ${name.padEnd(62)} ${pad(s.return_pct.toFixed(2), 6)} % ${pad(s.max_drawdown_pct.toFixed(2), 6)} % ${pad(s.turnover_pct, 5)} % ${pad(s.target_changes, 4)} ${pad(s.avg_share_pct, 6)} % ${pad(s.timing_pp.toFixed(2), 7)} ${extra}`); return s; };

console.log("\n2. Линии на окне (учёт монитора: цель снимка зарабатывает до следующего, 10 б.п. на оборот, кэш 3,98 % годовых)");
console.log(`   ${"линия".padEnd(62)}  доход  макс.пр. оборот смен ср.доля тайминг, п.п.`);
const result = { window: { from: first.t, to: lastTick.t, snapshots: ticks.length, btc_return_pct: +((lastTick.price / first.price - 1) * 100).toFixed(2) }, ports: { window: portWindow, all: portAll, hysteresis }, lines: {}, references: {}, fix_hour: {} };
result.references.v1_published = row("v1 как опубликована (цель из снимков)", published);
result.references.v1_port = row("v1 по порту гистерезиса (без переворотов инцидента 21.07)", portV1);
for (const key of ["v1_daily_close", "v1_floor_handoff", "v1_no_cftc", "policy_v3_shadow"]) result.lines[key] = { ...row(`${key} — движок, холодный старт 19.07 06:30`, cold.books[key]), null_target_snapshots: cold.nulls[key], changes: cold.books[key].log };
result.lines.v1_floor_handoff_port_state = { ...row("v1_floor_handoff — на состоянии v1 по порту (как у аудита)", ported.books.v1_floor_handoff), changes: ported.books.v1_floor_handoff.log };
result.lines.v1_no_cftc_warm = { ...row("v1_no_cftc — старт от опубликованного отсчёта (как у аудита)", warm.books.v1_no_cftc), changes: warm.books.v1_no_cftc.log };
for (const share of [100, 50, 45]) result.references[`constant_${share}`] = row(`постоянные ${share} %`, book(() => share));
console.log(`   состояние движка: до ${cold.stateBytes} байт JSON; снимков с целью null: ${JSON.stringify(cold.nulls)}`);
result.state_bytes_max = cold.stateBytes;

console.log("\n3. Суточная v1: чувствительность к часу фикса (те же сигналы, тот же гистерезис в фиксах)");
const refs = {};
for (const hour of ["last", 0, 3, 6, 9, 12, 15, 18, 21]) {
  refs[hour] = dailyReference(hour);
  result.fix_hour[String(hour)] = { ...row(hour === "last" ? "фикс — последний снимок суток (версия аудита)" : `фикс — первый снимок не раньше ${String(hour).padStart(2, "0")}:00 UTC`, refs[hour].book, `фиксов ${refs[hour].fixes}`), fixes: refs[hour].fixes, changes: refs[hour].book.log };
}
const engineDaily = cold.books.v1_daily_close.summary(), refDaily = result.fix_hour["6"];
result.daily_engine_equals_reference = engineDaily.nav === refDaily.nav;
console.log(`   сверка: движок v1_daily_close ${engineDaily.return_pct} % против опорного расчёта на 06:00 ${refDaily.return_pct} % — ${result.daily_engine_equals_reference ? "совпадают" : "РАСХОДЯТСЯ"}`);
const returns = Object.values(result.fix_hour).map(x => x.return_pct);
console.log(`   размах по часу фикса: от ${Math.min(...returns)} до ${Math.max(...returns)} %`);
const printSegments = (title, a, b, nameA, nameB) => {
  const d = divergenceSegments(ticks, a, b);
  console.log(`   ${title}: всего ${d.total_pp >= 0 ? "+" : ""}${d.total_pp} п.п.`);
  for (const s of d.segments) console.log(`      ${s.from.slice(5, 16)} → ${s.to.slice(5, 16)}  ${nameA} ${pad(s.a, 3)} % / ${nameB} ${pad(s.b, 3)} %  BTC ${s.price_from} → ${s.price_to} (${s.btc_pct >= 0 ? "+" : ""}${s.btc_pct} %)  вклад ${s.pp >= 0 ? "+" : ""}${s.pp} п.п.`);
  return d;
};
result.attribution = {};
result.attribution.last_vs_0600 = printSegments("почему 06:00 даёт меньше последнего снимка суток (вклад доли × ход BTC, отрезки от 0,15 п.п.)", refs.last.book, refs[6].book, "посл.", "06:00");

console.log("\n4. Смены цели");
console.log("   v1 опубликована:    " + changeLine(published.log));
console.log("   v1_daily_close:     " + changeLine(cold.books.v1_daily_close.log));
console.log("   последний снимок:   " + changeLine(result.fix_hour.last.changes));
console.log("   v1_floor_handoff:   " + changeLine(cold.books.v1_floor_handoff.log));
console.log("   v1_no_cftc:         " + changeLine(cold.books.v1_no_cftc.log));
console.log("   v1_no_cftc (тёпл.): " + changeLine(warm.books.v1_no_cftc.log));
console.log("   policy_v3_shadow:   " + changeLine(cold.books.policy_v3_shadow.log));

// ---------- 4. Что делала бы policy_v3_shadow ----------
const fixes = cold.fixes, real = fixes.filter(f => f.v3.reason_codes.includes("fix"));
const count = (list, fn) => list.reduce((m, f) => { const k = fn(f); m[k] = (m[k] || 0) + 1; return m; }, {});
const differs = name => real.filter(f => { const r = f.v3.inputs?.families?.[name]; return r && r.v3 !== r.v1; }).length;
const v3Summary = {
  fixes: real.length, days_in_window: new Set(ticks.map(x => x.t.slice(0, 10))).size,
  states: count(real, f => f.v3.state), candidates: count(real, f => f.v3.candidate), targets: count(real, f => String(f.v3.target_pct)),
  candidate_differs_from_v1_at_fix: real.filter(f => f.v3.candidate !== f.v1_candidate).length,
  target_differs_from_v1_at_fix: real.filter(f => f.v3.target_pct !== f.v1_target).length,
  family_differs_from_v1: { network: differs("network"), exchange_supply: differs("exchange_supply"), valuation: differs("valuation"), trend: differs("trend") },
  deep_window_used: count(real, f => String(f.v3.inputs?.deep_window_used)),
  recovery: count(real, f => f.v3.inputs?.recovery?.state), floor_fixes: real.filter(f => f.v3.floor.active).length,
  floor_binding_fixes: real.filter(f => f.v3.binding_overlays.includes("recovery_floor")).length,
  inputs_same_age_fixes: real.filter(f => { const o = f.v3.inputs?.observed; return o && o.closed_day === o.mvrv && o.mvrv === o.exchange_supply; }).length,
  notes: count(real.flatMap(f => f.v3.inputs?.notes || []).map(n => ({ n })), x => x.n),
};
result.policy_v3_shadow = { ...v3Summary, fixes_log: fixes.map(f => ({ t: f.t, price: Math.round(f.price), v1: [f.v1_state, f.v1_candidate, f.v1_target], state: f.v3.state, candidate: f.v3.candidate, target: f.v3.target_pct, floor: f.v3.floor.closes, blocks: f.v3.inputs?.blocks ?? null, families: f.v3.inputs ? Object.fromEntries(Object.entries(f.v3.inputs.families).map(([k, r]) => [k, [r.v3, r.v1]])) : null, mvrv: f.v3.inputs ? [f.v3.inputs.mvrv_percentile, f.v3.inputs.mvrv_percentile_deep] : null, recovery: f.v3.inputs?.recovery ?? null, observed: f.v3.inputs?.observed ?? null, codes: f.v3.reason_codes })) };
console.log("\n5. policy_v3_shadow на окне");
console.log("   " + JSON.stringify(v3Summary));
result.attribution.v3_vs_v1 = printSegments("policy_v3_shadow против v1 как опубликована (вклад доли × ход BTC, отрезки от 0,15 п.п.)", cold.books.policy_v3_shadow, published, "v3", "v1");
result.attribution.v3_vs_daily = printSegments("policy_v3_shadow против v1_daily_close — вклад изменений счёта и пола поверх суточного такта", cold.books.policy_v3_shadow, cold.books.v1_daily_close, "v3", "сут.");
// Критерий приёмки min_target_changes_vs_v1: эпизоды расхождения по дневным строкам (определение контракта)
// против числа смен разности целей на снимках — оно считает и задержку суточного фикса в несколько часов.
{
  const dailyRows = new Map();
  ticks.forEach((x, i) => dailyRows.set(x.t.slice(0, 10), { targets: Object.fromEntries([...LINES.map(k => [k, Math.round(cold.books[k].weights[i] * 100)]), ["policy_v1", Math.round(published.weights[i] * 100)]]) }));
  result.divergence_vs_v1 = {};
  console.log("   расхождение с v1 за окно: эпизодов по дневным строкам / дней расхождения / смен разности целей на снимках");
  for (const key of LINES) {
    const episodes = countTargetDivergenceEpisodesV3([...dailyRows.values()], { candidate: key });
    let gap = null, gapChanges = 0;
    ticks.forEach((x, i) => { const g = Math.round((cold.books[key].weights[i] - published.weights[i]) * 100); if (gap !== null && g !== gap) gapChanges++; gap = g; });
    result.divergence_vs_v1[key] = { ...episodes, gap_changes_on_snapshots: gapChanges };
    console.log(`      ${key.padEnd(18)} ${pad(episodes.episodes, 3)} / ${pad(episodes.days, 3)} / ${pad(gapChanges, 3)}`);
  }
}
if (flag("--fixes")) {
  console.log("   фикс              цена  v1 сост/канд/цель      v3 канд → сост  цель пол | M / D / C            | сеть б.п. оц. тренд (v3|v1) | MVRV 4г/глуб | recovery");
  const short = s => ({ defensive: "DEF", deteriorating: "DET", transition: "TRA", unconfirmed_positive: "UNC", constructive: "CON" }[s] || String(s));
  for (const f of fixes) {
    const i = f.v3.inputs, fam = k => i ? `${i.families[k].v3 ?? "—"}|${i.families[k].v1 ?? "—"}` : "—";
    console.log(`   ${f.t.slice(0, 16)} ${pad(Math.round(f.price), 6)}  ${short(f.v1_state)}/${short(f.v1_candidate)}/${pad(f.v1_target, 4)}   ${short(f.v3.candidate)} → ${short(f.v3.state)} ${pad(f.v3.target_pct, 4)} ${pad(f.v3.floor.closes, 2)}  | ${i ? [i.blocks.macro, i.blocks.demand, i.blocks.cycle].map(v => pad(v, 6)).join(" ") : "—".padEnd(20)} | ${[fam("network"), fam("exchange_supply"), fam("valuation"), fam("trend")].map(s => s.padEnd(10)).join("")}| ${i ? `${pad(i.mvrv_percentile, 5)}/${pad(i.mvrv_percentile_deep, 5)}` : "—"} | ${i ? `${i.recovery.state} ${i.recovery.supports}/3${i.recovery.anchor ? " якорь" : ""}` : "—"}${f.v3.reason_codes.includes("cold_start") ? " (холодный старт)" : ""}`);
  }
}

const out = arg("--out");
if (out) { writeFileSync(out, JSON.stringify(result, null, 1)); console.log(`\nJSON: ${out}`); }
