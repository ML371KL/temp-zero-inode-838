// Общие части сверок потока «варианты» на реальных данных аудита 10.10.2026: лента опубликованных
// снимков, сырьё первоисточников и учёт NAV по правилам форвард-монитора. В `npm run check` не входит:
// лента и сырьё лежат вне репозитория (папка аудита), путь к ней — `--audit <dir>` или AUDIT_DIR.
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";

export const DAY = 86_400_000, HOUR = 3_600_000;
// Старт форвард-монитора после графта 21.07.2026 — с него считал и аудит.
export const MONITOR_START = Date.parse("2026-07-19T06:30:22.915Z");
// Доходность кэша за окно аудита: +0,892 % за 83,14 суток по FRED DTB3.
export const CASH_ANNUAL = 0.0398;
export const COST_PER_TURNOVER = MODEL_POLICY_V1.forward_monitoring.transaction_cost_bps_per_full_turnover / 10_000;

export function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
export const flag = name => process.argv.includes(name);
// По умолчанию — раскладка аудита: клон лежит в <audit>/impl/<клон>.
export function auditDir() {
  const dir = arg("--audit", process.env.AUDIT_DIR || fileURLToPath(new URL("../../../", import.meta.url)));
  if (!existsSync(join(dir, "work", "ticks.jsonl"))) {
    console.error(`Не найдена лента снимков ${join(dir, "work", "ticks.jsonl")}. Укажите папку аудита: --audit <dir> или AUDIT_DIR.`);
    process.exit(2);
  }
  return dir;
}

// Лента: по строке JSON на опубликованный снимок (формат — work/extract-ticks.mjs). Поле sources в ней пустое.
export async function readTicks(path) {
  const all = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line) continue;
    let tick;
    try { tick = JSON.parse(line); } catch { continue; }
    if (tick.error || !tick.t || tick.mock) continue;
    all.push(tick);
  }
  return all.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

// Входы движка вариантов из снимка ленты — в той форме, в какой их строит сборщик (SPEC 1.4).
export function inputsFromTick(tick, series = {}) {
  const detector = id => tick.detectors?.[id]?.[0] ?? null, metric = id => tick.metrics?.[id] ?? [];
  const families = block => ({ ...(tick.blocks?.[block]?.sf || {}) });
  const criticalOk = ["macro", "demand", "cycle"].every(block => (tick.blocks?.[block]?.sc ?? 0) >= MODEL_POLICY_V1.critical_min[block]) && !(tick.scores?.critical_missing?.strategic || []).length;
  return {
    price: tick.price,
    hard_override: !!tick.override,
    v1: {
      state: tick.regime?.strategic ?? null,
      candidate: tick.regime_meta?.strategic?.candidate ?? tick.regime?.strategic ?? null,
      critical_ok: criticalOk,
      target_pct: tick.decision?.target ?? null,
      recovery_state: detector("recovery"), macro_shock_state: detector("macro_shock"), distribution_state: detector("distribution"),
      mvrv_percentile: metric("mvrv_cycle")[1] ?? null, valuation_score: metric("mvrv_cycle")[0] ?? null,
    },
    families: { macro: families("macro"), demand: families("demand"), cycle: families("cycle") },
    series,
    observed_at: { mvrv: metric("mvrv_cycle")[3] ?? null, coinmetrics: metric("exchange_supply")[3] ?? null, etf: metric("etf_regime")[3] ?? null, network: metric("network_security")[3] ?? null, market: metric("trend_regime")[3] ?? null },
  };
}

// Учёт по правилам монитора: цель предыдущего снимка зарабатывает до следующего, оборот стоит
// 10 б.п., остаток лежит в кэше; цель null — держать прежнюю.
export class NavBook {
  constructor() { Object.assign(this, { nav: 1, weight: null, peak: 1, maxDrawdown: 0, turnover: 0, changes: 0, exposureTime: 0, time: 0, lastT: null, lastPrice: null, log: [], weights: [] }); }
  step(now, price, targetPct) {
    if (this.weight !== null && this.lastT !== null) {
      const years = (now - this.lastT) / DAY / 365;
      this.nav *= 1 + this.weight * (price / this.lastPrice - 1) + (1 - this.weight) * CASH_ANNUAL * years;
      this.exposureTime += this.weight * years;
      this.time += years;
    }
    if (targetPct !== null && targetPct !== undefined && Number.isFinite(targetPct)) {
      const weight = targetPct / 100;
      if (this.weight === null) { this.nav *= 1 - COST_PER_TURNOVER * weight; this.turnover += weight; this.weight = weight; }
      else if (Math.abs(weight - this.weight) > 1e-9) {
        this.nav *= 1 - COST_PER_TURNOVER * Math.abs(weight - this.weight);
        this.turnover += Math.abs(weight - this.weight);
        this.changes++;
        this.log.push({ t: new Date(now).toISOString(), from: Math.round(this.weight * 100), to: targetPct, price: Math.round(price) });
        this.weight = weight;
      }
    }
    this.peak = Math.max(this.peak, this.nav);
    this.maxDrawdown = Math.min(this.maxDrawdown, this.nav / this.peak - 1);
    this.lastT = now;
    this.lastPrice = price;
    this.weights.push(this.weight); // доля, с которой линия идёт до следующего снимка
  }
  get avgShare() { return this.time > 0 ? this.exposureTime / this.time : null; }
  summary() {
    return {
      return_pct: +((this.nav - 1) * 100).toFixed(2), max_drawdown_pct: +(this.maxDrawdown * 100).toFixed(2), turnover_pct: Math.round(this.turnover * 100),
      target_changes: this.changes, avg_share_pct: this.time > 0 ? +(this.exposureTime / this.time * 100).toFixed(1) : null, nav: +this.nav.toFixed(6),
    };
  }
}
export const changeLine = log => log.map(x => `${x.t.slice(5, 16)} ${x.from}→${x.to} @${x.price}`).join(" | ");
// Где две линии шли с разной долей и что это стоило: отрезки расхождения и вклад в разность дохода, п.п.
// (доля × ход BTC на отрезке; кэш и издержки в разбор не входят — это десятые доли пункта).
export function divergenceSegments(ticks, a, b, minAbsPp = 0.15) {
  const segments = [];
  let open = null;
  for (let i = 0; i + 1 < ticks.length; i++) {
    const wa = a.weights[i] ?? 0, wb = b.weights[i] ?? 0;
    if (Math.abs(wa - wb) < 1e-9) { if (open) { segments.push(open); open = null; } continue; }
    const move = ticks[i + 1].price / ticks[i].price - 1;
    if (!open || open.a !== Math.round(wa * 100) || open.b !== Math.round(wb * 100)) { if (open) segments.push(open); open = { from: ticks[i].t, to: ticks[i + 1].t, a: Math.round(wa * 100), b: Math.round(wb * 100), price_from: Math.round(ticks[i].price), price_to: Math.round(ticks[i + 1].price), pp: 0 }; }
    open.to = ticks[i + 1].t; open.price_to = Math.round(ticks[i + 1].price); open.pp += (wa - wb) * move * 100;
  }
  if (open) segments.push(open);
  const total = segments.reduce((s, x) => s + x.pp, 0);
  return { total_pp: +total.toFixed(2), segments: segments.filter(x => Math.abs(x.pp) >= minAbsPp).map(x => ({ ...x, pp: +x.pp.toFixed(2), btc_pct: +((x.price_to / x.price_from - 1) * 100).toFixed(1) })) };
}

// Сырьё первоисточников на 10.10.2026 (work/recompute/data) в форме рядов {t,v}.
export function loadRawSeries(dir) {
  const raw = join(dir, "work", "recompute", "data"), json = rel => JSON.parse(readFileSync(join(raw, rel), "utf8"));
  const cmRows = name => (json(name).data || []).map(r => ({ ...r, t: Date.parse(String(r.time).slice(0, 10) + "T00:00:00Z") })).filter(r => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  const pick = (rows, key) => rows.filter(r => r[key] !== undefined && r[key] !== null && r[key] !== "" && Number.isFinite(Number(r[key]))).map(r => ({ t: r.t, v: Number(r[key]) }));
  const cm = cmRows("coinmetrics/asset-metrics.json"), cmFull = cmRows("coinmetrics/asset-metrics-full-control.json");
  const mempool = json("mempool/hashrate-3y.json");
  // Свечи Coinbase: [время, low, high, open, close, volume], метка — начало суток UTC.
  const candles = new Map();
  for (const file of readdirSync(join(raw, "coinbase")).filter(f => /^btc-usd-daily-\d+\.json$/.test(f)).sort())
    for (const c of json(`coinbase/${file}`)) if (Number.isFinite(Number(c?.[0])) && Number.isFinite(Number(c?.[4]))) candles.set(Number(c[0]) * 1000, Number(c[4]));
  return {
    exchange_supply: pick(cm, "SplyExNtv"), flow_in: pick(cm, "FlowInExNtv"), flow_out: pick(cm, "FlowOutExNtv"),
    mvrv: pick(cm, "CapMVRVCur"), mvrv_deep: pick(cmFull, "CapMVRVCur"),
    hashrate: (mempool.hashrates || []).map(x => ({ t: Number(x.timestamp) * 1000, v: Number(x.avgHashrate) })).filter(p => p.v > 0).sort((a, b) => a.t - b.t),
    difficulty: (mempool.difficulty || []).map(x => ({ t: Number(x.time) * 1000, v: Number(x.difficulty) })).filter(p => p.v > 0).sort((a, b) => a.t - b.t),
    price_daily: [...candles].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t),
  };
}
// Срез ряда «как было известно»: точки не позже отметки наблюдения. Кэш по отметке — отметок за окно десятки.
export function vintageSlicer(series) {
  const cache = new Map();
  return cutoff => {
    if (!Number.isFinite(cutoff)) return [];
    if (!cache.has(cutoff)) { let n = series.length; while (n > 0 && series[n - 1].t > cutoff) n--; cache.set(cutoff, series.slice(0, n)); }
    return cache.get(cutoff);
  };
}
export const pad = (v, n) => String(v).padStart(n);
