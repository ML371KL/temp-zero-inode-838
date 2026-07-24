#!/usr/bin/env node
// Telegram-уведомления об изменениях панели.
//
// ЖИВЁТ СНАРУЖИ РЕШАЮЩЕГО КОНТУРА: читает уже опубликованное состояние (снимок или живую
// страницу) и ничего не пишет ни в снимок, ни в решение, ни в состояние сборщика. Отказ
// уведомлений не должен и не может повлиять на вердикт.
//
// Один и тот же файл лежит в ОБОИХ репозиториях побайтово одинаковым — панель определяется
// по форме данных, а не по правкам в коде. Правишь здесь — копируешь во второй репозиторий.
//
// Режимы источника (NOTIFY_SOURCE):
//   json  — docs/snapshot.json уже содержит посчитанные карточки (BTC-панель);
//   page  — карточки считаются в браузере, снимаем headless-прогоном (макро-панель);
//   auto  — по наличию metrics[] в снимке (по умолчанию).
//
// Переменные окружения:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — обязательны для отправки (без них — только dry-run);
//   NOTIFY_DRY_RUN=1        — печатать сообщения в stdout, ничего не отправлять;
//   NOTIFY_STATE=<путь>     — файл состояния «что уже отправлено» (по умолчанию .notify/state.json);
//   NOTIFY_SNAPSHOT=<путь>  — снимок для режима json (по умолчанию docs/snapshot.json);
//   NOTIFY_PAGE=<url>       — страница для режима page;
//   OPENROUTER_KEY          — ключ для комментариев LLM; без него комментарий берётся из шаблона;
//   NOTIFY_MODEL            — модель комментатора (по умолчанию бесплатная nemotron);
//   NOTIFY_MAX=<n>          — предохранитель: больше n событий за прогон → отправляется сводка.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const DRY = process.env.NOTIFY_DRY_RUN === "1" || !process.env.TELEGRAM_BOT_TOKEN;
const STATE_PATH = process.env.NOTIFY_STATE || ".notify/state.json";
const SNAPSHOT_PATH = process.env.NOTIFY_SNAPSHOT || "docs/snapshot.json";
const PAGE_URL = process.env.NOTIFY_PAGE || "";
const MAX_EVENTS = Number(process.env.NOTIFY_MAX || 40);
const SEND_GAP_MS = Number(process.env.NOTIFY_GAP_MS || 3500); // Telegram: ~20 сообщений/мин в чат
// Комментатор обязан быть БЕСПЛАТНЫМ. Модель по умолчанию — та же, что уже судит новости на
// макро-панели. Переопределить её можно (vars.NOTIFY_MODEL), но платный вариант требует явного
// NOTIFY_ALLOW_PAID=1: иначе одна опечатка в переменной начала бы тихо жечь деньги на каждом
// прогоне, а прогонов до сотни в сутки.
const FREE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const resolveModel = () => (process.env.NOTIFY_MODEL || "").trim() || FREE_MODEL;
const paidAllowed = () => process.env.NOTIFY_ALLOW_PAID === "1";
const LLM_TIMEOUT_MS = Number(process.env.NOTIFY_LLM_TIMEOUT_MS || 90000);

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ 1. КАЛЕНДАРЬ ПЕРВОИСТОЧНИКОВ ============================
   scheduled — у показателя есть КАЛЕНДАРЬ публикации: сдвиг даты наблюдения = новый релиз,
               о нём сообщаем (если значение при этом изменилось).
   revisable — первоисточник пересматривает УЖЕ опубликованные значения: смена значения при
               той же дате наблюдения = ревизия, о ней сообщаем отдельно.
   Ни то, ни другое не ставится рыночным котировкам: у них «значение изменилось» — не событие,
   они меняются непрерывно. Для них остаётся только смена зоны/балла (и вердикт/детекторы).  */
const MACRO_CADENCE = {
  // водопровод и Казначейство
  sofr_iorb: { scheduled: true, revisable: true, release: "NY Fed · SOFR", cadence: "каждый рабочий день" },
  netliq: { scheduled: true, revisable: true, release: "ФРС H.4.1", cadence: "четверг" },
  reserves: { scheduled: true, revisable: true, release: "ФРС H.4.1", cadence: "четверг" },
  tga: { scheduled: true, revisable: true, release: "Treasury DTS", cadence: "каждый рабочий день, T+1" },
  rrp: { scheduled: true, revisable: true, release: "NY Fed", cadence: "каждый рабочий день" },
  nfci: { scheduled: true, revisable: true, release: "ФРБ Чикаго", cadence: "среда" },
  srf: { scheduled: true, revisable: true, release: "NY Fed", cadence: "по факту операций" },
  ratevol: { scheduled: true, revisable: false, release: "ФРС H.15", cadence: "каждый рабочий день" },
  // кредит
  hy: { scheduled: true, revisable: false, release: "ICE BofA", cadence: "каждый рабочий день" },
  hy_mom: { scheduled: true, revisable: false, release: "ICE BofA", cadence: "каждый рабочий день" },
  ig: { scheduled: true, revisable: false, release: "ICE BofA", cadence: "каждый рабочий день" },
  sloos: { scheduled: true, revisable: true, release: "SLOOS", cadence: "ежеквартально" },
  bizd: { scheduled: false, revisable: false, release: "котировка", cadence: "внутридневная" },
  // рынок
  spx: { scheduled: true, revisable: false, release: "закрытие рынка США", cadence: "торговый день" },
  spx_mom: { scheduled: true, revisable: false, release: "закрытие рынка США", cadence: "торговый день" },
  vix: { scheduled: true, revisable: false, release: "CBOE", cadence: "закрытие торгового дня" },
  vixterm: { scheduled: true, revisable: false, release: "CBOE", cadence: "закрытие торгового дня" },
  breadth: { scheduled: false, revisable: false, release: "котировки", cadence: "внутридневные" },
  // макро-цикл
  payrolls: { scheduled: true, revisable: true, release: "BLS Employment Situation", cadence: "ежемесячно" },
  sahm: { scheduled: true, revisable: true, release: "BLS Employment Situation", cadence: "ежемесячно" },
  claims: { scheduled: true, revisable: true, release: "DOL", cadence: "четверг" },
  curve: { scheduled: true, revisable: false, release: "ФРС H.15", cadence: "каждый рабочий день" },
  real10: { scheduled: true, revisable: false, release: "ФРС H.15", cadence: "каждый рабочий день" },
  // режимы
  jpy: { scheduled: true, revisable: false, release: "фиксинг ЕЦБ", cadence: "рабочий день" },
  goldreal: { scheduled: true, revisable: false, release: "дневная точка", cadence: "рынок 24/7" },
  btc: { scheduled: true, revisable: false, release: "дневная точка", cadence: "рынок 24/7" },
  stagf: { scheduled: true, revisable: false, release: "ФРС H.15", cadence: "каждый рабочий день" },
  oil: { scheduled: true, revisable: false, release: "EIA", cadence: "рабочие дни" },
  cny: { scheduled: true, revisable: false, release: "фиксинг ЕЦБ", cadence: "рабочий день" },
  dxy: { scheduled: true, revisable: false, release: "ФРС H.10", cadence: "пакет по понедельникам" },
};

// BTC-панель: карточка считается непрерывной, если её наблюдение моложе этого возраста —
// это живой рыночный фид (споты, деривативы, пеги, комиссии мемпула), у него нет релизов.
const LIVE_FEED_MAX_AGE_MS = 6 * 3600 * 1000;

/* ================================ 2. ЧТЕНИЕ СОСТОЯНИЯ ================================ */

async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Приводит снимок BTC-панели к общей форме. Ничего не пересчитывает: только проекция.
function fromSnapshotJSON(snap) {
  const generatedAt = Date.parse(snap.generated_at || "") || Date.now();
  const indicators = (snap.metrics || []).map((m) => {
    const obs = Date.parse(m.observed_at || "");
    const live = finite(obs) ? generatedAt - obs < LIVE_FEED_MAX_AGE_MS : false;
    return {
      id: m.id,
      name: m.name,
      value: m.value,
      value_num: finite(m.value_num) ? m.value_num : null,
      unit: m.unit || "",
      delta: m.delta || "",
      zone: null, // у BTC-панели зон нет — роль зоны играет балл семьи
      score: finite(m.score) ? m.score : null,
      observed_at: finite(obs) ? new Date(obs).toISOString().slice(0, 10) : "",
      source: m.source || "",
      note: m.note || "",
      voting: m.vote === true,
      scheduled: !live,
      revisable: false, // ревизии BTC-панель детектирует сама, ниже
      release: live ? "живой рыночный фид" : m.source || "",
    };
  });
  const detectors = (snap.detectors || []).map((d) => ({
    id: d.id,
    name: d.name,
    state: d.state,
    inputs: d.inputs || "",
    note: d.logic || d.note || "",
  }));
  const revisions = (snap.source_revision_alerts || []).map((r) => ({
    key: `${r.source || r.key || "источник"}:${r.observed_at || ""}:${String(r.previous_data_sha256 || "").slice(0, 8)}`,
    text:
      r.message ||
      [
        `источник «${r.source || r.key}» переписал уже отданные данные`,
        r.observed_at ? `наблюдение ${String(r.observed_at).slice(0, 10)}` : "",
        finite(r.changed_rows) ? `изменено строк: ${r.changed_rows}` : "",
        finite(r.added_rows) && r.added_rows ? `добавлено: ${r.added_rows}` : "",
        finite(r.removed_rows) && r.removed_rows ? `удалено: ${r.removed_rows}` : "",
      ].filter(Boolean).join(" · "),
  }));
  return {
    generated_at: snap.generated_at || "",
    verdict: {
      word: typeof snap.verdict === "string" ? snap.verdict : String(snap.verdict?.word || snap.verdict?.label || ""),
      score: snap.scores?.strategic ?? snap.scores?.total ?? null,
      extra: [
        snap.regime?.strategic ? `режим ${snap.regime.strategic}` : "",
        finite(snap.scores?.strategic) ? `балл ${snap.scores.strategic.toFixed(1)}` : "",
      ].filter(Boolean).join(" · "),
    },
    target: finite(snap.decision?.target_pct)
      ? { pct: snap.decision.target_pct, reason: (snap.decision.reason_codes || []).join(", ") }
      : null,
    indicators,
    detectors,
    revisions,
  };
}

// Проекция, вычисляемая ВНУТРИ страницы макро-панели. Никакой логики скоринга здесь нет —
// только чтение уже посчитанных страницей значений (IND + state.data + DETECTORS).
// ВАЖНО: реестр объявлен через `const` на верхнем уровне классического скрипта, поэтому
// живёт в лексической области, а НЕ свойством window — обращаться можно только по голому
// имени. `window.IND` здесь всегда undefined, на этом уже потерян один прогон.
const PAGE_EXTRACTOR = `(() => {
  const out = { generated_at: new Date().toISOString(), indicators: [], detectors: [], revisions: [] };
  const g = (id) => (document.getElementById(id) || {}).textContent || "";
  out.verdict = { word: g("vWord").trim(), score: g("vScore").trim(),
    extra: [g("vLead").trim() && ("опережающие " + g("vLead").trim()),
            g("vCoin").trim() && ("подтверждающие " + g("vCoin").trim()),
            g("vDet").trim() && ("детекторы " + g("vDet").trim())].filter(Boolean).join(" · ") };
  for (const i of IND) {
    const r = (state.data || {})[i.id];
    if (!r || r.zi == null) continue;
    const z = i.zones[r.zi] || {};
    out.indicators.push({ id: i.id, name: i.name, value: String(r.value ?? ""),
      value_num: (typeof r.value === "number" ? r.value : null), unit: i.unit || "",
      delta: r.delta || "", zone: z.l || "", score: (i.info ? null : (typeof z.s === "number" ? z.s : null)),
      observed_at: r.date ? new Date(r.date).toISOString().slice(0, 10) : "",
      source: (i.link || "").replace(/^https?:\\/\\//, "").split("/")[0], note: r.note || "",
      degraded: !!r.degraded,
      voting: !i.info, lead: !!i.lead });
  }
  for (const d of DETECTORS) {
    const l = d.last || {};
    out.detectors.push({ id: d.id, name: d.name, state: l.st || "calm", inputs: l.inputs || "", note: d.logic || "" });
  }
  return out;
})()`;

async function fromLivePage(url) {
  const puppeteer = await import("puppeteer-core");
  const executablePath =
    process.env.CHROME_PATH ||
    (process.platform === "win32"
      ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
      : "/usr/bin/google-chrome");
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    // Страница грузит источники асинхронно и ставит settled=true на ФИНАЛЬНОМ compute цикла.
    // Снимать раньше — значит ловить переходное состояние с недогруженными детекторами.
    await page.waitForFunction(
      `(() => { try { return state.settled === true && IND.length > 0; } catch (e) { return false; } })()`,
      { timeout: 180000, polling: 500 }
    );
    const raw = await page.evaluate(PAGE_EXTRACTOR);
    if (errors.length) console.error("page errors:", errors.slice(0, 3).join(" | "));
    const indicators = raw.indicators.map((i) => {
      const c = MACRO_CADENCE[i.id] || { scheduled: true, revisable: false, release: "", cadence: "" };
      return { ...i, scheduled: c.scheduled, revisable: c.revisable, release: c.release, cadence: c.cadence || "" };
    });
    return { ...raw, indicators };
  } finally {
    await browser.close();
  }
}

async function readPanel() {
  const mode = process.env.NOTIFY_SOURCE || "auto";
  if (mode === "page" || (mode === "auto" && PAGE_URL && !process.env.NOTIFY_SNAPSHOT)) {
    if (!PAGE_URL) throw new Error("NOTIFY_PAGE не задан для режима page");
    return fromLivePage(PAGE_URL);
  }
  const snap = await readJSON(SNAPSHOT_PATH);
  if (!snap) throw new Error(`снимок не читается: ${SNAPSHOT_PATH}`);
  if (Array.isArray(snap.metrics)) return fromSnapshotJSON(snap);
  if (PAGE_URL) return fromLivePage(PAGE_URL);
  throw new Error("снимок без metrics[] и без NOTIFY_PAGE — источник не определён");
}

/* ==================================== 3. СОБЫТИЯ ==================================== */

const KIND = {
  target: { emoji: "🎯", label: "целевая доля капитала" },
  verdict: { emoji: "⚖️", label: "вердикт" },
  detector: { emoji: "🔔", label: "детектор" },
  zone: { emoji: "🚦", label: "смена зоны" },
  release: { emoji: "📊", label: "новые данные" },
  revision: { emoji: "♻️", label: "ревизия" },
};

// Порядок важен: сначала то, что меняет вывод, потом то, что его питает.
const KIND_ORDER = ["target", "verdict", "detector", "zone", "release", "revision"];

const DET_LABEL = { calm: "спокоен", watch: "наблюдение", fired: "СРАБОТАЛ", good: "подтверждён" };

// Строки источников в снимках писались в разное время и в разном регистре; в сообщении
// пользователю нужен человеческий вид, а не внутренний ключ датасета.
const SOURCE_LABEL = {
  fred: "FRED",
  coinmetrics: "Coin Metrics",
  defillama: "DefiLlama",
  deribit: "Deribit",
  mempool: "mempool.space",
  fiscaldata: "Treasury FiscalData",
  cftc: "CFTC",
  "bitcoin-data.com": "bitcoin-data.com",
};
const sourceLabel = (s) => SOURCE_LABEL[String(s || "").trim().toLowerCase()] || String(s || "источник");

function sameNum(a, b) {
  if (a == null || b == null) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= scale * 1e-9;
}

function valueChanged(prev, cur) {
  if (prev.value_num != null && cur.value_num != null) return !sameNum(prev.value_num, cur.value_num);
  return String(prev.value) !== String(cur.value);
}

function diff(prevState, panel) {
  const events = [];
  const releaseGroups = [];
  const prevInd = prevState.indicators || {};

  if (prevState.target && panel.target && !sameNum(prevState.target.pct, panel.target.pct)) {
    events.push({
      kind: "target",
      key: "target",
      title: "Целевая доля BTC от лимита",
      before: `${prevState.target.pct}%`,
      after: `${panel.target.pct}%`,
      detail: [panel.verdict?.word || "", panel.target.reason].filter(Boolean).join(" · "),
      note: "",
    });
  }

  if (prevState.verdict && panel.verdict?.word && prevState.verdict.word !== panel.verdict.word) {
    events.push({
      kind: "verdict",
      key: "verdict",
      title: "Вердикт панели",
      before: prevState.verdict.word,
      after: panel.verdict.word,
      detail: panel.verdict.extra || "",
      note: "",
    });
  }

  const prevDet = prevState.detectors || {};
  for (const d of panel.detectors || []) {
    const was = prevDet[d.id];
    if (was && was.state !== d.state) {
      events.push({
        kind: "detector",
        key: `det:${d.id}`,
        title: d.name,
        before: DET_LABEL[was.state] || was.state,
        after: DET_LABEL[d.state] || d.state,
        // живые входы детектора; полная логика уходит только в контекст LLM, иначе сообщение
        // превращается в простыню на пол-экрана телефона
        detail: String(d.inputs || "").length > 300 ? String(d.inputs).slice(0, 297) + "…" : d.inputs || "",
        note: d.note || "",
      });
    }
  }

  for (const i of panel.indicators || []) {
    const was = prevInd[i.id];
    if (!was) continue; // первый прогон только фиксирует базу, не шлёт историю целиком
    // Карточка на встроенной оценке вместо живого источника: её значение говорит о доступности
    // источника, а не о рынке. Сообщать об этом — значит слать шум при каждом сбое сети раннера
    // (FRED и Stooq режут раннеры GitHub, у страницы на них штатные резервы).
    if (i.degraded || was.degraded) continue;

    const zoneChanged =
      (i.zone != null && was.zone != null && i.zone !== was.zone) ||
      (i.score != null && was.score != null && !sameNum(i.score, was.score));
    const dateAdvanced = i.observed_at && was.observed_at && i.observed_at > was.observed_at;
    const changed = valueChanged(was, i);

    if (zoneChanged) {
      events.push({
        kind: "zone",
        key: `zone:${i.id}`,
        title: i.name,
        before: fmtLevel(was),
        after: fmtLevel(i),
        detail: valueLine(was, i),
        indicator: i,
        beforeScore: was.score,
        afterScore: i.score,
        note: i.note,
      });
    }
    // Релиз: вышли новые данные И значение действительно изменилось. Совпало со сменой зоны —
    // не дублируем: сообщение о зоне уже несёт и старое, и новое значение.
    // Одна публикация первоисточника обычно двигает несколько карточек (H.15 — сразу пять,
    // ETF — четыре), поэтому релизы собираются в ОДНО сообщение на публикацию, а не на карточку.
    if (i.scheduled && dateAdvanced && changed && !zoneChanged) {
      releaseGroups.push({ i, was });
    }
    // Ревизия: дата наблюдения та же, а значение переписали.
    if (i.revisable && i.observed_at && i.observed_at === was.observed_at && changed && !zoneChanged) {
      events.push({
        kind: "revision",
        key: `rev:${i.id}`,
        title: i.name,
        before: fmtValue(was),
        after: fmtValue(i),
        detail: `первоисточник пересмотрел значение за ${i.observed_at}`,
        indicator: i,
        note: i.note,
      });
    }
  }

  // Сборка релизов: ключ группы — публикация первоисточника (кто и на какую дату наблюдения).
  const groups = new Map();
  for (const { i, was } of releaseGroups) {
    const key = `${String(i.release || i.source || "источник").toLowerCase()}|${i.observed_at}`;
    if (!groups.has(key))
      groups.set(key, { release: i.release || i.source || "источник", cadence: i.cadence || "", observed_at: i.observed_at, moves: [], notes: [] });
    const g = groups.get(key);
    g.moves.push({ name: i.name, before: fmtValue(was), after: fmtValue(i), delta: i.delta || "" });
    if (i.note) g.notes.push(`${i.name}: ${i.note}`);
  }
  for (const [key, g] of groups) {
    events.push({
      kind: "release",
      key: `rel:${key}`,
      title: `Новые данные · ${sourceLabel(g.release)}`,
      before: "",
      after: "",
      detail: [g.observed_at ? `наблюдение ${g.observed_at}` : "", g.cadence].filter(Boolean).join(" · "),
      moves: g.moves,
      note: g.notes.join("\n").slice(0, 1200),
    });
  }

  // Ревизии, которые панель детектирует сама (BTC-панель ведёт их список).
  const seenRev = new Set((prevState.revisions || []).map((r) => r.key + "|" + r.text));
  for (const r of panel.revisions || []) {
    if (seenRev.has(r.key + "|" + r.text)) continue;
    events.push({
      kind: "revision",
      key: `rev-src:${r.key}`,
      title: `Ревизия источника: ${r.key}`,
      before: "",
      after: "",
      detail: r.text,
      note: "",
    });
  }

  events.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return events;
}

/* ================================= 4. ТЕКСТ СООБЩЕНИЙ ================================= */

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtValue(i) {
  const v = String(i.value ?? "").trim();
  return i.unit && !v.includes(i.unit) ? `${v} ${i.unit}` : v;
}

function fmtScore(s) {
  if (s == null) return "—";
  return (s > 0 ? "+" : "") + String(s);
}

function fmtLevel(i) {
  const zone = i.zone ? `«${i.zone}»` : "";
  const score = i.score != null ? `балл ${fmtScore(i.score)}` : "";
  return [zone, score].filter(Boolean).join(", ") || fmtValue(i);
}

function valueLine(was, cur) {
  const a = fmtValue(was);
  const b = fmtValue(cur);
  return a === b ? b : `${a} → ${b}`;
}

// Шаблонный комментарий — работает всегда, даже когда LLM недоступна. Держится за то, что
// панель уже сказала о показателе: направление балла + первая фраза её собственной заметки.
function templateComment(ev) {
  const parts = [];
  if (ev.kind === "target") {
    const from = parseFloat(ev.before) || 0;
    const to = parseFloat(ev.after) || 0;
    parts.push(
      to > from
        ? "Модель увеличила предписанную долю: режим стал благоприятнее и часть отложенного риска возвращается в позицию."
        : "Модель сократила предписанную долю: режим ухудшился, часть позиции уходит в резерв."
    );
  }
  if (ev.kind === "verdict") parts.push("Сменился общий вывод панели — это верх иерархии, всё остальное ниже уточняет его.");
  if (ev.kind === "detector") {
    const to = String(ev.after || "");
    parts.push(
      to === "fired" || to === "СРАБОТАЛ"
        ? "Детектор сработал: условия сошлись одновременно, а не по одному."
        : to === "watch" || to === "НАБЛЮДЕНИЕ"
          ? "Детектор перешёл в наблюдение: часть условий выполнена, подтверждения нет."
          : "Детектор успокоился: условия разошлись."
    );
  }
  if (ev.kind === "zone") {
    const ds = (ev.afterScore ?? 0) - (ev.beforeScore ?? 0);
    parts.push(
      ds < 0
        ? "Показатель перешёл в худшую зону — его вклад в общий балл уменьшился."
        : ds > 0
          ? "Показатель перешёл в лучшую зону — его вклад в общий балл вырос."
          : "Показатель сменил зону без изменения вклада в балл."
    );
  }
  if (ev.kind === "release") parts.push("Вышли новые данные первоисточника; зоны и вклад в балл при этом не изменились.");
  if (ev.kind === "revision") parts.push("Пересмотр уже опубликованных данных: картина прошлого изменилась задним числом.");
  // У сгруппированного релиза заметок столько же, сколько карточек — в шаблон они не лезут,
  // их видит только LLM. У одиночного события берём первую фразу собственной заметки панели.
  if (!ev.moves) {
    const note = String(ev.note || "").split(/(?<=[.!?])\s/)[0];
    if (note) parts.push(note.length > 220 ? note.slice(0, 217) + "…" : note);
  }
  return parts.join(" ");
}

function renderMessage(ev, comment) {
  const k = KIND[ev.kind] || { emoji: "•", label: ev.kind };
  const head = `${k.emoji} <b>${esc(ev.title)}</b>`;
  const move = ev.before || ev.after ? `${esc(ev.before || "—")} → <b>${esc(ev.after || "—")}</b>` : "";
  const moves = (ev.moves || [])
    .map((m) => `• ${esc(m.name)}: ${esc(m.before)} → <b>${esc(m.after)}</b>${m.delta ? ` <i>(${esc(m.delta)})</i>` : ""}`)
    .join("\n");
  const lines = [head, move, moves, ev.detail ? esc(ev.detail) : ""].filter(Boolean);
  if (ev.indicator?.observed_at) lines.push(`<i>данные на ${esc(ev.indicator.observed_at)}${ev.indicator.source ? " · " + esc(ev.indicator.source) : ""}</i>`);
  lines.push("");
  lines.push("💬 " + esc(comment));
  const text = lines.join("\n");
  return text.length > 4000 ? text.slice(0, 3990) + "…" : text;
}

/* ================================== 5. КОММЕНТАРИИ ================================== */

const LLM_SYSTEM = `Ты — макро- и крипто-стратег, пишешь короткие уведомления владельцу двух аналитических панелей.
На вход — список изменений с ТОЧНЫМИ числами. Для каждого напиши комментарий из ДВУХ частей:
что это значит по существу и какие наиболее вероятные последствия.
ЖЁСТКИЕ ПРАВИЛА: (1) не выдумывай и не переписывай числа — они уже есть в сообщении, повторять их не нужно;
(2) 2–3 предложения, живой русский, без воды и без дисклеймеров; (3) если событие рутинное — так и скажи прямо;
(4) не давай инвестиционных советов в форме приказа, описывай механику и вероятные следствия.
Ответ — СТРОГО JSON-массив вида [{"i":0,"text":"..."}] и ничего больше.`;

function llmContext(panel) {
  const voting = (panel.indicators || []).filter((i) => i.voting && i.score != null);
  return {
    verdict: panel.verdict?.word || "",
    verdict_extra: panel.verdict?.extra || "",
    detectors_fired: (panel.detectors || []).filter((d) => d.state !== "calm").map((d) => `${d.name}: ${d.state}`),
    board: voting.slice(0, 24).map((i) => `${i.name}: ${fmtValue(i)} (${fmtLevel(i)})`),
  };
}

async function llmComments(events, panel) {
  const key = process.env.OPENROUTER_KEY;
  if (!key || !events.length) return null;
  const model = resolveModel();
  if (!model.endsWith(":free") && !paidAllowed()) {
    console.error(`модель «${model}» платная, а NOTIFY_ALLOW_PAID не выставлен — комментарии из шаблона`);
    return null;
  }
  const payload = {
    model,
    max_tokens: Math.min(4000, 320 * events.length + 400),
    messages: [
      { role: "system", content: LLM_SYSTEM },
      {
        role: "user",
        content: JSON.stringify(
          {
            panel_context: llmContext(panel),
            events: events.map((e, i) => ({
              i,
              type: KIND[e.kind]?.label || e.kind,
              indicator: e.title,
              before: e.before || undefined,
              after: e.after || undefined,
              moves: e.moves || undefined,
              detail: e.detail,
              panel_note: (e.note || "").slice(0, 900),
            })),
          },
          null,
          0
        ),
      },
    ],
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}`);
    const j = await res.json();
    const txt = j?.choices?.[0]?.message?.content || "";
    // Берём ПОСЛЕДНИЙ JSON-массив в ответе: модели любят повторить пример из промпта первым.
    const matches = [...txt.matchAll(/\[[\s\S]*?\]/g)];
    for (let m = matches.length - 1; m >= 0; m--) {
      try {
        const arr = JSON.parse(matches[m][0]);
        if (Array.isArray(arr) && arr.some((x) => typeof x?.text === "string")) {
          const by = new Map(arr.map((x) => [Number(x.i), String(x.text)]));
          return events.map((_, i) => by.get(i) || null);
        }
      } catch {}
    }
    return null;
  } catch (e) {
    console.error("LLM-комментарий недоступен, работает шаблон:", String(e.message || e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* =================================== 6. ОТПРАВКА =================================== */

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      link_preview_options: { is_disabled: true },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telegram ${res.status}: ${body.slice(0, 300)}`);
  }
}

/* ================================ 7. СОСТОЯНИЕ И MAIN ================================ */

// Идемпотентность: база сравнения двигается ОДИН раз в конце прогона, а список уже доставленных
// сообщений пишется после КАЖДОЙ отправки. Поэтому падение Telegram на середине рассылки не
// приводит ни к потере хвоста (база осталась старой — события пересчитаются), ни к повтору
// начала (эти ключи уже в индексе). Ключ включает сами значения: то же событие с другими
// числами — это новое событие.
const SENT_TTL_MS = 7 * 24 * 3600 * 1000;
const sentKey = (ev) => `${ev.key}|${ev.before}→${ev.after}|${(ev.moves || []).map((m) => m.after).join(",")}`;

function pruneSent(sent, now) {
  const out = {};
  for (const [k, iso] of Object.entries(sent || {})) {
    const t = Date.parse(iso);
    if (Number.isFinite(t) && now - t < SENT_TTL_MS) out[k] = iso;
  }
  return out;
}

function snapshotState(panel) {
  const indicators = {};
  for (const i of panel.indicators || []) {
    indicators[i.id] = {
      value: i.value,
      value_num: i.value_num,
      unit: i.unit,
      zone: i.zone,
      score: i.score,
      observed_at: i.observed_at,
      degraded: !!i.degraded,
    };
  }
  const detectors = {};
  for (const d of panel.detectors || []) detectors[d.id] = { state: d.state };
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    generated_at: panel.generated_at || "",
    verdict: { word: panel.verdict?.word || "" },
    target: panel.target || null,
    indicators,
    detectors,
    revisions: panel.revisions || [],
  };
}

async function main() {
  const panel = await readPanel();
  const prev = (await readJSON(STATE_PATH)) || {};
  const first = !prev.indicators;
  const now = Date.now();
  const sentIndex = pruneSent(prev.sent, now);
  const all = first ? [] : diff(prev, panel);
  const events = all.filter((ev) => !sentIndex[sentKey(ev)]);

  if (first) console.log("первый прогон: зафиксирована база, уведомления начнутся со следующего изменения");
  if (all.length !== events.length) console.log(`уже доставлено ранее и пропущено: ${all.length - events.length}`);
  console.log(`событий: ${events.length}`);

  let baseline = null; // сдвигается один раз в самом конце — до тех пор пишем старую базу
  const persist = async () => {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify({ ...(baseline || prev), sent: sentIndex }, null, 1));
  };

  let sent = 0;
  if (events.length) {
    const capped = events.slice(0, MAX_EVENTS);
    if (events.length > MAX_EVENTS) console.log(`ПРЕДОХРАНИТЕЛЬ: событий ${events.length} > ${MAX_EVENTS}, отправляются первые ${MAX_EVENTS} по важности`);
    const llm = await llmComments(capped, panel);
    for (let i = 0; i < capped.length; i++) {
      const ev = capped[i];
      const comment = (llm && llm[i]) || templateComment(ev);
      const text = renderMessage(ev, comment);
      if (DRY) {
        const plain = text
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        console.log("\n--- сообщение " + (i + 1) + " ---\n" + plain);
      } else {
        await sendTelegram(text);
        sent++;
        sentIndex[sentKey(ev)] = new Date().toISOString();
        await persist(); // индекс доставленного — сразу на диск, база сдвинется в конце
        if (i < capped.length - 1) await sleep(SEND_GAP_MS);
      }
    }
  }

  baseline = snapshotState(panel);
  await persist();
  console.log(DRY ? "dry-run: ничего не отправлено, база сравнения обновлена" : `отправлено сообщений: ${sent}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("notify.mjs")) {
  main().catch((e) => {
    console.error("notify упал:", e);
    process.exit(1);
  });
}

export { diff, renderMessage, templateComment, fromSnapshotJSON, snapshotState, llmComments, sentKey, pruneSent, MACRO_CADENCE };
