// Сквозные сценарии сборщика на синтетике (MOCK=1) — правки аудита 10.10.2026, поток «сборщик».
//
// Чистые функции проверяются в unit-test; здесь проверяется ПРОВОДКА: что compute() действительно
// зовёт их с нужными входами и что результат доезжает до снимка. Каждый сценарий — отдельный запуск
// сборщика дочерним процессом с подставленным прошлым состоянием: сборщик читает его один раз при
// загрузке модуля, поэтому в одном процессе два «такта» не проверить.
//
// Сети нет: MOCK=1 строит все наборы данных детерминированным генератором. Набор не зависит от дня
// недели и часа прогона — все метки времени в подставленных состояниях отсчитываются от «сейчас».
// Запускается из live-regression-test (входит в npm run check); можно и отдельно:
//   node scripts/collector-e2e-test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { optionalSnapshotProblemsV1, optionalSnapshotBytesV1, OPTIONAL_FIELD_MAX_BYTES } from "./public-snapshot-contract.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";

const collector=fileURLToPath(new URL("./fetch-snapshot.mjs",import.meta.url));
const dir=mkdtempSync(join(tmpdir(),"btc21m-collector-e2e-"));
const H=36e5,DAY=864e5;
let seq=0;
// Один такт сборщика на синтетике. `previous` — внутреннее состояние прошлого такта (или null — холодный старт).
function tick({previous=null,env={}}={}){
  const id=String(++seq).padStart(2,"0"),out=join(dir,`${id}.json`),state=join(dir,`${id}.state.json`),prev=join(dir,`${id}.prev.json`),absent=join(dir,"absent.json");
  if(previous)writeFileSync(prev,JSON.stringify(previous));
  const r=spawnSync(process.execPath,[collector],{encoding:"utf8",env:{...process.env,MOCK:"1",OUT:out,STATE:state,PREVIOUS_STATE:previous?prev:absent,PREVIOUS_PUBLIC:absent,...env}});
  if(r.status!==0)throw new Error(`сборщик на синтетике упал (такт ${id}):\n${r.stdout||""}${r.stderr||""}`);
  return{pub:JSON.parse(readFileSync(out,"utf8")),state:JSON.parse(readFileSync(state,"utf8")),stderr:r.stderr||""};
}
const card=(snap,id)=>snap.metrics.find(x=>x.id===id);

try{
  const cold=tick();

  // ---- C7г. «OI · суточный сброс»: цена и OI от одной записи истории, подпись — её возраст ----
  {
    const now=Date.now(),P=cold.pub.price;
    const row=(hoursAgo,price,oi)=>({t:new Date(now-hoursAgo*H).toISOString(),strategic:0,tactical:0,price,phase:"фикстура",raw:{oi_by_venue:oi}});
    // Ровно сутки назад: OI площадок ниже нынешнего (1,1 / 4,8 / 3,1 млрд $ в синтетике) на 5,88 %, цена −3 %.
    // Ловушки: запись 22 часа назад (прежняя база OI) и запись 2 часа назад с другой ценой и другим OI.
    const base={Deribit:1.0e9,Hyperliquid:4.5e9,OKX:3.0e9};
    const previous={...cold.state,history:[
      row(26,P*.90,{Deribit:2e9,Hyperliquid:9e9,OKX:6e9}),
      row(24,P*.97,base),
      row(22,P*1.10,{Deribit:.5e9,Hyperliquid:2e9,OKX:1.5e9}),
      row(2,P*1.20,{Deribit:.3e9,Hyperliquid:1e9,OKX:1e9}),
    ]};
    const got=tick({previous}),c=card(got.pub,"oi_purge_24h");
    const oiExpected=(1.1e9+4.8e9+3.1e9)/(1.0e9+4.5e9+3.0e9)*100-100,priceExpected=got.pub.price/(P*.97)*100-100;
    assert.ok(Math.abs(c.value_num-oiExpected)<1e-6,`OI обязан сравниваться со снимком сутки назад: ${c.value_num} против ${oiExpected}`);
    assert.equal(c.value,`+${oiExpected.toFixed(1)}% / 24ч`);
    assert.equal(c.delta,`цена +${priceExpected.toFixed(1)}% / 24ч`,"цена обязана сравниваться с ТЕМ ЖЕ снимком, а не с закрытием прошлых суток");
    // Пауза публикации: ближайший снимок — 26 часов назад. Подпись называет настоящее окно.
    const gapped=tick({previous:{...previous,history:previous.history.filter(h=>Date.parse(h.t)<now-25*H)}});
    assert.match(card(gapped.pub,"oi_purge_24h").value,/ \/ 26ч$/,"после паузы публикации подпись обязана называть настоящее окно");
    assert.match(card(gapped.pub,"oi_purge_24h").delta,/ \/ 26ч$/);
    // Базы в окне ±3 часа нет — карточка пуста.
    const empty=tick({previous:{...previous,history:previous.history.filter(h=>Date.parse(h.t)>now-3*H)}});
    assert.equal(card(empty.pub,"oi_purge_24h").value,"—");
    assert.equal(card(empty.pub,"oi_purge_24h").delta,"");
  }

  // ---- C4. Новые публикуемые поля: холодный старт ----
  {
    const s=cold.pub;
    assert.equal(s.regime_birth,null,"холодный старт: записи о рождении кандидата нет");
    assert.equal(s.tick_diff,null,"холодный старт: сравнивать не с чем");
    assert.deepEqual(s.diagnostics,[],"ни один необязательный расчёт не отказал");
    assert.deepEqual(optionalSnapshotProblemsV1(s),[],"новые поля проходят контракт публичного снимка");
    // Уровни MVRV согласованы с карточкой: текущее значение лежит по ту сторону каждого уровня,
    // по какую перцентиль карточки лежит от порога. Это и есть «то же окно, что у карточки».
    const levels=s.valuation_levels,percentile=card(s,"mvrv_cycle").value_num;
    assert.deepEqual(levels.levels.map(x=>[x.key,x.percentile]),[["capitulation_floor",10],["recovery_anchor",25],["valuation_gate",82],["euphoria",95]]);
    assert.equal(levels.window_days,1460);
    for(const level of levels.levels){
      assert.ok(Number.isFinite(level.mvrv)&&Number.isFinite(level.price_usd),`уровень ${level.key} посчитан`);
      if(levels.mvrv<level.mvrv-2e-4)assert.ok(percentile<=level.percentile,`MVRV ниже уровня ${level.key} — перцентиль карточки не выше ${level.percentile}: ${percentile}`);
      if(levels.mvrv>level.mvrv+2e-4)assert.ok(percentile>=level.percentile,`MVRV выше уровня ${level.key} — перцентиль карточки не ниже ${level.percentile}: ${percentile}`);
      assert.ok(Math.abs(level.price_usd/(level.mvrv*levels.realized_price_usd)-1)<.002,"цена уровня = уровень × реализованная цена");
    }
    // Сверка потоков и остатка бирж: в синтетике три ряда — независимые блуждания, разрыв заведомо
    // больше допуска. Предупреждение обязано нести ровно то, что даёт измерение на тех же рядах.
    process.env.PREVIOUS_STATE=join(dir,"absent.json");process.env.PREVIOUS_PUBLIC=join(dir,"absent.json");
    const {exchangeFlowSupplyCheck}=await import("./fetch-snapshot.mjs");
    const check=exchangeFlowSupplyCheck(cold.state.datasets.coinmetrics.data),warning=s.data_warnings.find(x=>x.code==="exchange_flow_supply_mismatch");
    assert.ok(Math.abs(check.gap_btc)>5000,"фикстура обязана давать разрыв больше допуска, иначе проверка пуста");
    assert.deepEqual([warning?.source,warning?.value,warning?.threshold,warning?.affects],["coinmetrics",Math.sign(check.gap_btc)*Math.round(Math.abs(check.gap_btc)),5000,["exchange_supply","exchange_netflow_30d"]]);
    // На качество решения и состояние источника предупреждение не влияет.
    assert.equal(s.sources.coinmetrics.state,"mock");
    assert.equal(s.decision.quality.status,"good","предупреждение о данных не имеет права понижать качество решения");
    assert.equal(s.data_warnings.some(x=>x.code==="redundancy_lost"),false,"в синтетике у источника ETF нет ног — и предупреждения о резерве нет");
    // Прибавка к размеру публичного снимка — в пределах потолков.
    const bytes=optionalSnapshotBytesV1(s);
    assert.ok(bytes.total>0&&bytes.total<Object.values(OPTIONAL_FIELD_MAX_BYTES).reduce((a,b)=>a+b,0));
  }

  // ---- C4. Второй такт на том же состоянии: разница снимков описывает только настоящие изменения ----
  {
    const second=tick({previous:cold.state}),diff=second.pub.tick_diff;
    assert.ok(diff&&Array.isArray(diff.families)&&Array.isArray(diff.detectors),"со второго такта разница снимков есть");
    for(const row of diff.families){
      assert.equal(card(cold.pub,row.id).score,row.from,`${row.id}: from — балл прошлого снимка`);
      assert.equal(card(second.pub,row.id).score,row.to,`${row.id}: to — балл этого снимка`);
    }
    const changed=second.pub.metrics.filter(m=>m.vote&&m.score!==card(cold.pub,m.id).score).map(m=>m.id);
    assert.deepEqual(diff.families.map(x=>x.id),changed,"в разнице — все изменившиеся голосующие карточки и только они");
    for(const horizon of ["strategic","tactical"])
      if(second.pub.regime_meta[horizon].candidate===cold.pub.regime_meta[horizon].candidate)assert.equal(second.pub.regime_birth[horizon],null,`${horizon}: кандидат прежний, записи о рождении ещё не было — null`);
    assert.deepEqual(second.pub.diagnostics,[]);
  }

  // ---- C4. Рождение кандидата: запись на снимке смены, перенос, потеря внутреннего состояния ----
  {
    const now=cold.pub,otherCandidate=now.regime_meta.strategic.candidate==="defensive"?"transition":"defensive";
    const crafted=structuredClone(cold.state),other=score=>score===-1?-2:-1;
    crafted.regime.strategic=otherCandidate;
    crafted.regime_meta.strategic={...crafted.regime_meta.strategic,state:otherCandidate,candidate:otherCandidate};
    // В «прошлом» снимке у двух семей другие баллы, у блока спроса другой балл, у детектора другое состояние.
    const etfBefore=other(card(now,"etf_regime").score),liquidityBefore=other(card(now,"liquidity_regime").score);
    crafted.metrics.find(x=>x.id==="etf_regime").score=etfBefore;
    crafted.metrics.find(x=>x.id==="liquidity_regime").score=liquidityBefore;
    const demandNow=now.blocks.demand.strategic.score,demandBefore=demandNow-37.5;
    crafted.blocks.demand.strategic.score=demandBefore;
    const recoveryNow=now.detectors.find(x=>x.id==="recovery").state,recoveryBefore=recoveryNow==="calm"?"watch":"calm";
    crafted.detectors.find(x=>x.id==="recovery").state=recoveryBefore;
    crafted.detectors.find(x=>x.id==="leverage").state=now.detectors.find(x=>x.id==="leverage").state==="calm"?"watch":"calm";   // детектор краткосрочного контура
    const born=tick({previous:crafted}),birth=born.pub.regime_birth.strategic;
    const bands=MODEL_POLICY_V1.regime_bands,band=v=>v>=bands.supportive_min?"supportive":v<=bands.adverse_max?"adverse":"neutral";
    assert.deepEqual([birth.candidate,birth.from_candidate],[born.pub.regime_meta.strategic.candidate,otherCandidate]);
    assert.equal(birth.t,born.pub.generated_at,"запись делается на снимке, где кандидат сменился");
    assert.equal(birth.t,born.pub.regime_meta.strategic.since,"рождение кандидата совпадает с началом его отсчёта в гистерезисе");
    assert.equal(birth.price,born.pub.price);
    assert.deepEqual(birth.blocks,{demand:{from:demandBefore,to:demandNow,band_from:band(demandBefore),band_to:band(demandNow)}},"блоки — только изменившиеся, с полосами до и после");
    assert.deepEqual(birth.families.map(x=>[x.block,x.family,x.id,x.name,x.from,x.to]),[
      ["macro","liquidity","liquidity_regime",card(now,"liquidity_regime").name,liquidityBefore,card(now,"liquidity_regime").score],
      ["demand","etf","etf_regime",card(now,"etf_regime").name,etfBefore,card(now,"etf_regime").score]],"семьи — только изменившиеся, имена из карточек");
    assert.deepEqual(birth.detectors,[{id:"recovery",from:recoveryBefore,to:recoveryNow}],"детекторы — только среднесрочного контура");
    assert.equal(birth.note,null);
    assert.equal(born.pub.regime_birth.tactical,null,"краткосрочный кандидат не менялся");
    assert.deepEqual(born.pub.tick_diff.detectors.map(x=>x.id).sort(),["leverage","recovery"],"разница снимков несёт все изменившиеся детекторы");
    assert.deepEqual(optionalSnapshotProblemsV1(born.pub),[]);
    // Перенос: пока кандидат тот же, запись едет из такта в такт без изменений — через внутреннее
    // состояние и через опубликованный снимок (так сборщик стартует после потери состояния).
    const carried=tick({previous:born.state});
    assert.deepEqual(carried.pub.regime_birth.strategic,birth,"запись о рождении переносится, пока кандидат тот же");
    assert.deepEqual(tick({previous:carried.state}).pub.regime_birth.strategic,birth,"и на третьем такте тоже");
    assert.deepEqual(tick({previous:born.pub}).pub.regime_birth.strategic,birth,"перенос работает и от опубликованного снимка");

    // ОТКАЗ НЕОБЯЗАТЕЛЬНОГО РАСЧЁТА: null, строка диагностики, сбор не падает, качество не понижено.
    const broken=tick({previous:{...crafted,detectors:"мусор"}});
    assert.equal(broken.pub.regime_birth,null);assert.equal(broken.pub.tick_diff,null);
    assert.deepEqual(broken.pub.diagnostics.map(x=>x.scope),["regime_birth","tick_diff"],"отказавшие расчёты названы в диагностике снимка");
    assert.ok(broken.pub.diagnostics.every(x=>typeof x.error==="string"&&x.error.length>0));
    assert.match(broken.stderr,/optional calculation failed: regime_birth/,"и в журнале прогона");
    assert.equal(broken.pub.decision.quality.status,born.pub.decision.quality.status,"отказ необязательного расчёта не имеет права понижать качество решения");
    assert.equal(broken.pub.decision.target_pct,born.pub.decision.target_pct,"и цель от него не зависит");
    assert.ok(broken.pub.valuation_levels&&Array.isArray(broken.pub.data_warnings),"остальные необязательные поля при этом посчитаны");
    assert.deepEqual(optionalSnapshotProblemsV1(broken.pub),[]);
    // Результат, не прошедший контракт снимка, до публикации не доходит: перенесённая запись,
    // раздутая сверх бюджета размера, заменяется на null со строкой диагностики.
    const fat=structuredClone(born.state);
    fat.regime_birth.strategic.families=Array.from({length:300},(_,i)=>({block:"demand",family:"etf",id:`m${i}`,name:"х".repeat(30),from:0,to:1}));
    const trimmed=tick({previous:fat});
    assert.equal(trimmed.pub.regime_birth,null);
    assert.match(trimmed.pub.diagnostics.find(x=>x.scope==="regime_birth")?.error||"",/не прошло контракт снимка/);
  }

  // ---- C6. Что compute() передаёт монитору: входы вариантов, значения теневых карточек, рождение, разница ----
  {
    const driver=join(dir,"extras.mjs"),statePath=join(dir,"extras.prev.json");
    writeFileSync(statePath,JSON.stringify(cold.state));
    writeFileSync(driver,`
const m=await import(process.env.MODULE_URL);
await m.collect();
// Основной и резервный ряды MVRV в синтетике совпадают — чтобы видеть, какой из них выбран, резервный
// сдвигается на 1 %; в режиме fallback основной ряд Coin Metrics убирается вовсе.
const reserve=m.collectorDatasets.blockchain_onchain.data;reserve.MVRV=reserve.MVRV.map(p=>({t:p.t,v:p.v*1.01}));
if(process.env.MVRV_SOURCE==="fallback")m.collectorDatasets.coinmetrics.data={...m.collectorDatasets.coinmetrics.data,CapMVRVCur:[]};
const mvrvLast={main:m.collectorDatasets.coinmetrics.data.CapMVRVCur.at(-1)?.v??null,reserve:reserve.MVRV.at(-1).v};
const snap=m.compute(),call=m.monitorCallArguments(),x={variantInputs:call.variantInputs,shadowValues:call.shadowValues,regimeBirth:call.regimeBirth,tickDiff:call.tickDiff};
const brief=a=>a===null?null:{n:a.length,first:a[0],last:a[a.length-1]};
console.log(JSON.stringify({snap:{price:snap.price,regime:snap.regime,regime_meta:snap.regime_meta,decision:snap.decision,blocks:snap.blocks,override:snap.override,detectors:snap.detectors,scores:snap.scores,
  regime_birth:snap.regime_birth,tick_diff:snap.tick_diff,metrics:snap.metrics.map(q=>({id:q.id,vote:q.vote,score:q.score,value_num:q.value_num})),diagnostics:snap.diagnostics},
  parameters:Object.keys(call),mvrvLast,valuation_levels:snap.valuation_levels,mvrvCardSource:snap.metrics.find(q=>q.id==="mvrv_cycle").source,
  extras:{...x,variantInputs:{...x.variantInputs,series:Object.fromEntries(Object.entries(x.variantInputs.series).map(([k,v])=>[k,brief(v)]))}}}));
`);
    const drive=(env={})=>{
      const r=spawnSync(process.execPath,[driver],{encoding:"utf8",maxBuffer:1<<26,env:{...process.env,MOCK:"1",MODULE_URL:new URL("./fetch-snapshot.mjs",import.meta.url).href,PREVIOUS_STATE:statePath,PREVIOUS_PUBLIC:join(dir,"absent.json"),...env}});
      if(r.status!==0)throw new Error(`проводка монитора: сборщик упал\n${r.stdout||""}${r.stderr||""}`);
      return JSON.parse(r.stdout.trim().split("\n").at(-1));
    };
    const main=drive(),{snap,extras,parameters}=main,v=extras.variantInputs,det=id=>snap.detectors.find(x=>x.id===id).state,mvrv=snap.metrics.find(x=>x.id==="mvrv_cycle");
    // Имена параметров вызова — граница потоков «сборщик» ↔ «монитор» (SPEC 1.3): прежние четырнадцать и четыре новых.
    assert.deepEqual(parameters,["previousMonitor","now","price","decision","inputSummary","sourceVintages","revisionAlerts","cashQuotePct","cashQuoteBasis","priceSeries","previousSnapshotPresent","regimeMeta","shadowHysteresis","v2Inputs","variantInputs","shadowValues","regimeBirth","tickDiff"],"параметры вызова монитора");
    assert.deepEqual(Object.keys(v),["price","hard_override","v1","families","series","observed_at"],"входы вариантов — ровно ключи SPEC 1.4");
    // critical_ok — покрытие среднесрочного контура; в снимке публикуется только общее (оба горизонта),
    // поэтому сверяется следствие: общее покрытие в порядке — значит, и среднесрочное тоже.
    assert.equal(typeof v.v1.critical_ok,"boolean");
    if(snap.scores.critical_coverage_ok)assert.equal(v.v1.critical_ok,true,"при полном покрытии среднесрочный контур не может быть «insufficient»");
    if(snap.scores.critical_missing.strategic.length)assert.equal(v.v1.critical_ok,false,"нет обязательной среднесрочной семьи — покрытия нет");
    assert.deepEqual(v.v1,{state:snap.regime.strategic,candidate:snap.regime_meta.strategic.candidate,critical_ok:v.v1.critical_ok,target_pct:snap.decision.target_pct,
      recovery_state:det("recovery"),macro_shock_state:det("macro_shock"),distribution_state:det("distribution"),mvrv_percentile:mvrv.value_num,valuation_score:mvrv.score},"состояние v1 — то, что опубликовано в этом же снимке");
    assert.deepEqual([v.price,v.hard_override],[snap.price,!!snap.override]);
    assert.equal(v.v1.mvrv_percentile,snap.decision.inputs.mvrv_percentile,"перцентиль MVRV — тот же, по которому собрано решение");
    for(const block of ["macro","demand","cycle"]){
      const s=snap.blocks[block].strategic;
      assert.deepEqual(v.families[block],Object.fromEntries(s.expected.map(f=>[f,s.families[f]??null])),`${block}: баллы семей — из блока, отсутствующая семья — null`);
    }
    assert.deepEqual([Object.keys(v.families.macro),Object.keys(v.families.demand),Object.keys(v.families.cycle)],[["liquidity","conditions","stress"],["etf","stablecoins","exchange_supply","institutional"],["valuation","network","activity","miners","trend"]],"двенадцать среднесрочных семей по трём блокам");
    assert.deepEqual(Object.keys(v.series),["hashrate","difficulty","exchange_supply","price_daily","mvrv","mvrv_deep"]);
    for(const [name,min] of [["hashrate",300],["difficulty",60],["exchange_supply",180],["price_daily",1200],["mvrv",180]]){
      assert.ok(v.series[name].n>=min,`ряд ${name}: ${v.series[name].n} точек`);
      assert.ok(Number.isFinite(v.series[name].last.t)&&Number.isFinite(v.series[name].last.v),`ряд ${name}: точки {t,v}`);
    }
    assert.equal(v.series.mvrv_deep,null,"в синтетике глубокого ряда нет — честный null, а не пустой массив");
    assert.deepEqual(Object.keys(v.observed_at),["mvrv","coinmetrics","etf","network","market","mvrv_deep"]);
    assert.ok(["mvrv","coinmetrics","etf","network","market"].every(k=>Number.isFinite(Date.parse(v.observed_at[k]))));
    const shadowIds=["tga_daily","g3_liquidity","gold_axis","sth_pricing","realized_pnl","options_structure","oi_purge_24h","hash_ribbons"];
    assert.deepEqual(Object.keys(extras.shadowValues),shadowIds,"значения восьми теневых карточек");
    for(const id of shadowIds)assert.equal(extras.shadowValues[id],snap.metrics.find(x=>x.id===id).value_num,`${id}: value_num карточки`);
    assert.ok(Number.isFinite(extras.shadowValues.hash_ribbons),"хотя бы одна теневая карточка в синтетике несёт число");
    assert.deepEqual(extras.regimeBirth,snap.regime_birth,"монитору уходит та же запись о рождении, что публикуется");
    assert.deepEqual(extras.tickDiff,snap.tick_diff,"и та же разница снимков");
    assert.deepEqual(snap.diagnostics,[]);
    // РЯД MVRV — ТОТ, ПО КОТОРОМУ СЧИТАЕТ v1. Пока жив Coin Metrics, вариантам и уровням оценки идёт его
    // ряд; когда его нет, карточка v1 переходит на резерв целиком — и вместе с ней обязаны перейти они.
    const round4=x=>Math.round(x*1e4)/1e4;
    assert.notEqual(main.mvrvLast.main,main.mvrvLast.reserve,"фикстура обязана различать основной и резервный ряды");
    assert.equal(v.series.mvrv.last.v,main.mvrvLast.main,"вариантам идёт основной ряд Coin Metrics");
    assert.equal(main.valuation_levels.mvrv,round4(main.mvrvLast.main),"уровни оценки считаются по нему же");
    assert.equal(main.mvrvCardSource,"Coin Metrics");
    const fallback=drive({MVRV_SOURCE:"fallback"});
    assert.notEqual(fallback.mvrvCardSource,"Coin Metrics","без основного ряда карточка v1 переходит на резерв");
    assert.equal(fallback.extras.variantInputs.series.mvrv.last.v,fallback.mvrvLast.reserve,"и вариантам идёт тот же резервный ряд");
    assert.equal(fallback.valuation_levels.mvrv,round4(fallback.mvrvLast.reserve),"и уровни оценки считаются по нему");
    assert.equal(fallback.extras.variantInputs.v1.mvrv_percentile,fallback.snap.metrics.find(x=>x.id==="mvrv_cycle").value_num);
  }

  console.log("Collector end-to-end scenarios OK");
}finally{rmSync(dir,{recursive:true,force:true});}
