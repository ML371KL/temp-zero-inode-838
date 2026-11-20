// Тесты теневых трендовых линий монитора (scripts/monitor-trend-lines-v1.mjs).
// Запускаются из `npm run check` и отдельно: node scripts/monitor-trend-lines-test.mjs.
// Сети нет, системные часы не читаются: все моменты времени передаются явно.
import assert from "node:assert/strict";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { buildDecisionRecordV1, buildSourceVintagesV1, updateForwardMonitorV1, verifyDecisionLogChainV1 } from "./forward-monitor-v1.mjs";
import { STRATEGY_REGISTRY_V1 } from "./monitor-backfill-v1.mjs";
import { TREND_LINES_V1, TREND_LINE_NAMES_V1, blockScoreV1, demandBrakeV1, evaluateTrendLinesV1, trendLinesPublicV1, trendShareV1, trendTargetsV1 } from "./monitor-trend-lines-v1.mjs";

const DAY=86_400_000,HOUR=3_600_000,MIN=60_000;
const iso=t=>new Date(t).toISOString();
const near=(a,b,eps=1e-9)=>Math.abs(a-b)<=eps;
// Полночь UTC; MONITOR_TEST_DAY_SHIFT сдвигает набор на другой день недели, как в соседних тестах.
const D0=Date.parse("2027-03-01T00:00:00.000Z")+(Number(process.env.MONITOR_TEST_DAY_SHIFT)||0)*DAY;
const at=(day,hour=0,minute=0)=>D0+day*DAY+hour*HOUR+minute*MIN;

// Дневные закрытия: `days` закрытых суток до суток `day` (не включая их), значение — функция от
// номера с конца (0 — вчера). Метка свечи — начало её суток.
const candles=(day,days,valueOf)=>Array.from({length:days},(_,k)=>({t:at(day)-(days-k)*DAY,v:valueOf(days-1-k)}));
const flat=(day,days=260,v=100)=>candles(day,days,()=>v);
// Ряд, у которого последнее закрытие стоит выше ровно `above` средних из трёх: длинная полка 100,
// затем ступень. Средние 50/100/200 считаются от конца.
function closesAbove(above){
  // 200 точек: старые 100 по 300, затем 50 по 200, затем 50 по 100; последнее закрытие подбирается.
  const base=[...Array(100).fill(300),...Array(50).fill(200),...Array(49).fill(100)];
  const ma=(arr,n)=>arr.slice(-n).reduce((s,x)=>s+x,0)/n;
  const candidates={0:50,1:104,2:160,3:400};
  const closes=[...base,candidates[above]];
  const got=[50,100,200].filter(n=>closes.at(-1)>=ma(closes,n)).length;
  assert.equal(got,above,`фикстура: закрытие выше ${above} средних, получилось ${got}`);
  return closes;
}
const families=({etf=0,stablecoins=0,exchange_supply=0,institutional=0,liquidity=0,conditions=0,stress=0}={})=>({macro:{liquidity,conditions,stress},demand:{etf,stablecoins,exchange_supply,institutional},cycle:{trend:0}});
const inputsOf=(day,closes,fam=families())=>({series:{price_daily:closes.map((v,k)=>({t:at(day)-(closes.length-k)*DAY,v}))},families:fam,v1:{critical_ok:true}});

// ================= 1. Объявление =================
{
  assert.deepEqual(TREND_LINE_NAMES_V1,["trend_ma3","trend_demand_b1"]);
  assert.deepEqual(TREND_LINES_V1.moving_averages_days,[50,100,200]);
  assert.equal(TREND_LINES_V1.demand_brake.floor_at_score,MODEL_POLICY_V1.regime_bands.adverse_max,"граница тормоза — неблагоприятная полоса панели");
  assert.deepEqual(TREND_LINES_V1.demand_brake.families,["etf","stablecoins","exchange_supply"],"CFTC в тормоз не входит");
  assert.ok(Object.isFrozen(TREND_LINES_V1)&&Object.isFrozen(TREND_LINES_V1.demand_brake)&&Object.isFrozen(TREND_LINES_V1.lines.trend_ma3),"объявление заморожено");
  assert.equal(STRATEGY_REGISTRY_V1.trend_ma3.kind,"benchmark");assert.equal(STRATEGY_REGISTRY_V1.trend_demand_b1.kind,"candidate");
}

// ================= 2. Правило =================
{
  for(const above of [0,1,2,3])assert.ok(near(trendShareV1(closesAbove(above)).share,above/3),`доля тренда при ${above} средних`);
  assert.equal(trendShareV1(Array(199).fill(100)),null,"короче 200 закрытых дней — тренда нет");
  assert.equal(trendShareV1(Array(200).fill(100)).share,1,"закрытие, равное средней, считается не ниже её");
  // Тормоз спроса.
  assert.deepEqual([0,30,-20,-50,-10,-5].map(demandBrakeV1),[1,1,0.5,0.5,0.75,0.875]);
  assert.equal(demandBrakeV1(null),1,"нет балла спроса — тормоза нет");
  // Балл блока: среднее имеющихся семей по шкале панели.
  assert.equal(blockScoreV1({etf:-2,stablecoins:-2,exchange_supply:0.5},["etf","stablecoins","exchange_supply"]),(-3.5/3)/2*100);
  assert.equal(blockScoreV1({etf:null,stablecoins:-1,exchange_supply:0},["etf","stablecoins","exchange_supply"]),-25,"семья без балла в среднее не входит");
  assert.equal(blockScoreV1({},["etf"]),null);
  const full=closesAbove(3);
  // Спрос в норме: кандидат равен ориентиру.
  let t=trendTargetsV1({closes:full,families:families()});
  assert.deepEqual([t.trend_ma3.target_pct,t.trend_demand_b1.target_pct,t.trend_demand_b1.brake,t.trend_demand_b1.double_adverse],[100,100,1,false]);
  // Спрос против (−2, −2, +0,5 → −58,33): тормоз 0,5.
  t=trendTargetsV1({closes:full,families:families({etf:-2,stablecoins:-2,exchange_supply:0.5})});
  assert.deepEqual([t.trend_ma3.target_pct,t.trend_demand_b1.target_pct,t.trend_demand_b1.demand_block],[100,50,-58.33]);
  // CFTC голосует в блоке панели, но в тормоз не входит: его −2 цель не меняет.
  assert.equal(trendTargetsV1({closes:full,families:families({institutional:-2})}).trend_demand_b1.target_pct,100);
  // Оба блока против: ещё × 0,25. Макро ровно на границе −25 ≤ −20.
  t=trendTargetsV1({closes:full,families:families({etf:-2,stablecoins:-2,exchange_supply:0.5,liquidity:0.5,conditions:-1,stress:-1})});
  assert.deepEqual([t.trend_demand_b1.macro_block,t.trend_demand_b1.double_adverse,t.trend_demand_b1.target_pct],[-25,true,12.5]);
  // Макро против, спрос нет — множителя нет.
  assert.equal(trendTargetsV1({closes:full,families:families({liquidity:-2,conditions:-2,stress:-2})}).trend_demand_b1.target_pct,100);
  // Частичный тренд и частичный тормоз: ⅔ × 0,75.
  t=trendTargetsV1({closes:closesAbove(2),families:families({etf:-1,stablecoins:0,exchange_supply:0.4})});
  assert.ok(near(t.trend_demand_b1.demand_block,-10)&&near(t.trend_demand_b1.target_pct,50),`⅔ × 0,75 = 50: ${JSON.stringify(t.trend_demand_b1)}`);
  assert.equal(t.trend_ma3.target_pct,66.67);
  // Тренда нет — обе линии в кэше, что бы ни говорил спрос.
  t=trendTargetsV1({closes:closesAbove(0),families:families({etf:2,stablecoins:2,exchange_supply:2})});
  assert.deepEqual([t.trend_ma3.target_pct,t.trend_demand_b1.target_pct],[0,0]);
  // Нет баллов семей вовсе — кандидат вырождается в ориентир.
  assert.equal(trendTargetsV1({closes:full,families:null}).trend_demand_b1.target_pct,100);
}

// ================= 3. Часы: один фикс в сутки, не раньше 06:00 UTC, по закрытым свечам =================
{
  const up=closesAbove(3),down=closesAbove(0);
  // Холодный старт до 06:00: цель есть сразу, день фикса — вчерашний.
  const cold=evaluateTrendLinesV1({now:at(0,0,30),inputs:inputsOf(0,up),state:null});
  assert.deepEqual([cold.fixed,cold.note,cold.targets],[true,"cold_start",{trend_ma3:100,trend_demand_b1:100}]);
  assert.equal(cold.state.d,Math.floor(at(0)/DAY)-1);assert.equal(cold.state.fix_at,iso(at(0,0,30)));
  // До 06:00 тех же суток новый фикс не делается, даже если входы изменились.
  const early=evaluateTrendLinesV1({now:at(0,5,59),inputs:inputsOf(0,down),state:cold.state});
  assert.deepEqual([early.fixed,early.note,early.targets,early.state],[false,"between_fixes",cold.targets,cold.state]);
  // Первый прогон не раньше 06:00 — фикс.
  const fix=evaluateTrendLinesV1({now:at(0,6,0),inputs:inputsOf(0,down),state:cold.state});
  assert.deepEqual([fix.fixed,fix.note,fix.targets],[true,"fix",{trend_ma3:0,trend_demand_b1:0}]);
  assert.equal(fix.state.d,Math.floor(at(0)/DAY));
  // Остаток суток и ночь до следующих 06:00 — держим.
  for(const now of [at(0,6,15),at(0,23,59),at(1,5,45)])assert.equal(evaluateTrendLinesV1({now,inputs:inputsOf(now===at(1,5,45)?1:0,up),state:fix.state}).fixed,false);
  // Следующие сутки: вчерашней свечи ещё нет — фикс не состоялся, день не потрачен.
  const stale=evaluateTrendLinesV1({now:at(1,6,0),inputs:inputsOf(0,up),state:fix.state});
  assert.deepEqual([stale.fixed,stale.note,stale.state],[false,"closed_day_not_ready",fix.state]);
  // Свеча пришла позже в те же сутки — фикс на этом прогоне.
  const late=evaluateTrendLinesV1({now:at(1,7,15),inputs:inputsOf(1,up),state:stale.state});
  assert.deepEqual([late.fixed,late.targets.trend_ma3,late.state.fix_at],[true,100,iso(at(1,7,15))]);
  // Незакрытая свеча текущих суток в расчёт не входит, каким бы ни было её значение.
  const withOpen=inputsOf(2,up);withOpen.series.price_daily.push({t:at(2),v:1});
  const openRun=evaluateTrendLinesV1({now:at(2,6,0),inputs:withOpen,state:late.state});
  assert.deepEqual([openRun.fixed,openRun.targets.trend_ma3,openRun.state.lines.trend_ma3.close],[true,100,400],"фикс состоялся по вчерашнему закрытию; свеча текущих суток не читается");
  // Короткая история, нет входов — прежние цели, день не потрачен.
  assert.deepEqual([evaluateTrendLinesV1({now:at(2,6,0),inputs:inputsOf(2,up.slice(-150)),state:late.state}).note,evaluateTrendLinesV1({now:at(2,6,0),inputs:null,state:late.state}).note],["price_history_short","no_inputs"]);
  // Без состояния и без возможности посчитать целей нет: линия не рождается.
  assert.deepEqual(evaluateTrendLinesV1({now:at(2,6,0),inputs:null,state:null}).targets,{trend_ma3:null,trend_demand_b1:null});
  // Испорченное состояние (чужая версия, цель вне 0…100, день из будущего) не принимается: холодный старт.
  for(const bad of [{...late.state,v:2},{...late.state,d:Math.floor(at(9)/DAY)},{...late.state,lines:{...late.state.lines,trend_ma3:{target_pct:140}}},"строка",{v:1}])
    assert.equal(evaluateTrendLinesV1({now:at(2,6,0),inputs:inputsOf(2,down),state:bad}).note,"cold_start");
  // Чистота: прежнее состояние и входы не изменяются.
  const frozenState=structuredClone(late.state),frozenInputs=inputsOf(2,down),copy=structuredClone(frozenInputs);
  evaluateTrendLinesV1({now:at(2,6,0),inputs:frozenInputs,state:late.state});
  assert.deepEqual([late.state,frozenInputs],[frozenState,copy]);
  assert.throws(()=>evaluateTrendLinesV1({now:"не время",inputs:null,state:null}),/bad time/);
  // Дубли и пропуски в ряду: берётся последнее значение суток; разрыв до вчера — ряд не годен.
  const dup=inputsOf(3,up);dup.series.price_daily.push({...dup.series.price_daily.at(-1),v:dup.series.price_daily.at(-1).v});
  assert.equal(evaluateTrendLinesV1({now:at(3,6,0),inputs:dup,state:null}).fixed,true);
}

// ================= 4. В мониторе =================
const vintagesAt=t=>{const v=buildSourceVintagesV1({market:{source:"fixture",observed_at:iso(t),fetched_at:iso(t),data:[{t:1,v:100}]}},{market:{state:"ok",source:"fixture",observed_at:iso(t),fetched_at:iso(t)}});v.captured_at=iso(t);return v;};
const VINTAGES=vintagesAt(D0);
const BLOCKS={macro:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},demand:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},cycle:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},leverage:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}},market:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}}};
function mkDecision(t,{strategic="transition",tactical="balanced",coverage=true}={}){
  const metrics=[{id:"mvrv_cycle",vote:true,score:0,value_num:50,observed_at:iso(t),source:"fixture"}];
  return buildDecisionRecordV1({generatedAt:iso(t),regime:{strategic,tactical},regimeMeta:{},metrics,blocks:BLOCKS,detectors:[{id:"recovery",state:"calm"},{id:"macro_shock",state:"calm"}],scores:{strategic:0,tactical:0,critical_coverage_ok:coverage},sourceVintages:VINTAGES,revisionAlerts:[]});
}
function tick(monitor,t,price,{decision={},...extra}={}){
  const built=mkDecision(t,decision);
  return updateForwardMonitorV1({previousMonitor:monitor,now:t,price,decision:built.decision,inputSummary:built.inputSummary,sourceVintages:VINTAGES,cashQuotePct:4,priceSeries:[],...extra});
}
{
  const up=closesAbove(3),weak=families({etf:-2,stablecoins:-2,exchange_supply:0.5});
  // Рождение: линии появляются на первом прогоне с входами, с NAV за вычетом входа и записью старта.
  let m=tick(null,at(0,0,30),60_000,{variantInputs:inputsOf(0,up,weak)});
  assert.deepEqual(TREND_LINE_NAMES_V1.map(n=>m.strategies[n].current_target_pct),[100,50]);
  assert.ok(near(m.strategies.trend_ma3.nav,1-0.001)&&near(m.strategies.trend_demand_b1.nav,1-0.0005),"вход оплачен со своей доли");
  for(const name of TREND_LINE_NAMES_V1){
    assert.deepEqual([m.strategy_meta[name].kind,m.strategy_meta[name].label,m.strategy_meta[name].started_at],[STRATEGY_REGISTRY_V1[name].kind,STRATEGY_REGISTRY_V1[name].label,iso(at(0,0,30))]);
    assert.equal(m.daily.at(-1).targets[name],m.strategies[name].current_target_pct);assert.ok(Number.isFinite(m.daily.at(-1).nav[name]));
    assert.ok(m.performance[name],"линия попадает в таблицу результатов");
  }
  assert.deepEqual([m.trend_lines.id,m.trend_lines.status,m.trend_lines.fix_at,m.trend_lines.lines.trend_demand_b1.target_pct],["btc-trend-lines-v1","shadow",iso(at(0,0,30)),50]);
  assert.ok(JSON.stringify(m.trend_lines).length<1500&&JSON.stringify(m.trend_lines_state).length<800,"блок и состояние линий малы");
  // Между фиксами цель держится; доходность считается с прежней долей.
  const before=structuredClone(m.strategies);
  m=tick(m,at(0,3),66_000,{variantInputs:inputsOf(0,closesAbove(0))});
  assert.deepEqual(TREND_LINE_NAMES_V1.map(n=>[m.strategies[n].current_target_pct,m.strategies[n].turnover_pct]),[[100,100],[50,50]]);
  const cash=m.strategies.cash.nav/before.cash.nav-1;
  assert.ok(near(m.strategies.trend_ma3.nav/before.trend_ma3.nav,1.1,1e-12)&&near(m.strategies.trend_demand_b1.nav/before.trend_demand_b1.nav,1+0.5*0.1+0.5*cash,1e-12),"+10 % BTC: ориентир со 100 %, кандидат с 50 %");
  // Фикс в 06:00: тренд пропал — обе линии выходят в кэш, оборот и издержки записаны.
  m=tick(m,at(0,6),66_000,{variantInputs:inputsOf(0,closesAbove(0))});
  assert.deepEqual(TREND_LINE_NAMES_V1.map(n=>[m.strategies[n].current_target_pct,m.strategies[n].turnover_pct]),[[0,200],[0,100]]);
  assert.equal(m.trend_lines.fix_at,iso(at(0,6)));
  // Гейт витрины линий не касается: решение на паузе, а фикс следующих суток исполняется.
  m=tick(m,at(1,6),66_000,{decision:{tactical:"insufficient",coverage:false},variantInputs:inputsOf(1,up)});
  assert.equal(m.health.operational_status,"paused");
  assert.deepEqual(TREND_LINE_NAMES_V1.map(n=>m.strategies[n].current_target_pct),[100,100]);
  // Запасной вызов сборщика без входов вариантов: линии держат цель, ошибок нет.
  const errorsBefore=(m.optional_errors||[]).length;
  m=tick(m,at(2,6),66_000,{variantInputs:null});
  assert.deepEqual([TREND_LINE_NAMES_V1.map(n=>m.strategies[n].current_target_pct),(m.optional_errors||[]).length,m.trend_lines.fix_at],[[100,100],errorsBefore,iso(at(1,6))]);
  // Отказ расчёта (вход, который бросает при чтении): след в optional_errors, цели прежние, прогон жив.
  const poisoned={families:families(),get series(){throw new Error("ряд не читается");}};
  m=tick(m,at(2,7),66_000,{variantInputs:poisoned});
  assert.deepEqual([TREND_LINE_NAMES_V1.map(n=>m.strategies[n].current_target_pct),m.optional_errors.at(-1).part,m.optional_errors.at(-1).error],[[100,100],"trend_lines","ряд не читается"]);
  assert.equal(verifyDecisionLogChainV1(m.decision_log).ok,true,"цепочка журнала решений цела");
}
// Решение и журнал от линий не зависят: два прогона, отличающиеся только входами линий, дают одну запись.
{
  // Движок вариантов v3 читает те же входы и пишет свой блок в журнал, поэтому здесь он заменён
  // заглушкой с постоянным ответом: разница между прогонами остаётся только в том, что читают линии.
  const variantEngine=()=>({state:{k:1},variants:{}});
  const withLines=tick(null,at(0,6),60_000,{variantInputs:inputsOf(0,closesAbove(3)),variantEngine}),without=tick(null,at(0,6),60_000,{variantInputs:inputsOf(0,closesAbove(3).slice(-150)),variantEngine});
  assert.equal(withLines.strategies.trend_ma3.current_target_pct,100,"фикстура: в первом прогоне линии родились");
  assert.deepEqual(withLines.decision_log,without.decision_log);
  assert.deepEqual(withLines.strategies.policy_v1,without.strategies.policy_v1);
  assert.deepEqual(withLines.health,without.health);
  assert.deepEqual([without.trend_lines,without.trend_lines_state,without.strategies.trend_ma3],[undefined,undefined,undefined],"без годного ряда линии не рождаются и блок не публикуется");
}
// Разрыв учёта (прогон прежней версии): линии перезапускаются вместе с остальными новыми линиями.
{
  let m=tick(null,at(0,6),60_000,{variantInputs:inputsOf(0,closesAbove(3))});
  m=tick(m,at(0,7),60_000,{variantInputs:inputsOf(0,closesAbove(3))});
  const rolledBack=structuredClone(m);rolledBack.last_at=iso(at(0,8));rolledBack.updated_at=iso(at(0,8)); // прежняя версия отметку учёта не двигает
  const back=tick(rolledBack,at(0,9),60_000,{variantInputs:inputsOf(0,closesAbove(3))});
  const restart=back.line_restarts.at(-1);
  assert.ok(TREND_LINE_NAMES_V1.every(n=>restart.lines.includes(n)),`линии в записи перезапуска: ${JSON.stringify(restart.lines)}`);
  for(const name of TREND_LINE_NAMES_V1)assert.equal(back.strategy_meta[name].started_at,iso(at(0,9)),`${name}: рождена заново`);
}
// Публичный блок без состояния.
assert.deepEqual(trendLinesPublicV1(null,iso(D0)).lines,null);

console.log("Monitor trend lines OK: declaration, rule, daily fix clock, monitor integration, gate independence, failure isolation, ledger independence, restart after accounting gap");
