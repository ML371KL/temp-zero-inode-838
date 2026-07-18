/* Endpoint and unit-contract probe. Diagnostic only; never prints secrets. */
import { readFileSync as __rf } from "node:fs";
const PKG_VERSION = JSON.parse(__rf(new URL("../package.json", import.meta.url), "utf8")).version;

const FRED_KEY=String(process.env.FRED_KEY||"").trim(),CM_KEY=String(process.env.CM_API_KEY||"").trim(),SOSO_KEY=String(process.env.SOSO_API_KEY||"").trim(),TIMEOUT=20_000;
const host=u=>{try{return new URL(u).host}catch{return"?"}},safe=v=>String(v??"").replace(/[\r\n\t]+/g," ").slice(0,180);
async function probe(name,url,inspect,{critical=false,text=false,method="GET",payload=null,headers={}}={}){const t=Date.now();try{const r=await fetch(url,{method,headers:{"User-Agent":"btc-21m-dashboard/"+PKG_VERSION+"-probe","Accept":text?"text/plain,text/csv,text/html,*/*":"application/json,*/*",...(payload?{"Content-Type":"application/json"}:{}),...headers},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(TIMEOUT)}),raw=await r.text();let body=null;try{body=JSON.parse(raw)}catch{}let note="";try{note=safe(inspect?.(body,raw,r)||"")}catch(e){note=`!inspect ${safe(e.message||e)}`;}return{name,critical,ok:r.ok&&!note.startsWith("!"),status:r.status,ms:Date.now()-t,host:host(url),note};}catch(e){return{name,critical,ok:false,status:"-",ms:Date.now()-t,host:host(url),note:safe(e.message||e)};}}
const fredApi=`https://api.stlouisfed.org/fred/series/observations?series_id=WALCL&api_key=${encodeURIComponent(FRED_KEY)}&file_type=json&sort_order=desc&limit=3`;
const cftcParams=new URLSearchParams({"$select":"report_date_as_yyyy_mm_dd,open_interest_all,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short","$limit":"3","$where":"market_and_exchange_names='BITCOIN - CHICAGO MERCANTILE EXCHANGE'","$order":"report_date_as_yyyy_mm_dd desc"});
const cmMetrics="CapMVRVCur,FlowInExNtv,FlowOutExNtv,SplyExNtv,IssTotUSD,FeeTotNtv,AdrActCnt,TxCnt,TxTfrCnt",cmRoot=CM_KEY?"https://api.coinmetrics.io/v4":"https://community-api.coinmetrics.io/v4",cmQ=new URLSearchParams({assets:"btc",metrics:cmMetrics,frequency:"1d",page_size:"3",ignore_forbidden_errors:"true",ignore_unsupported_errors:"true"});if(CM_KEY)cmQ.set("api_key",CM_KEY);
const chart=(name,unit,scale=1)=>b=>{const a=b?.values||[],v=Number(a.at(-1)?.y)*scale;return b?.status==="ok"&&a.length&&Number.isFinite(v)?`${a.length} points · unit ${b.unit||"?"} · last ${v}`:`!invalid chart ${name}`;};
const checks=[
 ["FRED API WALCL",fredApi,b=>b?.error_message?`!${b.error_message}`:`${b?.observations?.[0]?.date} · millions USD`,{critical:true}],
 ["FRED CSV WALCL","https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL",(_b,t)=>/,WALCL/i.test(t)&&t.trim().split(/\r?\n/).length>20?`${t.trim().split(/\r?\n/).length-1} rows · same FRED series`:'!CSV invalid',{critical:true,text:true}],
 ["Coinbase daily price","https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400",b=>Array.isArray(b)&&b.length?`${b.length} candles · USD/BTC close ${b[0]?.[4]} · base volume BTC ${b[0]?.[5]}`:'!candles missing',{critical:true}],
 ["Bitstamp daily OHLC","https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=30",b=>Array.isArray(b?.data?.ohlc)&&b.data.ohlc.length?`${b.data.ohlc.length} candles · USD/BTC close ${b.data.ohlc.at(-1)?.close} · base volume BTC ${b.data.ohlc.at(-1)?.volume}`:'!OHLC missing'],
 ["Blockchain market price","https://api.blockchain.info/charts/market-price?timespan=30days&format=json&sampled=false",chart("market-price","USD"),{critical:true}],
 ["Blockchain trade volume","https://api.blockchain.info/charts/trade-volume?timespan=30days&format=json&sampled=false",chart("trade-volume","USD")],
 ["CoinGecko ATH","https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&sparkline=false",b=>Number.isFinite(Number(b?.[0]?.ath))?`ATH USD ${b[0].ath}`:'!ATH missing'],
 ["mempool hashrate","https://mempool.space/api/v1/mining/hashrate/3y",b=>Array.isArray(b?.hashrates)&&b.hashrates.length>300?`${b.hashrates.length} points · H/s ${b.hashrates.at(-1)?.avgHashrate}`:'!hashrate missing',{critical:true}],
 ["Blockchain hash-rate","https://api.blockchain.info/charts/hash-rate?timespan=30days&format=json&sampled=false",chart("hash-rate","TH/s",1e12),{critical:true}],
 ["Blockchain difficulty","https://api.blockchain.info/charts/difficulty?timespan=30days&format=json&sampled=false",chart("difficulty","difficulty"),{critical:true}],
 ["mempool fees","https://mempool.space/api/v1/fees/recommended",b=>Number.isFinite(Number(b?.fastestFee))?`sat/vB 1-block ${b.fastestFee}`:'!fees missing'],
 ["Blockstream fees","https://blockstream.info/api/fee-estimates",b=>Number.isFinite(Number(b?.["1"]))?`sat/vB targets 1=${b["1"]},3=${b["3"]},6=${b["6"]}`:'!fee estimates missing'],
 ["Coin Metrics enrichment",`${cmRoot}/timeseries/asset-metrics?${cmQ}`,b=>{const row=b?.data?.[0],served=row?Object.keys(row).filter(k=>!['asset','time'].includes(k)):[];return row?`${served.length}/9 fields · ${row.time?.slice(0,10)} · ${served.join(',')}`:'!no rows';}],
 ["bitcoin-data MVRV","https://bitcoin-data.com/v1/mvrv/last",b=>{const x=Array.isArray(b)?b.at(-1):(b?.data??b),v=Number(x?.mvrv??x?.value);return Number.isFinite(v)?`MVRV ratio ${v}`:"!MVRV missing";}],
 ["Blockchain active addresses","https://api.blockchain.info/charts/n-unique-addresses?timespan=30days&format=json&sampled=false",chart("addresses","count")],
 ["Blockchain transactions","https://api.blockchain.info/charts/n-transactions?timespan=30days&format=json&sampled=false",chart("transactions","count")],
 ["Blockchain miner revenue","https://api.blockchain.info/charts/miners-revenue?timespan=30days&format=json&sampled=false",chart("miners-revenue","USD")],
 ["The Block ETF API","https://www.theblock.co/api/charts/chart/etfs/bitcoin/spot-bitcoin-etf-total-net-flow",b=>{const d=b?.chart?.jsonFile?.Series?.["Total Net Flow"]?.Data;return Array.isArray(d)&&d.length>100?`${d.length} rows · Result USD/day · latest ${new Date(Number(d.at(-1)?.Timestamp)*1000).toISOString().slice(0,10)}`:'!ETF JSON contract failed';}],
 ["tbstat ETF mirror","https://data.tbstat.com/dashboard/markets_structuredproducts_btcspotetftotalnetflows_daily_other.json",b=>{const d=b?.Series?.["Total Net Flow"]?.Data;return Array.isArray(d)&&d.length>100?`${d.length} rows · mirror Result USD/day`:'!ETF mirror contract failed';}],
 // РАЗВЕДКА (шаг 1, ничего не интегрировано в снимок): доступен ли SosoValue с раннера и
 // насколько он свежее The Block. Farside умирает здесь на Cloudflare-челлендже (403) — у
 // SosoValue тоже Cloudflare, но это авторизованный REST API, который обычно не челленджится.
 // Проверка НЕ критическая и без ключа честно сообщает, что пропущена.
 ["SosoValue ETF current","https://api.sosovalue.xyz/openapi/v2/etf/currentEtfDataMetrics",b=>{
   if(b?.code!==0&&b?.code!==undefined)return `!API code ${b.code}: ${safe(b.msg||b.message)}`;
   const f=b?.data?.dailyNetInflow;const v=Number(f?.value);
   if(!Number.isFinite(v)||!f?.lastUpdateDate)return '!contract failed: нет dailyNetInflow/lastUpdateDate';
   const funds=Array.isArray(b?.data?.list)?b.data.list.length:0;
   const withFlow=Array.isArray(b?.data?.list)?b.data.list.filter(x=>Number.isFinite(Number(x?.dailyNetInflow?.value))).length:0;
   return `latest ${f.lastUpdateDate} · ${(v/1e6).toFixed(1)} млн USD/day · фондов ${withFlow}/${funds} · status ${f.status??'?'} · ключ ${SOSO_KEY?'задан':'не задан (маршрут отвечает и без него)'}`;
 },{method:"POST",payload:{type:"us-btc-spot"},headers:SOSO_KEY?{"x-soso-api-key":SOSO_KEY}:{}}],
 ["SosoValue ETF history","https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart",b=>{
   const a=b?.data;
   if(!Array.isArray(a)||!a.length)return `!contract failed: нет массива истории (code ${b?.code})`;
   const dates=a.map(x=>x?.date).filter(Boolean).sort();
   const unitOk=a.every(x=>Number.isFinite(Number(x?.totalNetInflow)));
   return `${a.length} дней · ${dates[0]}..${dates.at(-1)} · totalNetInflow USD/day ${unitOk?'ok':'!нечисловой'}`;
 },{method:"POST",payload:{type:"us-btc-spot"},headers:SOSO_KEY?{"x-soso-api-key":SOSO_KEY}:{}}],
 ["DefiLlama supply","https://stablecoins.llama.fi/stablecoincharts/all",b=>Array.isArray(b)&&b.length>100?`${b.length} points · USD total supply`:'!history missing',{critical:true}],
 ["DefiLlama pegs","https://stablecoins.llama.fi/stablecoins?includePrices=true",b=>{const a=b?.peggedAssets||b?.data||[],f=s=>a.find(x=>String(x.symbol||'').toUpperCase()===s)?.price;return f('USDT')&&f('USDC')?`USD/token USDT ${f('USDT')} · USDC ${f('USDC')}`:'!peg prices missing';},{critical:true}],
 ["Coinbase USDT/USD","https://api.exchange.coinbase.com/products/USDT-USD/ticker",b=>b?.price?`USD/token ${b.price}`:'!missing'],
 ["Kraken USDC/USD","https://api.kraken.com/0/public/Ticker?pair=USDCUSD",b=>b?.error?.length?`!${b.error.join(',')}`:`USD/token ${Object.values(b?.result||{})[0]?.c?.[0]||'missing'}`],
 ["Gemini USDT/USD","https://api.gemini.com/v1/pubticker/USDTUSD",b=>b?.last?`USD/token ${b.last}`:'!missing'],
 ["CFTC JSON",`https://publicreporting.cftc.gov/resource/gpe5-46if.json?${cftcParams}`,b=>Array.isArray(b)&&b[0]?.asset_mgr_positions_long?`${b[0].report_date_as_yyyy_mm_dd?.slice(0,10)} · contracts`:'!fields missing'],
 ["CFTC CSV",`https://publicreporting.cftc.gov/resource/gpe5-46if.csv?${cftcParams}`,(_b,t)=>/asset_mgr_positions_long/.test(t)&&t.split(/\r?\n/).length>1?'same Socrata rows · CSV transport':'!CSV invalid',{text:true}],
 ["Coinbase BTCUSD","https://api.exchange.coinbase.com/products/BTC-USD/ticker",b=>b?.price?`USD/BTC ${b.price}`:'!price missing',{critical:true}],
 ["Kraken XBTUSD","https://api.kraken.com/0/public/Ticker?pair=XBTUSD",b=>b?.error?.length?`!${b.error.join(',')}`:`USD/BTC ${Object.values(b?.result||{})[0]?.c?.[0]||'missing'}`,{critical:true}],
 ["Bitstamp BTCUSD","https://www.bitstamp.net/api/v2/ticker/btcusd/",b=>b?.last?`USD/BTC ${b.last}`:'!price missing'],
 ["Gemini BTCUSD","https://api.gemini.com/v1/pubticker/BTCUSD",b=>b?.last?`USD/BTC ${b.last}`:'!price missing'],
 ["Deribit perpetual","https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL",b=>b?.error?`!${b.error.message}`:`8h funding ${b?.result?.funding_8h} · OI USD contracts ${b?.result?.open_interest}`],
 ["Kraken Futures PI_XBTUSD","https://futures.kraken.com/derivatives/api/v3/tickers/PI_XBTUSD",b=>b?.result==="success"?`hourly funding ${b?.ticker?.fundingRate} · OI $1 contracts ${b?.ticker?.openInterest}`:`!${b?.error||b?.result}`],
 ["Kraken dated futures","https://futures.kraken.com/derivatives/api/v3/tickers?contractType=futures_inverse",b=>b?.result==="success"&&Array.isArray(b?.tickers)?`${b.tickers.filter(x=>String(x.symbol||'').startsWith('FI_XBTUSD_')).length} BTC dated tickers · annualized basis fallback`:`!${b?.error||b?.result}`],
 ["Hyperliquid funding","https://api.hyperliquid.xyz/info",b=>{const u=b?.[0]?.universe||[],i=u.findIndex(x=>x?.name==="BTC"),c=i>=0?b?.[1]?.[i]:null;return c&&Number.isFinite(Number(c.funding))?`funding/1h ${c.funding} · OI BTC ${c.openInterest} · mark ${c.markPx}`:'!BTC ctx missing';},{method:"POST",payload:{type:"metaAndAssetCtxs"}}],
 ["OKX swap","https://openapi.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP",b=>String(b?.code)==="0"?`OI USD ${b?.data?.[0]?.oiUsd}`:`!code ${b?.code}`],
];
const results=[];for(const [n,u,i,o] of checks)results.push(await probe(n,u,i,o));
console.log("STATE CRIT HTTP    MS HOST                         NAME · CONTRACT");for(const x of results)console.log(`${x.ok?'OK  ':'FAIL'}  ${x.critical?'YES ':' no '} ${String(x.status).padEnd(4)} ${String(x.ms).padStart(5)} ${x.host.padEnd(28)} ${x.name} · ${x.note}`);
const cf=results.filter(x=>x.critical&&!x.ok),of=results.filter(x=>!x.critical&&!x.ok);console.log(`\nCritical failures: ${cf.length}${cf.length?' · '+cf.map(x=>x.name).join(', '):''}`);console.log(`Optional/fallback failures: ${of.length}${of.length?' · '+of.map(x=>x.name).join(', '):''}`);console.log('Probe is diagnostic; candidate validation and TTL remain authoritative.');
// ---- Разведка SosoValue: свежесть и согласие с каноническим рядом The Block ----
// Единственная проверка, которая отвечает на вопрос «стоит ли интегрировать»: опережает ли
// SosoValue The Block НА РАННЕРЕ и совпадают ли они на общих днях. Ничего не блокирует.

try{
  // Ключ шлём, если задан. Проверено 2026-07-18: маршрут отвечает и БЕЗ ключа, и с неверным
  // ключом — разведка не зависит от секрета, но переживёт включение авторизации провайдером.
  const hdr={...(SOSO_KEY?{"x-soso-api-key":SOSO_KEY}:{}),"Content-Type":"application/json","User-Agent":"btc-21m-dashboard/"+PKG_VERSION+"-probe"};
  const [tbRes,soRes]=await Promise.all([
    fetch("https://www.theblock.co/api/charts/chart/etfs/bitcoin/spot-bitcoin-etf-total-net-flow",{signal:AbortSignal.timeout(TIMEOUT)}).then(r=>r.json()),
    fetch("https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart",{method:"POST",headers:hdr,body:JSON.stringify({type:"us-btc-spot"}),signal:AbortSignal.timeout(TIMEOUT)}).then(r=>r.json()),
  ]);
  const jf=tbRes?.chart?.jsonFile||tbRes;
  const tb=new Map((jf?.Series?.["Total Net Flow"]?.Data||[]).map(d=>[new Date(Number(d.Timestamp)*1000).toISOString().slice(0,10),Number(d.Result)]));
  const so=new Map((soRes?.data||[]).map(x=>[x.date,Number(x.totalNetInflow)]));
  if(!tb.size||!so.size)throw new Error("один из рядов пуст");
  const tbLast=[...tb.keys()].sort().at(-1),soLast=[...so.keys()].sort().at(-1);
  const ahead=[...so.keys()].filter(d=>d>tbLast).sort();
  const common=[...so.keys()].filter(d=>tb.has(d)).sort();
  const scale=[...common.map(d=>Math.abs(tb.get(d)))].sort((a,b)=>a-b)[Math.floor(common.length/2)]||1;
  const within=common.filter(d=>Math.abs(so.get(d)-tb.get(d))<=scale*0.02).length;
  const diffs=common.map(d=>so.get(d)-tb.get(d));
  const bias=diffs.reduce((s,v)=>s+v,0)/(diffs.length||1);
  console.log("\nРазведка SosoValue (диагностика, не блокирует):");
  console.log(`  The Block последний день : ${tbLast}`);
  console.log(`  SosoValue последний день : ${soLast}${ahead.length?`  ← опережает на ${ahead.length} дн: ${ahead.join(", ")}`:"  (не опережает)"}`);
  console.log(`  согласие на ${common.length} общих днях: ${within} в пределах 2% дневного масштаба = ${(within/common.length*100).toFixed(1)}% · смещение ${(bias/1e6).toFixed(2)} млн/день`);
}catch(e){console.log("\nРазведка SosoValue не удалась: "+safe(e.message||e));}

// Дрейф календаря публикации: единственная проверка, которая ловит расхождение порога с РЕАЛЬНОСТЬЮ
// (совпадение двух таблиц между собой этого не ловит — обе могут быть одинаково неправы).
// Диагностика: печатает запас до порога по каждому FRED-ряду; ничего не блокирует.
try{
  const { FRED_SERIES } = await import("./fetch-snapshot.mjs");
  const rows=[];
  for(const [id,cfg] of Object.entries(FRED_SERIES)){
    try{
      const r=await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`,{headers:{"User-Agent":"btc-21m-dashboard/"+PKG_VERSION},signal:AbortSignal.timeout(20_000)});
      const lines=(await r.text()).trim().split(/\r?\n/).slice(1).map(l=>l.split(","));
      const last=lines.filter(c=>c[1]&&c[1].trim()).pop();
      const ageH=(Date.now()-Date.parse(last[0]+"T00:00:00Z"))/36e5, ttlH=cfg.ttl/36e5;
      const used=ageH/ttlH*100;
      rows.push(`${id.padEnd(13)} ${cfg.release.padEnd(13)} возраст ${(ageH/24).toFixed(1)}д / порог ${(ttlH/24).toFixed(0)}д = ${used.toFixed(0)}%${used>70?"  ⚠ приближается к порогу":""}`);
    }catch(e){rows.push(`${id.padEnd(13)} диагностика недоступна: ${String(e.message||e).slice(0,40)}`);}
  }
  console.log("\nЗапас свежести FRED (диагностика, не блокирует):\n"+rows.join("\n"));
}catch(e){console.log("\nдиагностика календаря пропущена: "+String(e.message||e).slice(0,60));}
