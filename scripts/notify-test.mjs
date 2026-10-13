// Тесты уведомлений. Все фикстуры синтетические и НЕ зависят от текущей даты: проверяется
// поведение диффера, а не то, что сегодня опубликовал FRED.
import assert from "node:assert/strict";
import { diff, renderMessage, templateComment, fromSnapshotJSON, snapshotState, llmComments, sentKey, pruneSent, rememberRevised, appendTrend, appendChanges, decisionChanges, thresholdFrom, humanRelease, releaseOf, pingMessage, main, llmInput, strayNumbers, engineAgrees, fmtValue, HUMAN, MACRO_CADENCE, KIND_ORDER } from "./notify.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error("асинхронный тест должен идти через testAsync");
    passed++;
  } catch (e) {
    console.error(`ПРОВАЛ: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};
const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push([name, fn]);

// Глушилка для синхронных вызовов: часть фикстур штатно печатает диагностику (отсев качков,
// алерты источников), и в логе CI она выглядела боевой тревогой.
const mute = (fn) => {
  const realLog = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = realLog;
  }
};

const ind = (o) => ({
  id: "x",
  name: "Показатель",
  value: "1",
  value_num: 1,
  unit: "",
  delta: "",
  zone: null,
  score: 0,
  observed_at: "2026-07-20",
  source: "FRED",
  note: "Заметка панели. Второе предложение.",
  voting: true,
  scheduled: true,
  revisable: false,
  release: "FRED",
  ...o,
});
const panelOf = (indicators, extra = {}) => ({
  generated_at: "2026-07-24T10:00:00.000Z",
  assetWord: "акций",
  verdict: { word: "ДЕРЖАТЬ", extra: "" },
  allocation: null,
  indicators,
  detectors: [],
  revisions: [],
  ...extra,
});
const stateOf = (panel) => snapshotState(panel);

test("первый прогон не рассылает историю", () => {
  const panel = panelOf([ind({})]);
  assert.equal(diff({}, panel).length, 0, "пустое состояние не должно порождать событий");
});

test("тумблер шума: тип, убранный из KIND_ORDER, не рассылается", () => {
  // УВЕДОМЛЕНИЯ.md обещает именно это; раньше список задавал только порядок сообщений.
  const before = stateOf(panelOf([ind({ value: "1", value_num: 1 })]));
  const after = panelOf([ind({ value: "2", value_num: 2, observed_at: "2026-07-21" })]);
  const at = KIND_ORDER.indexOf("release");
  KIND_ORDER.splice(at, 1);
  try {
    assert.equal(mute(() => diff(before, after)).length, 0, "релизы выключены — событий нет");
  } finally {
    KIND_ORDER.splice(at, 0, "release");
  }
  assert.equal(diff(before, after).length, 1, "с полным списком релиз приходит");
});

test("новая карточка не порождает событие задним числом", () => {
  const before = stateOf(panelOf([ind({ id: "a" })]));
  const after = panelOf([ind({ id: "a" }), ind({ id: "b", name: "Новая" })]);
  assert.equal(diff(before, after).length, 0);
});

test("релиз: дата сдвинулась и значение изменилось", () => {
  const before = stateOf(panelOf([ind({ value: "1", value_num: 1 })]));
  const after = panelOf([ind({ value: "2", value_num: 2, observed_at: "2026-07-21" })]);
  const ev = diff(before, after);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "release");
  assert.equal(ev[0].moves[0].before, "1");
  assert.equal(ev[0].moves[0].after, "2");
});

test("релиз без изменения значения молчит (пользователь просил «если значение меняется»)", () => {
  const before = stateOf(panelOf([ind({ value: "1", value_num: 1 })]));
  const after = panelOf([ind({ value: "1", value_num: 1, observed_at: "2026-07-21" })]);
  assert.equal(diff(before, after).length, 0);
});

test("одна публикация — одно сообщение на несколько карточек", () => {
  const before = stateOf(
    panelOf([
      ind({ id: "a", name: "A", value: "1", value_num: 1 }),
      ind({ id: "b", name: "B", value: "10", value_num: 10 }),
      ind({ id: "c", name: "C", value: "5", value_num: 5, release: "CBOE", source: "CBOE" }),
    ])
  );
  const after = panelOf([
    ind({ id: "a", name: "A", value: "2", value_num: 2, observed_at: "2026-07-21" }),
    ind({ id: "b", name: "B", value: "11", value_num: 11, observed_at: "2026-07-21" }),
    ind({ id: "c", name: "C", value: "6", value_num: 6, observed_at: "2026-07-21", release: "CBOE", source: "CBOE" }),
  ]);
  const ev = diff(before, after);
  assert.equal(ev.length, 2, "две разные публикации → два сообщения");
  const fred = ev.find((e) => e.title === "Данные ФРС");
  assert.ok(fred, `заголовок обязан быть человеческим именем источника, а не ключом датасета: ${ev.map((e) => e.title)}`);
  assert.equal(fred.moves.length, 2, "две карточки одной публикации живут в одном сообщении");
});

test("публикации с разной датой наблюдения не сливаются", () => {
  const before = stateOf(panelOf([ind({ id: "a", value: "1", value_num: 1 }), ind({ id: "b", value: "2", value_num: 2 })]));
  const after = panelOf([
    ind({ id: "a", value: "9", value_num: 9, observed_at: "2026-07-21" }),
    ind({ id: "b", value: "8", value_num: 8, observed_at: "2026-07-22" }),
  ]);
  assert.equal(diff(before, after).length, 2);
});

test("внутренняя переоценка показателя сама по себе не рассылается", () => {
  const before = stateOf(panelOf([ind({ zone: "норма", score: 1 })]));
  const after = panelOf([ind({ zone: "стресс", score: -1 })]);
  assert.equal(diff(before, after).length, 0, "смена зоны — кухня панели, читателю нужны данные и доля");
});

test("вышедшие данные рассылаются даже если оценка показателя сдвинулась", () => {
  const before = stateOf(panelOf([ind({ zone: "норма", score: 1, value: "1", value_num: 1 })]));
  const after = panelOf([ind({ zone: "стресс", score: -1, value: "2", value_num: 2, observed_at: "2026-07-21" })]);
  const ev = diff(before, after);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "release");
  assert.equal(ev[0].moves[0].after, "2");
});

test("непрерывный рыночный фид не порождает релизов", () => {
  const before = stateOf(panelOf([ind({ scheduled: false, value: "1", value_num: 1 })]));
  const after = panelOf([ind({ scheduled: false, value: "999", value_num: 999, observed_at: "2026-07-21" })]);
  assert.equal(diff(before, after).length, 0, "у котировок «значение изменилось» — не событие");
});

test("сдвиг оценки становится объяснением к смене доли, а не отдельным сообщением", () => {
  const alloc = (pct) => ({ pct, blocks: {}, bands: null, hold: null });
  const before = stateOf(panelOf([ind({ id: "hy", zone: "норма", score: 1 })], { allocation: alloc(85) }));
  const after = panelOf([ind({ id: "hy", zone: "стресс", score: -1 })], { allocation: alloc(65) });
  const ev = diff(before, after);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "allocation");
  assert.equal(ev[0].before, "85%");
  assert.equal(ev[0].after, "65%");
  assert.ok(ev[0].causes.some((c) => /спред высокодоходных/i.test(c)), `причина должна называть показатель человеческим именем: ${ev[0].causes}`);
});

test("ревизия: та же дата, другое значение", () => {
  const before = stateOf(panelOf([ind({ revisable: true, value: "100", value_num: 100 })]));
  const after = panelOf([ind({ revisable: true, value: "90", value_num: 90 })]);
  const ev = diff(before, after);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "revision");
});

test("непересматриваемый ряд ревизий не выдумывает", () => {
  const before = stateOf(panelOf([ind({ revisable: false, value: "100", value_num: 100 })]));
  const after = panelOf([ind({ revisable: false, value: "90", value_num: 90 })]);
  assert.equal(diff(before, after).length, 0);
});

test("дребезг чисел ниже машинной точности не считается изменением", () => {
  const before = stateOf(panelOf([ind({ revisable: true, value: "1", value_num: 1 })]));
  const after = panelOf([ind({ revisable: true, value: "1", value_num: 1 + 1e-15 })]);
  assert.equal(diff(before, after).length, 0);
});

test("смена доли — ОДНО сообщение, детектор внутри него объяснением", () => {
  const det = (state) => [{ id: "d1", name: "Слом маржинального спроса", state, inputs: "", note: "" }];
  const before = stateOf(panelOf([ind({})], { allocation: { pct: 80 }, detectors: det("calm") }));
  const after = panelOf([ind({})], { allocation: { pct: 5 }, detectors: det("fired") });
  const ev = diff(before, after);
  assert.equal(ev.length, 1, "вердикт и детектор не должны идти отдельными сообщениями");
  assert.equal(ev[0].kind, "allocation");
  assert.equal(ev[0].before, "80%");
  assert.ok(ev[0].causes.some((c) => c.includes("Совместное ухудшение спроса")), `детектор объясняется по-человечески: ${ev[0].causes}`);
});

test("имя детектора называет условие, а не факт о рынке", () => {
  // Имя печатается при ЛЮБОМ состоянии. «Приток денег в биткоин прекратился: спокоен → наблюдение»
  // пришло бы при притоке в ETF +539 млн $ за пять дней: сошлись 2 условия из 4.
  const det = (state) => [{ id: "d1", name: "Слом маржинального спроса", state, inputs: "условий 3/4", note: "" }];
  const before = stateOf(panelOf([ind({})], { allocation: { pct: 65 }, detectors: det("calm") }));
  const ev = diff(before, panelOf([ind({})], { allocation: { pct: 65 }, detectors: det("fired") }));
  assert.equal(ev.length, 1);
  assert.doesNotMatch(ev[0].title, /прекратил|сжимается|распродают/, `имя утверждает больше посчитанного: ${ev[0].title}`);
  assert.match(ev[0].title, /ухудшение спроса/);
  assert.equal(ev[0].detail, "условий 3 из 4", "счётчик условий печатается рядом с именем");
});

test("сработавший сигнал риска без движения доли идёт отдельным коротким сообщением", () => {
  const det = (state) => [{ id: "d1", name: "Нефтяной шок / Ормуз", state, inputs: "WTI $96", note: "" }];
  const before = stateOf(panelOf([ind({})], { allocation: { pct: 65 }, detectors: det("calm") }));
  const ev = diff(before, panelOf([ind({})], { allocation: { pct: 65 }, detectors: det("fired") }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "risk");
  assert.equal(ev[0].title, "Скачок цен на нефть");
});

test("снятие предварительной тревоги не шлётся", () => {
  const det = (state) => [{ id: "d1", name: "Нефтяной шок / Ормуз", state, inputs: "", note: "" }];
  const before = stateOf(panelOf([ind({})], { allocation: { pct: 65 }, detectors: det("watch") }));
  assert.equal(mute(() => diff(before, panelOf([ind({})], { allocation: { pct: 65 }, detectors: det("calm") }))).length, 0);
});

test("алерт источника без наблюдаемых изменений в рассылку не идёт", () => {
  const rev = [{ key: "network:2026-07-24:abc", text: "источник переписал уже отданные данные" }];
  const ev = mute(() => diff(stateOf(panelOf([ind({})])), panelOf([ind({})], { revisions: rev })));
  assert.equal(ev.length, 0, "«изменено строк: 1» без старого и нового значения — не сообщение");
});

/* ---- значимость движения: рутина дневных рядов не рассылается ---- */

// ряд с ровным шагом 1 и одним крупным выбросом в конце — задаётся явно, дат «от сегодня» нет
const seriesPoints = (steps, startDay = "2026-01-01") => {
  const t0 = Date.parse(startDay + "T00:00:00Z");
  const pts = {};
  let v = 100;
  steps.forEach((d, k) => { v += d; pts[t0 + k * 864e5] = v; });
  return pts;
};
const flat = Array.from({ length: 30 }, (_, k) => (k % 2 ? 1 : -1)); // обычный дрейф ±1

test("мелкое движение официальных данных ВСЁ РАВНО рассылается", () => {
  // Правило владельца: всё, что публикуется по календарю, приходит сразу. Фильтр «значимости»
  // здесь был и за сутки съел SOFR−IORB, HY-спред, VIX и разворот юаня — сторож против возврата.
  const pts = seriesPoints([...flat, 0.2]);
  const before = stateOf(panelOf([ind({ value: "1", value_num: 1, points: seriesPoints(flat) })]));
  const after = panelOf([ind({ value: "1.2", value_num: 1.2, observed_at: "2026-07-21", points: pts })]);
  assert.equal(diff(before, after).length, 1, "данные с календарём публикации молчать не должны");
});

test("крупное движение дневного ряда рассылается и помечается", () => {
  const pts = seriesPoints([...flat, 12]);
  const before = stateOf(panelOf([ind({ value: "1", value_num: 1, points: seriesPoints(flat) })]));
  const after = panelOf([ind({ value: "13", value_num: 13, observed_at: "2026-07-21", points: pts })]);
  const ev = diff(before, after);
  assert.equal(ev.length, 1);
  assert.match(ev[0].moves[0].delta, /движение/, "заметное движение обязано быть помечено прямо в тексте");
});

test("недельные и более редкие публикации проходят ВСЕГДА, даже мелким шагом", () => {
  const weekly = {};
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  Array.from({ length: 30 }, (_, k) => (weekly[t0 + k * 7 * 864e5] = 100 + (k % 2 ? 1 : -1)));
  const later = { ...weekly, [t0 + 30 * 7 * 864e5]: 100.2 };
  const before = stateOf(panelOf([ind({ value: "100", value_num: 100, points: weekly })]));
  const ev = diff(before, panelOf([ind({ value: "100.2", value_num: 100.2, observed_at: "2026-07-21", points: later })]));
  assert.equal(ev.length, 1, "у недельного релиза сам факт выхода данных — событие");
});

test("смена знака помечается: приток стал оттоком", () => {
  const base = seriesPoints(flat);
  const before = stateOf(panelOf([ind({ value: "+34 млн $", value_num: 34, points: base })]));
  const after = panelOf([ind({ value: "-205 млн $", value_num: -205, observed_at: "2026-07-21", points: seriesPoints([...flat, 0.1]) })]);
  const ev = diff(before, after);
  assert.equal(ev.length, 1);
  assert.match(ev[0].moves[0].delta, /отрицательн/, "направление берётся по старому значению: «−0,0» это минус-ноль, и проверка нового его не видит");
});

test("минус-ноль не выдаётся за переход в плюс", () => {
  const before = stateOf(panelOf([ind({ value: "+5", value_num: 5, points: seriesPoints(flat) })]));
  const after = panelOf([ind({ value: "-0,0", value_num: -0, observed_at: "2026-07-21", points: seriesPoints([...flat, 1]) })]);
  const ev = diff(before, after);
  assert.match(ev[0].moves[0].delta, /отрицательн/, "было +5, стало −0,0 — это переход вниз");
});

test("топтание у нуля не помечается сменой знака", () => {
  // +0,1 → −0,0 формально пересекает ноль, но обе стороны ничтожны на фоне обычного шага
  const before = stateOf(panelOf([ind({ value: "+0,1", value_num: 0.1, points: seriesPoints(flat) })]));
  const after = panelOf([ind({ value: "-0,0", value_num: -0.02, observed_at: "2026-07-21", points: seriesPoints([...flat, 0.12]) })]);
  const ev = diff(before, after);
  assert.equal(ev.length, 1, "данные всё равно рассылаются");
  assert.equal(ev[0].moves[0].delta, "", "но громкой пометки быть не должно");
});

test("без накопленного ряда показатель не глушится", () => {
  const before = stateOf(panelOf([ind({ value: "1", value_num: 1 })]));
  const ev = diff(before, panelOf([ind({ value: "1.0001", value_num: 1.0001, observed_at: "2026-07-21" })]));
  assert.equal(ev.length, 1, "нет базы для суждения — молчать нельзя");
});

test("пояснение относится к показателю, который реально попал в сообщение", () => {
  // у первого показателя видимое значение не изменилось — он выпадает; пояснение должно
  // остаться от второго, иначе комментарий объясняет не то, что видит читатель
  const before = stateOf(panelOf([
    ind({ id: "mvrv_cycle", value: "смешанно", value_num: null }),
    ind({ id: "realized_pnl", value: "1.0016", value_num: 1.0016 }),
  ]));
  const after = panelOf([
    ind({ id: "mvrv_cycle", value: "смешанно", value_num: null, observed_at: "2026-07-21", score: 1 }),
    ind({ id: "realized_pnl", value: "1.0013", value_num: 1.0013, observed_at: "2026-07-21" }),
  ]);
  const ev = diff(before, after);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].moves.length, 1, "показатель без видимого изменения в сообщение не попадает");
  assert.equal(ev[0].plain.length, 1, "и его пояснение — тоже");
  assert.match(ev[0].plain[0], /прибыль или в убыток/, `пояснение должно быть о показателе из сообщения: ${ev[0].plain}`);
});

/* ---- нормализация источников ---- */

test("технические имена источников не уходят в заголовок", () => {
  const cases = [
    ["The Block (tbstat) + SosoValue · Coinbase", "Потоки в биткоин-ETF"],
    ["The Block (tbstat)", "Потоки в биткоин-ETF"],
    ["coinmetrics", "Ончейн-данные сети биткоина"],
    ["Coin Metrics · network", "Ончейн-данные сети биткоина"],
    ["CFTC · The Block (tbstat)", "Отчёт CFTC о позициях во фьючерсах"],
    ["mempool.space", "Сеть биткоина"],
    ["DefiLlama · exchange fallback", "Стейблкоины"],
    ["fiscaldata", "Минфин США"],
  ];
  for (const [raw, want] of cases) assert.equal(humanRelease(raw), want, `«${raw}» → ожидалось «${want}»`);
});

test("одна и та же публикация не расщепляется из-за приписки провайдера", () => {
  const a = { id: "etf_regime", source: "The Block (tbstat) + SosoValue · Coinbase" };
  const b = { id: "etf_1d", source: "The Block (tbstat)" };
  assert.equal(releaseOf(a), releaseOf(b), "оба про потоки ETF — сообщение должно быть одно");
});

test("разные публикации одного провайдера не сливаются", () => {
  assert.notEqual(releaseOf({ id: "two_year", source: "fred" }), releaseOf({ id: "liquidity_regime", source: "fred" }),
    "2-летка выходит каждый рабочий день, баланс ФРС — раз в неделю; это разные события");
});

test("порог из фразы панели разбирается вместе с типографским минусом", () => {
  assert.equal(thresholdFrom("до 35%: композит ≤ −13"), -13);
  assert.equal(thresholdFrom("до 100%: композит ≥ +33 и опереж ≥ +13"), 33);
  assert.equal(thresholdFrom("апгрейд разблокируется, когда детектор выйдет"), null);
});

test("промежуточное «наблюдение» детектора не рассылается", () => {
  const det = (state) => [{ id: "d1", name: "Нефтяной шок / Ормуз", state, inputs: "", note: "" }];
  const base = { allocation: { pct: 65 } };
  const calm = stateOf(panelOf([ind({})], { ...base, detectors: det("calm") }));
  const realLog = console.log; console.log = () => {};
  try {
  assert.equal(diff(calm, panelOf([ind({})], { ...base, detectors: det("watch") })).length, 0, "«подтверждений 1/3» — не новость");
  const watch = stateOf(panelOf([ind({})], { ...base, detectors: det("watch") }));
  assert.equal(diff(watch, panelOf([ind({})], { ...base, detectors: det("fired") })).length, 1, "срабатывание — новость");
  const fired = stateOf(panelOf([ind({})], { ...base, detectors: det("fired") }));
  assert.equal(diff(fired, panelOf([ind({})], { ...base, detectors: det("calm") })).length, 1, "снятие — тоже");
  } finally { console.log = realLog; }
});

test("у каждого показателя макро-панели есть человеческое имя", () => {
  const missing = Object.keys(MACRO_CADENCE).filter((id) => !HUMAN[id]);
  assert.deepEqual(missing, [], `без записи в словаре в сообщение уедет внутренняя подпись карточки: ${missing}`);
});

/* ---- класс устойчивости: только у панели, которая сама печатает условия ступеней (макро) ---- */

// Доля макро-панели: текущая оценка и условие нижней ступени, как их печатает страница.
const allocOf = (pct, extra = {}) => ({ pct, score: 9, down: "до 35%: композит ≤ −13", up: "", ...extra });
// Ряд наблюдений оценки с заданным суточным размахом — «обычный шум» для запаса до отката.
const trendOf = (span) => Array.from({ length: 12 }, (_, k) => ({ t: Date.parse("2026-07-01T00:00:00Z") + Math.floor(k / 2) * 864e5 + (k % 2) * 3600e3, pct: 85, score: k % 2 ? span : 0 }));
const tierOf = (before, after, extraState = {}) => {
  const ev = diff({ ...stateOf(panelOf([ind({})], { allocation: before })), ...extraState }, panelOf([ind({})], { allocation: after }));
  return ev[0].stability[0];
};

test("запас меньше обычного суточного хода — шаткое", () => {
  const st = tierOf(allocOf(85), allocOf(65), { alloc_trend: trendOf(30) });
  assert.equal(st.tier, "shaky", "до порога 22 пункта при суточном размахе 30");
  assert.match(st.reason.join(" "), /меньше, чем обстановка обычно проходит за сутки/);
});

test("запас в несколько суточных ходов — устойчивое", () => {
  const st = tierOf(allocOf(85), allocOf(65), { alloc_trend: trendOf(5) });
  assert.equal(st.tier, "firm", "до порога 22 пункта при суточном размахе 5");
  assert.match(st.reason.join(" "), /запас до отката — примерно/);
});

test("без накопленного ряда запас называется числом, класс — умеренный", () => {
  const st = tierOf(allocOf(85), allocOf(65));
  assert.equal(st.tier, "moderate");
  assert.match(st.reason.join(" "), /ещё на 22 пункта/);
});

test("аварийный переключатель — отдельный класс, а не «шаткое»", () => {
  const st = tierOf(allocOf(65), allocOf(0, { override: true }));
  assert.equal(st.tier, "forced");
  assert.match(st.reason.join(" "), /аварийн/);
});

test("в объяснении устойчивости нет внутреннего жаргона", () => {
  const jargon = /блок|шаг|групп|композит|балл|зон[аы]/i;
  for (const st of [tierOf(allocOf(85), allocOf(65), { alloc_trend: trendOf(30) }), tierOf(allocOf(85), allocOf(65), { alloc_trend: trendOf(5) })]) {
    const text = st.reason.join(" ");
    assert.ok(!jargon.test(text), `внутренняя терминология снова протекла наружу: «${text}»`);
  }
});

test("база частот считает только ТАКИЕ ЖЕ смены и не считает текущую", () => {
  const day = 86400e3;
  // три прошлых перехода 85 → 65, каждый отыгран назад за сутки; между ними — посторонние смены
  const alloc_changes = [
    { t: 1e12, from: 85, to: 65 }, { t: 1e12 + day, from: 65, to: 85 },
    { t: 1e12 + 5 * day, from: 85, to: 65 }, { t: 1e12 + 6 * day, from: 65, to: 85 },
    { t: 1e12 + 10 * day, from: 85, to: 100 }, { t: 1e12 + 20 * day, from: 100, to: 85 },
    { t: 1e12 + 30 * day, from: 85, to: 65 }, { t: 1e12 + 31 * day, from: 65, to: 85 },
  ];
  const text = tierOf(allocOf(85), allocOf(65), { alloc_changes }).reason.join(" ");
  assert.match(text, /из 3 таких же смен 3 откатились/, `в счёт идут три перехода 85 → 65, а не все восемь смен: ${text}`);
});

test("меньше трёх таких же смен — база частот не печатается", () => {
  const day = 86400e3;
  // смен в журнале шесть, но перехода 85 → 65 среди них два: прежний счёт напечатал бы «из 7 таких смен»
  const alloc_changes = [
    { t: 1e12, from: 85, to: 65 }, { t: 1e12 + day, from: 65, to: 85 },
    { t: 1e12 + 5 * day, from: 85, to: 100 }, { t: 1e12 + 6 * day, from: 100, to: 85 },
    { t: 1e12 + 10 * day, from: 85, to: 65 }, { t: 1e12 + 11 * day, from: 65, to: 85 },
  ];
  const text = tierOf(allocOf(85), allocOf(65), { alloc_changes }).reason.join(" ");
  assert.doesNotMatch(text, /таких же смен|откатил/, `при двух случаях база — анекдот, а не частота: ${text}`);
});

test("журнал смен переживает подрезку ряда наблюдений", () => {
  const many = Array.from({ length: 500 }, (_, k) => ({ t: 1e12 + k * 3600e3, pct: 5 }));
  const panel = panelOf([ind({})], { allocation: allocOf(5) });
  const trend = appendTrend(many, panel);
  assert.ok(trend.length <= 400, "ряд наблюдений подрезается");
  const changes = appendChanges([{ t: 1e11, from: 80, to: 5 }], panel, { pct: 80 });
  assert.equal(changes.length, 2, "а журнал смен — нет");
  assert.equal(changes[1].to, 5);
});

test("одна и та же смена дважды в журнал не пишется", () => {
  // после сбоя посреди рассылки журнал уже лежит на диске, а смена пересчитывается заново
  const panel = panelOf([ind({})], { allocation: allocOf(5) });
  const once = appendChanges([], panel, { pct: 80 });
  const twice = appendChanges(once, panel, { pct: 80 });
  assert.equal(twice.length, 1);
});

test("опубликованная панелью история решений сразу даёт базу частот", () => {
  const hist = [
    { t: "2026-07-21T01:00:00Z", decision: { target_pct: 5 } },
    { t: "2026-07-21T02:00:00Z", decision: { target_pct: 20 } },
    { t: "2026-07-22T02:00:00Z", decision: { target_pct: 80 } },
    { t: "2026-07-24T02:00:00Z", decision: { target_pct: 45 } },
    { t: "2026-07-24T03:00:00Z", decision: { target_pct: 5 } },
  ];
  const ch = decisionChanges(hist);
  assert.equal(ch.length, 4, `должно быть 4 смены: ${JSON.stringify(ch)}`);
  assert.deepEqual([ch[0].from, ch[0].to], [5, 20]);
  assert.equal(decisionChanges([]).length, 0);
  assert.equal(decisionChanges(undefined).length, 0);
});

test("сообщение о доле собирается с разделами «почему» и «устойчиво ли»", () => {
  const msg = renderMessage(
    { kind: "allocation", title: "Доля акций сокращена", before: "85%", after: "65%", causes: ["причина"], stability: ["запас 5 пунктов"] },
    "комментарий"
  );
  assert.match(msg, /Что за этим стоит/);
  assert.match(msg, /Насколько это устойчиво/);
  assert.match(msg, /85% → <b>65%<\/b>/);
});

/* ---- переписанная история ряда: что именно, когда и на сколько ---- */

const withPoints = (pts, o = {}) => ind({ series: undefined, points: pts, ...o });
const day = (iso) => Date.parse(iso + "T00:00:00Z");

test("переписанная точка ряда показывается с датой и «было → стало»", () => {
  const before = stateOf(panelOf([withPoints({ [day("2026-05-27")]: 100, [day("2026-05-28")]: 110, [day("2026-05-29")]: 120 })]));
  const after = panelOf([withPoints({ [day("2026-05-27")]: 115, [day("2026-05-28")]: 110, [day("2026-05-29")]: 120 })]);
  const ev = diff(before, after);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "revision");
  assert.match(ev[0].detail, /27\.05\.2026/, "дата переписанной точки обязана быть в сообщении");
  assert.equal(ev[0].moves[0].before, "100");
  assert.equal(ev[0].moves[0].after, "115");
  assert.equal(ev[0].moves[0].delta, "+15,0%", "проценты пишутся по-русски, с запятой");
});

test("последняя точка ряда — не ревизия: она ещё формируется", () => {
  const before = stateOf(panelOf([withPoints({ [day("2026-05-27")]: 100, [day("2026-05-28")]: 110 })]));
  const after = panelOf([withPoints({ [day("2026-05-27")]: 100, [day("2026-05-28")]: 999, [day("2026-05-29")]: 130 })]);
  assert.equal(diff(before, after).length, 0, "движение свежей точки — это рынок, а не пересмотр истории");
});

test("несколько переписанных точек — одно сообщение с периодом", () => {
  const base = {};
  for (let d = 1; d <= 10; d++) base[day(`2026-05-${String(d).padStart(2, "0")}`)] = d * 10;
  const before = stateOf(panelOf([withPoints({ ...base })]));
  const moved = { ...base, [day("2026-05-02")]: 21, [day("2026-05-03")]: 31, [day("2026-05-04")]: 41 };
  const ev = diff(before, panelOf([withPoints(moved)]));
  assert.equal(ev.length, 1);
  assert.match(ev[0].detail, /период 02\.05\.2026 — 04\.05\.2026/);
  assert.equal(ev[0].moves.length, 3);
});

test("новые точки в конце ряда ревизией не считаются", () => {
  const before = stateOf(panelOf([withPoints({ [day("2026-05-27")]: 100, [day("2026-05-28")]: 110 })]));
  const after = panelOf([withPoints({ [day("2026-05-27")]: 100, [day("2026-05-28")]: 110, [day("2026-05-29")]: 130, [day("2026-05-30")]: 140 })]);
  assert.equal(diff(before, after).length, 0);
});

test("дребезг последнего знака не выдаётся за пересмотр", () => {
  const before = stateOf(panelOf([withPoints({ [day("2026-05-27")]: 1e20, [day("2026-05-28")]: 2e20 })]));
  const after = panelOf([withPoints({ [day("2026-05-27")]: 1e20 * (1 + 1e-12), [day("2026-05-28")]: 2e20 })]);
  assert.equal(diff(before, after).length, 0);
});

test("возврат точки к уже показанному значению — не сообщение, а качок источника", () => {
  const pts = (v) => ({ [day("2026-05-27")]: v, [day("2026-05-28")]: 200, [day("2026-05-29")]: 300 });
  const s0 = stateOf(panelOf([withPoints(pts(100))]));
  const first = diff(s0, panelOf([withPoints(pts(115))]));
  assert.equal(first.length, 1, "первый пересмотр показывается");
  const seen = rememberRevised({}, first, Date.parse("2026-07-24T00:00:00Z"));
  const s1 = { ...stateOf(panelOf([withPoints(pts(115))])), revised_points: seen };
  const realLog2 = console.log; console.log = () => {};
  let back;
  try { back = diff(s1, panelOf([withPoints(pts(100))])); } finally { console.log = realLog2; }
  assert.equal(back.length, 0, "источник вернул прежнее значение — новости в этом нет");
  const s2 = { ...stateOf(panelOf([withPoints(pts(115))])), revised_points: seen };
  assert.equal(diff(s2, panelOf([withPoints(pts(130))])).length, 1, "новое, ещё не показанное значение — событие");
});

test("память о показанных значениях протухает и не растёт бесконечно", () => {
  const now = Date.parse("2026-07-24T00:00:00Z");
  const old = { "x|1": { v: [1], at: "2026-01-01T00:00:00Z" }, "x|2": { v: [2], at: "2026-07-20T00:00:00Z" } };
  const kept = rememberRevised(old, [], now);
  assert.deepEqual(Object.keys(kept), ["x|2"], "запись старше 90 дней уходит");
  let acc = {};
  for (let i = 0; i < 20; i++) acc = rememberRevised(acc, [{ revisedPoints: [{ id: "x", t: 7, after: i }] }], now);
  assert.ok(acc["x|7"].v.length <= 6, `список значений точки не должен расти без предела: ${acc["x|7"].v.length}`);
});

test("крупные и мелкие порядки печатаются читаемо", () => {
  const before = stateOf(panelOf([withPoints({ [day("2026-05-27")]: 7.31e20, [day("2026-05-28")]: 1 })]));
  const ev = diff(before, panelOf([withPoints({ [day("2026-05-27")]: 8.36e20, [day("2026-05-28")]: 1 })]));
  assert.match(ev[0].moves[0].before, /10\^20/, "хешрейт обязан читаться, а не тянуться двадцатью нулями");
  assert.equal(ev[0].moves[0].delta, "+14,4%");
});

test("шаблонный комментарий не бывает пустым ни для одного типа события", () => {
  const kinds = [
    { kind: "target", before: "80%", after: "5%" },
    { kind: "verdict" },
    { kind: "detector", after: "СРАБОТАЛ" },
    { kind: "zone", beforeScore: 1, afterScore: -1, note: "Заметка. Хвост." },
    { kind: "release", moves: [{ name: "A", before: "1", after: "2" }] },
    { kind: "revision" },
  ];
  for (const ev of kinds) {
    const c = templateComment(ev);
    assert.ok(c && c.length > 20, `пустой комментарий у ${ev.kind}`);
  }
});

test("шаблон релиза не вываливает заметки всех карточек", () => {
  const c = templateComment({ kind: "release", moves: [{ name: "A" }], note: "Очень длинная заметка про карточку." });
  assert.ok(!c.includes("Очень длинная заметка"), "заметки карточек уходят только в контекст LLM");
});

test("HTML в данных экранируется, разметка сообщения — нет", () => {
  const msg = renderMessage({ kind: "zone", title: "MVRV <25 & прочее", before: "a", after: "b", detail: "" }, "ok");
  assert.ok(msg.includes("MVRV &lt;25 &amp; прочее"), "значения обязаны экранироваться");
  assert.ok(msg.includes("<b>"), "собственная разметка сообщения должна остаться");
});

test("сообщение не превышает лимит Telegram", () => {
  const msg = renderMessage({ kind: "release", title: "T", before: "", after: "", detail: "x".repeat(5000) }, "y".repeat(5000));
  assert.ok(msg.length <= 4000, `длина ${msg.length}`);
});

test("снимок BTC-панели читается в общую форму", () => {
  const snap = {
    generated_at: "2026-07-24T10:00:00.000Z",
    verdict: "ЗАЩИТНЫЙ РЕЖИМ",
    scores: { strategic: -15 },
    regime: { strategic: "defensive" },
    decision: { target_pct: 5, reason_codes: ["base:defensive"] },
    metrics: [
      { id: "m1", name: "Карточка", value: "1", value_num: 1, score: 0, vote: true, observed_at: "2026-07-22T00:00:00.000Z", source: "FRED", note: "n" },
      { id: "m2", name: "Живой фид", value: "2", value_num: 2, score: null, vote: false, observed_at: "2026-07-24T09:59:00.000Z", source: "Coinbase", note: "n" },
    ],
    detectors: [{ id: "d", name: "Д", state: "calm", inputs: "in", logic: "log" }],
    source_revision_alerts: [{ source: "etf", observed_at: "2026-07-23T12:00:00.000Z", changed_rows: 1, previous_data_sha256: "abcdef1234" }],
  };
  // Предупреждение о безымянной карточке — ОЖИДАЕМЫЙ вывод этой фикстуры. В логе CI оно
  // выглядело как боевая тревога, поэтому глушим — но проверяем, что оно вообще прозвучало.
  let warned = "";
  const realLog = console.log;
  console.log = (...a) => { warned += a.join(" ") + " "; };
  let p;
  try {
    p = fromSnapshotJSON(snap);
  } finally {
    console.log = realLog;
  }
  assert.match(warned, /нет человеческого имени/, "карточка без записи в словаре обязана давать предупреждение");
  assert.equal(p.verdict.word, "ЗАЩИТНЫЙ РЕЖИМ");
  assert.equal(p.target.pct, 5);
  assert.equal(p.indicators[0].scheduled, true, "суточной свежести наблюдение — публикация по календарю");
  assert.equal(p.indicators[1].scheduled, false, "наблюдение минутной свежести — живой фид");
  assert.equal(p.revisions.length, 1);
  assert.match(p.revisions[0].text, /переписал/);
});

test("карточка на встроенной оценке не порождает событий", () => {
  const before = stateOf(panelOf([ind({ zone: "норма", score: 1, value: "1", value_num: 1 })]));
  const degradedNow = panelOf([ind({ zone: "стресс", score: -1, value: "9", value_num: 9, degraded: true })]);
  assert.equal(diff(before, degradedNow).length, 0, "сбой источника — не рыночное событие");
  const wasDegraded = stateOf(panelOf([ind({ zone: "норма", score: 1, value: "1", value_num: 1, degraded: true })]));
  const healthyNow = panelOf([ind({ zone: "стресс", score: -1, value: "9", value_num: 9 })]);
  assert.equal(diff(wasDegraded, healthyNow).length, 0, "возврат источника — тоже не событие");
});

test("ключ доставленного различает одно событие с разными числами", () => {
  const a = { key: "rel:fred|2026-07-21", before: "", after: "", moves: [{ after: "1" }] };
  const b = { key: "rel:fred|2026-07-21", before: "", after: "", moves: [{ after: "2" }] };
  assert.notEqual(sentKey(a), sentKey(b), "пересмотренное значение обязано считаться новым событием");
  assert.equal(sentKey(a), sentKey({ ...a }));
});

test("индекс доставленного протухает, но не раньше недели", () => {
  const now = Date.parse("2026-07-24T00:00:00Z");
  const kept = pruneSent(
    { fresh: "2026-07-23T00:00:00Z", old: "2026-07-10T00:00:00Z", broken: "не дата" },
    now
  );
  assert.deepEqual(Object.keys(kept), ["fresh"]);
});

test("проверочное сообщение показывает текущее состояние панели", () => {
  const p = panelOf([ind({ name: "Карточка" })], {
    verdict: { word: "ДЕРЖАТЬ", extra: "балл +9" },
    allocation: { pct: 20 },
    detectors: [
      { id: "a", name: "Спокойный", state: "calm", inputs: "", note: "" },
      { id: "b", name: "Тревожный", state: "fired", inputs: "", note: "" },
    ],
  });
  const m = pingMessage(p);
  assert.match(m, /Проверка связи/);
  assert.match(m, /ДЕРЖАТЬ/);
  assert.match(m, /20%/);
  assert.match(m, /Тревожный \(СРАБОТАЛ\)/, "нештатные детекторы обязаны быть названы");
  assert.ok(!m.includes("Спокойный"), "спокойные детекторы не перечисляются поимённо");
});

/* ====================== BTC-панель: правки по аудиту уведомлений от 10.10.2026 ======================
   Фикстуры — синтетические снимки той формы, какую публикует панель; числа взяты из настоящих смен
   цели 19.07–10.10.2026. Всё идёт через fromSnapshotJSON → diff → renderMessage, а там, где важна
   память между запусками (индекс доставленного, пауза, удержание, показанные значения), — через
   саму main() с подставленным получателем сообщений: ни токена, ни сети для этого не нужно. */

const LADDER = { emergency: 0, defensive: 5, deteriorating: 20, transition: 45, unconfirmed_positive: 95, constructive: 100 };
// оценки трёх направлений, при которых таблица режимов движка даёт именно этот режим
const REGIME_BLOCKS = {
  defensive: { macro: 0, demand: -31.3, cycle: -20 },
  deteriorating: { macro: -16.7, demand: -25, cycle: 20 },
  transition: { macro: -8.3, demand: 6.3, cycle: 30 },
  unconfirmed_positive: { macro: 25, demand: 5, cycle: 25 },
  constructive: { macro: 25, demand: 25, cycle: 25 },
};
const T0 = Date.parse("2026-08-19T20:38:48.000Z");
const at = (min) => new Date(T0 + min * 60000).toISOString();
const card = (id, o = {}) => ({
  id, block: "demand", family: id, name: id, vote: true, strategic: true, value: "смешанно", value_num: 0, score: 0, unit: "", delta: "",
  source: "источник", observed_at: "2026-08-18T00:00:00.000Z", stale: false, series: [], note: "", ...o,
});
// Суточный ряд из n точек, заканчивающийся в day. Значение задаётся функцией от номера точки и
// от номера суток: ряд, привязанный к суткам, не «переписывается», когда сдвигается его конец.
const dailySeries = (day, n, f) => Array.from({ length: n }, (_, k) => {
  const t = Date.parse(day + "T00:00:00Z") - (n - 1 - k) * 864e5;
  return { t, v: f(k, Math.round(t / 864e5)) };
});

function btcSnap(o = {}) {
  const t = o.t || at(15);
  const state = o.state ?? "deteriorating";
  const candidate = o.candidate ?? state;
  const blocks = o.blocks || REGIME_BLOCKS[o.table || candidate] || REGIME_BLOCKS.transition;
  const mvrv = o.mvrv ?? 42;
  const overlays = o.overlays || [];
  const paused = o.target === null;
  const base = LADDER[state] ?? null;
  const floor = overlays.includes("recovery_floor") ? 80 : overlays.includes("capitulation_floor") ? 40 : 0;
  const cap = overlays.includes("euphoria_safety_cap") ? 60 : 100;
  // панель публикует цели режимов уже с действующими оверлеями
  const targets = Object.fromEntries(Object.entries(LADDER).map(([r, p]) => [r, r === "emergency" ? 0 : Math.min(Math.max(p, floor), cap)]));
  const fam = (n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`f${k}`, 0]));
  return {
    generated_at: t,
    version: "2.13.0",
    price: o.price ?? 69116,
    verdict: "ВЕРДИКТ",
    scores: { strategic: -10, critical_missing: { strategic: o.missing || [], tactical: [] } },
    regime: { strategic: state, tactical: "balanced" },
    regime_meta: { strategic: { state, candidate, count: o.count ?? 3, since: o.since || t, downStreak: 0, anchor: state, ...(o.hold_until ? { hold_until: o.hold_until } : {}) } },
    override: o.override || null,
    policy_components: { allocation: { id: "btc-allocation-policy-v1" }, model: { id: o.model_id || "btc-model-policy-v1" }, execution: { id: "btc-execution-policy-v1" } },
    blocks: {
      macro: { strategic: { score: blocks.macro, families: fam(3) } },
      demand: { strategic: { score: blocks.demand, families: fam(4) } },
      cycle: { strategic: { score: blocks.cycle, families: fam(5) } },
    },
    decision: paused
      ? { status: "paused", base_target_pct: null, target_pct: null, binding_overlays: [], reason_codes: ["insufficient_data"], quality: { status: "paused" } }
      : {
          status: "actionable", strategic: state, base_target_pct: base, target_pct: o.target ?? base, regime_targets_pct: targets,
          binding_overlays: overlays, reason_codes: [`base:${state}`, ...overlays],
          inputs: { strategic: state, recovery_state: o.recovery || "calm", macro_shock_state: "calm", mvrv_percentile: mvrv },
          quality: { status: o.quality || "good" },
        },
    metrics: o.metrics || [
      card("mvrv_cycle", { block: "cycle", family: "valuation", value: `${Math.round(mvrv)}-й перцентиль 4 лет`, value_num: mvrv }),
      card("trend_regime", { block: "cycle", family: "trend", value: (o.trend ?? -1) > 0 ? "выше 20W и 200D" : "ниже среднесрочных опор", value_num: o.trend ?? -1, score: o.trend ?? -1 }),
      card("etf_regime", { family: "etf", value: "смешанно", value_num: o.etf ?? 0, score: o.etf ?? 0, stale: !!o.etf_stale }),
      card("exchange_supply", { family: "exchange_supply", value: "сбалансировано", value_num: o.exchange ?? 0, score: o.exchange ?? 0 }),
    ],
    detectors: [
      { id: "integrity", name: "Нарушение целостности рынка", state: o.override ? "fired" : "calm", inputs: o.override ? "peg 6.20% · spread 350 б.п." : "peg 0.08% · spread 2 б.п." },
      { id: "macro_shock", name: "Макрошок ликвидности", state: "calm", inputs: "условий 1/3" },
      { id: "demand_break", name: "Слом маржинального спроса", state: o.demand_break || "calm", inputs: "условий 3/4" },
      { id: "recovery", name: "Капитуляция → восстановление", state: o.recovery || "calm", inputs: `оценка ${mvrv < 25 ? "низкая" : "не низкая"} · подтверждений ${o.conf ?? 1}/3` },
    ],
    sources: o.sources || {},
    history: [],
    monitoring: o.log ? { target_change_log: o.log } : {},
    ...(o.extra || {}),
  };
}
// Лента снимков: у каждого — история решений из всех предыдущих и себя самого, как у панели.
const timeline = (list) => {
  const history = [];
  return list.map((o) => {
    const snap = btcSnap(o);
    history.push({ t: snap.generated_at, price: snap.price, regime: { strategic: snap.regime.strategic }, decision: { status: snap.decision.status, base_target_pct: snap.decision.base_target_pct, target_pct: snap.decision.target_pct, binding_overlays: snap.decision.binding_overlays } });
    snap.history = history.slice();
    return snap;
  });
};
const silently = async (fn) => {
  const realLog = console.log, realErr = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = realLog; console.error = realErr; }
};
const plainText = (html) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/ /g, " ");
// Бот идёт по ленте снимков настоящей main(): состояние — из памяти, сообщения — в массив.
// only — номера снимков, на которых бот запускается (пропуск тактов); по умолчанию на каждом.
async function runBot(snaps, { state = null, only = null, selftest } = {}) {
  const sent = [];
  let st = state;
  const realNow = Date.now;
  try {
    for (let k = 0; k < snaps.length; k++) {
      if (only && !only.includes(k)) continue;
      Date.now = () => Date.parse(snaps[k].generated_at) + 90e3;
      await silently(() => main({
        panel: fromSnapshotJSON(snaps[k]),
        state: st,
        saveState: (s) => { st = JSON.parse(JSON.stringify(s)); },
        deliver: (text, ev) => { sent.push({ k, kind: ev.kind, title: ev.title, before: ev.before, after: ev.after, text: plainText(text), ev }); },
        selftest,
      }));
    }
  } finally { Date.now = realNow; }
  return { sent, state: st };
}
const texts = (r, kind) => r.sent.filter((m) => !kind || m.kind === kind).map((m) => m.text);

/* ---- п. 1: причина смены доли ---- */

// Повышение 20 → 45, принятое после 48 часов удержания (как 23.09.2026). В такт принятия качнулась
// посторонняя карточка — потоки ETF: прежний бот назвал её причиной.
const SINCE = at(15 - 48 * 60);
const UP_LOG = [{
  t: at(15), from_pct: 20, to_pct: 45, direction: "up", price: 86198, strategic_from: "deteriorating", strategic_to: "transition",
  overlays_from: [], overlays_to: [], kind: "regime",
  cause: {
    text: "блок «Спрос» вышел из неблагоприятной полосы: качество институционального спроса −1 → 0",
    families: [{ block: "demand", family: "institutional", id: "institutional_quality", name: "Качество институционального спроса", from: -1, to: 0 }],
    detectors: [], candidate_since: SINCE,
  },
}];
const upgrade = (extra1 = {}) => timeline([
  { t: at(0), state: "deteriorating", candidate: "transition", since: SINCE, hold_until: at(15), count: 192, price: 86120, etf: 0 },
  { t: at(15), state: "transition", candidate: "transition", since: SINCE, count: 193, price: 86198, etf: 0.5, ...extra1 },
]);

testAsync("причина смены доли берётся из журнала монитора, а не из разницы соседних снимков", async () => {
  const r = await runBot(upgrade({ log: UP_LOG }));
  assert.equal(r.sent.length, 1, `одна смена — одно сообщение: ${r.sent.map((m) => m.title)}`);
  const text = r.sent[0].text;
  assert.match(text, /Причина: блок «Спрос» вышел из неблагоприятной полосы: качество институционального спроса −1 → 0/, text);
  assert.match(text, /кандидат с 17\.08 20:53 UTC/, "момент рождения кандидата обязан быть назван");
  assert.doesNotMatch(text, /Потоки в биткоин-ETF/, "карточка, качнувшаяся в такт принятия, причиной не является");
});

testAsync("запись журнала с меткой времени, отстающей от снимка, всё равно даёт причину", async () => {
  // монитор и сборщик — разные потоки кода; метка записи не обязана совпасть со снимком до миллисекунды
  const late = [{ ...UP_LOG[0], t: new Date(Date.parse(at(15)) + 7000).toISOString() }];
  const text = (await runBot(upgrade({ log: late }))).sent[0].text;
  assert.match(text, /20% → 45%/);
  assert.match(text, /Причина: блок «Спрос» вышел из неблагоприятной полосы/, text);
});

testAsync("без журнала причина строится из записи о рождении кандидата", async () => {
  const regime_birth = { strategic: {
    t: SINCE, candidate: "transition", from_candidate: "deteriorating", price: 81092.7,
    blocks: { demand: { from: -31.25, to: -18.75, band_from: "adverse", band_to: "neutral" } },
    families: [{ block: "demand", family: "institutional", id: "institutional_quality", name: "Качество институционального спроса", from: -1, to: 0 }],
    detectors: [], note: null,
  } };
  const r = await runBot(upgrade({ extra: { regime_birth } }));
  const text = r.sent[0].text;
  assert.match(text, /Причина: оценка спроса −31,3 → −18,8 \(вышла из неблагоприятной полосы\): «Позиции фондов во фьючерсах CME \(отчёт CFTC\)» −1 → 0 \(кандидат с 17\.08 20:53 UTC\)/, text);
  assert.doesNotMatch(text, /Потоки в биткоин-ETF/);
});

testAsync("без журнала и без записи о рождении причина не выдумывается", async () => {
  const r = await runBot(upgrade());
  const text = r.sent[0].text;
  assert.match(text, /Причина: смена режима, принятая после удержания/, text);
  assert.doesNotMatch(text, /Потоки в биткоин-ETF|Улучшил|Ухудшил/, "случайные изменения соседнего снимка в причины не идут");
  assert.match(text, /Сейчас: неблагоприятных направлений нет/, "правило, по которому режим таков, читается с текущего снимка");
});

/* ---- п. 2: сообщение о доле самодостаточно ---- */

testAsync("повышение по режиму: было → стало, цена, режим, действие и условие отката ВНИЗ", async () => {
  const text = (await runBot(upgrade({ log: UP_LOG }))).sent[0].text;
  assert.match(text, /Доля биткоина увеличена\n20% → 45%\nBTC 86 198 \$ · 19\.08 20:53 UTC/, text);
  assert.match(text, /Режим «ухудшается» → «переходный» \(ступень 45 %\), принят после 48 часов удержания/);
  assert.match(text, /Что делать\n• Повышение — траншами со следующей сессии/);
  assert.match(text, /Что отменит\n• Понижение до 20 % — вторым снимком подряд \(≈ 15 мин\), если оценка спроса опустится до −20 \(сейчас \+6,3\)/, "для повышения откат — это ухудшение, а не улучшение");
  const undo = text.split("Что отменит")[1].split("💬")[0];
  assert.doesNotMatch(undo, /улучш/, `условие отмены повышения не может быть «в сторону улучшения»: ${undo}`);
  assert.doesNotMatch(text, /Шаткое|Устойчивое|Насколько это устойчиво/, "класса устойчивости у BTC-панели больше нет");
});

testAsync("понижение по режиму: исполнять сразу, возврат — не раньше чем через 48 часов", async () => {
  const snaps = timeline([
    { t: at(0), state: "transition", candidate: "deteriorating", table: "deteriorating", count: 1, price: 75600 },
    { t: at(15), state: "deteriorating", candidate: "deteriorating", count: 2, since: at(0), price: 75563 },
  ]);
  const text = (await runBot(snaps)).sent[0].text;
  assert.match(text, /Доля биткоина сокращена\n45% → 20%/);
  assert.match(text, /Режим «переходный» → «ухудшается» \(ступень 20 %\), подтверждён вторым снимком подряд/);
  assert.match(text, /Сейчас: спрос неблагоприятен \(−25 при пороге −20\)/);
  assert.match(text, /Что делать\n• Понижение — сразу/);
  assert.match(text, /Что отменит\n• Возврат к 45 % — после 48 часов удержания, не раньше 21\.08 20:53 UTC: нужна оценка спроса выше −20 \(сейчас −25\)/, text);
  assert.doesNotMatch(text, /Понижение до/, "для понижения условие отмены — возврат вверх");
});

// Вход на пол восстановления (как 19.08.2026): режим прежний, цель поднята оверлеем.
const floorOn = (extra = {}) => timeline([
  { t: at(0), state: "deteriorating", candidate: "deteriorating", mvrv: 19.5, recovery: "watch", conf: 1, trend: -1, price: 68900 },
  { t: at(15), state: "deteriorating", candidate: "transition", table: "deteriorating", hold_until: at(15 + 48 * 60), mvrv: 19.5, recovery: "good", conf: 2, trend: 2, target: 80, overlays: ["recovery_floor"], count: 1, ...extra },
]);

testAsync("пол восстановления назван полом, а его снятие описано условиями детектора", async () => {
  const text = (await runBot(floorOn())).sent[0].text;
  assert.match(text, /Доля биткоина увеличена\n20% → 80%\nBTC 69 116 \$/);
  assert.match(text, /Включён пол восстановления 80 % поверх режима «ухудшается» \(ступень 20 %\)/, text);
  assert.match(text, /Причина: детектор разворота подтверждён — MVRV-перцентиль 19,5 \(ниже 25\), подтверждений 2 из 3; сдвинулся показатель «Тренд цены биткоина»: ниже среднесрочных опор → выше 20W и 200D/);
  assert.match(text, /Кандидат «переходный» \(ступень 45 %\) на удержании: не раньше 21\.08 20:53 UTC/);
  assert.match(text, /Что отменит\n• Пол снимается одним снимком, если MVRV-перцентиль дойдёт до 25 \(сейчас 19,5\) или подтверждений станет меньше 2 из 3 \(сейчас 2\)\. Цель вернётся к ступени режима — 20 %/);
  assert.match(text, /💬 Это пол восстановления поверх режима, а не смена режима/, "шаблон выбирается по тому, что изменилось, а не по знаку");
});

testAsync("уровень цены, на котором пол снимется, печатается, когда снимок его публикует", async () => {
  const valuation_levels = { as_of: at(0), levels: [{ key: "capitulation_floor", percentile: 10, mvrv: 1.17, price_usd: 63600 }, { key: "recovery_anchor", percentile: 25, mvrv: 1.34, price_usd: 72800 }] };
  const text = (await runBot(floorOn({ extra: { valuation_levels } }))).sent[0].text;
  assert.match(text, /MVRV-перцентиль дойдёт до 25 \(сейчас 19,5; это цена ≈ 72,8 тыс\. \$\)/, text);
});

testAsync("снятие пола из-за роста оценки не подаётся как «обстановка хуже прежней»", async () => {
  // 20.08: пол прожил семь часов и снят оттого, что цена выросла и оценка перестала быть дешёвой.
  const off = timeline([
    { t: at(15), state: "deteriorating", candidate: "transition", table: "deteriorating", mvrv: 19.5, recovery: "good", conf: 2, trend: 2, target: 80, overlays: ["recovery_floor"] },
    { t: at(30), state: "deteriorating", candidate: "deteriorating", mvrv: 27.2, recovery: "calm", conf: 2, trend: 2, price: 69158, count: 1 },
  ]);
  const text = (await runBot(off)).sent[0].text;
  assert.match(text, /Доля биткоина сокращена\n80% → 20%/);
  assert.match(text, /Снят пол восстановления: цель вернулась к ступени режима «ухудшается» \(20 %\)/, text);
  assert.match(text, /Причина: оценка перестала быть дешёвой — MVRV-перцентиль 19,5 → 27,2 при пороге 25/);
  assert.match(text, /Что отменит\n• Пол вернётся одним снимком — нужно: MVRV-перцентиль ниже 25 \(сейчас 27,2\)/);
  assert.doesNotMatch(text, /хуже прежней|уводит часть позиции/);
});

testAsync("снятие пола и принятое повышение режима в одном снимке: названо и то, и другое", async () => {
  // Удержание кандидата истекло в тот же снимок, где детектор потерял якорь: цель упала с пола
  // на новую, более высокую ступень режима.
  const since = at(15 - 48 * 60);
  const snaps = timeline([
    { t: at(0), state: "deteriorating", candidate: "transition", table: "deteriorating", since, hold_until: at(15), mvrv: 19.5, recovery: "good", conf: 2, target: 80, overlays: ["recovery_floor"], count: 192 },
    { t: at(15), state: "transition", candidate: "transition", since, mvrv: 27.2, recovery: "calm", conf: 2, count: 193 },
  ]);
  const text = (await runBot(snaps)).sent[0].text;
  assert.match(text, /Доля биткоина сокращена\n80% → 45%/);
  assert.match(text, /Снят пол восстановления, режим «ухудшается» → «переходный» \(ступень 45 %\), принят после 48 часов удержания/, text);
  assert.match(text, /Причина: оценка перестала быть дешёвой — MVRV-перцентиль 19,5 → 27,2 при пороге 25/);
  assert.match(text, /Что делать\n• Понижение — сразу/);
  assert.match(text, /Что отменит\n• Пол вернётся одним снимком — нужно: MVRV-перцентиль ниже 25 \(сейчас 27,2\)/);
  assert.match(text, /💬 В одном снимке сошлись смена режима и смена оверлея/);
});

/* ---- п. 3: кандидат и удержание ---- */

testAsync("сообщение о снятии пола не обещает возврата, когда кандидат уже хуже режима", async () => {
  // 24.07 и 12.08: «80 → 45» прожило 24 и 15 минут — кандидат в момент отправки был «защитный».
  const snaps = timeline([
    { t: at(0), state: "transition", candidate: "transition", mvrv: 20, recovery: "good", conf: 2, target: 80, overlays: ["recovery_floor"], exchange: 0 },
    { t: at(15), state: "transition", candidate: "defensive", mvrv: 20, recovery: "watch", conf: 1, exchange: -0.5, count: 1, price: 64942 },
  ]);
  const text = (await runBot(snaps)).sent[0].text;
  assert.match(text, /80% → 45%/);
  assert.match(text, /Что делать\n• Понижение — сразу\. Кандидат уже «защитный»: следующий шаг до 5 % подтвердится ближайшим снимком/, text);
  assert.match(text, /Причина: подтверждений осталось 1 из 3, нужно 2; сдвинулся показатель «Запас биткоинов на биржах» \(ухудшился\)/);
  assert.doesNotMatch(text, /на одну ступень вверх|вернёт долю/, "о возврате вверх при идущем понижении — ни слова");
});

// Удержание повышения 20 → 45: кандидат «переходный» ждёт 48 часов; источник ETF пять раз отдаёт
// устаревший день, кандидат каждый раз падает и возвращается — отсчёт начинается заново (20–21.09).
const HOLD_SINCE = at(-41.5 * 60);
const holdLine = [
  { t: at(0), state: "deteriorating", candidate: "transition", since: HOLD_SINCE, hold_until: at(6.5 * 60), count: 167, etf: 0 },
  // сброс 1: удержанию 41,5 часа
  { t: at(15), state: "deteriorating", candidate: "deteriorating", count: 1, etf: -0.5, etf_stale: true },
  { t: at(30), state: "deteriorating", candidate: "transition", since: at(30), hold_until: at(30 + 2880), count: 1, etf: 0 },
  // сбросы 2–5: удержания по 15–30 минут
  { t: at(60), state: "deteriorating", candidate: "deteriorating", count: 1, etf: -0.5, etf_stale: true },
  { t: at(75), state: "deteriorating", candidate: "transition", since: at(75), hold_until: at(75 + 2880), count: 1, etf: 0 },
  { t: at(90), state: "deteriorating", candidate: "deteriorating", count: 1, etf: -0.5, etf_stale: true },
  { t: at(105), state: "deteriorating", candidate: "transition", since: at(105), hold_until: at(105 + 2880), count: 1, etf: 0 },
  { t: at(120), state: "deteriorating", candidate: "deteriorating", count: 1, etf: -0.5, etf_stale: true },
  { t: at(135), state: "deteriorating", candidate: "transition", since: at(135), hold_until: at(135 + 2880), count: 1, etf: 0 },
  { t: at(150), state: "deteriorating", candidate: "deteriorating", count: 1, etf: -0.5, etf_stale: true },
  { t: at(165), state: "deteriorating", candidate: "transition", since: at(165), hold_until: at(165 + 2880), count: 1, etf: 0 },
  // принятие через 48 часов после последнего возврата кандидата
  { t: at(165 + 2880), state: "transition", candidate: "transition", since: at(165), count: 193, etf: 0 },
];

testAsync("пять сбросов удержания подряд — одно короткое сообщение с причиной", async () => {
  const r = await runBot(timeline(holdLine));
  const holds = texts(r, "hold");
  assert.equal(holds.length, 1, `о сбросах не молчим, но и не шлём пять раз: ${holds.length}`);
  assert.match(holds[0], /Повышение доли биткоина откладывается\nКандидат «переходный» \(ступень 45 %\) продержался 41,5 ч из 48 и сорван 19\.08 20:53 UTC\. Цель остаётся 20 %/, holds[0]);
  assert.match(holds[0], /Причина: по свежим данным режим снова «ухудшается»: спрос неблагоприятен \(−25 при пороге −20\); сдвинулся показатель «Потоки в биткоин-ETF в США» \(ухудшился, источник отдал устаревшие данные\)/);
  assert.match(holds[0], /Отсчёт 48 часов начнётся заново, когда кандидат вернётся/);
  const alloc = texts(r, "allocation");
  assert.equal(alloc.length, 1, "само повышение приходит своим сообщением");
  assert.match(alloc[0], /Удержание до этого срывалось 5 раз: первый кандидат на повышение появился 18\.08 03:08 UTC/, alloc[0]);
});

testAsync("в причину сброса удержания идут только карточки среднесрочного контура", async () => {
  // Разница такта сборщика (tick_diff) несёт и краткосрочные карточки: на кандидата среднесрочного
  // режима они не влияют и причиной его смены быть не могут.
  const tick_diff = { families: [
    { block: "demand", family: "etf", id: "etf_regime", name: "US spot-ETF · режим потоков", from: 0, to: -0.5 },
    { block: "leverage", family: "oi", id: "oi_quality", name: "Качество движения · цена × OI", from: 0, to: -1 },
  ], detectors: [] };
  const oi = card("oi_quality", { block: "leverage", family: "oi", strategic: false, tactical: true, value: "OI стабилен" });
  const line = holdLine.slice(0, 2).map((o, k) => ({ ...o, metrics: [...btcSnap(o).metrics, oi], ...(k === 1 ? { extra: { tick_diff } } : {}) }));
  const text = texts(await runBot(timeline(line)), "hold")[0];
  assert.match(text, /сдвинулся показатель «Потоки в биткоин-ETF в США» \(0 → −0,5, источник отдал устаревшие данные\)\n/, text);
  assert.doesNotMatch(text, /Качество движения|oi_quality/, text);
});

testAsync("кандидат, мигнувший на четверть часа, сообщения о сбросе не даёт", async () => {
  const r = await runBot(timeline([
    { t: at(0), state: "defensive", candidate: "defensive" },
    { t: at(15), state: "defensive", candidate: "deteriorating", since: at(15), hold_until: at(15 + 2880), count: 1 },
    { t: at(30), state: "defensive", candidate: "defensive", count: 1 },
  ]));
  assert.equal(r.sent.length, 0, `кандидат прожил один снимок: ${r.sent.map((m) => m.title)}`);
});

/* ---- п. 4: ошибки кода ---- */

const flap = (targets) => timeline(targets.map((target, k) => target === 80
  ? { t: at(k * 1440), state: "deteriorating", candidate: "transition", table: "deteriorating", hold_until: at(k * 1440 + 2880), mvrv: 19.5, recovery: "good", conf: 2, target: 80, overlays: ["recovery_floor"] }
  : { t: at(k * 1440), state: "deteriorating", candidate: "deteriorating", mvrv: 19.5, recovery: "watch", conf: 1 }));

testAsync("повтор той же смены доли в пределах недели не глушится", async () => {
  // 20 → 80 → 20 → 80 → 20 с шагом в сутки: раньше доходили два сообщения из четырёх.
  const r = await runBot(flap([20, 80, 20, 80, 20]));
  assert.deepEqual(r.sent.map((m) => `${m.before}→${m.after}`), ["20%→80%", "80%→20%", "20%→80%", "80%→20%"]);
});

testAsync("повторное срабатывание детектора в пределах недели не глушится", async () => {
  const r = await runBot(timeline(["calm", "fired", "calm", "fired", "calm"].map((demand_break, k) => ({ t: at(k * 1440), state: "transition", demand_break }))));
  assert.deepEqual(r.sent.map((m) => `${m.kind}:${m.after}`), ["risk:СРАБОТАЛ", "risk:спокоен", "risk:СРАБОТАЛ", "risk:спокоен"]);
  assert.match(r.sent[0].text, /Совместное ухудшение спроса: ETF, стейблкоины, биржи, спот США\nспокоен → СРАБОТАЛ\nусловий 3 из 4/, r.sent[0].text);
});

testAsync("повторный прогон после сбоя смену доли не дублирует", async () => {
  // Идемпотентность: рассылка упала после отправки — база сравнения осталась прежней, индекс
  // доставленного уцелел. Следующий запуск (уже на следующем снимке) видит ту же смену заново
  // и обязан промолчать.
  const snaps = flap([20, 80, 80]);
  const first = await runBot(snaps.slice(0, 2));
  assert.equal(first.sent.length, 1);
  const crashed = { ...(await runBot([snaps[0]])).state, sent: first.state.sent };
  const again = await runBot([snaps[2]], { state: crashed });
  assert.equal(again.sent.length, 0, "ключ события — переход с меткой времени шага, а не запуска");
});

testAsync("пауза решения не стирает базу: 45 → пауза → 20 даёт сообщение о паузе и о новой доле", async () => {
  const r = await runBot(timeline([
    { t: at(0), state: "transition" },
    { t: at(15), state: "insufficient", candidate: "insufficient", target: null, missing: ["etf_regime", "stablecoin_regime | exchange_supply"] },
    { t: at(30), state: "deteriorating", candidate: "deteriorating", count: 2 },
  ]));
  assert.deepEqual(r.sent.map((m) => m.kind), ["pause", "allocation"], `пауза и новая доля — два сообщения: ${r.sent.map((m) => m.title)}`);
  assert.match(r.sent[0].text, /Решение о доле биткоина на паузе\nЦель не опубликована: не хватает данных — Потоки в биткоин-ETF в США; Объём стейблкоинов или Запас биткоинов на биржах/, r.sent[0].text);
  assert.match(r.sent[0].text, /Новых действий не предпринимать\. Последняя цель — 45 %/);
  assert.match(r.sent[1].text, /Решение возобновлено: доля биткоина сокращена\n45% → 20%/, r.sent[1].text);
  assert.match(r.sent[1].text, /Решение возобновлено после паузы \(с 19\.08 20:53 UTC\)/);
  assert.match(r.sent[1].text, /Что делать\n• Понижение — сразу/);
});

testAsync("пауза, после которой цель прежняя, закрывается коротким сообщением", async () => {
  const r = await runBot(timeline([
    { t: at(0), state: "transition" },
    { t: at(15), state: "insufficient", candidate: "insufficient", target: null },
    { t: at(30), state: "transition" },
  ]));
  assert.deepEqual(r.sent.map((m) => m.title), ["Решение о доле биткоина на паузе", "Решение о доле биткоина возобновлено"]);
  assert.match(r.sent[1].text, /Цель прежняя — 45 %/);
});

testAsync("мигающая пауза не превращается в пару сообщений на каждый такт", async () => {
  const pause = (min) => ({ t: at(min), state: "insufficient", candidate: "insufficient", target: null });
  const ok = (min) => ({ t: at(min), state: "transition" });
  const r = await runBot(timeline([ok(0), pause(15), ok(30), pause(45), ok(60), pause(75), ok(90), pause(8 * 60), ok(8 * 60 + 15)]));
  assert.deepEqual(r.sent.map((m) => `${m.k}:${m.title.replace("Решение о доле биткоина ", "")}`), ["1:на паузе", "2:возобновлено", "7:на паузе", "8:возобновлено"],
    "повтор паузы раньше шести часов идёт только в лог; через восемь часов — снова сообщение");
});

testAsync("аварийный режим — отдельное сообщение, а не шаблон обычной смены", async () => {
  const r = await runBot(timeline([
    { t: at(0), state: "transition" },
    { t: at(15), state: "emergency", candidate: "emergency", target: 0, overlays: ["emergency_override"], override: "НАРУШЕНИЕ ЦЕЛОСТНОСТИ РЫНКА" },
    { t: at(30), state: "transition", count: 1 },
  ]));
  assert.equal(r.sent.length, 2, `вход и выход, без отдельного сигнала о целостности: ${r.sent.map((m) => m.title)}`);
  const on = r.sent[0].text;
  assert.match(on, /^🚨 Аварийный режим: доля биткоина обнулена\n45% → 0%/, on);
  assert.match(on, /Сработал аварийный переключатель: нарушение целостности рынка \(peg 6,20%, spread 350 б\.п\.\)\. Цель обнулена независимо от режима/);
  assert.match(on, /Что делать\n• Понижение — сразу: убрать риск и ждать нормализации/);
  assert.match(on, /Что отменит\n• Аварийный режим снимается первым снимком без нарушения/);
  assert.doesNotMatch(on, /устойчив|уводит часть позиции|хуже прежней/);
  assert.match(r.sent[1].text, /Аварийный режим снят: доля биткоина увеличена\n0% → 45%/, r.sent[1].text);
  assert.match(r.sent[1].text, /Аварийный режим вернётся первым же снимком с нарушением целостности рынка/);
});

testAsync("пол капитуляции и потолок эйфории названы своими именами", async () => {
  const cap = (await runBot(timeline([
    { t: at(0), state: "defensive", mvrv: 11 },
    { t: at(15), state: "defensive", mvrv: 10, target: 40, overlays: ["capitulation_floor"] },
  ]))).sent[0].text;
  assert.match(cap, /Включён пол капитуляции 40 % поверх режима «защитный» \(ступень 5 %\)/, cap);
  assert.match(cap, /Причина: MVRV-перцентиль 11 → 10 — не выше 10/);
  assert.match(cap, /Пол капитуляции снимается одним снимком, если MVRV-перцентиль поднимется выше 10 \(сейчас 10\)\. Цель вернётся к ступени режима — 5 %/);
  assert.doesNotMatch(cap, /лучше прежней/);
  const euph = (await runBot(timeline([
    { t: at(0), state: "constructive", mvrv: 94 },
    { t: at(15), state: "constructive", mvrv: 95, target: 60, overlays: ["euphoria_safety_cap"] },
  ]))).sent[0].text;
  assert.match(euph, /Доля биткоина сокращена\n100% → 60%/);
  assert.match(euph, /Включён потолок эйфории 60 % при режиме «конструктивный» \(ступень 100 %\)/, euph);
  assert.match(euph, /Потолок снимается одним снимком, если MVRV-перцентиль опустится ниже 95 \(сейчас 95\)/);
  assert.doesNotMatch(euph, /хуже прежней/);
});

testAsync("шаги цели, пропущенные между запусками, названы поимённо", async () => {
  // 12.08: «80 → 45 → 5» за 15 минут. Бот, попавший только на крайние снимки, видел «80 → 5».
  const snaps = timeline([
    { t: at(0), state: "transition", mvrv: 18, recovery: "good", conf: 2, target: 80, overlays: ["recovery_floor"] },
    { t: at(15), state: "transition", candidate: "defensive", mvrv: 18, recovery: "watch", conf: 1, count: 1 },
    { t: at(30), state: "defensive", candidate: "defensive", mvrv: 18, recovery: "watch", conf: 1, count: 2, since: at(15) },
  ]);
  const r = await runBot(snaps, { only: [0, 2] });
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].text, /80% → 5%/);
  assert.match(r.sent[0].text, /Путь: 80 % → 45 % \(19\.08 20:53 UTC\) → 5 % \(19\.08 21:08 UTC\)\n• 80 % → 45 % — снят пол восстановления\n• Режим «переходный» → «защитный» \(ступень 5 %\), подтверждён вторым снимком подряд/, r.sent[0].text);
});

testAsync("смена, целиком уместившаяся между двумя запусками, оставляет след", async () => {
  const r = await runBot(flap([20, 80, 20]), { only: [0, 2] });
  assert.equal(r.sent.length, 1, "20 → 80 → 20 между запусками раньше не давало ничего");
  assert.match(r.sent[0].text, /Доля биткоина менялась между запусками\n.*\n\nЧто за этим стоит\n• Путь: 20 % → 80 % \(20\.08 20:38 UTC\) → 20 % \(21\.08 20:38 UTC\)/, r.sent[0].text);
  assert.match(r.sent[0].text, /Действий не требуется: цель снова 20 %/);
});

/* ---- карточки на отказавших входах, живой фид, обновление в ту же дату, цепочка ---- */

const dataSnap = (t, metrics, extra = {}) => btcSnap({ t, state: "transition", metrics, ...extra });
const stress = (o) => card("system_stress", { block: "macro", family: "stress", value: "нейтрально", value_num: -0.5, score: -0.5, observed_at: "2026-09-25T00:00:00.000Z", source: "FRED", ...o });

testAsync("карточка на отказавших входах не рассылается, а возврат источника не теряется", async () => {
  // 29.09: оба ряда VIX отказали, карточка стала «напряжение» со stale:true и ушла как «сильнейшее
  // движение с 08.04». Возврат в «нейтрально» не пришёл: в базе уже лежало значение без VIX.
  const day = (d) => `2026-09-${d}T00:00:00.000Z`;
  const snaps = [
    dataSnap("2026-09-28T23:53:00.000Z", [stress({})]),
    dataSnap("2026-09-29T00:08:00.000Z", [stress({ value: "напряжение", value_num: -1, score: -1, observed_at: day(28), stale: true })]),
    dataSnap("2026-09-29T18:23:00.000Z", [stress({ observed_at: day(28) })]),
    dataSnap("2026-09-30T20:23:00.000Z", [stress({ value: "напряжение", value_num: -1, score: -1, observed_at: day(29) })]),
  ];
  const r = await runBot(snaps);
  assert.deepEqual(r.sent.map((m) => m.k), [3], `ни ложной тревоги, ни ложного отбоя: ${r.sent.map((m) => `${m.k}: ${m.text}`)}`);
  assert.match(r.sent[0].text, /Кредитный и рыночный стресс: нейтрально → напряжение/);
});

testAsync("после отказа источника новое значение сравнивается с последним свежим", async () => {
  const day = (d) => `2026-09-${d}T00:00:00.000Z`;
  const r = await runBot([
    dataSnap("2026-09-28T23:53:00.000Z", [stress({})]),
    dataSnap("2026-09-29T00:08:00.000Z", [stress({ value: "напряжение", value_num: -1, score: -1, stale: true })]),
    dataSnap("2026-09-30T00:08:00.000Z", [stress({ value: "разлом", value_num: -2, score: -2, observed_at: day(29) })]),
  ]);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].text, /нейтрально \(за 25\.09\) → разлом/, `«было» — последнее свежее значение (и его дата), а не посчитанное на отказавших входах: ${r.sent[0].text}`);
});

test("суточная карточка с датой «сегодня 00:00 UTC» — публикация, а не живой фид", () => {
  // «Мощность сети» и «Объём стейблкоинов»: 0 сообщений при 66 и 13 сменах оценки — в момент
  // выхода наблюдению меньше шести часов, и карточка считалась живым фидом.
  const hash = (day, v, extra = {}) => card("network_security", { block: "cycle", family: "network", value: v, value_num: 0, score: 0, observed_at: `${day}T00:00:00.000Z`, source: "mempool.space", series: dailySeries(day, 30, (k, d) => 9e20 + (d % 7) * 1e18), ...extra });
  const live = card("funding", { value: "+0.003% / 8ч", value_num: 0.003, observed_at: "2026-09-16T00:14:00.000Z", vote: false });
  const tape = card("oi_quality", { value: "OI стабилен", observed_at: "2026-09-16T00:14:00.000Z", series: Array.from({ length: 30 }, (_, k) => ({ t: Date.parse("2026-09-16T00:14:00Z") - (29 - k) * 15 * 60e3, v: 6e9 + k })) });
  const cur = mute(() => fromSnapshotJSON(dataSnap("2026-09-16T00:15:00.000Z", [hash("2026-09-16", "ослабевает", { value_num: -1.5, score: -1.5 }), live, tape])));
  const byId = Object.fromEntries(cur.indicators.map((i) => [i.id, i]));
  assert.equal(byId.network_security.scheduled, true, "шаг ряда — сутки: это календарь публикации, каким бы свежим ни было наблюдение");
  assert.equal(byId.funding.scheduled, false, "карточка без ряда с минутной меткой — живой фид");
  assert.equal(byId.oi_quality.scheduled, false, "ряд с шагом в минуты — тоже живой фид");
  const prev = stateOf(mute(() => fromSnapshotJSON(dataSnap("2026-09-15T23:45:00.000Z", [hash("2026-09-15", "стабильна"), live, tape]))));
  const ev = mute(() => diff(prev, cur));
  assert.equal(ev.length, 1, `релиз голосующей карточки обязан прийти в момент выхода: ${ev.map((e) => e.title)}`);
  assert.equal(ev[0].moves[0].before, "стабильна");
  assert.equal(ev[0].moves[0].after, "ослабевает");
});

const etf = (o) => card("etf_1d", { family: "etf", vote: false, value: "-58 млн $", value_num: -58e6, score: null, observed_at: "2026-08-14T12:00:00.000Z", source: "The Block (tbstat)", ...o });
const sth = (o) => card("sth_pricing", { block: "cycle", family: "valuation", vote: false, value: "1.11", value_num: 1.11, score: null, observed_at: "2026-08-14T00:00:00.000Z", source: "bitview.space", ...o });

testAsync("пересмотр свежего значения в ту же дату не молчит", async () => {
  // 18.08: приток за 17.08 ушёл как +137 млн $, через четыре часа в снимке стоял +298 млн $.
  const d17 = "2026-08-17T12:00:00.000Z";
  const r = await runBot([
    dataSnap("2026-08-18T08:23:00.000Z", [etf({})]),
    dataSnap("2026-08-18T08:38:00.000Z", [etf({ value: "+137 млн $", value_num: 137e6, observed_at: d17 })]),
    dataSnap("2026-08-18T12:53:00.000Z", [etf({ value: "+298 млн $", value_num: 298e6, observed_at: d17 })]),
    dataSnap("2026-08-18T13:08:00.000Z", [etf({ value: "+298 млн $", value_num: 298e6, observed_at: d17 })]),
  ]);
  assert.deepEqual(r.sent.map((m) => m.k), [1, 2]);
  assert.match(r.sent[0].text, /Потоки в биткоин-ETF за день: -58 млн \$ → \+137 млн \$ \(смена на положительные значения\)\nданные за 17\.08\.2026/, r.sent[0].text);
  assert.match(r.sent[1].text, /Потоки в биткоин-ETF за день: \+137 млн \$ → \+298 млн \$\nобновление данных за 17\.08\.2026/, r.sent[1].text);
});

testAsync("«было» следующего сообщения равно «стало» предыдущего", async () => {
  // Карточка, которая плывёт с ценой между релизами: обновления в ту же дату для неё не шлются,
  // но и цепочка не рвётся — «было» берётся из прошлого сообщения, а не из прошлого такта.
  const r = await runBot([
    dataSnap("2026-08-15T02:00:00.000Z", [sth({})]),
    dataSnap("2026-08-16T02:00:00.000Z", [sth({ value: "1.10", value_num: 1.10, observed_at: "2026-08-15T00:00:00.000Z" })]),
    dataSnap("2026-08-16T14:00:00.000Z", [sth({ value: "1.08", value_num: 1.08, observed_at: "2026-08-15T00:00:00.000Z" })]),
    dataSnap("2026-08-17T02:00:00.000Z", [sth({ value: "1.07", value_num: 1.07, observed_at: "2026-08-16T00:00:00.000Z" })]),
  ]);
  assert.deepEqual(r.sent.map((m) => m.k), [1, 3], "дрейф внутри дня сообщением не становится");
  assert.match(r.sent[0].text, /1,11 → 1,10/);
  assert.match(r.sent[1].text, /1,10 → 1,07/, `читатель видел 1,10 — с него и начинается следующая строка: ${r.sent[1].text}`);
});

testAsync("приток на биржи приходит раз в сутки — при сдвиге даты, в общем сообщении об ончейн-данных", async () => {
  // Значение этой карточки обновляется за час до общей даты ончейн-набора (10.09.2026: число сменилось
  // в 02:23, дата набора — в 03:23). Отдельным «обновлением в ту же дату» оно уходило 45 раз за 84 дня.
  const nf = (label, num, d) => card("exchange_netflow_30d", { family: "exchange_supply", vote: false, value: label, value_num: num, score: null, observed_at: `2026-09-${d}T00:00:00.000Z`, source: "Coin Metrics" });
  const mv = (pct, d) => card("mvrv_cycle", { block: "cycle", family: "valuation", value: `${pct}-й перцентиль 4 лет`, value_num: pct, observed_at: `2026-09-${d}T00:00:00.000Z`, source: "Coin Metrics" });
  const r = await runBot([
    dataSnap("2026-09-10T00:08:00.000Z", [nf("-50 тыс. BTC", -50172, "08"), mv(39, "08")]),
    // 1: число сменилось, дата прежняя — отдельного сообщения нет
    dataSnap("2026-09-10T02:23:00.000Z", [nf("-58 тыс. BTC", -57843, "08"), mv(39, "08")]),
    // 2: дата набора сдвинулась; у притока в этот такт число уже то же — строка идёт всё равно
    dataSnap("2026-09-10T03:23:00.000Z", [nf("-58 тыс. BTC", -57843, "09"), mv(38, "09")]),
    // 3, 4: за сутки число сменилось дважды
    dataSnap("2026-09-11T01:38:00.000Z", [nf("-63 тыс. BTC", -63100, "09"), mv(38, "09")]),
    dataSnap("2026-09-11T01:53:00.000Z", [nf("-68 тыс. BTC", -68151, "09"), mv(38, "09")]),
    // 5: сдвиг даты — приходит последнее значение, «было» — из прошлого сообщения
    dataSnap("2026-09-11T02:24:00.000Z", [nf("-68 тыс. BTC", -68151, "10"), mv(36, "10")]),
    // 6, 7: источник отдал прошлый день и снова нынешний, число при этом другое — та же дата, второй строки нет
    dataSnap("2026-09-11T05:00:00.000Z", [nf("-70 тыс. BTC", -70000, "09"), mv(36, "09")]),
    dataSnap("2026-09-11T05:15:00.000Z", [nf("-70 тыс. BTC", -70000, "10"), mv(36, "10")]),
    // 8: настоящий сдвиг даты — значение, сменившееся в ту же дату, не потеряно
    dataSnap("2026-09-12T02:53:00.000Z", [nf("-70 тыс. BTC", -70000, "11"), mv(36, "11")]),
    // 9: дата сдвинулась, число то же, что читатель уже видел, — сообщения нет
    dataSnap("2026-09-13T02:53:00.000Z", [nf("-70 тыс. BTC", -70000, "12"), mv(36, "12")]),
  ]);
  assert.deepEqual(r.sent.map((m) => m.k), [2, 5, 8], `по одному сообщению на сдвиг даты: ${r.sent.map((m) => `${m.k}: ${m.text}`).join("\n")}`);
  assert.match(r.sent[0].text, /^📊 Ончейн-данные сети биткоина\n• Приток биткоинов на биржи за месяц: -50 тыс\. BTC → -58 тыс\. BTC\n• Оценка рынка биткоина \(MVRV\): 39-й перцентиль 4 лет → 38-й перцентиль 4 лет\nданные за 09\.09\.2026/, r.sent[0].text);
  assert.match(r.sent[1].text, /Приток биткоинов на биржи за месяц: -58 тыс\. BTC → -68 тыс\. BTC\n• Оценка рынка биткоина \(MVRV\): 38-й перцентиль 4 лет → 36-й перцентиль 4 лет\nданные за 10\.09\.2026/, `«было» равно «стало» прошлого сообщения: ${r.sent[1].text}`);
  assert.match(r.sent[2].text, /Приток биткоинов на биржи за месяц: -68 тыс\. BTC → -70 тыс\. BTC\nданные за 11\.09\.2026/, r.sent[2].text);
  assert.doesNotMatch(r.sent.map((m) => m.text).join("\n"), /обновление данных|-63 тыс/, "ни отдельного обновления в ту же дату, ни промежуточного значения");
});

testAsync("возврат источника к уже показанному значению и откат даты — не новости", async () => {
  const d = (n) => `2026-08-${n}T12:00:00.000Z`;
  const r = await runBot([
    dataSnap("2026-08-18T05:00:00.000Z", [etf({ observed_at: d(14) })]),
    dataSnap("2026-08-18T05:15:00.000Z", [etf({ value: "+137 млн $", value_num: 137e6, observed_at: d(17) })]),
    // источник отдал предыдущий торговый день, потом снова свежий — и так дважды
    dataSnap("2026-08-18T05:30:00.000Z", [etf({ observed_at: d(14) })]),
    dataSnap("2026-08-18T05:45:00.000Z", [etf({ value: "+137 млн $", value_num: 137e6, observed_at: d(17) })]),
    dataSnap("2026-08-18T06:00:00.000Z", [etf({ observed_at: d(14) })]),
    dataSnap("2026-08-18T06:15:00.000Z", [etf({ value: "+137 млн $", value_num: 137e6, observed_at: d(17) })]),
    // значение пропало совсем
    dataSnap("2026-08-18T06:30:00.000Z", [etf({ value: "—", value_num: null, observed_at: d(17) })]),
    dataSnap("2026-08-18T06:45:00.000Z", [etf({ value: "+137 млн $", value_num: 137e6, observed_at: d(17) })]),
  ]);
  assert.deepEqual(r.sent.map((m) => m.k), [1], `один релиз на одни данные: ${r.sent.map((m) => `${m.k}: ${m.text}`)}`);
});

testAsync("после простоя бота дата «было» названа", async () => {
  const tga = (o) => card("tga_daily", { block: "macro", family: "liquidity", vote: false, value: "$818 млрд", value_num: 818, score: null, observed_at: "2026-09-25T00:00:00.000Z", source: "fiscaldata", ...o });
  const r = await runBot([
    dataSnap("2026-09-26T20:00:00.000Z", [tga({})]),
    dataSnap("2026-09-27T20:00:00.000Z", [tga({})]),
    dataSnap("2026-10-01T20:00:00.000Z", [tga({ value: "$871 млрд", value_num: 871, observed_at: "2026-09-30T00:00:00.000Z" })]),
  ]);
  assert.match(r.sent[0].text, /\$818 млрд \(за 25\.09\) → \$871 млрд\nданные за 30\.09\.2026/, r.sent[0].text);
});

/* ---- п. 5: ревизии ---- */

const seriesCard = (pts, o = {}) => card("stablecoin_regime", { family: "stablecoins", value: "стабильно", source: "defillama", observed_at: "2026-08-10T00:00:00.000Z", series: pts, ...o });
const revise = (base, patch) => base.map((p, k) => (k in patch ? { ...p, v: patch[k] } : p));
const revDiff = (prevCard, curCard, extraPrev = {}, extraCur = {}) => {
  const prev = stateOf(mute(() => fromSnapshotJSON(dataSnap("2026-08-10T10:00:00.000Z", [prevCard], extraPrev))));
  return mute(() => diff(prev, fromSnapshotJSON(dataSnap("2026-08-10T10:15:00.000Z", [curCard], extraCur))));
};
const BASE_SERIES = dailySeries("2026-08-10", 30, (k) => 3.05e11 + k * 1e8);

test("пересчёт истории меньше 0,1 % в рассылку не идёт", () => {
  // 22 сообщения из 38 были о таком сдвиге, из них 12 — «3,177·10^11 → 3,177·10^11 (+0,00%)».
  const dust = revDiff(seriesCard(BASE_SERIES), seriesCard(revise(BASE_SERIES, { 10: BASE_SERIES[10].v * 1.0004, 11: BASE_SERIES[11].v * 0.99995 })));
  assert.equal(dust.length, 0, "сдвиг 0,04 % — не событие");
  const real = revDiff(seriesCard(BASE_SERIES), seriesCard(revise(BASE_SERIES, { 10: BASE_SERIES[10].v * 1.0058, 11: BASE_SERIES[11].v * 1.0003 })));
  assert.equal(real.length, 1);
  assert.equal(real[0].moves.length, 1, "в сообщении только точка со значимым сдвигом");
  assert.equal(real[0].moves[0].delta, "+0,58%");
});

test("процент пересмотра у отрицательных величин имеет верный знак", () => {
  const neg = dailySeries("2026-08-10", 30, (k) => -3e8 + k * 1e6);
  const ev = revDiff(seriesCard(neg, { id: "etf_5d", family: "etf", value: "-271 млн $", value_num: -2.71e8, vote: false }), seriesCard(revise(neg, { 5: -1.89e7 + 0 }), { id: "etf_5d", family: "etf", value: "-271 млн $", value_num: -2.71e8, vote: false }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].moves[0].before, "−295 млн $");
  assert.equal(ev[0].moves[0].after, "−18,9 млн $", "обе стороны — в одной единице, по большей из двух");
  assert.match(ev[0].moves[0].delta, /^\+/, `отток сократился — число выросло, знак «плюс»: ${ev[0].moves[0].delta}`);
});

// Одна переписанная точка суточного ряда карточки id: было from, стало to.
const unitRev = (id, from, to, o = {}) => {
  const base = dailySeries("2026-08-10", 30, () => from);
  const mk = (pts) => card(id, { value: "стабильно", source: "источник", observed_at: "2026-08-10T00:00:00.000Z", series: pts, ...o });
  return revDiff(mk(base), mk(revise(base, { 10: to })));
};

test("пересчёт истории печатается в единице ряда, а не сырым числом", () => {
  // «Мощность сети …: 9,463·10^20 → 9,404·10^20» и «Потоки в биткоин-ETF в США: -4 786,4 → -4 763,1»:
  // число без единицы читателю ничего не говорит. Единица и имя величины ряда — из словаря.
  const cases = [
    ["network_security", 9.463e20, 9.404e20, "Мощность сети биткоина", "946,3 EH/s", "940,4 EH/s"],
    ["etf_regime", -4786.4, -4763.1, "Потоки в биткоин-ETF за месяц в пересчёте на биткоины", "−4 786 BTC", "−4 763 BTC"],
    ["etf_regime", 29019.8, 28120.4, "Потоки в биткоин-ETF за месяц в пересчёте на биткоины", "29,02 тыс. BTC", "28,12 тыс. BTC"],
    // обе стороны — в одной единице, по большей из двух: не «9 990 BTC → 10,02 тыс. BTC»
    ["etf_regime", 9990, 10020, "Потоки в биткоин-ETF за месяц в пересчёте на биткоины", "9,99 тыс. BTC", "10,02 тыс. BTC"],
    ["etf_1d", -2.25e7, -1.89e7, "Потоки в биткоин-ETF за день", "−22,5 млн $", "−18,9 млн $"],
    ["etf_20d", 2.454e9, 2.4601e9, "Потоки в биткоин-ETF за месяц", "2,454 млрд $", "2,46 млрд $"],
    ["stablecoin_regime", 3.037e11, 3.055e11, "Объём стейблкоинов", "303,7 млрд $", "305,5 млрд $"],
    ["g3_liquidity", 17.53, 17.56, "Совокупные балансы ФРС, ЕЦБ и Банка Японии", "17,53 трлн $", "17,56 трлн $"],
    ["sth_pricing", 77907.5, 80024.2, "Средняя цена покупки недавних держателей", "77 908 $", "80 024 $"],
    ["miner_regime", 2.896e-14, 3.198e-14, "Доход майнеров на единицу мощности", "28,96 $ за PH/s в сутки", "31,98 $ за PH/s в сутки"],
    ["mvrv_cycle", 1.5191, 1.5343, "MVRV — цена биткоина к средней цене покупки всех монет", "1,519", "1,534"],
    ["liquidity_regime", 5864.97, 5901.2, "Чистая ликвидность ФРС", "5,865 трлн $", "5,901 трлн $"],
    ["tga_daily", 887.469, 871.2, "Счёт Минфина США в ФРС (ежедневно)", "887,5 млрд $", "871,2 млрд $"],
    ["exchange_supply", 2672865.6, 2661210.4, "Запас биткоинов на биржах", "2,673 млн BTC", "2,661 млн BTC"],
    ["two_year", 4.75, 4.63, "Доходность 2-летних облигаций США", "4,75 %", "4,63 %"],
  ];
  for (const [id, from, to, name, before, after] of cases) {
    const ev = unitRev(id, from, to);
    assert.equal(ev.length, 1, `${id}: пересчёт обязан прийти`);
    const m = ev[0].moves[0];
    assert.deepEqual([m.name, m.before.replace(/ /g, " "), m.after.replace(/ /g, " ")], [name, before, after], id);
    assert.doesNotMatch(renderMessage(ev[0], ""), /10\^/, `${id}: никаких степеней десяти`);
  }
});

test("порог пересчёта считается от величины точки и у ряда с малыми числами", () => {
  // Доход майнеров на единицу мощности лежит в ряду числами порядка 4·10^−14: пересчёт на 1 % — событие,
  // на 0,03 % — пыль, как у любого другого ряда.
  const real = unitRev("miner_regime", 4.0e-14, 4.04e-14);
  assert.equal(real.length, 1, "пересчёт на 1 % обязан прийти");
  assert.deepEqual([real[0].moves[0].before, real[0].moves[0].after], ["40 $ за PH/s в сутки", "40,4 $ за PH/s в сутки"]);
  assert.match(real[0].moves[0].delta, /^\+1,0+%$/, real[0].moves[0].delta);
  assert.equal(unitRev("miner_regime", 4.0e-14, 4.001e-14).length, 0, "сдвиг 0,03 % — не событие");
});

test("у каждой карточки BTC-панели с пересчётами за окно объявлена единица ряда", () => {
  // Десять карточек, чьи пересчёты истории уходили за 19.07–10.10.2026 (38 сообщений до правок, 15 после).
  for (const id of ["network_security", "miner_regime", "stablecoin_regime", "etf_regime", "etf_1d", "etf_5d", "etf_20d", "g3_liquidity", "sth_pricing", "mvrv_cycle"]) {
    assert.equal(typeof HUMAN[id]?.s?.u, "string", `${id}: единица ряда не объявлена`);
  }
  // у макро-панели ряды природу не объявляют — в словаре у её карточек единицы ряда нет
  for (const id of Object.keys(MACRO_CADENCE)) assert.equal(HUMAN[id]?.s, undefined, `${id}: карточка макро-панели`);
});

test("без объявленной единицы ряда точка пересчёта печатается как раньше", () => {
  // макро-панель: её ряды природу не объявляют, поведение прежнее
  const pts = { [day("2026-07-01")]: 9.463e20, [day("2026-07-02")]: 9.5e20, [day("2026-07-03")]: 9.6e20 };
  const before = stateOf(panelOf([withPoints(pts)]));
  const ev = diff(before, panelOf([withPoints({ ...pts, [day("2026-07-01")]: 9.404e20 })]));
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].moves[0].before, ev[0].moves[0].after], ["9,463·10^20", "9,404·10^20"]);
  // новая карточка BTC-панели без записи в словаре: число сырое, а в логе — громкая строка
  const raw = unitRev("brand_new_card", 3.037e11, 3.055e11);
  assert.equal(raw[0].moves[0].before, "3,037·10^11");
  const said = [];
  const realLog = console.log;
  console.log = (...a) => said.push(a.join(" "));
  try {
    fromSnapshotJSON(dataSnap("2026-08-10T10:00:00.000Z", [card("brand_new_card", { series: dailySeries("2026-08-10", 30, () => 3.037e11) }), card("trend_regime", { series: dailySeries("2026-08-10", 30, () => 82737) })]));
  } finally { console.log = realLog; }
  assert.ok(said.some((l) => /не объявлена единица ряда у карточек — brand_new_card \(/.test(l)), `о карточке без единицы ряда лог обязан сказать, о тихой карточке — нет: ${said.join(" | ")}`);
});

test("карточки с одинаковыми числами, но разными единицами в одну строку не склеиваются", () => {
  // хешрейт лежит и в ряду «Мощности сети» (H/s → EH/s), и мог бы лежать в ряду новой карточки без единицы
  const base = dailySeries("2026-08-10", 30, () => 9.463e20);
  const pair = (pts) => [card("network_security", { block: "cycle", family: "network", value: "стабильна", source: "mempool.space", observed_at: "2026-08-10T00:00:00.000Z", series: pts }),
    card("brand_new_card", { value: "стабильна", vote: false, source: "mempool.space", observed_at: "2026-08-10T00:00:00.000Z", series: pts })];
  const prev = stateOf(mute(() => fromSnapshotJSON(dataSnap("2026-08-10T10:00:00.000Z", pair(base)))));
  const ev = mute(() => diff(prev, fromSnapshotJSON(dataSnap("2026-08-10T10:15:00.000Z", pair(revise(base, { 10: 9.404e20 }))))));
  assert.equal(ev.length, 1, "одна переписанная точка первоисточника — одно сообщение");
  assert.deepEqual(ev[0].moves.map((m) => `${m.name}: ${m.before} → ${m.after}`).sort(), ["brand_new_card: 9,463·10^20 → 9,404·10^20", "Мощность сети биткоина: 946,3 EH/s → 940,4 EH/s"]);
});

test("смена источника ряда не выдаётся за пересмотр", () => {
  const other = BASE_SERIES.map((p) => ({ ...p, v: p.v * 1.12 }));
  const bySource = revDiff(seriesCard(BASE_SERIES, { source: "mempool.space" }), seriesCard(other, { source: "Blockchain.com network fallback" }));
  assert.equal(bySource.length, 0, "у карточки сменился источник: это другой ряд, а не переписанная история");
  // строка источника карточки та же, но сборщик сменил поставщика набора данных — ряд переписан целиком
  const byProvider = revDiff(seriesCard(BASE_SERIES), seriesCard(other),
    { sources: { network: { state: "ok", source: "mempool.space" } } }, { sources: { network: { state: "ok", source: "Blockchain.com network fallback" } } });
  assert.equal(byProvider.length, 0);
  // точечный пересмотр в тот же такт остаётся пересмотром
  const point = revDiff(seriesCard(BASE_SERIES), seriesCard(revise(BASE_SERIES, { 10: BASE_SERIES[10].v * 1.02 })),
    { sources: { network: { state: "ok", source: "mempool.space" } } }, { sources: { network: { state: "ok", source: "Blockchain.com network fallback" } } });
  assert.equal(point.length, 1, "одна переписанная точка — не подмена ряда");
});

/* ---- п. 6: подписи величин ---- */

test("2-летка подписана тем, что на ней напечатано: изменение за 4 недели, рядом уровень", () => {
  const two = (o) => card("two_year", { block: "macro", family: "conditions", vote: false, value: "-3 б.п.", value_num: -3, score: null, delta: "4.71%", source: "fred", observed_at: "2026-10-07T00:00:00.000Z", ...o });
  const prev = stateOf(mute(() => fromSnapshotJSON(dataSnap("2026-10-08T20:00:00.000Z", [two({})]))));
  const ev = mute(() => diff(prev, fromSnapshotJSON(dataSnap("2026-10-09T20:00:00.000Z", [two({ value: "+10 б.п.", value_num: 10, delta: "4.75%", observed_at: "2026-10-08T00:00:00.000Z" })]))));
  assert.equal(ev[0].moves[0].name, "Изменение доходности 2-летних облигаций США за 4 недели");
  assert.match(ev[0].moves[0].delta, /сама доходность 4,75%/, ev[0].moves[0].delta);
});

test("метка «сильнейшее движение» считается по той же величине, что напечатана", () => {
  // Ряд карточки — цена в долларах, значение — отношение: шаг ряда огромный, а напечатано 1,11 → 1,10.
  const priceSeries = (last) => dailySeries("2026-08-15", 40, (k) => (k === 39 ? last : 70000 + (k % 2 ? 50 : -50)));
  const ratio = (o) => card("realized_pnl", { block: "cycle", family: "valuation", vote: false, value: "1.11", value_num: 1.11, score: null, source: "bitview.space", observed_at: "2026-08-14T00:00:00.000Z", series: priceSeries(70000), ...o });
  const prev = stateOf(mute(() => fromSnapshotJSON(dataSnap("2026-08-15T02:00:00.000Z", [ratio({})]))));
  const cur = mute(() => fromSnapshotJSON(dataSnap("2026-08-16T02:00:00.000Z", [ratio({ value: "1.10", value_num: 1.10, observed_at: "2026-08-15T00:00:00.000Z", series: priceSeries(90000) })])));
  assert.equal(cur.indicators[0].series_is_value, false, "ряд — другая величина, чем значение карточки");
  const ev = mute(() => diff(prev, cur));
  assert.equal(ev[0].moves[0].delta, "", `по чужой величине метка не ставится: ${ev[0].moves[0].delta}`);
  // когда ряд — та же величина, что и значение, метка считается по нему, как прежде
  const same = (v, last) => card("etf_1d", { family: "etf", vote: false, value: `${v} млн $`, value_num: last, score: null, source: "The Block (tbstat)", observed_at: "2026-08-14T00:00:00.000Z", series: dailySeries("2026-08-15", 40, (k) => (k === 39 ? last : (k % 2 ? 1e6 : -1e6))) });
  const p2 = stateOf(mute(() => fromSnapshotJSON(dataSnap("2026-08-15T02:00:00.000Z", [same("+1", 1e6)]))));
  const c2 = mute(() => fromSnapshotJSON(dataSnap("2026-08-16T02:00:00.000Z", [{ ...same("+900", 900e6), observed_at: "2026-08-15T00:00:00.000Z" }])));
  assert.equal(c2.indicators[0].series_is_value, true);
  assert.match(mute(() => diff(p2, c2))[0].moves[0].delta, /движение/);
});

testAsync("метка движения по накопленной истории показанной величины", async () => {
  // у карточки-перцентиля ряд — отношение; история самого перцентиля копится ботом по датам
  const pct = (day, v) => card("mvrv_cycle", { block: "cycle", family: "valuation", value: `${v}-й перцентиль 4 лет`, value_num: v, observed_at: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`, source: "Coin Metrics", series: dailySeries("2026-08-30", 30, (k) => 1.2 + k * 0.001) });
  // пятнадцать суток обычного хода (шаги от 1 до 5 перцентилей, к концу — по одному) и скачок на 20
  const values = [30, 35, 31, 36, 32, 37, 33, 36, 34, 37, 35, 36, 35, 36, 35, 55];
  const snaps = values.map((v, k) => dataSnap(`2026-08-${String(k + 2).padStart(2, "0")}T02:00:00.000Z`, [pct(k + 1, v)]));
  const r = await runBot(snaps);
  assert.equal(r.sent.length, 15, "каждые сутки — релиз");
  const last = r.sent.at(-1).text;
  assert.match(last, /35-й перцентиль 4 лет → 55-й перцентиль 4 лет \(заметное движение\)/, last);
  assert.ok(r.sent.slice(0, -1).every((m) => !/движение/.test(m.text)), "рядовые шаги меткой не помечаются — ни пока истории мало, ни когда её хватает");
});

test("«смена на положительные значения» не ставится словесным карточкам", () => {
  const cot = (o) => card("institutional_quality", { family: "institutional", value: "ETF-поток частично похож на basis trade", value_num: -1, score: -1, source: "CFTC", observed_at: "2026-08-04T00:00:00.000Z", ...o });
  const prev = stateOf(mute(() => fromSnapshotJSON(dataSnap("2026-08-07T19:00:00.000Z", [cot({})]))));
  const ev = mute(() => diff(prev, fromSnapshotJSON(dataSnap("2026-08-14T19:00:00.000Z", [cot({ value: "направленный спрос", value_num: 1, score: 1, observed_at: "2026-08-11T00:00:00.000Z" })]))));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].moves[0].delta, "", `число словесной карточки — балл, а не величина: ${ev[0].moves[0].delta}`);
});

test("ноль — не положительное значение", () => {
  // Раньше ноль считался и положительным, и отрицательным — смотря откуда пришли: балл −1 → 0
  // помечался «сменой на положительные значения».
  const before = stateOf(panelOf([ind({ value: "-5", value_num: -5 })]));
  const ev = diff(before, panelOf([ind({ value: "0", value_num: 0, observed_at: "2026-07-21" })]));
  assert.equal(ev[0].moves[0].delta, "", `в ноль пришли, знак не сменили: ${ev[0].moves[0].delta}`);
});

test("потоки ETF не округляются до целых миллиардов", () => {
  assert.equal(fmtValue({ value: "+3 млрд $", value_num: 3.44e9 }), "+3,4 млрд $");
  assert.equal(fmtValue({ value: "+4 млрд $", value_num: 3.54e9 }), "+3,5 млрд $", "3,44 → 3,54 раньше читалось как «+3 → +4»");
  assert.equal(fmtValue({ value: "-7 тыс. BTC", value_num: -7300 }), "-7,3 тыс. BTC");
  assert.equal(fmtValue({ value: "+137 млн $", value_num: 137.4e6 }), "+137 млн $", "подпись с тремя значащими цифрами не трогается");
  assert.equal(fmtValue({ value: "$5 млрд", value_num: 5.2 }), "$5,2 млрд", "число уже в единицах подписи");
  assert.equal(fmtValue({ value: "+4 млрд $", value_num: null }), "+4 млрд $", "нет точного числа — подпись как есть");
  assert.equal(fmtValue({ value: "+4 млрд $", value_num: 812 }), "+4 млрд $", "число не сходится с подписью — подпись как есть");
});

/* ---- п. 7: качество данных и предупреждения сборщика ---- */

testAsync("неполные данные названы в сообщении о доле источником и не обрезаются", async () => {
  // Прежняя оговорка шла последней строкой и выпадала под правилом «не больше трёх строк».
  const sources = { blockchain_onchain: { state: "partial", source: "Blockchain.com · bitcoin-data.com" }, sth_onchain: { state: "fail", source: "bitcoindata", decision_relevant: false }, fred_DGS2: { state: "ok", source: "FRED API" } };
  const text = (await runBot(upgrade({ log: UP_LOG, quality: "degraded", sources }))).sent[0].text;
  assert.match(text, /Данные неполны: Ончейн-данные сети биткоина \(частично\) — показатели этой смены не затронуты/, text);
  assert.doesNotMatch(text, /degraded|осторожнее|bitcoindata/, "ни внутреннего кода, ни оговорки, ни источника без голоса");
  const hit = (await runBot(upgrade({ log: UP_LOG, quality: "degraded", sources, metrics: [card("institutional_quality", { family: "institutional", stale: true })] }))).sent[0].text;
  assert.match(hit, /Данные неполны: Ончейн-данные сети биткоина \(частично\)\. На устаревших данных сейчас показатель этой смены: «Позиции фондов во фьючерсах CME \(отчёт CFTC\)»/, hit);
});

const WARN = [{ source: "coinmetrics", code: "exchange_flow_supply_mismatch", value: -61725, threshold: 5000, unit: "BTC за 30 дней", text: "Потоки бирж расходятся с остатком на 61,7 тыс. BTC за 30 дней", affects: ["exchange_supply", "exchange_netflow_30d"] }];
const warnSnap = (min, data_warnings) => ({ t: at(min), state: "transition", extra: data_warnings === undefined ? {} : { data_warnings } });

testAsync("предупреждение о данных: одно сообщение при появлении и одно при снятии", async () => {
  const drift = [{ ...WARN[0], text: "Потоки бирж расходятся с остатком на 58,2 тыс. BTC за 30 дней" }];
  const r = await runBot(timeline([
    warnSnap(0, []), warnSnap(15, WARN), warnSnap(30, WARN), warnSnap(45, drift), warnSnap(60, WARN),
    // мигнуло: пропало на полчаса и вернулось
    warnSnap(75, []), warnSnap(90, []), warnSnap(105, WARN),
    // снято: шесть часов подряд предупреждения нет
    warnSnap(120, []), warnSnap(120 + 5 * 60, []), warnSnap(120 + 6 * 60, []), warnSnap(120 + 7 * 60, []),
  ]));
  assert.deepEqual(r.sent.map((m) => `${m.k}:${m.title}`), ["2:Предупреждение о данных", "10:Предупреждение о данных снято"], "ни повтора при смене числа, ни пары сообщений на мигание");
  assert.match(r.sent[0].text, /^🧩 Предупреждение о данных\n• Потоки бирж расходятся с остатком на 61,7 тыс\. BTC за 30 дней — затронуты: «Запас биткоинов на биржах», «Приток биткоинов на биржи за месяц»$/, r.sent[0].text);
});

testAsync("предупреждение, висящее неделями, не повторяется", async () => {
  // индекс доставленного живёт семь суток — память об объявленном от него не зависит
  const day = 1440;
  const r = await runBot(timeline([warnSnap(0, []), warnSnap(15, WARN), warnSnap(30, WARN), warnSnap(8 * day, WARN), warnSnap(16 * day, WARN), warnSnap(24 * day, WARN)]));
  assert.deepEqual(r.sent.map((m) => `${m.k}:${m.title}`), ["2:Предупреждение о данных"]);
});

testAsync("предупреждение, мигнувшее на один снимок, не объявляется", async () => {
  const r = await runBot(timeline([warnSnap(0, []), warnSnap(15, WARN), warnSnap(30, []), warnSnap(10 * 60, [])]));
  assert.equal(r.sent.length, 0);
});

testAsync("снимок прежней формы без поля предупреждений ничего не снимает", async () => {
  const r = await runBot(timeline([warnSnap(0, WARN), warnSnap(15, WARN), warnSnap(30, WARN), warnSnap(45, undefined), warnSnap(10 * 60, undefined), warnSnap(10 * 60 + 15, WARN)]));
  assert.deepEqual(r.sent.map((m) => m.title), [], "первый запуск принял висящее предупреждение за известное; исчезновение ПОЛЯ — не снятие");
});

/* ---- п. 9: вход модели ---- */

testAsync("во входе модели о смене доли есть причина, цена, режим, кандидат и оверлей", async () => {
  const snaps = floorOn();
  const r = await runBot(snaps);
  const input = llmInput([r.sent[0].ev], mute(() => fromSnapshotJSON(snaps[1])));
  for (const needle of ["цена биткоина 69 116 $", "снимок 19.08 20:53 UTC", "доля биткоина 80 %", "режим «ухудшается» (ступень 20 %)", "кандидат «переходный», на удержании до 21.08 20:53 UTC", "оверлей: пол восстановления",
    "детектор разворота подтверждён", "Повышение — траншами со следующей сессии", "Пол снимается одним снимком"]) {
    assert.ok(input.replace(/ /g, " ").includes(needle), `во входе нет «${needle}»`);
  }
  assert.doesNotMatch(input, /"stability"|Шаткое|Умеренно устойчивое/, "класса устойчивости, который модель пересказывала бы, больше нет");
});

testAsync("разбор модели о смене доли: честный идёт в сообщение, с посторонним числом — заменяется шаблоном", async () => {
  // Весь путь разом: main() → запрос модели (сеть подменена) → сверка чисел → текст сообщения.
  const send = async (txt) => {
    let r;
    await quiet(async () => { r = await withFetch(reply(txt), () => runBot(upgrade({ log: UP_LOG }))); });
    return r.sent[0].text;
  };
  const honest = await send("===0===\nЦель поднята с 20 до 45 %: режим выдержал удержание, цена биткоина — 86 198 долларов.");
  assert.match(honest, /💬 Цель поднята с 20 до 45 %: режим выдержал удержание, цена биткоина — 86 198 долларов\./, honest);
  const invented = await send("===0===\nЦель поднята до 45 %, а ставка ФРС при этом остаётся на уровне 5,25 %.");
  assert.doesNotMatch(invented, /5,25/, "числа, которого модели не давали, в сообщении быть не должно");
  assert.match(invented, /💬 Режим улучшился и выдержал удержание/, "вместо отброшенного разбора — шаблон из записи решения");
});

test("история показателя идёт во вход в тех же единицах, что и значение", () => {
  // «Потоки ETF за день: -58 млн $ → +137 млн $» и рядом история той же строки «-5,800·10^7 …».
  const flow = (day, label, num) => card("etf_1d", { family: "etf", vote: false, value: label, value_num: num, score: null, source: "The Block (tbstat)", observed_at: `${day}T12:00:00.000Z`, series: dailySeries(day, 30, (k, d) => (k === 29 ? num : ((d % 30) - 15) * 2e7)) });
  const prev = stateOf(mute(() => fromSnapshotJSON(dataSnap("2026-08-17T05:00:00.000Z", [flow("2026-08-14", "-58 млн $", -58e6)]))));
  const ev = mute(() => diff(prev, fromSnapshotJSON(dataSnap("2026-08-18T05:00:00.000Z", [flow("2026-08-17", "+137 млн $", 137e6)]))));
  assert.match(ev[0].history[0], /последние наблюдения: .*17\.08\.2026 137 млн \$/, ev[0].history[0]);
  assert.doesNotMatch(ev[0].history[0], /10\^/, "сырые доллары рядом с миллионами — разные единицы под одним именем");
});

test("панель, не объявляющая природу ряда, получает историю числами ряда", () => {
  // Макро-панель: на карточке изменение за четыре недели в базисных пунктах, в ряду — уровень.
  // Единица подписи к числам ряда не относится, и приписывать её нельзя.
  const before = stateOf(panelOf([ind({ value: "+41 б.п.", value_num: 41, points: seriesPoints(flat) })]));
  const ev = diff(before, panelOf([ind({ value: "+46 б.п.", value_num: 46, observed_at: "2026-07-21", points: seriesPoints([...flat, 1]) })]));
  assert.match(ev[0].history[0], /последние наблюдения: .*диапазон/, ev[0].history[0]);
  assert.doesNotMatch(ev[0].history[0], /б\.п\./, `у ряда своя величина: ${ev[0].history[0]}`);
});

/* ---- п. 10: база частот у BTC-панели ---- */

const logRow = (min, from, to, overlays_from, overlays_to, regimes = ["deteriorating", "deteriorating"]) => ({
  t: at(min), from_pct: from, to_pct: to, direction: to > from ? "up" : "down", price: 65000, strategic_from: regimes[0], strategic_to: regimes[1],
  overlays_from, overlays_to, kind: overlays_from.length !== overlays_to.length ? "overlay" : "regime", cause: { text: "причина", families: [], detectors: [], candidate_since: at(min) },
});

testAsync("база частот — по сменам того же рода: вход на пол считается среди входов на пол", async () => {
  const F = ["recovery_floor"];
  // три прошлых входа на пол (с разных ступеней) сняты через 48, 95 и 7 часов; между ними — смены по режиму
  const past = [
    logRow(-40000, 20, 80, [], F), logRow(-40000 + 48 * 60, 80, 45, F, [], ["transition", "transition"]),
    logRow(-30000, 45, 5, [], [], ["transition", "defensive"]),
    logRow(-20000, 5, 80, [], F, ["defensive", "defensive"]), logRow(-20000 + 95 * 60, 80, 45, F, [], ["transition", "transition"]),
    logRow(-10000, 45, 20, [], [], ["transition", "deteriorating"]),
    logRow(-5000, 20, 80, [], F), logRow(-5000 + 7 * 60, 80, 20, F, []),
  ];
  const now = logRow(15, 20, 80, [], F);
  const text = (await runBot(floorOn({ log: [...past, now] }))).sent[0].text;
  assert.match(text, /Пол восстановления включался 3 раза: следующая смена цели наступала через 48 ч, 4 сут, 7 ч/, text);
  // двух случаев мало — строка не печатается
  const few = (await runBot(floorOn({ log: [...past.slice(3), now] }))).sent[0].text;
  assert.doesNotMatch(few, /включался|Такая же смена/, few);
});

/* ---- сверка правил движка и осторожный режим ---- */

test("таблица режимов бота сходится с движком на каждом режиме лестницы", () => {
  for (const state of Object.keys(REGIME_BLOCKS)) {
    const eng = mute(() => fromSnapshotJSON(btcSnap({ state }))).allocation.engine;
    assert.equal(engineAgrees(eng), true, `режим ${state}: оценки ${JSON.stringify(eng.blocks)} обязаны давать его же`);
  }
  // детектор разворота поднимает защитный и ухудшающийся режим до переходного
  const lifted = mute(() => fromSnapshotJSON(btcSnap({ state: "deteriorating", candidate: "transition", table: "deteriorating", recovery: "good", mvrv: 19, conf: 2 }))).allocation.engine;
  assert.equal(engineAgrees(lifted), true);
  const wrong = mute(() => fromSnapshotJSON(btcSnap({ state: "transition", blocks: REGIME_BLOCKS.defensive }))).allocation.engine;
  assert.equal(engineAgrees(wrong), false, "оценки говорят «защитный», движок — «переходный»: правила разошлись");
});

testAsync("незнакомый контракт движка: чужое правило ему не приписывается", async () => {
  const text = (await runBot(upgrade({ log: UP_LOG, model_id: "btc-model-policy-v2" }))).sent[0].text;
  assert.match(text, /20% → 45%/);
  assert.match(text, /Причина: блок «Спрос» вышел/, "причина из журнала от правил бота не зависит");
  assert.doesNotMatch(text, /Что делать|если оценка спроса/, `ни правила исполнения, ни порога из замороженной v1: ${text}`);
  assert.match(text, /Что отменит\n• Понижение принимается вторым снимком подряд/);
});

testAsync("упавшие тесты не выключают сообщения о доле", async () => {
  // Раньше красный шаг тестов в notify.yml молча отключал рассылку целиком.
  const tga = (v, day) => card("tga_daily", { block: "macro", family: "liquidity", vote: false, value: `$${v} млрд`, value_num: v, score: null, observed_at: `2026-08-${day}T00:00:00.000Z`, source: "fiscaldata" });
  const base = [card("mvrv_cycle", { block: "cycle", family: "valuation", value: "42-й перцентиль 4 лет", value_num: 42 })];
  const snaps = timeline([
    { t: at(0), state: "deteriorating", candidate: "transition", since: SINCE, hold_until: at(15), metrics: [...base, tga(818, 17)] },
    { t: at(15), state: "transition", since: SINCE, metrics: [...base, tga(822, 18)] },
    { t: at(30), state: "transition", since: SINCE, metrics: [...base, tga(871, 19)] },
  ]);
  const r = await runBot(snaps, { selftest: "failure" });
  assert.deepEqual(r.sent.map((m) => `${m.k}:${m.kind}`), ["1:service", "1:allocation"], `доля идёт, данные придержаны, о сбое сказано один раз: ${r.sent.map((m) => `${m.k}:${m.kind}`)}`);
  assert.match(r.sent[0].text, /^🛠 Тесты уведомлений не проходят\nИдут только сообщения о решении, сигналы риска и предупреждения о данных\. Публикации и пересмотры не рассылаются, пока тесты не починены/);
  const healthy = await runBot(snaps);
  assert.deepEqual(healthy.sent.map((m) => `${m.k}:${m.kind}`), ["1:allocation", "1:release", "2:release"], "в обычном режиме поток данных идёт как всегда");
});

/* ---- первый запуск после выкладки: состояние прежнего формата + снимок новой формы ---- */

// Состояние в том виде, в каком его писала версия бота до правок (форма snapshotState и
// fromSnapshotJSON на коммите cd276564): факты движка россыпью, без памяти о показанном.
function legacyState(snap) {
  const p = mute(() => fromSnapshotJSON(snap));
  const indicators = {};
  for (const i of p.indicators) indicators[i.id] = { value: i.value, value_num: i.value_num, unit: i.unit, zone: null, score: i.score, observed_at: i.observed_at, degraded: false, points: i.points || null };
  const blocks = {};
  for (const [k, b] of Object.entries(snap.blocks)) { const n = Object.keys(b.strategic.families).length; blocks[k] = { title: k, score: b.strategic.score, families: n, step: 50 / n }; }
  const dec = snap.decision;
  return {
    version: 1,
    updated_at: snap.generated_at,
    generated_at: snap.generated_at,
    verdict: { word: "ВЕРДИКТ" },
    allocation: Number.isFinite(dec.target_pct) ? {
      pct: dec.target_pct, regime: snap.regime.strategic, ladder: dec.regime_targets_pct, overlays: dec.binding_overlays, reasons: dec.reason_codes, quality: dec.quality.status,
      blocks, bands: { adverse: -20, supportive: 20 }, hold: snap.regime_meta.strategic,
      sample: { t: Date.parse(snap.generated_at), pct: dec.target_pct, score: -10, blocks: {} }, changes: [],
    } : null,
    indicators,
    detectors: Object.fromEntries(snap.detectors.map((d) => [d.id, { state: d.state }])),
    revisions: [],
    sent: { "alloc:45->20|45%→20%|": "2026-08-16T02:10:14.000Z" },
    revised_points: {},
    alloc_trend: [{ t: Date.parse(snap.generated_at), pct: dec.target_pct, score: -10, blocks: {} }],
    alloc_changes: [{ t: Date.parse("2026-08-16T02:08:44Z"), from: 45, to: 20 }],
  };
}
const NEW_FORM = (birthT) => ({
  regime_birth: { strategic: { t: birthT, candidate: "transition", from_candidate: "deteriorating", price: 81092.7, blocks: { demand: { from: -31.25, to: -18.75, band_from: "adverse", band_to: "neutral" } }, families: [], detectors: [], note: null } },
  tick_diff: { families: [], detectors: [] },
  valuation_levels: { as_of: at(0), mvrv: 1.52, realized_price_usd: 54332, window_days: 1460, levels: [{ key: "recovery_anchor", percentile: 25, mvrv: 1.34, price_usd: 72800 }] },
  data_warnings: WARN,
});
// Журнал монитора на снимке новой формы несёт и старые смены — они старше базы сравнения бота.
// Здесь это вход на пол и его снятие неделю назад: цепочка «20 → 80 → 20», которая начинается и
// кончается нынешней долей. Принятая за свежую, она дала бы ложное «доля менялась между запусками».
const OLD_LOG = [logRow(-9000, 20, 80, [], ["recovery_floor"]), logRow(-8500, 80, 20, ["recovery_floor"], [])];

testAsync("первый запуск после выкладки: ни ложного сообщения, ни пропуска настоящей смены", async () => {
  const old = timeline([{ t: at(0), state: "deteriorating", candidate: "transition", since: SINCE, hold_until: at(15), count: 192, price: 86120 }])[0];
  const state = legacyState(old);
  // 1) цель не менялась: снимок новой формы приносит журнал, запись о рождении, уровни и предупреждение
  const same = timeline([{ t: at(0) }, { t: at(15), state: "deteriorating", candidate: "transition", since: SINCE, hold_until: at(15), count: 193, log: OLD_LOG, extra: NEW_FORM(SINCE) }])[1];
  const quietRun = await runBot([same], { state });
  assert.deepEqual(quietRun.sent.map((m) => m.title), [], "новые поля сами по себе событием не являются");
  assert.equal(quietRun.state.version, 2, "состояние переписано в новой форме");
  assert.equal(quietRun.state.last_alloc.pct, 20);
  // 2) в первом же снимке новой формы цель сменилась — сообщение приходит, и с причиной из журнала
  const moved = upgrade({ log: [...OLD_LOG, ...UP_LOG], extra: NEW_FORM(SINCE) })[1];
  const r = await runBot([moved], { state });
  assert.deepEqual(r.sent.map((m) => `${m.before}→${m.after}`), ["20%→45%"]);
  assert.match(r.sent[0].text, /Причина: блок «Спрос» вышел из неблагоприятной полосы/, r.sent[0].text);
  assert.doesNotMatch(r.sent[0].text, /Путь|80 %/, "старые записи журнала в сообщение не попадают");
  // 3) предупреждение, висящее в снимке новой формы, объявляется один раз — со второго запуска
  const next = timeline([{ t: at(0) }, { t: at(15) }, { t: at(30), state: "deteriorating", candidate: "transition", since: SINCE, hold_until: at(15), count: 194, log: OLD_LOG, extra: NEW_FORM(SINCE) }])[2];
  const second = await runBot([next], { state: quietRun.state });
  assert.deepEqual(second.sent.map((m) => m.title), ["Предупреждение о данных"]);
});

testAsync("первый запуск на состоянии прежнего формата: разосланное прежней версией не повторяется, новое приходит", async () => {
  // За такт до выкладки источник потоков ETF отдавал вчерашний набор — прежний бот положил его в
  // базу (он двигал её и на отказавших входах). О свежем наборе, за 17.08, он сообщил ещё раньше:
  // ключ лежит в его индексе доставленного, но с прежними подписями и без строки «за месяц»
  // (она округлялась до целых миллиардов и тогда не изменилась). На истории — 23.09 07:39.
  const flow = (id, label, num, day) => card(id, { family: "etf", vote: false, value: label, value_num: num, score: null, observed_at: `2026-08-${day}T12:00:00.000Z`, source: "The Block (tbstat)" });
  const tga = (v, day) => card("tga_daily", { block: "macro", family: "liquidity", vote: false, value: `$${v} млрд`, value_num: v, score: null, observed_at: `2026-08-${day}T00:00:00.000Z`, source: "fiscaldata" });
  const mvrv = card("mvrv_cycle", { block: "cycle", family: "valuation", value: "42-й перцентиль 4 лет", value_num: 42 });
  const stale = [flow("etf_1d", "+433 млн $", 433e6, 14), flow("etf_5d", "+6 млн $", 6.1e6, 14), flow("etf_20d", "+2 млрд $", 1.8e9, 14)];
  const fresh = [flow("etf_1d", "+999 млн $", 999e6, 17), flow("etf_5d", "+845 млн $", 845e6, 17), flow("etf_20d", "+2 млрд $", 2.45e9, 17)];
  const snaps = timeline([
    { t: at(0), state: "deteriorating", candidate: "transition", since: SINCE, hold_until: at(15), metrics: [mvrv, ...stale, tga(818, 17)] },
    { t: at(15), state: "transition", since: SINCE, metrics: [mvrv, ...fresh, tga(822, 18)] },
    { t: at(30), state: "transition", since: SINCE, metrics: [mvrv, ...fresh, tga(871, 19)] },
  ]);
  const state = legacyState(snaps[0]);
  state.sent["rel:Потоки в биткоин-ETF|2026-08-17|→|+999 млн $,+845 млн $"] = at(-600);
  const r = await runBot(snaps.slice(1), { state });
  assert.deepEqual(r.sent.map((m) => `${m.k}:${m.kind}`), ["0:allocation", "0:release", "1:release"], `доля, новая публикация и следующая за ней: ${r.sent.map((m) => `${m.k}:${m.title}`)}`);
  assert.match(r.sent[1].text, /\$818 млрд → \$822 млрд/, "публикация, попавшая на такт выкладки, не теряется");
  assert.doesNotMatch(r.sent.map((m) => m.text).join("\n"), /\+999 млн/, "потоки ETF за 17.08 прежний бот уже разослал — повтора нет");
  assert.match(r.sent[2].text, /\$822 млрд → \$871 млрд/);
  // ключ прежнего бота мог нести одну строку, и её подпись с тех пор стала другой: «+2 млрд $» → «+2,5 млрд $»
  const rounded = legacyState(snaps[0]);
  rounded.sent["rel:Потоки в биткоин-ETF|2026-08-17|→|+2 млрд $"] = at(-600);
  assert.doesNotMatch((await runBot([snaps[1]], { state: rounded })).sent.map((m) => m.text).join("\n"), /\+999 млн/, "сверка идёт и по прежней подписи значения");
  // без ключа прежнего бота та же публикация — новость
  const unseen = await runBot([snaps[1]], { state: legacyState(snaps[0]) });
  assert.match(unseen.sent.map((m) => m.text).join("\n"), /Потоки в биткоин-ETF за день: \+433 млн \$ → \+999 млн \$/);
});

testAsync("первый запуск на состоянии прежнего формата: другое значение за ту же дату — новость", async () => {
  // 29.09: прежний бот разослал «стресс: напряжение» по отказавшим рядам VIX. Источник вернулся —
  // карточка снова «нейтрально» за ту же дату. Это отбой ложной тревоги, а не повтор.
  const snaps = [
    dataSnap("2026-09-29T18:08:00.000Z", [stress({ value: "напряжение", value_num: -1, score: -1 })]),
    dataSnap("2026-09-29T18:23:00.000Z", [stress({})]),
  ];
  const key = mute(() => diff(stateOf(fromSnapshotJSON(snaps[0])), fromSnapshotJSON(snaps[1])))[0].key;
  const state = legacyState(snaps[0]);
  state.sent[`${key}|→|напряжение`] = "2026-09-29T00:09:30.000Z";
  const r = await runBot([snaps[1]], { state });
  assert.equal(r.sent.length, 1, "источник и дата те же, значение другое");
  assert.match(r.sent[0].text, /Кредитный и рыночный стресс: напряжение → нейтрально/, r.sent[0].text);
});

testAsync("выкладка, попавшая на паузу решения, не теряет сообщение о возобновлении", async () => {
  // Прежний бот на паузе не хранил долю вовсе (allocation: null); последняя цель есть в его ряду наблюдений.
  const snaps = timeline([{ t: at(0), state: "deteriorating" }, { t: at(15), state: "insufficient", candidate: "insufficient", target: null }, { t: at(30), state: "defensive" }]);
  const state = { ...legacyState(snaps[1]), alloc_trend: [{ t: Date.parse(at(0)), pct: 20, score: -10, blocks: { demand: -25 } }] };
  assert.equal(state.allocation, null);
  const r = await runBot([snaps[2]], { state });
  assert.deepEqual(r.sent.map((m) => `${m.title} ${m.before}→${m.after}`), ["Решение возобновлено: доля биткоина сокращена 20%→5%"]);
});

testAsync("потеря состояния — молчаливая фиксация базы", async () => {
  const snaps = timeline([
    { t: at(0), state: "transition", target: 80, overlays: ["recovery_floor"], mvrv: 19, recovery: "good", conf: 2, extra: { data_warnings: WARN } },
    { t: at(15), state: "transition", target: 80, overlays: ["recovery_floor"], mvrv: 19, recovery: "good", conf: 2, extra: { data_warnings: WARN } },
  ]);
  const r = await runBot(snaps, { state: null });
  assert.equal(r.sent.length, 0, `без состояния бот ничего не знает о прошлом и не шлёт ни доли, ни предупреждений: ${r.sent.map((m) => m.title)}`);
  assert.equal(r.state.last_alloc.pct, 80, "база зафиксирована");
});

testAsync("снимок старше базы сравнения ничего не шлёт и базу не двигает", async () => {
  // Выкладка со снимком-заглушкой или revert коммита снимка: в ветке на один прогон оказался прежний
  // файл. Сравнение с ним дало бы «45 → 20», а следующий настоящий снимок — «20 → 45» обратно.
  const snaps = timeline([
    { t: at(0), state: "deteriorating", candidate: "transition", since: SINCE, hold_until: at(15), count: 192 },
    { t: at(15), state: "transition", since: SINCE, count: 193 },
    { t: at(30), state: "transition", since: SINCE, count: 194 },
  ]);
  const r = await runBot([snaps[0], snaps[1], snaps[0], snaps[2]]);
  assert.deepEqual(r.sent.map((m) => `${m.k}:${m.before}→${m.after}`), ["1:20%→45%"], `откат снимка — не смена доли: ${r.sent.map((m) => `${m.k}:${m.title}`)}`);
  assert.equal(r.state.generated_at, snaps[2].generated_at, "база стоит на последнем настоящем снимке");
  // тот же снимок повторно — обычный путь: перезапуск после сбоя обязан работать
  const again = await runBot([snaps[0], snaps[1], snaps[1]]);
  assert.equal(again.sent.length, 1);
});

/* ---- настоящие формы полей монитора и сборщика (сверены с их кодом 13.10.2026) ---- */

// Журнал монитора начинается записью о старте наблюдения: прежней доли у неё нет.
const startRow = (min, to, regime) => ({
  t: at(min), from_pct: null, to_pct: to, direction: "start", price: 64686.945, strategic_from: null, strategic_to: regime, overlays_from: [], overlays_to: [], kind: "start",
  cause: { text: "старт наблюдения: режим «защитный»", families: [], detectors: [], candidate_since: null },
});

testAsync("запись журнала о старте наблюдения шагом цели не считается", async () => {
  // 1) старт стоит в журнале перед настоящей сменой: сообщение то же, старт в него не попадает
  const text = (await runBot(upgrade({ log: [startRow(-60000, 5, "defensive"), ...UP_LOG] }))).sent[0].text;
  assert.match(text, /20% → 45%/);
  assert.match(text, /Причина: блок «Спрос» вышел из неблагоприятной полосы/);
  assert.doesNotMatch(text, /старт наблюдения|Путь/, text);
  // 2) монитор начал журнал заново в этом такте, цель прежняя — события нет
  const calm = await runBot(timeline([{ t: at(0), state: "deteriorating" }, { t: at(15), state: "deteriorating", count: 4, log: [startRow(15, 20, "deteriorating")] }]));
  assert.deepEqual(calm.sent.map((m) => m.title), []);
  // 3) журнал начат заново в такте настоящей смены — смена не теряется, идёт запасной веткой
  const moved = (await runBot(upgrade({ log: [startRow(15, 45, "transition")] }))).sent;
  assert.deepEqual(moved.map((m) => `${m.before}→${m.after}`), ["20%→45%"]);
  assert.match(moved[0].text, /Причина: смена режима, принятая после удержания/, moved[0].text);
});

testAsync("запись о старте наблюдения не идёт в базу частот", async () => {
  const F = ["recovery_floor"];
  // три прошлых входа на пол, сняты через 48, 95 и 7 часов; после первого входа монитор начал журнал заново
  const past = [
    logRow(-40000, 20, 80, [], F), startRow(-40000 + 60, 80, "deteriorating"), logRow(-40000 + 48 * 60, 80, 45, F, [], ["transition", "transition"]),
    logRow(-20000, 5, 80, [], F, ["defensive", "defensive"]), logRow(-20000 + 95 * 60, 80, 45, F, [], ["transition", "transition"]),
    logRow(-5000, 20, 80, [], F), logRow(-5000 + 7 * 60, 80, 20, F, []),
  ];
  const text = (await runBot(floorOn({ log: [...past, logRow(15, 20, 80, [], F)] }))).sent[0].text;
  assert.match(text, /Пол восстановления включался 3 раза: следующая смена цели наступала через 48 ч, 4 сут, 7 ч/, `старт наблюдения — не смена цели: ${text}`);
});

testAsync("смена одного оверлея объясняется со снимка и при журнале монитора", async () => {
  // Причина оверлея лежит в том же снимке: детектор называет её числами. Запись журнала о том же
  // шаге («пол восстановления включён: …») повторила бы строку о поле и не назвала бы ни порога, ни счёта.
  const row = { ...logRow(15, 20, 80, [], ["recovery_floor"]), cause: { text: "пол восстановления включён: старший ценовой тренд −1 → 2", families: [{ block: "cycle", family: "trend", id: "trend_regime", name: "Старший ценовой тренд", from: -1, to: 2 }], detectors: [{ id: "recovery", from: "watch", to: "good" }], candidate_since: null } };
  const tick_diff = { families: [{ block: "cycle", family: "trend", id: "trend_regime", name: "Старший ценовой тренд", from: -1, to: 2 }, { block: "leverage", family: "oi", id: "oi_quality", name: "Качество движения", from: 0, to: 1 }], detectors: [{ id: "recovery", from: "watch", to: "good" }] };
  const text = (await runBot(floorOn({ log: [row], extra: { tick_diff } }))).sent[0].text;
  assert.match(text, /Причина: детектор разворота подтверждён — MVRV-перцентиль 19,5 \(ниже 25\), подтверждений 2 из 3; сдвинулся показатель «Тренд цены биткоина» \(−1 → \+2\)/, text);
  assert.doesNotMatch(text, /Причина: пол восстановления включён|Качество движения/, "ни повтора строки о поле, ни карточки, не входящей в детектор");
  // сборщик разницу такта не отдал (расчёт отказал) — сдвинувшийся вход берётся из записи журнала
  const noTick = (await runBot(floorOn({ log: [row] }))).sent[0].text;
  assert.match(noTick, /подтверждений 2 из 3; сдвинулся показатель «Тренд цены биткоина» \(−1 → \+2\)/, noTick);
  // тот же шаг, пропущенный между запусками: снимка смены у бота нет — причина берётся из журнала
  const later = timeline([
    { t: at(0), state: "deteriorating", candidate: "deteriorating", mvrv: 19.5, recovery: "watch", conf: 1 },
    { t: at(15), state: "deteriorating", candidate: "deteriorating", mvrv: 19.5, recovery: "good", conf: 2, trend: 2, target: 80, overlays: ["recovery_floor"] },
    { t: at(30), state: "deteriorating", candidate: "deteriorating", mvrv: 19.5, recovery: "good", conf: 2, trend: 2, target: 80, overlays: ["recovery_floor"], log: [row] },
  ]);
  const skipped = (await runBot(later, { only: [0, 2] })).sent[0].text;
  assert.match(skipped, /20% → 80%\nBTC 65 000 \$ · 19\.08 20:53 UTC/, skipped);
  assert.match(skipped, /Причина: пол восстановления включён: старший ценовой тренд −1 → 2/, skipped);
  // журнал, засеянный до правки монитора 13.10.2026, несёт прежнее имя оверлея — запись читается так же
  const seeded = { ...row, cause: { ...row.cause, text: "пол recovery включён: старший ценовой тренд −1 → 2" } };
  const old = (await runBot(later.map((x, k) => (k === 2 ? { ...x, monitoring: { target_change_log: [seeded] } } : x)), { only: [0, 2] })).sent[0].text;
  assert.match(old, /20% → 80%\nBTC 65 000 \$ · 19\.08 20:53 UTC/, old);
  assert.match(old, /Причина: пол recovery включён: старший ценовой тренд −1 → 2/, old);
  const oldLive = (await runBot(floorOn({ log: [seeded] }))).sent[0].text;
  assert.match(oldLive, /Причина: детектор разворота подтверждён — MVRV-перцентиль 19,5 \(ниже 25\), подтверждений 2 из 3; сдвинулся показатель «Тренд цены биткоина» \(−1 → \+2\)/, oldLive);
});

testAsync("причина журнала, повторяющая сам переход, причиной не считается", async () => {
  // Монитор не знает, в каком снимке родился принятый кандидат (тот появился ещё до выкладки), и
  // пишет в причину переход. Строка «Причина: режим «ухудшается» → «переходный»» ничего не объясняет.
  const bare = [{ ...UP_LOG[0], cause: { text: "режим «ухудшается» → «переходный»", families: [], detectors: [], candidate_since: SINCE } }];
  const text = (await runBot(upgrade({ log: bare }))).sent[0].text;
  assert.doesNotMatch(text, /Причина: режим «ухудшается»/, text);
  assert.match(text, /Режим «ухудшается» → «переходный» \(ступень 45 %\), принят после 48 часов удержания/, "срок удержания читается из той же записи журнала");
  assert.match(text, /Причина: смена режима, принятая после удержания\n• Сейчас: неблагоприятных направлений нет/, text);
  // причина оверлея в той же записи — настоящая, и вместе с переходом печатается целиком
  const both = [{ ...UP_LOG[0], kind: "both", cause: { text: "пол восстановления снят: биржевое предложение BTC 0 → −1,5; режим «ухудшается» → «переходный»", families: [], detectors: [], candidate_since: SINCE } }];
  assert.match((await runBot(upgrade({ log: both }))).sent[0].text, /Причина: пол восстановления снят: биржевое предложение BTC 0 → −1,5; режим «ухудшается» → «переходный»/);
  // прежняя формулировка монитора — такой же допустимый вход
  const bothOld = [{ ...both[0], cause: { ...both[0].cause, text: "пол recovery снят: биржевое предложение BTC 0 → −1,5; режим «ухудшается» → «переходный»" } }];
  assert.match((await runBot(upgrade({ log: bothOld }))).sent[0].text, /Причина: пол recovery снят: биржевое предложение BTC 0 → −1,5; режим «ухудшается» → «переходный»/);
});

testAsync("негодные значения необязательных полей не роняют рассылку", async () => {
  // Поля пишут другие части панели; строка вместо объекта или объект вместо списка читаются как «поля нет».
  const flat = { regime_birth: "x", tick_diff: 7, valuation_levels: { levels: { a: 1 } }, data_warnings: "oops" };
  const nested = {
    regime_birth: { strategic: { candidate: "transition", t: 5, blocks: "x", families: 7, detectors: { a: 1 }, note: 3 }, tactical: 9 },
    tick_diff: { families: "x", detectors: 3, mvrv_percentile: "y" },
    valuation_levels: { levels: [null, 7, { key: 5 }, { key: "recovery_anchor", price_usd: "дорого" }] },
    data_warnings: [null, "x", { source: "etf" }, { source: "etf", code: "redundancy_lost", text: 5, affects: "x" }],
  };
  const badLog = [null, 7, { t: "не дата", from_pct: 5, to_pct: 20 }, { from_pct: "5" },
    { t: at(15), from_pct: "20", to_pct: 45, cause: 7, overlays_from: "x", overlays_to: { a: 1 } },
    { t: at(15), from_pct: 20, to_pct: 45, strategic_from: 1, strategic_to: {}, kind: 5, cause: { text: 5, families: { a: 1 }, candidate_since: 9 } }];
  for (const extra of [flat, nested]) {
    const snaps = upgrade({ log: badLog, extra });
    snaps[1].monitoring.health = 7;
    snaps[1].sources = { etf: { state: "ok", source: "The Block", legs: [null, { name: null, state: 7 }, "x"] } };
    const r = await runBot(snaps);
    assert.deepEqual(r.sent.map((m) => `${m.before}→${m.after}`), ["20%→45%"], "смена доли приходит и при мусоре в соседних полях");
    assert.match(r.sent[0].text, /Режим «ухудшается» → «переходный» \(ступень 45 %\), принят после 48 часов удержания\n• Причина: смена режима, принятая после удержания/, r.sent[0].text);
  }
  // пол на мусорных уровнях оценки: строка об отмене остаётся, цена порога не выдумывается
  const floor = (await runBot(floorOn({ extra: nested }))).sent[0].text;
  assert.match(floor, /MVRV-перцентиль дойдёт до 25 \(сейчас 19,5\)/, floor);
  // из четырёх записей предупреждений годна одна — у неё есть пара «источник:код»
  const warned = await runBot(timeline([warnSnap(0, []), warnSnap(15, nested.data_warnings), warnSnap(30, nested.data_warnings)]));
  assert.deepEqual(warned.sent.map((m) => m.text), ["🧩 Предупреждение о данных\n• etf: redundancy_lost"]);
});

testAsync("отказ расчёта предупреждений (null вместо списка) ничего не снимает", async () => {
  const r = await runBot(timeline([warnSnap(0, []), warnSnap(15, WARN), warnSnap(30, WARN), warnSnap(45, null), warnSnap(10 * 60, null), warnSnap(10 * 60 + 15, WARN)]));
  assert.deepEqual(r.sent.map((m) => `${m.k}:${m.title}`), ["2:Предупреждение о данных"], "null — расчёт не выполнен, а не «предупреждений нет»");
});

testAsync("панель скрыла цель — это пауза, а не смена доли", async () => {
  // Потеря одного краткосрочного покрытия: решение actionable, цель в снимке — число, и оно
  // сменилось, но качество paused. Витрина цель не показывает, монитор её не исполняет.
  const scores = { strategic: 30, critical_missing: { strategic: [], tactical: ["etf_regime"] } };
  const hidden = { t: at(15), state: "constructive", quality: "paused", extra: { scores } };
  const back = await runBot(timeline([{ t: at(0), state: "transition" }, hidden, { t: at(30), state: "transition", count: 5 }]));
  assert.deepEqual(back.sent.map((m) => m.title), ["Решение о доле биткоина на паузе", "Решение о доле биткоина возобновлено"], back.sent.map((m) => m.text).join("\n---\n"));
  assert.match(back.sent[0].text, /Панель скрыла цель: не хватает данных — Потоки в биткоин-ETF в США/, back.sent[0].text);
  assert.match(back.sent[0].text, /Новых действий не предпринимать\. Последняя цель — 45 %/);
  assert.match(back.sent[0].text, /Цель вернётся первым же снимком, в котором панель снова её покажет/);
  assert.doesNotMatch(back.sent.map((m) => m.text).join("\n"), /100/, "скрытая цель читателю не называется");
  // гейт открылся уже с новой целью — она приходит как возобновлённое решение
  const moved = await runBot(timeline([{ t: at(0), state: "transition" }, hidden, { t: at(30), state: "constructive", count: 5 }]));
  assert.deepEqual(moved.sent.map((m) => `${m.title} ${m.before}→${m.after}`), ["Решение о доле биткоина на паузе →", "Решение возобновлено: доля биткоина увеличена 45%→100%"]);
  // монитор приостановил действие (например, не сошёлся хэш политики) — та же пауза
  const health = { operational_status: "paused", operational_issues: ["policy_hash_mismatch"] };
  const mon = await runBot(timeline([{ t: at(0), state: "transition" }, { t: at(15), state: "transition", extra: { monitoring: { health } } }]));
  assert.match(mon.sent[0].text, /Решение о доле биткоина на паузе\nПанель скрыла цель: монитор панели приостановил действие/, mon.sent[0].text);
  // degraded гейт не закрывает: цель показывается и исполняется
  const degraded = await runBot(timeline([{ t: at(0), state: "transition" }, { t: at(15), state: "transition", quality: "degraded", extra: { monitoring: { health: { operational_status: "healthy" } } } }]));
  assert.deepEqual(degraded.sent.map((m) => m.title), []);
});

testAsync("в осторожном режиме предупреждение о данных не теряется", async () => {
  // Память «объявлено» пишется в базу в том же прогоне: придержанное предупреждение не пришло бы никогда.
  const r = await runBot(timeline([warnSnap(0, []), warnSnap(15, WARN), warnSnap(30, WARN), warnSnap(45, WARN)]), { selftest: "failure" });
  assert.deepEqual(r.sent.map((m) => `${m.k}:${m.kind}`), ["1:service", "2:quality"]);
});

/* ---- комментатор LLM: сеть подменяется, ключ фиктивный ---- */

// Тесты фолбэка НАМЕРЕННО провоцируют отказ модели, и её жалоба уезжала в лог CI, выглядя там
// настоящей ошибкой. Такой шум приучает не читать диагностику, поэтому ожидаемый вывод глушится:
// сами сообщения при этом проверяются — тест падает, если жалобы не было вовсе.
// Глушит ОБА потока: часть диагностики идёт через console.log («комментарий получен запасной
// моделью…»), и она утекала в лог CI, выглядя там боевой. Сами сообщения при этом проверяются.
const quiet = async (fn) => {
  const realErr = console.error;
  const realLog = console.log;
  const said = [];
  console.error = (...a) => said.push(a.join(" "));
  console.log = (...a) => said.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = realErr;
    console.log = realLog;
  }
  return said.join("\n");
};

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  const realKey = process.env.OPENROUTER_KEY;
  globalThis.fetch = impl;
  process.env.OPENROUTER_KEY = "test-key";
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
    if (realKey === undefined) delete process.env.OPENROUTER_KEY;
    else process.env.OPENROUTER_KEY = realKey;
  }
};
const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const evs = [{ kind: "zone", title: "A", before: "1", after: "2", detail: "", note: "" }, { kind: "release", title: "B", before: "", after: "", detail: "", note: "" }];
const panel = panelOf([ind({})]);

testAsync("комментарии разбираются из ответа модели", async () => {
  const out = await withFetch(reply('[{"i":0,"text":"первый"},{"i":1,"text":"второй"}]'), () => llmComments(evs, panel));
  assert.deepEqual(out, ["первый", "второй"]);
});

testAsync("основной формат — блоки ===N===", async () => {
  const txt = "===0===\nразбор первого события\n===1===\nразбор второго события";
  const out = await withFetch(reply(txt), () => llmComments(evs, panel));
  assert.deepEqual(out, ["разбор первого события", "разбор второго события"]);
});

testAsync("рассуждение вокруг блоков не мешает разбору", async () => {
  const txt = "Сначала подумаю: событий два, оба про кредит.\n\n===0===\nпервый текст\n\n===1===\nвторой текст\n";
  const out = await withFetch(reply(txt), () => llmComments(evs, panel));
  assert.equal(out[0], "первый текст");
  assert.equal(out[1], "второй текст");
});

testAsync("готовый ответ внутри reasoning принимается — но только с разметкой", async () => {
  const impl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "", reasoning: "===0===\nтекст с разметкой\n===1===\nвторой" } }] }),
  });
  const out = await withFetch(impl, () => llmComments(evs, panel));
  assert.equal(out[0], "текст с разметкой");
});

testAsync("ЧЕРНОВИК РАЗМЫШЛЕНИЙ не выдаётся за разбор", async () => {
  // Боевой случай: бюджета токенов не хватило, content пуст, а в reasoning лежит поток мыслей
  // по-английски — он уехал пользователю целиком. Без разметки такой текст ответом не считается.
  const cot = "The user wants me to analyze a single event: the Fed's balance sheet data.\nKey data points:\n- Net liquidity up 1.8% over 4 weeks\n- wait, monthly -50M seems low";
  const impl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "", reasoning: cot }, finish_reason: "length" }] }) });
  let out, said = "";
  said = await quiet(async () => { out = await withFetch(impl, () => llmComments(evs, panel)); });
  assert.equal(out, null, "черновик — не ответ");
  assert.match(said, /бюджета токенов/, "причина должна быть названа в логе");
});

testAsync("англоязычный разбор до читателя не доходит", async () => {
  const txt = "===0===\nThe spread widened by three basis points, which is a routine move for this indicator and does not change the credit picture materially.\n===1===\nВторое событие разобрано по-русски и остаётся.";
  let out, said = "";
  said = await quiet(async () => { out = await withFetch(reply(txt), () => llmComments(evs, panel)); });
  assert.equal(out[0], null, "английский текст заменяется шаблоном");
  assert.match(out[1], /по-русски/, "русский разбор при этом сохраняется");
  assert.match(said, /не на русском/);
});

testAsync("ломаный текст отбраковывается: транслитерация, арабица, смешение алфавитов", async () => {
  // Все три дефекта наблюдались в живых прогонах бесплатных моделей.
  const broken = [
    "===0===\nЛиквидность растёт несмотря на продолжение kvantitativnogo uzhestocheniya в политике ФРС сегодня.\n===1===\nВторой разбор написан чисто и по-русски, без единого изъяна в тексте.",
    "===0===\nЛиквидность растёт, а на рынке заметны продажи حكومات и связанное с ними давление.\n===1===\nВторой разбор написан чисто и по-русски, без единого изъяна в тексте.",
    "===0===\nПродолжается кванitative tightening, и это давит на длинные ставки в текущей ситуации.\n===1===\nВторой разбор написан чисто и по-русски, без единого изъяна в тексте.",
  ];
  for (const txt of broken) {
    let out;
    const said = await quiet(async () => { out = await withFetch(reply(txt), () => llmComments(evs, panel)); });
    assert.equal(out?.[0] ?? null, null, `ломаный текст не должен доходить до читателя: ${txt.slice(10, 60)}`);
    assert.match(said, /испорчен/, "причина брака обязана быть в логе");
  }
});

testAsync("чистый русский разбор с аббревиатурами и именами проходит", async () => {
  const txt = "===0===\nПотоки в биткоин-ETF развернулись: за неделю отток, MVRV ушёл к 18-му перцентилю, а Nasdaq при этом растёт.\n===1===\nВторой разбор тоже чистый, с упоминанием Deribit и обычных сокращений вроде ФРС и ВВП.";
  // число из разбора обязано лежать во входе — здесь оно стоит в строке события
  const withMove = [{ ...evs[0], moves: [{ name: "Оценка рынка биткоина (MVRV)", before: "25-й перцентиль 4 лет", after: "18-й перцентиль 4 лет" }] }, evs[1]];
  const out = await withFetch(reply(txt), () => llmComments(withMove, panel));
  assert.ok(out[0] && out[1], `нормальный текст с аббревиатурами не должен браковаться: ${JSON.stringify(out)}`);
});

/* ---- сверка чисел разбора со входом модели ---- */

const numEvents = [{
  kind: "release", title: "Потоки в биткоин-ETF", before: "", after: "", detail: "данные за 17.08.2026",
  moves: [{ name: "Потоки в биткоин-ETF за день", before: "-58 млн $", after: "+137 млн $" }, { name: "Потоки в биткоин-ETF за месяц", before: "+3,4 млрд $", after: "+3,5 млрд $" }],
  history: ["Потоки в биткоин-ETF за день: последние наблюдения: 14.08.2026 -58 млн $ · за 150 наблюдений диапазон -912…845 млн $"],
  note: "",
}];

test("числа разбора сверяются со входом: взятое из входа проходит, постороннее — нет", () => {
  const input = llmInput(numEvents, panel);
  assert.deepEqual(strayNumbers("Приток за день составил 137 млн долларов после оттока в 58 млн.", input), [], "числа из входа — без знака и с другой единицей записи — свои");
  assert.deepEqual(strayNumbers("За месяц набралось около 3,5 млрд, то есть 3 500 млн.", input), [], "та же величина в другой кратности — своя");
  assert.deepEqual(strayNumbers("Данные за 17 августа 2026 года.", input), [], "части даты из входа — свои");
  assert.deepEqual(strayNumbers("Индекс S&P 500 при этом растёт.", input), [], "число внутри имени собственного — не данные");
  assert.deepEqual(strayNumbers("Ставка ФРС остаётся на уровне 5,25 %.", input), ["5,25"], "числа, которого во входе нет, быть не должно");
  assert.deepEqual(strayNumbers("Приток достиг 173 млн.", input), ["173"], "перестановка цифр — уже другое число");
  assert.deepEqual(strayNumbers("Это максимум с 2021 года.", input), ["2021"], "выдуманная дата — тоже число");
});

test("округление принимается только в пределах записанной точности", () => {
  const input = JSON.stringify({ price: "цена биткоина 86 198 $", pct: "MVRV-перцентиль 19,5" });
  assert.deepEqual(strayNumbers("Цена около 86 тыс. долларов.", input), [], "«86 тыс.» — запись 86 198 до тысяч");
  assert.deepEqual(strayNumbers("Цена около 86 200.", input), []);
  assert.deepEqual(strayNumbers("Оценка — около 20-го перцентиля.", input), [], "19,5 округляется до 20");
  assert.deepEqual(strayNumbers("Цена около 90 тыс.", input), ["90"], "90 — уже не округление 86 198");
  assert.deepEqual(strayNumbers("Оценка — около 25-го перцентиля.", input), ["25"]);
});

testAsync("разбор с посторонним числом отбрасывается — уходит шаблон", async () => {
  // Раньше проверялся только язык ответа; числа и смысл — ничем.
  const txt = "===0===\nПриток за день составил 137 млн долларов, а доходность десятилетних бумаг держится у 4,35 %.";
  let out;
  const said = await quiet(async () => { out = await withFetch(reply(txt), () => llmComments(numEvents, panel)); });
  assert.equal(out, null, "единственный разбор забракован — остаётся шаблон");
  assert.match(said, /числа, которых нет во входе \(4,35\)/, "причина брака обязана быть в логе");
});

testAsync("разбор, все числа которого взяты из входа, проходит", async () => {
  const txt = "===0===\nЗа день в фонды пришло 137 млн долларов после оттока в 58 млн: за месяц приток вырос с 3,4 до 3,5 млрд.";
  const out = await withFetch(reply(txt), () => llmComments(numEvents, panel));
  assert.ok(out?.[0], `честный разбор браковаться не должен: ${JSON.stringify(out)}`);
});

testAsync("одиночный устоявшийся англицизм модель не меняет", async () => {
  // «treasuries» в боевом прогоне вызвал смену модели — это расточительно: слово читателю
  // понятно, а лишний запрос жжёт бесплатную квоту. Признак срыва языка — ДВА слова подряд.
  const txt = "===0===\nДоходности treasuries подросли, и это давит на длинные ставки по всему рынку сегодня.\n===1===\nВторой разбор чистый и достаточно длинный для проверки языковых правил.";
  const out = await withFetch(reply(txt), () => llmComments(evs, panel));
  assert.ok(out[0], `одно английское слово не повод браковать разбор: ${JSON.stringify(out)}`);
});

testAsync("перегрузка бесплатного провайдера — переход к запасной модели", async () => {
  // Боевой случай: «Upstream error from Nvidia: ResourceExhausted: Worker local total request
  // limit reached (163/32)» оставил уведомление без разбора. Одна модель = единая точка отказа.
  const tried = [];
  const impl = async (_u, o) => {
    const m = JSON.parse(o.body).model;
    tried.push(m);
    if (m.startsWith("nvidia/")) return { ok: true, json: async () => ({ error: { message: "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (163/32)" } }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "===0===\nразбор от запасной\n===1===\nвторой" } }] }) };
  };
  let out;
  await quiet(async () => { out = await withFetch(impl, () => llmComments(evs, panel)); });
  assert.equal(out[0], "разбор от запасной", "перегрузка одного провайдера не должна лишать разбора");
  assert.ok(tried.length >= 2, `должна быть попытка у следующей модели: ${tried}`);
  assert.ok(!tried[1].startsWith("nvidia/"), `запасная обязана быть у ДРУГОГО провайдера: ${tried}`);
});

testAsync("на сообщение о доле модель ждут не дольше отведённого", async () => {
  // Понижение исполняется сразу, а цепочка из четырёх моделей по полторы минуты могла задержать
  // сообщение о нём на шесть минут. Срок вышел — дальше по цепочке не идём, уходит шаблон.
  const tried = [];
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const impl = async (_u, o) => {
    tried.push(JSON.parse(o.body).model);
    clock += 45000; // каждая модель «думает» 45 секунд и отказывает
    return { ok: true, json: async () => ({ error: { message: "exhausted" } }) };
  };
  let out, said;
  try {
    said = await quiet(async () => { out = await withFetch(impl, () => llmComments(evs, panel, { budgetMs: 60000 })); });
  } finally {
    Date.now = realNow;
  }
  assert.equal(out, null);
  assert.equal(tried.length, 2, `за минуту успевают две модели из четырёх: ${tried}`);
  assert.match(said, /время на разбор для сообщения о доле вышло/);
});

testAsync("вся цепочка запасных моделей — бесплатная", async () => {
  const tried = [];
  const impl = async (_u, o) => {
    tried.push(JSON.parse(o.body).model);
    return { ok: true, json: async () => ({ error: { message: "exhausted" } }) };
  };
  await quiet(async () => { await withFetch(impl, () => llmComments(evs, panel)); });
  assert.ok(tried.length >= 3, `цепочка должна быть не из одной модели: ${tried}`);
  for (const m of tried) assert.ok(m.endsWith(":free"), `платная модель в цепочке: ${m}`);
  assert.equal(new Set(tried).size, tried.length, "повторов в цепочке быть не должно");
});

testAsync("явно заданная модель отменяет цепочку", async () => {
  const tried = [];
  const impl = async (_u, o) => {
    tried.push(JSON.parse(o.body).model);
    return { ok: true, json: async () => ({ error: { message: "exhausted" } }) };
  };
  process.env.NOTIFY_MODEL = "google/gemma-4-31b-it:free";
  try {
    await quiet(async () => { await withFetch(impl, () => llmComments(evs, panel)); });
  } finally {
    delete process.env.NOTIFY_MODEL;
  }
  assert.deepEqual(tried, ["google/gemma-4-31b-it:free"], "выбор владельца не подменяется цепочкой");
});

testAsync("тело-ошибка при статусе 200 объясняется в логе", async () => {
  // OpenRouter умеет вернуть 200 с телом-ошибкой и пустым choices; без этой ветки в логе было
  // только «ответ пуст», и причина оставалась невидимой.
  const impl = async () => ({ ok: true, json: async () => ({ error: { message: "rate limit exceeded" } }) });
  let out, said = "";
  said = await quiet(async () => { out = await withFetch(impl, () => llmComments(evs, panel)); });
  assert.equal(out, null);
  assert.match(said, /rate limit exceeded/);
});

testAsync("провайдер, не понявший подавление размышлений, получает повтор без него", async () => {
  const seen = [];
  const impl = async (_u, o) => {
    const body = JSON.parse(o.body);
    seen.push(body.reasoning ? "с подавлением" : "без подавления");
    if (body.reasoning) return { ok: false, status: 400, text: async () => "unsupported parameter" };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "===0===\nразбор\n===1===\nвторой" } }] }) };
  };
  let out;
  await quiet(async () => { out = await withFetch(impl, () => llmComments(evs, panel)); });
  assert.deepEqual(seen, ["с подавлением", "без подавления"], "должен быть ровно один повтор");
  assert.equal(out[0], "разбор", "разбор не теряется из-за неподдержанного параметра");
});

testAsync("отказ параметра телом при коде 200 тоже даёт повтор", async () => {
  // Провайдеры сообщают об отказе по-разному: одни HTTP-кодом, другие полем error при 200.
  const seen = [];
  const impl = async (_u, o) => {
    const body = JSON.parse(o.body);
    seen.push(body.reasoning ? "с подавлением" : "без подавления");
    if (body.reasoning) return { ok: true, json: async () => ({ error: { message: "unsupported parameter: reasoning" } }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "===0===\nразбор\n===1===\nвторой" } }] }) };
  };
  let out;
  await quiet(async () => { out = await withFetch(impl, () => llmComments(evs, panel)); });
  assert.deepEqual(seen, ["с подавлением", "без подавления"]);
  assert.equal(out[0], "разбор");
});

testAsync("перегрузка провайдера НЕ путается с отказом параметра", async () => {
  // «ResourceExhausted» — это не про параметры: повторять тот же запрос бессмысленно, надо
  // сразу идти к следующей модели, иначе на каждую перегрузку тратится лишний запрос квоты.
  const seen = [];
  const impl = async (_u, o) => {
    const body = JSON.parse(o.body);
    seen.push(`${body.model}|${body.reasoning ? "подавл" : "без"}`);
    if (body.model.startsWith("nvidia/")) return { ok: true, json: async () => ({ error: { message: "ResourceExhausted: Worker local total request limit reached (163/32)" } }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "===0===\nразбор\n===1===\nвторой" } }] }) };
  };
  let out;
  await quiet(async () => { out = await withFetch(impl, () => llmComments(evs, panel)); });
  assert.equal(seen.filter((x) => x.startsWith("nvidia/")).length, 1, `на перегруженную модель — один запрос, а не два: ${seen}`);
  assert.equal(out[0], "разбор");
});

testAsync("бюджет токенов рассчитан на размышления модели", async () => {
  let body = null;
  const spy = async (_u, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({ choices: [{ message: { content: "===0===\nтекст\n===1===\nтекст" } }] }) }; };
  await withFetch(spy, () => llmComments(evs, panel));
  assert.ok(body.max_tokens >= 8000, `рассуждающей модели нужен запас, а не ${body.max_tokens} токенов`);
  assert.equal(body.reasoning?.exclude, true, "размышления не должны возвращаться в ответе");
});

testAsync("пустой ответ модели объясняется в логе, а не молчит", async () => {
  const impl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) });
  let out, said = "";
  said = await quiet(async () => { out = await withFetch(impl, () => llmComments(evs, panel)); });
  assert.equal(out, null);
  assert.match(said, /не дал текста/, "иначе «шаблон» в логе не отличить от «модель ответила, а я не разобрал»");
});

testAsync("ответ, обёрнутый в markdown-блок, разбирается", async () => {
  const txt = "```\n===0===\nтекст один\n===1===\nтекст два\n```";
  const out = await withFetch(reply(txt), () => llmComments(evs, panel));
  assert.equal(out[0], "текст один");
});

testAsync("единственное событие принимает связный текст без маркеров", async () => {
  const one = [evs[0]];
  const txt = "Спред расширился на три пункта — движение рядовое, но направление стоит держать в уме: кредитные премии обычно поворачивают раньше акций.";
  const out = await withFetch(reply(txt), () => llmComments(one, panel));
  assert.equal(out[0], txt, "модель, ответившая без разметки на один вопрос, не должна терять ответ");
});

testAsync("пропущенный моделью индекс не ломает рассылку", async () => {
  const out = await withFetch(reply('[{"i":1,"text":"только второй"}]'), () => llmComments(evs, panel));
  assert.equal(out[0], null, "на пропуск подставится шаблон");
  assert.equal(out[1], "только второй");
});

testAsync("нечитаемый ответ → шаблон, с диагностикой в логе", async () => {
  let out, said = "";
  said = await quiet(async () => { out = await withFetch(reply("извините, не могу"), () => llmComments(evs, panel)); });
  assert.equal(out, null);
  assert.match(said, /не разобран/, "в логе должно быть видно, что модель ответила, но ответ не разобрался");
});

testAsync("отказ API не роняет прогон и объясняет причину в логе", async () => {
  let out;
  const said = await quiet(async () => {
    out = await withFetch(async () => ({ ok: false, status: 503, text: async () => "down" }), () => llmComments(evs, panel));
  });
  assert.equal(out, null);
  assert.match(said, /503/, "причина отказа обязана попасть в лог");
});

testAsync("по умолчанию берётся именно бесплатная nemotron", async () => {
  let seen = null;
  const spy = async (_url, opt) => {
    seen = JSON.parse(opt.body).model;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"i":0,"text":"ok"},{"i":1,"text":"ok"}]' } }] }) };
  };
  const realModel = process.env.NOTIFY_MODEL;
  delete process.env.NOTIFY_MODEL;
  try {
    await withFetch(spy, () => llmComments(evs, panel));
  } finally {
    if (realModel !== undefined) process.env.NOTIFY_MODEL = realModel;
  }
  assert.equal(seen, "nvidia/nemotron-3-ultra-550b-a55b:free");
});

testAsync("пустая переменная модели (незаданный vars) не ломает выбор бесплатной", async () => {
  let seen = null;
  const spy = async (_url, opt) => {
    seen = JSON.parse(opt.body).model;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"i":0,"text":"ok"},{"i":1,"text":"ok"}]' } }] }) };
  };
  process.env.NOTIFY_MODEL = "   ";
  try {
    await withFetch(spy, () => llmComments(evs, panel));
  } finally {
    delete process.env.NOTIFY_MODEL;
  }
  assert.equal(seen, "nvidia/nemotron-3-ultra-550b-a55b:free");
});

testAsync("платная модель без явного разрешения не вызывается вообще", async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return { ok: true, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
  };
  process.env.NOTIFY_MODEL = "anthropic/claude-opus-4.8";
  let out;
  let said = "";
  try {
    said = await quiet(async () => {
      out = await withFetch(spy, () => llmComments(evs, panel));
    });
  } finally {
    delete process.env.NOTIFY_MODEL;
  }
  assert.equal(out, null, "должен быть шаблон, а не запрос");
  assert.equal(called, false, "платный запрос не должен уходить в сеть");
  assert.match(said, /платная/, "отказ от платной модели обязан быть объяснён в логе");
});

testAsync("платная модель уходит в сеть только при NOTIFY_ALLOW_PAID=1", async () => {
  let seen = null;
  const spy = async (_url, opt) => {
    seen = JSON.parse(opt.body).model;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"i":0,"text":"ok"},{"i":1,"text":"ok"}]' } }] }) };
  };
  process.env.NOTIFY_MODEL = "anthropic/claude-opus-4.8";
  process.env.NOTIFY_ALLOW_PAID = "1";
  try {
    await withFetch(spy, () => llmComments(evs, panel));
  } finally {
    delete process.env.NOTIFY_MODEL;
    delete process.env.NOTIFY_ALLOW_PAID;
  }
  assert.equal(seen, "anthropic/claude-opus-4.8");
});

testAsync("без ключа модель не дёргается вовсе", async () => {
  const real = process.env.OPENROUTER_KEY;
  delete process.env.OPENROUTER_KEY;
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error("не должно вызываться"); };
  try {
    assert.equal(await llmComments(evs, panel), null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
    if (real !== undefined) process.env.OPENROUTER_KEY = real;
  }
});

for (const [name, fn] of asyncTests) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`ПРОВАЛ: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

console.log(`тестов пройдено: ${passed}`);
if (process.exitCode) console.error("ЕСТЬ ПРОВАЛЫ");
