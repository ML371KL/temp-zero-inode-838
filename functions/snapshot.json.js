/**
 * `/snapshot.json` — снимок отдаётся из R2, а не из деплоя сайта.
 *
 * Смысл ровно один: развязать частоту данных и частоту публикаций. Пока снимок был
 * файлом внутри развёртывания, каждое обновление данных означало новую публикацию
 * сайта — 24 в сутки у этой панели и под сотню у соседней, при бесплатном потолке
 * Pages в 500 сборок в месяц. Теперь сайт публикуется только когда меняется его код,
 * а снимок переписывается в бакете сколько угодно часто и стоит один PUT.
 *
 * Функция, а не публичный адрес бакета: `r2.dev` у Cloudflare сознательно
 * ограничен по частоте и в документации назван путём для разработки, а не для
 * постоянного трафика. Здесь же данные приходят с того же источника, что и
 * страница, — значит ни CORS, ни отдельного хоста в CSP, ни второго домена,
 * который однажды разъедется с первым.
 *
 * Путь совпадает со старым намеренно: страница как забирала `./snapshot.json`, так и
 * забирает, и переезд не потребовал ни строчки во фронтенде.
 *
 * ПЕРЕЖИВАЕТ СБОЙ R2. 13.09.2026 в 15:39 UTC R2 несколько минут отвечал на чтение
 * внутренней ошибкой. Вызов бакета здесь ничем не был обёрнут: исключение уходило
 * наружу, страница и сторож получали голый 500, и пять минут панель числилась мёртвой
 * при целых данных. Теперь каждый удачный ответ оставляет копию в кэше края, а на
 * отказ бакета функция отдаёт эту копию — с её НАСТОЯЩИМ временем публикации в
 * Last-Modified, так что возраст данных виден и странице, и сторожу, и ничего не
 * выдаётся за свежее. Копии нет — честный 503 с Retry-After вместо сорванного вызова.
 * Пустой бакет копией не маскируется: это настоящее состояние, а не сбой.
 */

import { bodilessStatus, preconditionFailed } from "../lib/conditional-requests.js";

// Ключ копии — отдельный путь, который никто не запрашивает. Под адресом самого
// `/snapshot.json` копия могла бы начать отвечать мимо функции, а долгий срок её
// хранения уехал бы клиенту.
const LAST_GOOD_PATH = "/__snapshot-last-good.json";
// Срок хранения на краю — неделя: копия нужна только на время сбоя, но край волен
// выселить её раньше, и чем дольше разрешено держать, тем меньше шанс остаться без неё.
// Возраст данных копия при этом не скрывает: он лежит в её Last-Modified.
const LAST_GOOD_TTL_SECONDS = 7 * 24 * 3600;

// Кэш края есть на Cloudflare, включая *.pages.dev. В местном прогоне его нет — тогда
// функция работает как прежде, без копии.
function edgeCache() {
  return globalThis.caches?.default ?? null;
}

function lastGoodKey(request) {
  return new Request(new URL(LAST_GOOD_PATH, request.url).toString());
}

async function readLastGood(request) {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    return (await cache.match(lastGoodKey(request))) ?? null;
  } catch {
    return null;
  }
}

function unavailable(withBody) {
  return new Response(
    withBody ? JSON.stringify({ error: "snapshot storage is temporarily unavailable" }) : null,
    {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "30",
      },
    },
  );
}

async function fromLastGood(request, withBody) {
  const copy = await readLastGood(request);
  if (!copy) return unavailable(withBody);

  const headers = new Headers(copy.headers);
  // Долгий срок хранения — свойство копии на краю, клиенту он не положен.
  headers.set("cache-control", "no-store");
  // Копия называет себя: человек, разбирающий сбой, отличит её от свежего ответа.
  headers.set("x-snapshot-source", "last-good-copy");

  // «Отдай, только если это ещё та версия» соблюдается и против копии: для чужой
  // версии честный ответ — 412, а не данные, которые клиент не просил. Семейство
  // «изменилось ли» здесь не разбирается: полный ответ на него всегда верен.
  const uploaded = headers.get("x-snapshot-uploaded");
  const version = { httpEtag: headers.get("etag"), uploaded: uploaded ? new Date(uploaded) : null };
  if (preconditionFailed(request, version)) {
    await copy.body?.cancel();
    return new Response(null, { status: 412, headers });
  }
  if (!withBody) {
    await copy.body?.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(copy.body, { status: 200, headers });
}

async function serve(context, { withBody }) {
  const { env, request } = context;

  let object;
  try {
    // `onlyIf` перекладывает сверку ETag на R2: если у браузера уже есть текущая
    // версия, тело не читается и не оплачивается — возвращается 304.
    object = await env.DATA.get("snapshot.json", { onlyIf: request.headers });
  } catch (error) {
    console.error("snapshot.json: R2 не ответил, отдаю последнюю удачную копию", error);
    return fromLastGood(request, withBody);
  }

  if (object === null) {
    // Бакет пуст — это состояние «сборщик ещё ни разу не опубликовал», а не ошибка
    // страницы. 503 и явный текст: иначе фронтенд получит HTML-заглушку 404 и
    // упадёт на разборе JSON, сообщив владельцу совсем не то, что случилось.
    return new Response(
      JSON.stringify({ error: "snapshot has not been published to R2 yet" }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-type", "application/json; charset=utf-8");
  // Снимок переписывается чаще, чем истёк бы любой разумный кэш, а страница и так
  // добавляет к запросу метку времени. Единственный честный ответ на вопрос «какие
  // сейчас данные» — тот, что пришёл сейчас.
  headers.set("cache-control", "no-store");
  // Метка публикации отдельным заголовком: по ней сторож отличает «страница не
  // обновилась» от «страница обновилась, но источники молчат», не разбирая тело.
  // Last-Modified, а не только собственный заголовок. Это стандартный признак возраста
  // публикации, и его отсутствие — не мелочь: канарейка 839 определяет по нему, не встал ли
  // публикатор, и без него отказывается выносить вердикт вовсе, чтобы остановившаяся
  // публикация не пряталась за неполным заголовком. `writeHttpMetadata` его не пишет — она
  // переносит только httpMetadata объекта, а время выгрузки лежит отдельным полем.
  if (object.uploaded) {
    headers.set("x-snapshot-uploaded", object.uploaded.toISOString());
    headers.set("last-modified", object.uploaded.toUTCString());
  }

  // При сработавшем `onlyIf` R2 возвращает объект без тела — это и есть 304.
  if (!("body" in object) || object.body === null) {
    // 304 говорит «твоя копия актуальна». Клиенту, пришедшему с If-Match, эта фраза
    // не подходит: копии у него нет, а условие не выполнено — это 412. См. модуль.
    return new Response(null, { status: bodilessStatus(request, object), headers });
  }
  if (!withBody) return new Response(null, { headers });

  const cache = edgeCache();
  if (!cache) {
    headers.set("x-snapshot-last-good", "unavailable");
    return new Response(object.body, { headers });
  }
  // Копия переписывается только при новой версии: снимок меняется раз в пятнадцать
  // минут, а читают его чаще — класть полтора мегабайта на край на каждый запрос незачем.
  const known = await readLastGood(request);
  const knownEtag = known?.headers.get("etag") ?? null;
  await known?.body?.cancel();
  if (knownEtag === object.httpEtag) {
    headers.set("x-snapshot-last-good", "fresh");
    return new Response(object.body, { headers });
  }

  const [forClient, forCache] = object.body.tee();
  const copyHeaders = new Headers(headers);
  copyHeaders.set("cache-control", `public, max-age=${LAST_GOOD_TTL_SECONDS}`);
  const stored = cache
    .put(lastGoodKey(request), new Response(forCache, { headers: copyHeaders }))
    .catch((error) => console.error("snapshot.json: копия в кэш края не легла", error));
  if (typeof context.waitUntil === "function") context.waitUntil(stored);
  // Отметка для проверки снаружи: «stored» — копия отправлена на край, «fresh» — эта
  // версия там уже лежит. По ней видно, что кэш края действительно работает.
  headers.set("x-snapshot-last-good", "stored");
  return new Response(forClient, { headers });
}

export async function onRequestGet(context) {
  return serve(context, { withBody: true });
}

// HEAD — это GET без тела, и обслуживать его обязана та же функция. Без этого экспорта
// Pages не находит обработчика на метод и уходит к статике, а та на неизвестный путь
// отвечает 200 и HTML главной страницы. Сторож свежести, спрашивающий Last-Modified
// именно методом HEAD, получал заглушку и объявлял живую панель мёртвой — проверено
// на себе в первый же прогон.
export async function onRequestHead(context) {
  const response = await serve(context, { withBody: false });
  return new Response(null, { status: response.status, headers: response.headers });
}
