// Тесты уведомлений. Все фикстуры синтетические и НЕ зависят от текущей даты: проверяется
// поведение диффера, а не то, что сегодня опубликовал FRED.
import assert from "node:assert/strict";
import { diff, renderMessage, templateComment, fromSnapshotJSON, snapshotState, llmComments, sentKey, pruneSent, rememberRevised, pingMessage, HUMAN, MACRO_CADENCE } from "./notify.mjs";

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
  assert.ok(ev[0].causes.some((c) => c.includes("Приток денег в биткоин прекратился")), `детектор объясняется по-человечески: ${ev[0].causes}`);
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
  assert.equal(diff(before, panelOf([ind({})], { allocation: { pct: 65 }, detectors: det("calm") })).length, 0);
});

test("алерт источника без наблюдаемых изменений в рассылку не идёт", () => {
  const rev = [{ key: "network:2026-07-24:abc", text: "источник переписал уже отданные данные" }];
  const ev = diff(stateOf(panelOf([ind({})])), panelOf([ind({})], { revisions: rev }));
  assert.equal(ev.length, 0, "«изменено строк: 1» без старого и нового значения — не сообщение");
});

test("у каждого показателя макро-панели есть человеческое имя", () => {
  const missing = Object.keys(MACRO_CADENCE).filter((id) => !HUMAN[id]);
  assert.deepEqual(missing, [], `без записи в словаре в сообщение уедет внутренняя подпись карточки: ${missing}`);
});

const allocOf = (pct, blocks, extra = {}) => ({
  pct,
  bands: { adverse: -20, supportive: 20 },
  blocks,
  hold: { state: "defensive", candidate: "defensive", count: 21 },
  ...extra,
});
const BLOCKS_TWO_ADVERSE = {
  macro: { title: "мировые условия", score: 16.7, families: 3, step: 50 / 3 },
  demand: { title: "спрос на биткоин", score: -31.25, families: 4, step: 12.5 },
  cycle: { title: "стадия цикла", score: -25, families: 5, step: 10 },
};
const BLOCKS_ONE_ADVERSE = {
  macro: { title: "мировые условия", score: 16.7, families: 3, step: 50 / 3 },
  demand: { title: "спрос на биткоин", score: 5, families: 4, step: 12.5 },
  cycle: { title: "стадия цикла", score: -25, families: 5, step: 10 },
};
const tierOf = (before, after) => {
  const ev = diff(stateOf(panelOf([ind({})], { allocation: before })), panelOf([ind({})], { allocation: after }));
  return ev[0].stability[0];
};

test("решение, где ближайшему фактору хватит одного шага, — шаткое даже при двух неблагоприятных", () => {
  const st = tierOf(allocOf(80, BLOCKS_TWO_ADVERSE), allocOf(5, BLOCKS_TWO_ADVERSE));
  assert.equal(st.tier, "shaky", "лестница поднимает долю уже при развороте ОДНОГО фактора");
  assert.match(st.reason.join(" "), /ближе всего к развороту/);
  assert.match(st.reason.join(" "), /не полностью, а на одну ступень/, "надо честно сказать, что возврат будет частичным");
});

test("когда развернуться должны несколько показателей — решение устойчиво", () => {
  // оба неблагоприятных фактора глубоко в зоне: ближайший к выходу — и тот в трёх ступенях
  const deep = {
    ...BLOCKS_TWO_ADVERSE,
    demand: { title: "спрос на биткоин", score: -60, families: 4, step: 12.5 },
    cycle: { title: "стадия цикла", score: -55, families: 5, step: 10 },
  };
  const st = tierOf(allocOf(80, deep), allocOf(5, deep));
  assert.equal(st.tier, "firm");
});

test("решение на одном пограничном факторе — шаткое", () => {
  const st = tierOf(allocOf(80, BLOCKS_ONE_ADVERSE), allocOf(20, BLOCKS_ONE_ADVERSE));
  assert.equal(st.tier, "shaky");
  assert.match(st.reason.join(" "), /достаточно, чтобы один показатель/);
});

test("аварийный переключатель — отдельный класс, а не «шаткое»", () => {
  const st = tierOf(allocOf(65, BLOCKS_ONE_ADVERSE), allocOf(0, BLOCKS_ONE_ADVERSE, { override: true }));
  assert.equal(st.tier, "forced");
  assert.match(st.reason.join(" "), /аварийн/);
});

test("в объяснении устойчивости нет внутреннего жаргона", () => {
  const jargon = /блок|пункт|шаг|групп|композит|балл|зон[аы]/i;
  for (const st of [
    tierOf(allocOf(80, BLOCKS_TWO_ADVERSE), allocOf(5, BLOCKS_TWO_ADVERSE)),
    tierOf(allocOf(80, BLOCKS_ONE_ADVERSE), allocOf(20, BLOCKS_ONE_ADVERSE)),
  ]) {
    const text = st.reason.join(" ");
    assert.ok(!jargon.test(text), `внутренняя терминология снова протекла наружу: «${text}»`);
  }
});

test("накопленная история решений даёт частоту откатов", () => {
  const day = 86400e3;
  const trend = [
    { t: 1e12, pct: 80 }, { t: 1e12 + day, pct: 20 }, { t: 1e12 + 2 * day, pct: 80 },
    { t: 1e12 + 3 * day, pct: 20 }, { t: 1e12 + 4 * day, pct: 80 },
  ];
  const prev = { ...stateOf(panelOf([ind({})], { allocation: allocOf(80, BLOCKS_TWO_ADVERSE) })), alloc_trend: trend };
  const ev = diff(prev, panelOf([ind({})], { allocation: allocOf(20, BLOCKS_TWO_ADVERSE) }));
  const text = ev[0].stability[0].reason.join(" ");
  assert.match(text, /откатились обратно/, `база частот обязана попасть в объяснение: ${text}`);
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
  const back = diff(s1, panelOf([withPoints(pts(100))]));
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
  const p = fromSnapshotJSON(snap);
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

/* ---- комментатор LLM: сеть подменяется, ключ фиктивный ---- */

// Тесты фолбэка НАМЕРЕННО провоцируют отказ модели, и её жалоба уезжала в лог CI, выглядя там
// настоящей ошибкой. Такой шум приучает не читать диагностику, поэтому ожидаемый вывод глушится:
// сами сообщения при этом проверяются — тест падает, если жалобы не было вовсе.
const quiet = async (fn) => {
  const real = console.error;
  const said = [];
  console.error = (...a) => said.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = real;
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

testAsync("берётся ПОСЛЕДНИЙ JSON-массив: модели повторяют пример из промпта", async () => {
  const txt = 'Формат: [{"i":0,"text":"..."}]\nВот ответ:\n[{"i":0,"text":"настоящий"},{"i":1,"text":"тоже"}]';
  const out = await withFetch(reply(txt), () => llmComments(evs, panel));
  assert.equal(out[0], "настоящий");
});

testAsync("пропущенный моделью индекс не ломает рассылку", async () => {
  const out = await withFetch(reply('[{"i":1,"text":"только второй"}]'), () => llmComments(evs, panel));
  assert.equal(out[0], null, "на пропуск подставится шаблон");
  assert.equal(out[1], "только второй");
});

testAsync("мусор вместо JSON → шаблон", async () => {
  const out = await withFetch(reply("извините, не могу"), () => llmComments(evs, panel));
  assert.equal(out, null);
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
