// Сквозные сценарии сборщика на синтетике (MOCK=1) — правки аудита 10.10.2026, поток «сборщик».
//
// Чистые функции проверяются в unit-test; здесь проверяется ПРОВОДКА: что compute() действительно
// зовёт их с нужными входами и что результат доезжает до снимка. Каждый сценарий — отдельный запуск
// сборщика дочерним процессом с подставленным прошлым состоянием: сборщик читает его один раз при
// загрузке модуля, поэтому в одном процессе два «такта» не проверить.
//
// Сети нет: MOCK=1 строит все наборы данных детерминированным генератором. Набор не зависит от дня
// недели и часа прогона — все метки времени в подставленных состояниях отсчитываются от «сейчас».
// Часть сценариев идёт БЕЗ синтетики (offlineTick): настоящий collect() с загрузчиками, которым вместо
// сети отвечает HTTP 503, на состоянии прошлого такта — так проверяется, что сборщик делает с кэшем.
// Запускается из live-regression-test (входит в npm run check); можно и отдельно:
//   node scripts/collector-e2e-test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { optionalSnapshotProblemsV1, optionalSnapshotBytesV1, OPTIONAL_FIELD_MAX_BYTES } from "./public-snapshot-contract.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { verifyDecisionLogChainV1 } from "./forward-monitor-v1.mjs";

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
// ТАКТ БЕЗ СЕТИ НА СОСТОЯНИИ ПРОШЛОГО ТАКТА. Сборщик запускается главным модулем — настоящие collect(),
// compute() и запись снимка с состоянием, — но не в синтетике: работают загрузчики и loadDataset, а каждое
// обращение к источнику получает HTTP 503. Всё, что попадёт в снимок, берётся из кэша прошлого состояния.
// Следом кандидат проходит ту же проверку, что перед публикацией (REQUIRE_LIVE=1).
const offlineDriver=join(dir,"offline.mjs");
writeFileSync(offlineDriver,`
import { fileURLToPath } from "node:url";
const realSetTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,_ms,...args)=>realSetTimeout(fn,0,...args);   // паузы между повторами запросов — без ожидания
globalThis.fetch=async()=>new Response("{}",{status:503,headers:{"content-type":"application/json"}});
process.argv[1]=fileURLToPath(process.env.MODULE_URL);   // сборщик исполняет свой главный блок
await import(process.env.MODULE_URL);
`);
function offlineTick(previous){
  const id=String(++seq).padStart(2,"0"),out=join(dir,`${id}.json`),state=join(dir,`${id}.state.json`),prev=join(dir,`${id}.prev.json`),absent=join(dir,"absent.json");
  writeFileSync(prev,JSON.stringify(previous));
  // Ключи провайдеров из окружения в прогон не передаются: сети нет, и в тексты ошибок им попадать незачем.
  const r=spawnSync(process.execPath,[offlineDriver],{encoding:"utf8",env:{...process.env,MOCK:"",FRED_KEY:"",CM_API_KEY:"",SOSO_API_KEY:"",MODULE_URL:new URL("./fetch-snapshot.mjs",import.meta.url).href,OUT:out,STATE:state,PREVIOUS_STATE:prev,PREVIOUS_PUBLIC:absent}});
  if(r.status!==0)throw new Error(`сборщик без сети упал (такт ${id}):\n${r.stdout||""}${r.stderr||""}`);
  const v=spawnSync(process.execPath,[fileURLToPath(new URL("./self-test.mjs",import.meta.url))],{encoding:"utf8",env:{...process.env,REQUIRE_LIVE:"1",REQUIRE_COMPLETE:"",OUT:out,STATE:state}});
  return{pub:JSON.parse(readFileSync(out,"utf8")),state:JSON.parse(readFileSync(state,"utf8")),verify:{status:v.status,text:`${v.stdout||""}${v.stderr||""}`}};
}

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
  regime_birth:snap.regime_birth,tick_diff:snap.tick_diff,metrics:snap.metrics.map(q=>({id:q.id,vote:q.vote,score:q.score,value_num:q.value_num,observed_at:q.observed_at})),diagnostics:snap.diagnostics},
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
    assert.deepEqual(Object.keys(v.observed_at),["mvrv","coinmetrics","etf","network","market","mvrv_deep","macro_liquidity","macro_conditions","macro_stress"]);
    assert.ok(["mvrv","coinmetrics","etf","network","market"].every(k=>Number.isFinite(Date.parse(v.observed_at[k]))));
    // Даты макровходов — те, что стоят на голосующих карточках этого же снимка (суточный фикс кандидата публикует их возраст).
    for(const [key,id] of [["macro_liquidity","liquidity_regime"],["macro_conditions","financial_conditions"],["macro_stress","system_stress"]])assert.equal(v.observed_at[key],snap.metrics.find(x=>x.id===id).observed_at??null,`${key} — дата карточки ${id}`);
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

  // СЦЕНАРИИ БЕЗ СЕТИ. Состояние прошлого такта — такт на синтетике, признанный боевым (mock:false): его
  // наборы годятся в кэш. Сети нет, поэтому каждый набор либо приходит из кэша, либо честно отсутствует.
  const live=()=>{const s=structuredClone(cold.state);s.mock=false;return s;};
  const base=offlineTick(live());
  assert.equal(base.verify.status,0,`такт без сети на исправном состоянии обязан проходить гейт публикации:\n${base.verify.text}`);

  // ---- Н7а. Отказали все три ноги потоков ETF, кэша канона нет: состав источника по ногам опубликован ----
  // Прошлый пакет ETF каноном служить не может (его источник — не The Block), резерв тоже молчит: загрузчик
  // отказывает целиком и уносит состояние ног с собой. Ряд при этом остаётся из прошлого пакета (stale), а
  // кто из резервов жив сейчас, обязано быть видно: ноги — из самого отказа, а не из кэша.
  {
    assert.equal(String(live().datasets.etf.source).startsWith("The Block"),false,"фикстура: прошлый пакет ETF — не канон The Block");
    const etf=base.pub.sources.etf;
    assert.equal(etf.state,"stale");
    assert.match(etf.error,/^ETF flows unavailable: /,"источник отказал целиком: ни зеркал, ни кэша канона, ни резерва");
    assert.deepEqual(etf.legs?.map(l=>[l.name,l.state]),[["The Block","fail"],["The Block (tbstat)","fail"],["SosoValue","fail"]],"ноги публикуются и тогда, когда источник отказал целиком");
    assert.ok(etf.legs.every(l=>/HTTP 503/.test(l.error)),"у каждой отказавшей ноги названа причина");
    assert.ok(etf.legs.every(l=>l.since===base.pub.generated_at),"и начало серии отказов — этот такт");
    assert.deepEqual(optionalSnapshotProblemsV1(base.pub),[],"ноги отказавшего источника проходят контракт снимка");
    assert.deepEqual(base.pub.diagnostics,[]);
  }

  // ---- Н6. Испорченный кэш теневого набора: сборщик его не берёт, кандидат проходит гейт публикации ----
  {
    const now=Date.now(),day0=Math.floor(now/DAY)*DAY,at=t=>new Date(t).toISOString(),doc="https://example.org/doc";
    const daily=(n,value)=>Array.from({length:n},(_,i)=>({t:day0-(n-i)*DAY,v:value(i)}));
    // Пакет набора в той форме, в какой его кладёт в состояние loadDataset; загружен два часа назад.
    const packet=(data,over={})=>({data,observed_at:at(day0-DAY),fetched_at:at(now-2*H),source:"фикстура",source_url:doc,source_urls:[doc],...over});
    const swapTwo=rows=>{const a=rows.slice();[a[50],a[51]]=[a[51],a[50]];return a;};

    const state=live(),recently=at(now-10*60_000);
    // Исправные теневые наборы — контроль обоих путей кэша: «рано опрашивать» (квота) и «источник не ответил».
    state.datasets.sth_onchain=packet({sth_rp:daily(200,i=>60000+i),sopr:daily(200,()=>1.001),lth_sopr:daily(200,()=>1.2)});
    state.datasets.fred_JPNASSETS=packet(daily(60,i=>7e6+i));
    // Испорченные: каждый — своим способом, и каждый до правки либо ронял сбор, либо отвергал кандидата.
    state.datasets.mvrv_deep=packet(daily(2200,i=>1+i%7/10).map((p,i)=>i%9?p:{t:p.t,v:"мусор"}));   // порядок верен, значения — не числа
    state.datasets.gold=packet(swapTwo(daily(300,i=>2000+i)));                                          // две точки переставлены
    state.datasets.tga_daily=packet(daily(200,i=>800+i),{source_urls:doc});                              // список ссылок — строка
    state.datasets.fred_DEXUSEU=packet(daily(60,()=>1.1),{fetched_at:at(now+3*DAY)});                    // загрузка «из будущего»
    state.attempts={...state.attempts,sth_onchain:recently,mvrv_deep:recently};
    const got=offlineTick(state),src=k=>got.pub.sources[k];
    assert.equal(got.verify.status,0,`испорченный кэш теневого набора не имеет права отвергнуть кандидата:\n${got.verify.text}`);
    assert.equal(src("sth_onchain").state,"ok","исправный кэш теневого набора по-прежнему переиспользуется, пока опрашивать рано");
    assert.deepEqual(got.state.datasets.sth_onchain.data,state.datasets.sth_onchain.data);
    assert.equal(src("fred_JPNASSETS").state,"stale","исправный кэш теневого набора по-прежнему выручает при отказе источника");
    assert.deepEqual(got.state.datasets.fred_JPNASSETS.data,state.datasets.fred_JPNASSETS.data);
    for(const [key,why] of [["mvrv_deep","нечисловые значения"],["gold","переставленные точки"],["tga_daily","негодный список ссылок"],["fred_DEXUSEU","метка загрузки из будущего"]]){
      assert.equal(src(key).state,"fail",`${key} (${why}): испорченный кэш не берётся — источник честно отсутствует`);
      assert.equal(key in got.state.datasets,false,`${key}: испорченный пакет не переезжает в новое состояние`);
      assert.equal(src(key).decision_relevant,false);
    }
    assert.match(src("mvrv_deep").error,/source quota/,"mvrv_deep: опрашивать рано, а кэш негоден — причина названа, запроса не было");
    // Решение от теневых наборов не зависит: режим, цель и качество — как в такте без них.
    const decisive=s=>[s.regime,s.decision.target_pct,s.decision.base_target_pct,s.decision.binding_overlays,s.decision.quality];
    assert.deepEqual(decisive(got.pub),decisive(base.pub),"порча теневых наборов не меняет ни решения, ни его качества");

    // РЕШАЮЩИЙ НАБОР — КАК РАНЬШЕ. Его кэш этой проверкой не фильтруется: при отказе источника испорченный
    // пакет возвращается как stale, и останавливает его гейт публикации — кандидат отвергается, на витрине
    // остаётся прошлый снимок. Считать решение без набора молча нельзя.
    const broken=live();broken.datasets.stablecoins.data=swapTwo(broken.datasets.stablecoins.data);
    const held=offlineTick(broken);
    assert.equal(held.pub.sources.stablecoins.state,"stale","решающий набор: кэш берётся как раньше");
    assert.deepEqual(held.state.datasets.stablecoins.data,broken.datasets.stablecoins.data);
    assert.notEqual(held.verify.status,0,"кандидат с испорченным решающим набором обязан быть отвергнут");
    assert.match(held.verify.text,/unsorted dataset:stablecoins/);
  }

  // ---- Н7б. Монитор бросает исключение на новых параметрах: живая линия v1 и журнал решений не встают ----
  // Сборщик исполняется из копии модулей, где на месте монитора стоит обёртка: настоящий монитор лежит рядом
  // под другим именем, а обёртка отказывает, если получила хоть один из четырёх новых параметров (SPEC 1.3).
  // Контроль — тот же такт настоящим монитором. Часы в обоих прогонах заморожены на одном моменте, поэтому
  // решение, хэши и NAV сравниваются дословно.
  {
    const here=fileURLToPath(new URL(".",import.meta.url)),tree=join(dir,"tree"),modules=src=>["",".mjs"].includes(extname(src));   // каталоги и модули
    // Копия — содержимым файлов, без переноса прав каталога: рабочий каталог на сервере несёт setgid, а боевой
    // юнит запрещает его выставлять (cpSync падал на chmod и останавливал сбор — первый такт выкладки 13.10.2026).
    const copyFiles=(from,to,keep)=>{mkdirSync(to,{recursive:true});for(const entry of readdirSync(from,{withFileTypes:true}))if(entry.isFile()&&keep(entry.name))writeFileSync(join(to,entry.name),readFileSync(join(from,entry.name)));};
    copyFiles(here,join(tree,"scripts"),name=>extname(name)===".mjs");
    copyFiles(join(here,"..","docs"),join(tree,"docs"),name=>extname(name)===".mjs"||name==="monitor-graft-v1.json");
    renameSync(join(tree,"scripts","forward-monitor-v1.mjs"),join(tree,"scripts","forward-monitor-v1.real.mjs"));
    writeFileSync(join(tree,"scripts","forward-monitor-v1.mjs"),`export * from "./forward-monitor-v1.real.mjs";
import { updateForwardMonitorV1 as realMonitor } from "./forward-monitor-v1.real.mjs";
export function updateForwardMonitorV1(args){
  const extras=["variantInputs","shadowValues","regimeBirth","tickDiff"].filter(name=>args[name]!=null);
  if(extras.length)throw new Error("монитор не принял новые параметры: "+extras.join(", "));
  return realMonitor(args);
}
`);
    const driver=join(dir,"frozen.mjs"),statePath=join(dir,"frozen.prev.json"),frozenNow=Date.parse(cold.pub.generated_at)+15*60_000;
    writeFileSync(statePath,JSON.stringify(cold.state));
    writeFileSync(driver,`
const now=Number(process.env.FAKE_NOW),RealDate=Date;
globalThis.Date=class extends RealDate{constructor(...args){if(!args.length)super(now);else super(...args);}static now(){return now;}};
const m=await import(process.env.MODULE_URL);
await m.collect();
const s=m.compute(),call=m.monitorCallArguments();
console.log(JSON.stringify({decision:s.decision,regime:s.regime,diagnostics:s.diagnostics,extras:["variantInputs","shadowValues","regimeBirth","tickDiff"].filter(name=>call[name]!=null),
  monitoring:{updated_at:s.monitoring.updated_at,policy_v1:s.monitoring.strategies.policy_v1,performance_v1:s.monitoring.performance.policy_v1,decision_log:s.monitoring.decision_log,
    target_changes:s.monitoring.target_changes,state_changes:s.monitoring.state_changes,started_at:s.monitoring.started_at,reset_events:s.monitoring.reset_events||[]}}));
`);
    const drive=moduleUrl=>{
      const r=spawnSync(process.execPath,[driver],{encoding:"utf8",maxBuffer:1<<26,env:{...process.env,MOCK:"1",FAKE_NOW:String(frozenNow),MODULE_URL:moduleUrl,PREVIOUS_STATE:statePath,PREVIOUS_PUBLIC:join(dir,"absent.json")}});
      if(r.status!==0)throw new Error(`отказ монитора на новых параметрах уронил сбор:\n${r.stdout||""}${r.stderr||""}`);
      return{...JSON.parse(r.stdout.trim().split("\n").at(-1)),stderr:r.stderr||""};
    };
    const control=drive(new URL("./fetch-snapshot.mjs",import.meta.url).href),broken=drive(pathToFileURL(join(tree,"scripts","fetch-snapshot.mjs")).href);
    assert.deepEqual(control.extras,["variantInputs","shadowValues","regimeBirth","tickDiff"],"фикстура: на втором такте монитор получает все четыре новых параметра");
    assert.deepEqual(control.diagnostics,[],"контроль: настоящий монитор новые параметры принимает");
    assert.deepEqual(broken.diagnostics.map(x=>x.scope),["monitor_extras"],"отказ монитора на новых параметрах назван в диагностике снимка");
    assert.match(broken.diagnostics[0].error,/монитор не принял новые параметры: variantInputs, shadowValues, regimeBirth, tickDiff/);
    assert.match(broken.stderr,/optional calculation failed: monitor_extras/,"и в журнале прогона");
    assert.deepEqual(broken.decision,control.decision,"решение — то же до последнего хэша");
    assert.deepEqual(broken.regime,control.regime);
    assert.deepEqual(broken.monitoring.policy_v1,control.monitoring.policy_v1,"линия policy_v1 (NAV, экспозиция, издержки) — та же");
    assert.deepEqual(broken.monitoring.performance_v1,control.monitoring.performance_v1);
    // Журнал решений не рвётся: новая запись — про это решение и ссылается на запись прошлого такта. Всё, что
    // в ней есть, совпадает с записью настоящего монитора; нет в ней только того, что монитор пишет о теневых
    // линиях, — в этом такте они не считались (поэтому и собственный хэш записи другой).
    const before=cold.state.monitoring.decision_log,entry=broken.monitoring.decision_log.at(-1),reference=control.monitoring.decision_log.at(-1);
    assert.equal(entry.previous_log_hash,before.at(-1).log_hash,"запись журнала ссылается на прошлый такт");
    assert.equal(entry.decision_hash,broken.decision.decision_hash);
    for(const key of Object.keys(entry))if(key!=="log_hash")assert.deepEqual(entry[key],reference[key],`запись журнала, поле ${key}: как у настоящего монитора`);
    assert.equal(broken.monitoring.decision_log.length,before.length+1);
    assert.deepEqual(verifyDecisionLogChainV1(broken.monitoring.decision_log),{ok:true,issues:[],records:before.length+1},"цепочка хэшей журнала цела");
    assert.deepEqual([broken.monitoring.started_at,broken.monitoring.reset_events,broken.monitoring.target_changes,broken.monitoring.state_changes],[control.monitoring.started_at,control.monitoring.reset_events,control.monitoring.target_changes,control.monitoring.state_changes],"монитор не сброшен, счётчики те же");
    assert.equal(broken.monitoring.updated_at,new Date(frozenNow).toISOString(),"монитор отработал этот такт");
  }

  console.log("Collector end-to-end scenarios OK");
}finally{rmSync(dir,{recursive:true,force:true});}
