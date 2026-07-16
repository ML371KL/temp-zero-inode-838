/*
  Walk-forward reconstruction of the 21M dashboard scoring engine.
  Replicates fetch-snapshot.mjs family scores, block scores, weighted aggregates and the
  candidateRegimes() gate tree at every historical date, using only data <= that date.

  Not reconstructable (no free history): us_spot_premium, carry_regime (funding/basis),
  oi_quality, spot_integrity, stablecoin_peg, and the skew half of options_vol.
  Those families are null; coverage math handles them exactly as the live engine does
  when a source is geo-blocked.
*/
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const DAY = 86_400_000;
const DATA = new URL("./data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = new URL("./out/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUT, { recursive: true });

// ---- helpers copied semantically from fetch-snapshot.mjs ----
const finite = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = a => a.length ? a.reduce((s, v) => s + Number(v), 0) / a.length : null;
const stdev = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const last = a => a?.length ? a[a.length - 1] : null;
const pct = (a, b) => finite(a) && finite(b) && Number(b) !== 0 ? (Number(a) / Number(b) - 1) * 100 : null;
const dayKey = t => new Date(t).toISOString().slice(0, 10);

function percentileRank(values, value) {
  const x = values.filter(finite).map(Number);
  if (x.length < 30 || !finite(value)) return null;
  const y = Number(value), less = x.filter(v => v < y).length, equal = x.filter(v => v === y).length;
  return (less + 0.5 * equal) / x.length * 100;
}
function componentScore(parts) { const a = parts.filter(finite).map(Number); return a.length ? clamp(Math.round(mean(a) * 2) / 2, -2, 2) : null; }
function highGood(p) { return !finite(p) ? null : p >= 90 ? 2 : p >= 65 ? 1 : p >= 35 ? 0 : p >= 10 ? -1 : -2; }
function lowGood(p) { return !finite(p) ? null : p <= 10 ? 2 : p <= 35 ? 1 : p <= 65 ? 0 : p <= 90 ? -1 : -2; }
function customScore(v, bands) { if (!finite(v)) return null; for (const [test, score] of bands) if (test(Number(v))) return score; return 0; }
function nearestAtOrBefore(s, t) { let lo = 0, hi = s.length - 1, found = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].t <= t) { found = s[m]; lo = m + 1; } else hi = m - 1; } return found; }
function idxAtOrBefore(s, t) { let lo = 0, hi = s.length - 1, found = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].t <= t) { found = m; lo = m + 1; } else hi = m - 1; } return found; }
function priorByDays(s, days, endIdx) { const target = s[endIdx].t - days * DAY; const i = idxAtOrBefore(s, target); return i >= 0 ? s[i] : null; }

function trailingChangeSeries(s, days, { difference = false, scale = 1 } = {}) {
  const out = [];
  for (let i = 1, j = 0; i < s.length; i++) {
    const target = s[i].t - days * DAY;
    while (j + 1 < i && s[j + 1].t <= target) j++;
    const prev = s[j];
    if (!prev || prev.t > target || !finite(prev.v) || !finite(s[i].v)) continue;
    const v = difference ? (s[i].v - prev.v) * scale : pct(s[i].v, prev.v);
    if (finite(v)) out.push({ t: s[i].t, v });
  }
  return out;
}
function changeOfAverageSeries(s, recent = 30, previous = 90) {
  const out = [];
  for (let i = recent + previous - 1; i < s.length; i++) {
    const r = mean(s.slice(i - recent + 1, i + 1).map(x => x.v).filter(finite));
    const b = mean(s.slice(i - recent - previous + 1, i - recent + 1).map(x => x.v).filter(finite));
    const v = pct(r, b);
    if (finite(v)) out.push({ t: s[i].t, v });
  }
  return out;
}
function rollingSum(s, n) { const out = []; let acc = 0; for (let i = 0; i < s.length; i++) { acc += s[i].v; if (i >= n) acc -= s[i - n].v; if (i >= n - 1) out.push({ t: s[i].t, v: acc }); } return out; }
function rollingMeanSeries(s, n) { const out = []; let acc = 0; for (let i = 0; i < s.length; i++) { acc += s[i].v; if (i >= n) acc -= s[i - n].v; if (i >= n - 1) out.push({ t: s[i].t, v: acc / n }); } return out; }

// percentile of the value at index idx of `series`, over the trailing window of `windowN` points ending at idx (inclusive)
function pctAt(series, idx, windowN) {
  if (idx < 0) return null;
  const start = windowN ? Math.max(0, idx - windowN + 1) : 0;
  const w = series.slice(start, idx + 1).map(x => x.v);
  return percentileRank(w, series[idx].v);
}
// percentile of value at idx over trailing window of DAYS (sliceDays semantics)
function pctAtDays(series, idx, days) {
  if (idx < 0) return null;
  const cut = series[idx].t - days * DAY;
  const w = [];
  for (let i = idx; i >= 0 && series[i].t >= cut; i--) w.push(series[i].v);
  return percentileRank(w, series[idx].v);
}

// ---- load data ----
function load(name) { try { return JSON.parse(readFileSync(`${DATA}${name}.json`, "utf8")); } catch { return null; } }
const fredIds = ["WALCL", "WTREGEN", "RRPONTSYD", "DFII10", "DGS2", "DGS10", "DTWEXBGS", "BAMLH0A0HYM2", "VIXCLS", "VXVCLS", "NASDAQ100"];
const F = Object.fromEntries(fredIds.map(id => [id, load(`fred_${id}`) || []]));
const priceCb = load("price_coinbase") || [];
const bcPrice = load("bc_price_all") || [];
const etf = load("etf_flows") || [];
const stable = load("stablecoins") || [];
const CM_EARLY = load("coinmetrics_deep") || load("coinmetrics") || {};
// Engine prefers Coin Metrics MVRV; bitcoin-data.com free tier only serves the last 4 years.
const mvrv = (CM_EARLY.CapMVRVCur || []).length >= 500 ? CM_EARLY.CapMVRVCur : (load("mvrv") || []);
const hash = load("bc_hashrate") || [];
const diff = load("bc_difficulty") || [];
const addr = load("bc_addresses") || [];
const txs = load("bc_transactions") || [];
const minerRev = load("bc_miner_revenue") || [];
const cftc = load("cftc") || [];
const dvolS = load("dvol") || [];
const CM = load("coinmetrics_deep") || load("coinmetrics") || {};

// price: Coinbase primary (2015+), extended backward with blockchain.info for MA warmup only
const cbStart = priceCb.length ? priceCb[0].t : Infinity;
const price = [...bcPrice.filter(x => x.t < cbStart && x.v > 0.01), ...priceCb.map(x => ({ t: x.t, v: x.v }))].sort((a, b) => a.t - b.t);
const volume = priceCb.filter(x => finite(x.volume)).map(x => ({ t: x.t, v: x.volume }));
const priceByDay = new Map(price.map(x => [dayKey(x.t), x.v]));

// ---- precompute derived (causal) series ----
// I. macro
const walcl = F.WALCL, tga = F.WTREGEN, rrp = F.RRPONTSYD;
const net = [];
for (const p of walcl) { const a = nearestAtOrBefore(tga, p.t), b = nearestAtOrBefore(rrp, p.t); if (a && b) net.push({ t: p.t, v: p.v / 1000 - a.v / 1000 - b.v }); }
const net4S = trailingChangeSeries(net, 28), net13S = trailingChangeSeries(net, 91);
const real4S = trailingChangeSeries(F.DFII10, 28, { difference: true, scale: 100 });
const usd4S = trailingChangeSeries(F.DTWEXBGS, 28);
const hy4S = trailingChangeSeries(F.BAMLH0A0HYM2, 28, { difference: true, scale: 100 });
const dgs10 = F.DGS10;
const absMoves = dgs10.slice(1).map((p, i) => ({ t: p.t, v: Math.abs(p.v - dgs10[i].v) * 100 }));
const rateVolS = rollingMeanSeries(absMoves, 20);
// VIX/VXV ratio series on common dates
const vxvByDay = new Map(F.VXVCLS.map(x => [dayKey(x.t), x.v]));
const vixRatioS = F.VIXCLS.map(x => { const b = vxvByDay.get(dayKey(x.t)); return finite(b) && b !== 0 ? { t: x.t, v: x.v / b } : null; }).filter(Boolean);

// II. demand
const dailyBtc = etf.map(row => { const p = priceByDay.get(dayKey(row.t)) ?? nearestAtOrBefore(price, row.t)?.v; return finite(p) && p > 0 ? { t: row.t, v: row.v / p } : null; }).filter(Boolean);
const f5Btc = rollingSum(dailyBtc, 5), f20Btc = rollingSum(dailyBtc, 20), etf20Usd = rollingSum(etf, 20);
const st30S = trailingChangeSeries(stable, 30), st90S = trailingChangeSeries(stable, 90);
const cmIn = CM.FlowInExNtv || [], cmOut = CM.FlowOutExNtv || [], cmReserve = CM.SplyExNtv || [];
const outMap = new Map(cmOut.map(x => [dayKey(x.t), x.v]));
const netflow = cmIn.map(p => { const o = outMap.get(dayKey(p.t)); return finite(o) ? { t: p.t, v: p.v - o } : null; }).filter(Boolean);
const nf7S = rollingSum(netflow, 7);
const res90S = trailingChangeSeries(cmReserve, 90);
// CFTC positioning
const cot = cftc.filter(r => r.oi > 0 && [r.assetLong, r.assetShort, r.levLong, r.levShort].every(finite)).map(r => ({ t: r.t, assetNet: (r.assetLong - r.assetShort) / r.oi * 100, levNetShort: (r.levShort - r.levLong) / r.oi * 100 }));

// III. cycle
const h90S = trailingChangeSeries(hash, 90), d90S = trailingChangeSeries(diff, 90);
const addrChS = changeOfAverageSeries(addr, 30, 90), txChS = changeOfAverageSeries(txs, 30, 90);
const cmTfr = CM.TxTfrCnt || [];
const tfrChS = cmTfr.length >= 180 ? changeOfAverageSeries(cmTfr, 30, 90) : [];
const hashMap = new Map(hash.map(x => [dayKey(x.t), x.v]));
const revHash = minerRev.map(r => { const h = hashMap.get(dayKey(r.t)); return finite(h) && h > 0 ? { t: r.t, v: r.v / h } : null; }).filter(Boolean);
const hpChS = changeOfAverageSeries(revHash, 30, 30);
// moving averages of price
const ma140S = rollingMeanSeries(price, 140), ma200S = rollingMeanSeries(price, 200), ma1400S = rollingMeanSeries(price, 1400);

// IV. leverage
const logRet = price.slice(1).map((p, i) => ({ t: p.t, v: Math.log(p.v / price[i].v) }));
const rv30S = []; {
  let accS = 0, accQ = 0; const q = [];
  for (let i = 0; i < logRet.length; i++) {
    q.push(logRet[i].v); accS += logRet[i].v; accQ += logRet[i].v ** 2;
    if (q.length > 30) { const d = q.shift(); accS -= d; accQ -= d ** 2; }
    if (q.length === 30) { const m = accS / 30, varr = accQ / 30 - m * m; rv30S.push({ t: logRet[i].t, v: Math.sqrt(Math.max(0, varr)) * Math.sqrt(365) * 100 }); }
  }
}
// V. market
const volChS = changeOfAverageSeries(volume, 30, 30);

// ---- as-of family scoring ----
const FRESH = { weekly: 21 * DAY, daily: 10 * DAY, etf: 6 * DAY, cm: 6 * DAY, dvol: 6 * DAY };
function latestWithin(series, t, maxAge) { const i = idxAtOrBefore(series, t); if (i < 0) return null; return t - series[i].t <= maxAge ? i : null; }

function familyScoresAt(t) {
  const s = {}, raw = {};
  s._raw = raw;
  // liquidity
  {
    const i4 = latestWithin(net4S, t, FRESH.weekly), i13 = latestWithin(net13S, t, FRESH.weekly);
    if (i4 != null && i13 != null) {
      const p4 = pctAt(net4S, i4, 260), p13 = pctAt(net13S, i13, 260);
      raw.net4 = net4S[i4].v; raw.net13 = net13S[i13].v; raw.net4Pct = p4; raw.net13Pct = p13;
      let sc = componentScore([highGood(p4), highGood(p13)]);
      if (finite(net13S[i13].v) && net13S[i13].v < 0 && finite(sc)) sc = Math.min(sc, 0);
      s.liquidity = sc;
    } else s.liquidity = null;
  }
  // conditions
  {
    const ir = latestWithin(real4S, t, FRESH.daily), iu = latestWithin(usd4S, t, FRESH.daily);
    const pr = ir != null ? pctAt(real4S, ir, 750) : null, pu = iu != null ? pctAt(usd4S, iu, 750) : null;
    raw.real4 = ir != null ? real4S[ir].v : null; raw.usd4 = iu != null ? usd4S[iu].v : null; raw.real4Pct = pr; raw.usd4Pct = pu;
    s.conditions = componentScore([lowGood(pr), lowGood(pu)]);
  }
  // stress
  {
    const ih = latestWithin(hy4S, t, FRESH.daily), iv = latestWithin(vixRatioS, t, FRESH.daily), irv = latestWithin(rateVolS, t, FRESH.daily);
    const ph = ih != null ? pctAt(hy4S, ih, 750) : null;
    const vr = iv != null ? vixRatioS[iv].v : null;
    const prv = irv != null ? pctAt(rateVolS, irv, 750) : null;
    raw.hy4Pct = ph; raw.vixRatio = vr; raw.rateVolPct = prv;
    s.stress = componentScore([lowGood(ph), customScore(vr, [[v => v < .90, 1], [v => v < 1, 0], [v => v < 1.10, -1], [() => true, -2]]), finite(prv) ? lowGood(prv) : null]);
    s.stress28 = componentScore([lowGood(ph), customScore(vr, [[v => v < 1, 0], [v => v < 1.10, -1], [() => true, -2]]), finite(prv) ? Math.min(lowGood(prv), 0) : null]);
  }
  // etf
  {
    const i5 = latestWithin(f5Btc, t, FRESH.etf), i20 = latestWithin(f20Btc, t, FRESH.etf);
    if (i5 != null && i20 != null) {
      const p5 = pctAt(f5Btc, i5, 0), p20 = pctAt(f20Btc, i20, 0); // full history windows
      raw.etf5Btc = f5Btc[i5].v; raw.etf20Btc = f20Btc[i20].v; raw.etf5Pct = p5; raw.etf20Pct = p20;
      let sc = componentScore([finite(f5Btc[i5].v) ? highGood(p5) : null, finite(f20Btc[i20].v) ? highGood(p20) : null]);
      if (f20Btc[i20].v < 0 && finite(sc)) sc = Math.min(sc, 0);
      s.etf = sc;
    } else s.etf = null;
  }
  // stablecoins
  {
    const i30 = latestWithin(st30S, t, FRESH.daily), i90 = latestWithin(st90S, t, FRESH.daily);
    if (i30 != null && i90 != null) {
      const p30 = pctAt(st30S, i30, 1460), p90 = pctAt(st90S, i90, 1460);
      raw.st30 = st30S[i30].v; raw.st90 = st90S[i90].v; raw.st30Pct = p30; raw.st90Pct = p90;
      let sc = componentScore([highGood(p30), highGood(p90)]);
      if (st90S[i90].v < 0 && finite(sc)) sc = Math.min(sc, 0);
      s.stablecoins = sc;
    } else s.stablecoins = null;
  }
  // exchange_supply
  {
    const i7 = latestWithin(nf7S, t, FRESH.cm), ir = latestWithin(res90S, t, FRESH.cm);
    const p7 = i7 != null ? pctAt(nf7S, i7, 1460) : null, pr = ir != null ? pctAt(res90S, ir, 1460) : null;
    raw.nf7Pct = p7; raw.res90 = ir != null ? res90S[ir].v : null; raw.res90Pct = pr;
    s.exchange_supply = componentScore([finite(p7) ? lowGood(p7) : null, finite(pr) ? lowGood(pr) : null]);
    const nf7v = i7 != null ? nf7S[i7].v : null, res90v = ir != null ? res90S[ir].v : null;
    s.exchange_supply28 = componentScore([finite(p7) ? (finite(nf7v) && nf7v > 0 ? Math.min(lowGood(p7), 0) : lowGood(p7)) : null, finite(pr) ? (finite(res90v) && res90v > 0 ? Math.min(lowGood(pr), 0) : lowGood(pr)) : null]);
  }
  // institutional
  {
    const ic = idxAtOrBefore(cot, t);
    if (ic >= 4 && t - cot[ic].t <= 15 * DAY) {
      const cur = cot[ic], prev = cot[ic - 4];
      const asset4 = cur.assetNet - prev.assetNet, lev4 = cur.levNetShort - prev.levNetShort;
      const ie = latestWithin(etf20Usd, t, FRESH.etf), e20 = ie != null ? etf20Usd[ie].v : null;
      raw.asset4 = asset4; raw.lev4 = lev4;
      s.institutional = asset4 > 1 && lev4 < 1 ? 1 : (lev4 > 3 && finite(e20) && e20 > 0) ? -1 : asset4 < -2 ? -1 : 0;
    } else s.institutional = null;
  }
  // valuation (mvrv)
  {
    const im = latestWithin(mvrv, t, FRESH.daily);
    if (im != null) {
      const p = pctAtDays(mvrv, im, 4 * 365);
      s.mvrvPct = p;
      s.valuation = finite(p) ? (p >= 95 ? -2 : p >= 82 ? -1 : 0) : null;
    } else { s.valuation = null; s.mvrvPct = null; }
  }
  // network security
  {
    const ih = latestWithin(h90S, t, FRESH.daily), id = latestWithin(d90S, t, FRESH.daily);
    const h90 = ih != null ? h90S[ih].v : null, d90 = id != null ? d90S[id].v : null;
    raw.h90 = h90; raw.d90 = d90;
    s.network = componentScore([customScore(h90, [[v => v > 12, 0], [v => v > -5, 0], [v => v > -15, -1], [() => true, -2]]), customScore(d90, [[v => v > 10, 0], [v => v > -5, 0], [v => v > -15, -1], [() => true, -2]])]);
  }
  // activity
  {
    const ia = latestWithin(addrChS, t, FRESH.daily), it = latestWithin(txChS, t, FRESH.daily), if_ = tfrChS.length ? latestWithin(tfrChS, t, FRESH.cm) : null;
    const pa = ia != null ? pctAt(addrChS, ia, 1460) : null, pt = it != null ? pctAt(txChS, it, 1460) : null, pf = if_ != null ? pctAt(tfrChS, if_, 1460) : null;
    raw.addrPct = pa; raw.txPct = pt;
    s.activity = componentScore([highGood(pa), highGood(pt), tfrChS.length && finite(pf) ? highGood(pf) : null]);
  }
  // miners
  {
    const ih = latestWithin(hpChS, t, FRESH.daily);
    raw.hpCh = ih != null ? hpChS[ih].v : null;
    s.miners = ih != null ? customScore(hpChS[ih].v, [[v => v > 15, 1], [v => v > -10, 0], [v => v > -30, -1], [() => true, -2]]) : null;
  }
  // trend
  {
    const ip = idxAtOrBefore(price, t);
    const i140 = latestWithin(ma140S, t, FRESH.daily), i200 = latestWithin(ma200S, t, FRESH.daily), i1400 = latestWithin(ma1400S, t, FRESH.daily);
    const pl = ip >= 0 && t - price[ip].t <= FRESH.daily ? price[ip].v : null;
    const ma140 = i140 != null ? ma140S[i140].v : null, ma200 = i200 != null ? ma200S[i200].v : null, ma1400 = i1400 != null ? ma1400S[i1400].v : null;
    raw.pVsMa200 = pl && ma200 ? pct(pl, ma200) : null; raw.pVsMa1400 = pl && ma1400 ? pct(pl, ma1400) : null;
    if (pl && ma200 && ma140) {
      s.trend = pl > ma200 && pl > ma140 ? 2 : (pl > ma200 || pl > ma140) ? 0 : (!ma1400 || pl > ma1400) ? -1 : -2;
    } else s.trend = null;
  }
  // realized vol
  {
    const ir = latestWithin(rv30S, t, FRESH.daily);
    if (ir != null) { const p = pctAt(rv30S, ir, 730); raw.rv30 = rv30S[ir].v; raw.rvPct = p; s.realized_vol = !finite(p) ? null : p >= 95 ? -2 : p >= 85 ? -1 : p <= 8 ? -1 : 1; }
    else s.realized_vol = null;
  }
  // options vol (dvol percentile component only; skew unavailable)
  {
    const iv = latestWithin(dvolS, t, FRESH.dvol);
    if (iv != null) { const p = pctAtDays(dvolS, iv, 2 * 365); raw.dvol = dvolS[iv].v; raw.dvolPct = p; s.volatility = !finite(p) ? null : componentScore([p >= 95 ? -2 : p >= 85 ? -1 : p <= 8 ? -1 : 1]); }
    else s.volatility = null;
  }
  // volume confirmation
  {
    const ivc = latestWithin(volChS, t, FRESH.daily), ip = idxAtOrBefore(price, t);
    const volCh = ivc != null ? volChS[ivc].v : null;
    const p30 = ip >= 0 ? pct(price[ip].v, priorByDays(price, 30, ip)?.v) : null;
    raw.p30 = p30; raw.volCh = volCh;
    if (finite(volCh) && finite(p30)) s.volume = p30 > 5 && volCh > 10 ? 1 : p30 < -5 && volCh > 15 ? -1 : 0;
    else s.volume = null;
  }
  // non-reconstructable
  s.us_spot = null; s.carry = null; s.oi = null; s.integrity = null; s.stablecoin_integrity = null;
  return s;
}

// ---- block/aggregate/regime replication ----
const BLOCKS = {
  macro: { strategicWeight: 30, tacticalWeight: 10 },
  demand: { strategicWeight: 40, tacticalWeight: 25 },
  cycle: { strategicWeight: 30, tacticalWeight: 10 },
  leverage: { strategicWeight: 0, tacticalWeight: 45 },
  market: { strategicWeight: 0, tacticalWeight: 10 },
};
const FAMS = {
  macro: { strategic: ["liquidity", "conditions", "stress"], tactical: ["liquidity", "conditions", "stress"] },
  demand: { strategic: ["etf", "stablecoins", "exchange_supply", "institutional"], tactical: ["etf", "stablecoins", "exchange_supply", "us_spot"] },
  cycle: { strategic: ["valuation", "network", "activity", "miners", "trend"], tactical: ["trend"] },
  leverage: { strategic: [], tactical: ["carry", "oi", "realized_vol", "volatility"] },
  market: { strategic: [], tactical: ["integrity", "volume", "stablecoin_integrity"] },
};
const CRITICAL_MIN = { macro: 0.60, demand: 0.60, cycle: 0.40, leverage: 0.25, market: 0.50 };

function blockStats(s, block, horizon) {
  const fams = FAMS[block][horizon];
  const avail = fams.filter(f => finite(s[f]));
  return { score: avail.length ? mean(avail.map(f => s[f])) / 2 * 100 : null, coverage: fams.length ? avail.length / fams.length : 1 };
}
function band(score) { return score == null ? "unknown" : score >= 20 ? "supportive" : score <= -20 ? "adverse" : "neutral"; }

function computeAt(t, { relaxEtfGate = false } = {}) {
  const s = familyScoresAt(t);
  const blocks = {};
  for (const b of Object.keys(BLOCKS)) blocks[b] = { strategic: blockStats(s, b, "strategic"), tactical: blockStats(s, b, "tactical") };
  let sRaw = 0, sw = 0, tRaw = 0, tw = 0;
  for (const [k, b] of Object.entries(blocks)) {
    const W = BLOCKS[k];
    if (b.strategic.score != null && W.strategicWeight) { const w = W.strategicWeight * b.strategic.coverage; sRaw += b.strategic.score * w; sw += w; }
    if (b.tactical.score != null && W.tacticalWeight) { const w = W.tacticalWeight * b.tactical.coverage; tRaw += b.tactical.score * w; tw += w; }
  }
  const strategicScore = sw > 0 ? sRaw / 100 : null, tacticalScore = tw > 0 ? tRaw / 100 : null;
  // gate tree
  const present = f => finite(s[f]);
  const requiredGroups = [["liquidity"], ["conditions"], ["etf"], ["stablecoins", "exchange_supply"], ["trend"], ["network"]];
  const groups = relaxEtfGate ? requiredGroups.filter(g => g[0] !== "etf") : requiredGroups;
  const missing = groups.filter(g => !g.some(present));
  const criticalStrategic = ["macro", "demand", "cycle"].every(k => blocks[k].strategic.coverage >= CRITICAL_MIN[k] || (relaxEtfGate && k === "demand" && blocks[k].strategic.coverage >= 0.4)) && !missing.length;
  const M = band(blocks.macro.strategic.score), D = band(blocks.demand.strategic.score), C = band(blocks.cycle.strategic.score);
  let strategic = "transition";
  if (!criticalStrategic) strategic = "insufficient";
  else if ((D === "adverse" && C === "adverse") || (M === "adverse" && D === "adverse")) strategic = "defensive";
  else if ([M, D, C].filter(x => x === "adverse").length >= 1) strategic = "deteriorating";
  else if (D === "supportive" && C === "supportive" && M !== "adverse") strategic = "constructive";
  else if (D === "supportive" && M === "supportive") strategic = "constructive";
  else if (M === "supportive" && C === "supportive" && D === "neutral") strategic = "unconfirmed_positive";
  const valuationAvailable = present("valuation");
  if ((!valuationAvailable || (finite(s.valuation) && s.valuation <= -1)) && ["constructive", "unconfirmed_positive"].includes(strategic)) strategic = "transition";
  // detectors (reconstructable subset)
  const le = (f, x) => finite(s[f]) && s[f] <= x, ge = (f, x) => finite(s[f]) && s[f] >= x;
  const demandHits = [le("etf", -1), le("stablecoins", -1), le("exchange_supply", -1)].filter(Boolean).length;
  const macroHits = [le("liquidity", -1), le("conditions", -1), le("stress", -1)].filter(Boolean).length;
  const distAnchor = le("valuation", -1), distSupport = [le("exchange_supply", -1), le("trend", -1)].filter(Boolean).length;
  const recAnchor = finite(s.mvrvPct) && s.mvrvPct < 25, recSupport = [ge("trend", 0), ge("etf", 0), ge("exchange_supply", 0)].filter(Boolean).length;
  const detectors = {
    demand_break: demandHits >= 3 ? "fired" : demandHits >= 2 ? "watch" : "calm",
    macro_shock: macroHits >= 3 ? "fired" : macroHits >= 2 ? "watch" : "calm",
    distribution: !distAnchor ? "calm" : distSupport >= 2 ? "fired" : distSupport >= 1 ? "watch" : "calm",
    recovery: !recAnchor ? "calm" : recSupport >= 2 ? "good" : recSupport >= 1 ? "watch" : "calm",
  };
  return { t, families: s, blocks, strategicScore, tacticalScore, bands: { M, D, C }, strategic, detectors, missing: missing.map(g => g.join("|")) };
}

// ---- run over evaluation grid ----
const startT = Date.UTC(2012, 0, 1);
const evalDates = price.filter(p => p.t >= startT).map(p => p.t);
const rows = [];
for (const t of evalDates) {
  const strict = computeAt(t);
  const relaxed = computeAt(t, { relaxEtfGate: true });
  // Era view: families that did not yet EXIST as products are excluded from expected coverage,
  // reconstructing "the panel as it could have been built in that era".
  const eraDemand = ["exchange_supply"];
  if (t >= Date.UTC(2018, 5, 1)) eraDemand.push("institutional");
  if (t >= Date.UTC(2019, 8, 1)) eraDemand.push("stablecoins");
  if (t >= Date.UTC(2024, 2, 1)) eraDemand.push("etf");
  const s_ = strict.families;
  const demandCovEra = eraDemand.filter(f => finite(s_[f])).length / eraDemand.length;
  const macroCov = strict.blocks.macro.strategic.coverage, cycleCov = strict.blocks.cycle.strategic.coverage;
  const reqOk = [["liquidity"], ["conditions"], ["stablecoins", "exchange_supply"], ["trend"], ["network"], ...(eraDemand.includes("etf") ? [["etf"]] : [])]
    .every(g => g.some(f => finite(s_[f])));
  const insufficientEra = !(macroCov >= 0.6 && demandCovEra >= 0.5 && cycleCov >= 0.4 && reqOk);
  const { _raw, ...famOnly } = strict.families;
  rows.push({
    date: dayKey(t), t, price: price[idxAtOrBefore(price, t)].v,
    families: famOnly, raw: _raw,
    blockS: Object.fromEntries(Object.entries(strict.blocks).map(([k, b]) => [k, b.strategic.score])),
    blockT: Object.fromEntries(Object.entries(strict.blocks).map(([k, b]) => [k, b.tactical.score])),
    covS: Object.fromEntries(Object.entries(strict.blocks).map(([k, b]) => [k, b.strategic.coverage])),
    strategicScore: strict.strategicScore, tacticalScore: strict.tacticalScore,
    bands: strict.bands, regimeStrict: strict.strategic, regimeRelaxed: relaxed.strategic,
    insufficientEra, demandCovEra,
    detectors: strict.detectors,
  });
}
writeFileSync(`${OUT}timeline.json`, JSON.stringify(rows));
console.log(`timeline: ${rows.length} days, ${rows[0].date} .. ${last(rows).date}`);
const regimeCounts = {};
for (const r of rows) regimeCounts[r.regimeRelaxed] = (regimeCounts[r.regimeRelaxed] || 0) + 1;
console.log("relaxed regime counts:", JSON.stringify(regimeCounts));
const strictCounts = {};
for (const r of rows) strictCounts[r.regimeStrict] = (strictCounts[r.regimeStrict] || 0) + 1;
console.log("strict regime counts:", JSON.stringify(strictCounts));
