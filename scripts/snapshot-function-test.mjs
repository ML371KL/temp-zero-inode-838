// Функция /snapshot.json переживает сбой R2.
//
// 13.09.2026 в 15:39 UTC R2 несколько минут отвечал на чтение внутренней ошибкой. Вызов
// бакета в функции ничем не был обёрнут: исключение уходило наружу, страница и сторож
// получали голый 500, и пять минут панель числилась мёртвой при целых данных. Функция
// исполняется на краю Cloudflare, где местный прогон её не увидит, поэтому проверяется
// здесь — с подменными бакетом и кэшем, но с НАСТОЯЩИМ кодом функции.

import assert from "node:assert/strict";
import { onRequestGet, onRequestHead } from "../functions/snapshot.json.js";

const quiet = console.error;
console.error = () => {};

const PAGE = "https://tzi-838.pages.dev/snapshot.json?t=1";
const V1 = { text: '{"generation":1}', etag: '"v1"', uploaded: new Date("2026-09-13T15:23:52.000Z") };
const V2 = { text: '{"generation":2}', etag: '"v2"', uploaded: new Date("2026-09-13T15:53:50.000Z") };

const object = (v) => ({
  httpEtag: v.etag,
  uploaded: v.uploaded,
  body: new Response(v.text).body,
  writeHttpMetadata(h) { h.set("content-type", "application/json"); },
});
const bodiless = (v) => ({ httpEtag: v.etag, uploaded: v.uploaded, writeHttpMetadata() {} });

function makeCache() {
  const store = new Map();
  const cache = {
    puts: 0,
    async match(request) {
      const hit = store.get(new URL(request.url).pathname);
      return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
    },
    async put(request, response) {
      cache.puts += 1;
      store.set(new URL(request.url).pathname,
        { body: await response.text(), headers: new Headers(response.headers) });
    },
  };
  return cache;
}

async function call(handler, { get, method = "GET", headers = {} }) {
  const pending = [];
  const context = {
    env: { DATA: { get } },
    request: new Request(PAGE, { method, headers }),
    waitUntil: (promise) => pending.push(promise),
  };
  const response = await handler(context);
  await Promise.all(pending);
  return response;
}

const r2Down = async () => { throw new Error("We encountered an internal error. Please try again."); };
const r2Serves = (v) => async () => object(v);

// Спокойная работа: ответ как прежде, а копия ложится в кэш края — один раз на версию.
{
  const cache = makeCache();
  globalThis.caches = { default: cache };
  const res = await call(onRequestGet, { get: r2Serves(V1) });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), V1.text);
  assert.equal(res.headers.get("cache-control"), "no-store", "клиенту по-прежнему no-store");
  assert.equal(res.headers.get("last-modified"), V1.uploaded.toUTCString());
  assert.equal(res.headers.get("x-snapshot-last-good"), "stored");
  assert.equal(cache.puts, 1, "удачный ответ обязан оставить копию");

  const again = await call(onRequestGet, { get: r2Serves(V1) });
  assert.equal(await again.text(), V1.text);
  assert.equal(again.headers.get("x-snapshot-last-good"), "fresh");
  assert.equal(cache.puts, 1, "одна и та же версия переписывала кэш на каждом запросе");

  await (await call(onRequestGet, { get: r2Serves(V2) })).text();
  assert.equal(cache.puts, 2, "новая версия не попала в копию");
}

// Главное: R2 лежит, копия есть — читатель получает данные с НАСТОЯЩИМ возрастом.
{
  const cache = makeCache();
  globalThis.caches = { default: cache };
  await (await call(onRequestGet, { get: r2Serves(V1) })).text();

  const res = await call(onRequestGet, { get: r2Down });
  assert.equal(res.status, 200, "при живой копии сбой R2 не должен превращаться в ошибку");
  assert.equal(await res.text(), V1.text);
  assert.equal(res.headers.get("x-snapshot-source"), "last-good-copy", "копия обязана назвать себя");
  assert.equal(res.headers.get("last-modified"), V1.uploaded.toUTCString(),
    "возраст копии не выдаётся за свежесть");
  assert.equal(res.headers.get("x-snapshot-uploaded"), V1.uploaded.toISOString());
  assert.equal(res.headers.get("cache-control"), "no-store",
    "долгий срок хранения на краю не должен уехать клиенту");
  assert.equal(res.headers.get("etag"), V1.etag);

  // Сторож спрашивает HEAD — и тоже видит живую панель с настоящим Last-Modified.
  const head = await call(onRequestHead, { get: r2Down, method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("last-modified"), V1.uploaded.toUTCString());
  assert.equal(await head.text(), "");

  // «Только если это та версия» против копии соблюдается: 412, а не чужие данные.
  const stale = await call(onRequestGet, { get: r2Down, headers: { "if-match": '"other"' } });
  assert.equal(stale.status, 412);
  const same = await call(onRequestGet, { get: r2Down, headers: { "if-match": V1.etag } });
  assert.equal(same.status, 200);
  assert.equal(await same.text(), V1.text);
}

// R2 лежит, копии нет — честный 503 с Retry-After, а не сорванный вызов.
{
  globalThis.caches = { default: makeCache() };
  const res = await call(onRequestGet, { get: r2Down });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match((await res.json()).error, /temporarily unavailable/);
  const head = await call(onRequestHead, { get: r2Down, method: "HEAD" });
  assert.equal(head.status, 503);
}

// Пустой бакет — настоящее состояние, а не сбой: копия его не маскирует.
{
  globalThis.caches = { default: makeCache() };
  await (await call(onRequestGet, { get: r2Serves(V1) })).text();
  const res = await call(onRequestGet, { get: async () => null });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /has not been published/);
}

// Условный запрос по-прежнему 304 и кэш не трогает; HEAD копию не пишет.
{
  const cache = makeCache();
  globalThis.caches = { default: cache };
  const res = await call(onRequestGet, { get: async () => bodiless(V1), headers: { "if-none-match": V1.etag } });
  assert.equal(res.status, 304);
  const head = await call(onRequestHead, { get: r2Serves(V1), method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("last-modified"), V1.uploaded.toUTCString());
  assert.equal(cache.puts, 0, "HEAD и 304 не должны писать копию");
}

// Кэша нет вовсе (местный прогон или рантайм без Cache API) — работа как прежде.
{
  delete globalThis.caches;
  const res = await call(onRequestGet, { get: r2Serves(V1) });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), V1.text);
  const down = await call(onRequestGet, { get: r2Down });
  assert.equal(down.status, 503, "без кэша сбой R2 — всё равно честный 503, а не исключение");
}

console.error = quiet;
console.log("Snapshot function tests OK");
