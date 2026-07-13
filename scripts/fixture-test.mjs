import assert from "node:assert/strict";
import { fetchCftc, fetchDerivatives, fetchSpot, fetchPegs, parseFred, quoteDispersion, quoteGroupPrices } from "./fetch-snapshot.mjs";

const now=Date.now();
const mon=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function expiryName(days){const d=new Date(now+days*864e5);return `${String(d.getUTCDate()).padStart(2,"0")}${mon[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}`;}
const e30=expiryName(30),e35=expiryName(35);

function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}})}
const fixtures=new Map([
  ["https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future",{result:[{instrument_name:`BTC-${e30}`,open_interest:100_000_000,volume_usd:2_000_000,mark_price:102_000,estimated_delivery_price:100_000}]}],
  ["https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option",{result:[
    {instrument_name:`BTC-${e35}-90000-P`,mark_iv:62,underlying_price:100_000,open_interest:20},
    {instrument_name:`BTC-${e35}-110000-C`,mark_iv:55,underlying_price:100_000,open_interest:20},
  ]}],
  [null,{result:{data:[[now-864e5,49,52,48,51],[now,50,53,49,52]]}}],
  ["https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL",{result:{funding_8h:0.0001,open_interest:1_200_000_000,index_price:100_000,timestamp:now-500}}],
  ["https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT",{time:now-400,result:{list:[{fundingRate:"0.00005",fundingIntervalHour:"4",openInterestValue:"2000000000"}]}}],
  ["https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP",{data:[{fundingRate:"0.00008",fundingTime:String(now-8*3600e3),nextFundingTime:String(now),ts:String(now-300)}]}],
  ["https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP",{data:[{oiUsd:"3000000000",ts:String(now-250)}]}],
  ["https://futures.kraken.com/derivatives/api/v3/tickers/PI_XBTUSD",{result:"success",serverTime:new Date(now-350).toISOString(),ticker:{fundingRate:"0.00001",openInterest:"1500000000"}}],
  ["https://futures.kraken.com/derivatives/api/v3/tickers?contractType=futures_inverse",{result:"success",tickers:[]}],
  ["https://api.exchange.coinbase.com/products/BTC-USD/ticker",{price:"100050",time:new Date(now-200).toISOString()}],
  ["https://api.kraken.com/0/public/Ticker?pair=XBTUSD",{result:{XXBTZUSD:{c:["100000","1"]}}}],
  ["https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",{data:[{last:"100020",ts:String(now-150)}]}],
  ["https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT",{time:now-100,result:{list:[{lastPrice:"100010"}]}}],
  ["https://api.kraken.com/0/public/Ticker?pair=XBTUSDT",{result:{XBTUSDT:{c:["100030","1"]}}}],
  ["https://www.bitstamp.net/api/v2/ticker/btcusd/",{last:"100060"}],
  ["https://api.gemini.com/v1/pubticker/BTCUSD",{last:"100055",timestampms:now-175}],
  ["https://api.exchange.coinbase.com/products/BTC-USDT/ticker",{price:"100040",time:new Date(now-120).toISOString()}],
  ["https://stablecoins.llama.fi/stablecoins?includePrices=true",{peggedAssets:[{symbol:"USDT",price:0.9998},{symbol:"USDC",price:1.0001},{symbol:"OTHER",price:0.5}]}],
]);

const originalFetch=globalThis.fetch,originalSetTimeout=globalThis.setTimeout;
let forcedFailure=null;
globalThis.fetch=async url=>{
  const u=String(url);
  if(forcedFailure&&u.includes(forcedFailure))return json({error:"fixture failure"},503);
  if(u.startsWith("https://www.deribit.com/api/v2/public/get_volatility_index_data?"))return json(fixtures.get(null));
  if(u.startsWith("https://publicreporting.cftc.gov/resource/gpe5-46if.json?")){
    const qp=new URL(u).searchParams;
    assert.equal(qp.get("$order"),"report_date_as_yyyy_mm_dd desc","CFTC must request latest reports before applying limit");
    assert.match(qp.get("$select")||"",/asset_mgr_positions_long/,"CFTC query must request required fields explicitly");
    return json(Array.from({length:24},(_,i)=>{
      const t=Date.UTC(2026,6,7)-i*7*864e5;
      return {report_date_as_yyyy_mm_dd:new Date(t).toISOString(),open_interest_all:String(30000-i*100),asset_mgr_positions_long:String(8000-i*20),asset_mgr_positions_short:String(2000-i*5),lev_money_positions_long:String(3000-i*10),lev_money_positions_short:String(12000-i*25)};
    }));
  }
  if(!fixtures.has(u))throw new Error(`unexpected URL ${u}`);
  return json(fixtures.get(u));
};

try{
  const cftc=await fetchCftc();
  assert.equal(cftc.data.length,24,"CFTC rows parsed");
  assert.ok(cftc.data[0].t<cftc.data[1].t,"CFTC parser restores chronological order");
  assert.equal(cftc.data[cftc.data.length-1].assetLong,8000,"CFTC current field names parsed");

  const d=await fetchDerivatives();
  assert.equal(d.partial,false);
  assert.equal(d.source_urls.length,4,"all derivative source links exposed");
  assert.equal(d.data.funding.length,4);
  assert.equal(d.data.funding.find(x=>x.venue==="Bybit").rate8h,0.0001,"4h Bybit funding normalized to 8h");
  assert.equal(d.data.funding.find(x=>x.venue==="Deribit").oiUsd,1_200_000_000,"Deribit OI remains USD, no price multiplication");
  assert.equal(d.data.funding.find(x=>x.venue==="Kraken Futures").rate8h,0.00008,"hourly Kraken funding normalized to 8h");
  assert.ok(d.data.basis>20&&d.data.basis<30,"annualized dated-future basis");
  assert.equal(d.data.skew,7,"OTM put-call IV proxy");
  assert.ok(Date.parse(d.observed_at)<=now&&Date.parse(d.observed_at)>=now-1000,"exchange observation time propagated");

  const spot=await fetchSpot();
  assert.equal(spot.partial,false);
  assert.equal(spot.source_urls.length,6,"all spot source links exposed");
  assert.deepEqual(spot.data,{coinbase:100050,kraken:100000,bitstamp:100060,gemini:100055,okx:100020,bybit:100010,kraken_usdt:100030,coinbase_usdt:100040});
  assert.ok(Date.parse(spot.observed_at)<=now&&Date.parse(spot.observed_at)>=now-1000,"spot timestamp propagated");

  const pegs=await fetchPegs();
  assert.deepEqual(pegs.data,{USDT:0.9998,USDC:1.0001});
  assert.equal(pegs.partial,false,"complete peg packet is healthy");

  // One missing major stablecoin must be visible as partial and must not be mistaken for healthy coverage.
  const pegUrl="https://stablecoins.llama.fi/stablecoins?includePrices=true";
  const pegFixture=fixtures.get(pegUrl);
  fixtures.set(pegUrl,{peggedAssets:[{symbol:"USDT",price:0.9998}]});
  const partialPegs=await fetchPegs();
  assert.equal(partialPegs.partial,true,"missing USDC marks peg packet partial");
  assert.deepEqual(partialPegs.data,{USDT:0.9998});
  assert.match(partialPegs.errors.join(" "),/USDC/);
  fixtures.set(pegUrl,pegFixture);

  // A non-critical derivative endpoint may fail without discarding funding/OI.
  globalThis.setTimeout=(fn,_ms,...args)=>originalSetTimeout(fn,0,...args);
  forcedFailure="kind=option";
  const partial=await fetchDerivatives();
  assert.equal(partial.partial,true,"partial derivative packet is marked");
  assert.equal(partial.data.funding.length,4,"funding/OI survives an options failure");
  forcedFailure="category=spot&symbol=BTCUSDT";
  const partialSpot=await fetchSpot();
  assert.equal(partialSpot.partial,true,"partial spot packet is marked");
  assert.equal(partialSpot.data.coinbase,100050,"complete USD pair survives an offshore venue failure");
  forcedFailure=null;

  // HTTP 200 with an impossible secondary quote is rejected before dispersion/override logic.
  const okxUrl="https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT";
  const okxFixture=fixtures.get(okxUrl);
  fixtures.set(okxUrl,{data:[{last:"100",ts:String(now-150)}]});
  const sanitizedSpot=await fetchSpot();
  assert.equal(sanitizedSpot.partial,true,"invalid quote marks spot packet partial");
  assert.equal(sanitizedSpot.data.okx,null,"invalid quote is removed");
  assert.equal(sanitizedSpot.data.coinbase,100050,"valid comparable pair is retained");
  assert.match(sanitizedSpot.errors.join(" "),/okx: invalid price/);
  fixtures.set(okxUrl,okxFixture);

  // HTTP 200 with venue-level error codes must be treated as a failed component.
  const bybitDerivUrl="https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT";
  const bybitDerivFixture=fixtures.get(bybitDerivUrl);
  fixtures.set(bybitDerivUrl,{retCode:10001,retMsg:"bad request",result:{list:[]}});
  const businessErrorDeriv=await fetchDerivatives();
  assert.equal(businessErrorDeriv.partial,true,"Bybit business error marks derivatives partial");
  assert.equal(businessErrorDeriv.data.funding.some(x=>x.venue==="Bybit"),false,"Bybit business error cannot leak an empty/invalid component");
  fixtures.set(bybitDerivUrl,bybitDerivFixture);

  const okxFundingUrl="https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP";
  const okxFundingFixture=fixtures.get(okxFundingUrl);
  fixtures.set(okxFundingUrl,{code:"51000",msg:"parameter error",data:[]});
  const okxBusinessError=await fetchDerivatives();
  assert.equal(okxBusinessError.partial,true,"OKX business error marks derivatives partial");
  assert.equal(okxBusinessError.data.funding.some(x=>x.venue==="OKX"),false,"OKX business error cannot leak a component");
  fixtures.set(okxFundingUrl,okxFundingFixture);

  const deribitTickerUrl="https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL";
  const deribitTickerFixture=fixtures.get(deribitTickerUrl);
  fixtures.set(deribitTickerUrl,{error:{code:10004,message:"not_found"}});
  const deribitBusinessError=await fetchDerivatives();
  assert.equal(deribitBusinessError.partial,true,"Deribit JSON-RPC error marks derivatives partial");
  assert.equal(deribitBusinessError.data.funding.some(x=>x.venue==="Deribit"),false,"Deribit JSON-RPC error cannot leak a component");
  fixtures.set(deribitTickerUrl,deribitTickerFixture);

  const krakenUrl="https://api.kraken.com/0/public/Ticker?pair=XBTUSD";
  const krakenFixture=fixtures.get(krakenUrl);
  fixtures.set(krakenUrl,{error:["EGeneral:Invalid arguments"],result:{}});
  const businessErrorSpot=await fetchSpot();
  assert.equal(businessErrorSpot.partial,true,"Kraken business error marks spot packet partial");
  assert.equal(businessErrorSpot.data.kraken,null,"Kraken business error cannot create a quote");
  fixtures.set(krakenUrl,krakenFixture);
  globalThis.setTimeout=originalSetTimeout;

  // US-runner geo-block: both offshore venues disappear. The USDT quote group must survive on the
  // two US-reachable venues, otherwise spot_integrity loses its vote and the tactical verdict dies.
  globalThis.setTimeout=(fn,_ms,...args)=>originalSetTimeout(fn,0,...args);
  forcedFailure="okx.com";
  const geo=await fetchSpot();
  assert.equal(geo.partial,true,"geo-blocked venues mark the spot packet partial");
  assert.equal(geo.data.okx,null,"OKX unavailable");
  assert.equal(quoteGroupPrices(geo.data,"USD").length,4,"USD group intact (Coinbase/Kraken/Bitstamp/Gemini)");
  assert.equal(quoteGroupPrices(geo.data,"USDT").length,3,"USDT group keeps Bybit plus both US venues");
  assert.ok(Number.isFinite(quoteDispersion(geo.data,"USDT")),"USDT dispersion still computable without OKX");
  forcedFailure=null;
  globalThis.setTimeout=originalSetTimeout;

  const fred=parseFred({observations:[{date:"2026-01-02",value:"2"},{date:"2026-01-01",value:"1"},{date:"2026-01-03",value:"."}]});
  assert.deepEqual(fred.map(x=>x.v),[1,2],"FRED parser filters missing values and sorts ascending");
} finally {
  globalThis.fetch=originalFetch;
  globalThis.setTimeout=originalSetTimeout;
}
console.log("Fixture integration tests OK");
