/*
  Endpoint probe.

  Runs inside the GitHub runner and reports what every upstream actually does *from that IP*.
  It never fails the job (`continue-on-error: true` in the workflow) and never prints a secret:
  credentials are sent, but only hostnames, status codes and shapes are logged.

  This exists because the three hardest failure modes of this project are invisible from a laptop:
    - Coin Metrics Community access changing tier/host;
    - offshore exchanges geo-blocking US datacentre ranges;
    - Farside's Cloudflare layer rejecting a non-browser User-Agent.
*/
const FRED_KEY = process.env.FRED_KEY || "";
const CM_KEY = process.env.CM_API_KEY || "";
const TIMEOUT = 20_000;

const CM_METRICS = "PriceUSD,CapMrktCurUSD,CapMVRVCur,FlowInExNtv,FlowOutExNtv,SplyExNtv,HashRate,IssTotUSD,FeeTotNtv,AdrActCnt,TxCnt,TxTfrCnt,volume_reported_spot_usd_1d";
// Coin Metrics is an OPTIONAL enrichment layer. A failure here is not fatal — see the notes below.

const redact = u => String(u).replace(/(api_key=)[^&]+/g, "$1***");
const host = u => { try { return new URL(u).host; } catch { return "?"; } };

async function probe(name, url, inspect) {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "btc-21m-dashboard/2.2", "Accept": "application/json,text/html,*/*" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const ms = Date.now() - started;
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* html or plain text */ }
    let note = "";
    try { note = inspect ? String(inspect(body, text, r) ?? "") : ""; } catch (e) { note = `inspect failed: ${e?.message || e}`; }
    const verdict = r.ok && !/^!/.test(note) ? "OK  " : "FAIL";
    return { name, verdict, status: r.status, ms, host: host(url), note: note.slice(0, 110) };
  } catch (e) {
    return { name, verdict: "FAIL", status: "-", ms: Date.now() - started, host: host(url), note: String(e?.message || e).slice(0, 110) };
  }
}

const cmUrl = root => {
  const q = new URLSearchParams({ assets: "btc", metrics: CM_METRICS, frequency: "1d", page_size: "1", sort: "desc", ignore_forbidden_errors: "true", ignore_unsupported_errors: "true" });
  if (CM_KEY && root.includes("//api.")) q.set("api_key", CM_KEY);
  return `${root}/timeseries/asset-metrics?${q}`;
};
const cmInspect = body => {
  const row = body?.data?.[0];
  if (!row) return "!no rows returned";
  const served = Object.keys(row).filter(k => !["asset", "time"].includes(k));
  const missing = CM_METRICS.split(",").filter(m => !served.includes(m));
  return `${served.length}/13 metrics · ${row.time?.slice(0, 10)}` + (missing.length ? ` · missing: ${missing.join(",")}` : " · complete");
};

const checks = [
  ["FRED WALCL", `https://api.stlouisfed.org/fred/series/observations?series_id=WALCL&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`,
    b => b?.error_message ? `!${b.error_message}` : `latest ${b?.observations?.[0]?.date}`],
  ["FRED VXVCLS", `https://api.stlouisfed.org/fred/series/observations?series_id=VXVCLS&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`,
    b => b?.error_message ? `!${b.error_message}` : `latest ${b?.observations?.[0]?.date}`],
  ["FRED NASDAQ100", `https://api.stlouisfed.org/fred/series/observations?series_id=NASDAQ100&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`,
    b => b?.error_message ? `!${b.error_message}` : `latest ${b?.observations?.[0]?.date}`],

  ["CoinMetrics api.*", cmUrl("https://api.coinmetrics.io/v4"), cmInspect],
  ["CoinMetrics community-api.*", cmUrl("https://community-api.coinmetrics.io/v4"), cmInspect],
  ["Coinbase candles (PRIMARY price)", "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400",
    b => Array.isArray(b) && b.length ? `${b.length} candles · close ${b[0]?.[4]}` : "!no candles"],
  ["CoinGecko markets (ATH only)", "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&sparkline=false",
    b => Array.isArray(b) && b[0]?.ath ? `ath ${b[0].ath}` : "!rate-limited or no ath — ATH degrades to window max"],
  ["mempool hashrate (PRIMARY network)", "https://mempool.space/api/v1/mining/hashrate/3y",
    b => (b?.hashrates?.length || 0) > 300 ? `${b.hashrates.length} points` : "!history too short"],
  ["mempool difficulty", "https://mempool.space/api/v1/difficulty-adjustment",
    b => Number.isFinite(Number(b?.difficultyChange)) ? `next retarget ${Number(b.difficultyChange).toFixed(1)}%` : "!no difficultyChange"],
  ["Bitstamp BTC/USD", "https://www.bitstamp.net/api/v2/ticker/btcusd/",
    b => b?.last ? `price ${b.last}` : "!no price"],

  ["Farside ETF (HTML)", "https://farside.co.uk/bitcoin-etf-flow-all-data/",
    (_b, text) => { const rows = (text.match(/<tr[\s\S]*?<\/tr>/gi) || []).length; const dated = (text.match(/\d{1,2}\s+[A-Z][a-z]{2}\s+20\d{2}/g) || []); return rows < 50 || !dated.length ? `!only ${rows} rows — Cloudflare challenge?` : `${rows} rows · last ${dated[dated.length - 1]}`; }],

  ["DefiLlama pegs", "https://stablecoins.llama.fi/stablecoins?includePrices=true",
    b => { const a = b?.peggedAssets || []; const f = s => a.find(x => String(x.symbol).toUpperCase() === s)?.price; return f("USDT") && f("USDC") ? `USDT ${f("USDT")} · USDC ${f("USDC")}` : "!USDT/USDC price missing"; }],
  ["DefiLlama supply history", "https://stablecoins.llama.fi/stablecoincharts/all",
    b => Array.isArray(b) && b.length > 100 ? `${b.length} points` : "!history too short"],

  ["CFTC TFF (short names)", "https://publicreporting.cftc.gov/resource/gpe5-46if.json?" + new URLSearchParams({ "$select": "report_date_as_yyyy_mm_dd,open_interest_all,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short", "$limit": "1", "$where": "market_and_exchange_names='BITCOIN - CHICAGO MERCANTILE EXCHANGE'", "$order": "report_date_as_yyyy_mm_dd desc" }),
    b => Array.isArray(b) && b[0]?.asset_mgr_positions_long ? `latest ${String(b[0].report_date_as_yyyy_mm_dd).slice(0, 10)}` : "!fields absent"],
  ["CFTC TFF (_all names)", "https://publicreporting.cftc.gov/resource/gpe5-46if.json?" + new URLSearchParams({ "$select": "report_date_as_yyyy_mm_dd,open_interest_all,asset_mgr_positions_long_all,asset_mgr_positions_short_all,lev_money_positions_long_all,lev_money_positions_short_all", "$limit": "1", "$where": "market_and_exchange_names='BITCOIN - CHICAGO MERCANTILE EXCHANGE'", "$order": "report_date_as_yyyy_mm_dd desc" }),
    b => Array.isArray(b) && b[0]?.asset_mgr_positions_long_all ? `latest ${String(b[0].report_date_as_yyyy_mm_dd).slice(0, 10)}` : "!fields absent"],

  ["Deribit perpetual", "https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL",
    b => b?.error ? `!${b.error.message}` : `funding_8h ${b?.result?.funding_8h} · OI ${b?.result?.open_interest}`],
  ["Deribit DVOL", "https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=" + (Date.now() - 7 * 864e5) + "&end_timestamp=" + Date.now() + "&resolution=1D",
    b => b?.error ? `!${b.error.message}` : `${b?.result?.data?.length || 0} candles`],
  ["Bybit linear (geo-block test)", "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT",
    b => Number(b?.retCode) !== 0 ? `!retCode ${b?.retCode} ${b?.retMsg || ""}` : `funding ${b?.result?.list?.[0]?.fundingRate}`],
  ["OKX openapi (geo-block test)", "https://openapi.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP",
    b => String(b?.code) !== "0" ? `!code ${b?.code} ${b?.msg || ""}` : `funding ${b?.data?.[0]?.fundingRate}`],
  ["OKX www (geo-block test)", "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP",
    b => String(b?.code) !== "0" ? `!code ${b?.code} ${b?.msg || ""}` : `funding ${b?.data?.[0]?.fundingRate}`],

  ["Coinbase BTC-USD", "https://api.exchange.coinbase.com/products/BTC-USD/ticker", b => `price ${b?.price}`],
  ["Coinbase BTC-USDT", "https://api.exchange.coinbase.com/products/BTC-USDT/ticker", b => b?.price ? `price ${b.price}` : "!no price"],
  ["Kraken XBTUSD", "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    b => b?.error?.length ? `!${b.error.join(",")}` : `price ${Object.values(b?.result || {})[0]?.c?.[0]}`],
  ["Kraken XBTUSDT", "https://api.kraken.com/0/public/Ticker?pair=XBTUSDT",
    b => b?.error?.length ? `!${b.error.join(",")}` : `price ${Object.values(b?.result || {})[0]?.c?.[0]}`],
];

console.log(`Endpoint probe · ${new Date().toISOString()}\n`);
const results = [];
for (const [name, url, inspect] of checks) {
  const r = await probe(name, url, inspect);
  results.push(r);
  console.log(`${r.verdict}  ${String(r.status).padEnd(4)} ${String(r.ms + "ms").padStart(7)}  ${name.padEnd(32)} ${r.note}`);
  if (r.verdict === "FAIL") console.log(`      url: ${redact(url)}`);
}

const bad = results.filter(r => r.verdict === "FAIL");
console.log(`\n${results.length - bad.length}/${results.length} endpoints reachable from this runner.`);

// Interpretation, so the log is actionable without re-reading the source.
const down = n => bad.some(r => r.name.startsWith(n));
const notes = [];
if (down("CoinMetrics api.*") && down("CoinMetrics community-api.*")) notes.push("Coin Metrics unreachable on BOTH hosts → MVRV, exchange flows, activity and miner revenue lose their vote. The panel KEEPS WORKING (price/volume from Coinbase, hashrate from mempool.space), but with no valuation data the strategic verdict can never rise above ПЕРЕХОДНЫЙ. This is the asymmetric valuation gate, not a bug.");
if (down("Coinbase candles")) notes.push("The PRIMARY price history is down. Nothing else can replace it — the run will fail. This is the one endpoint the model cannot lose.");
if (down("mempool hashrate")) notes.push("The PRIMARY network source is down → network_security is required for the strategic verdict, so it will read НЕДОСТАТОЧНО ДАННЫХ.");
if (down("CoinGecko markets")) notes.push("CoinGecko rate-limited this runner (its keyless tier throttles cloud IPs). Harmless: the ATH degrades to the observed window maximum and the drawdown card says so.");
if (down("Bybit") && (down("OKX openapi") && down("OKX www"))) notes.push("Both offshore venues are blocked from this IP (expected on US-hosted runners). Leverage now runs on Deribit alone; the USDT quote group runs on Kraken/Coinbase.");
if (down("Deribit perpetual")) notes.push("Deribit is down as well → the leverage block is nearly empty. The tactical verdict SURVIVES on realized volatility, which is computed from the price series and cannot be geo-blocked.");
if (down("Farside")) notes.push("Farside rejected this request → ETF flows are unavailable and the strategic verdict cannot be issued. Likely a Cloudflare bot rule against the non-browser User-Agent.");
if (down("CFTC TFF (short names)") && down("CFTC TFF (_all names)")) notes.push("Neither CFTC column naming works → institutional_quality is lost (survivable: demand coverage stays at 0.75).");
if (notes.length) console.log("\nWhat this means:\n- " + notes.join("\n- "));
