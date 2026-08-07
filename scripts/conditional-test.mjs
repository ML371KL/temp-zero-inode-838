// Условные запросы: 412 против 304.
//
// Функция `lib/conditional-requests.js` живёт побайтово одинаковой в трёх репозиториях
// (837, 838, 839 — пять точек входа), а исполняется на краю Cloudflare, где её никакой
// местный прогон не увидит. Тест держится здесь, потому что здесь есть, чем прогонять;
// повторять его в двух других репозиториях значило бы держать три копии одной проверки.
//
// Смысл проверок — не «функция что-то возвращает», а граница между двумя семействами
// заголовков. Оба дают ответ БЕЗ ТЕЛА, и перепутать их можно, ни разу не покраснев.

import assert from "node:assert/strict";
import { preconditionFailed, bodilessStatus } from "../lib/conditional-requests.js";

const ETAG = '"abc123"';
const UPLOADED = new Date("2026-08-07T10:00:30.400Z");
const object = { httpEtag: ETAG, uploaded: UPLOADED };
const ask = (headers) => ({ headers: new Headers(headers) });

// Условного заголовка нет вовсе — тела нет по другой причине, и это не 412.
assert.equal(preconditionFailed(ask({}), object), false);

// Семейство «изменилось ли»: провалившееся условие — это ровно 304, и никогда 412.
assert.equal(preconditionFailed(ask({ "if-none-match": ETAG }), object), false);
assert.equal(bodilessStatus(ask({ "if-none-match": ETAG }), object), 304);
assert.equal(bodilessStatus(ask({ "if-modified-since": UPLOADED.toUTCString() }), object), 304);

// Семейство «отдай, только если это ещё та версия».
assert.equal(bodilessStatus(ask({ "if-match": ETAG }), object), 304, "совпало — значит тело убрал не If-Match");
assert.equal(bodilessStatus(ask({ "if-match": '"stale"' }), object), 412);
assert.equal(bodilessStatus(ask({ "if-match": '"stale", "abc123"' }), object), 304, "список валидаторов");
assert.equal(bodilessStatus(ask({ "if-match": "*" }), object), 304, "звёздочка совпадает с любым объектом");

// Сильное сравнение: слабый валидатор не совпадает ни с чем, включая самого себя.
assert.equal(bodilessStatus(ask({ "if-match": 'W/"abc123"' }), object), 412, "W/ в If-Match не совпадает");
assert.equal(bodilessStatus(ask({ "if-match": ETAG }), { httpEtag: 'W/"abc123"', uploaded: UPLOADED }), 412,
  "слабый валидатор У ОБЪЕКТА тоже не совпадает");
// Случай, который и различает сильное сравнение от обычного равенства строк: W/ с ОБЕИХ сторон.
// Проверки выше прошли бы и без границы — строки там и так разные.
assert.equal(bodilessStatus(ask({ "if-match": 'W/"abc123"' }), { httpEtag: 'W/"abc123"', uploaded: UPLOADED }), 412,
  "совпавшие СЛАБЫЕ валидаторы в If-Match считаются НЕСОВПАДЕНИЕМ");

// If-Match перекрывает If-Unmodified-Since: когда есть оба, второй не смотрят.
assert.equal(
  bodilessStatus(ask({ "if-match": ETAG, "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT" }), object),
  304,
  "If-Match выполнено — до If-Unmodified-Since дело не доходит",
);

// If-Unmodified-Since сам по себе.
assert.equal(bodilessStatus(ask({ "if-unmodified-since": "Fri, 07 Aug 2026 09:00:00 GMT" }), object), 412);
assert.equal(bodilessStatus(ask({ "if-unmodified-since": "Fri, 07 Aug 2026 11:00:00 GMT" }), object), 304);
// Точность заголовка — секунда, и объект, выгруженный в ту же секунду, условие НЕ нарушает.
assert.equal(bodilessStatus(ask({ "if-unmodified-since": "Fri, 07 Aug 2026 10:00:30 GMT" }), object), 304);
// Неразобранная дата игнорируется: опечатка в заголовке не должна оборачиваться отказом.
assert.equal(bodilessStatus(ask({ "if-unmodified-since": "not-a-date" }), object), 304);

console.log("Conditional request tests OK");
