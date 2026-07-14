/*
  Backtest data downloader — pulls FULL histories from the same free sources the dashboard uses,
  so the scoring engine can be reconstructed walk-forward over multiple years.
  Saves one JSON per dataset into backtest/data/. Failures are recorded, not fatal.
*/
import { writeFileSync, mkdirSync } from "node:fs";

const NOW = Date.now();
const DAY = 86_400_000;
const OUTDIR = new URL("./data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUTDIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = t => new Date(t).toISOString();
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const finite = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

async function request(url, { text = false, tries = 3, headers = {}, method = "GET", body = null } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method,
        headers: { "User-Agent": "btc-21m-backtest/1.0", Accept: text ? "text/plain,text/html,*/*" : "application/json,*/*", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return text ? await r.text() : await r.json();
    } catch (e) {
      err = e;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    }
  }
  throw err;
}

const results = {};
async function save(name, fn) {
  try {
    const data = await fn();
    writeFileSync(`${OUTDIR}${name}.json`, JSON.stringify(data));
    const n = Array.isArray(data) ? data.length : Object.keys(data).length;
    results[name] = `ok (${n})`;
    console.log(`✓ ${name}: ${n}`);
  } catch (e) {
    results[name] = `FAIL: ${e.message}`;
    console.log(`✗ ${name}: ${e.message}`);
  }
}

// ---- FRED (keyless CSV, full history) ----
function parseFredCsv(textBody) {
  const lines = String(textBody || "").trim().split(/\r?\n/);
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const t = Date.parse(String(cells[0] || "").trim() + "T00:00:00Z");
    const raw = String(cells[1] ?? "").trim();
    if (!raw || raw === ".") continue;
    const v = Number(raw);
    if (Number.isFinite(t) && Number.isFinite(v)) out.push({ t, v });
  }
  return out.sort((a, b) => a.t - b.t);
}
const FRED_IDS = ["WALCL", "WTREGEN", "RRPONTSYD", "DFII10", "DGS2", "DGS10", "DTWEXBGS", "BAMLH0A0HYM2", "VIXCLS", "VXVCLS", "NASDAQ100"];

// ---- Coinbase daily candles (2015 -> now) ----
async function fetchCoinbase(days = 4100) {
  const byDay = new Map(), chunk = 280 * DAY;
  for (let a = NOW - days * DAY; a < NOW; a += chunk) {
    const b = Math.min(NOW, a + chunk);
    const u = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${encodeURIComponent(iso(a))}&end=${encodeURIComponent(iso(b))}`;
    const rows = await request(u, { tries: 3 });
    for (const r of rows || []) {
      const t = Date.parse(dayKey(Number(r[0]) * 1000) + "T00:00:00Z");
      const close = Number(r[4]), volBase = Number(r[5]);
      if (Number.isFinite(t) && Number.isFinite(close) && close > 100) byDay.set(t, { t, v: close, volume: Number.isFinite(volBase) ? volBase * close : null });
    }
    await sleep(250);
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

// ---- The Block ETF flows ----
function parseEtfFlowJson(j) {
  const jf = j?.chart?.jsonFile || j, data = jf?.Series?.["Total Net Flow"]?.Data;
  if (!Array.isArray(data)) throw new Error("ETF series not found");
  const rows = data.map(d => ({ t: Number(d.Timestamp) * 1000, v: Number(d.Result) })).filter(x => finite(x.t) && finite(x.v) && ![0, 6].includes(new Date(x.t).getUTCDay()));
  return [...new Map(rows.map(x => [x.t, x])).values()].sort((a, b) => a.t - b.t);
}

// ---- DefiLlama stablecoins ----
function normalizeStable(j) {
  const arr = Array.isArray(j) ? j : j?.data || [];
  return arr.map(r => {
    const raw = r.date ?? r.timestamp ?? r.time, n = Number(raw), t = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(raw);
    const v = r.totalCirculating?.peggedUSD ?? r.totalCirculatingUSD?.peggedUSD ?? r.totalCirculatingUSD ?? r.totalCirculating ?? r.total;
    return { t, v: Number(v) };
  }).filter(x => finite(x.t) && finite(x.v) && x.v > 1e9).sort((a, b) => a.t - b.t);
}

// ---- bitcoin-data.com MVRV ----
async function fetchMvrv() {
  const payload = await request("https://bitcoin-data.com/v1/mvrv", { tries: 3 });
  const arr = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const rows = arr.map(x => {
    const raw = x?.unixTs ?? x?.timestamp ?? x?.time ?? x?.date, n = Number(raw), t = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(raw);
    return { t, v: Number(x?.mvrv ?? x?.value) };
  }).filter(x => finite(x.t) && finite(x.v)).sort((a, b) => a.t - b.t);
  if (rows.length < 500) throw new Error(`too short: ${rows.length}`);
  return rows;
}

// ---- blockchain.info charts (full history) ----
async function fetchBcChart(name, timespan = "all") {
  const j = await request(`https://api.blockchain.info/charts/${name}?timespan=${timespan}&format=json&sampled=false`, { tries: 3 });
  const a = (j?.values || []).map(x => ({ t: Number(x.x) * 1000, v: Number(x.y) })).filter(x => finite(x.t) && finite(x.v)).sort((x, y) => x.t - y.t);
  if (a.length < 100) throw new Error(`too short: ${a.length}`);
  return a;
}

// ---- CFTC TFF (weekly, full history) ----
function num(v) { return finite(v) ? Number(v) : null; }
async function fetchCftc() {
  const where = "market_and_exchange_names='BITCOIN - CHICAGO MERCANTILE EXCHANGE'";
  const fields = ["report_date_as_yyyy_mm_dd", "open_interest_all", "asset_mgr_positions_long", "asset_mgr_positions_short", "lev_money_positions_long", "lev_money_positions_short"];
  const params = new URLSearchParams({ $select: fields.join(","), $limit: "1000", $where: where, $order: "report_date_as_yyyy_mm_dd desc" });
  const rows = await request(`https://publicreporting.cftc.gov/resource/gpe5-46if.json?${params}`, { tries: 3 });
  return rows.map(r => ({
    t: Date.parse(r.report_date_as_yyyy_mm_dd),
    oi: num(r.open_interest_all),
    assetLong: num(r.asset_mgr_positions_long), assetShort: num(r.asset_mgr_positions_short),
    levLong: num(r.lev_money_positions_long), levShort: num(r.lev_money_positions_short),
  })).filter(r => finite(r.t) && finite(r.oi)).sort((a, b) => a.t - b.t);
}

// ---- Deribit DVOL (since 2021-03, chunked) ----
async function fetchDvol() {
  const out = new Map();
  const start0 = Date.UTC(2021, 2, 1);
  for (let a = start0; a < NOW; a += 300 * DAY) {
    const b = Math.min(NOW, a + 300 * DAY);
    const j = await request(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${a}&end_timestamp=${b}&resolution=1D`, { tries: 3 });
    for (const r of j?.result?.data || []) {
      const t = Number(r[0]), v = Number(r[4]);
      if (finite(t) && finite(v)) out.set(dayKey(t), { t: Date.parse(dayKey(t) + "T00:00:00Z"), v });
    }
    await sleep(300);
  }
  const rows = [...out.values()].sort((a, b) => a.t - b.t);
  if (rows.length < 300) throw new Error(`too short: ${rows.length}`);
  return rows;
}

// ---- Coin Metrics community (exchange flows etc.) ----
const CM_METRICS = ["CapMVRVCur", "FlowInExNtv", "FlowOutExNtv", "SplyExNtv", "IssTotUSD", "FeeTotNtv", "AdrActCnt", "TxCnt", "TxTfrCnt"];
async function fetchCoinMetrics() {
  const start = "2015-01-01";
  const by = {}; CM_METRICS.forEach(k => by[k] = []);
  let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=${CM_METRICS.join(",")}&frequency=1d&start_time=${start}&page_size=10000&ignore_forbidden_errors=true&ignore_unsupported_errors=true`;
  for (let page = 0; page < 10 && url; page++) {
    const j = await request(url, { tries: 3 });
    for (const r of j?.data || []) {
      const t = Date.parse(String(r.time).slice(0, 10) + "T00:00:00Z");
      if (!finite(t)) continue;
      for (const k of CM_METRICS) if (finite(r[k])) by[k].push({ t, v: Number(r[k]) });
    }
    url = j?.next_page_url || null;
    await sleep(400);
  }
  for (const k of CM_METRICS) by[k].sort((a, b) => a.t - b.t);
  if (!CM_METRICS.some(k => by[k].length > 500)) throw new Error("no usable series");
  return by;
}

// ---- run all ----
for (const id of FRED_IDS) {
  await save(`fred_${id}`, async () => parseFredCsv(await request(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { text: true })));
  await sleep(300);
}
await save("price_coinbase", () => fetchCoinbase());
await save("etf_flows", async () => parseEtfFlowJson(await request("https://www.theblock.co/api/charts/chart/etfs/bitcoin/spot-bitcoin-etf-total-net-flow", { tries: 3 })));
await save("stablecoins", async () => normalizeStable(await request("https://stablecoins.llama.fi/stablecoincharts/all", { tries: 3 })));
await save("mvrv", () => fetchMvrv());
await save("bc_hashrate", () => fetchBcChart("hash-rate"));
await save("bc_difficulty", () => fetchBcChart("difficulty"));
await save("bc_addresses", () => fetchBcChart("n-unique-addresses"));
await save("bc_transactions", () => fetchBcChart("n-transactions"));
await save("bc_miner_revenue", () => fetchBcChart("miners-revenue"));
await save("bc_price_all", () => fetchBcChart("market-price"));
await save("cftc", () => fetchCftc());
await save("dvol", () => fetchDvol());
await save("coinmetrics", () => fetchCoinMetrics());

writeFileSync(`${OUTDIR}_manifest.json`, JSON.stringify({ downloaded_at: iso(NOW), results }, null, 2));
console.log("\nDone:", JSON.stringify(results, null, 2));
