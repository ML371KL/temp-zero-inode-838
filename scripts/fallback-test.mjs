import assert from "node:assert/strict";
// ГЕРМЕТИЧНОСТЬ. Сборщик при загрузке подхватывает прошлый снимок из .state/cache.json или
// docs/snapshot.json. Для контрактного набора это чужое состояние: оно приносит в тесты живые
// данные и делает результат зависящим от того, что лежит в рабочей копии. Отводим оба пути в
// несуществующие файлы ДО импорта модуля — поэтому импорт динамический.
process.env.PREVIOUS_STATE=".state/__test_absent__.json";
process.env.PREVIOUS_PUBLIC=".state/__test_absent__.json";
const {fetchFredSeries,fetchMarket,fetchNetwork,fetchPegs,fetchBlockchainOnchain,fetchCftc,fetchDerivatives,fetchEtfFlows}=await import("./fetch-snapshot.mjs");
const NOW=Date.now(),DAY=864e5;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}}),text=(body,status=200)=>new Response(body,{status,headers:{"content-type":"text/plain"}});
const originalFetch=globalThis.fetch,originalSetTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,_ms,...args)=>originalSetTimeout(fn,0,...args);
let mode="";
const blockchain=(name,n=1500,unit="")=>({status:"ok",name,unit,period:"day",values:Array.from({length:n},(_,i)=>({x:Math.floor((NOW-(n-1-i)*DAY)/1000),y:name==="hash-rate"?600_000_000+i*1000:name==="difficulty"?80e12+i*1e9:name==="mvrv"?1.2+i/10000:name==="n-unique-addresses"?700000+i:name==="n-transactions"?300000+i:name==="miners-revenue"?30e6+i*1000:name==="trade-volume"?5e9+i*1e6:50000+i}))});
// КАЛЕНДАРЬ ФИКСТУР. Отсчёт ведётся ТОРГОВЫМИ днями от последнего дня, чья каноническая метка
// (полдень UTC) уже наступила. Прежняя арифметика «сегодня минус N суток» делала набор зависимым
// от дня недели: в выходные хвост схлопывался, а в будни свежий день оказывался незакрытым, и
// тесты были зелёными ровно по субботам. Здесь такой зависимости нет по построению.
const CANON_HOUR=12*3600e3;
function tradingDays(count,lagTradingDays=0){
  const out=[];
  let idx=Math.floor((NOW-CANON_HOUR)/DAY);
  for(let skipped=0;out.length<count;idx--){
    const t=idx*DAY;
    if([0,6].includes(new Date(t).getUTCDay()))continue;
    if(skipped<lagTradingDays){skipped++;continue;}
    out.unshift(t);
  }
  return out; // полуночи торговых дней, по возрастанию
}
// Значение зависит от КАЛЕНДАРНОГО дня, а не от счётчика: два зеркала одного провайдера обязаны
// совпадать на общих днях (в реальности они байт-в-байт идентичны на 628 пересекающихся днях).
const dayValue=t=>Math.floor(t/DAY)%7===0?-2e8:1.2e8;
// Канон The Block: метка — полдень UTC.
function etfChart(lagTradingDays){
  const rows=tradingDays(260,lagTradingDays).map(t=>({Timestamp:Math.floor((t+CANON_HOUR)/1000),Result:dayValue(t)}));
  return {chart:{jsonFile:{Frequency:"Daily",Series:{"Total Net Flow":{Data:rows}}}}};
}
// Тот же календарь и те же значения, но в соглашении SosoValue: дата вместо метки времени.
function sosoRows(lagTradingDays){
  return tradingDays(260,lagTradingDays).map(t=>({date:new Date(t).toISOString().slice(0,10),totalNetInflow:dayValue(t)}));
}
// Срок квартального контракта обязан отсчитываться от текущего момента. Зашитая дата истечения —
// мина замедленного действия: набор зеленеет ровно до дня экспирации, а потом краснеет без единой
// правки кода (символ 260925 обрушил бы CI около 20.09.2026).
function quarterAhead(){
  const d=new Date(NOW+90*DAY),p=n=>String(n).padStart(2,"0");
  return `${p(d.getUTCFullYear()%100)}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`;
}
function farsideHtml(){
  const rows=[];
  for(let i=200;i>=0;i--){const d=new Date(NOW-i*DAY);if([0,6].includes(d.getUTCDay()))continue;
    const day=String(d.getUTCDate()),mon=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
    rows.push(`<tr><td>${day} ${mon} ${d.getUTCFullYear()}</td><td>50.0</td><td>60.0</td><td>110.0</td></tr>`);}
  return `<table>${rows.join("")}</table>`;
}
function cftcCsv(){const h="report_date_as_yyyy_mm_dd,open_interest_all,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short",r=Array.from({length:24},(_,i)=>`${new Date(NOW-i*7*DAY).toISOString()},${30000-i},8000,2000,3000,12000`);return[h,...r].join("\n");}
globalThis.fetch=async input=>{const u=String(input);
  if(mode==="fred"){if(u.includes("api.stlouisfed.org"))return json({},503);if(u.includes("fredgraph.csv")){const rows=["observation_date,WALCL",...Array.from({length:40},(_,i)=>`${new Date(NOW-(39-i)*7*DAY).toISOString().slice(0,10)},7000000`)];return text(rows.join("\n"));}}
  if(mode==="market_bitstamp"){if(u.includes("exchange.coinbase.com/products/BTC-USD/candles"))return json({},503);if(u.includes("bitstamp.net/api/v2/ohlc")){const q=new URL(u),a=Number(q.searchParams.get("start"))*1000,b=Number(q.searchParams.get("end"))*1000,rows=[];for(let t=a;t<=b;t+=DAY)rows.push({timestamp:String(Math.floor(t/1000)),close:String(50000+Math.floor((t-a)/DAY)),volume:"1000"});return json({data:{ohlc:rows}});}if(u.includes("coins/markets"))return json([{ath:120000}]);}
  if(mode==="market"){if(u.includes("exchange.coinbase.com/products/BTC-USD/candles"))return json({},503);if(u.includes("bitstamp.net/api/v2/ohlc"))return json({},503);if(u.includes("coins/markets"))return json({},503);if(u.includes("charts/market-price"))return json(blockchain("market-price",u.includes("timespan=all")?2000:1500,"USD"));if(u.includes("charts/trade-volume"))return json(blockchain("trade-volume",1500,"USD"));}
  if(mode==="network"){if(u.includes("mempool.space/api/v1/mining/hashrate"))return json({},503);if(u.includes("charts/hash-rate"))return json(blockchain("hash-rate",400,"TH/s"));if(u.includes("charts/difficulty"))return json(blockchain("difficulty",100,""));if(u.includes("difficulty-adjustment"))return json({},503);if(u.includes("fees/recommended"))return json({},503);if(u.includes("blockstream.info/api/fee-estimates"))return json({"1":2.5,"3":2,"6":1.5});}
  if(mode==="pegs"){if(u.includes("stablecoins.llama.fi"))return json({peggedAssets:[]});if(u.includes("products/USDT-USD"))return json({price:"0.9998"});if(u.includes("products/USDC-USD"))return json({price:"1.0001"});if(u.includes("pair=USDTUSD"))return json({error:[],result:{USDTUSD:{c:["0.9999"]}}});if(u.includes("pair=USDCUSD"))return json({error:[],result:{USDCUSD:{c:["1.0000"]}}});if(u.includes("pubticker/USDTUSD"))return json({last:"1.0000"});if(u.includes("pubticker/USDCUSD"))return json({last:"1.0001"});}
  if(mode==="pegs_single"){if(u.includes("stablecoins.llama.fi"))return json({peggedAssets:[]});if(u.includes("products/USDT-USD"))return json({price:"0.9998"});if(u.includes("products/USDC-USD"))return json({price:"1.0001"});return json({},503);}
  if(mode==="onchain"){if(u.includes("bitcoin-data.com/v1/mvrv"))return json(Array.from({length:700},(_,i)=>({unixTs:Math.floor((NOW-(699-i)*DAY)/1000),mvrv:1.2+i/10000})));for(const name of ["n-unique-addresses","n-transactions","miners-revenue"])if(u.includes(`/charts/${name}`))return json(blockchain(name,700,name==="miners-revenue"?"USD":""));}
  if(mode==="etf"){if(u.includes("theblock.co"))return json(etfChart(0));if(u.includes("tbstat.com"))return json({},503);}
  // Зеркало свежее основного API ровно на один торговый день — реальная и постоянная ситуация.
  if(mode==="etf_mirror_fresher"){if(u.includes("theblock.co"))return json(etfChart(1));if(u.includes("tbstat.com"))return json(etfChart(0));}
  // Основной API свежее — источник не должен «скакать» на зеркало без причины.
  if(mode==="etf_primary_fresher"){if(u.includes("theblock.co"))return json(etfChart(0));if(u.includes("tbstat.com"))return json(etfChart(1));}
  // Зеркало свежее, но битое (мало строк): свежесть не должна побеждать валидность.
  if(mode==="etf_mirror_corrupt"){if(u.includes("theblock.co"))return json(etfChart(1));if(u.includes("tbstat.com"))return json({chart:{jsonFile:{Series:{"Total Net Flow":{Data:Array.from({length:12},(_,i)=>({Timestamp:Math.floor((NOW-i*DAY)/1000),Result:1e8}))}}}}});}
  // Зеркало свежее, но расходится с основным API на общих днях — признак порчи одной из копий.
  if(mode==="etf_mirror_disagrees"){if(u.includes("theblock.co"))return json(etfChart(1));if(u.includes("tbstat.com")){const c=etfChart(0);const d=c.chart.jsonFile.Series["Total Net Flow"].Data;d[d.length-5].Result=9.9e8;return json(c);}}
  // Оба зеркала канона мертвы → ряд целиком берётся у SosoValue.
  if(mode==="etf_both_dead"){if(u.includes("theblock.co")||u.includes("tbstat.com"))return json({},503);if(u.includes("historicalInflowChart"))return json({code:0,data:sosoRows(0)});}
  // Мертвы и канон, и резерв: потоки ETF обязаны честно отсутствовать, а не выдумываться.
  if(mode==="etf_all_dead")return json({},503);
  // Канон мёртв, резерв отвечает, но отдаёт величины вне физической полосы. Резерв обязан
  // проходить тот же ETF-контракт, что и канон: подмена источника не повод ослаблять проверку.
  if(mode==="etf_fallback_corrupt"){
    if(u.includes("theblock.co")||u.includes("tbstat.com"))return json({},503);
    if(u.includes("historicalInflowChart"))return json({code:0,data:sosoRows(0).map((x,i,a)=>i>=a.length-2?{...x,totalNetInflow:2e10}:x)});
  }
  // Дополняющий слой SosoValue поверх канона The Block, отставшего на 2 торговых дня. Значения обязаны
  // совпадать с каноном на общих днях — иначе слой будет отбракован проверкой расхождения.
  if(mode.startsWith("etf_soso")){
    if(u.includes("theblock.co"))return json(etfChart(2));
    if(u.includes("tbstat.com"))return json({},503);
    if(u.includes("historicalInflowChart")){
      if(mode==="etf_soso_dead")return json({},503);
      const rows=sosoRows(0);
      if(mode==="etf_soso_drift")rows[rows.length-3].totalNetInflow=9e9;
      return json({code:0,data:rows});
    }
  }
  if(mode==="cftc"){if(u.includes(".json?"))return json({},503);if(u.includes(".csv?"))return text(cftcCsv());}
  if(mode==="derivatives"){if(u.includes("contractType=futures_inverse"))return json({result:"success",tickers:[{symbol:`FI_XBTUSD_${quarterAhead()}`,tag:"quarter",markPrice:"103000",indexPrice:"100000",openInterest:"100000000"}]});if(u.includes("futures.kraken.com"))return json({result:"success",serverTime:new Date(NOW).toISOString(),ticker:{fundingRate:"2.5e-10",markPrice:"40000",openInterest:"2000000000"}});return json({},503);}
  throw new Error(`unexpected ${mode} URL ${u}`);
};
try{
  mode="fred";const f=await fetchFredSeries("WALCL",{limit:30});assert.equal(f.partial,true);assert.match(f.source,/CSV/);assert.equal(f.data.length,30);assert.equal(f.data.at(-1).v,7000000);
  mode="market_bitstamp";const mb=await fetchMarket();assert.equal(mb.data.historySource,"bitstamp");assert.ok(mb.data.price.length>=1200);assert.equal(mb.data.athSource,"coingecko");
  mode="market";const m=await fetchMarket();assert.equal(m.data.historySource,"blockchain");assert.equal(m.data.price.length,1500);assert.equal(m.data.volume.length,1500);assert.equal(m.data.athSource,"blockchain");assert.equal(m.data.price.at(-1).v,51499);
  mode="network";const n=await fetchNetwork();assert.match(n.source,/Blockchain/);assert.equal(n.data.hashrate.length,400);assert.ok(n.data.hashrate.at(-1).v>6e20);assert.equal(n.data.fees.fastest,2.5);
  mode="pegs";const p=await fetchPegs();assert.ok(Math.abs(p.data.USDT-.9999)<.0002);assert.ok(Math.abs(p.data.USDC-1.0001)<.0002);assert.equal(p.partial,true);
  mode="pegs_single";const p1=await fetchPegs();assert.equal(p1.data.USDT,undefined,"one exchange quote must not establish USDT peg");assert.equal(p1.data.USDC,undefined,"one exchange quote must not establish USDC peg");assert.match(p1.errors.join(";"),/at least 2 independent quotes/);
  mode="onchain";const o=await fetchBlockchainOnchain();assert.equal(o.data.MVRV.length,700);assert.equal(o.data.AdrActCnt.length,700);assert.equal(o.data.TxCnt.length,700);assert.equal(o.data.MinerRevUSD.length,700);
  mode="etf";const e=await fetchEtfFlows();assert.equal(e.source,"The Block");assert.ok(e.data.length>=100,`etf rows ${e.data.length}`);assert.ok(e.data.every(x=>![0,6].includes(new Date(x.t).getUTCDay())),"etf weekend rows leaked");

  // ---- Выбор источника ETF: свежайшее ВАЛИДНОЕ зеркало одного провайдера ----
  mode="etf_mirror_fresher";const eM=await fetchEtfFlows();
  assert.equal(eM.source,"The Block (tbstat)","более свежее зеркало обязано побеждать основной API");
  assert.equal(Date.parse(eM.observed_at),tradingDays(1)[0]+CANON_HOUR,"выбрана свежая копия ряда");
  mode="etf_primary_fresher";const eP=await fetchEtfFlows();
  assert.equal(eP.source,"The Block","при более свежем основном API источник не должен уходить на зеркало");
  mode="etf_mirror_corrupt";const eC=await fetchEtfFlows();
  assert.equal(eC.source,"The Block","битое, но более свежее зеркало не должно вытеснять валидный ряд");
  assert.ok(eC.data.length>=100,"выбран полноценный ряд, а не обрезок зеркала");
  mode="etf_mirror_disagrees";const eD=await fetchEtfFlows();
  assert.equal(eD.source,"The Block","при расхождении зеркал обязан побеждать канонический chart-API, а не более свежая копия");
  assert.match(eD.errors.join(" "),/разошлись/,"расхождение зеркал должно быть записано в диагностику");
  mode="etf_both_dead";const eF=await fetchEtfFlows();
  assert.equal(eF.source,"SosoValue","при смерти обоих зеркал канона обязан включиться резервный источник");
  assert.ok(eF.data.length>=100,`строк резерва ${eF.data.length}`);
  // Резерв — это ПОДМЕНА источника с более короткой историей, а перцентиль потоков считается по
  // всей глубине ряда. Молчать об этом нельзя: на короткой базе то же значение получает более
  // высокий ранг, то есть картина систематически менее медвежья.
  assert.equal(eF.partial,true,"работа на резервном источнике обязана помечаться неполной");
  assert.match(eF.errors.join(" "),/перцентили потоков смещены/,"смещение перцентилей обязано быть названо в диагностике");
  mode="etf_all_dead";
  await assert.rejects(()=>fetchEtfFlows(),/ETF flows unavailable/,"при смерти всех источников потоки обязаны отсутствовать, а не выдумываться");
  mode="etf_fallback_corrupt";
  await assert.rejects(()=>fetchEtfFlows(),/ETF flows unavailable/,"резерв обязан проходить тот же ETF-контракт: подмена источника не повод ослаблять проверку");
  // ---- Дополняющий слой SosoValue ----
  // Прошлых наблюдений нет (набор герметичен), поэтому подтвердить свежий день нечем. Это главный
  // контракт слоя: без подтверждения он обязан отказывать В ЗАКРЫТУЮ, а не пропускать день молча.
  mode="etf_soso_fresh";const eS=await fetchEtfFlows();
  assert.equal(eS.source,"The Block","неподтверждённый день обязан быть придержан, а не сшит");
  assert.equal(eS.spliced,0,`сшит неподтверждённый день: ${eS.spliced}`);
  assert.match(eS.errors.join(" "),/не подтверждён повторным наблюдением/,"причина отказа обязана попасть в диагностику");
  // Наблюдения этого прогона обязаны быть возвращены — иначе подтверждать в следующий час нечем,
  // и слой окажется мёртвым навсегда.
  assert.equal(Object.keys(eS.fresh_probe||{}).length,2,"память наблюдений не заполнена: подтверждение никогда не наступит");
  mode="etf_soso_dead";const eSd=await fetchEtfFlows();
  assert.equal(eSd.source,"The Block","смерть дополняющего слоя не должна ронять канон");
  assert.equal(eSd.spliced,0);
  assert.match(eSd.errors.join(" "),/SosoValue/,"недоступность слоя обязана попасть в диагностику");
  mode="etf_soso_drift";const eSx=await fetchEtfFlows();
  assert.equal(eSx.source,"The Block","расхождение с каноном на общих днях обязано отменять сшивку");
  assert.equal(eSx.spliced,0);
  mode="cftc";const c=await fetchCftc();assert.equal(c.partial,true);assert.match(c.source,/CSV/);assert.equal(c.data.length,24);
  mode="derivatives";const d=await fetchDerivatives();assert.equal(d.partial,true);assert.equal(d.data.funding.length,1);assert.equal(d.data.funding[0].venue,"Kraken Futures");assert.equal(d.data.funding[0].rate8h,.00008,"absolute Kraken funding * markPrice * 8");assert.equal(d.data.funding[0].oiUsd,2e9);assert.equal(d.data.basisSource,"Kraken Futures");assert.ok(Number.isFinite(d.data.basis));
  console.log("Fallback contract tests OK");
}finally{globalThis.fetch=originalFetch;globalThis.setTimeout=originalSetTimeout;}
