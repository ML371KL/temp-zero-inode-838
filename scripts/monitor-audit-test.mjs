// Тесты правок форвард-монитора по аудиту 2026-10-10 (M1–M9) и по независимому ревью 13.10.2026
// (Н2–Н8, в конце файла). Запускаются из forward-monitor-test.mjs
// (он в `npm run check`) и отдельно: node scripts/monitor-audit-test.mjs. Сети нет, время задано явно.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { POLICY_SUITE_V1 } from "../docs/policy-suite-v1.mjs";
import { evaluateActionGateV1 } from "../docs/action-gate-v1.mjs";
import { POLICY_V3_CANDIDATE } from "../docs/policy-v3-candidate.mjs";
import { SHADOW_CARD_IDS_V1, SHADOW_HYPOTHESES_V1, shadowConditionStateV1 } from "../docs/shadow-hypotheses-v1.mjs";
import { excessSharpeV2 } from "../docs/policy-v2-candidate.mjs";
import { buildDecisionRecordV1, buildSourceVintagesV1, decisionGateV1, graftForwardMonitorV1, monitorRetentionLimitsV1, sha256, updateForwardMonitorV1, verifyDecisionLogChainV1 } from "./forward-monitor-v1.mjs";
import { MONITOR_BACKFILL_V1, STRATEGY_REGISTRY_V1, applyMonitorBackfillV1, decisionEventsCompleteV1 } from "./monitor-backfill-v1.mjs";
import { TARGET_CHANGE_LOG_LIMIT, targetChangeCauseV1, targetChangeRecordV1 } from "./monitor-changes-v1.mjs";
import { shadowEvidenceV1, shadowRowValuesV1, tacticalForwardV1 } from "./monitor-evidence-v1.mjs";
import { MONITOR_FIXTURE_V2130 } from "./monitor-fixture-v2130.mjs";
import { TRANCHE_CONVENTION_V1, VARIANTS_STATE_MAX_BYTES, acceptLineTargetV1, divergenceEpisodesV3, evaluateAcceptanceV3, runShadowVariantsV1, updateTrancheStateV1 } from "./monitor-lines-v1.mjs";
import { lineTimingV1 } from "./monitor-timing-v1.mjs";
import { releaseWindowAssetIssuesV1, validateSnapshotV1 } from "./monitor-live.mjs";
import { DAILY_INPUT_SUMMARY_DAYS, HISTORY_MAX_ROWS, jsonBytesV1, projectedPublicSnapshotBytesV1, publicSnapshotAtLimitsV1, publicSnapshotAtLimitsWarningV1, PUBLIC_SNAPSHOT_MAX_BYTES } from "./public-snapshot-contract.mjs";

const DAY=86_400_000,HOUR=3_600_000,MIN=60_000,COST=MODEL_POLICY_V1.forward_monitoring.transaction_cost_bps_per_full_turnover/10_000;
const near=(a,b,eps=1e-9)=>Math.abs(a-b)<=eps;
const iso=t=>new Date(t).toISOString();
// Точка отсчёта — понедельник; MONITOR_TEST_DAY_SHIFT=0…6 сдвигает весь набор на другой день недели.
// Системные часы монитор не читает: все моменты времени передаются явно.
const T0=Date.parse("2027-03-01T00:30:00.000Z")+(Number(process.env.MONITOR_TEST_DAY_SHIFT)||0)*86_400_000;

// ---------- общие заготовки ----------
const vintagesAt=t=>{const v=buildSourceVintagesV1({market:{source:"fixture",observed_at:iso(t),fetched_at:iso(t),data:[{t:1,v:100}]}},{market:{state:"ok",source:"fixture",observed_at:iso(t),fetched_at:iso(t)}});v.captured_at=iso(t);return v;};
const VINTAGES=vintagesAt(T0);
const BLOCKS={macro:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},demand:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},cycle:{strategic:{score:0,coverage:1},tactical:{score:0,coverage:1}},leverage:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}},market:{strategic:{score:null,coverage:0},tactical:{score:0,coverage:1}}};
function mkDecision(t,{strategic="transition",tactical="balanced",recovery="calm",macro="calm",mvrv=50,coverage=true,scores={}}={}){
  const metrics=[{id:"mvrv_cycle",vote:true,score:0,value_num:mvrv,observed_at:iso(t),source:"fixture"},{id:"exchange_supply",vote:true,score:scores.exchange_supply??0,value_num:scores.exchange_supply??0,observed_at:iso(t),source:"fixture"},{id:"trend_regime",vote:true,score:scores.trend_regime??0,value_num:scores.trend_regime??0,observed_at:iso(t),source:"fixture"}];
  return buildDecisionRecordV1({generatedAt:iso(t),regime:{strategic,tactical},regimeMeta:{},metrics,blocks:BLOCKS,detectors:[{id:"recovery",state:recovery},{id:"macro_shock",state:macro}],scores:{strategic:0,tactical:0,critical_coverage_ok:coverage},sourceVintages:VINTAGES,revisionAlerts:[]});
}
function tick(monitor,t,price,opts={},extra={}){
  const built=mkDecision(t,opts);
  return updateForwardMonitorV1({previousMonitor:monitor,now:t,price,decision:built.decision,inputSummary:built.inputSummary,sourceVintages:VINTAGES,cashQuotePct:4,priceSeries:[],...extra});
}
const priceAt=i=>60_000*(1+0.03*Math.sin(i/7)+0.0004*i);

// ================= M5. Цель исполняется, только если решение проходит гейт витрины =================
{
  let m=tick(null,T0,60_000,{strategic:"transition"});
  assert.equal(m.strategies.policy_v1.current_target_pct,45);
  // Пауза из-за ТАКТИЧЕСКОГО покрытия: среднесрочная цель конечна и меняется (45 → 100), статус
  // actionable, но качество paused — витрина цель скрывает.
  const paused=mkDecision(T0+HOUR,{strategic:"constructive",tactical:"insufficient",coverage:false}).decision;
  assert.equal(paused.status,"actionable");assert.equal(paused.target_pct,100);assert.equal(paused.quality.status,"paused");
  const shownByPanel=evaluateActionGateV1({generatedAt:paused.decided_at,now:T0+HOUR,staleLimitHours:3,decision:paused,operationalStatus:"paused"});
  assert.equal(shownByPanel.actionable,false,"фикстура: витрина такое решение не показывает");
  assert.deepEqual([decisionGateV1(paused,T0+HOUR).actionable,decisionGateV1(paused,T0+HOUR).code],[false,"decision_quality_not_actionable"],"гейт монитора обязан совпадать с гейтом витрины");
  const before=structuredClone(m.strategies);
  m=tick(m,T0+HOUR,60_000,{strategic:"constructive",tactical:"insufficient",coverage:false});
  m=tick(m,T0+2*HOUR,54_000,{strategic:"constructive",tactical:"insufficient",coverage:false}); // −10 % во время паузы
  for(const name of ["policy_v1","previous_policy_shadow","policy_v2_shadow","policy_v1_tranched"]){
    assert.equal(m.strategies[name].current_target_pct,before[name].current_target_pct,`${name}: при паузе решения линия держит прежнюю долю`);
    assert.equal(m.strategies[name].turnover_pct,before[name].turnover_pct,`${name}: при паузе решения оборота нет`);
  }
  // NAV прошёл падение на 10 % с долей 45 %, а не 100 %.
  const hourCash=Math.sqrt(m.strategies.cash.nav)-1; // два часовых шага кэша с генезиса
  assert.ok(near(m.strategies.policy_v1.nav/before.policy_v1.nav,(1+0.55*hourCash)*(1+0.45*(-0.10)+0.55*hourCash),1e-12),`policy_v1 обязана пройти движение с прежней долей 45 %: ${m.strategies.policy_v1.nav/before.policy_v1.nav}`);
  assert.equal(m.strategies.buy_and_hold.current_target_pct,100,"простых ориентиров гейт не касается");
  assert.equal(m.health.operational_status,"paused");
  assert.equal(m.target_change_log.at(-1).gate,"closed","смена цели при закрытом гейте записана и помечена");
  // Гейт открылся: цель исполняется этим же прогоном.
  m=tick(m,T0+3*HOUR,54_000,{strategic:"constructive"});
  assert.equal(m.strategies.policy_v1.current_target_pct,100);
  assert.equal(m.strategies.policy_v1.turnover_pct,before.policy_v1.turnover_pct+55);
  // Генезис на паузе: позиции нет, цель не исполняется.
  const pausedGenesis=tick(null,T0,60_000,{strategic:"constructive",tactical:"insufficient",coverage:false});
  assert.equal(pausedGenesis.strategies.policy_v1.current_target_pct,0);
  assert.equal(pausedGenesis.strategies.policy_v1_tranched,undefined,"линия исполнения рождается, когда панель впервые показывает цель");
}

// ================= M1. Честный ноль тайминга в мониторе =================
{
  // Три суток, прогон раз в час, смены цели внутри дня: 45 % шесть часов, 20 % тридцать часов, 45 % до конца.
  const regimeAt=h=>h<6?"transition":h<36?"deteriorating":"transition";
  let m=null;
  for(let h=0;h<=72;h++)m=tick(m,T0+h*HOUR,priceAt(h),{strategic:regimeAt(h)});
  const w=m.timing_null.since_start,policy=m.strategies.policy_v1;
  assert.ok(near(policy.exposure_pct_days,(45*6+20*30+45*36)/24,1e-9),"накопленная доля — интеграл исполненной цели по времени");
  assert.equal(w.share_source,"exact");
  assert.equal(w.share_pct,Number(((45*6+20*30+45*36)/72).toFixed(2)),"доля нуля — средневзвешенная ПО ВРЕМЕНИ, а не среднее целей закрытия");
  const closeAverage=m.daily.reduce((s,r)=>s+r.targets.policy_v1,0)/m.daily.length;
  assert.ok(Math.abs(closeAverage-w.share_pct)>1,"фикстура: среднее целей закрытия заметно отличается от доли по времени");
  assert.ok(near(w.policy_net_return_pct,(policy.nav-1)*100,1e-4)&&near(w.hodl_net_return_pct,(m.strategies.buy_and_hold.nav-1)*100,1e-4),"окно с начала повторяет опубликованные NAV");
  assert.ok(near(w.level_pp+w.timing_pp+w.costs_pp,w.policy_net_return_pct-w.hodl_net_return_pct,3e-4),"уровень + тайминг + издержки = разница с HODL");
  // Независимый пересчёт нуля по дневной сетке: генезис и дневные строки.
  let g=1,p0=m.strategy_meta.policy_v1.start_price,c0=1;const share=policy.exposure_pct_days/3/100;
  for(const row of m.daily){g*=1+share*(row.price/p0-1)+(1-share)*(row.nav.cash/c0-1);p0=row.price;c0=row.nav.cash;}
  assert.ok(near(w.null_net_return_pct,(g*(1-share*COST)-1)*100,1e-4),"NAV нуля — по дневным строкам (цена, NAV кэша), вход оплачен");
  assert.ok(near(w.timing_pp,(policy.gross_nav-g)*100,1e-4),"тайминг — валовой NAV политики минус валовой NAV нуля");
  assert.equal(m.timing_null.d90,null,"скользящее окно не публикуется, пока данных не хватает");
  assert.ok(m.strategies.static_theta&&m.performance.static_theta,"static_theta остаётся линией — как история");
  assert.deepEqual(m.strategy_meta.policy_v1,{started_at:iso(T0),kind:"live",label:STRATEGY_REGISTRY_V1.policy_v1.label,start_price:priceAt(0),start_target_pct:45});
}
{
  // Длинный ряд (раз в сутки): скользящие окна, R2 на своём окне, уход генезиса за срок хранения.
  const targetOf=d=>Math.floor(d/9)%3===0?"deteriorating":Math.floor(d/9)%3===1?"transition":"defensive",LADDER={deteriorating:20,transition:45,defensive:5};
  let m=null;const marks={};
  for(let d=0;d<=380;d++){
    m=tick(m,T0+d*DAY+23*HOUR,priceAt(d),{strategic:targetOf(d)});
    if([100,200,330].includes(d))marks[d]=structuredClone({timing_null:m.timing_null,review:m.v2_review,daily:m.daily.length});
  }
  const exactShare=(fromDay,toDay)=>{let s=0;for(let d=fromDay;d<toDay;d++)s+=LADDER[targetOf(d)];return s/(toDay-fromDay);};
  const w100=marks[100].timing_null;
  assert.ok(w100.since_start&&w100.d90&&!w100.d180&&!w100.d365,"на сотый день есть окно с начала и окно 90 дней");
  assert.ok(w100.d90.days>=90&&w100.d90.days<91.01,`окно 90 дней начинается с закрытой строки не моложе 90 суток: ${w100.d90.days}`);
  assert.equal(w100.d90.share_pct,Number(exactShare(10,100).toFixed(2)),"доля окна 90 дней — по исполненным целям этого окна");
  assert.ok(near(w100.d90.level_pp+w100.d90.timing_pp+w100.d90.costs_pp,w100.d90.policy_net_return_pct-w100.d90.hodl_net_return_pct,3e-4));
  assert.ok(marks[200].timing_null.d180&&!marks[200].timing_null.d365);
  assert.equal(marks[200].review.r2_timing.status,"collecting","R2 не вычисляется, пока окно короче 0,82·365 суток");
  const r2=marks[330].review.r2_timing;
  assert.equal(r2.status,"ok");assert.equal(r2.share_source,"exact");
  assert.equal(r2.null_share_pct,Number(exactShare(0,330).toFixed(2)),"R2 сравнивает политику с честным нулём своего окна");
  assert.equal(r2.net_gap_pp,Number((-marks[330].timing_null.since_start.vs_null_pp).toFixed(4)),"net-нога R2 — тот же честный ноль, что в timing_null");
  // После 370 суток генезис уходит из дневных строк: окно «с начала» честно закрывается, его сменяет окно 365 дней.
  assert.equal(m.daily.length<=371,true);
  assert.equal(m.timing_null.since_start,null,"окно с начала не подменяется обрезанным");
  assert.ok(m.timing_null.d365&&m.timing_null.d365.days>=365&&m.timing_null.d365.share_source==="exact");
  assert.equal(m.timing_null.d365.share_pct,Number(exactShare(15,380).toFixed(2)));
}

// ================= M2. Приёмка кандидата v2 =================
{
  // Четыре прогона в сутки. Сутки 1–4 — recovery good: пол тени идёт ступенями 40 → 60 → 80; на
  // четвёртые сутки good только в первом прогоне (пол действует ночью, к закрытию снят).
  const good=(d,q)=>(d>=1&&d<=3)||(d===4&&q===0)||(d>=8&&d<=10);
  let m=null;const seen=[];
  for(let d=0;d<=12;d++)for(let q=0;q<4;q++){
    m=tick(m,T0+d*DAY+q*6*HOUR,60_000,{strategic:"defensive",mvrv:20,recovery:good(d,q)?"good":"calm"});
    seen.push([d,q,m.strategies.policy_v1.current_target_pct,m.strategies.policy_v2_shadow.current_target_pct]);
  }
  assert.deepEqual(seen.filter(x=>x[1]===0&&x[0]>=1&&x[0]<=5).map(x=>x[3]),[5,40,60,80,5],"фикстура: пол тени градуируется по закрытиям 40 → 60 → 80");
  assert.ok(seen.every(x=>x[3]<=x[2]),"фикстура: цель тени НИКОГДА не выше цели v1 — прежнее условие эпизода невыполнимо");
  assert.deepEqual(m.daily.filter(r=>r.v2_floor).map(r=>r.date),[2,3,4,9,10].map(d=>iso(T0+d*DAY).slice(0,10)),"сутки, когда пол держал цель: включая ночь четвёртых суток (к закрытию пол снят)");
  assert.equal(m.v2_candidate.acceptance_status.recovery_episodes_observed,2,"два отрезка суток с действующим полом — два эпизода");
  assert.equal(m.v2_candidate.acceptance_status.meets.episode_or_180d,true);
}
{
  // Тень рождена позже монитора (как в бою: v1 — 19.07, тень — 22.07): теневые дни и разрыв Sharpe — на общем окне.
  let m=null;
  for(let d=0;d<3;d++)for(let q=0;q<4;q++)m=tick(m,T0+d*DAY+q*6*HOUR,60_000*(1+0.05*d+0.01*q),{strategic:"constructive"});
  for(const name of ["policy_v2_shadow","static_theta"]){delete m.strategies[name];delete m.strategy_meta[name];for(const row of m.daily){delete row.targets[name];delete row.nav[name];}}
  const born=T0+3*DAY;
  // После рождения тени — трое суток recovery good: v1 сразу берёт пол 80, тень идёт ступенями, NAV расходятся.
  for(let d=3;d<16;d++)for(let q=0;q<4;q++)m=tick(m,T0+d*DAY+q*6*HOUR,69_000*(1+0.02*Math.sin(d)+0.004*q),{strategic:d%4===0?"deteriorating":"transition",...(d>=6&&d<=8?{mvrv:20,recovery:"good"}:{})});
  assert.notEqual(m.strategies.policy_v2_shadow.nav,m.strategies.policy_v1.nav/m.strategy_meta.policy_v2_shadow.base.policy_v1_nav,"фикстура: тень и v1 на общем окне разошлись");
  const meta=m.strategy_meta.policy_v2_shadow,status=m.v2_candidate.acceptance_status,cmp=m.comparisons.policy_v2_shadow,now=Date.parse(m.updated_at);
  assert.equal(meta.started_at,iso(born));assert.equal(meta.kind,"candidate");
  assert.ok(meta.base.policy_v1_nav>1.05,"фикстура: к рождению тени v1 уже ушла от единицы");
  assert.equal(m.days_elapsed,15);
  assert.equal(status.shadow_days,Math.floor((now-born)/DAY),"теневые дни считаются от рождения тени");
  assert.equal(status.shadow_days,12);
  const closed=m.daily.filter(r=>r.date<m.updated_at.slice(0,10)),common=closed.filter(r=>Number.isFinite(r.nav.policy_v2_shadow));
  const sharpe=(rows,name)=>excessSharpeV2(rows.map(r=>({t:Date.parse(r.t),nav:r.nav[name],cash:r.nav.cash}))).sharpe_excess;
  const commonGap=sharpe(common,"policy_v2_shadow")-sharpe(common,"policy_v1"),ownWindowsGap=m.performance.policy_v2_shadow.sharpe_excess-m.performance.policy_v1.sharpe_excess;
  assert.ok(Math.abs(commonGap-ownWindowsGap)>0.05,`фикстура: разрыв на разных окнах отличается от разрыва на общем: ${commonGap} / ${ownWindowsGap}`);
  assert.ok(Math.abs(commonGap)>0.01,`фикстура: разрыв на общем окне ненулевой: ${commonGap}`);
  assert.equal(cmp.sharpe_gap,Number(commonGap.toFixed(4)),"разрыв Sharpe — по закрытым суткам, где есть обе линии");
  assert.equal(status.sharpe_gap_vs_v1,cmp.sharpe_gap,"приёмка судит по разрыву на общем окне");
  assert.equal(cmp.from,iso(born));assert.equal(cmp.closed_days,common.length-1);
  const policyOnWindow=m.strategies.policy_v1.nav/meta.base.policy_v1_nav*(1-meta.base.policy_v1_target_pct/100*COST)-1;
  assert.ok(near(cmp.net_return_gap_pp,(m.strategies.policy_v2_shadow.nav-1-policyOnWindow)*100,1e-4),"доходности на общем окне: обе линии открыты в его начале");
  assert.ok(Math.abs(cmp.net_return_gap_pp-(m.performance.policy_v2_shadow.net_return_pct-m.performance.policy_v1.net_return_pct))>3,"фикстура: разница «с рождения каждой» на разных окнах ничего не значит");
  // strategy_meta и comparisons есть у каждой линии; род — из реестра.
  for(const name of Object.keys(m.strategies)){assert.ok(m.strategy_meta[name]?.started_at&&m.strategy_meta[name].kind===STRATEGY_REGISTRY_V1[name].kind,`strategy_meta: ${name}`);if(name!=="policy_v1")assert.equal(m.comparisons[name].vs,"policy_v1");}
}

// ================= M6. Sharpe по закрытым суткам; счётчик понижений; просадка после графта =================
{
  let m=null;
  for(let d=0;d<6;d++)for(let q=0;q<4;q++)m=tick(m,T0+d*DAY+q*6*HOUR,priceAt(d*4+q),{strategic:"transition"});
  const morning=tick(m,T0+6*DAY,priceAt(24)*1.00,{strategic:"transition"}),evening=tick(morning,T0+6*DAY+18*HOUR,priceAt(24)*1.08,{strategic:"transition"});
  for(const name of ["policy_v1","buy_and_hold","fixed_50"]){
    assert.equal(evening.performance[name].sharpe_excess,morning.performance[name].sharpe_excess,`${name}: Sharpe внутри суток не меняется`);
    assert.equal(evening.performance[name].annualized_volatility_pct,morning.performance[name].annualized_volatility_pct);
    const closed=evening.daily.filter(r=>r.date<evening.updated_at.slice(0,10));
    assert.equal(evening.performance[name].sharpe_excess,excessSharpeV2(closed.map(r=>({t:Date.parse(r.t),nav:r.nav[name],cash:r.nav.cash}))).sharpe_excess,`${name}: Sharpe — по закрытым суткам`);
  }
  assert.notEqual(evening.performance.buy_and_hold.net_return_pct,morning.performance.buy_and_hold.net_return_pct,"доходность и просадка остаются живыми");
  const withOpenDay=excessSharpeV2(evening.daily.map(r=>({t:Date.parse(r.t),nav:r.nav.buy_and_hold,cash:r.nav.cash}))).sharpe_excess;
  assert.ok(Math.abs(withOpenDay-evening.performance.buy_and_hold.sharpe_excess)>0.5,"фикстура: неполные сутки заметно сдвигали Sharpe");
}
{
  // Счётчик «понижение подтверждено раньше, чем разрешило бы правило v2»: отсчёт от ПЕРВОГО встречного снимка.
  const meta=(state,candidate)=>({strategic:{state,candidate,count:1,since:iso(T0)},tactical:{state:"balanced",candidate:"balanced",count:1,since:iso(T0)}});
  const run=(steps,prior=null)=>{let m=tick(null,T0-HOUR,60_000,{strategic:"transition"},{regimeMeta:meta("transition","transition")});if(prior)m.shadow_hysteresis={...m.shadow_hysteresis,...prior};for(const [minutes,state,candidate] of steps)m=tick(m,T0+minutes*MIN,60_000,{strategic:state},{regimeMeta:meta(state,candidate),shadowHysteresis:{upgrade_hold_reset_by_degraded:0,risk_off_confirmed_under_min_interval:9}});return m.shadow_hysteresis;};
  // Такт 15 минут: встречный снимок, через 15 минут v1 подтвердил — v2 отложил бы.
  const fast=run([[0,"transition","deteriorating"],[15,"deteriorating","deteriorating"]]);
  assert.equal(fast.risk_off_confirmed_under_min_interval,1,"подтверждение через 15 минут от первого встречного снимка считается; флаг сборщика (9) монитором не суммируется");
  assert.equal(fast.reference,"first_counter_snapshot");assert.equal(fast.last_event_t,iso(T0+15*MIN));assert.equal(fast.risk_off_first_counter_at,null);
  // Часовой такт не считается.
  assert.equal(run([[0,"transition","deteriorating"],[60,"deteriorating","deteriorating"]]).risk_off_confirmed_under_min_interval,0);
  // Серия длиннее интервала: первый встречный снимок 40 минут назад, предыдущий снимок — 10 минут
  // назад и без данных (серию не прерывает). По прежнему определению (от предыдущего снимка) это
  // считалось бы быстрым подтверждением; по новому — нет.
  const long=run([[0,"transition","deteriorating"],[30,"insufficient","insufficient"],[40,"deteriorating","deteriorating"]]);
  assert.equal(long.risk_off_confirmed_under_min_interval,0,"интервал отсчитывается от первого встречного снимка серии, а не от предыдущего");
  // Кандидат вернулся к режиму — серия прервана, отсчёт начинается заново.
  assert.equal(run([[0,"transition","deteriorating"],[45,"transition","transition"],[60,"transition","defensive"],[75,"defensive","defensive"]]).risk_off_confirmed_under_min_interval,1);
  // Повышение и аварийный режим в счёт не идут.
  assert.equal(run([[0,"transition","constructive"],[15,"constructive","constructive"]]).risk_off_confirmed_under_min_interval,0);
  assert.equal(run([[0,"emergency","emergency"]]).risk_off_confirmed_under_min_interval,0,"аварийный режим подтверждений не требует");
  // Накопленное значение переносится.
  assert.equal(run([[0,"transition","deteriorating"],[15,"deteriorating","deteriorating"]],{risk_off_confirmed_under_min_interval:3}).risk_off_confirmed_under_min_interval,4);
  assert.equal(run([[0,"transition","transition"]],{risk_off_confirmed_under_min_interval:3}).risk_off_confirmed_under_min_interval,3);
}
{
  // Графт: внутридневной пик живой эры обязан пережить склейку.
  let archive=tick(null,T0,100,{strategic:"constructive"});archive=tick(archive,T0+DAY,104,{strategic:"constructive"});
  const eraAt=T0+DAY+2*HOUR;
  let era=tick(null,eraAt,105,{strategic:"constructive"},{previousSnapshotPresent:true});
  era=tick(era,eraAt+HOUR,112,{strategic:"constructive"}); // внутридневной пик
  era=tick(era,eraAt+2*HOUR,106,{strategic:"constructive"});
  const pack={schema:1,reason:"test_restore",invalid_window:[],orphaned_genesis_log_hashes:[],archive:{source_commit:"fixture",monitor:archive},era:{started_at:era.started_at,price:105,strategies:Object.fromEntries(Object.entries(era.strategies).map(([k,v])=>[k,{initial_target_pct:era.strategy_meta[k].start_target_pct,initial_nav:1-era.strategy_meta[k].start_target_pct/100*COST,initial_turnover_pct:era.strategy_meta[k].start_target_pct,initial_cost_pct:era.strategy_meta[k].start_target_pct/100*COST*100}]))}};
  const grafted=graftForwardMonitorV1(era,pack),hodl=grafted.strategies.buy_and_hold;
  assert.ok(near(hodl.nav,archive.strategies.buy_and_hold.nav*106/104,1e-9));
  assert.ok(near(hodl.peak_nav,archive.strategies.buy_and_hold.nav*112/104,1e-9),"пик после склейки включает внутридневной пик живой эры");
  // Следующий прогон мерит просадку от настоящего пика.
  const next=updateForwardMonitorV1({previousMonitor:grafted,now:eraAt+3*HOUR,price:100,...(()=>{const b=mkDecision(eraAt+3*HOUR,{strategic:"constructive"});return{decision:b.decision,inputSummary:b.inputSummary};})(),sourceVintages:VINTAGES,cashQuotePct:4,priceSeries:[]});
  assert.ok(near(next.strategies.buy_and_hold.max_drawdown_pct,(100/112-1)*100,1e-6),`просадка считается от пика 112: ${next.strategies.buy_and_hold.max_drawdown_pct}`);
  assert.equal(verifyDecisionLogChainV1(next.decision_log).ok,true);
  assert.ok(Number.isFinite(next.strategies.policy_v1.gross_nav)&&next.daily.every(r=>Array.isArray(r.path?.policy_v1)),"путь политики после склейки пересчитан из полного списка событий");
  assert.equal(next.strategy_meta.policy_v1.started_at,archive.started_at);
  assert.equal(graftForwardMonitorV1(next,pack),next,"склейка по-прежнему идемпотентна");
}

// ================= M3. Теневые линии v3 и исполнение траншами =================
const variantInputs=target=>({price:60_000,hard_override:false,v1:{state:"transition",candidate:"transition",critical_ok:true,target_pct:target},families:{},series:{},observed_at:{}});
{
  const calls=[];
  const engine=({now,inputs,state})=>{calls.push({now,state:structuredClone(state)});const n=(state.n||0)+1,t=inputs.v1.target_pct;return{state:{n},variants:{policy_v3_shadow:{target_pct:n>=3?t-10:t,base_target_pct:t,state:"transition",candidate:"transition",fix_at:iso(now),next_fix_at:iso(now+DAY),floor:{active:false,rung:null,closes:0},binding_overlays:[],inputs:{mvrv_percentile:42.4,deep_ok:true}},v1_daily_close:{target_pct:t,state:"transition",fix_at:iso(now)},v1_floor_handoff:{target_pct:null,carry:false},v1_no_cftc:{target_pct:t,state:"transition",candidate:"transition"}}};};
  let m=tick(null,T0,60_000,{strategic:"transition"});
  assert.equal(m.strategies.policy_v3_shadow,undefined,"без входов движка линий v3 нет");
  assert.equal(m.decision_log.at(-1).v3,undefined,"без входов движка запись журнала прежней формы");
  assert.equal(m.v3_candidate,undefined);
  m=tick(m,T0+HOUR,61_200,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:engine});
  // Рождение: NAV = 1 минус вход, запись старта с опорными числами policy_v1.
  for(const name of ["policy_v3_shadow","v1_daily_close","v1_no_cftc"]){
    assert.ok(near(m.strategies[name].nav,1-0.45*COST,1e-12),`${name}: линия рождается с NAV = 1 и платит вход`);
    assert.equal(m.strategy_meta[name].started_at,iso(T0+HOUR));assert.equal(m.strategy_meta[name].kind,STRATEGY_REGISTRY_V1[name].kind);
    assert.equal(m.strategy_meta[name].base.policy_v1_nav,m.strategies.policy_v1.nav);assert.equal(m.strategy_meta[name].start_price,61_200);
  }
  assert.equal(m.strategies.v1_floor_handoff,undefined,"линия без собственной цели не рождается");
  assert.deepEqual(m.variants_state,{n:1});assert.deepEqual(calls[0].state,{},"движок получает переносимое состояние");
  m=tick(m,T0+2*HOUR,61_200,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:engine});
  assert.deepEqual(calls[1].state,{n:1});
  m=tick(m,T0+3*HOUR,61_200,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:engine});
  assert.equal(m.strategies.policy_v3_shadow.current_target_pct,35);
  // Эпизоды расхождения с v1 считает определение из контракта кандидата; в модуле-заглушке его нет —
  // тогда счёта нет вовсе, и критерий приёмки остаётся неоценённым. Тест проходит в обоих вариантах.
  const episodes=divergenceEpisodesV3(m.daily,"policy_v3_shadow");
  assert.deepEqual(m.comparisons.policy_v3_shadow.divergence??null,episodes);
  if(episodes!==null)assert.deepEqual(episodes,{episodes:1,days:1},"цель кандидата 35 против 45 у v1 в дневной строке — один эпизод расхождения");
  // Приёмка считает эпизоды против линии с теми же часами (divergence_base контракта), а не против policy_v1.
  const sameClock=divergenceEpisodesV3(m.daily,"policy_v3_shadow",undefined,POLICY_V3_CANDIDATE.decision_record.acceptance_criteria.divergence_base);
  assert.deepEqual([m.v3_candidate.acceptance_status.divergence_base,m.v3_candidate.acceptance_status.divergence_episodes],["v1_daily_close",sameClock?.episodes??null]);
  if(sameClock!==null)assert.deepEqual(sameClock,{episodes:1,days:1},"цель кандидата 35 против 45 у суточной линии v1 — один эпизод");
  assert.equal(m.strategies.policy_v3_shadow.target_changes_vs_v1,undefined,"счёта смен разности на снимках в учёте линии нет");
  assert.equal(m.v3_candidate.id,POLICY_V3_CANDIDATE.id);assert.equal(m.v3_candidate.target_pct,35);assert.equal(m.v3_candidate.evaluated_at,iso(T0+3*HOUR));
  assert.equal(m.v3_candidate.acceptance_status.status,"collecting");
  assert.deepEqual(Object.keys(m.variants).sort(),["v1_daily_close","v1_floor_handoff","v1_no_cftc"]);
  // Запись журнала: блок v3 хэшируется вместе с решением и не содержит undefined.
  const entry=m.decision_log.at(-1);
  assert.deepEqual(entry.v3,{target_pct:35,base_target_pct:45,state:"transition",candidate:"transition",fix_at:iso(T0+3*HOUR),floor_rung:null,inputs:{mvrv_percentile:42.4,deep_ok:true},lines:{v1_daily_close:45,v1_floor_handoff:null,v1_no_cftc:45}});
  {const c=JSON.parse(JSON.stringify(entry));delete c.log_hash;assert.equal(entry.log_hash,sha256(c),"запись воспроизводится из опубликованной (JSON) формы");}
  assert.equal(verifyDecisionLogChainV1(m.decision_log).ok,true);
  assert.deepEqual(Object.keys(m.daily.at(-1).nav).filter(k=>k.startsWith("v1_")||k==="policy_v3_shadow").sort(),["policy_v3_shadow","v1_daily_close","v1_no_cftc"]);
  // target_pct:null — держать прежнюю цель; отказ движка — след в variant_errors, решение и качество не тронуты.
  const holdEngine=()=>({state:{n:99},variants:{policy_v3_shadow:{target_pct:null},v1_daily_close:{target_pct:null}}});
  let held=tick(m,T0+4*HOUR,63_000,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:holdEngine});
  assert.equal(held.strategies.policy_v3_shadow.current_target_pct,35);assert.equal(held.strategies.policy_v3_shadow.turnover_pct,m.strategies.policy_v3_shadow.turnover_pct);
  assert.equal(held.v3_candidate.evaluated_at,iso(T0+4*HOUR));assert.equal(held.v3_candidate.target_pct,null,"публикуется то, что движок отдал");
  const throwing=()=>{throw new Error("boom");};
  const failed=tick(m,T0+4*HOUR,63_000,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:throwing});
  const clean=tick(m,T0+4*HOUR,63_000,{strategic:"transition"});
  assert.deepEqual(failed.variant_errors.map(e=>[e.t,e.error]),[[iso(T0+4*HOUR),"engine_threw: boom"]]);
  assert.deepEqual(failed.variants_state,m.variants_state,"при отказе состояние движка не теряется");
  assert.equal(failed.strategies.policy_v3_shadow.current_target_pct,35);
  for(const key of ["policy_v1","previous_policy_shadow","buy_and_hold","policy_v2_shadow"])assert.deepEqual(failed.strategies[key],clean.strategies[key],`отказ движка не трогает ${key}`);
  assert.deepEqual(failed.health,clean.health);assert.equal(failed.decision_log.at(-1).quality,"good");
  assert.equal(failed.v3_candidate.evaluated_at,iso(T0+3*HOUR),"без свежего результата блок кандидата остаётся прежним");
  // Пустой набор вариантов: линии не рождаются, блок кандидата честно пуст. Движок передан явно —
  // тест не зависит от того, заглушка или наполненный модуль лежит в docs/policy-v3-candidate.mjs.
  const stub=tick(tick(null,T0,60_000),T0+HOUR,60_000,{},{variantInputs:variantInputs(45),variantEngine:()=>({state:{},variants:{}})});
  assert.equal(stub.strategies.policy_v3_shadow,undefined);assert.equal(stub.v3_candidate.target_pct,null);assert.deepEqual(stub.variants,{});
  assert.deepEqual(stub.decision_log.at(-1).v3,{target_pct:null,base_target_pct:null,state:null,candidate:null,fix_at:null,floor_rung:null,inputs:null,lines:{v1_daily_close:null,v1_floor_handoff:null,v1_no_cftc:null}});
  // Негодные ответы движка.
  assert.equal(runShadowVariantsV1({engine:()=>null,now:T0,inputs:{},state:{a:1}}).error,"engine_result_invalid");
  assert.equal(runShadowVariantsV1({engine:()=>({state:[],variants:{}}),now:T0,inputs:{},state:{a:1}}).error,"engine_state_invalid");
  const huge=runShadowVariantsV1({engine:()=>({state:{blob:"x".repeat(VARIANTS_STATE_MAX_BYTES)},variants:{policy_v3_shadow:{target_pct:50}}}),now:T0,inputs:{},state:{a:1}});
  assert.ok(huge.error.startsWith("engine_state_too_large")&&huge.targets.policy_v3_shadow===null,"раздутое состояние не принимается, цель этого прогона — тоже");
  assert.deepEqual(huge.state,{a:1});
  assert.equal(runShadowVariantsV1({engine:()=>({state:{},variants:{policy_v3_shadow:{target_pct:250}}}),now:T0,inputs:{},state:{}}).targets.policy_v3_shadow,null,"цель вне 0…100 не исполняется и не обрезается до края");
  assert.equal(runShadowVariantsV1({engine:()=>{throw new Error("не должен вызываться");},now:T0,inputs:null,state:{}}).ran,false,"без входов движок не вызывается");
  // Гейт закрыт — линии v3 тоже держат долю.
  const gated=tick(m,T0+4*HOUR,63_000,{strategic:"transition",tactical:"insufficient",coverage:false},{variantInputs:variantInputs(45),variantEngine:()=>({state:{},variants:{policy_v3_shadow:{target_pct:80}}})});
  assert.equal(gated.strategies.policy_v3_shadow.current_target_pct,35);
}
{
  // Исполнение траншами: понижения сразу, повышения тремя равными траншами со следующей сессии.
  assert.equal(TRANCHE_CONVENTION_V1.tranches,3);assert.equal(TRANCHE_CONVENTION_V1.first_not_before_utc_hour,6);
  const D0=Math.floor(T0/DAY)*DAY;
  let m=tick(null,D0+2*HOUR,60_000,{strategic:"deteriorating"});
  assert.equal(m.strategies.policy_v1_tranched.current_target_pct,20,"линия рождается в цели панели");
  assert.equal(m.strategy_meta.policy_v1_tranched.kind,"execution");
  assert.equal(m.assumptions.tranched_execution.tranches,3);assert.ok(m.assumptions.tranched_execution.text.includes("06:00 UTC"));
  m=tick(m,D0+10*HOUR,60_000,{strategic:"constructive",mvrv:50,recovery:"calm"});m=tick(m,D0+10*HOUR+15*MIN,60_000,{strategic:"defensive",mvrv:20,recovery:"good"}); // v1: 100, затем 80
  assert.equal(m.strategies.policy_v1.current_target_pct,80);
  assert.equal(m.strategies.policy_v1_tranched.current_target_pct,20,"повышение в день решения не исполняется");
  assert.deepEqual([m.tranche_state.goal_pct,m.tranche_state.left,m.tranche_state.next_at],[80,3,iso(D0+DAY+6*HOUR)]);
  const up=(t)=>{m=tick(m,t,60_000,{strategic:"defensive",mvrv:20,recovery:"good"});return m.strategies.policy_v1_tranched.current_target_pct;};
  assert.equal(up(D0+DAY+5*HOUR+45*MIN),20,"до 06:00 UTC следующих суток транша нет");
  assert.equal(up(D0+DAY+6*HOUR+5*MIN),40,"первый транш — на первом снимке не раньше 06:00 UTC");
  assert.equal(up(D0+DAY+18*HOUR),40,"не больше транша в сутки");
  assert.equal(up(D0+2*DAY+6*HOUR),60);
  assert.equal(up(D0+3*DAY+7*HOUR),80,"третий транш ставит ровно цель");
  assert.equal(m.tranche_state,null);
  assert.ok(near(m.strategies.policy_v1_tranched.turnover_pct,20+60,1e-9),"оборот — вход и три транша по 20");
  assert.equal(m.strategies.policy_v1.turnover_pct,20+80+20);
  // Понижение исполняется сразу и отменяет неисполненные транши.
  let n=tick(null,D0+2*HOUR,60_000,{strategic:"defensive"});
  n=tick(n,D0+3*HOUR,60_000,{strategic:"defensive",mvrv:20,recovery:"good"});          // 5 → 80
  n=tick(n,D0+DAY+6*HOUR,60_000,{strategic:"defensive",mvrv:20,recovery:"good"});      // транш: 30
  assert.equal(n.strategies.policy_v1_tranched.current_target_pct,30);
  const cut=tick(n,D0+DAY+9*HOUR,60_000,{strategic:"defensive"});                      // цель 5: сразу
  assert.equal(cut.strategies.policy_v1_tranched.current_target_pct,5);assert.equal(cut.tranche_state,null);
  // Цель снижена, но осталась выше позиции: старый план отменён, новый — от текущей позиции со следующей сессии.
  const lower=tick(n,D0+DAY+9*HOUR,60_000,{strategic:"transition"});                   // цель 45 при позиции 30
  assert.equal(lower.strategies.policy_v1_tranched.current_target_pct,30);
  assert.deepEqual([lower.tranche_state.goal_pct,lower.tranche_state.left,lower.tranche_state.tranche_pct,lower.tranche_state.next_at],[45,3,5,iso(D0+2*DAY+6*HOUR)]);
  // При закрытом гейте транши не исполняются, план сохраняется.
  const gated=tick(n,D0+2*DAY+6*HOUR,60_000,{strategic:"defensive",tactical:"insufficient",mvrv:20,recovery:"good",coverage:false});
  assert.equal(gated.strategies.policy_v1_tranched.current_target_pct,30);assert.equal(gated.tranche_state.left,2);
  // Чистая машина состояний.
  assert.deepEqual(updateTrancheStateV1(null,{now:D0,target:45,position:null}),{state:null,position:45});
  assert.deepEqual(updateTrancheStateV1({goal_pct:80,tranche_pct:20,left:2,next_at:iso(D0)},{now:D0+HOUR,target:10,position:40}),{state:null,position:10});
}
{
  // Приёмка кандидата v3: критерии из контракта; без них — collecting и список недостающих ключей.
  const none=evaluateAcceptanceV3({criteria:null,shadowDays:100});
  assert.equal(none.status,"collecting");assert.equal(none.missing_criteria.length,7);assert.equal(none.shadow_days,100);
  const criteria={shadow_days_min:90,divergence_base:"v1_daily_close",min_divergence_episodes:4,timing_pp_not_worse_than_v1:true,max_drawdown_worse_pp_max:3,falsify_net_return_gap_pp:5,falsify_min_days:120};
  assert.equal(evaluateAcceptanceV3({criteria:{...criteria,falsify_min_days:undefined},shadowDays:100}).status,"collecting");
  const ready={criteria,shadowDays:95,divergence:{episodes:6,days:15},timingGapPp:0.4,drawdownWorsePp:1,netReturnGapPp:0.8};
  assert.deepEqual([evaluateAcceptanceV3(ready).divergence_base,evaluateAcceptanceV3(ready).divergence_episodes,evaluateAcceptanceV3(ready).divergence_days],["v1_daily_close",6,15]);
  assert.equal(evaluateAcceptanceV3({...ready,criteria:{...criteria,divergence_base:undefined}}).status,"collecting","без названной базы эпизодов приёмка не оценена");
  assert.equal(evaluateAcceptanceV3(ready).status,"switch_ready_pending_owner","выполненные критерии дают только pending-owner");
  assert.equal(evaluateAcceptanceV3({...ready,shadowDays:60}).status,"collecting");
  assert.equal(evaluateAcceptanceV3({...ready,divergence:{episodes:1,days:40}}).status,"collecting","кандидат, почти не расходившийся с v1, ничего не доказал: одна длинная серия — один эпизод");
  // Определения эпизодов в модуле нет — критерий не оценён, приёмка ждёт; фальсификация от него не зависит.
  const undefinedEpisodes=evaluateAcceptanceV3({...ready,divergence:null});
  assert.deepEqual([undefinedEpisodes.status,undefinedEpisodes.meets.divergence,undefinedEpisodes.divergence_episodes],["collecting",null,null]);
  assert.equal(evaluateAcceptanceV3({...ready,divergence:null,shadowDays:130,netReturnGapPp:-6}).status,"falsified");
  // Обёртка счёта: определение приходит из модуля кандидата; без него — null, а не собственный вариант.
  const rowsOf=pairs=>pairs.map(([line,base],i)=>({date:iso(T0+i*DAY).slice(0,10),targets:{policy_v3_shadow:line,policy_v1:base}}));
  const sample=rowsOf([[45,45],[20,45],[20,45],[45,45],[45,80],[45,45],[null,45],[45,45]]);
  assert.equal(divergenceEpisodesV3(sample,"policy_v3_shadow",null),null,"определения нет — счёта нет");
  assert.deepEqual(divergenceEpisodesV3(sample,"policy_v3_shadow",(daily,options)=>({episodes:daily.length,days:options.candidate==="policy_v3_shadow"&&options.base==="policy_v1"?7:-1})),{episodes:8,days:7},"линия и база передаются определению как есть");
  assert.equal(divergenceEpisodesV3(sample,"policy_v3_shadow",()=>({episodes:"мусор"})),null);
  const contract=divergenceEpisodesV3(sample);
  if(contract!==null)assert.deepEqual(contract,{episodes:2,days:3},"определение контракта: непрерывная серия дневных строк — один эпизод");
  assert.equal(evaluateAcceptanceV3({...ready,timingGapPp:-0.2}).status,"collecting");
  assert.equal(evaluateAcceptanceV3({...ready,timingGapPp:-0.2,criteria:{...criteria,timing_pp_not_worse_than_v1:0.5}}).status,"switch_ready_pending_owner","число — допуск в п.п.");
  assert.equal(evaluateAcceptanceV3({...ready,drawdownWorsePp:4}).status,"collecting");
  assert.equal(evaluateAcceptanceV3({...ready,timingGapPp:null}).meets.timing,null,"нет числа — критерий не оценён");
  assert.equal(evaluateAcceptanceV3({...ready,shadowDays:130,netReturnGapPp:-6}).status,"falsified");
  assert.equal(evaluateAcceptanceV3({...ready,shadowDays:100,netReturnGapPp:-6}).falsified,false,"раньше falsify_min_days — не отклонение");
}

// ================= M4. Журнал смен цели =================
{
  const birth={strategic:{t:iso(T0-2*DAY),candidate:"transition",from_candidate:"deteriorating",price:59_000,blocks:{demand:{from:-31.25,to:-18.75,band_from:"adverse",band_to:"neutral"}},families:[{block:"demand",family:"institutional",id:"institutional_quality",name:"Качество институционального спроса",from:-1,to:0},{block:"cycle",family:"trend",id:"trend_regime",name:"Старший ценовой тренд",from:0,to:0.5}],detectors:[],note:null}};
  let m=tick(null,T0,60_000,{strategic:"deteriorating"});
  assert.deepEqual(m.target_change_log.map(x=>[x.kind,x.from_pct,x.to_pct,x.direction]),[["start",null,20,"start"]]);
  m=tick(m,T0+HOUR,60_500,{strategic:"deteriorating"},{regimeBirth:birth});
  assert.equal(m.target_change_log.length,1,"без смены цели записи нет");
  m=tick(m,T0+2*HOUR,61_000,{strategic:"transition"},{regimeBirth:birth,tickDiff:{families:[],detectors:[]}});
  const up=m.target_change_log.at(-1);
  assert.deepEqual([up.t,up.from_pct,up.to_pct,up.direction,up.price,up.strategic_from,up.strategic_to,up.kind],[iso(T0+2*HOUR),20,45,"up",61_000,"deteriorating","transition","regime"]);
  assert.equal(up.cause.text,"блок «Спрос» вышел из неблагоприятной полосы: качество институционального спроса −1 → 0","причина режима — из снимка рождения принятого кандидата, семьи — пересёкшего полосу блока");
  assert.equal(up.cause.candidate_since,iso(T0-2*DAY));
  assert.deepEqual(up.cause.families,[{block:"demand",family:"institutional",id:"institutional_quality",name:"Качество институционального спроса",from:-1,to:0}]);
  // Оверлей: причина — из tick_diff этого снимка.
  m=tick(m,T0+3*HOUR,61_000,{strategic:"transition",mvrv:20,recovery:"good"},{regimeBirth:birth,tickDiff:{families:[{block:"demand",family:"exchange_supply",id:"exchange_supply",name:"Биржевое предложение BTC",from:-0.5,to:0},{block:"macro",family:"stress",id:"system_stress",name:"Кредит и системный стресс",from:0,to:-0.5}],detectors:[{id:"recovery",from:"watch",to:"good"}]}});
  const floor=m.target_change_log.at(-1);
  assert.deepEqual([floor.kind,floor.from_pct,floor.to_pct,floor.overlays_from,floor.overlays_to],["overlay",45,80,[],["recovery_floor"]]);
  assert.equal(floor.cause.text,"пол восстановления включён: биржевое предложение BTC −0,5 → 0");assert.equal(floor.cause.candidate_since,null);
  assert.deepEqual(floor.cause.detectors,[{id:"recovery",from:"watch",to:"good"}]);
  m=tick(m,T0+4*HOUR,61_000,{strategic:"transition",mvrv:27.2,recovery:"calm"},{tickDiff:{families:[],detectors:[{id:"recovery",from:"good",to:"calm"}],mvrv_percentile:{from:19.54,to:27.21}}});
  assert.equal(m.target_change_log.at(-1).cause.text,"пол восстановления снят: перцентиль MVRV 19,5 → 27,2");
  // Пол капитуляции включает перцентиль MVRV: совпавшая по времени смена балла посторонней карточки причиной не называется.
  {
    let cap=tick(null,T0,60_000,{strategic:"defensive",mvrv:12});
    cap=tick(cap,T0+HOUR,60_000,{strategic:"defensive",mvrv:9},{tickDiff:{families:[{block:"leverage",family:"carry",id:"carry_regime",name:"Funding и фьючерсный carry",from:0,to:-1}],detectors:[{id:"leverage",from:"calm",to:"watch"}],mvrv_percentile:{from:12,to:9}}});
    const record=cap.target_change_log.at(-1);
    assert.deepEqual([record.from_pct,record.to_pct,record.kind,record.overlays_to],[5,40,"overlay",["capitulation_floor"]]);
    assert.equal(record.cause.text,"пол капитуляции включён: перцентиль MVRV 12 → 9");assert.deepEqual(record.cause.families,[]);
  }
  // Заголовки карточек, которые читаются как внутренние имена, в тексте заменены человеческими; в данных имя остаётся как пришло.
  {
    const etfBirth={strategic:{t:iso(T0),candidate:"transition",from_candidate:"deteriorating",price:1,blocks:{demand:{from:-25,to:-18.75,band_from:"adverse",band_to:"neutral"}},families:[{block:"demand",family:"etf",id:"etf_regime",name:"US spot-ETF · режим потоков",from:-0.5,to:0}],detectors:[],note:null}};
    const cause=targetChangeCauseV1({kind:"regime",strategicFrom:"deteriorating",strategicTo:"transition",regimeBirth:etfBirth});
    assert.equal(cause.text,"блок «Спрос» вышел из неблагоприятной полосы: потоки спотовых ETF −0,5 → 0");assert.equal(cause.families[0].name,"US spot-ETF · режим потоков");
    assert.ok(/^[а-яё«]/.test(cause.text)&&!/[.!]$/.test(cause.text),"текст причины — со строчной буквы и без точки: он печатается после слова «Причина:»");
  }
  // Режим и оверлей одним снимком; рождение чужого кандидата причиной не считается.
  m=tick(m,T0+5*HOUR,61_000,{strategic:"defensive",mvrv:20,recovery:"good"},{regimeBirth:birth,tickDiff:{families:[{block:"cycle",family:"trend",id:"trend_regime",name:"Старший ценовой тренд",from:-1,to:2}],detectors:[{id:"recovery",from:"calm",to:"good"}]}});
  const both=m.target_change_log.at(-1);
  assert.equal(both.kind,"both");
  assert.equal(both.cause.text,"пол восстановления включён: старший ценовой тренд −1 → 2; режим «переходный» → «защитный»","рождение кандидата transition не объясняет режим defensive");
  // Пауза между сменами базу сравнения не стирает: 80 → нет данных → 5 записывается как 80 → 5.
  m=tick(m,T0+6*HOUR,61_000,{strategic:"insufficient"});
  assert.deepEqual(m.target_change_log.at(-1),both,"исчезновение цели — не смена");
  m=tick(m,T0+7*HOUR,61_000,{strategic:"defensive"});
  assert.deepEqual([m.target_change_log.at(-1).from_pct,m.target_change_log.at(-1).to_pct,m.target_change_log.at(-1).direction],[80,5,"down"]);
  // Без данных сборщика причина оверлея выводится из собственных входов монитора (по идентификаторам).
  let own=tick(null,T0,60_000,{strategic:"defensive",mvrv:20,recovery:"watch",scores:{exchange_supply:-0.5}});
  own=tick(own,T0+HOUR,60_000,{strategic:"defensive",mvrv:20,recovery:"good",scores:{exchange_supply:0}});
  assert.equal(own.target_change_log.at(-1).cause.text,"пол восстановления включён: exchange_supply −0,5 → 0");
  // Журнал ограничен.
  let many=tick(null,T0,60_000,{strategic:"transition"});
  for(let i=1;i<=70;i++)many=tick(many,T0+i*HOUR,60_000,{strategic:i%2?"deteriorating":"transition"});
  assert.equal(many.target_change_log.length,TARGET_CHANGE_LOG_LIMIT);assert.equal(many.target_changes,70);
  // Построитель текста.
  assert.equal(targetChangeCauseV1({kind:"regime",strategicFrom:"transition",strategicTo:"deteriorating",regimeBirth:{strategic:{t:"x",candidate:"deteriorating",blocks:{},families:[],detectors:[{id:"macro_shock",from:"watch",to:"fired"}],note:null}}}).text,"детектор «Макрошок»: наблюдение → сработал");
  assert.equal(targetChangeCauseV1({kind:"regime",strategicFrom:"transition",strategicTo:"deteriorating",regimeBirth:{strategic:{t:"x",candidate:"deteriorating",blocks:{},families:[],detectors:[],note:"coverage"}}}).text,"изменилось покрытие данных");
  assert.equal(targetChangeRecordV1({at:iso(T0),price:1,previous:{target_pct:45},decision:{target_pct:45,strategic:"transition",binding_overlays:[]}}),null);
}

// ================= M8. Дневные строки, краткосрочный вердикт, теневой слой =================
{
  const values={tga_daily:887.4691234,g3_liquidity:null,gold_axis:0.59613473,sth_pricing:1.1140245,realized_pnl:1.00471012,options_structure:-4.13,oi_purge_24h:-0.98411,hash_ribbons:1.02312054};
  const m=tick(null,T0,60_000,{tactical:"spot_led"},{shadowValues:values});
  assert.equal(m.daily.at(-1).tactical,"spot_led");
  assert.deepEqual(m.daily.at(-1).shadow,{tga_daily:887.469,g3_liquidity:null,gold_axis:0.596135,sth_pricing:1.11402,realized_pnl:1.00471,options_structure:-4.13,oi_purge_24h:-0.98411,hash_ribbons:1.02312});
  assert.deepEqual(Object.keys(shadowRowValuesV1({})).sort(),[...SHADOW_CARD_IDS_V1].sort(),"все восемь карточек пишутся всегда");
  assert.equal(shadowRowValuesV1({tga_daily:"не число"}).tga_daily,null);assert.equal(shadowRowValuesV1(null),null);
  assert.equal(tick(null,T0,60_000).daily.at(-1).shadow,undefined,"прежний вызов без shadowValues строку не раздувает");
  assert.ok(m.shadow_evidence&&m.tactical_forward);
}
{
  // Доходность за 7 дней вперёд по краткосрочным состояниям — по закрытым суткам.
  const day=d=>iso(T0+d*DAY).slice(0,10),rows=[];
  for(let d=0;d<20;d++)rows.push({date:day(d),t:iso(T0+d*DAY+23*HOUR),price:100+d*(d%2?2:1),tactical:d<12?"balanced":"fragile"});
  const forward=tacticalForwardV1(rows,{date:day(19)}); // строка day(19) — текущие сутки, в счёт не входит
  assert.equal(forward.horizon_days,7);
  assert.deepEqual([forward.by_state.balanced.days,forward.by_state.balanced.completed,forward.by_state.fragile.days,forward.by_state.fragile.completed],[12,12,7,0]);
  const expected=Array.from({length:12},(_,d)=>(rows[d+7].price/rows[d].price-1)*100),sorted=[...expected].sort((a,b)=>a-b);
  assert.equal(forward.by_state.balanced.mean_fwd_pct,Number((expected.reduce((a,b)=>a+b,0)/12).toFixed(2)));
  assert.equal(forward.by_state.balanced.median_fwd_pct,Number(((sorted[5]+sorted[6])/2).toFixed(2)));
  assert.equal(forward.by_state.balanced.hit_rate,Number((expected.filter(x=>x>0).length/12).toFixed(2)));
  assert.ok(expected.some(x=>x<0)&&expected.some(x=>x>0),"фикстура: есть и положительные, и отрицательные исходы");
  assert.equal(forward.by_state.fragile.mean_fwd_pct,null,"без завершённых наблюдений среднего нет");
  assert.deepEqual(tacticalForwardV1(rows,{date:day(20)}).by_state.fragile.days,8,"после смены суток день входит в счёт");
  // пропуск суток: форвардная цена берётся только с точной даты
  assert.equal(tacticalForwardV1(rows.filter((_,d)=>d!==7),{date:day(19)}).by_state.balanced.completed,10);
}
{
  // Объявление: по одному утверждению на карточку, заморожено, без подгонки (пороги — ноль, единица, заявленные в описании).
  assert.ok(Object.isFrozen(SHADOW_HYPOTHESES_V1)&&Object.isFrozen(SHADOW_HYPOTHESES_V1.cards.tga_daily.condition));
  assert.deepEqual(SHADOW_CARD_IDS_V1,["tga_daily","g3_liquidity","gold_axis","sth_pricing","realized_pnl","options_structure","oi_purge_24h","hash_ribbons"]);
  assert.equal(SHADOW_HYPOTHESES_V1.declared_at,"2026-10-10");
  for(const [id,h] of Object.entries(SHADOW_HYPOTHESES_V1.cards)){
    if(h.statement===null){assert.equal(h.condition,null,`${id}: без утверждения нет и условия`);continue;}
    assert.ok(h.statement.length>30&&h.rationale.length>30&&[1,-1].includes(h.expected_sign)&&[7,30].includes(h.horizon_days)&&["level","change","cross_up"].includes(h.condition.kind),`${id}: утверждение неполно`);
  }
  assert.equal(SHADOW_HYPOTHESES_V1.cards.gold_axis.statement,null,"карточка без направленного утверждения так и объявлена");
  // Условия.
  const series=values=>values.map((value,i)=>({date:iso(T0+i*DAY).slice(0,10),value}));
  const level=SHADOW_HYPOTHESES_V1.cards.sth_pricing.condition,change=SHADOW_HYPOTHESES_V1.cards.tga_daily.condition,cross=SHADOW_HYPOTHESES_V1.cards.hash_ribbons.condition;
  assert.deepEqual([1.2,1,0.99,null].map((v,i,a)=>shadowConditionStateV1(level,series(a),i)),[true,true,false,null]);
  const tga=series(Array.from({length:40},(_,i)=>900-i));
  assert.equal(shadowConditionStateV1(change,tga,27),null,"до 28 суток истории условие на изменение не оценивается");
  assert.equal(shadowConditionStateV1(change,tga,28),true);
  assert.equal(shadowConditionStateV1(change,series(Array.from({length:40},(_,i)=>900+i)),30),false);
  const ribbons=series([...Array(10).fill(0.97),...Array(45).fill(1.02)]);
  assert.equal(shadowConditionStateV1(cross,ribbons,5),false,"лента инвертирована — креста нет");
  assert.equal(shadowConditionStateV1(cross,ribbons,12),true,"первые 30 суток после возврата выше 1");
  assert.equal(shadowConditionStateV1(cross,ribbons,39),true);assert.equal(shadowConditionStateV1(cross,ribbons,41),false,"через 30 суток окно креста закрыто");
  assert.equal(shadowConditionStateV1(cross,series(Array(10).fill(1.02)),9),null,"короткая история: отсутствие креста утверждать нельзя");
  // Счёт: только дни не раньше объявления, только закрытые сутки, группы «выполнено» и «не выполнено».
  const start=Date.parse("2026-10-08T00:00:00.000Z"),rows=[];
  for(let d=0;d<60;d++)rows.push({date:iso(start+d*DAY).slice(0,10),t:iso(start+d*DAY+23*HOUR),price:100*(1+0.01*d),shadow:{...shadowRowValuesV1({}),sth_pricing:d<30?0.9:1.1,options_structure:d%2?1:-1}});
  const evidence=shadowEvidenceV1(rows,{date:iso(start+59*DAY).slice(0,10)});
  assert.equal(evidence.declared_at,"2026-10-10");
  const sth=evidence.cards.sth_pricing;
  assert.deepEqual([sth.off.days,sth.on.days,sth.off.completed,sth.on.completed],[28,29,27,0],"дни до объявления и текущие сутки в счёт не входят; завершены только наблюдения с ценой через 30 дней");
  assert.equal(sth.blocks_independent,1,"27 перекрывающихся 30-дневных окон — одно независимое");
  assert.equal(sth.off.mean_fwd_pct,Number((rows.slice(2,29).reduce((s,r,i)=>s+(rows[i+2+30].price/r.price-1)*100,0)/27).toFixed(2)));
  const options=evidence.cards.options_structure;
  assert.deepEqual([options.on.days+options.off.days,options.on.completed+options.off.completed,options.blocks_independent],[57,50,8]);
  assert.deepEqual(evidence.cards.gold_axis,{statement:null,horizon_days:null,expected_sign:null,observed_days:0});
  assert.equal(evidence.cards.tga_daily.on.days+evidence.cards.tga_daily.off.days,0,"значения нет — день не входит ни в одну группу");
  assert.ok(!JSON.stringify(evidence).match(/confirmed|refuted|verdict|подтвержд|опроверг/i),"монитор только считает, выводов не делает");
}

// ================= M7. Числа против порогов; инциденты — только операционные =================
{
  let m=null;
  for(let d=0;d<=185;d++)m=tick(m,T0+d*DAY+23*HOUR,60_000*(1+0.004*d),{strategic:"defensive"});
  const n=m.health.performance_numbers,cfg=MODEL_POLICY_V1.forward_monitoring;
  assert.equal(m.health.performance_status,"investigate","правило v1 зашито в замороженный контракт и вычисляется как было");
  assert.deepEqual(n.thresholds.investigation,{min_days:180,...cfg.investigation_rules});
  assert.deepEqual(n.thresholds.retirement,{min_days:cfg.minimum_retirement_days,min_target_changes:cfg.minimum_target_changes,...cfg.retirement_requires_all});
  assert.equal(n.net_return_gap_vs_fixed_50_pct_points,Number((m.performance.fixed_50.net_return_pct-m.performance.policy_v1.net_return_pct).toFixed(4)));
  assert.equal(n.best_simple_benchmark,"buy_and_hold");
  assert.equal(n.sharpe_gap_vs_best_simple_benchmark,Number((m.performance.buy_and_hold.sharpe_excess-m.performance.policy_v1.sharpe_excess).toFixed(4)));
  assert.equal(n.investigation_numbers_met,true);assert.equal(n.retirement_numbers_met,false);
  const early=tick(tick(null,T0,60_000),T0+DAY,61_000);
  assert.equal(early.health.performance_status,"collecting");
  assert.ok(early.health.performance_numbers.thresholds&&Number.isFinite(early.health.performance_numbers.net_return_gap_vs_fixed_50_pct_points),"пороги и разрыв доходности публикуются с первого дня");
  assert.deepEqual([early.health.performance_numbers.sharpe_gap_vs_best_simple_benchmark,early.health.performance_numbers.investigation_numbers_met],[null,null],"пока Sharpe не посчитать, разрыва и вывода по числам нет");
  // Статусы результативности инцидент не открывают: сторож смотрит только на операционное.
  const built=mkDecision(T0+185*DAY+23*HOUR,{strategic:"defensive"});
  const snapshot={schema:3,version:JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version,generated_at:m.updated_at,policy_suite:{...POLICY_SUITE_V1},decision:built.decision,source_vintages:VINTAGES,monitoring:structuredClone(m)};
  const at=Date.parse(m.updated_at)+MIN;
  assert.deepEqual(validateSnapshotV1(snapshot,at).issues,[],"investigate по результативности — не инцидент");
  snapshot.monitoring.health.performance_status="retire_candidate";snapshot.monitoring.v2_review.r2_timing.status="investigate";snapshot.monitoring.v2_review.r1_protection.status="investigate";snapshot.monitoring.v2_candidate.acceptance_status.status="falsified";snapshot.monitoring.v3_candidate={acceptance_status:{status:"falsified"}};
  assert.deepEqual(validateSnapshotV1(snapshot,at).issues,[],"ни один статус результативности или приёмки не открывает инцидент");
  snapshot.monitoring.health.operational_status="paused";
  assert.ok(validateSnapshotV1(snapshot,at).issues.some(x=>x.startsWith("forward_monitor_not_healthy")),"операционный отказ инцидент открывает");
  // Новые модули сверяются с тем же льготным окном выкладки.
  const assets={ok:false,issues:["asset_http:policy-v3-candidate.mjs:404","asset_http:shadow-hypotheses-v1.mjs:404"],checked_assets:9};
  const fresh={version:"0.0.0-старый",generated_at:iso(at-30*MIN)},stale={version:"0.0.0-старый",generated_at:iso(at-2*HOUR)},same={version:snapshot.version,generated_at:iso(at-30*MIN)};
  assert.deepEqual(releaseWindowAssetIssuesV1(fresh,assets,at),{issues:[],suppressed:assets.issues},"свежий рассинхрон версий — окно выкладки, а не инцидент");
  assert.deepEqual(releaseWindowAssetIssuesV1(stale,assets,at).issues,assets.issues,"протухшая страница льготу теряет");
  assert.deepEqual(releaseWindowAssetIssuesV1(same,assets,at).issues,assets.issues,"при совпавшей версии расхождение модулей — инцидент");
}

// ================= M9. Старт от состояния 2.13.0, прежний вызов, размер =================
{
  const F=MONITOR_FIXTURE_V2130,now=Date.parse(F.generated_at)+15*MIN,previous=structuredClone(F.monitoring);
  assert.equal(F.version,"2.13.0");assert.equal(previous.strategy_meta,undefined,"фикстура: состояние прежней формы");
  assert.equal(decisionEventsCompleteV1(previous),true,"список событий решения полон с генезиса");
  const decision={...F.decision};
  const call=extra=>updateForwardMonitorV1({previousMonitor:previous,now,price:F.price*1.002,decision,inputSummary:{scores:{},blocks:{},detectors:[],metrics:[],source_vintages_sha256:null},sourceVintages:{contract_sha256:F.source_vintages_sha256},cashQuotePct:previous.last_cash_quote_pct,cashQuoteBasis:previous.last_cash_quote_basis,priceSeries:[],previousSnapshotPresent:true,regimeMeta:F.regime_meta,...extra});
  const engine=({inputs})=>({state:{k:1},variants:Object.fromEntries(["policy_v3_shadow","v1_daily_close","v1_floor_handoff","v1_no_cftc"].map(name=>[name,{target_pct:inputs.v1.target_pct}]))});
  const m=call({variantInputs:variantInputs(45),variantEngine:engine,shadowValues:{tga_daily:887.5}});
  // Без сброса и без разрыва цепи.
  assert.equal(m.started_at,"2026-07-19T06:30:22.915Z");assert.deepEqual(m.reset_events,[]);
  assert.equal(m.decision_log.at(-1).previous_log_hash,previous.decision_log.at(-1).log_hash);assert.equal(verifyDecisionLogChainV1(m.decision_log).ok,true);
  assert.equal(m.target_changes,15);assert.equal(m.state_changes,21);
  // Прежние восемь линий: тот же расчёт, что в 2.13.0.
  const dt=15*MIN,cashEffective=((1/(1-previous.last_cash_quote_pct/100*91/360))**(365.25/91)-1),cashReturn=(1+cashEffective)**(dt/(365.25*DAY))-1;
  for(const [name,old] of Object.entries(previous.strategies)){
    const w=old.current_target_pct/100,target=name==="trend_vol_25"?0:old.current_target_pct,expected=old.nav*(1+w*0.002+(1-w)*cashReturn)*(1-Math.abs(target-old.current_target_pct)/100*COST);
    assert.ok(near(m.strategies[name].nav,expected,1e-12),`${name}: NAV продолжается без пересчёта прошлого`);
  }
  // Новые линии рождаются с NAV = 1 и записью старта.
  for(const name of ["policy_v3_shadow","v1_daily_close","v1_floor_handoff","v1_no_cftc","policy_v1_tranched"]){
    assert.ok(near(m.strategies[name].nav,1-0.45*COST,1e-12),`${name}: рождение с NAV = 1`);
    assert.equal(m.strategy_meta[name].started_at,iso(now));assert.ok(near(m.strategy_meta[name].base.policy_v1_nav,m.strategies.policy_v1.nav,1e-15));
  }
  // Старты прежних линий восстановлены.
  assert.equal(m.strategy_meta.policy_v1.started_at,"2026-07-19T06:30:22.915Z");assert.equal(m.strategy_meta.policy_v1.start_price,64686.945);
  assert.equal(m.strategy_meta.policy_v2_shadow.started_at,"2026-07-22T09:03:56.510Z");assert.equal(m.strategy_meta.static_theta.started_at,"2026-07-22T09:03:56.510Z");
  assert.ok(near(m.strategy_meta.policy_v2_shadow.base.policy_v1_w_days,(5*(Date.parse("2026-07-21T01:51:00.411Z")-Date.parse("2026-07-19T06:30:22.915Z"))+20*(Date.parse("2026-07-22T02:51:10.456Z")-Date.parse("2026-07-21T01:51:00.411Z"))+80*(Date.parse("2026-07-22T09:03:56.510Z")-Date.parse("2026-07-22T02:51:10.456Z")))/DAY,1e-9),"путь policy_v1 на рождение тени — из событий решения");
  // Честный ноль тайминга на реальном окне (отчёт аудита, 4.1: доля 32,89 %, тайминг −7,43 п.п. по прогонам).
  const w=m.timing_null.since_start;
  assert.equal(w.share_source,"exact");assert.ok(Math.abs(w.share_pct-32.9)<=0.011,`доля политики за окно: ${w.share_pct}`);
  assert.ok(w.timing_pp<-7&&w.timing_pp>-8&&w.level_pp<-18&&w.level_pp>-19&&w.costs_pp<-0.4&&w.costs_pp>-0.45,`разложение: ${JSON.stringify(w)}`);
  assert.ok(near(m.strategies.policy_v1.gross_nav*(1-0.05*COST)*[15,60,35,40,15,15,75,35,40,15,60,60,25,25,25].reduce((x,d)=>x*(1-d/100*COST),1),m.strategies.policy_v1.nav,1e-12),"валовой NAV политики = NAV / (вход и пятнадцать смен цели)");
  // Приёмка v2: теневые дни от рождения тени, два эпизода, разрыв на общем окне.
  const acc=m.v2_candidate.acceptance_status;
  assert.equal(acc.shadow_days,80);assert.equal(acc.recovery_episodes_observed,2);assert.equal(acc.meets.episode_or_180d,true);
  assert.equal(acc.sharpe_gap_vs_v1,m.comparisons.policy_v2_shadow.sharpe_gap);assert.ok(Math.abs(acc.sharpe_gap_vs_v1-0.364)<0.002,`разрыв Sharpe на общем окне: ${acc.sharpe_gap_vs_v1}`);
  assert.ok(Math.abs(m.comparisons.policy_v2_shadow.net_return_gap_pp-0.98)<0.02);
  // Sharpe по закрытым суткам: опубликовано 0,2537, по закрытым суткам 0,2250.
  assert.ok(Math.abs(previous.performance.policy_v1.sharpe_excess-0.2537)<1e-4&&Math.abs(m.performance.policy_v1.sharpe_excess-0.2250)<1e-4);
  // Журнал смен цели засеян из таблицы и сверен с событиями.
  assert.equal(m.target_change_log.length,16);assert.deepEqual(m.backfill.target_changes,{from_events:16,from_table:16,table_rows_unconfirmed:[]});
  assert.deepEqual(m.target_change_log.map(x=>x.to_pct),[5,20,80,45,5,20,5,80,45,5,20,80,20,45,20,45]);
  assert.equal(m.target_change_log.at(-1).price,86197.93);assert.equal(m.target_change_log.at(-1).cause.candidate_since,"2026-09-21T07:24:19.700Z");
  for(const record of m.target_change_log)assert.ok(/^[а-яё]/.test(record.cause.text)&&!/[.!]$/.test(record.cause.text)&&!record.cause.text.includes(" · "),`текст причины в засеянной записи: ${record.cause.text}`);
  for(const row of MONITOR_BACKFILL_V1.target_changes){const event=previous.decision_events.find(e=>e.t===row.t);assert.ok(event&&event.target_pct===row.to_pct&&event.strategic===row.strategic_to&&JSON.stringify(event.binding_overlays)===JSON.stringify(row.overlays_to),`таблица засева расходится с событиями: ${row.t}`);}
  // Просадка после графта исправлена один раз.
  assert.equal(previous.strategies.policy_v1.max_drawdown_pct,-3.656930649291834);assert.equal(m.strategies.policy_v1.max_drawdown_pct,-3.70811014853204);
  assert.deepEqual(m.corrections,[{t:iso(now),field:"strategies.policy_v1.max_drawdown_pct",from:-3.656930649291834,to:-3.70811014853204,reason:"графт 21.07 потерял внутридневной пик"}]);
  // Дневные строки прежней формы досеяны; краткосрочный вердикт считается за всё окно.
  assert.ok(m.daily.every(r=>typeof r.tactical==="string"&&Array.isArray(r.path?.policy_v1)));
  assert.deepEqual(m.daily.filter(r=>r.v2_floor).map(r=>r.date),MONITOR_BACKFILL_V1.v2_floor_days);
  assert.deepEqual([m.tactical_forward.by_state.balanced.days,m.tactical_forward.by_state.balanced.completed],[79,72]);
  assert.equal(m.shadow_hysteresis.risk_off_confirmed_under_min_interval,3,"накопленное значение счётчика сохранено");
  // Идемпотентность: второй прогон ничего не досевает и не исправляет повторно.
  const again=updateForwardMonitorV1({previousMonitor:m,now:now+15*MIN,price:F.price,decision,inputSummary:{scores:{},blocks:{},detectors:[],metrics:[],source_vintages_sha256:null},sourceVintages:{contract_sha256:F.source_vintages_sha256},cashQuotePct:4,priceSeries:[],regimeMeta:F.regime_meta,variantInputs:variantInputs(45),variantEngine:engine});
  assert.equal(again.corrections.length,1);assert.deepEqual(again.target_change_log,m.target_change_log);assert.deepEqual(again.strategy_meta,m.strategy_meta);assert.deepEqual(again.backfill,m.backfill);
  assert.deepEqual(again.daily.slice(0,-1).map(r=>r.path),m.daily.slice(0,-1).map(r=>r.path),"закрытые дневные строки задним числом не меняются");
  assert.deepEqual(applyMonitorBackfillV1(structuredClone(again),{at:iso(now),costRate:COST}),again,"засев идемпотентен");
  // Более глубокая просадка, случившаяся до выкладки, уже посчитана от верного пика — не трогается.
  const deeper=structuredClone(F.monitoring);deeper.strategies.policy_v1.max_drawdown_pct=-4.2;
  const kept=updateForwardMonitorV1({previousMonitor:deeper,now,price:F.price,decision,inputSummary:{scores:{},blocks:{},detectors:[],metrics:[],source_vintages_sha256:null},sourceVintages:{contract_sha256:F.source_vintages_sha256},cashQuotePct:4,priceSeries:[]});
  assert.equal(kept.strategies.policy_v1.max_drawdown_pct,-4.2);assert.equal(kept.corrections,undefined);
  // Таблица засева сверяется с событиями: несовпавшая строка не применяется.
  const drift=structuredClone(F.monitoring);drift.decision_events.find(e=>e.t==="2026-09-16T02:08:44.363Z").target_pct=25;
  const drifted=structuredClone(drift);applyMonitorBackfillV1(drifted,{at:iso(now),costRate:COST});
  assert.deepEqual(drifted.backfill.target_changes.table_rows_unconfirmed,["2026-09-16T02:08:44.363Z","2026-09-23T07:39:19.463Z"],"строки таблицы, не подтверждённые событиями, перечислены");
  assert.equal(drifted.target_change_log.find(x=>x.t==="2026-09-16T02:08:44.363Z").price,null,"вместо них — запись из самих событий");
  assert.equal(drifted.strategies.policy_v1.gross_nav,undefined,"оборот по событиям не сошёлся с исполненным — путь из них не засевается");
  // Прежний вызов без новых параметров работает и даёт те же NAV прежних линий.
  const legacy=call({});
  for(const name of Object.keys(previous.strategies))assert.equal(legacy.strategies[name].nav,m.strategies[name].nav,`прежний вызов: ${name}`);
  assert.equal(legacy.decision_log.at(-1).v3,undefined);assert.equal(legacy.v3_candidate,undefined);assert.equal(legacy.daily.at(-1).shadow,undefined);
  assert.equal(verifyDecisionLogChainV1(legacy.decision_log).ok,true);
  // Чужое состояние прежней формы (не боевой генезис): таблица не применяется, общие правила работают.
  let foreign=tick(null,T0,60_000,{strategic:"deteriorating"});foreign=tick(foreign,T0+DAY,61_000,{strategic:"transition"});
  for(const key of ["strategy_meta","target_change_log","timing_null","comparisons","tranche_state"])delete foreign[key];
  delete foreign.strategies.policy_v1_tranched;for(const s of Object.values(foreign.strategies)){delete s.gross_nav;delete s.exposure_pct_days;}for(const row of foreign.daily){delete row.path;delete row.tactical;delete row.targets.policy_v1_tranched;delete row.nav.policy_v1_tranched;}
  const healed=tick(foreign,T0+2*DAY,62_000,{strategic:"transition"});
  assert.deepEqual(healed.target_change_log.map(x=>[x.kind,x.to_pct,x.price]),[["start",20,null],["regime",45,null]],"журнал собран из событий; цен в них нет");
  assert.ok(near(healed.strategies.policy_v1.exposure_pct_days,20+45,1e-9)&&healed.daily.every(r=>r.tactical==="balanced"&&Array.isArray(r.path?.policy_v1)));
  assert.equal(healed.strategy_meta.policy_v1.approximate,true,"старт чужой линии известен приблизительно и помечен");
  assert.equal(healed.corrections,undefined);
}
{
  // Отказ необязательного расчёта не останавливает учёт и не трогает решение: след в optional_errors.
  const poisoned={get families(){throw new Error("сломанный tick_diff");},detectors:[]};
  let m=tick(null,T0,60_000,{strategic:"transition"});
  const clean=tick(m,T0+HOUR,61_000,{strategic:"deteriorating"}),failed=tick(m,T0+HOUR,61_000,{strategic:"transition",mvrv:20,recovery:"good"},{tickDiff:poisoned}),reference=tick(m,T0+HOUR,61_000,{strategic:"transition",mvrv:20,recovery:"good"});
  assert.deepEqual(failed.optional_errors,[{t:iso(T0+HOUR),part:"target_change_log",error:"сломанный tick_diff"}]);
  assert.equal(clean.optional_errors,undefined);
  for(const name of Object.keys(reference.strategies))assert.deepEqual(failed.strategies[name],reference.strategies[name],`отказ необязательного расчёта не трогает учёт: ${name}`);
  assert.equal(failed.decision_log.length,2);assert.equal(verifyDecisionLogChainV1(failed.decision_log).ok,true);assert.deepEqual(failed.health,reference.health);
  assert.equal(failed.target_change_log.length,1,"несобранная запись не выдумывается");
  // Разрыв учёта: прогон прежней версией (откат релиза) не ведёт путь политики и новые линии.
  // Эмуляция: прогон новой версией, после которого путь, новые линии и отметка учёта возвращены к прежним значениям.
  const engine=({inputs})=>({state:{},variants:{policy_v3_shadow:{target_pct:inputs.v1.target_pct}}});
  let live=tick(null,T0,60_000,{strategic:"deteriorating"},{variantInputs:variantInputs(20),variantEngine:engine});
  live=tick(live,T0+DAY,62_000,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:engine});
  const rolled=tick(live,T0+2*DAY,66_000,{strategic:"transition"}); // «прежняя версия»: старые линии и журнал ведутся
  for(const name of ["policy_v3_shadow","policy_v1_tranched"])rolled.strategies[name]=structuredClone(live.strategies[name]);
  Object.assign(rolled.strategies.policy_v1,{gross_nav:live.strategies.policy_v1.gross_nav,exposure_pct_days:live.strategies.policy_v1.exposure_pct_days});
  rolled.accounting_at=live.accounting_at;delete rolled.daily.at(-1).path;
  const back=tick(rolled,T0+3*DAY,67_000,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:engine});
  assert.deepEqual(back.line_restarts,[{t:iso(T0+3*DAY),reason:"run_without_line_accounting",accounted_until:iso(T0+DAY),last_run:iso(T0+2*DAY),lines:["policy_v3_shadow","policy_v1_tranched"]}]);
  for(const name of ["policy_v3_shadow","policy_v1_tranched"]){
    assert.equal(back.strategy_meta[name].started_at,iso(T0+3*DAY),`${name}: линия рождена заново`);assert.ok(near(back.strategies[name].nav,1-0.45*COST,1e-12));
    assert.ok(back.daily.slice(0,-1).every(row=>row.nav[name]===undefined&&row.targets[name]===undefined),`${name}: прежняя жизнь линии из дневных строк убрана`);
  }
  // Путь прежней жизни кандидата уходит из строк вместе с её NAV: иначе через год он стал бы началом окна.
  assert.ok(live.daily.every(row=>Array.isArray(row.path?.policy_v3_shadow)),"фикстура: до разрыва путь кандидата в строках был");
  assert.deepEqual(back.daily.map(row=>Array.isArray(row.path?.policy_v3_shadow)),[false,false,false,true],"после перезапуска путь кандидата есть только в строке новой жизни");
  assert.ok(near(back.strategies.policy_v1.exposure_pct_days,20+45+45,1e-9),"путь политики пересчитан из событий и включает пропущенный интервал");
  assert.ok(near(back.strategies.policy_v1.gross_nav*(1-0.2*COST)*(1-0.25*COST),back.strategies.policy_v1.nav,1e-12));
  assert.ok(back.daily.every(row=>Array.isArray(row.path?.policy_v1)));
  assert.equal(back.accounting_at,iso(T0+3*DAY));
  assert.equal(tick(back,T0+4*DAY,67_000,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:engine}).line_restarts.length,1,"без разрыва линии не перезапускаются");
}
{
  // Размер. Публичный снимок ограничен 3,0 МБ; страж в unit-test требует запас 150 КБ на проекции
  // стационара (370 дневных строк, 400 записей журнала). Новые поля обязаны в него уложиться —
  // иначе первая же публикация новой формы заблокировала бы сбор. Это ПРИЁМОЧНАЯ проверка перед
  // переходом: она выполняется, пока закоммиченный снимок прежней формы. Монитор продвигается на
  // один прогон со всеми новыми параметрами, и проекция считается с запасом: все 400 записей
  // журнала уже новой формы, журнал смен цели заполнен, состояние движка упёрлось в потолок.
  // После первой публикации новой формы размер сторожит unit-test на фактическом снимке.
  const snap=JSON.parse(readFileSync(new URL("../docs/snapshot.json",import.meta.url),"utf8"));
  if(snap.monitoring?.daily?.length&&snap.monitoring?.decision_log?.length&&snap.history?.length&&snap.decision&&snap.monitoring.strategy_meta===undefined){
    const cfg=MODEL_POLICY_V1.forward_monitoring,now=Date.parse(snap.generated_at)+15*MIN;
    const engine=({inputs})=>({state:{fix_day:20736,fixed:45,closes:[1,2,3]},variants:{policy_v3_shadow:{target_pct:inputs.v1.target_pct,base_target_pct:45,state:"transition",candidate:"transition",fix_at:iso(now),next_fix_at:iso(now+DAY),floor:{active:false,rung:null,closes:0},binding_overlays:[],inputs:{mvrv_percentile:42.402464065708415,mvrv_percentile_deep:42.821917808219176,hashrate_30d_change_pct:-1.2345678,exchange_supply_7d_percentile:55.123456,trend_closed_day_score:2,deep_window_used:true}},v1_daily_close:{target_pct:45,state:"transition",fix_at:iso(now)},v1_floor_handoff:{target_pct:45,carry:false},v1_no_cftc:{target_pct:45,state:"transition",candidate:"transition"}}});
    const metricsSummary=snap.monitoring.daily.at(-1).input_summary;
    const inputSummary=metricsSummary?{scores:{strategic:metricsSummary.scores[0],tactical:metricsSummary.scores[1],critical_coverage_ok:metricsSummary.scores[2]},blocks:Object.fromEntries(metricsSummary.blocks.map(b=>[b[0],{strategic_score:b[1],strategic_coverage:b[2],tactical_score:b[3],tactical_coverage:b[4]}])),detectors:metricsSummary.detectors.map(d=>({id:d[0],state:d[1]})),metrics:metricsSummary.metrics.map(x=>({id:x[0],score:x[1],value_num:x[2],observed_at:x[3],stale:x[4],source:x[5]})),source_vintages_sha256:metricsSummary.source_vintages_sha256}:{scores:{},blocks:{},detectors:[],metrics:[],source_vintages_sha256:null};
    const monitoring=updateForwardMonitorV1({previousMonitor:snap.monitoring,now,price:snap.price,decision:snap.decision,inputSummary,sourceVintages:snap.source_vintages,cashQuotePct:snap.monitoring.last_cash_quote_pct,priceSeries:[],previousSnapshotPresent:true,regimeMeta:snap.regime_meta,variantInputs:variantInputs(snap.decision.target_pct),variantEngine:engine,shadowValues:Object.fromEntries(SHADOW_CARD_IDS_V1.map(id=>[id,snap.metrics?.find(x=>x.id===id)?.value_num??null])),tickDiff:{families:[],detectors:[]}});
    const next={...snap,monitoring},rowBytes=jsonBytesV1(monitoring.daily.at(-1)),recordBytes=jsonBytesV1(monitoring.decision_log.at(-1));
    const logMigration=monitoring.decision_log.slice(0,-1).reduce((sum,record)=>sum+Math.max(0,recordBytes-jsonBytesV1(record)),0);
    const changeLogGrowth=Math.max(0,TARGET_CHANGE_LOG_LIMIT-monitoring.target_change_log.length)*Math.max(...monitoring.target_change_log.map(jsonBytesV1));
    const projected=projectedPublicSnapshotBytesV1({snapshotBytes:jsonBytesV1(next),snapshot:next,dailyLimit:cfg.daily_history_days,decisionLogLimit:cfg.observation_log_limit,historyMaxRows:HISTORY_MAX_ROWS,dailyInputSummaryDays:DAILY_INPUT_SUMMARY_DAYS})+logMigration+changeLogGrowth+(VARIANTS_STATE_MAX_BYTES-jsonBytesV1(monitoring.variants_state));
    if(process.env.MONITOR_SIZE_REPORT)console.log(JSON.stringify({snapshot_bytes:jsonBytesV1(snap),next_bytes:jsonBytesV1(next),daily_row_full:rowBytes,daily_row_without_inputs:rowBytes-jsonBytesV1(monitoring.daily.at(-1).input_summary),log_record:recordBytes,log_migration:logMigration,change_log_growth:changeLogGrowth,projected,margin:PUBLIC_SNAPSHOT_MAX_BYTES-projected}));
    assert.ok(rowBytes-jsonBytesV1(monitoring.daily.at(-1).input_summary)<1_800,`дневная строка без входов: ${rowBytes-jsonBytesV1(monitoring.daily.at(-1).input_summary)} байт`);
    assert.ok(recordBytes<1_700,`запись журнала: ${recordBytes} байт`);
    assert.ok(PUBLIC_SNAPSHOT_MAX_BYTES-projected>150_000,`проекция стационара с новыми полями ${(projected/1e6).toFixed(3)} МБ: запас до капа меньше 150 КБ`);
    // Все пределы разом (ревью 13.10.2026, Н8): тысяча событий решения, остальные списки монитора на
    // пределе, состояние движка и блоки линий на потолках, история на своём бюджете — первый снимок
    // новой формы обязан помещаться в кап с запасом стража, иначе предупреждение горело бы с первого дня.
    const atLimits=publicSnapshotAtLimitsV1({snapshot:next,snapshotBytes:jsonBytesV1(next),...monitorRetentionLimitsV1()});
    if(process.env.MONITOR_SIZE_REPORT)console.log(JSON.stringify(atLimits));
    assert.ok(atLimits.parts.find(x=>x.name==="monitoring.decision_events").growth>300_000,"события решения на пределе — самая большая часть после дневных строк");
    assert.equal(publicSnapshotAtLimitsWarningV1(atLimits),null,`все пределы разом: ${(atLimits.total/1e6).toFixed(3)} МБ, запас ${(atLimits.margin/1e3).toFixed(0)} КБ — меньше запаса стража`);
  }
}

// ================= Правки по независимому ревью 13.10.2026 =================
// ---------- Н3. Линия старше срока хранения дневных строк ----------
{
  // Монитор живёт 435 суток; линии движка рождаются на пятые сутки в 06:30 и живут 430. Закрывающий
  // прогон — каждые сутки в 23:00, в каждые пятые сутки есть ещё прогон в 06:30: цели меняются и
  // внутри дня, поэтому доля по времени не равна доле по целям закрытия. Рядом ведётся независимый
  // учёт: NAV, валовой NAV и накопленная доля каждой линии по прогонам и ПОЛНАЯ дневная сетка, из
  // которой ничего не уходит. Монитор обязан совпадать с пересчётом по ней: пока рождение линии в
  // его дневных строках — на окне с рождения, после — на скользящем окне 365 суток, с пометкой.
  const BIRTH=4,LAST=BIRTH+430,D0=Math.floor(T0/DAY)*DAY,LINES=["policy_v3_shadow","v1_daily_close","v1_floor_handoff","v1_no_cftc"];
  const REGIMES=["transition","deteriorating","defensive","transition","constructive","deteriorating"];
  let seed=20261013;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const cashStep=dt=>(1+((1/(1-4/100*91/360))**(365.25/91)-1))**(dt/(365.25*DAY))-1;
  const acc={},closes=[],born={},v1Targets=[];
  let m=null,price=60_000,cash=1,lastT=null,lastPrice=null,run=0;
  // Независимый учёт: доходность интервала получает ПРЕЖНЯЯ цель, издержки — модуль смены цели.
  function account(t){
    const c=lastT===null?0:cashStep(t-lastT),r=lastT===null?0:price/lastPrice-1;
    cash*=1+c;
    for(const [name,strategy] of Object.entries(m.strategies)){
      const target=strategy.current_target_pct,a=acc[name];
      if(!a){acc[name]={nav:1-Math.abs(target)/100*COST,gross:1,w:0,target};born[name]={t,price,cash,lines:null};continue;}
      const g=a.target/100*r+(1-a.target/100)*c;
      a.nav*=(1+g)*(1-Math.abs(target-a.target)/100*COST);a.gross*=1+g;a.w+=a.target*(t-lastT)/DAY;a.target=target;
    }
    lastT=t;lastPrice=price;
    for(const b of Object.values(born))if(b.lines===null)b.lines=structuredClone(acc);
    const row={date:iso(t).slice(0,10),t,price,cash,lines:structuredClone(acc)};
    if(closes.length&&closes.at(-1).date===row.date)closes[closes.length-1]=row;else closes.push(row);
  }
  // Точка начала окна: линия открывается в ней и платит вход со своей доли. В точке собственного
  // рождения NAV линии уже за вычетом входа, поэтому отношение даёт опубликованный NAV.
  const point=(row,name)=>{const s=row.lines[name];return{t:row.t,price:row.price,cash:row.cash,nav:s.nav,entry:1-Math.abs(s.target)/100*COST,gross:s.gross,w:s.w};};
  // Линия на окне [start, сейчас]: доля по времени, честный ноль по полной дневной сетке, тайминг.
  function onWindow(name,start){
    const end=closes.at(-1),a=end.lines[name],days=(end.t-start.t)/DAY,share=(a.w-start.w)/days/100;
    let g=1,p=start.price,c=start.cash;
    for(const row of closes){if(row.t<=start.t)continue;g*=1+share*(row.price/p-1)+(1-share)*(row.cash/c-1);p=row.price;c=row.cash;}
    const net=a.nav/start.nav*start.entry;
    return{days,share:share*100,net:(net-1)*100,timing:(a.gross/start.gross-g)*100,vsNull:(net-g*(1-Math.abs(share)*COST))*100};
  }
  const rowsFrom=fromT=>closes.filter(row=>row.t>=fromT);
  const sharpeGap=(name,fromT,today)=>{const rows=rowsFrom(fromT).filter(row=>row.date<today&&row.lines[name]&&row.lines.policy_v1),of=key=>excessSharpeV2(rows.map(row=>({t:row.t,nav:row.lines[key].nav,cash:row.cash}))).sharpe_excess,own=of(name),policy=of("policy_v1");return{gap:own===null||policy===null?null:own-policy,closed:rows.length-1};};
  const drawdown=(rows,name,startNav=null)=>{let peak=startNav,worst=0;for(const row of rows){const nav=row.lines[name]?.nav;if(nav===undefined)continue;peak=peak===null?nav:Math.max(peak,nav);worst=Math.min(worst,(nav/peak-1)*100);}return worst;};
  const episodes=(rows,a,b)=>{let n=0,days=0,open=false;for(const row of rows){const x=row.lines[a]?.target,y=row.lines[b]?.target;if(x===undefined||y===undefined)continue;const differs=Math.abs(x-y)>1e-9;if(differs){days++;if(!open)n++;}open=differs;}return{episodes:n,days};};
  const stored=now=>closes.filter(row=>now-row.t<=370*DAY);
  const rollingStart=(name,now,today)=>closes.filter(row=>row.date<today&&row.t<=now-365*DAY&&row.lines[name]).at(-1);

  // Сверка блока сравнения линии и чисел приёмки кандидата с пересчётом. basis — ожидаемое окно.
  function verifyLine(name,basis,now,label){
    const today=iso(now).slice(0,10),c=m.comparisons[name],start=basis==="birth"?born[name]:rollingStart(name,now,today),rows=rowsFrom(start.t);
    const own=onWindow(name,point(start,name)),pol=onWindow("policy_v1",point(start,"policy_v1")),sharpe=sharpeGap(name,start.t,today);
    assert.deepEqual([c.basis,c.from,c.vs],[basis,iso(start.t),"policy_v1"],`${label}: окно сравнения ${name}`);
    assert.ok(near(c.days,own.days,0.006),`${label}: длина окна ${name}: ${c.days} / ${own.days}`);
    assert.deepEqual([c.since_birth,c.window_days],basis==="rolling"?[null,365]:[undefined,undefined],`${label}: закрытое окно с рождения помечено, открытое — нет`);
    assert.ok(near(c.net_return_gap_pp,own.net-pol.net,1e-4),`${label}: разница доходностей ${name} на окне: ${c.net_return_gap_pp} / ${own.net-pol.net}`);
    assert.ok((sharpe.gap===null?c.sharpe_gap===null:c.sharpe_gap!==null&&near(c.sharpe_gap,sharpe.gap,1e-4))&&c.closed_days===sharpe.closed,`${label}: разрыв Sharpe ${name} по закрытым суткам окна: ${c.sharpe_gap} / ${sharpe.gap}`);
    assert.deepEqual(c.divergence,name==="buy_and_hold"?undefined:episodes(rows,name,"policy_v1"),`${label}: эпизоды расхождения ${name} с policy_v1 — на том же окне`);
    return{c,start,rows,own,pol};
  }
  function verifyTiming(name,basis,now,label){
    const{c,own,pol}=verifyLine(name,basis,now,label);
    assert.ok(near(c.share_pct,own.share,0.006)&&near(c.policy_share_pct,pol.share,0.006),`${label}: доли ${name} и policy_v1 по времени: ${c.share_pct}/${own.share}, ${c.policy_share_pct}/${pol.share}`);
    assert.ok(near(c.timing_pp,own.timing,1e-4)&&near(c.policy_timing_pp,pol.timing,1e-4),`${label}: тайминг ${name} по полной сетке: ${c.timing_pp} / ${own.timing}; policy_v1 ${c.policy_timing_pp} / ${pol.timing}`);
    assert.ok(near(c.vs_null_pp,own.vsNull,1e-4)&&near(c.policy_vs_null_pp,pol.vsNull,1e-4)&&near(c.vs_null_gap_pp,own.vsNull-pol.vsNull,1.5e-4)&&near(c.timing_gap_pp,own.timing-pol.timing,1.5e-4),`${label}: ${name} против своего нуля: ${c.vs_null_pp} / ${own.vsNull}`);
  }
  // Приёмка кандидата v3: окно и четыре числа сравнения — на окне блока, теневые сутки — возраст линии.
  function verifyAcceptance(basis,now,label,lifeDays){
    const{c,start,rows,own,pol}=verifyLine("policy_v3_shadow",basis,now,label),a=m.v3_candidate.acceptance_status;
    const lineDd=drawdown(rows,"policy_v3_shadow",basis==="birth"?start.lines.policy_v3_shadow.nav:null),policyDd=drawdown(rows,"policy_v1",basis==="birth"?start.lines.policy_v1.nav:null);
    assert.deepEqual(a.window,{basis,from:c.from,days:c.days},`${label}: приёмка публикует окно своих чисел`);
    assert.equal(a.shadow_days,lifeDays,`${label}: теневые сутки — возраст линии, от окна не зависят`);
    assert.deepEqual([a.divergence_base,a.divergence_episodes,a.divergence_days],["v1_daily_close",...Object.values(episodes(rows,"policy_v3_shadow","v1_daily_close"))],`${label}: эпизоды приёмки — на окне сравнения`);
    assert.ok(near(a.timing_gap_pp_vs_v1,own.vsNull-pol.vsNull,1.5e-4),`${label}: тайминг приёмки: ${a.timing_gap_pp_vs_v1} / ${own.vsNull-pol.vsNull}`);
    assert.ok(near(a.max_drawdown_worse_pp,Math.abs(lineDd)-Math.abs(policyDd),1e-4),`${label}: просадка приёмки по закрытиям окна: ${a.max_drawdown_worse_pp} / ${Math.abs(lineDd)-Math.abs(policyDd)}`);
    assert.ok(near(a.net_return_gap_pp_vs_v1,own.net-pol.net,1e-4),`${label}: разница доходностей приёмки: ${a.net_return_gap_pp_vs_v1} / ${own.net-pol.net}`);
    // Н2. Вывод приёмки — критерии контракта, применённые к независимым числам: тайминг — против
    // своего нуля и не хуже v1, просадка — насколько ГЛУБЖЕ, отклонение — при ОТСТАВАНИИ по доходности.
    const k=POLICY_V3_CANDIDATE.decision_record.acceptance_criteria,timing=own.vsNull-pol.vsNull,worse=Math.abs(lineDd)-Math.abs(policyDd),gap=own.net-pol.net;
    const meets={shadow_days:lifeDays>=k.shadow_days_min,divergence:episodes(rows,"policy_v3_shadow",k.divergence_base).episodes>=k.min_divergence_episodes,timing:timing>=0,drawdown:worse<=k.max_drawdown_worse_pp_max};
    const falsified=gap<-Math.abs(k.falsify_net_return_gap_pp)&&lifeDays>=k.falsify_min_days;
    assert.deepEqual([a.meets,a.falsified,a.status],[meets,falsified,falsified?"falsified":Object.values(meets).every(Boolean)?"switch_ready_pending_owner":"collecting"],`${label}: вывод приёмки по критериям контракта`);
    return{rows,start,lineDd,policyDd,own,pol,timing,worse,gap,meets,falsified};
  }

  const marks={};
  for(let d=0;d<=LAST;d++)for(const offset of d%5===4?[6.5*HOUR,23*HOUR]:[23*HOUR]){
    const t=D0+d*DAY+offset,closing=offset===23*HOUR;
    price*=1+(rnd()-0.5)*0.03+0.0005;
    // Сконструированные участки: обвал до рождения линий (политика стоит в 100 %); падение в сутки
    // рождения между прогоном рождения и закрытием (пик окна — стартовый NAV, а не первая строка);
    // обвал на 65–67-е сутки — в строках, которые на последней отметке ещё хранятся, но в окно
    // 365 суток не входят.
    if(closing){if(d===1)price*=1.08;if(d===2||d===3)price*=0.8;if(d===BIRTH)price*=0.9;if(d>=65&&d<=67)price*=0.88;if(d===68||d===69)price*=1.1;}
    const good=d>=64&&d<=67,opts={strategic:d<BIRTH?"constructive":d>=62&&d<=69?"defensive":REGIMES[Math.floor(run/7)%REGIMES.length],...(good?{mvrv:20,recovery:"good"}:{})};
    const v1=mkDecision(t,opts).decision.target_pct;
    // Цели линий: суточная повторяет v1 с задержкой на прогон, кандидат — на два, а на прогоне 06:30
    // держит на 20 п.п. больше до закрытия суток (в дневных строках этой смены не видно); на 64–69-е
    // сутки кандидат стоит в 100 % (расходится и с v1, и с суточной линией).
    const lagged=v1Targets[run-2]??v1,targets={policy_v3_shadow:d>=64&&d<=69?100:closing?lagged:Math.min(100,lagged+20),v1_daily_close:v1Targets[run-1]??v1,v1_floor_handoff:v1,v1_no_cftc:d%11<3?Math.min(100,v1+15):v1};
    m=tick(m,t,price,opts,d>=BIRTH?{variantInputs:variantInputs(v1),variantEngine:()=>({state:{},variants:Object.fromEntries(LINES.map(name=>[name,{target_pct:targets[name]}]))})}:{});
    v1Targets.push(v1);run++;account(t);
    if(!closing)continue;
    const life=d-BIRTH,label=`сутки ${d}`;
    if(d===BIRTH+3||d===BIRTH+300||d===BIRTH+369||d===BIRTH+370){
      // Пока строка суток рождения хранится, окно — с рождения, и числа равны пересчёту по полной сетке.
      for(const name of ["policy_v3_shadow","v1_no_cftc"])verifyTiming(name,"birth",t,label);
      const early=verifyAcceptance("birth",t,label,life);
      // На третьи сутки жизни просадка обеих линий — падение суток рождения от стартового NAV: по
      // одним дневным строкам (пик — первое закрытие) её не было бы видно.
      if(d===BIRTH+300){
        // Н2. Линия родилась на четверо суток позже v1 и разошлась с ней: каждое число приёмки здесь
        // отличается от того, что дала бы типовая ошибка в его сборке.
        const sinceGenesis=rowsFrom(born.policy_v1.t);
        assert.equal(m.days_elapsed,life+BIRTH,"фикстура: возраст монитора больше возраста линии — теневые сутки считаются от её старта");
        assert.ok(Math.abs(early.worse)>1,`фикстура: просадки линии и v1 на общем окне разные, знак различим: ${early.worse}`);
        assert.ok(Math.abs(early.timing-(early.own.timing-early.pol.timing))>0.5,`фикстура: тайминг «против своего нуля» отличается от валового тайминга: ${early.timing} / ${early.own.timing-early.pol.timing}`);
        assert.ok(Math.abs(early.gap)>1,`фикстура: разница доходностей ненулевая, знак различим: ${early.gap}`);
        assert.ok(Math.abs(Math.abs(drawdown(sinceGenesis,"policy_v1"))-Math.abs(early.policyDd))>1,"фикстура: просадка v1 от её собственного старта отличается от просадки на общем окне");
        assert.notDeepEqual(episodes(early.rows,"policy_v3_shadow","v1_daily_close"),episodes(early.rows,"policy_v3_shadow","policy_v1"),"фикстура: эпизоды против суточной линии v1 и против policy_v1 — разные числа");
        assert.deepEqual([early.meets,early.falsified],[{shadow_days:true,divergence:true,timing:false,drawdown:false},false],"фикстура: сутки и эпизоды набраны, тайминг хуже v1, просадка глубже допуска");
      }
      if(d===BIRTH+3)assert.ok(early.lineDd<-9&&early.policyDd<-4&&Math.abs(drawdown(early.rows,"policy_v3_shadow"))<Math.abs(early.lineDd)-5&&Math.abs(drawdown(early.rows,"policy_v1"))<Math.abs(early.policyDd)-2,`фикстура: просадка окна с рождения мерится от стартовых NAV: ${early.lineDd} / ${early.policyDd}`);
    }
    if(d===370||d===371){
      // Линии, рождённые вместе с монитором: строка суток рождения хранится 370 суток и уходит на 371-е.
      const basis=d===370?"birth":"rolling";
      verifyLine("buy_and_hold",basis,t,label);verifyLine("policy_v2_shadow",basis,t,label);
      assert.equal(m.timing_null.since_start===null,d===371,`${label}: окно «с начала» честного нуля политики закрывается тем же правилом`);
      assert.equal(m.v2_candidate.acceptance_status.window.basis,basis,`${label}: приёмка v2 публикует окно`);
    }
    if(d===BIRTH+371||d===BIRTH+380||d===LAST){
      // Строка суток рождения ушла: окно с рождения закрыто и помечено, сравнение — на скользящем окне.
      verifyTiming("policy_v3_shadow","rolling",t,label);
      const{c}=verifyLine("v1_no_cftc","rolling",t,label);
      assert.deepEqual([c.timing_pp,c.vs_null_pp,c.share_pct],[undefined,undefined,undefined],`${label}: линии без пути в дневных строках тайминг на скользящем окне не публикуют`);
      marks[d]=verifyAcceptance("rolling",t,label,life);
    }
  }
  // Н2. К 430-му дню кандидат отстал от v1 по доходности больше порога — приёмка его отклоняет; обратный
  // знак разницы (опережение) отклонением не был бы.
  assert.deepEqual([marks[LAST].falsified,m.v3_candidate.acceptance_status.status,marks[LAST].gap<-10],[true,"falsified",true],"отставание больше 10 п.п. на окне от 180 суток — кандидат отклонён");
  assert.equal(evaluateAcceptanceV3({shadowDays:430,divergence:{episodes:54,days:54},timingGapPp:marks[LAST].timing,drawdownWorsePp:marks[LAST].worse,netReturnGapPp:-marks[LAST].gap}).falsified,false,"опережение на ту же величину — не отклонение");
  // Фикстура говорит то, ради чего построена.
  for(const name of Object.keys(m.strategies))assert.ok(near(m.strategies[name].nav,acc[name].nav,1e-9),`независимый учёт NAV расходится с монитором: ${name}`);
  assert.ok(near(m.strategies.policy_v3_shadow.exposure_pct_days,acc.policy_v3_shadow.w,1e-6)&&near(m.strategies.policy_v3_shadow.gross_nav,acc.policy_v3_shadow.gross,1e-9));
  const now=lastT,today=iso(now).slice(0,10),kept=stored(now),last=marks[LAST],dayOf=d=>iso(D0+d*DAY).slice(0,10);
  assert.deepEqual([m.daily[0].date,m.daily.length,kept[0].date,last.start.date],[dayOf(64),371,dayOf(64),dayOf(69)],"хранятся строки с 64-х суток, окно 365 суток начинается с 69-х");
  assert.deepEqual(m.daily.map(row=>Object.keys(row.path||{}).join()),m.daily.map(()=>"policy_v1,policy_v3_shadow"),"путь в дневной строке — у политики и кандидата, у остальных линий его нет");
  // 1. По хранимым строкам (а не по окну) вышли бы другие эпизоды и другая просадка.
  assert.notDeepEqual(episodes(kept,"policy_v3_shadow","v1_daily_close"),episodes(last.rows,"policy_v3_shadow","v1_daily_close"),"фикстура: в хранимых строках вне окна есть эпизод расхождения");
  assert.ok(Math.abs(drawdown(kept,"policy_v3_shadow"))-Math.abs(last.lineDd)>5&&Math.abs((Math.abs(drawdown(kept,"policy_v3_shadow"))-Math.abs(drawdown(kept,"policy_v1")))-(Math.abs(last.lineDd)-Math.abs(last.policyDd)))>1,"фикстура: обвал 65–67-х суток лежит в хранимых строках вне окна");
  // 2. Старт окна: линии стоят в разных долях, вход оплачен обеими.
  assert.notEqual(last.start.lines.policy_v3_shadow.target,last.start.lines.policy_v1.target,"фикстура: в начале окна доли линий разные — вход со своей доли различим");
  // 3. Доля по целям закрытия дня заметно отличается от доли по времени: приближение не прошло бы.
  {
    let weighted=0,prev=last.start;for(const row of last.rows.slice(1)){weighted+=prev.lines.policy_v3_shadow.target*(row.t-prev.t);prev=row;}
    assert.ok(Math.abs(weighted/(now-last.start.t)-last.own.share)>0.05,`фикстура: доля по целям закрытия ${weighted/(now-last.start.t)} против доли по времени ${last.own.share}`);
  }
  // 4. Окно с рождения по обрезанной сетке дало бы другой тайминг — тот самый дефект.
  {
    const start=point(born.policy_v3_shadow,"policy_v3_shadow"),a=acc.policy_v3_shadow,share=a.w/((now-start.t)/DAY)/100;
    let full=1,cut=1,p=start.price,c=start.cash;for(const row of closes){if(row.t<=start.t)continue;full*=1+share*(row.price/p-1)+(1-share)*(row.cash/c-1);p=row.price;c=row.cash;}
    p=start.price;c=start.cash;for(const row of kept){cut*=1+share*(row.price/p-1)+(1-share)*(row.cash/c-1);p=row.price;c=row.cash;}
    assert.ok(Math.abs(full-cut)*100>0.01,`фикстура: ноль с рождения по обрезанной сетке отличается от полного на ${(Math.abs(full-cut)*100).toFixed(4)} п.п.`);
  }
  // Приёмка v2: эпизод пола тени 65–67-х суток хранится, но в окно не входит — счёт идёт по окну.
  assert.deepEqual(m.daily.filter(row=>row.v2_floor).map(row=>row.date),[65,66,67].map(dayOf),"фикстура: единственный эпизод пола тени — в хранимых строках вне окна");
  const v2=m.v2_candidate.acceptance_status,v2Window=m.comparisons.policy_v2_shadow;
  assert.deepEqual(v2.window,{basis:"rolling",from:v2Window.from,days:v2Window.days});
  assert.equal(v2.recovery_episodes_observed,0,"эпизоды пола тени считаются на окне сравнения, а не по всем хранимым строкам");
  assert.equal(m.v2_candidate.days_diverged,m.daily.filter(row=>row.v2_diverged===true&&Date.parse(row.t)>=Date.parse(v2Window.from)).length);
  assert.ok(m.daily.some(row=>row.v2_diverged===true&&Date.parse(row.t)<Date.parse(v2Window.from)),"фикстура: сутки расхождения тени есть и вне окна");
  assert.equal(v2.sharpe_gap_vs_v1,v2Window.sharpe_gap);
  // Само разложение с рождения по обрезанной сетке не считается вовсе — и при прямом вызове.
  assert.equal(lineTimingV1(m,"policy_v3_shadow",{costRate:COST}),null,"окно с рождения закрыто: null, а не число по обрезанной сетке");
  assert.ok(lineTimingV1(m,"policy_v3_shadow",{costRate:COST,from:m.daily.find(row=>row.t===m.comparisons.policy_v3_shadow.from)}),"скользящее окно от строки с путём считается");
  assert.equal(lineTimingV1(m,"v1_no_cftc",{costRate:COST,from:m.daily[5]}),null,"без пути линии в начальной строке скользящего разложения нет");
  assert.equal(m.optional_errors,undefined);assert.equal(m.variant_errors,undefined);
}

// ---------- Н4. В блоках кандидата и линий нет ключей прошлых прогонов ----------
{
  const view=(target,extra={})=>({target_pct:target,base_target_pct:target,state:"transition",candidate:"transition",fix_at:iso(T0),next_fix_at:iso(T0+DAY),floor:{active:false,rung:null,closes:0},binding_overlays:[],inputs:{a:1},reason_codes:["between_fixes"],...extra});
  const engineOf=(v3,daily={target_pct:45,state:"transition",fix_at:iso(T0)})=>()=>({state:{k:1},variants:{policy_v3_shadow:v3,v1_daily_close:daily,v1_floor_handoff:{target_pct:45,carry:false},v1_no_cftc:{target_pct:45}}});
  const run=(monitor,hour,engine)=>tick(monitor,T0+hour*HOUR,60_000,{strategic:"transition"},engine===null?{}:{variantInputs:variantInputs(45),variantEngine:engine});
  const OWN=["id","version","status","created","base_suite","evaluated_at","acceptance","acceptance_status"];
  const engineKeys=block=>Object.keys(block).filter(key=>!OWN.includes(key)).sort();
  const healthy=run(run(null,0,null),1,engineOf(view(45)));
  assert.deepEqual(engineKeys(healthy.v3_candidate),Object.keys(view(45)).sort(),"фикстура: в блоке — поля движка и свои поля монитора");
  // Разовый отказ линии в движке: настоящий движок отдаёт target_pct null, код и текст ошибки.
  const broken=run(healthy,2,engineOf({target_pct:null,reason_codes:["engine_error"],error:"TypeError: boom"},{target_pct:null,reason_codes:["engine_error"],error:"TypeError: boom"}));
  assert.deepEqual([broken.v3_candidate.error,broken.v3_candidate.target_pct,broken.v3_candidate.evaluated_at],["TypeError: boom",null,iso(T0+2*HOUR)]);
  assert.deepEqual(engineKeys(broken.v3_candidate),["error","reason_codes","target_pct"],"на отказном прогоне в блоке — только то, что движок отдал сейчас");
  assert.equal(broken.strategies.policy_v3_shadow.current_target_pct,45,"линия держит прежнюю цель");
  const healed=run(broken,3,engineOf(view(45)));
  assert.deepEqual(healed.v3_candidate,{...healthy.v3_candidate,evaluated_at:iso(T0+3*HOUR),acceptance_status:healed.v3_candidate.acceptance_status},"после восстановления движка следа прошлой ошибки в блоке нет");
  assert.equal(healed.v3_candidate.error,undefined);
  assert.deepEqual([broken.variants.v1_daily_close.error,healed.variants.v1_daily_close.error,Object.keys(healed.variants.v1_daily_close).sort()],["TypeError: boom",undefined,["evaluated_at","fix_at","state","target_pct"]],"то же у линий «v1 с одной правкой»");
  // Обрезанный блок (линия отдала больше 4 КБ) помечается только на том прогоне, где он обрезан.
  const cut=run(healthy,2,engineOf(view(45,{blob:"x".repeat(5000)})));
  assert.deepEqual(engineKeys(cut.v3_candidate),["target_pct","truncated"]);assert.equal(cut.v3_candidate.target_pct,45);
  assert.equal(run(cut,3,engineOf(view(45))).v3_candidate.truncated,undefined,"пометка truncated не переживает прогон");
  // Свежего ответа нет (движок упал целиком либо входов нет): прежние поля движка остаются как были, возраст — в evaluated_at.
  for(const [label,engine] of [["движок упал",()=>{throw new Error("boom");}],["входов нет",null]]){
    const stale=run(healthy,2,engine);
    assert.deepEqual({...stale.v3_candidate,acceptance_status:null},{...healthy.v3_candidate,acceptance_status:null},`${label}: блок кандидата — прежний, с прежним evaluated_at`);
    assert.deepEqual(stale.variants,healthy.variants,`${label}: блоки линий — прежние`);
    assert.equal(stale.v3_candidate.evaluated_at,iso(T0+HOUR));
  }
  // Движок ответил не по всем линиям: у ответивших блок свежий, у остальных — прежний целиком.
  const partial=run(healthy,2,()=>({state:{k:2},variants:{policy_v3_shadow:view(20),v1_no_cftc:{target_pct:20,note:"fresh"}}}));
  assert.deepEqual([partial.v3_candidate.target_pct,partial.variants.v1_no_cftc,partial.variants.v1_daily_close],[20,{target_pct:20,note:"fresh",evaluated_at:iso(T0+2*HOUR)},healthy.variants.v1_daily_close]);
  // Данные контракта движок переписать не может: свои поля монитор кладёт поверх.
  const spoof=run(healthy,2,engineOf(view(45,{id:"чужой",version:99,acceptance:"подмена",evaluated_at:"вчера"})));
  assert.deepEqual([spoof.v3_candidate.id,spoof.v3_candidate.version,spoof.v3_candidate.acceptance,spoof.v3_candidate.evaluated_at],[POLICY_V3_CANDIDATE.id,POLICY_V3_CANDIDATE.version,POLICY_V3_CANDIDATE.decision_record.acceptance_criteria,iso(T0+2*HOUR)]);
}

// ---------- Н5. Захват роста при росте HODL около нуля ----------
{
  // Десять суток, цель политики меняется через день; цена конца задаёт рост HODL за окно.
  const runTo=endPrice=>{let m=tick(null,T0,60_000,{strategic:"transition"});for(let d=1;d<=10;d++)m=tick(m,T0+d*DAY,d<10?60_000*(1+0.05*Math.sin(d)):endPrice,{strategic:d%2?"deteriorating":"transition"});return m.timing_null.since_start;};
  const tiny=runTo(60_000*1.00101),small=runTo(60_000*1.03),fallen=runTo(60_000*0.99),grown=runTo(60_000*1.3);
  assert.ok(tiny.hodl_net_return_pct>0&&tiny.hodl_net_return_pct<0.01&&Math.abs(tiny.policy_net_return_pct/tiny.hodl_net_return_pct)>50,`фикстура: HODL ${tiny.hodl_net_return_pct} %, политика ${tiny.policy_net_return_pct} % — прежний «захват» трёхзначный`);
  assert.deepEqual([tiny.capture_ratio,small.capture_ratio,fallen.capture_ratio],[null,null,null],"рост HODL меньше 5 % или падение — захват не публикуется");
  assert.ok(small.hodl_net_return_pct>2&&small.hodl_net_return_pct<5&&fallen.hodl_net_return_pct<0);
  assert.equal(grown.capture_ratio,Number((grown.policy_net_return_pct/grown.hodl_net_return_pct).toFixed(4)),"при заметном росте HODL захват — отношение чистых доходностей");
  assert.ok(grown.hodl_net_return_pct>29&&grown.capture_ratio>0&&grown.capture_ratio<1);
  for(const w of [tiny,small,fallen,grown])assert.ok(near(w.level_pp+w.timing_pp+w.costs_pp,w.policy_net_return_pct-w.hodl_net_return_pct,3e-4),"остальные числа окна не тронуты");
}

// ---------- Н6. Обёртка движка: цель линии — только число, чтение ответа не роняет прогон ----------
{
  const NAMES=["policy_v3_shadow","v1_daily_close","v1_floor_handoff","v1_no_cftc"];
  // Правило приёма цели.
  for(const good of [0,5,37.5,100,1e-320])assert.deepEqual(acceptLineTargetV1(good),{target:good,rejected:null},`число в 0…100 исполняется: ${good}`);
  assert.ok(Object.is(acceptLineTargetV1(-0).target,0),"минус ноль в цель не попадает");
  for(const hold of [null,undefined])assert.deepEqual(acceptLineTargetV1(hold),{target:null,rejected:null},"null и отсутствие поля — законное «держать»");
  for(const [value,code] of [[true,"target_not_number"],[false,"target_not_number"],[[],"target_not_number"],[[80],"target_not_number"],["80","target_not_number"],[" ","target_not_number"],["","target_not_number"],[{},"target_not_number"],[80n,"target_not_number"],[NaN,"target_not_finite"],[Infinity,"target_not_finite"],[-Infinity,"target_not_finite"],[-5,"target_out_of_range"],[150,"target_out_of_range"],[100.0001,"target_out_of_range"],[-1e-9,"target_out_of_range"]])
    assert.deepEqual(acceptLineTargetV1(value),{target:null,rejected:code},`не исполняется: ${typeof value} ${String(value)}`);
  // Монитор: мусорная цель одной линии — линия держит долю, остальные исполняются, след остаётся.
  const all=target=>Object.fromEntries(NAMES.map(name=>[name,{target_pct:target,state:"transition"}]));
  const run=(monitor,hour,variants,price=60_000)=>tick(monitor,T0+hour*HOUR,price,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:typeof variants==="function"?variants:()=>({state:{k:hour},variants})});
  const base=run(tick(null,T0,60_000,{strategic:"transition"}),1,all(45));
  assert.deepEqual(NAMES.map(name=>base.strategies[name].current_target_pct),[45,45,45,45]);
  for(const [garbage,code] of [[true,"target_not_number"],[false,"target_not_number"],[[],"target_not_number"],[[80],"target_not_number"],["80","target_not_number"],[" ","target_not_number"],[NaN,"target_not_finite"],[250,"target_out_of_range"],[-5,"target_out_of_range"]]){
    // Движок прислал мусор кандидату и настоящую новую цель остальным; цена за интервал +10 %.
    const m=run(base,2,{...all(20),policy_v3_shadow:{target_pct:garbage,state:"transition",fix_at:iso(T0)}},66_000),label=`${typeof garbage} ${JSON.stringify(garbage)}`;
    assert.equal(m.strategies.policy_v3_shadow.current_target_pct,45,`${label}: линия держит прежнюю цель`);
    assert.equal(m.strategies.policy_v3_shadow.turnover_pct,base.strategies.policy_v3_shadow.turnover_pct,`${label}: оборота нет`);
    assert.deepEqual(NAMES.slice(1).map(name=>m.strategies[name].current_target_pct),[20,20,20],`${label}: остальные линии исполнены`);
    assert.deepEqual(m.variant_errors,[{t:iso(T0+2*HOUR),line:"policy_v3_shadow",error:code}],`${label}: причина записана с именем линии`);
    assert.deepEqual([m.v3_candidate.target_pct,m.v3_candidate.target_rejected,m.v3_candidate.state,m.v3_candidate.fix_at],[null,code,"transition",iso(T0)],`${label}: в блоке — принятая цель (её нет) и причина, остальные поля движка на месте`);
    assert.deepEqual(m.variants_state,{k:2},`${label}: состояние движка принято — отказ одной линии остальных не касается`);
    assert.equal(m.decision_log.at(-1).v3.target_pct,null);assert.equal(verifyDecisionLogChainV1(m.decision_log).ok,true);
    assert.equal(m.decision_log.at(-1).quality,"good");assert.equal(m.optional_errors,undefined);
    // Следующий здоровый прогон: причины в блоке нет (Н4), запись в variant_errors остаётся историей.
    const healed=run(m,3,all(20),66_000);
    assert.deepEqual([healed.v3_candidate.target_pct,healed.v3_candidate.target_rejected,healed.strategies.policy_v3_shadow.current_target_pct,healed.variant_errors.length],[20,undefined,20,1],label);
  }
  // Интервал с +10 % прошёл с прежней долей 45 %: NAV мусорной линии равен NAV линии, которой движок ответил null.
  const held=run(base,2,{...all(20),policy_v3_shadow:{target_pct:null}},66_000),junk=run(base,2,{...all(20),policy_v3_shadow:{target_pct:"80"}},66_000);
  assert.equal(junk.strategies.policy_v3_shadow.nav,held.strategies.policy_v3_shadow.nav);assert.ok(junk.strategies.policy_v3_shadow.nav/base.strategies.policy_v3_shadow.nav>1.044);
  assert.equal(held.variant_errors,undefined,"null — не отказ: следа в variant_errors нет");
  assert.equal(held.v3_candidate.target_rejected,undefined);
  // Линия не объектом; линии нет в ответе.
  const shaped=run(base,2,{...all(20),policy_v3_shadow:[80],v1_daily_close:"80",v1_no_cftc:undefined});
  assert.deepEqual([shaped.strategies.policy_v3_shadow.current_target_pct,shaped.strategies.v1_daily_close.current_target_pct,shaped.strategies.v1_floor_handoff.current_target_pct,shaped.strategies.v1_no_cftc.current_target_pct],[45,45,20,45]);
  assert.deepEqual(shaped.variant_errors.map(e=>[e.line,e.error]),[["policy_v3_shadow","line_not_object"],["v1_daily_close","line_not_object"]],"линия, которой в ответе нет, — не отказ");
  assert.deepEqual([shaped.v3_candidate.target_rejected,shaped.variants.v1_daily_close.target_rejected,shaped.variants.v1_no_cftc],["line_not_object","line_not_object",base.variants.v1_no_cftc]);
  // Геттеры, бросающие исключение: на чтении линии, на чтении её цели, на чтении всего ответа.
  const throwing=key=>({get [key](){throw new Error(`геттер ${key}`);}});
  const withGetter=(target,key)=>Object.defineProperties({...target},Object.getOwnPropertyDescriptors(throwing(key)));
  const lineGetter=run(base,2,withGetter(all(20),"v1_daily_close")),targetGetter=run(base,2,{...all(20),v1_no_cftc:withGetter({state:"transition"},"target_pct")});
  assert.deepEqual([lineGetter.strategies.v1_daily_close.current_target_pct,lineGetter.strategies.policy_v3_shadow.current_target_pct,lineGetter.strategies.v1_no_cftc.current_target_pct,lineGetter.variant_errors.map(e=>[e.line,e.error])],[45,20,20,[["v1_daily_close","line_unreadable"]]],"геттер на чтении линии: она держит долю, остальные исполнены");
  assert.deepEqual([targetGetter.strategies.v1_no_cftc.current_target_pct,targetGetter.strategies.policy_v3_shadow.current_target_pct,targetGetter.variant_errors.map(e=>[e.line,e.error]),targetGetter.variants.v1_no_cftc.target_rejected],[45,20,[["v1_no_cftc","line_unreadable"]],"line_unreadable"],"геттер на чтении цели — то же");
  const reference=run(base,2,all(45));
  for(const [label,engine,error] of [["variants",()=>withGetter({state:{k:9}},"variants"),"engine_result_unreadable: геттер variants"],["state",()=>withGetter({variants:all(20)},"state"),"engine_result_unreadable: геттер state"]]){
    const m=run(base,2,engine);
    assert.deepEqual(m.variant_errors,[{t:iso(T0+2*HOUR),error}],`геттер на чтении ${label}: отказ движка целиком записан`);
    assert.deepEqual([NAMES.map(name=>m.strategies[name].current_target_pct),m.variants_state],[[45,45,45,45],{k:1}],`геттер на чтении ${label}: линии держат цель, состояние прежнее`);
    for(const key of ["policy_v1","buy_and_hold","policy_v2_shadow"])assert.deepEqual(m.strategies[key],reference.strategies[key],`геттер на чтении ${label}: учёт остальных линий не тронут`);
  }
  // Сама обёртка не бросает ни на чём из этого и отдаёт коды причин.
  const direct=runShadowVariantsV1({engine:()=>({state:{},variants:withGetter({policy_v3_shadow:{target_pct:true},v1_daily_close:{target_pct:60}},"v1_no_cftc")}),now:T0,inputs:{},state:{}});
  assert.deepEqual([direct.ok,direct.error,direct.targets,direct.rejected],[true,null,{policy_v3_shadow:null,v1_daily_close:60,v1_floor_handoff:null,v1_no_cftc:null},{policy_v3_shadow:"target_not_number",v1_no_cftc:"line_unreadable"}]);
  assert.deepEqual(direct.published,{policy_v3_shadow:{target_pct:null,target_rejected:"target_not_number"},v1_daily_close:{target_pct:60},v1_no_cftc:{target_pct:null,target_rejected:"line_unreadable"}});
  // Запись hash-журнала читает поля кандидата тем же строгим правилом: мусор и длинные строки в неё
  // не попадают (блок публикации держит их до своего потолка, запись журнала хранится 400 раз).
  const valid=run(base,2,{...all(20),policy_v3_shadow:{target_pct:20,base_target_pct:20,state:"deteriorating",candidate:"transition",fix_at:iso(T0),floor:{active:true,rung:2,closes:2},inputs:{a:1}}});
  assert.deepEqual(valid.decision_log.at(-1).v3,{target_pct:20,base_target_pct:20,state:"deteriorating",candidate:"transition",fix_at:iso(T0),floor_rung:2,inputs:{a:1},lines:{v1_daily_close:20,v1_floor_handoff:20,v1_no_cftc:20}});
  const bloated=run(base,2,{...all(20),policy_v3_shadow:{target_pct:20,base_target_pct:"20",state:"x".repeat(3_000),candidate:{a:1},fix_at:12345,floor:{rung:"2"},inputs:[1,2]}});
  assert.deepEqual(bloated.decision_log.at(-1).v3,{target_pct:20,base_target_pct:null,state:null,candidate:null,fix_at:null,floor_rung:null,inputs:null,lines:{v1_daily_close:20,v1_floor_handoff:20,v1_no_cftc:20}});
  assert.ok(jsonBytesV1(bloated.decision_log.at(-1))<=jsonBytesV1(valid.decision_log.at(-1)),"запись журнала от мусора не растёт");
  assert.equal(bloated.v3_candidate.state.length,3_000,"в блоке публикации поле движка остаётся как пришло — он ограничен своим потолком");
  assert.equal(verifyDecisionLogChainV1(bloated.decision_log).ok,true);
  // Журнал отказов ограничен десятью записями.
  let noisy=base;for(let h=2;h<8;h++)noisy=run(noisy,h,{policy_v3_shadow:{target_pct:"x"},v1_daily_close:{target_pct:[]}});
  assert.equal(noisy.variant_errors.length,10);assert.equal(noisy.variant_errors.at(-1).t,iso(T0+7*HOUR));
}

// ---------- Н7. Запасной вызов сборщика не стирает значения теневых карточек этих суток ----------
{
  // Сборщик при отказе дополнительного расчёта повторяет вызов монитора без variantInputs,
  // shadowValues, regimeBirth и tickDiff. Строка дня переписывается каждым прогоном целиком.
  const values={tga_daily:887.4,g3_liquidity:24.1,gold_axis:0.5,sth_pricing:1.1,realized_pnl:1.0,options_structure:-3,oi_purge_24h:-0.5,hash_ribbons:1.02},rounded=shadowRowValuesV1(values);
  const engine=()=>({state:{k:1},variants:{policy_v3_shadow:{target_pct:45},v1_daily_close:{target_pct:45}}});
  const full=(monitor,t,shadow=values)=>tick(monitor,t,60_000,{strategic:"defensive",mvrv:20,recovery:"good",tactical:"spot_led"},{shadowValues:shadow,variantInputs:variantInputs(45),variantEngine:engine});
  const fallback=(monitor,t)=>tick(monitor,t,60_000,{strategic:"defensive",mvrv:20,recovery:"good",tactical:"spot_led"},{variantInputs:null,shadowValues:null,regimeBirth:null,tickDiff:null});
  const D0=Math.floor(T0/DAY)*DAY;
  // Сутки 0 — recovery good весь день, чтобы на сутки 1 пол тени v2 был в строке (v2_floor).
  let m=full(full(null,D0+HOUR),D0+20*HOUR);
  m=full(m,D0+DAY+HOUR);
  const before=m.daily.at(-1);
  assert.deepEqual([before.shadow,before.tactical,before.v2_floor,Object.keys(before.path).join()],[rounded,"spot_led",true,"policy_v1,policy_v3_shadow"],"фикстура: строка суток с теневыми значениями, путём и полом тени");
  // Запасной вызов — последний прогон суток 1.
  m=fallback(m,D0+DAY+23*HOUR);
  const row=m.daily.at(-1);
  assert.equal(row.t,iso(D0+DAY+23*HOUR));
  assert.deepEqual(row.shadow,rounded,"значения теневых карточек этих суток перенесены из прежней строки");
  assert.deepEqual([row.tactical,row.v2_floor,Object.keys(row.path).join()],["spot_led",true,"policy_v1,policy_v3_shadow"],"краткосрочное состояние, пол тени и путь линий запасной вызов пишет сам");
  assert.ok(row.path.policy_v3_shadow[0]>before.path.policy_v3_shadow[0]&&row.nav.policy_v3_shadow>0,"учёт линий в запасном вызове идёт: доля копится, NAV ведётся");
  assert.equal(m.decision_log.at(-1).v3,undefined,"запись журнала запасного вызова — без блока v3: движок не вызывался");
  assert.equal(m.accounting_at,m.last_at,"разрыва учёта запасной вызов не создаёт");
  // Сутки 2: день 1 закрыт и входит в счёт утверждений — его последний прогон был запасным.
  const next=full(m,D0+2*DAY+HOUR);
  assert.equal(next.shadow_evidence.cards.tga_daily.observed_days,2,"сутки с запасным последним прогоном не выпадают из счёта теневого слоя");
  assert.equal(next.line_restarts,undefined);
  // Запасной вызов — первый прогон суток: вчерашние значения в новую строку не переносятся.
  const cold=fallback(m,D0+2*DAY+HOUR);
  assert.equal(cold.daily.at(-1).shadow,undefined,"из строки прошлых суток значения не берутся");
  assert.deepEqual(full(cold,D0+2*DAY+2*HOUR,{...values,tga_daily:900}).daily.at(-1).shadow,{...rounded,tga_daily:900},"следующий полный прогон тех же суток пишет свежие значения");
  // Полный прогон после запасного переписывает перенесённое свежим; карточка без значения на закрытии — null.
  const fresh=full(m,D0+DAY+23*HOUR+30*MIN,{...values,tga_daily:null,sth_pricing:1.3});
  assert.deepEqual(fresh.daily.at(-1).shadow,{...rounded,tga_daily:null,sth_pricing:1.3},"значение строки — значение последнего прогона, получившего карточки");
}

// ---------- Н8. Пределы хранения монитора объявлены и входят в проекцию размера ----------
{
  const limits=monitorRetentionLimitsV1(),limitOf=key=>limits.lists.find(x=>x.path===`monitoring.${key}`)?.limit;
  const engine=()=>({state:{k:1},variants:{policy_v3_shadow:{target_pct:45},v1_daily_close:{target_pct:45}}});
  const alert=i=>({source:"network",type:"same_vintage_rewritten",quality_impact:"audit",observed_at:iso(T0),changed_rows:i});
  let m=tick(null,T0,60_000,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:engine});
  m=tick(m,T0+HOUR,60_000,{strategic:"deteriorating"},{variantInputs:variantInputs(20),variantEngine:engine});
  // Каждый список переполнен заранее; один прогон дописывает в каждый по записи.
  const stuffed=structuredClone(m);
  stuffed.decision_events=Array.from({length:limitOf("decision_events")+5},(_,i)=>({...m.decision_events.at(-1),t:iso(T0-(2000-i)*MIN)}));
  stuffed.revision_alerts=Array.from({length:60},(_,i)=>({...alert(i),detected_at:iso(T0)}));
  stuffed.target_change_log=Array.from({length:70},()=>structuredClone(m.target_change_log.at(-1)));
  stuffed.optional_errors=Array.from({length:25},(_,i)=>({t:iso(T0),part:"x",error:String(i)}));
  stuffed.variant_errors=Array.from({length:12},(_,i)=>({t:iso(T0),error:String(i)}));
  const poisoned={get tga_daily(){throw new Error("сломанное значение карточки");}};
  const next=tick(stuffed,T0+2*HOUR,60_000,{strategic:"transition"},{revisionAlerts:[alert(100),alert(101)],shadowValues:poisoned,variantInputs:variantInputs(45),variantEngine:()=>({state:{k:2},variants:{policy_v3_shadow:{target_pct:"45"}}})});
  for(const key of ["decision_events","revision_alerts","target_change_log","optional_errors","variant_errors"])assert.equal(next[key].length,limitOf(key),`${key}: список держит объявленный предел`);
  assert.deepEqual([limitOf("decision_events"),limitOf("revision_alerts"),limitOf("target_change_log"),limitOf("optional_errors"),limitOf("variant_errors")],[MODEL_POLICY_V1.forward_monitoring.decision_event_limit,40,TARGET_CHANGE_LOG_LIMIT,20,10]);
  assert.deepEqual(next.revision_alerts.slice(-2).map(x=>[x.changed_rows,x.detected_at]),[[100,iso(T0+2*HOUR)],[101,iso(T0+2*HOUR)]],"в буфере пересмотров остаются самые свежие");
  assert.equal(next.revision_alerts[0].changed_rows,22,"вытесняются самые старые: из 62 записей остались последние 40");
  assert.equal(next.decision_events.at(-1).t,iso(T0+2*HOUR));assert.equal(next.optional_errors.at(-1).part,"shadow_values");assert.equal(next.variant_errors.at(-1).line,"policy_v3_shadow");
  // Перезапуски линий и сбросы монитора — по десять записей.
  const gap=structuredClone(m);gap.line_restarts=Array.from({length:12},(_,i)=>({t:iso(T0),reason:"x",lines:[String(i)]}));gap.accounting_at=iso(T0);
  assert.equal(tick(gap,T0+2*HOUR,60_000,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:engine}).line_restarts.length,limitOf("line_restarts"));
  const reborn=tick({reset_events:Array.from({length:12},(_,i)=>({t:iso(T0),reason:String(i)}))},T0,60_000,{strategic:"transition"},{previousSnapshotPresent:true});
  assert.equal(reborn.reset_events.length,limitOf("reset_events"));assert.equal(limitOf("line_restarts"),10);assert.equal(limitOf("reset_events"),10);
  // Склейка с архивом (графт) режет те же списки теми же пределами.
  {
    let archive=tick(null,T0,100,{strategic:"constructive"});archive=tick(archive,T0+DAY,104,{strategic:"constructive"});
    const era=tick(null,T0+DAY+2*HOUR,105,{strategic:"constructive"},{previousSnapshotPresent:true});
    archive.revision_alerts=Array.from({length:30},(_,i)=>({...alert(i),detected_at:iso(T0)}));era.revision_alerts=Array.from({length:30},(_,i)=>({...alert(100+i),detected_at:iso(T0+DAY)}));
    archive.reset_events=Array.from({length:8},(_,i)=>({t:iso(T0),reason:String(i)}));era.reset_events=Array.from({length:8},(_,i)=>({t:iso(T0+DAY),reason:String(100+i)}));
    const pack={schema:1,reason:"test_restore",invalid_window:[],orphaned_genesis_log_hashes:[],archive:{source_commit:"fixture",monitor:archive},era:{started_at:era.started_at,price:105,strategies:Object.fromEntries(Object.entries(era.strategies).map(([k])=>[k,{initial_target_pct:era.strategy_meta[k].start_target_pct,initial_nav:1-era.strategy_meta[k].start_target_pct/100*COST,initial_turnover_pct:era.strategy_meta[k].start_target_pct,initial_cost_pct:era.strategy_meta[k].start_target_pct/100*COST*100}]))}};
    const grafted=graftForwardMonitorV1(era,pack);
    assert.deepEqual([grafted.revision_alerts.length,grafted.revision_alerts[0].changed_rows,grafted.revision_alerts.at(-1).changed_rows,grafted.reset_events.length,grafted.reset_events.at(-1).reason],[limitOf("revision_alerts"),20,129,limitOf("reset_events"),"107"],"графт держит те же пределы и оставляет самые свежие записи");
  }
  // Каждый список монитора либо объявлен, либо это дневные строки и журнал, которые проекция знает сама.
  const arrays=new Set([m,next,reborn,tick(gap,T0+2*HOUR,60_000,{strategic:"transition"})].flatMap(state=>Object.keys(state).filter(key=>Array.isArray(state[key]))));
  const declared=new Set([...limits.lists.map(x=>x.path.replace("monitoring.","")),"daily","decision_log","review_schedule_days"]);
  assert.deepEqual([...arrays].filter(key=>!declared.has(key)),[],"список без объявленного предела в проекцию размера не попал бы");
  for(const key of ["decision_events","revision_alerts","target_change_log","optional_errors","variant_errors","line_restarts","reset_events"])assert.ok(arrays.has(key),`фикстура: список ${key} встретился`);
  // Байтовые потолки: состояние движка и блоки линий.
  assert.deepEqual(limits.ceilings.map(x=>[x.path,x.max_bytes]),[["monitoring.variants_state",VARIANTS_STATE_MAX_BYTES],["monitoring.v3_candidate",6_000],["monitoring.variants",12_300]]);
  assert.equal(VARIANTS_STATE_MAX_BYTES,12_000,"потолок состояния движка входит в проекцию размера: менять вместе с её пересчётом");
  const stateOf=bytes=>runShadowVariantsV1({engine:()=>({state:{blob:"x".repeat(bytes-11)},variants:{policy_v3_shadow:{target_pct:50}}}),now:T0,inputs:{},state:{a:1}});
  assert.deepEqual([stateOf(12_000).error,stateOf(12_000).targets.policy_v3_shadow],[null,50],"состояние ровно на потолке принимается");
  assert.ok(stateOf(12_001).error.startsWith("engine_state_too_large: 12001 > 12000")&&stateOf(12_001).targets.policy_v3_shadow===null,"состояние больше потолка не принимается");
  // Блок линии больше своего потолка в снимок не попадает, блок кандидата целиком — меньше объявленного.
  const fat=tick(m,T0+2*HOUR,60_000,{strategic:"transition"},{variantInputs:variantInputs(45),variantEngine:()=>({state:{k:2},variants:Object.fromEntries(["policy_v3_shadow","v1_daily_close","v1_floor_handoff","v1_no_cftc"].map(name=>[name,{target_pct:45,pad:"x".repeat(3_950)}]))})});
  assert.ok(jsonBytesV1(fat.v3_candidate)<=6_000&&jsonBytesV1(fat.v3_candidate)>4_000&&jsonBytesV1(fat.variants)<=12_300&&jsonBytesV1(fat.variants)>11_000,`блоки линий на потолке движка укладываются в объявленные: ${jsonBytesV1(fat.v3_candidate)} / ${jsonBytesV1(fat.variants)}`);
  // Проверка перед публикацией предупреждает заранее и не отказывает: снимок, которому до капа при всех
  // пределах разом остаётся меньше 150 КБ, проходит self-test с предупреждением.
  const committed=JSON.parse(readFileSync(new URL("../docs/snapshot.json",import.meta.url),"utf8")),room=publicSnapshotAtLimitsV1({snapshot:committed,snapshotBytes:jsonBytesV1(committed),...limits}).margin;
  const dir=mkdtempSync(join(tmpdir(),"monitor-size-")),padded=join(dir,"snapshot.json");
  try{
    writeFileSync(padded,JSON.stringify({...committed,size_test_padding:"x".repeat(Math.max(0,room-100_000))}));
    const run=spawnSync(process.execPath,["scripts/self-test.mjs"],{cwd:fileURLToPath(new URL("..",import.meta.url)),encoding:"utf8",env:{...process.env,OUT:padded,STATE:join(dir,"absent.json"),REQUIRE_LIVE:""}});
    assert.equal(run.status,0,`предупреждение о размере не отказ: ${run.stderr.slice(0,300)}`);
    assert.ok(/at all retention limits would be \d\.\d{3} MB: margin \d+ KB is below 150 KB/.test(run.stderr),`self-test обязан предупредить о проекции «все лимиты разом»: ${run.stderr.slice(-400)}`);
  }finally{rmSync(dir,{recursive:true,force:true});}
}

console.log("Monitor audit fixes OK: display gate, honest timing null, v2 acceptance windows, closed-day Sharpe, risk-off counter, graft peak, v3 lines, tranched execution, target change log, shadow evidence, performance numbers, 2.13.0 migration, size budget; review fixes: rolling comparison window, fresh-only engine blocks, capture floor, strict line targets, same-day shadow carry, retention limits, acceptance numbers");
