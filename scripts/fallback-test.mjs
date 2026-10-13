import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {EPISODE_TIMELINE,EPISODE_PUBLISHED_ERROR_1323,EPISODE_SOSO_FRIDAY_USD} from "./collector-etf-episode.mjs";
// ГЕРМЕТИЧНОСТЬ. Сборщик при загрузке подхватывает прошлый снимок из .state/cache.json или
// docs/snapshot.json. Для контрактного набора это чужое состояние: оно приносит в тесты живые
// данные и делает результат зависящим от того, что лежит в рабочей копии. Отводим оба пути в
// несуществующие файлы ДО импорта модуля — поэтому импорт динамический.
process.env.PREVIOUS_STATE=".state/__test_absent__.json";
process.env.PREVIOUS_PUBLIC=".state/__test_absent__.json";
const {fetchFredSeries,fetchMarket,fetchNetwork,fetchPegs,fetchBlockchainOnchain,fetchCftc,fetchDerivatives,fetchEtfFlows,fetchSthOnchain,fetchBitviewDaily,relabelMvrvFallback,changeOfAverage}=await import("./fetch-snapshot.mjs");
const NOW=Date.now(),DAY=864e5;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}}),text=(body,status=200)=>new Response(body,{status,headers:{"content-type":"text/plain"}});
// bitview.space: дневная календарная сетка. Индекс — число суток от 2009-01-01, как у настоящего API;
// ряд заканчивается ПОЗАВЧЕРА, чтобы итог не зависел от времени суток прогона (правило закрытия дня
// «полночь UTC + 1 ч» проверяется отдельно). Значение ряда — функция индекса.
const BV_EPOCH=Date.parse("2009-01-01T00:00:00Z"),BV_FLOOR=Math.floor(NOW/DAY)*DAY;
function bitview(u,{lastDay=BV_FLOOR-2*DAY,values={},override={}}={}){
  const url=new URL(u),m=/^\/api\/series\/([a-z0-9_]+)\/day1$/.exec(url.pathname);
  if(!m)return json({error:{code:"unexpected "+u}},404);
  const name=m[1],lastIdx=Math.round((lastDay-BV_EPOCH)/DAY),len=lastIdx+1;
  if(name!=="date"&&!values[name])return json({error:{type:"not_found",code:"series_not_found"}},404);
  const s=Number(url.searchParams.get("start")),e=url.searchParams.has("end")?Number(url.searchParams.get("end")):len;
  const start=s<0?len+s:s,end=Math.min(e,len),data=[];
  for(let i=start;i<end;i++){const t=BV_EPOCH+i*DAY;data.push(name==="date"?new Date(t).toISOString().slice(0,10):values[name](i,t));}
  return json({version:1,index:"day1",type:name==="date"?"Date":"StoredF32",start,end,stamp:new Date(NOW).toISOString(),data,...(override[name]||{})});
}
const originalFetch=globalThis.fetch,originalSetTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,_ms,...args)=>originalSetTimeout(fn,0,...args);
let mode="";
// Объём свечи открытых суток (BTC) в сценарии market_open_candle — меняется между двумя прогонами.
let openCandleBtc=0;
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
const etfChartFrom=ser=>({chart:{jsonFile:{Frequency:"Daily",Series:{"Total Net Flow":{Data:ser.map(x=>({Timestamp:Math.floor(x.t/1000),Result:x.v}))}}}}});
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
  // Живой Coinbase: дневные свечи, последняя — открытые сутки с произвольным объёмом. Остальное мертво.
  if(mode==="market_open_candle"){
    if(u.includes("exchange.coinbase.com/products/BTC-USD/candles")){
      const q=new URL(u),a=Date.parse(q.searchParams.get("start")),b=Date.parse(q.searchParams.get("end")),today=Math.floor(NOW/DAY)*DAY,rows=[];
      for(let t=Math.ceil(a/DAY)*DAY;t<=b;t+=DAY)rows.push([t/1000,49000,51000,50000,50000,t===today?openCandleBtc:1000+(Math.floor(t/DAY)%7)*10]);
      return json(rows.reverse());
    }
    return json({},503);
  }
  if(mode==="market"){if(u.includes("exchange.coinbase.com/products/BTC-USD/candles"))return json({},503);if(u.includes("bitstamp.net/api/v2/ohlc"))return json({},503);if(u.includes("coins/markets"))return json({},503);if(u.includes("charts/market-price"))return json(blockchain("market-price",u.includes("timespan=all")?2000:1500,"USD"));if(u.includes("charts/trade-volume"))return json(blockchain("trade-volume",1500,"USD"));}
  if(mode==="network"){if(u.includes("mempool.space/api/v1/mining/hashrate"))return json({},503);if(u.includes("charts/hash-rate"))return json(blockchain("hash-rate",400,"TH/s"));if(u.includes("charts/difficulty"))return json(blockchain("difficulty",100,""));if(u.includes("difficulty-adjustment"))return json({},503);if(u.includes("fees/recommended"))return json({},503);if(u.includes("blockstream.info/api/fee-estimates"))return json({"1":2.5,"3":2,"6":1.5});}
  if(mode==="pegs"){if(u.includes("stablecoins.llama.fi"))return json({peggedAssets:[]});if(u.includes("products/USDT-USD"))return json({price:"0.9998"});if(u.includes("products/USDC-USD"))return json({price:"1.0001"});if(u.includes("pair=USDTUSD"))return json({error:[],result:{USDTUSD:{c:["0.9999"]}}});if(u.includes("pair=USDCUSD"))return json({error:[],result:{USDCUSD:{c:["1.0000"]}}});if(u.includes("pubticker/USDTUSD"))return json({last:"1.0000"});if(u.includes("pubticker/USDCUSD"))return json({last:"1.0001"});}
  if(mode==="pegs_single"){if(u.includes("stablecoins.llama.fi"))return json({peggedAssets:[]});if(u.includes("products/USDT-USD"))return json({price:"0.9998"});if(u.includes("products/USDC-USD"))return json({price:"1.0001"});return json({},503);}
  if(mode==="onchain"){if(u.includes("bitview.space/api/series/"))return bitview(u,{values:{mvrv:i=>1.2+(i%700)/10000}});for(const name of ["n-unique-addresses","n-transactions","miners-revenue"])if(u.includes(`/charts/${name}`))return json(blockchain(name,700,name==="miners-revenue"?"USD":""));}
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
  // Жив один Kraken Futures: линейный PF (OI в BTC) и датированные FF. В сценарии derivatives резервный
  // контракт ликвиден (1 000 BTC OI), в derivatives_dead_basis — мёртв: OI 0, оборот 0, mark = index.
  if(mode==="derivatives"||mode==="derivatives_dead_basis"){
    if(u.includes("contractType=futures_inverse"))throw new Error("инверсные контракты Kraken мертвы — запрашивать их нельзя");
    if(u.includes("contractType=flexible_futures"))return json({result:"success",tickers:[mode==="derivatives"
      ?{symbol:`FF_XBTUSD_${quarterAhead()}`,tag:"quarter",markPrice:"103000",indexPrice:"100000",openInterest:"1000",volumeQuote:"5000000",suspended:false}
      :{symbol:`FF_XBTUSD_${quarterAhead()}`,tag:"quarter",markPrice:"100000",indexPrice:"100000",openInterest:"0",vol24h:"0",volumeQuote:"0",suspended:false}]});
    if(u.includes("futures.kraken.com/derivatives/api/v3/tickers/PF_XBTUSD"))return json({result:"success",serverTime:new Date(NOW).toISOString(),ticker:{symbol:"PF_XBTUSD",fundingRate:"0.4",relativeFundingRate:"0.00001",markPrice:"40000",openInterest:"50000",suspended:false}});
    return json({},503);
  }
  throw new Error(`unexpected ${mode} URL ${u}`);
};
try{
  mode="fred";const f=await fetchFredSeries("WALCL",{limit:30});assert.equal(f.partial,true);assert.match(f.source,/CSV/);assert.equal(f.data.length,30);assert.equal(f.data.at(-1).v,7000000);
  mode="market_bitstamp";const mb=await fetchMarket();assert.equal(mb.data.historySource,"bitstamp");assert.ok(mb.data.price.length>=1200);assert.equal(mb.data.athSource,"coingecko");
  mode="market";const m=await fetchMarket();assert.equal(m.data.historySource,"blockchain");assert.equal(m.data.price.length,1500);assert.equal(m.data.volume.length,1499,"точка открытых суток в ряд объёма не входит и на резервном пути");assert.equal(m.data.athSource,"blockchain");assert.equal(m.data.price.at(-1).v,51499);
  // НЕЗАКРЫТАЯ СВЕЧА НЕ ВХОДИТ В РЯД ОБЪЁМА (аудит 10.10.2026, 5-А). Два прогона отличаются только
  // объёмом идущих суток — от почти нуля (первая минута после полуночи UTC) до пятидесяти обычных
  // дней. Ряд объёма и показатель «30 дней к предыдущим 30» обязаны выйти одинаковыми; ценовой ряд
  // при этом по-прежнему заканчивается текущими сутками — на нём стоят тренд и MA решающего контура.
  {
    const today=Math.floor(NOW/DAY)*DAY;
    mode="market_open_candle";openCandleBtc=0.001;const quiet=await fetchMarket();
    openCandleBtc=50_000;const loud=await fetchMarket();
    assert.equal(quiet.data.historySource,"coinbase");
    assert.equal(quiet.data.price.at(-1).t,today,"ценовой ряд обязан заканчиваться текущими сутками");
    assert.equal(quiet.data.volume.at(-1).t,today-DAY,"ряд объёма обязан заканчиваться вчерашними, закрытыми сутками");
    assert.equal(quiet.data.volume.length,quiet.data.price.length-1,"из ряда объёма убрана ровно одна точка — открытые сутки");
    assert.deepEqual(quiet.data.volume,loud.data.volume,"объём открытых суток не имеет права менять ряд");
    const a=changeOfAverage(quiet.data.volume,30,30),b=changeOfAverage(loud.data.volume,30,30);
    assert.ok(Number.isFinite(a)&&a===b,`показатель объёма 30д/30д обязан не зависеть от открытых суток: ${a} против ${b}`);
    // Почти пустая свеча первых минут суток раньше ещё и проваливала контракт единиц (объём < $1 млн
    // «не USD/день») — ряд объёма обнулялся целиком. Теперь контракт судит по закрытому дню.
    assert.ok(!quiet.errors.some(e=>/^volume:/.test(e)),`контракт объёма не должен падать на пустой открытой свече: ${quiet.errors.join("; ")}`);
  }
  mode="network";const n=await fetchNetwork();assert.match(n.source,/Blockchain/);assert.equal(n.data.hashrate.length,400);assert.ok(n.data.hashrate.at(-1).v>6e20);assert.equal(n.data.fees.fastest,2.5);
  mode="pegs";const p=await fetchPegs();assert.ok(Math.abs(p.data.USDT-.9999)<.0002);assert.ok(Math.abs(p.data.USDC-1.0001)<.0002);assert.equal(p.partial,true);
  mode="pegs_single";const p1=await fetchPegs();assert.equal(p1.data.USDT,undefined,"one exchange quote must not establish USDT peg");assert.equal(p1.data.USDC,undefined,"one exchange quote must not establish USDC peg");assert.match(p1.errors.join(";"),/at least 2 independent quotes/);
  mode="onchain";const o=await fetchBlockchainOnchain();assert.equal(o.data.MVRV.length,4*365,"резерв MVRV обрезается ровно до четырёх лет");assert.equal(o.mvrv_source,"bitview.space");assert.match(o.source,/bitview\.space/);assert.equal(o.data.AdrActCnt.length,700);assert.equal(o.data.TxCnt.length,700);assert.equal(o.data.MinerRevUSD.length,700);
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

  // КЭШ ПОДТВЕРЖДЁННОГО ДНЯ: SosoValue отвалился на один прогон, но уже подтверждённый день
  // обязан остаться в ряду. Иначе получается ровно тот одиночный встречный снимок, который
  // обнуляет 48-часовой отсчёт гистерезиса, — единственный подтверждённый источник такого в системе.
  {
    const dir=mkdtempSync(join(tmpdir(),"etf-cache-"));
    const days=tradingDays(400);
    const canon=days.slice(0,-1).map(t=>({t:t+CANON_HOUR,v:dayValue(t)}));   // канон отстал на день
    const fresh=[{t:days.at(-1)+CANON_HOUR,v:dayValue(days.at(-1))}];        // он уже был сшит час назад
    const drive=(state,label)=>{
      writeFileSync(join(dir,"state.json"),JSON.stringify(state));
      writeFileSync(join(dir,"drive.mjs"),`
const __t=Number(process.env.FAKE_NOW);
if(Number.isFinite(__t)){const R=Date;class D extends R{constructor(...a){if(!a.length)super(__t);else super(...a);}static now(){return __t;}}globalThis.Date=D;}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json"}});
globalThis.fetch=async i=>{const u=String(i);
  if(u.includes("theblock.co"))return json(${JSON.stringify(etfChartFrom(canon))});
  if(u.includes("tbstat.com"))return json({},503);
  return json({},503);};   // SosoValue мёртв
const {fetchEtfFlows}=await import(process.env.MODULE_URL);
const r=await fetchEtfFlows();
console.log(JSON.stringify({source:r.source,len:r.data.length,last:r.data.at(-1).t,spliced:r.spliced,partial:r.partial,canon_last:r.canon_last,errors:r.errors}));
`);
      const out=execFileSync(process.execPath,[join(dir,"drive.mjs")],{encoding:"utf8",env:{...process.env,
        MODULE_URL:new URL("./fetch-snapshot.mjs",import.meta.url).href,FAKE_NOW:String(NOW),
        PREVIOUS_STATE:join(dir,"state.json"),PREVIOUS_PUBLIC:join(dir,"state.json")}});
      return JSON.parse(out.trim().split("\n").at(-1));
    };
    const mk=ageH=>({datasets:{etf:{source:"The Block + SosoValue",data:[...canon,...fresh],
      spliced_cache:{days:fresh,at:new Date(NOW-ageH*3600e3).toISOString()}}}});

    const alive=drive(mk(2));
    assert.equal(alive.spliced,1,"свежий кэш обязан оживить подтверждённый день при отказе слоя");
    assert.ok(alive.canon_last,"основной путь обязан публиковать границу истинного канона: без неё сшитые дни отмываются в канон на следующем прогоне");
    assert.equal(alive.last,fresh[0].t,"наблюдение обязано остаться на сшитом дне, а не откатиться к канону");
    assert.match(alive.source,/SosoValue/,"атрибуция обязана честно называть дополняющий слой");
    assert.match(alive.errors.join(" "),/кэша подтверждения/,"оживление из кэша обязано быть названо в диагностике");
    assert.ok(!alive.partial,"ряд не укоротился — помечать пакет неполным не за что");

    const stale=drive(mk(25));
    assert.equal(stale.spliced,0,"кэш старше суток обязан протухать, а не держать неперепроверенный день");
    assert.equal(stale.len,canon.length,"после протухания ряд обязан честно вернуться к канону");
    rmSync(dir,{recursive:true,force:true});
  }

  // ОДНОВРЕМЕННЫЙ ОТКАЗ ЗЕРКАЛ И СЛОЯ. Ряд собирается из кэша канона, а подтверждённый день
  // обязан прийти из кэша подтверждения. Раньше эта ветка про кэш дня не знала: защита была
  // закрыта на основном маршруте и открыта на соседнем.
  {
    const dir=mkdtempSync(join(tmpdir(),"etf-both-"));
    const days=tradingDays(400);
    const canon=days.slice(0,-1).map(t=>({t:t+CANON_HOUR,v:dayValue(t)}));
    const fresh=[{t:days.at(-1)+CANON_HOUR,v:dayValue(days.at(-1))}];
    writeFileSync(join(dir,"state.json"),JSON.stringify({datasets:{etf:{
      source:"The Block (кэш) + SosoValue",data:[...canon,...fresh],
      canon_last:new Date(canon.at(-1).t).toISOString(),
      spliced_cache:{days:fresh,at:new Date(NOW-2*3600e3).toISOString()}}}}));
    writeFileSync(join(dir,"drive.mjs"),`
const __t=Number(process.env.FAKE_NOW);
if(Number.isFinite(__t)){const R=Date;class D extends R{constructor(...a){if(!a.length)super(__t);else super(...a);}static now(){return __t;}}globalThis.Date=D;}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json"}});
globalThis.fetch=async()=>json({},503);   // мертвы ВСЕ источники
const {fetchEtfFlows}=await import(process.env.MODULE_URL);
const r=await fetchEtfFlows();
console.log(JSON.stringify({source:r.source,len:r.data.length,last:r.data.at(-1).t,spliced:r.spliced,canon_last:r.canon_last,hasCache:!!r.spliced_cache,errors:r.errors}));
`);
    const out=execFileSync(process.execPath,[join(dir,"drive.mjs")],{encoding:"utf8",env:{...process.env,
      MODULE_URL:new URL("./fetch-snapshot.mjs",import.meta.url).href,FAKE_NOW:String(NOW),
      PREVIOUS_STATE:join(dir,"state.json"),PREVIOUS_PUBLIC:join(dir,"state.json")}});
    const r=JSON.parse(out.trim().split("\n").at(-1));
    assert.equal(r.last,fresh[0].t,"при отказе обоих источников подтверждённый день обязан прийти из кэша");
    assert.match(r.source,/SosoValue/,"атрибуция обязана называть слой, чей день в ряду");
    assert.ok(r.hasCache,"ступень кэша обязана СОХРАНЯТЬ кэш дня, иначе он теряется на следующем прогоне");
    assert.equal(r.canon_last,new Date(canon.at(-1).t).toISOString(),"граница истинного канона обязана публиковаться, иначе дни слоя отмоются в канон");
    rmSync(dir,{recursive:true,force:true});
  }
  // ПЕРВАЯ СТУПЕНЬ РЕЗЕРВА: зеркала мертвы, но история The Block лежит в состоянии. Она обязана
  // стать основой — терять половину глубины из-за отказа эндпоинта нельзя, перцентиль потоков
  // считается по всему ряду. Прошлый снимок читается сборщиком ОДИН раз при загрузке модуля,
  // поэтому обе ступени в одном процессе не проверить: развилка проверяется в дочернем.
  {
    const dir=mkdtempSync(join(tmpdir(),"etf-tier-"));
    const canon=tradingDays(400).map(t=>({t:t+CANON_HOUR,v:dayValue(t)}));
    writeFileSync(join(dir,"state.json"),JSON.stringify({datasets:{etf:{source:"The Block",data:canon}}}));
    writeFileSync(join(dir,"drive.mjs"),`
// Дочерний процесс обязан жить в том же «сейчас», что и родитель: иначе фикстуры, построенные от
// родительского календаря, окажутся для него из будущего или протухшими. Набор гоняется с
// подменённой датой по всем дням недели, и без этой строки он краснел бы шесть дней из семи.
const __t=Number(process.env.FAKE_NOW);
if(Number.isFinite(__t)){const R=Date;class D extends R{constructor(...a){if(!a.length)super(__t);else super(...a);}static now(){return __t;}}globalThis.Date=D;}
const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json"}});
globalThis.fetch=async i=>{const u=String(i);
  if(u.includes("theblock.co")||u.includes("tbstat.com"))return json({},503);
  if(u.includes("historicalInflowChart"))return json({code:0,data:${JSON.stringify(sosoRows(0))}});
  return json({},503);};
const {fetchEtfFlows}=await import(process.env.MODULE_URL);
const r=await fetchEtfFlows();
console.log(JSON.stringify({source:r.source,len:r.data.length,partial:r.partial,errors:r.errors}));
`);
    const out=execFileSync(process.execPath,[join(dir,"drive.mjs")],{encoding:"utf8",env:{...process.env,MODULE_URL:new URL("./fetch-snapshot.mjs",import.meta.url).href,FAKE_NOW:String(NOW),PREVIOUS_STATE:join(dir,"state.json"),PREVIOUS_PUBLIC:join(dir,"state.json")}});
    const r=JSON.parse(out.trim().split("\n").at(-1));
    assert.match(r.source,/^The Block \(кэш\)/,"основой обязана стать кэшированная история канона, а не более короткий резерв");
    assert.ok(r.len>=400,`глубина ряда обязана сохраниться: ${r.len} вместо >=400`);
    assert.equal(r.partial,true,"работа на кэше обязана помечаться неполной");
    assert.match(r.errors.join(" "),/история взята из кэша/,"причина обязана быть названа");
    rmSync(dir,{recursive:true,force:true});
  }
  // ===== РЯД КАНОНА НЕ УКОРАЧИВАЕТСЯ (аудит 10.10.2026, C1) =====
  // ЭПИЗОД 20–21.09.2026 НА НАСТОЯЩИХ ДАННЫХ. Пятнадцать тактов из git-истории снимков: пять раз за
  // 18 часов зеркало tbstat не отвечало, ряд откатывался на день, балл семьи ETF уходил с 0 на −0,5,
  // кандидат режима мигал и обнулял 48-часовой отсчёт повышения. Прогон исполняет настоящие
  // fetchEtfFlows и buildMetrics такт за тактом (scripts/collector-etf-episode.mjs) в двух вариантах.
  {
    const run=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL("./collector-etf-episode.mjs",import.meta.url)),"--json"],{encoding:"utf8",maxBuffer:1<<26}).trim().split("\n").at(-1));
    assert.equal(run.control.length,EPISODE_TIMELINE.length);assert.equal(run.hold.length,EPISODE_TIMELINE.length);
    // БЕЗ РЕЕСТРА прогон обязан повторить опубликованную историю дословно — это проверка самой
    // фикстуры: баллы, подписи источника, пометки partial и моменты обнуления отсчёта взяты из снимков.
    for(const [i,step] of EPISODE_TIMELINE.entries()){
      const c=run.control[i],at=`${step.t.slice(5,16)} (${step.commit})`;
      assert.equal(c.score,step.published.score,`без реестра балл семьи ETF обязан совпасть с опубликованным: ${at}`);
      assert.equal(c.source,step.published.source,`подпись источника: ${at}`);
      assert.equal(c.partial,step.published.state==="partial",`пометка partial: ${at}`);
      assert.equal(c.candidate,step.published.candidate,`кандидат режима: ${at}`);
      assert.equal(c.since,step.published.since,`начало отсчёта кандидата: ${at}`);
    }
    assert.deepEqual([run.control[0].flows,run.control[0].p5,run.control[0].p20],["5д -356 BTC · 20д 21 тыс. BTC","38-й перцентиль","52-й перцентиль"],"карточки снимка 13:09 воспроизводятся дословно");
    assert.deepEqual([run.control[1].flows,run.control[1].p5,run.control[1].p20],["5д -6 тыс. BTC · 20д 24 тыс. BTC","21-й перцентиль","54-й перцентиль"],"карточки снимка 13:23 воспроизводятся дословно");
    assert.equal(run.control[1].errors,EPISODE_PUBLISHED_ERROR_1323,"диагностика снимка 13:23 воспроизводится дословно");
    assert.equal(run.control[4].last_value,EPISODE_SOSO_FRIDAY_USD,"14:39: прежний код заново сшивал пятницу значением SosoValue");
    // Дефект, ради которого всё это: на ВТОРОМ подряд укороченном снимке (15:23) пометка исчезала.
    assert.deepEqual([run.control[7].last_day,run.control[7].score,run.control[7].partial],["2026-09-17",-0.5,false],"15:23: ряд укорочен, балл −0,5, а пакет уже «ok»");
    const resets=a=>a.filter((x,i)=>i>0&&a[i-1].candidate==="transition"&&x.candidate!=="transition").length;
    assert.equal(resets(run.control),5,"без реестра 48-часовой отсчёт повышения обнуляется пять раз");
    assert.equal(run.control.at(-1).regime,"deteriorating","без реестра к концу эпизода повышение так и не состоялось");

    // С РЕЕСТРОМ: ряд не укорачивается ни на одном такте, балл не дрожит, отсчёт не обнуляется.
    for(const [i,step] of EPISODE_TIMELINE.entries()){
      const h=run.hold[i],at=step.t.slice(5,16);
      assert.equal(h.score,0,`${at}: балл семьи ETF обязан оставаться 0`);
      assert.equal(h.demand,-18.75,`${at}: блок спроса обязан оставаться −18,75`);
      assert.deepEqual([h.last_day,h.last_value,h.rows],["2026-09-18",433_000_000,674],`${at}: пятница остаётся в ряду со значением канона`);
      assert.equal(h.partial,false,`${at}: ряд не укорочен — помечать пакет неполным не за что`);
      assert.deepEqual([h.candidate,h.since],["transition","2026-09-18T19:38:51.492Z"],`${at}: кандидат и его отсчёт не тронуты`);
      assert.equal(h.registry_friday_at,EPISODE_TIMELINE[0].t,`${at}: момент первого принятия дня не освежается ничем`);
      assert.equal(h.legs.find(l=>l.name==="The Block (tbstat)").state,step.tbstat?"ok":"fail",`${at}: состояние ноги tbstat`);
      assert.equal(h.legs.find(l=>l.name==="SosoValue").state,step.soso?"ok":"fail",`${at}: состояние ноги SosoValue`);
      assert.equal(h.legs.find(l=>l.name==="The Block").state,"ok");
      if(step.tbstat){
        assert.deepEqual([h.held,h.source,h.canon_last],[0,"The Block (tbstat)","2026-09-18T12:00:00.000Z"],`${at}: живой канон несёт пятницу сам`);
        assert.doesNotMatch(h.errors,/удержан/);
      }else{
        assert.deepEqual([h.held,h.source],[1,"The Block"],`${at}: день удержан поверх отставшего зеркала`);
        assert.match(h.errors,/день 2026-09-18 удержан: принят от канона \(The Block \(tbstat\)\)/,`${at}: диагностика обязана назвать удержанный день и зеркало`);
        assert.equal(h.canon_last,"2026-09-17T12:00:00.000Z",`${at}: граница истинного канона не двигается — удержанный день не отмывается в канон`);
        assert.equal(h.spliced,0,`${at}: SosoValue не подменяет значение дня, уже принятого от канона`);
      }
    }
    assert.equal(resets(run.hold),0,"с реестром отсчёт не обнуляется ни разу");
    assert.equal(run.hold.find(x=>x.regime==="transition")?.t,"2026-09-20T20:24:18.023Z","повышение публикуется на первом такте после 48 часов — на 59 часов раньше, чем в бою");
  }

  // УДЕРЖАНИЕ ДНЯ КАНОНА: ГРАНИЦЫ. Календарь — в торговых днях от последнего дня, чей канонический
  // момент наступил. D — этот день, «отставание N» — ряд, заканчивающийся на N торговых дней раньше.
  // Каждый прогон — дочерний процесс: прошлое состояние читается сборщиком один раз при загрузке.
  {
    const dir=mkdtempSync(join(tmpdir(),"etf-hold-"));
    writeFileSync(join(dir,"drive.mjs"),`
const {readFileSync}=await import("node:fs");
const cfg=JSON.parse(readFileSync(process.env.CFG,"utf8")),__t=Number(process.env.FAKE_NOW);
if(Number.isFinite(__t)){const R=Date;class D extends R{constructor(...a){if(!a.length)super(__t);else super(...a);}static now(){return __t;}}globalThis.Date=D;}
const __st=globalThis.setTimeout;globalThis.setTimeout=(fn,_ms,...a)=>__st(fn,0,...a);
const reply=x=>x==null?new Response("{}",{status:503}):new Response(JSON.stringify(x),{status:200,headers:{"content-type":"application/json"}});
globalThis.fetch=async i=>{const u=String(i);
  if(u.includes("theblock.co"))return reply(cfg.chart);
  if(u.includes("tbstat.com"))return reply(cfg.tbstat);
  if(u.includes("historicalInflowChart"))return reply(cfg.soso);
  return reply(null);};
const {fetchEtfFlows}=await import(process.env.MODULE_URL);
try{const r=await fetchEtfFlows();console.log(JSON.stringify({ok:true,packet:r}));}
catch(e){console.log(JSON.stringify({ok:false,error:String(e&&e.message||e),legs:e&&e.legs||null}));}
`);
    let n=0;
    // chart/tbstat/soso: число — отставание ряда в торговых днях, null — источник не отвечает, объект — готовое тело ответа.
    // Начало истории у зеркал общее, отставшее зеркало короче с конца — как в жизни.
    const flowPoints=lag=>tradingDays(400).slice(0,400-lag).map(t=>({Timestamp:Math.floor((t+CANON_HOUR)/1000),Result:dayValue(t)}));
    const chartBody=x=>typeof x==="number"?{ok:true,status:"success",message:"Success!",data:{chart:{jsonFile:{Frequency:"Daily",Series:{"Total Net Flow":{Data:flowPoints(x)}}}}},error:""}:x;
    const tbstatBody=x=>typeof x==="number"?{Frequency:"Daily",Series:{"Total Net Flow":{Data:flowPoints(x)}}}:x;
    const sosoBody=x=>typeof x==="number"?{code:0,data:sosoRows(x)}:x;
    const etfRun=({state=null,chart=null,tbstat=null,soso=null})=>{
      const id=++n,cfgPath=join(dir,`cfg-${id}.json`),statePath=join(dir,`state-${id}.json`);
      writeFileSync(cfgPath,JSON.stringify({chart:chartBody(chart),tbstat:tbstatBody(tbstat),soso:sosoBody(soso)}));
      if(state)writeFileSync(statePath,JSON.stringify(state));
      const out=execFileSync(process.execPath,[join(dir,"drive.mjs")],{encoding:"utf8",maxBuffer:1<<26,env:{...process.env,CFG:cfgPath,
        MODULE_URL:new URL("./fetch-snapshot.mjs",import.meta.url).href,FAKE_NOW:String(NOW),
        PREVIOUS_STATE:state?statePath:join(dir,"absent.json"),PREVIOUS_PUBLIC:join(dir,"absent.json")}});
      const r=JSON.parse(out.trim().split("\n").at(-1));
      return r.ok?r.packet:r;
    };
    // Состояние следующего такта — пакет, каким его кладёт loadDataset.
    const next=(packet,patch=p=>p)=>({datasets:{etf:patch({...structuredClone(packet),fetched_at:new Date(NOW).toISOString()})}});
    const day=lag=>tradingDays(1,lag)[0]+CANON_HOUR,D=day(0),dk=t=>new Date(t).toISOString().slice(0,10);
    const lastT=p=>p.data.at(-1).t,legState=(p,name)=>(p.legs||[]).find(l=>l.name===name)?.state;
    const errorsOf=p=>p.errors.join(" ; ");

    // 1. Свежее зеркало принесло день D, отстающее — по D−1. Затем свежее зеркало замолчало.
    const a=etfRun({chart:1,tbstat:0});
    assert.equal(a.source,"The Block (tbstat)");assert.equal(lastT(a),D);
    assert.deepEqual([legState(a,"The Block"),legState(a,"The Block (tbstat)"),legState(a,"SosoValue")],["ok","ok","fail"],"ноги: оба зеркала живы, слой SosoValue мёртв");
    const regA=a.canon_days.find(x=>x.t===D);
    assert.ok(regA&&regA.from==="The Block (tbstat)","день, принятый от канона, обязан попасть в реестр вместе с зеркалом-источником");
    assert.equal(a.canon_days.length,5,"в реестре — хвост канона, а не весь ряд");
    const b=etfRun({state:next(a),chart:1});
    assert.equal(lastT(b),D,"при отказе свежего зеркала день обязан остаться в ряду");
    assert.equal(b.data.at(-1).v,dayValue(D-CANON_HOUR),"значение удержанного дня — то, что отдал канон");
    assert.equal(b.data.length,a.data.length,"ряд не укорочен и не удлинён");
    assert.deepEqual([b.source,b.held,b.partial??false],["The Block",1,false],"основа — живое отстающее зеркало; пакет не помечается неполным");
    assert.match(errorsOf(b),new RegExp(`день ${dk(D)} удержан`),"удержание обязано быть названо в диагностике");
    assert.equal(b.canon_last,new Date(day(1)).toISOString(),"граница истинного канона — край ЖИВОГО зеркала, а не удержанного дня");
    assert.deepEqual([legState(b,"The Block"),legState(b,"The Block (tbstat)")],["ok","fail"],"молчащее зеркало обязано быть видно как отказавшая нога");
    assert.equal(b.canon_days.find(x=>x.t===D).at,regA.at,"метка первого принятия переносится без изменений");

    // 2. Второй, третий подряд такт с молчащим зеркалом: день по-прежнему в ряду, срок не продлевается.
    const b2=etfRun({state:next(b),chart:1}),b3=etfRun({state:next(b2),chart:1});
    for(const p of [b2,b3]){
      assert.equal(lastT(p),D);assert.equal(p.partial??false,false);
      assert.equal(p.canon_days.find(x=>x.t===D).at,regA.at,"удержание не имеет права освежать собственный срок");
      assert.equal(p.canon_last,new Date(day(1)).toISOString());
    }

    // 3. Отказали ВСЕ зеркала: основой становится кэш канона, и удержанный хвост в него не отмыт —
    //    кэш заканчивается на границе истинного канона, а день D снова дописан из реестра.
    const c=etfRun({state:next(b3)});
    assert.match(c.source,/^The Block \(кэш\)/);
    assert.equal(lastT(c),D,"и на кэше канона принятый день остаётся в ряду");
    assert.equal(c.canon_last,new Date(day(1)).toISOString(),"кэш канона обязан кончаться там же, где кончался живой канон");
    assert.equal(c.held,1);assert.equal(c.partial,true,"работа на кэше по-прежнему помечается неполной");
    assert.equal(c.canon_days.find(x=>x.t===D).at,regA.at,"кэш не пополняет реестр и не освежает метки");
    assert.deepEqual(c.legs.map(l=>l.state),["fail","fail","fail"]);

    // 4. СРОК. 119 часов от первого принятия — день держится; 121 час — срок истёк, ряд честно
    //    возвращается к живому канону, и пакет помечен. Срок двигается подменой метки принятия.
    const aged=(h,from=b)=>next(from,p=>{for(const x of p.canon_days)if(x.t===D)x.at=new Date(NOW-h*3600e3).toISOString();return p;});
    assert.equal(lastT(etfRun({state:aged(119),chart:1})),D,"за час до срока день ещё удержан");
    const expired=etfRun({state:aged(121),chart:1});
    assert.equal(lastT(expired),day(1),"после срока удержания ряд обязан вернуться к живому канону");
    assert.equal(expired.partial,true,"ряд короче принятого от канона — пакет обязан быть помечен");
    assert.match(errorsOf(expired),/срок удержания истёк \(принят 121 ч назад, предел 120 ч\)/);
    assert.match(errorsOf(expired),new RegExp(`ряд короче принятого от канона: ${dk(D)}`));
    // ПОМЕТКА НЕ ИСЧЕЗАЕТ НА ВТОРОМ СНИМКЕ. Раньше деградация сравнивалась только с прошлым прогоном,
    // и второй подряд укороченный снимок выходил «ok»: сравнивать было уже не с чем.
    const expired2=etfRun({state:next(expired),chart:1});
    assert.equal(lastT(expired2),day(1));
    assert.equal(expired2.partial,true,"на втором подряд укороченном снимке пометка обязана держаться");
    assert.match(errorsOf(expired2),/ряд короче принятого от канона/);
    // Через неделю реестр забывает день: это уже не «зеркало моргнуло», и вечной жёлтой пометки нет.
    const forgotten=etfRun({state:aged(169,expired2),chart:1});
    assert.equal(forgotten.partial??false,false,"через неделю реестр обязан забыть день — пометка не вечная");
    assert.equal(forgotten.canon_days.some(x=>x.t===D),false);
    // Метка принятия из будущего — испорченное состояние, доверять нельзя.
    assert.equal(lastT(etfRun({state:aged(-2),chart:1})),day(1),"метка принятия из будущего не имеет права удерживать день");

    // 5. КАНОН ДОГНАЛ — ВЫТЕСНЯЕТ, в том числе с другим значением. В реестре день D лежит со значением
    //    777 млн; живое зеркало теперь отдаёт D со своим значением — в ряд идёт значение зеркала.
    const revised=next(b,p=>{for(const x of p.canon_days)if(x.t===D)x.v=7.77e8;return p;});
    const caught=etfRun({state:revised,chart:0});
    assert.equal(lastT(caught),D);
    assert.equal(caught.data.at(-1).v,dayValue(D-CANON_HOUR),"догнавший канон вытесняет удержанное значение своим");
    assert.equal(caught.held??0,0);assert.doesNotMatch(errorsOf(caught),/удержан/);
    assert.equal(caught.canon_days.find(x=>x.t===D).v,dayValue(D-CANON_HOUR),"реестр принимает значение живого канона");
    assert.equal(caught.canon_days.find(x=>x.t===D).at,regA.at,"а метку первого принятия сохраняет");
    // Пока канон дня не несёт, в ряд идёт значение из реестра — то, которое канон отдал последним.
    assert.equal(etfRun({state:revised,chart:1}).data.at(-1).v,7.77e8);

    // 6. ПРЕДЕЛ. Живой канон отстал от принятого на три дня — удержаны все три; на четыре — это уже
    //    не удержание, а подмена источника: ряд возвращается к живому канону и помечается.
    const wide=etfRun({chart:4,tbstat:0});
    const three=etfRun({state:next(wide),chart:3});
    assert.deepEqual([lastT(three),three.held],[D,3],"ровно на пределе удержание обязано работать");
    const four=etfRun({state:next(wide),chart:4});
    assert.equal(lastT(four),day(4),"отставание больше трёх дней удержанием не закрывается");
    assert.match(errorsOf(four),/отстал от принятого на 4 дн — больше допустимых 3/);
    assert.equal(four.partial,true);
    // Дыр в ряду не бывает: срок среднего дня истёк — перенос обрывается на нём, а не перешагивает.
    const holed=next(wide,p=>{for(const x of p.canon_days)if(x.t===day(1))x.at=new Date(NOW-121*3600e3).toISOString();return p;});
    const cut=etfRun({state:holed,chart:3});
    assert.equal(lastT(cut),day(2),"перенос обязан оборваться на дне с истёкшим сроком, не оставив дыры");
    assert.equal(cut.held,1);
    // Тот же ETF-контракт: значение вне физической полосы в ряд не попадает.
    const wild=next(b,p=>{for(const x of p.canon_days)if(x.t===D)x.v=2e10;return p;});
    const rejected=etfRun({state:wild,chart:1});
    assert.equal(lastT(rejected),day(1));assert.match(errorsOf(rejected),/не прошёл ETF-контракт/);

    // 7. SOSOVALUE ПОВЕРХ УДЕРЖАННОГО ДНЯ (23.09.2026, 06:39: канон по понедельник, вторник сшит со
    //    слоя; tbstat замолчал — и пропали оба дня). Теперь день канона удержан, а сшитый день
    //    подтверждается и ложится поверх него.
    const s0=etfRun({chart:2,tbstat:1,soso:0}),s1=etfRun({state:next(s0),chart:2,tbstat:1,soso:0});
    assert.deepEqual([lastT(s1),s1.spliced,s1.source],[D,1,"The Block (tbstat) + SosoValue"],"исходное положение: канон по D−1, D сшит со слоя");
    const s2=etfRun({state:next(s1),chart:2,soso:0});
    assert.deepEqual([lastT(s2),s2.held,s2.spliced,s2.partial??false],[D,1,1,false],"день канона удержан, день слоя сшит поверх него — ряд не укорочен");
    assert.equal(s2.source,"The Block + SosoValue");
    assert.equal(s2.canon_last,new Date(day(2)).toISOString());
    assert.deepEqual(s2.data.slice(-3).map(x=>x.t),[day(2),day(1),D],"хвост ряда: живой канон, удержанный день, сшитый день — без дыр");
    assert.equal(s2.data.length,s1.data.length);
    // Слой тоже молчит: день канона — из реестра, день слоя — из кэша подтверждения.
    const s3=etfRun({state:next(s1),chart:2});
    assert.deepEqual([lastT(s3),s3.held,s3.spliced],[D,1,1]);
    assert.match(errorsOf(s3),/кэша подтверждения/);
    assert.deepEqual(s3.data.slice(-3).map(x=>x.t),[day(2),day(1),D],"оживлённый день обязан лечь ПОВЕРХ удержанного, а не на голый канон — иначе в ряду дыра");
    // Предел в три дня — общий на весь хвост: три удержанных дня не оставляют слою места.
    const s4=etfRun({state:next(s1),chart:4,soso:0});
    assert.deepEqual([lastT(s4),s4.held,s4.spliced],[day(1),3,0],"три удержанных дня исчерпывают предел — слой не добавляет четвёртый");
    assert.match(errorsOf(s4),/опережение 1 дн больше допустимых 0/);
    // И кэш подтверждения подчиняется тому же остатку: слой молчит, три дня удержаны — четвёртый не оживает.
    const s5=etfRun({state:next(s1),chart:4});
    assert.deepEqual([lastT(s5),s5.held,s5.spliced],[day(1),3,0],"кэш подтверждённого дня не имеет права обойти общий предел");
    assert.match(errorsOf(s5),/кэш подтверждённого дня непригоден/);

    // 8. Не ответил никто, и кэша нет: отказ уносит с собой состояние ног — его публикует loadDataset.
    const dead=etfRun({});
    assert.equal(dead.ok,false);assert.match(dead.error,/ETF flows unavailable/);
    assert.deepEqual(dead.legs.map(l=>[l.name,l.state]),[["The Block","fail"],["The Block (tbstat)","fail"],["SosoValue","fail"]]);
    assert.ok(dead.legs.every(l=>/HTTP 503/.test(l.error)),"у каждой отказавшей ноги названа причина");
    // Отказ, упакованный chart-API в HTTP 200, — тоже отказ ноги, а не пустой ряд.
    const wrapped=etfRun({chart:{ok:false,status:"error",error:"Internal error"},tbstat:0});
    assert.equal(wrapped.source,"The Block (tbstat)");
    assert.equal(legState(wrapped,"The Block"),"fail");
    assert.match(wrapped.legs.find(l=>l.name==="The Block").error,/The Block API: Internal error/);
    rmSync(dir,{recursive:true,force:true});
  }

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
  // СВЕРКА ПОТОКОВ И ОСТАТКА БИРЖ — ТОЛЬКО ИЗМЕРЕНИЕ. Провайдер отдаёт полный свежий пакет, в котором
  // потоки каждый день показывают отток на 2 000 BTC больше, чем убывает остаток (как с мая 2026).
  // Пакет обязан остаться исправным: ни partial, ни ошибок — балл семьи и состояние источника не
  // зависят от сверки; результат измерения лежит рядом с данными.
  {
    const cmDays=700,cmStart=Math.floor(NOW/DAY)*DAY-cmDays*DAY;
    const cmRows=bias=>Array.from({length:cmDays},(_,i)=>({asset:"btc",time:new Date(cmStart+i*DAY).toISOString().replace(".000Z",".000000000Z"),
      CapMVRVCur:"1.5",FlowInExNtv:"20000",FlowOutExNtv:String(20500-bias),SplyExNtv:String(2_900_000-500*i),IssTotUSD:"37000000",FeeTotNtv:"3",AdrActCnt:"650000",TxCnt:"690000",TxTfrCnt:"1030000"}));
    const realFetch=globalThis.fetch;let cmBias=-2000;
    globalThis.fetch=async u=>{if(String(u).includes("coinmetrics.io"))return json({data:cmRows(cmBias)});throw new Error(`unexpected URL ${u}`);};
    try{
      const {fetchCoinMetrics}=await import("./fetch-snapshot.mjs");
      const skewed=await fetchCoinMetrics();
      assert.equal(skewed.partial,false,"расхождение потоков и остатка не делает пакет частичным");
      assert.deepEqual(skewed.errors,[],"и не пишется в ошибки пакета");
      assert.ok(Math.abs(skewed.flow_supply_check.gap_btc-(-60000))<1e-6,`разрыв за 30 дней: ${skewed.flow_supply_check.gap_btc}`);
      assert.equal(skewed.flow_supply_check.days,30);
      cmBias=0;
      const honest=await fetchCoinMetrics();
      assert.ok(Math.abs(honest.flow_supply_check.gap_btc)<1e-6,"согласованные ряды дают нулевой разрыв");
      assert.deepEqual([honest.partial,honest.data.FlowInExNtv.length],[false,cmDays]);
    }finally{globalThis.fetch=realFetch;}
  }
  mode="cftc";const c=await fetchCftc();assert.equal(c.partial,true);assert.match(c.source,/CSV/);assert.equal(c.data.length,24);
  mode="derivatives";const d=await fetchDerivatives();assert.equal(d.partial,true);assert.equal(d.data.funding.length,1);assert.equal(d.data.funding[0].venue,"Kraken Futures PF");assert.equal(d.data.funding[0].rate8h,.00008,"часовая относительная ставка PF × 8");assert.equal(d.data.funding[0].oiUsd,2e9,"OI PF: 50 000 BTC × 40 000 $");assert.equal(d.data.basisSource,"Kraken Futures");assert.ok(d.data.basis>11&&d.data.basis<13,`резервный basis с ликвидного контракта: ${d.data.basis}`);
  // НОЛЬ МЁРТВОГО КОНТРАКТА НЕ ГОЛОСУЕТ. Все прочие площадки недоступны, у Kraken жив только бессрочный,
  // а датированный контракт стоит с нулевым OI и mark = index. Раньше отсюда выходил basis 0,0 % с
  // подписью «Kraken Futures», и нога carry получала 0 = «спокойно». Теперь basis отсутствует.
  mode="derivatives_dead_basis";const dz=await fetchDerivatives();
  assert.equal(dz.data.basis,null,"basis мёртвого контракта обязан отсутствовать, а не равняться нулю");
  assert.equal(dz.data.basisSource,null);
  assert.equal(dz.data.funding.length,1,"funding и OI живого бессрочного контракта при этом сохраняются");
  assert.match(dz.errors.join(" "),/нет ликвидного датированного контракта/);
  // --- экономия квоты bitcoin-data.com (10 запросов в час, 15 в сутки на IP) -------------
  // Пока сбор жил на раннерах GitHub, каждый прогон приходил с нового адреса и квота была
  // как бы бесконечной. С переездом на один сервер расход стал виден: 96 запросов в сутки
  // против 15. Две функции ниже — вся арифметика, на которой держится экономия, и обе
  // ошибаются молча: неверное «нового нет» замораживает ряд навсегда, ни разу не покраснев.
  {
    const {probeIsOlderOrSame,legNeedsRefetch,lastAttemptAt,dailySeriesIsCurrent}=await import("./fetch-snapshot.mjs");
    // САМОПОДДЕРЖИВАЮЩИЙСЯ ОТКАЗ (bitcoin-data.com завис на двое суток, 10-12.08). Метка попытки
    // жила внутри пакета и ставилась только при УСПЕХЕ, поэтому после отказа интервал переставал
    // действовать: на такте в 15 минут это 4 обращения в час против часовой квоты в 10 — один 429
    // выжигал окно, и отказ сам себя продлевал. Здесь закреплено, что отказ отодвигает следующую
    // попытку ровно так же, как успех: реестр `attempts` ведётся отдельно от данных.
    {
      const src=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
      assert.match(src,/^\s*attempts\[key\]=iso\(NOW\);\s*$/m,"метка попытки обязана ставиться ДО обращения — иначе отказ её не поставит");
      const guard=src.indexOf("attempts[key]=iso(NOW);"),tryAt=src.indexOf("try{",guard);
      assert.ok(guard>0&&tryAt>guard,"метка обязана стоять перед try, а не внутри успешной ветки");
      assert.match(src,/lastAttemptFor\(key\)/,"интервал обязан отсчитываться от реестра попыток");
      assert.match(src,/attempts:\{\.\.\.\(previous\?\.attempts\|\|\{\}\),\.\.\.attempts\}/,"реестр обязан переноситься вперёд, иначе метка теряется на следующем прогоне");
      // Носитель метки переживает и потерю кэша: реестр лежит в снимке, а не в пакете данных.
      assert.ok(src.indexOf("attempts:{...(previous?.attempts")>0,"реестр обязан публиковаться в снимке");
      // Арифметика самого интервала: после отказа следующая попытка приходит через порог, а не тактом.
      const failedAt="2026-08-12T04:38:00Z";
      assert.equal(legNeedsRefetch(failedAt,3*3600e3,Date.parse("2026-08-12T04:53:00Z")),false,"через такт после отказа обращаться нельзя");
      assert.equal(legNeedsRefetch(failedAt,3*3600e3,Date.parse("2026-08-12T07:38:00Z")),true,"через три часа — можно");
      // 15-минутный такт против квоты: за час обращений должно быть не больше одного.
      let hits=0;for(let m=0;m<60;m+=15)if(legNeedsRefetch(failedAt,3*3600e3,Date.parse(failedAt)+m*60000))hits++;
      assert.equal(hits,0,`за час после отказа обращений быть не должно, получилось ${hits}`);
    }
    // Главная экономия квоты: пока в кэше есть точка за вчерашний UTC-день, дневному ряду
    // взяться неоткуда — не тратится даже разведочный запрос. Раньше интервал в три часа
    // сам по себе разрешал восемь разведок в сутки на ряд, который меняется раз в день.
    {
      const now=Date.parse("2026-08-10T05:30:00Z");
      assert.equal(dailySeriesIsCurrent("2026-08-09T00:00:00.000Z",now),true,"точка за вчера — ряд актуален, запросов не нужно");
      assert.equal(dailySeriesIsCurrent("2026-08-10T00:00:00.000Z",now),true,"точка за сегодня — тем более актуален");
      assert.equal(dailySeriesIsCurrent("2026-08-08T00:00:00.000Z",now),false,"позавчерашняя точка — отстали, идём за данными");
      // Ровно на границе суток: 00:00 нового дня не должно объявлять позавчерашний ряд свежим.
      assert.equal(dailySeriesIsCurrent("2026-08-08T23:59:59Z",Date.parse("2026-08-10T00:00:00Z")),false,"граница суток считается по календарю, а не по «24 часам назад»");
      assert.equal(dailySeriesIsCurrent("2026-08-09T00:00:00Z",Date.parse("2026-08-10T23:59:59Z")),true,"весь день актуальности — целиком наш");
      // Нет кэша или мусор в метке — обязаны идти за данными, а не молчать.
      for(const bad of [undefined,null,"","не дата"])
        assert.equal(dailySeriesIsCurrent(bad,now),false,`без разобранной метки (${JSON.stringify(bad)}) обязаны качать`);
      // Расход за сутки при исправном провайдере: 1 разведка + 3 ряда, дальше тишина.
      let requests=0,cachedAt="2026-08-09T00:00:00.000Z";
      for(let tick=0;tick<8;tick++){ // такты каждые 3 часа
        const t=Date.parse("2026-08-10T00:00:00Z")+tick*3*3600e3;
        if(dailySeriesIsCurrent(cachedAt,t))continue;
        requests+=1; // разведка
        if(t>=Date.parse("2026-08-11T00:00:00Z")){requests+=3;cachedAt="2026-08-10T00:00:00.000Z";}
      }
      assert.ok(requests<=4,`расход за сутки обязан оставаться в пределах четырёх запросов из квоты 15, получилось ${requests}`);
    }
    const cached="2026-08-05T00:00:00.000Z";
    assert.equal(probeIsOlderOrSame("2026-08-05",cached),true,"тот же день — качать нечего");
    assert.equal(probeIsOlderOrSame("2026-08-04",cached),true,"источник откатился назад — тоже не повод качать");
    assert.equal(probeIsOlderOrSame("2026-08-06",cached),false,"появился новый день — обязаны выкачать ряды");
    // Сравнение идёт по календарным дням: точка за 6 августа остаётся точкой за 6 августа,
    // в котором бы часу её ни опубликовали.
    assert.equal(probeIsOlderOrSame("2026-08-06T23:59:59Z",cached),false,"время внутри дня не должно менять решение");
    // Нераспознанный ответ — НЕ «нового нет»: смена формата у провайдера обязана привести к
    // загрузке (и, если та не пройдёт, к честному отказу), а не к вечному молчанию.
    for(const bad of [undefined,null,"","мусор",{}])
      assert.equal(probeIsOlderOrSame(bad,cached),false,`неразобранный ответ разведки (${JSON.stringify(bad)}) не имеет права считаться «нового нет»`);
    assert.equal(probeIsOlderOrSame("2026-08-06",null),false,"без кэша сравнивать не с чем — качаем");

    const now=Date.parse("2026-08-07T12:00:00Z"),DAY_MS=864e5;
    assert.equal(legNeedsRefetch("2026-08-07T06:00:00Z",DAY_MS,now),false,"шесть часов назад — рано");
    assert.equal(legNeedsRefetch("2026-08-06T11:00:00Z",DAY_MS,now),true,"больше суток назад — пора");
    assert.equal(legNeedsRefetch("2026-08-06T12:00:00Z",DAY_MS,now),true,"ровно сутки — граница включительно");
    // Отсутствие метки означает «никогда не качали»: холодный старт обязан качать, а не ждать.
    for(const bad of [undefined,null,"","не дата"])
      assert.equal(legNeedsRefetch(bad,DAY_MS,now),true,`без метки времени (${JSON.stringify(bad)}) обязаны качать`);

    // Интервал отсчитывается от последнего ОБРАЩЕНИЯ, а не от последней удачной загрузки.
    // Разведка, ответившая «нового нет», обращением считается: если считать от загрузки, то
    // через интервал после неё порог оказывается пройден навсегда и разведка уходит в
    // источник каждый такт — 21 запрос в сутки вместо восьми, и квота кончается к обеду.
    const packet={fetched_at:"2026-08-07T00:00:00Z",probed_at:"2026-08-07T09:00:00Z"};
    assert.equal(lastAttemptAt(packet),"2026-08-07T09:00:00Z","метка разведки обязана перебивать метку загрузки");
    assert.equal(lastAttemptAt({fetched_at:"2026-08-07T00:00:00Z"}),"2026-08-07T00:00:00Z","без разведки считаем от загрузки");
    assert.equal(lastAttemptAt(null),null,"нечего считать — значит обращаемся");
    const t3=3*3600e3,probedAt=Date.parse("2026-08-07T09:00:00Z");
    assert.equal(legNeedsRefetch(lastAttemptAt(packet),t3,probedAt+t3-1),false,"до истечения интервала со времени разведки — молчим");
    assert.equal(legNeedsRefetch(lastAttemptAt(packet),t3,probedAt+t3),true,"после — снова разведываем");
  }
  {
    // КОГОРТНЫЙ СЛОЙ И РЕЗЕРВ MVRV С BITVIEW.SPACE (смена поставщика 17.09.2026: bitcoin-data.com
    // закрыл последние семь суток подпиской, и оба слоя стояли пустыми). Контракт:
    //   • пока в кэше вчерашняя точка — ни одного запроса;
    //   • загрузка — даты и каждый ряд ПОИМЁННО с общим абсолютным диапазоном, без /bulk;
    //   • текущие сутки не берутся никогда, вчерашние — только через час после полуночи UTC;
    //   • разъехавшийся диапазон, 404 переименованного ряда и смена единиц отвергают пакет целиком.
    const floorDay=BV_FLOOR;
    const values={sth_realized_price:i=>60000+i%500,sopr_24h:i=>1+((i%7)-3)/1000,lth_sopr_24h:i=>1.1+(i%5)/100,mvrv:i=>1.4};
    let calls=[];
    const stub=(opts={})=>{calls=[];globalThis.fetch=async u=>{const s=String(u);calls.push(s);return bitview(s,{values,...opts});};};
    const cacheAt=lag=>({observed_at:new Date(floorDay-lag*DAY).toISOString(),data:{}});

    // 1. Вчерашняя точка уже в кэше — источник не трогаем.
    stub();
    await fetchSthOnchain(cacheAt(1));
    assert.equal(calls.length,0,"вчерашняя точка в кэше — запросов быть не должно");

    // 2. Кэш отстал — ровно четыре поимённых запроса, без /bulk, и четыре года глубины.
    stub();
    const got=await fetchSthOnchain(cacheAt(4));
    assert.equal(calls.length,4,"загрузка — даты и три ряда");
    assert.ok(calls.every(u=>!u.includes("/bulk")),"пакетный /bulk запрещён");
    assert.match(calls[0],/\/series\/date\/day1\?start=-/,"первым идут даты с относительным стартом");
    for(const u of calls.slice(1))assert.match(u,/start=\d+&end=\d+/,`ряды значений — только с абсолютным диапазоном дат (${u})`);
    assert.equal(got.source,"bitview.space");
    assert.deepEqual(Object.keys(got.data).sort(),["lth_sopr","sopr","sth_rp"],"ключи пакета прежние — карточки читают их без изменений");
    for(const k of ["sth_rp","sopr","lth_sopr"])assert.equal(got.data[k].length,4*365,`${k}: глубина ровно четыре года`);
    assert.equal(new Date(Date.parse(got.observed_at)).toISOString().slice(0,10),new Date(floorDay-2*DAY).toISOString().slice(0,10));
    // Значение пришло именно из своего ряда: STH-RP ~60 тыс., SOPR ~1, LTH-SOPR ~1,1.
    assert.ok(got.data.sth_rp.at(-1).v>50000&&got.data.sopr.at(-1).v<1.01&&got.data.lth_sopr.at(-1).v>=1.1,"ряды перепутаны местами");

    // 3. Без кэша — тоже загрузка.
    stub();await fetchSthOnchain(null);assert.equal(calls.length,4);

    // 4. Текущие сутки не берутся никогда; вчерашние — только после 01:00 UTC.
    stub({lastDay:floorDay});
    const fresh=await fetchBitviewDaily(["sopr_24h"],{days:30});
    const lastDay=new Date(fresh.sopr_24h.at(-1).t).toISOString().slice(0,10);
    assert.notEqual(lastDay,new Date(floorDay).toISOString().slice(0,10),"текущие сутки пересчитываются с каждым блоком — брать их нельзя");
    const sinceMidnight=Date.now()-floorDay;
    if(Math.abs(sinceMidnight-3600e3)>60e3){
      const expected=new Date(floorDay-(sinceMidnight>=3600e3?1:2)*DAY).toISOString().slice(0,10);
      assert.equal(lastDay,expected,"вчерашние сутки закрываются через час после полуночи UTC");
    }

    // 5. Разъехавшийся диапазон — пакет отвергается целиком.
    stub({override:{sopr_24h:{start:1}}});
    await assert.rejects(fetchSthOnchain(cacheAt(4)),/index range mismatch/);

    // 6. Переименованный ряд — 404, пакет отвергается, а не собирается из оставшихся.
    stub({values:{...values,lth_sopr_24h:undefined}});
    await assert.rejects(fetchSthOnchain(cacheAt(4)),/HTTP 404/);

    // 7. Смена единиц у провайдера (отношение в ppm) — отвергается, а не рисуется.
    stub({values:{...values,sopr_24h:()=>1_000_000}});
    await assert.rejects(fetchSthOnchain(cacheAt(4)),/implausible latest value/);

    // 8. Подпись резерва MVRV: секция под замком пишет прежнего поставщика, наружу уходит новый;
    //    ряд и балл не трогаются, подпись Coin Metrics — тоже.
    const lockedCard={id:"mvrv_cycle",source:"bitcoin-data.com",source_url:"https://bitcoin-data.com/bguser/free-features.html",
      source_urls:["https://bitcoin-data.com/bguser/free-features.html"],score:-1,value_num:83.2,
      note:"Coin Metrics первым; bitcoin-data.com/BGeometrics — открытый keyless MVRV fallback. Истории разных методологий не сшиваются."};
    const [card]=relabelMvrvFallback([{...lockedCard}]);
    assert.equal(card.source,"bitview.space");
    assert.deepEqual(card.source_urls,["https://bitview.space/api"]);
    assert.match(card.note,/bitview\.space \(Bitcoin Research Kit\) — открытый keyless MVRV fallback/);
    assert.equal(card.score,-1);assert.equal(card.value_num,83.2);
    const [cm]=relabelMvrvFallback([{...lockedCard,source:"Coin Metrics",source_url:"https://docs.coinmetrics.io/api",source_urls:["https://docs.coinmetrics.io/api"]}]);
    assert.equal(cm.source,"Coin Metrics","подпись основного источника не трогается");
  }

  {
    // ВСЯ ИСТОРИЯ MVRV (набор mvrv_deep для теневого кандидата v3). Контракт загрузчика:
    //   • в кэше вчерашняя точка — ни одного запроса;
    //   • у основного пакета Coin Metrics нет дня новее кэша — ни одного запроса;
    //   • иначе РОВНО один запрос: CapMVRVCur с 18.07.2010 одной страницей;
    //   • вторая страница, смена единиц, слишком короткий ряд — отказ, а не усечённая история.
    const {fetchMvrvDeep,UNCHANGED,collectorDatasets,MVRV_DEEP_MIN_POINTS}=await import("./fetch-snapshot.mjs");
    const floorDay=Math.floor(NOW/DAY)*DAY,calls=[];
    // Ряд провайдера с 18.07.2010; первые три дня — настоящие исторические 146, 63 и 45.
    const deepRows=lastDay=>{const out=[];for(let t=Date.parse("2010-07-18T00:00:00Z"),i=0;t<=lastDay;t+=DAY,i++)out.push({asset:"btc",time:new Date(t).toISOString().replace(".000Z",".000000000Z"),CapMVRVCur:String(i===0?146.0383322:i===1?62.56512971:i===2?45.10663005:1.5+((i*7919)%1000)/2000)});return out;};
    let reply=()=>json({data:deepRows(floorDay-DAY)});
    globalThis.fetch=async u=>{calls.push(String(u));return reply();};
    const saved=collectorDatasets.coinmetrics;
    // Основной пакет Coin Metrics с последним днём MVRV `lag` суток назад.
    const main=lag=>{collectorDatasets.coinmetrics={data:{CapMVRVCur:[{t:floorDay-(lag+1)*DAY,v:1.4},{t:floorDay-lag*DAY,v:1.5}]}};};
    const cacheAt=lag=>({observed_at:new Date(floorDay-lag*DAY).toISOString(),data:[]});
    try{
      // 1. Вчерашняя точка уже в кэше — и при живом основном пакете, и когда его нет вовсе.
      main(1);
      assert.equal(await fetchMvrvDeep(cacheAt(1)),UNCHANGED);assert.equal(calls.length,0,"вчерашняя точка в кэше — запросов быть не должно");
      collectorDatasets.coinmetrics=undefined;
      assert.equal(await fetchMvrvDeep(cacheAt(1)),UNCHANGED);assert.equal(calls.length,0,"ряд актуален — не ходим и тогда, когда основной пакет недоступен");
      // 2. Кэш отстал на день, но и основной пакет не новее (первые часы суток, провайдер ещё не выложил вчера).
      main(2);
      assert.equal(await fetchMvrvDeep(cacheAt(2)),UNCHANGED);assert.equal(calls.length,0,"у основного пакета нет дня новее кэша — холостого запроса быть не должно");
      // 3. Основной пакет получил вчерашний день — один запрос за всей историей.
      main(1);
      const got=await fetchMvrvDeep(cacheAt(2)),q=new URL(calls[0]).searchParams;
      assert.equal(calls.length,1,"обновление — ровно один запрос");
      assert.match(calls[0],/^https:\/\/community-api\.coinmetrics\.io\/v4\/timeseries\/asset-metrics\?/);
      assert.deepEqual([q.get("assets"),q.get("metrics"),q.get("frequency"),q.get("start_time"),q.get("page_size")],["btc","CapMVRVCur","1d","2010-07-18","10000"]);
      assert.equal(got.observed_at,new Date(floorDay-DAY).toISOString());assert.equal(got.source,"coinmetrics");
      assert.ok(got.data.length>MVRV_DEEP_MIN_POINTS&&got.data.length>5800,`вся история: ${got.data.length} дней`);
      assert.equal(new Date(got.data[0].t).toISOString().slice(0,10),"2010-07-21","три первые точки вне физической полосы (146, 63, 45) отброшены контрактом единиц");
      assert.equal(got.data.at(-1).t,floorDay-DAY);
      assert.ok(got.data.every((x,i,a)=>!i||x.t>a[i-1].t),"ряд строго возрастает");
      // 4. Кэша нет — загрузка.
      calls.length=0;assert.ok((await fetchMvrvDeep(null)).data.length>5800);assert.equal(calls.length,1);
      // 5. Основного пакета нет вовсе, кэш отстал: сверить не с чем — идём за данными.
      collectorDatasets.coinmetrics=undefined;calls.length=0;
      await fetchMvrvDeep(cacheAt(3));assert.equal(calls.length,1,"без основного пакета отсев не действует");
      // 6. История не поместилась в одну страницу — отказ, а не молча обрезанный ряд.
      main(1);reply=()=>json({data:deepRows(floorDay-DAY),next_page_token:"abc"});
      await assert.rejects(fetchMvrvDeep(cacheAt(2)),/does not fit one page/);
      // 7. Смена единиц у провайдера (проценты вместо отношения) — отказ.
      reply=()=>json({data:deepRows(floorDay-DAY).map(r=>({...r,CapMVRVCur:String(Number(r.CapMVRVCur)*100)}))});
      await assert.rejects(fetchMvrvDeep(cacheAt(2)),/scale/);
      // 8. Слишком короткий ряд — это не «вся история».
      reply=()=>json({data:deepRows(floorDay-DAY).slice(-500)});
      await assert.rejects(fetchMvrvDeep(cacheAt(2)),/history too short: 500/);
      // 9. Отказ провайдера — исключение с хостом; отсрочку следующей попытки даёт реестр attempts.
      reply=()=>json({},503);
      await assert.rejects(fetchMvrvDeep(cacheAt(2)),/community-api\.coinmetrics\.io: HTTP 503/);
    }finally{collectorDatasets.coinmetrics=saved;}
  }

  console.log("Fallback contract tests OK");
}finally{globalThis.fetch=originalFetch;globalThis.setTimeout=originalSetTimeout;}
