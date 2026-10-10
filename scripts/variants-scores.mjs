// Счёт изменённых семей кандидата v3 на сырье первоисточников от 10.10.2026 рядом со счётом v1:
// хешрейт по 30-дневным средним против точечного, нога потоков бирж по остатку против суммы потоков,
// оба перцентиля MVRV, тренд по закрытому дню. Запуск: node scripts/variants-scores.mjs [--audit <dir>]
//   [--now <ISO>] [--out <json>]. В `npm run check` не входит: сырьё лежит вне репозитория.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { componentScore, percentileRank, priorByDays } from "./fetch-snapshot.mjs";
import { evaluateV3Inputs, lowGoodV1Port, mvrvDeepPercentileV3, scoreExchangeSupplyV3, scoreNetworkV3, scoreTrendV3, scoreValuationV3 } from "../docs/policy-v3-candidate.mjs";
import { DAY, arg, auditDir, inputsFromTick, loadRawSeries, readTicks } from "./variants-lib.mjs";

const AUDIT = auditDir(), raw = loadRawSeries(AUDIT);
// Момент выгрузки сырья аудитом: 10.10.2026 10:10 UTC.
const now = Date.parse(arg("--now", "2026-10-10T10:10:00.000Z"));
const pct = (a, b) => (a / b - 1) * 100, last = a => a[a.length - 1], f = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d)), day = t => new Date(t).toISOString().slice(0, 10);
const result = { now: new Date(now).toISOString() };

// --- сеть ---
const hash = raw.hashrate.filter(p => p.t <= now), diff = raw.difficulty.filter(p => p.t <= now);
const pointBase = priorByDays(hash, 90), pointChange = pct(last(hash).v, pointBase.v);
const network = scoreNetworkV3({ hashrate: hash, difficulty: diff, now });
const v1Leg = v => (v > -5 ? 0 : v > -15 ? -1 : -2);
result.network = {
  hashrate_last: { day: day(last(hash).t), eh: +(last(hash).v / 1e18).toFixed(1) }, hashrate_90d_ago: { day: day(pointBase.t), eh: +(pointBase.v / 1e18).toFixed(1) },
  v1_point_change_pct: +pointChange.toFixed(2), v3_mean30_change_pct: +network.hashrate_change_pct.toFixed(2), difficulty_change_pct: +network.difficulty_change_pct.toFixed(2),
  v1_score: componentScore([v1Leg(pointChange), v1Leg(network.difficulty_change_pct)]), v3_score: network.score,
};
// Размах за последние 90 дней: насколько гуляет точечное изменение и насколько — сглаженное.
{
  const point = [], smooth = [];
  for (let i = hash.length - 90; i < hash.length; i++) {
    const part = hash.slice(0, i + 1), base = priorByDays(part, 90);
    if (base) point.push(pct(last(part).v, base.v));
    const s = scoreNetworkV3({ hashrate: part, difficulty: [], now: last(part).t + 6 * 3_600_000 }).hashrate_change_pct;
    if (s !== null) smooth.push(s);
  }
  const range = a => [+Math.min(...a).toFixed(1), +Math.max(...a).toFixed(1)], flips = a => a.slice(1).filter((v, i) => v1Leg(v) !== v1Leg(a[i])).length;
  result.network.last_90_days = { point_range_pct: range(point), mean30_range_pct: range(smooth), point_leg_changes: flips(point), mean30_leg_changes: flips(smooth) };
}
console.log("Сеть");
console.log(`   хешрейт: ${result.network.hashrate_last.eh} EH/s (${result.network.hashrate_last.day}) против ${result.network.hashrate_90d_ago.eh} EH/s (${result.network.hashrate_90d_ago.day})`);
console.log(`   v1, точка к точке за 90 дней:        ${f(pointChange)} %`);
console.log(`   v3, 30-дневные средние за 90 дней:   ${f(network.hashrate_change_pct)} %`);
console.log(`   сложность за 90 дней (как в v1):     ${f(network.difficulty_change_pct)} %`);
console.log(`   балл семьи: v1 ${result.network.v1_score}, v3 ${network.score}`);
console.log(`   за последние 90 дней: точечное изменение ${result.network.last_90_days.point_range_pct.join(" … ")} %, смен ступени ${result.network.last_90_days.point_leg_changes}; по средним ${result.network.last_90_days.mean30_range_pct.join(" … ")} %, смен ступени ${result.network.last_90_days.mean30_leg_changes}`);

// --- биржевое предложение ---
const reserve = raw.exchange_supply.filter(p => p.t <= now), outByDay = new Map(raw.flow_out.map(p => [p.t, p.v]));
const netflow = raw.flow_in.filter(p => p.t <= now && outByDay.has(p.t)).map(p => ({ t: p.t, v: p.v - outByDay.get(p.t) }));
const sums7 = netflow.map((p, i) => (i >= 6 ? { t: p.t, v: netflow.slice(i - 6, i + 1).reduce((s, x) => s + x.v, 0) } : null)).filter(Boolean);
const flow7 = last(sums7).v, flowPct = percentileRank(sums7.slice(-1460).map(x => x.v), flow7), v1FlowLeg = flow7 > 0 ? Math.min(lowGoodV1Port(flowPct), 0) : lowGoodV1Port(flowPct);
const exchange = scoreExchangeSupplyV3({ reserve, now });
const gap = days => { const cutoff = last(reserve).t - days * DAY; return { flows: Math.round(netflow.filter(p => p.t > cutoff).reduce((s, p) => s + p.v, 0)), reserve: Math.round(last(reserve).v - reserve.filter(p => p.t <= cutoff).at(-1).v) }; };
result.exchange_supply = {
  observed: day(last(reserve).t),
  v1: { flow_7d_btc: Math.round(flow7), flow_percentile: +flowPct.toFixed(2), flow_leg: v1FlowLeg, reserve_leg: exchange.reserve_leg, score: componentScore([v1FlowLeg, exchange.reserve_leg]) },
  v3: { change_7d_btc: Math.round(exchange.flow_change_btc), change_percentile: +exchange.flow_percentile.toFixed(2), flow_leg: exchange.flow_leg, reserve_change_pct: +exchange.reserve_change_pct.toFixed(3), reserve_percentile: +exchange.reserve_percentile.toFixed(2), reserve_leg: exchange.reserve_leg, score: exchange.score },
  flows_vs_reserve: { d30: gap(30), d90: gap(90) },
};
console.log("\nБиржевое предложение (наблюдение " + result.exchange_supply.observed + ")");
console.log(`   v1, сумма потоков за 7 дней:    ${Math.round(flow7)} BTC, перцентиль ${f(flowPct)} → нога ${v1FlowLeg}`);
console.log(`   v3, изменение остатка за 7 дней: ${Math.round(exchange.flow_change_btc)} BTC, перцентиль ${f(exchange.flow_percentile)} → нога ${exchange.flow_leg}`);
console.log(`   остаток за 90 дней (как в v1):   ${f(exchange.reserve_change_pct, 3)} %, перцентиль ${f(exchange.reserve_percentile)} → нога ${exchange.reserve_leg}`);
console.log(`   балл семьи: v1 ${result.exchange_supply.v1.score}, v3 ${exchange.score}`);
console.log(`   потоки против остатка: 30 дней ${result.exchange_supply.flows_vs_reserve.d30.flows} против ${result.exchange_supply.flows_vs_reserve.d30.reserve} BTC; 90 дней ${result.exchange_supply.flows_vs_reserve.d90.flows} против ${result.exchange_supply.flows_vs_reserve.d90.reserve} BTC`);

// --- оценка ---
const mvrv = raw.mvrv.filter(p => p.t <= now), deepSeries = raw.mvrv_deep.filter(p => p.t <= now);
const window4y = mvrv.filter(p => p.t >= last(mvrv).t - 4 * 365 * DAY), p4 = percentileRank(window4y.map(p => p.v), last(mvrv).v);
const deep = mvrvDeepPercentileV3({ mvrvDeep: deepSeries, now }), valuation = scoreValuationV3({ percentile: p4, percentileDeep: deep.percentile });
const quantile = (values, q) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]; };
result.valuation = {
  mvrv: +last(mvrv).v.toFixed(4), observed: day(last(mvrv).t), percentile_4y: +p4.toFixed(4), points_4y: window4y.length, percentile_deep: +deep.percentile.toFixed(4), points_deep: deep.points, deep_from: day(deepSeries[0].t), deep_window_used: deep.used,
  thresholds_mvrv: { p10: { y4: +quantile(window4y.map(p => p.v), 0.10).toFixed(3), deep: +quantile(deepSeries.map(p => p.v), 0.10).toFixed(3) }, p25: { y4: +quantile(window4y.map(p => p.v), 0.25).toFixed(3), deep: +quantile(deepSeries.map(p => p.v), 0.25).toFixed(3) } },
  v3: valuation,
};
console.log(`\nОценка (MVRV ${f(last(mvrv).v, 4)} за ${result.valuation.observed})`);
console.log(`   перцентиль 4 лет: ${f(p4, 2)} (${window4y.length} точек); по всей истории с ${result.valuation.deep_from}: ${f(deep.percentile, 2)} (${deep.points} точек), окно ${deep.used ? "годно" : "не годно: " + deep.reason}`);
console.log(`   10-й перцентиль: MVRV ${result.valuation.thresholds_mvrv.p10.y4} за 4 года и ${result.valuation.thresholds_mvrv.p10.deep} по всей истории; 25-й: ${result.valuation.thresholds_mvrv.p25.y4} и ${result.valuation.thresholds_mvrv.p25.deep}`);
console.log(`   балл оценки v3 ${valuation.score}; «дёшево» ${valuation.cheap}; якорь recovery ${valuation.anchor}`);

// --- тренд ---
const today = Math.floor(now / DAY) * DAY, closedOnly = raw.price_daily.filter(p => p.t < today), liveCandle = raw.price_daily.find(p => p.t === today);
const trend = scoreTrendV3({ priceDaily: raw.price_daily, now });
result.trend = { closed_day: day(trend.closed_at), close: trend.close, ma_200d: +trend.ma_200d.toFixed(2), ma_20w: +trend.ma_20w.toFixed(2), ma_200w: +trend.ma_200w.toFixed(2), score: trend.score, unclosed_candle: liveCandle?.v ?? null, same_without_unclosed: scoreTrendV3({ priceDaily: closedOnly, now }).score === trend.score };
console.log(`\nТренд по закрытому дню ${result.trend.closed_day}: закрытие ${f(trend.close)}, 200D ${f(trend.ma_200d)}, 20W ${f(trend.ma_20w)}, 200W ${f(trend.ma_200w)} → балл ${trend.score}; незакрытая свеча ${f(liveCandle?.v)} в счёт не входит`);

// --- кандидат целиком на последнем снимке ленты ---
const ticks = await readTicks(join(AUDIT, "work", "ticks.jsonl")), tick = ticks.filter(x => Date.parse(x.t) <= now).at(-1);
const full = evaluateV3Inputs({ now, inputs: inputsFromTick(tick, { hashrate: hash, difficulty: diff, exchange_supply: reserve, mvrv, mvrv_deep: deepSeries, price_daily: raw.price_daily }) });
result.candidate = { v1_snapshot: tick.t, v1: { candidate: tick.regime_meta.strategic.candidate, state: tick.regime.strategic, target_pct: tick.decision.target, blocks: { macro: tick.blocks.macro.s, demand: tick.blocks.demand.s, cycle: tick.blocks.cycle.s } }, v3: { candidate: full.candidate, record: full.record } };
console.log(`\nКандидат v3 на входах снимка ${tick.t.slice(0, 16)}: ${full.candidate}; блоки M ${f(full.blocks.macro)} / D ${f(full.blocks.demand)} / C ${f(full.blocks.cycle)} (v1: ${tick.regime_meta.strategic.candidate}; ${f(tick.blocks.macro.s)} / ${f(tick.blocks.demand.s)} / ${f(tick.blocks.cycle.s)})`);
console.log(`   recovery ${full.recovery.state} (якорь ${full.recovery.anchor}, подтверждений ${full.recovery.supports}/3), макрошок ${full.macro_shock_state}, пометки: ${full.notes.join(", ") || "нет"}`);

const out = arg("--out");
if (out) { writeFileSync(out, JSON.stringify(result, null, 1)); console.log(`\nJSON: ${out}`); }
