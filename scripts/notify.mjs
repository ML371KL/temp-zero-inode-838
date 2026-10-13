#!/usr/bin/env node
// Telegram-уведомления об изменениях панели.
//
// ЖИВЁТ СНАРУЖИ РЕШАЮЩЕГО КОНТУРА: читает уже опубликованное состояние (снимок или живую
// страницу) и ничего не пишет ни в снимок, ни в решение, ни в состояние сборщика. Отказ
// уведомлений не должен и не может повлиять на вердикт.
//
// Файл вырос из общего для двух панелей (BTC и макро) и по-прежнему определяет панель по форме
// данных, но копии разошлись: в макро-панели он с 02.10.2026 ещё и ведёт журнал решений, здесь
// 13.10.2026 переписан по аудиту. Между репозиториями файл НЕ копируется — общие исправления
// переносятся руками, функция за функцией, с прогоном тестов той панели.
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
//   NOTIFY_PAGE_DIR=<путь>  — каталог страницы (docs) для локальной подачи: свежее и надёжнее;
//   NOTIFY_PAGE=<url>       — опубликованный адрес страницы (резерв, отстаёт на цикл публикации);
//   OPENROUTER_KEY          — ключ для комментариев LLM; без него комментарий берётся из шаблона;
//   NOTIFY_MODEL            — модель комментатора (по умолчанию бесплатная nemotron);
//   NOTIFY_MAX=<n>          — предохранитель: больше n событий за прогон → отправляется сводка.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const DRY = process.env.NOTIFY_DRY_RUN === "1" || !process.env.TELEGRAM_BOT_TOKEN;
const STATE_PATH = process.env.NOTIFY_STATE || ".notify/state.json";
const SNAPSHOT_PATH = process.env.NOTIFY_SNAPSHOT || "docs/snapshot.json";
const PAGE_URL = process.env.NOTIFY_PAGE || "";
// Каталог опубликованной страницы в рабочей копии (docs). Если задан — страница поднимается
// локально, и уведомления видят свежий снимок, не дожидаясь публикации Pages.
const PAGE_DIR = process.env.NOTIFY_PAGE_DIR || "";
const MAX_EVENTS = Number(process.env.NOTIFY_MAX || 40);
const SEND_GAP_MS = Number(process.env.NOTIFY_GAP_MS || 3500); // Telegram: ~20 сообщений/мин в чат
// Комментатор обязан быть БЕСПЛАТНЫМ. Модель по умолчанию — та же, что уже судит новости на
// макро-панели. Переопределить её можно (vars.NOTIFY_MODEL), но платный вариант требует явного
// NOTIFY_ALLOW_PAID=1: иначе одна опечатка в переменной начала бы тихо жечь деньги на каждом
// прогоне, а прогонов до сотни в сутки.
const FREE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
// Бесплатные модели живут на общих мощностях и регулярно отвечают «ResourceExhausted: Worker
// local total request limit reached» — именно это оставило боевое уведомление без разбора.
// Поэтому не одна модель, а ЦЕПОЧКА, и намеренно у РАЗНЫХ провайдеров: перегрузка NVIDIA не
// должна выключать разбор целиком. Все до единой — с суффиксом :free.
// КАТАЛОГ ЖИВОЙ, и модели из него исчезают. «inclusionai/ling-3.0-flash:free» отдаёт 404 —
// то есть последний рубеж цепочки был мёртв, и заметить это можно было только в тот день,
// когда первые три окажутся перегружены разом. Пришедший ему на смену «ling-3.0-tiny»
// разметку ответа игнорирует вовсе. Замену проверять живым запросом, а не по названию.
const FREE_CHAIN = [
  FREE_MODEL,                          // NVIDIA, самая крупная — первый выбор по качеству
  "google/gemma-4-31b-it:free",        // Google
  "openai/gpt-oss-20b:free",           // OpenAI OSS
  "poolside/laguna-s-2.1:free",        // Poolside, последний рубеж
];
const resolveModel = () => (process.env.NOTIFY_MODEL || "").trim() || FREE_MODEL;
const paidAllowed = () => process.env.NOTIFY_ALLOW_PAID === "1";
// Если модель задана явно — уважаем выбор и цепочку не подставляем.
const modelChain = () => ((process.env.NOTIFY_MODEL || "").trim() ? [resolveModel()] : FREE_CHAIN);
const LLM_TIMEOUT_MS = Number(process.env.NOTIFY_LLM_TIMEOUT_MS || 90000);
// Сколько всего ждать разбор, когда в пачке есть сообщение о доле. Понижение исполняется сразу,
// и сообщение о нём не должно стоять в очереди за четырьмя моделями по полторы минуты.
const DECISION_LLM_BUDGET_MS = Number(process.env.NOTIFY_DECISION_LLM_MS || 60000);

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Необязательные поля снимка пишут другие части панели. Негодное значение в любом из них (строка
// вместо объекта, объект вместо списка) читается как «поля нет»: рассылку оно ронять не вправе.
const asList = (x) => (Array.isArray(x) ? x : []);
const asObject = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);
const asText = (x) => (typeof x === "string" ? x : "");

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

/* ====================== 1b. ЧЕЛОВЕЧЕСКИЕ НАЗВАНИЯ ПОКАЗАТЕЛЕЙ ======================
   Сообщение читает человек, который не обязан помнить, что такое «импульс HY-спреда» или
   «китайская нога». Поэтому во внешний текст идёт НЕ подпись карточки панели, а нормальное имя
   официальной статистики плюс одна фраза о том, что показатель вообще значит. Внутренняя терминология
   панели (зоны, баллы, вклад в композит) во внешние сообщения не попадает вовсе.

   Правило пополнения: новый показатель — новая запись здесь, иначе в сообщение уедет
   внутренняя подпись карточки и читатель снова получит «китайскую ногу».

   Поля записи: t — имя; p — одна фраза о смысле; rel — публикация, к которой карточка относится;
   quiet — меняется вместе с ценой непрерывно, не рассылается; drift — значение меняется при той
   же дате наблюдения, строка идёт только со сдвигом даты (см. sth_pricing и
   exchange_netflow_30d); lvl — подпись уровня, который карточка держит в поле delta.

   s — что лежит в РЯДУ карточки: его точки печатаются в сообщении о пересчёте истории. Снимок
   единицу ряда не объявляет, поэтому она записана здесь, по коду сборщика (какой ряд уходит в
   series у каждой карточки): u — единица; per — сколько сырых единиц ряда в одной печатной
   (хешрейт лежит в H/s, печатается в EH/s — per 1e18; чистая ликвидность лежит в млрд $ —
   per 1e-9); auto — крупные суммы сжимаются до тыс. / млн / млрд / трлн; n — имя величины ряда,
   когда она не та, что в заголовке (у MVRV на карточке перцентиль, а в ряду — само отношение).
   Без s точка печатается как раньше, сырым числом: «9,463·10^20» вместо «946,3 EH/s» и
   «−4 786,4» вместо «−4 786 BTC» — так уходили все пересчёты истории до 13.10.2026.          */
const HUMAN = {
  // --- макро-панель ---
  sofr_iorb: { t: "Стоимость суточных займов в долларах против ставки ФРС по резервам", p: "дорого ли банкам занимать доллары на ночь: рост — свободных резервов в системе всё меньше" },
  netliq: { t: "Чистая ликвидность ФРС", p: "сколько долларов от ФРС реально доступно рынкам: баланс ФРС минус счёт Минфина и обратное репо" },
  reserves: { t: "Банковские резервы в ФРС, % ВВП", p: "запас прочности банковской системы; ниже ~9-10% исторически начинались сбои денежного рынка" },
  tga: { t: "Счёт Минфина США в ФРС", p: "когда Минфин тратит накопленное — деньги приходят в экономику, когда копит — уходят из неё" },
  rrp: { t: "Обратное репо ФРС", p: "«парковка» лишних денег фондов в ФРС; пока буфер полон, изъятие ликвидности не бьёт по банкам" },
  nfci: { t: "Индекс финансовых условий ФРБ Чикаго", p: "сводная мера того, легко ли занимать в экономике: ноль — историческая норма, выше — жёстче" },
  srf: { t: "Репо-окно ФРС (SRF)", p: "сколько банки занимают у ФРС под залог; всплеск — признак нехватки долларов" },
  ratevol: { t: "Волатильность доходности 10-летних облигаций США", p: "насколько сильно штормит рынок госдолга — от него зависит цена риска везде" },
  hy: { t: "Спред высокодоходных облигаций США", p: "надбавка к доходности, которую платят компании с низким рейтингом; растёт — рынок ждёт больше банкротств" },
  hy_mom: { t: "Спред высокодоходных облигаций: изменение за месяц", p: "скорость расширения кредитных премий важнее их уровня — быстрый рост предшествует кризисам" },
  ig: { t: "Спред облигаций инвестиционного рейтинга", p: "та же премия за риск, но для надёжных заёмщиков; через этот рынок финансируются крупные компании" },
  sloos: { t: "Опрос ФРС об условиях банковского кредитования (SLOOS)", p: "доля банков, ужесточивших требования к кредитам бизнесу; медленный, но надёжный предвестник спада" },
  bizd: { t: "Биржевой фонд компаний прямого кредитования (BIZD)", p: "живая цена непубличного кредита, который обычно переоценивается редко" , quiet: true },
  spx: { t: "S&P 500 относительно 200-дневной средней", p: "простая мера того, в восходящем рынок тренде или в нисходящем" , quiet: true },
  spx_mom: { t: "S&P 500: динамика за месяц", p: "скорость движения широкого рынка акций США" , quiet: true },
  vix: { t: "Индекс волатильности VIX", p: "ожидаемая рынком амплитуда колебаний S&P 500 на месяц вперёд, «индекс страха»" },
  vixterm: { t: "Срочная структура VIX", p: "сравнение цены страховки на ближний и дальний срок; ближняя дороже дальней — острый стресс здесь и сейчас" },
  breadth: { t: "Ширина рынка США", p: "растёт ли рынок широким фронтом или только за счёт нескольких крупнейших компаний" , quiet: true },
  payrolls: { t: "Занятость вне сельского хозяйства США: средний прирост за 3 месяца", p: "сколько рабочих мест создаётся в месяц — главный индикатор рынка труда США" },
  sahm: { t: "Правило Сама", p: "насколько безработица выросла от своего минимума; +0,5 п.п. исторически означает, что рецессия уже идёт" },
  claims: { t: "Продолжающиеся заявки на пособие по безработице (США)", p: "сколько человек продолжают получать пособие — видно, легко ли уволенным найти работу" },
  curve: { t: "Наклон кривой доходности США (10 лет минус 3 месяца)", p: "когда короткие ставки выше длинных, это классический предвестник рецессии" },
  real10: { t: "Реальная доходность 10-летних облигаций США", p: "доходность за вычетом инфляции: настоящая цена денег для всей экономики" },
  jpy: { t: "Курс доллара к иене", p: "резкое укрепление иены обычно означает принудительное закрытие сделок carry trade по всему миру" },
  goldreal: { t: "Золото", p: "растёт вместе с реальными ставками — рынок голосует против доверия к валюте; падает вместе с акциями — идут маржин-коллы" , quiet: true },
  btc: { t: "Биткоин как индикатор долларовой ликвидности", p: "крипта обычно сдаёт первой, когда ликвидность уходит с рынков" , quiet: true },
  stagf: { t: "Инфляционные ожидания рынка на 10 лет", p: "какую среднюю инфляцию закладывают в цены облигаций" },
  oil: { t: "Нефть WTI", p: "цена энергии — прямой вход в инфляцию и в издержки компаний" },
  cny: { t: "Курс доллара к юаню: изменение за 60 дней", p: "ослабление юаня означает, что Китай экспортирует дефляцию и напряжение на мировые рынки" },
  dxy: { t: "Курс доллара к корзине валют: изменение за 60 дней", p: "дорогой доллар ужесточает финансовые условия для всего мира" },
  // --- BTC-панель ---
  liquidity_regime: { t: "Чистая ликвидность ФРС", p: "сколько долларов от ФРС реально доступно рынкам", rel: "Баланс ФРС", s: { u: "$", per: 1e-9, auto: true } },
  netliq_4w: { t: "Чистая ликвидность ФРС за 4 недели", p: "краткосрочное направление долларовой ликвидности", rel: "Баланс ФРС", s: { u: "%" } },
  netliq_13w: { t: "Чистая ликвидность ФРС за квартал", p: "среднесрочное направление долларовой ликвидности", rel: "Баланс ФРС", s: { u: "%" } },
  financial_conditions: { t: "Реальные ставки и курс доллара", p: "две главные цены, определяющие спрос на рисковые активы", rel: "Ставки и курс доллара (ФРС)", s: { n: "Реальная доходность 10-летних облигаций США: изменение за 4 недели", u: "б.п." } },
  // Значение этой карточки — НЕ доходность, а её изменение за 4 недели в базисных пунктах: под
  // прежним именем «Доходность 2-летних облигаций США: −3 б.п. → +10 б.п.» ушло 55 сообщений.
  // Сам уровень лежит в поле delta карточки и печатается рядом (lvl).
  two_year: { t: "Изменение доходности 2-летних облигаций США за 4 недели", p: "во что рынок оценивает будущую политику ФРС", rel: "Доходности гособлигаций США (ФРС)", lvl: "сама доходность", s: { n: "Доходность 2-летних облигаций США", u: "%" } },
  system_stress: { t: "Кредитный и рыночный стресс", p: "сводка по кредитным премиям, страховке на акции и волатильности госдолга", rel: "Кредитные спреды и волатильность", s: { n: "Спред высокодоходных облигаций США", u: "п.п." } },
  macro_lens: { t: "Связь биткоина с индексом Nasdaq", p: "торгуется ли биткоин как обычный рисковый актив или живёт своей жизнью" , quiet: true },
  etf_regime: { t: "Потоки в биткоин-ETF в США", p: "сколько денег институциональные инвесторы вложили в биткоин или вывели через биржевые фонды", rel: "Потоки в биткоин-ETF", s: { n: "Потоки в биткоин-ETF за месяц в пересчёте на биткоины", u: "BTC", auto: true } },
  etf_1d: { t: "Потоки в биткоин-ETF за день", p: "приток или отток денег через американские биржевые фонды за последний торговый день", rel: "Потоки в биткоин-ETF", s: { u: "$", auto: true } },
  etf_5d: { t: "Потоки в биткоин-ETF за неделю", p: "приток или отток за пять торговых дней", rel: "Потоки в биткоин-ETF", s: { u: "$", auto: true } },
  etf_20d: { t: "Потоки в биткоин-ETF за месяц", p: "приток или отток за двадцать торговых дней", rel: "Потоки в биткоин-ETF", s: { u: "$", auto: true } },
  stablecoin_regime: { t: "Объём стейблкоинов", p: "сколько «долларов» находится внутри криптосистемы и может быть потрачено на покупки", rel: "Стейблкоины", s: { u: "$", auto: true } },
  exchange_supply: { t: "Запас биткоинов на биржах", p: "растёт — монеты несут продавать, падает — уносят на хранение", rel: "Ончейн-данные сети биткоина", s: { u: "BTC", auto: true } },
  // drift: карточка без голоса, а её значение обновляется примерно за час до общей даты ончейн-набора
  // (дата карточки — дата набора Coin Metrics, а потоки публикуются раньше остальных метрик). Поэтому
  // «обновление в ту же дату» у неё — не пересмотр, а та же суточная публикация, пришедшая раньше
  // подписи даты: отдельным сообщением оно уходило 45 раз за 84 дня. Строка идёт раз в сутки в общем
  // сообщении «Ончейн-данные сети биткоина» — при сдвиге даты, «было» из прошлого сообщения.
  exchange_netflow_30d: { t: "Приток биткоинов на биржи за месяц", p: "чистое движение монет на биржи и с бирж", rel: "Ончейн-данные сети биткоина", drift: true, s: { u: "BTC", auto: true } },
  institutional_quality: { t: "Позиции фондов во фьючерсах CME (отчёт CFTC)", p: "видно, покупают ли институционалы направленно или зарабатывают на арбитраже", rel: "Отчёт CFTC о позициях во фьючерсах", s: { n: "Чистая позиция управляющих активами во фьючерсах CME", u: "% открытого интереса" } },
  us_spot_premium: { t: "Премия американских бирж", p: "покупают ли биткоин дороже именно в США" , quiet: true },
  mvrv_cycle: { t: "Оценка рынка биткоина (MVRV)", p: "насколько цена выше средней цены покупки всех монет — мера накопленной прибыли рынка", rel: "Ончейн-данные сети биткоина", s: { n: "MVRV — цена биткоина к средней цене покупки всех монет", u: "" } },
  network_security: { t: "Мощность сети биткоина и сложность майнинга", p: "устойчивое падение означает, что майнеры выключают оборудование и вынуждены продавать монеты", rel: "Сеть биткоина", s: { n: "Мощность сети биткоина", u: "EH/s", per: 1e18 } },
  fee_pressure: { t: "Комиссии в сети биткоина", p: "спрос на место в блоках" , quiet: true },
  network_activity: { t: "Активность сети биткоина", p: "сколько адресов и транзакций реально работает в сети", rel: "Ончейн-данные сети биткоина", s: { n: "Активные адреса сети биткоина", u: "адресов", auto: true } },
  miner_regime: { t: "Доходность майнинга", p: "сколько майнеры зарабатывают на единицу мощности", rel: "Ончейн-данные сети биткоина", s: { n: "Доход майнеров на единицу мощности", u: "$ за PH/s в сутки", per: 1e-15 } },
  trend_regime: { t: "Тренд цены биткоина", p: "положение цены относительно её долгосрочных средних" , quiet: true },
  drawdown: { t: "Падение биткоина от исторического максимума", p: "на какой стадии цикла находится рынок" , quiet: true },
  realized_volatility: { t: "Волатильность биткоина за 30 дней", p: "насколько сильно цена колебалась в последний месяц" , quiet: true },
  volume_confirmation: { t: "Объём торгов биткоином", p: "подкреплено ли движение цены реальным оборотом" , quiet: true },
  tga_daily: { t: "Счёт Минфина США в ФРС (ежедневно)", p: "когда Минфин тратит накопленное — деньги приходят в экономику", rel: "Минфин США", s: { u: "$", per: 1e-9, auto: true } },
  g3_liquidity: { t: "Совокупные балансы ФРС, ЕЦБ и Банка Японии", p: "мировая долларовая ликвидность целиком, а не только американская", rel: "Балансы центробанков ФРС, ЕЦБ и Банка Японии", s: { u: "$", per: 1e-12, auto: true } },
  gold_axis: { t: "Связь биткоина с золотом", p: "ведёт ли себя биткоин как защитный актив" , quiet: true },
  // drift: между релизами значение плывёт вместе с ценой (за 84 дня — 881 смена подписи при той же
  // дате наблюдения). Обновления в ту же дату для такой карточки не шлются; строка идёт раз на дату
  // наблюдения — в такт её сдвига, и сравнивается с тем, что читатель видел в прошлом СООБЩЕНИИ,
  // а не со значением прошлого такта.
  sth_pricing: { t: "Цена биткоина относительно средней цены покупки недавних держателей", p: "ниже единицы — недавние покупатели сидят в убытке, это типично для медвежьей фазы", rel: "Ончейн-данные сети биткоина", drift: true, s: { n: "Средняя цена покупки недавних держателей", u: "$" } },
  realized_pnl: { t: "Продают ли биткоин в прибыль или в убыток", p: "устойчивые продажи в убыток — признак капитуляции", rel: "Ончейн-данные сети биткоина", s: { n: "SOPR за сутки", u: "" } },
  hash_ribbons: { t: "Тренд мощности сети биткоина", p: "классический индикатор конца капитуляции майнеров", rel: "Сеть биткоина" , quiet: true },
  oi_quality: { t: "Открытый интерес по фьючерсам на биткоин", p: "растёт ли плечо в системе вместе с ценой" , quiet: true },
  carry_regime: { t: "Стоимость плеча на крипторынке", p: "сколько стоит держать длинную позицию с плечом" , quiet: true },
  options_vol: { t: "Волатильность опционов на биткоин", p: "во сколько рынок оценивает страховку от движения цены" , quiet: true },
  spot_integrity: { t: "Согласованность цен на биржах", p: "расходятся ли цены между площадками — признак сбоя рынка" , quiet: true },
  stablecoin_peg: { t: "Привязка стейблкоинов к доллару", p: "держат ли USDT и USDC курс один к одному" , quiet: true },
};

// Кто опубликовал — тоже человеческим языком: в шапке сообщения имя источника статистики.
const RELEASE_HUMAN = {
  "ice bofa": "Кредитные спреды США",
  "фрс h.15": "Доходности гособлигаций США (ФРС)",
  "фрс h.4.1": "Баланс ФРС",
  "фрс h.10": "Курсы валют (ФРС)",
  "bls employment situation": "Отчёт о занятости США",
  dol: "Заявки на пособие по безработице (США)",
  "treasury dts": "Ежедневный отчёт Минфина США",
  "ny fed": "ФРБ Нью-Йорка",
  "ny fed · sofr": "Денежный рынок США (ФРБ Нью-Йорка)",
  "фрб чикаго": "Финансовые условия (ФРБ Чикаго)",
  sloos: "Опрос ФРС о банковском кредитовании",
  eia: "Цены на нефть (EIA)",
  "закрытие рынка США": "Закрытие рынка США",
  cboe: "Индексы волатильности CBOE",
  "фиксинг ецб": "Курсы валют (фиксинг ЕЦБ)",
  "дневная точка": "Рыночные цены",
  fred: "Данные ФРС",
  "the block (tbstat)": "Потоки в биткоин-ETF",
  "the block (tbstat) · coinbase": "Потоки в биткоин-ETF",
  coinmetrics: "Ончейн-данные сети биткоина",
  "coin metrics": "Ончейн-данные сети биткоина",
  "coin metrics · network": "Ончейн-данные сети биткоина",
  defillama: "Стейблкоины",
  "mempool.space": "Сеть биткоина",
  mempool: "Сеть биткоина",
  "cftc · the block (tbstat)": "Отчёт CFTC о позициях во фьючерсах",
  fiscaldata: "Минфин США",
  "bitcoin-data.com": "Ончейн-данные сети биткоина",
  "bitview.space": "Ончейн-данные сети биткоина",
  coinbase: "Биржевые цены",
  "coinbase exchange": "Биржевые цены",
  "coingecko · blockchain.com · market history": "Рыночные цены биткоина",
};

// Названия блоков BTC-панели для объяснения «почему изменилась доля» без внутреннего жаргона.
const BLOCK_TITLE = {
  macro: "мировые условия и ликвидность",
  demand: "спрос на биткоин и доступное предложение",
  cycle: "стадия цикла и состояние сети",
  leverage: "плечо и волатильность",
  market: "качество торгов",
};

/* Имя публикации по ОБРАЗЦУ, а не по точному совпадению строки: провайдеры дописывают в поле
   источника свои детали («The Block (tbstat) + SosoValue · Coinbase»), и точная таблица такое
   пропускала — в бой уходил сырой технический заголовок. Порядок важен: первый совпавший
   образец выигрывает, поэтому частные идут выше общих. */
const RELEASE_PATTERNS = [
  [/the block|sosovalue|spot.?etf/i, "Потоки в биткоин-ETF"],
  [/cftc/i, "Отчёт CFTC о позициях во фьючерсах"],
  [/coinmetrics|coin metrics|bitcoin-data|bgeometrics|bitview/i, "Ончейн-данные сети биткоина"],
  [/mempool|blockstream|esplora/i, "Сеть биткоина"],
  [/defillama/i, "Стейблкоины"],
  [/fiscaldata|treasury|минфин/i, "Минфин США"],
  [/h\.4\.1/i, "Баланс ФРС"],
  [/h\.15/i, "Доходности гособлигаций США (ФРС)"],
  [/h\.10/i, "Курсы валют (ФРС)"],
  [/employment situation|bls/i, "Отчёт о занятости США"],
  [/\bdol\b/i, "Заявки на пособие по безработице (США)"],
  [/sloos/i, "Опрос ФРС о банковском кредитовании"],
  [/чикаго/i, "Финансовые условия (ФРБ Чикаго)"],
  [/ny fed|нью-йорка/i, "Денежный рынок США (ФРБ Нью-Йорка)"],
  [/cboe/i, "Индексы волатильности CBOE"],
  [/ецб|фиксинг/i, "Курсы валют (фиксинг ЕЦБ)"],
  [/\beia\b|нефт/i, "Цены на нефть (EIA)"],
  [/ice bofa/i, "Кредитные спреды США"],
  [/закрытие рынка/i, "Закрытие рынка США"],
  [/coinbase|kraken|bitstamp|gemini|okx|coingecko|дневная точка/i, "Рыночные цены"],
  [/\bfred\b|фрс/i, "Данные ФРС"],
];

const humanTitle = (id, fallback) => HUMAN[id]?.t || fallback || id;
const humanPlain = (id) => HUMAN[id]?.p || "";
const humanRelease = (s) => {
  const raw = String(s || "").trim();
  if (!raw) return "Источник данных";
  if (RELEASE_HUMAN[raw.toLowerCase()]) return RELEASE_HUMAN[raw.toLowerCase()];
  for (const [rx, name] of RELEASE_PATTERNS) if (rx.test(raw)) return name;
  return sourceLabel(raw);
};

// Публикация показателя: у карточки может быть своя привязка (`rel` в словаре) — она точнее,
// чем имя провайдера. Пример: 2-летка и баланс ФРС обе приходят «из FRED», но это РАЗНЫЕ
// публикации с разным календарём, и валить их в одно сообщение «Данные ФРС» неправильно.
const releaseOf = (i) => HUMAN[i.id]?.rel || humanRelease(i.release || i.source);

// BTC-панель: карточка БЕЗ ряда считается непрерывной, если её наблюдение моложе этого возраста —
// это живой рыночный фид (споты, деривативы, пеги, комиссии мемпула), у него нет релизов.
const LIVE_FEED_MAX_AGE_MS = 6 * 3600 * 1000;
// Карточка С рядом судится по самому ряду: шаг от суток — это календарь публикации. Возраст
// наблюдения здесь врёт: суточный ряд с меткой «сегодня 00:00 UTC» в первые шесть часов суток
// выглядел живым фидом, и его релиз не создавался НИКОГДА — к шести утра новая дата уже лежала в
// базе сравнения. Так за 84 дня не пришло ни одного сообщения о «Мощности сети» (66 смен оценки)
// и об «Объёме стейблкоинов» (13), хотя обе голосуют в решении о доле.
const DAILY_GAP_DAYS = 0.9;

// Сколько последних точек ряда каждой карточки помним, чтобы поймать переписанную историю.
// Ревизия может уехать на месяцы назад (наблюдавшийся случай: 24.07 переписана точка за 27.05),
// поэтому окно широкое. Ряды публикуют 30 карточек из 40; те, что не публикуют, — живые фиды
// (деривативы, споты, пеги, комиссии), они по своей природе не пересматриваются.
const POINT_MEMORY = 150;

// Журнал смен доли из опубликованной панелью истории: [{t, from, to, …}]. Записи истории идут
// по времени, доля лежит в decision.target_pct; берём только моменты, где она изменилась.
// Рядом с долей история хранит режим, базовую ступень, оверлеи и цену — они уезжают в запись
// смены, чтобы шаг, пропущенный между двумя запусками бота, можно было назвать, а не потерять.
function decisionChanges(history) {
  const rows = (history || [])
    .map((r) => ({
      t: Date.parse(r?.t || ""),
      pct: r?.decision?.target_pct,
      base: r?.decision?.base_target_pct,
      overlays: r?.decision?.binding_overlays || [],
      regime: r?.regime?.strategic || "",
      price: r?.price,
    }))
    .filter((r) => finite(r.t) && finite(r.pct))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (sameNum(b.pct, a.pct)) continue;
    out.push({
      t: b.t, from: a.pct, to: b.pct,
      regime_from: a.regime, regime_to: b.regime,
      base_from: finite(a.base) ? a.base : null, base_to: finite(b.base) ? b.base : null,
      overlays_from: a.overlays, overlays_to: b.overlays,
      price: finite(b.price) ? b.price : null,
    });
  }
  return out;
}

// Журнал смен цели, который ведёт монитор панели (monitoring.target_change_log), в ту же форму,
// что и записи из истории. Причина смены есть только здесь: монитор пишет её В МОМЕНТ смены.
// Первая запись журнала — старт наблюдения (from_pct: null): шагом она не является и в цепочку
// не встаёт, потому что прежней доли у неё нет.
// Не зная, в каком снимке родился принятый кандидат, монитор пишет в причину сам переход
// («режим «ухудшается» → «переходный»») — так будет у первого повышения после выкладки, кандидат
// которого появился ещё при прежней версии. Это не причина, а повтор строки о режиме: такая запись
// причиной не считается, и сообщение идёт запасной веткой (правило, по которому режим таков).
const BARE_CAUSE = /^режим «[^»]*» → «[^»]*»$/;
function changeLogSteps(log) {
  if (!Array.isArray(log)) return null;
  const names = (x) => asList(x).filter((o) => typeof o === "string");
  return log
    .map((raw) => {
      const e = asObject(raw) || {};
      const cause = typeof e.cause === "string" ? { text: e.cause } : asObject(e.cause) || {};
      const text = asText(cause.text).trim();
      return {
        t: Date.parse(asText(e.t)), from: finite(e.from_pct) ? e.from_pct : null, to: finite(e.to_pct) ? e.to_pct : null,
        regime_from: asText(e.strategic_from), regime_to: asText(e.strategic_to),
        overlays_from: names(e.overlays_from), overlays_to: names(e.overlays_to),
        base_from: null, base_to: null,
        kind: ["regime", "overlay", "both"].includes(e.kind) ? e.kind : "",
        price: finite(e.price) ? e.price : null,
        cause: text && !BARE_CAUSE.test(text) ? { text, families: asList(cause.families).filter(asObject) } : null,
        // момент рождения принятого кандидата нужен и без причины: по нему видно, выдержан ли срок
        born: asText(cause.candidate_since),
      };
    })
    .filter((s) => finite(s.t) && finite(s.to))
    .sort((a, b) => a.t - b.t);
}

// Запись сборщика о рождении кандидата (regime_birth.strategic) и разница такта (tick_diff) —
// в форму, которой дальше можно верить: списки — списки объектов, момент — строка.
const rowsOf = (x) => asList(x).filter(asObject);
function birthOf(raw) {
  const b = asObject(raw);
  if (!b || !asText(b.candidate)) return null;
  return { t: asText(b.t), candidate: b.candidate, blocks: asObject(b.blocks) || {}, families: rowsOf(b.families), detectors: rowsOf(b.detectors), note: asText(b.note) };
}
function tickOf(raw) {
  const d = asObject(raw);
  if (!d) return null;
  return { families: rowsOf(d.families), detectors: rowsOf(d.detectors), mvrv_percentile: asObject(d.mvrv_percentile) };
}

// Шаг ряда в сутках (медиана промежутков последних точек) — по нему видно, календарный ли ряд.
function seriesGapDays(points) {
  if (!points) return null;
  const ts = Object.keys(points).map(Number).sort((a, b) => a - b).slice(-21);
  if (ts.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 864e5);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// Ряд карточки → компактная карта «метка времени → значение» для сравнения между прогонами.
function compactSeries(series) {
  if (!Array.isArray(series) || !series.length) return null;
  const out = {};
  for (const p of series.slice(-POINT_MEMORY)) {
    const t = finite(p?.t) ? p.t : Date.parse(p?.d || p?.time || "");
    const v = Number(p?.v);
    if (finite(t) && finite(v)) out[t] = v;
  }
  return Object.keys(out).length ? out : null;
}

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
  // На этой панели набор карточек задаётся кодом сборщика, поэтому тест на полноту словаря
  // (как у макро-панели) невозможен: новые id появляются без правки уведомлений. Вместо теста —
  // громкая строка в логе: без записи в словаре наружу уедет внутренняя подпись карточки.
  const noHuman = (snap.metrics || []).filter((m) => m.vote === true && !HUMAN[m.id]).map((m) => m.id);
  if (noHuman.length) console.log(`ВНИМАНИЕ: нет человеческого имени у карточек — ${noHuman.join(", ")} (в сообщение уйдёт внутренняя подпись; добавьте их в HUMAN)`);
  // То же с единицей ряда: у карточки с рядом, которая рассылается, но не описана полем s,
  // пересчёт истории уйдёт сырым числом без единицы.
  const noUnit = (snap.metrics || []).filter((m) => Array.isArray(m.series) && m.series.length && !HUMAN[m.id]?.quiet && !HUMAN[m.id]?.s).map((m) => m.id);
  if (noUnit.length) console.log(`ВНИМАНИЕ: не объявлена единица ряда у карточек — ${noUnit.join(", ")} (пересчёт их истории уйдёт сырым числом; добавьте поле s в HUMAN)`);

  const indicators = (snap.metrics || []).map((m) => {
    const obs = Date.parse(m.observed_at || "");
    const points = compactSeries(m.series);
    const gap = seriesGapDays(points);
    const live = gap != null ? gap < DAILY_GAP_DAYS : finite(obs) ? generatedAt - obs < LIVE_FEED_MAX_AGE_MS : false;
    const valueNum = finite(m.value_num) ? m.value_num : null;
    const lastPoint = points ? points[Math.max(...Object.keys(points).map(Number))] : null;
    return {
      id: m.id,
      name: m.name,
      value: m.value,
      value_num: valueNum,
      unit: m.unit || "",
      delta: m.delta || "",
      zone: null, // у BTC-панели зон нет — роль зоны играет балл семьи
      score: finite(m.score) ? m.score : null,
      observed_at: finite(obs) ? new Date(obs).toISOString().slice(0, 10) : "",
      source: m.source || "",
      note: m.note || "",
      voting: m.vote === true,
      // голосует именно в среднесрочном режиме — только такие карточки способны сдвинуть долю
      strategic: m.vote === true && m.strategic !== false,
      block: m.block || "",
      family: m.family || "",
      // Карточка посчитана на отказавших или устаревших входах: её значение говорит о доступности
      // источника, а не о рынке (29.09 отказ обоих рядов VIX ушёл как «стресс: сильнейшее движение»).
      stale: m.stale === true,
      scheduled: !live,
      revisable: false, // ревизия ловится сравнением точек ряда, а не текущего значения
      // Суточная карточка этой панели собирается из нескольких ног с разными датами, и свежее
      // значение может смениться при той же дате наблюдения — это тоже публикация, а не тишина.
      updates: true,
      // Ряд карточки — та же величина, что напечатана на ней? У большинства — нет (у MVRV ряд —
      // отношение, а значение — перцентиль; у 2-летки ряд — уровень, а значение — изменение за
      // 4 недели). Метка «сильнейшее движение» по чужой величине врала в 25 случаях из 43.
      series_is_value: valueNum != null && finite(lastPoint) && closeNum(lastPoint, valueNum),
      release: live ? "живой рыночный фид" : m.source || "",
      points,
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
  // Доля и всё, что о ней посчитал движок. Сообщение о смене доли собирается ИЗ ЗАПИСИ РЕШЕНИЯ
  // (режим, базовая ступень, оверлей, кандидат и граница удержания, цена), а не из разницы двух
  // соседних снимков: движок меняет опубликованный режим не в тот такт, когда сдвинулись
  // показатели (понижение — вторым снимком, повышение — через 48 часов), и к моменту смены цели
  // соседние снимки одинаковы. На этом разница снимков дала пустую причину в 8 сменах из 9.
  const dec = snap.decision || {};
  const meta = snap.regime_meta?.strategic || null;
  const blocks = {};
  for (const [k, b] of Object.entries(snap.blocks || {})) {
    const fams = Object.keys(b?.strategic?.families || {}).length;
    const score = b?.strategic?.score;
    if (!finite(score) || !fams) continue;
    blocks[k] = { title: BLOCK_TITLE[k] || k, score, families: fams };
  }
  const detState = (id) => (snap.detectors || []).find((d) => d.id === id) || {};
  const mvrv = (snap.metrics || []).find((m) => m.id === "mvrv_cycle") || {};
  const overlays = dec.binding_overlays || [];
  const state = snap.regime?.strategic || dec.strategic || "";
  const ids = snap.policy_components || {};
  const histT = (snap.history || []).slice(-7).map((r) => Date.parse(r?.t || "")).filter(finite);
  const histGaps = histT.slice(1).map((t, k) => (t - histT[k]) / 60000).sort((a, b) => a - b);
  // Гейт действия витрины (docs/action-gate-v1.mjs): цель показывается, только когда решение
  // actionable, его качество good или degraded и монитор не приостановил действие. Иначе витрина
  // печатает паузу вместо цели — и для бота это та же пауза, даже если target_pct в снимке число.
  // Так бывает при потере одного краткосрочного покрытия: среднесрочный режим обычный, цель конечна
  // и может меняться, а панель её скрывает, и монитор её не исполняет (в журнале смен цели такая
  // запись помечена gate: "closed"). Сообщение «доля увеличена, повышать траншами» спорило бы с панелью.
  const health = asText(asObject(asObject(snap.monitoring)?.health)?.operational_status);
  const gate = !finite(dec.target_pct) ? "target"
    : dec.status && dec.status !== "actionable" ? "status"
    : dec.quality?.status && !["good", "degraded"].includes(dec.quality.status) ? "quality"
    : health && health !== "healthy" ? "monitor" : "";
  const levels = {};
  for (const l of asList(asObject(snap.valuation_levels)?.levels)) if (asObject(l) && asText(l.key)) levels[l.key] = { percentile: l.percentile, price: l.price_usd };
  const engine = {
    t: generatedAt,
    price: finite(snap.price) ? snap.price : null,
    status: dec.status || "",
    state,
    candidate: meta?.candidate || "",
    since: meta?.since || "",
    hold_until: meta?.hold_until || "",
    count: finite(meta?.count) ? meta.count : null,
    base: finite(dec.base_target_pct) ? dec.base_target_pct : null,
    overlays,
    ladder: dec.regime_targets_pct || null,
    blocks: Object.fromEntries(Object.entries(blocks).map(([k, b]) => [k, b.score])),
    mvrv_pct: finite(dec.inputs?.mvrv_percentile) ? dec.inputs.mvrv_percentile : finite(mvrv.value_num) ? mvrv.value_num : null,
    mvrv_score: finite(mvrv.score) ? mvrv.score : null,
    recovery: detState("recovery").state || dec.inputs?.recovery_state || "",
    recovery_inputs: detState("recovery").inputs || "",
    macro_shock: detState("macro_shock").state || dec.inputs?.macro_shock_state || "",
    distribution: detState("distribution").state || "",
    integrity_inputs: detState("integrity").inputs || "",
    emergency: !!snap.override || overlays.includes("emergency_override") || state === "emergency",
    override: typeof snap.override === "string" ? snap.override : "",
    // при паузе из-за качества решения не хватать может и краткосрочного покрытия
    missing: [...asList(snap.scores?.critical_missing?.strategic), ...(gate === "quality" ? asList(snap.scores?.critical_missing?.tactical) : [])],
    gate,
    quality: dec.quality?.status || "",
    // какие входные звенья неполны — факт вместо оговорки «относиться осторожнее»
    bad_sources: Object.entries(snap.sources || {})
      .filter(([, v]) => v && v.state && v.state !== "ok" && v.decision_relevant !== false)
      .map(([k, v]) => ({ key: k, state: v.state, name: humanRelease(v.source || k) })),
    // Правила, по которым пишется «что отменит», — замороженный контракт v1. Он повторён в этом
    // файле (V1), и текст опирается на него, только пока панель объявляет те же идентификаторы.
    contract:
      (!ids.allocation?.id || ids.allocation.id === V1.ids.allocation) &&
      (!ids.model?.id || ids.model.id === V1.ids.model) &&
      (!ids.execution?.id || ids.execution.id === V1.ids.execution) &&
      (!finite(dec.base_target_pct) || !(state in V1.ladder) || V1.ladder[state] === dec.base_target_pct),
    cadence_min: histGaps.length ? Math.round(histGaps[Math.floor(histGaps.length / 2)]) : null,
    levels,
  };
  const hasDecision = !gate;
  const allocation = {
    // Пауза решения (цели нет либо панель её скрыла) — НЕ отсутствие доли, а отдельное состояние:
    // раньше она стирала базу сравнения, и последовательность 45 → пауза → 20 не давала ни одного
    // сообщения.
    pct: hasDecision ? dec.target_pct : null,
    paused: !hasDecision,
    regime: state,
    ladder: dec.regime_targets_pct || null,
    overlays,
    reasons: dec.reason_codes || [],
    quality: dec.quality?.status || "",
    blocks,
    hold: meta,
    engine,
    // Лента причин: в состояние между запусками НЕ пишется (см. snapshotState) — она нужна только
    // в том прогоне, где читается, а в следующем снимке придёт заново.
    feed: {
      log: changeLogSteps(snap.monitoring?.target_change_log),
      history: decisionChanges(snap.history),
      // последняя запись истории ДО текущего снимка: по ней видно, соседний ли снимок лежит в базе
      prev_t: histT.length > 1 ? histT[histT.length - 2] : null,
      birth: birthOf(asObject(snap.regime_birth)?.strategic),
      tick: tickOf(snap.tick_diff),
    },
  };

  return {
    generated_at: snap.generated_at || "",
    assetWord: "биткоина",
    allocation,
    providers: Object.fromEntries(Object.entries(snap.sources || {}).map(([k, v]) => [k, String(v?.source || "")])),
    // Предупреждения сборщика о несогласованности данных; null — снимок прежней формы, поля нет.
    // Запись без пары «источник:код» в счёт не идёт: по этой паре бот узнаёт «то же самое», и без неё
    // предупреждение нельзя было бы ни не повторить, ни снять. null вместо списка (расчёт сборщика
    // отказал в этом такте) — тоже «поля нет»: висящие предупреждения остаются висеть.
    warnings: Array.isArray(snap.data_warnings)
      ? snap.data_warnings.filter((w) => asObject(w) && asText(w.source) && asText(w.code)).map((w) => ({
          key: `${w.source}:${w.code}`,
          text: asText(w.text).trim() || `${w.source}: ${w.code}`,
          affects: asList(w.affects).filter((id) => typeof id === "string"),
        }))
      : null,
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
  // Значения этой панели — уже отформатированные строки («281», «+0,1 %», «−13 б.п.»), поэтому
  // числовое поле раньше всегда оставалось пустым, и смена знака здесь не определялась ВООБЩЕ
  // (в проде разворот юаня +0,1 % → −0,0 % прошёл незамеченным). Достаём число из подписи:
  // русская запятая, типографский минус и разделители разрядов приводятся к машинному виду.
  const numFromLabel = (v) => {
    const m = String(v ?? "").replace(/[−–—]/g, "-").replace(/[\\s\\u00a0]/g, "").replace(",", ".").match(/-?\\d+(\\.\\d+)?/);
    return m ? Number(m[0]) : null;
  };
  out.verdict = { word: g("vWord").trim(), score: g("vScore").trim(),
    extra: [g("vLead").trim() && ("опережающие " + g("vLead").trim()),
            g("vCoin").trim() && ("подтверждающие " + g("vCoin").trim()),
            g("vDet").trim() && ("детекторы " + g("vDet").trim())].filter(Boolean).join(" · ") };
  for (const i of IND) {
    const r = (state.data || {})[i.id];
    if (!r || r.zi == null) continue;
    const z = i.zones[r.zi] || {};
    out.indicators.push({ id: i.id, name: i.name, value: String(r.value ?? ""),
      value_num: (typeof r.value === "number" ? r.value : numFromLabel(r.value)), unit: i.unit || "",
      delta: r.delta || "", zone: z.l || "", score: (i.info ? null : (typeof z.s === "number" ? z.s : null)),
      observed_at: r.date ? new Date(r.date).toISOString().slice(0, 10) : "",
      source: (i.link || "").replace(/^https?:\\/\\//, "").split("/")[0], note: r.note || "",
      degraded: !!r.degraded,
      series: (r.series || []).slice(-150).map(p => ({ t: +new Date(p.d ?? p.t), v: Number(p.v) })),
      voting: !i.info, lead: !!i.lead });
  }
  for (const d of DETECTORS) {
    const l = d.last || {};
    out.detectors.push({ id: d.id, name: d.name, state: l.st || "calm", inputs: l.inputs || "", note: d.logic || "" });
  }
  // Полоса доли капитала. Её проценты и условия возврата страница считает сама и ПЕЧАТАЕТ
  // («до 85%: композит ≥ +13»), поэтому запас до соседней ступени берём готовым, а не
  // повторяем правила машины ступеней у себя.
  const strip = document.getElementById("actionStrip");
  const stripText = strip ? (strip.innerText || "").replace(/\\s+/g, " ").trim() : "";
  const pctMatch = stripText.match(/(\\d{1,3})\\s*%/);
  const num = (s) => { const m = String(s).replace(",", ".").match(/-?\\d+(\\.\\d+)?/); return m ? Number(m[0]) : null; };
  // В конце полосы идёт СПРАВОЧНАЯ сноска о правилах исполнения; в ней встречаются те же слова
  // («рубильник — немедленно»), что и в боевых предупреждениях. Разбираем только «живую» часть
  // до сноски, иначе аварийный режим определяется по описанию аварийного режима.
  const live = stripText.split("правила исполнения")[0];
  out.allocation = pctMatch ? {
    pct: Number(pctMatch[1]),
    score: num(g("vScore")),
    lead: num(g("vLead")),
    up: (live.split("↑")[1] || "").split("↓")[0].trim().slice(0, 200),
    down: (live.split("↓")[1] || "").trim().slice(0, 200),
    frozen: /на паузе|заморож/i.test(live),
    override: /⚠[^⚠]{0,40}рубильник/i.test(live),
    pending: /кандидат на смену/i.test(live),
    text: live.slice(0, 600),
  } : null;
  return out;
})()`;

/* Локальная подача страницы из рабочей копии.

   ЗАЧЕМ: раньше состояние снималось с ОПУБЛИКОВАННОЙ страницы, а публикация GitHub Pages идёт
   уже после того, как уведомления стартовали. Замер в проде 28.07: страница прочитана в 14:16:19,
   а деплой свежего снимка завершился в 14:16:37 — то есть сообщения о статистике считались по
   данным ПРЕДЫДУЩЕГО цикла и опаздывали на 10–35 минут. Для «как можно оперативнее» это главный
   структурный изъян.

   Побочная выгода: уведомления перестают зависеть от здоровья Pages (24.07 сборка Pages падала
   на инциденте платформы, страница замирала — уведомления замирали вместе с ней). */
async function serveDir(dir) {
  const http = await import("node:http");
  const { readFile: rf } = await import("node:fs/promises");
  const { join, normalize } = await import("node:path");
  const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };
  const server = http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent((req.url || "/").split("?")[0]);
      // нормализация пути: раннер и без того изолирован, но выход за каталог недопустим в любом виде
      const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
      const file = join(dir, safe === "/" || safe === "\\" ? "index.html" : safe);
      const body = await rf(file);
      const ext = (file.match(/\.[a-z]+$/i) || [""])[0].toLowerCase();
      res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

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
      const { series, ...rest } = i;
      return { ...rest, scheduled: c.scheduled, revisable: c.revisable, release: c.release, cadence: c.cadence || "", points: compactSeries(series) };
    });
    return { ...raw, assetWord: "акций", indicators };
  } finally {
    await browser.close();
  }
}

async function readPanel() {
  const mode = process.env.NOTIFY_SOURCE || "auto";
  if (mode === "page" || (mode === "auto" && (PAGE_DIR || PAGE_URL) && !process.env.NOTIFY_SNAPSHOT)) {
    // Каталог рабочей копии приоритетнее опубликованного адреса: он свежее ровно на один цикл
    // публикации и не зависит от здоровья GitHub Pages.
    if (PAGE_DIR) {
      const { server, url } = await serveDir(PAGE_DIR);
      console.log(`страница поднята локально из ${PAGE_DIR}`);
      try {
        return await fromLivePage(url);
      } finally {
        server.close();
      }
    }
    if (!PAGE_URL) throw new Error("не задан ни NOTIFY_PAGE_DIR, ни NOTIFY_PAGE для режима page");
    console.log(`страница читается по сети: ${PAGE_URL} (данные могут отставать на цикл публикации)`);
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
  allocation: { emoji: "🎯", label: "изменение доли капитала" },
  pause: { emoji: "⏸", label: "пауза решения о доле" },
  hold: { emoji: "⏳", label: "удержание повышения" },
  risk: { emoji: "⚠️", label: "сигнал риска" },
  quality: { emoji: "🧩", label: "предупреждение о данных" },
  service: { emoji: "🛠", label: "служебное сообщение" },
  release: { emoji: "📊", label: "вышли новые данные" },
  revision: { emoji: "♻️", label: "пересмотр опубликованных данных" },
};

// Порядок важен: сначала то, что меняет вывод, потом то, что его питает.
const KIND_ORDER = ["allocation", "pause", "hold", "risk", "quality", "service", "release", "revision"];
// Служебные события короткие и самодостаточные: разбор от модели им не нужен, и в ожидании её
// ответа они не участвуют.
const NO_COMMENT = new Set(["pause", "hold", "quality", "service"]);
// Что идёт в осторожном режиме, когда тесты уведомлений не прошли (см. main). Предупреждение о
// данных здесь потому, что память о нём («объявлено») пишется в базу в том же прогоне: придержанное,
// оно не пришло бы уже никогда. Их по построению не больше двух за прогон.
const SAFE_KINDS = new Set(["allocation", "pause", "hold", "risk", "quality"]);
const SELFTEST_ALERT_EVERY_MS = 24 * 3600 * 1000;

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
  "bitview.space": "bitview.space",
};
const sourceLabel = (s) => SOURCE_LABEL[String(s || "").trim().toLowerCase()] || String(s || "источник");

function sameNum(a, b) {
  if (a == null || b == null) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= scale * 1e-9;
}
// Одна и та же величина с точностью до округления сборщика: последняя точка ряда и значение
// карточки считаются в разных местах, и побитового совпадения ждать нельзя.
function closeNum(a, b) {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1e-12) * 1e-6;
}
const sameSet = (a, b) => { const x = [...(a || [])].sort(), y = [...(b || [])].sort(); return x.length === y.length && x.every((v, k) => v === y[k]); };

// Число со знаком и типографским минусом: «−6,3», «+12,5», «0» — так оценки читаются в строке
// рядом с порогом и не превращаются в «--6.25».
function fmtSigned(x, digits = 1) {
  if (!finite(x)) return "—";
  const r = Number(x.toFixed(digits));
  const body = Math.abs(r).toLocaleString("ru-RU", { maximumFractionDigits: digits });
  return (r > 0 ? "+" : r < 0 ? "−" : "") + body;
}
const fmtPlain = (x, digits = 1) => (finite(x) ? x.toLocaleString("ru-RU", { maximumFractionDigits: digits }) : "—");
const fmtUsd = (x) => (finite(x) ? `${Math.round(x).toLocaleString("ru-RU")} $` : "—");
// Момент снимка в сообщении: дата без года и время с явным поясом. Пояс один для всех дат в
// сообщениях — UTC, тот же, что у дат наблюдений.
const ruMoment = (t) => {
  const d = new Date(Number(t));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};

// Читаемое число для точки ряда: у карточек разный масштаб (хешрейт 7·10²⁰ H/s и MVRV 1,8
// живут рядом), поэтому крайние порядки уходят в экспоненту, остальное — обычным числом.
function fmtPoint(v) {
  if (!finite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e7 || a < 1e-3)) return v.toExponential(3).replace(".", ",").replace("e+", "·10^").replace("e-", "·10^−");
  const digits = a >= 100 ? 1 : a >= 1 ? 2 : 4;
  return v.toLocaleString("ru-RU", { maximumFractionDigits: digits });
}

// Пара точек ряда «было → стало» в единице ряда, объявленной словарём (HUMAN[id].s). Обе стороны —
// в одной и той же единице и с четырьмя значащими цифрами: пересчёт от 0,1 % (порог рассылки) при
// такой записи всегда виден. Крупные суммы (auto) сжимаются по большей из двух сторон.
const SERIES_STEPS = [[1e12, 1e12, "трлн"], [1e9, 1e9, "млрд"], [1e6, 1e6, "млн"], [1e4, 1e3, "тыс."]];
function seriesPair(before, after, s) {
  const a = before / (s.per || 1), b = after / (s.per || 1);
  const top = Math.max(Math.abs(a), Math.abs(b));
  const step = s.auto ? SERIES_STEPS.find(([from]) => top >= from) : null;
  const tail = [step ? step[2] : "", s.u || ""].filter(Boolean).join(" ");
  const one = (x) => {
    const v = x / (step ? step[1] : 1), abs = Math.abs(v);
    const body = abs >= 1000 ? Math.round(abs).toLocaleString("ru-RU") : abs.toLocaleString("ru-RU", { maximumSignificantDigits: 4 });
    return `${v < 0 && body !== "0" ? "−" : ""}${body}${tail ? ` ${tail}` : ""}`;
  };
  return [one(a), one(b)];
}

const dayLabel = (t) => new Date(Number(t)).toISOString().slice(0, 10);
// В сообщении дата читается человеком, а не машиной: 27.05.2026 вместо 2026-05-27.
const ruDay = (t) => { const d = new Date(Number(t)); return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`; };

// Переписанная история: сравниваем ТЕ ЖЕ метки времени в старом и новом ряду. Точки от
// последней запомненной и новее не считаются — последняя точка суток ещё формируется, её
// изменение это ход рынка, а не ревизия.
// Порог значимости пересмотра точки, в процентах от её величины. Взят из распределения 38
// сообщений о пересчёте истории за 19.07–10.10.2026: у 22 из них наибольший сдвиг был меньше
// 0,1 % (у 12 — буквально «3,177·10^11 → 3,177·10^11 (+0,00%)»), следующее значение по величине —
// уже 0,17 %. Порог стоит в этом разрыве: ниже него сообщение печатало два одинаковых числа.
const REVISION_MIN_PCT = 0.1;
// Доля переписанных точек, начиная с которой это уже не пересмотр, а другой ряд целиком.
const WHOLESALE_SHARE = 0.5;

function seriesRevisions(wasPoints, curPoints) {
  const out = { changed: [], compared: 0, dust: 0 };
  if (!wasPoints || !curPoints) return out;
  const frontier = Math.max(...Object.keys(wasPoints).map(Number));
  for (const [tRaw, oldV] of Object.entries(wasPoints)) {
    const t = Number(tRaw);
    if (!finite(t) || t >= frontier) continue;
    const newV = curPoints[tRaw];
    if (!finite(newV) || !finite(oldV)) continue;
    out.compared++;
    const scale = Math.max(Math.abs(oldV), Math.abs(newV), 1e-12);
    if (Math.abs(newV - oldV) <= scale * 1e-9) continue;
    // Доля — от самой величины точки, без нижней границы масштаба: у ряда с малыми числами (доход
    // майнеров на единицу мощности — порядка 4·10^−14) граница превращала пересчёт на 1 % в «пыль».
    const top = Math.max(Math.abs(oldV), Math.abs(newV));
    if ((Math.abs(newV - oldV) / top) * 100 < REVISION_MIN_PCT) { out.dust++; continue; }
    // Процент — от МОДУЛЯ прежнего значения: у отрицательных величин «новое/старое − 1» давало
    // перевёрнутый знак (отток сократился с −22,5 до −18,9 млн, а печаталось «−16,0%»).
    out.changed.push({ t, before: oldV, after: newV, pct: oldV === 0 ? null : ((newV - oldV) / Math.abs(oldV)) * 100 });
  }
  out.changed.sort((a, b) => a.t - b.t);
  return out;
}

// Названия детекторов у панелей внутренние («Слом маржинального спроса»); наружу идёт то же
// самое, но словами, которые понятны без чтения методологии.
// Имя называет УСЛОВИЕ, которое детектор проверяет, а не факт о рынке: оно печатается при любом
// состоянии, и утверждение, верное только при срабатывании, в «наблюдении» становилось ложным —
// 12.08 пришло «Приток денег в биткоин прекратился: спокоен → наблюдение» при притоке в ETF
// +539 млн $ за пять дней (сошлись 2 условия из 4). Что именно сошлось, говорит счётчик рядом.
const DETECTOR_HUMAN = {
  "Слом маржинального спроса": "Совместное ухудшение спроса: ETF, стейблкоины, биржи, спот США",
  "Макрошок ликвидности": "Совместное ухудшение ликвидности, ставок с долларом и кредитного стресса",
  "Дистрибуция и потеря тренда": "Дорогая оценка при росте запасов на биржах и потере тренда",
  "Капитуляция → восстановление": "Признаки разворота после капитуляции",
  "Перегрев / каскад плеча": "Риск каскада ликвидаций из-за плеча",
  "Условия short squeeze": "Условия для резкого выноса продавцов вверх",
  "Нарушение целостности рынка": "Сбой рынка: цены расходятся или стейблкоин теряет привязку",
  "Фондинговый стресс": "Нехватка долларов на денежном рынке",
  "Капекс / амортизация гиперскейлеров": "Крупнейшие ИТ-компании режут инвестиции в дата-центры",
  "Стресс BDC (гейты · дивиденды)": "Фонды прямого кредитования режут выплаты или ограничивают вывод денег",
  "Нефтяной шок / Ормуз": "Скачок цен на нефть",
  "Инфляционный узел": "Инфляция и зарплаты не замедляются",
  "Разворот ФРС при спокойном кредите": "ФРС смягчает политику при спокойном кредитном рынке",
  "Триада разворота (вход после стресса)": "Складываются условия для входа после стресса",
};
const detectorHuman = (name) => DETECTOR_HUMAN[name] || name;
// Счётчик условий детектора по-русски: «условий 2/4» → «условий 2 из 4», дробь — через запятую.
const detectorInputs = (s) => String(s || "").replace(/(\d+)\s*\/\s*(\d+)/g, "$1 из $2").replace(/(\d)\.(\d)/g, "$1,$2").replace(/\s*·\s*/g, ", ").trim();

// Русский счётный род: «5 пунктов», но «3,33 пункта» и «21 наблюдением». Мелочь, но без неё
// сообщение выглядит машинным переводом.
function plural(n, one, few, many) {
  if (!Number.isInteger(n)) return few;
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ====================== УСТОЙЧИВОСТЬ РЕШЕНИЯ ======================
   Читателю нужен ВЕРДИКТ, а не пересказ механики. Поэтому класс устойчивости считается
   детерминированно по явным правилам и всегда называется одними и теми же словами (как уровни
   метеопредупреждений: слово со временем становится понятным само по себе), а объяснение даётся
   обычным языком — без «блоков», «пунктов» и «шагов».

   Что учитывается, по убыванию силы довода:
   1. ЭМПИРИКА. Как часто ТАКИЕ ЖЕ смены (тот же переход) откатывались назад в собственном
      журнале. База частот сильнее любых рассуждений о механизме — но только когда случаев не
      меньше трёх и они того же рода.
   2. ЗАПАС В ЕДИНИЦАХ ОБЫЧНОГО ШУМА. Не «5 пунктов», а «меньше, чем эта величина обычно проходит
      за сутки»: абсолютные числа читателю ничего не говорят, отношение к дневному ходу — говорит.

   Класс ставится только панели, которая сама печатает условия соседних ступеней (макро-панель).
   BTC-панель публикует запись решения целиком — там вместо класса идут факты движка.          */
const TIER = {
  forced: { word: "Принудительное", mark: "🔴" },
  shaky: { word: "Шаткое", mark: "🟠" },
  moderate: { word: "Умеренно устойчивое", mark: "🟡" },
  firm: { word: "Устойчивое", mark: "🟢" },
};

// Медиана суточного хода величины — «обычный шум», с которым сравнивается запас до отката.
function typicalDailyMove(series) {
  if (!Array.isArray(series) || series.length < 6) return null;
  const byDay = new Map();
  for (const p of series) {
    const d = new Date(p.t).toISOString().slice(0, 10);
    const cur = byDay.get(d) || { min: p.v, max: p.v };
    byDay.set(d, { min: Math.min(cur.min, p.v), max: Math.max(cur.max, p.v) });
  }
  const spans = [...byDay.values()].map((x) => Math.abs(x.max - x.min)).filter((x) => finite(x));
  if (spans.length < 3) return null;
  spans.sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)] || null;
}

// Порог из фразы, которую печатает сама панель: «до 35%: композит ≤ −13» → −13.
// Числа приходят с типографским минусом, поэтому он нормализуется.
function thresholdFrom(text) {
  const m = String(text || "").replace(/[−–—]/g, "-").match(/[≤≥<>]\s*([+-]?\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(",", ".").replace(/^\+/, "")) : null;
}

// Журнал смен по времени с устранением дублей: одна и та же смена может прийти и из журнала
// панели, и из собственного журнала бота.
function mergeChanges(published, own) {
  const all = [...(published || []), ...(own || [])].filter((c) => finite(c?.t) && finite(c?.from) && finite(c?.to));
  const seen = new Map();
  for (const c of all) seen.set(`${Math.round(c.t / 60000)}|${c.to}`, c);
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

// Род смены: «включился или снялся такой-то оверлей» либо «такой-то переход между ступенями».
// Строки журнала прежнего формата оверлеев не знают — они сравниваются только по переходу.
function changeKind(c) {
  const known = Array.isArray(c?.overlays_from) && Array.isArray(c?.overlays_to);
  const on = known ? c.overlays_to.filter((o) => !c.overlays_from.includes(o)).sort() : [];
  const off = known ? c.overlays_from.filter((o) => !c.overlays_to.includes(o)).sort() : [];
  return { known, on, off, overlay: on.length + off.length > 0, step: `${c?.from}->${c?.to}` };
}
function alikeChange(a, b) {
  const x = changeKind(a), y = changeKind(b);
  if (x.known && y.known && (x.overlay || y.overlay)) return sameSet(x.on, y.on) && sameSet(x.off, y.off);
  return x.step === y.step;
}

/* База частот: что бывало с ТАКИМИ ЖЕ сменами раньше. «Такие же» — тот же переход или тот же
   оверлей, а не все смены подряд: прежний счёт «из N таких смен M откатились» складывал повышения
   с понижениями, включал саму текущую смену и на прореженной истории панели считал одну смену
   дважды (08.08 в тексте стояло 11 смен при восьми настоящих). Текущая смена в счёт не входит;
   о каждой прошлой известно, через сколько часов наступила следующая и была ли она встречной. */
function alikeHistory(journal, step) {
  const rows = mergeChanges(journal, [step]);
  const past = [];
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (c.t >= step.t - 60000 || !alikeChange(c, step)) continue;
    const next = rows[i + 1];
    if (!next) continue;
    const opposite = Math.sign(next.to - next.from) === -Math.sign(c.to - c.from);
    past.push({ t: c.t, hours: (next.t - c.t) / 3600e3, reverted: opposite && next.t - c.t <= 48 * 3600e3 });
  }
  return past;
}
// Меньше трёх прошлых случаев — не база, а анекдот: такую строку не печатаем вовсе.
const ALIKE_MIN = 3;
const fmtSpan = (h) => (h < 72 ? `${fmtPlain(h, h < 10 ? 1 : 0)} ч` : `${fmtPlain(h / 24, 0)} сут`);

// Насколько смена доли устойчива — для панели, которая сама печатает условия соседних ступеней
// (макро-панель). Отвечает на вопрос «не откатится ли это завтра обратно».
// У BTC-панели этой оценки больше НЕТ: класс считался по расстоянию до порога «в сторону
// улучшения» при любой смене, не знал ни оверлея, ни удержания и назвал механизм отката верно
// в 4 сообщениях из 15 (единственное «Умеренно устойчивое», 19.08, прожило 7 часов). Вместо
// класса там печатаются условия отката из правил движка — см. btcAllocationEvent.
function stabilityLines(prevAlloc, curAlloc, prevState) {
  const out = [];
  // --- запас до порога берётся из условий, которые страница печатает сама ---
  // «↓ до 35%: композит ≤ −13» при текущей оценке +9 означает запас 22 пункта. Обе цифры уже
  // есть на странице, и без этого вердикт для макро-панели был почти всегда «умеренный» без
  // единого числового довода.
  let marginRaw = null;
  if (finite(curAlloc.score)) {
    const th = thresholdFrom(curAlloc.down) ?? thresholdFrom(curAlloc.up);
    if (finite(th)) marginRaw = Math.abs(curAlloc.score - th);
  }

  // --- эмпирика: как сильно величина гуляет за сутки и что бывало с такими же сменами ---
  const trend = (prevState.alloc_trend || []).concat(curAlloc.sample ? [curAlloc.sample] : []);
  const noise = typicalDailyMove(trend.map((s) => ({ t: s.t, v: s.score })).filter((x) => finite(x.v) && finite(x.t)));
  const marginDays = finite(marginRaw) && noise ? marginRaw / noise : null;
  const past = alikeHistory(prevState.alloc_changes, { t: Date.now(), from: prevAlloc.pct, to: curAlloc.pct });
  const reverted = past.filter((p) => p.reverted).length;

  // --- класс устойчивости ---
  let tier = "moderate";
  if (curAlloc.override) tier = "forced";
  else if (marginDays !== null && marginDays < 1) tier = "shaky";
  else if (marginDays !== null && marginDays >= 3) tier = "firm";

  // --- объяснение обычными словами: самые сильные доводы, без механики ---
  const reason = [];
  if (tier === "forced") reason.push("доля выставлена аварийным переключателем и вернётся, как только он снимется");
  if (marginDays !== null) {
    reason.push(
      marginDays < 1
        ? "до отката осталось меньше, чем обстановка обычно проходит за сутки"
        : `запас до отката — примерно ${fmtPoint(Math.min(marginDays, 10))} ${plural(Math.round(marginDays), "день", "дня", "дней")} обычного движения`
    );
  } else if (finite(marginRaw)) {
    // Числовой запас есть, но накопленной истории ещё мало, чтобы перевести его в дни.
    reason.push(`обстановке нужно ухудшиться ещё на ${fmtPoint(marginRaw)} ${plural(Math.round(marginRaw), "пункт", "пункта", "пунктов")} по шкале от −100 до +100, чтобы доля упала на ступень ниже`);
  }
  if (past.length >= ALIKE_MIN) {
    reason.push(
      reverted === 0
        ? `таких же смен в прошлом было ${past.length}, и ни одна не откатилась обратно в течение двух суток`
        : `в прошлом из ${past.length} таких же смен ${reverted} ${plural(reverted, "откатилась", "откатились", "откатились")} обратно в течение двух суток`
    );
  }
  if (curAlloc.up && tier !== "forced") reason.push(`вернуть прежнюю долю может: ${curAlloc.up.replace(/^апгрейд разблокируется, когда/, "снятие паузы, когда")}`);
  if (curAlloc.frozen) reason.push("повышение доли пока заморожено сработавшим сигналом риска");
  if (curAlloc.pending) reason.push("следующее изменение уже накапливает подтверждение");

  out.push({ tier, reason: reason.slice(0, 3) });
  return out;
}

/* ====================== ДОЛЯ BTC-ПАНЕЛИ: ФАКТЫ ДВИЖКА ======================
   Правила движка, на которые опирается текст о доле. Это ЗАМОРОЖЕННЫЙ контракт policy v1 панели
   (docs/policy-v1.mjs, docs/model-policy-v1.mjs, docs/execution-policy-v1.mjs). Он не импортируется:
   файл начинался общим с макро-панелью, где этих модулей нет, и бот не зависит от модулей сайта.
   Числа повторены здесь, а таблица режимов на КАЖДОМ снимке сверяется с кандидатом, которого
   посчитал сам движок (engineAgrees): разошлись — строки «что отменит» честно сокращаются до
   общих слов, и чужое правило движку не приписывается.                                        */
const V1 = {
  ids: { allocation: "btc-allocation-policy-v1", model: "btc-model-policy-v1", execution: "btc-execution-policy-v1" },
  bands: { adverse: -20, supportive: 20 },
  // Базовая лестница. Снимок публикует цели режимов уже С УЧЁТОМ действующих оверлеев
  // (regime_targets_pct: при включённом поле «переходный» там 80, а не 45), поэтому ступень
  // режима без оверлея берётся отсюда — и сверяется с base_target_pct снимка.
  ladder: { emergency: 0, defensive: 5, deteriorating: 20, transition: 45, unconfirmed_positive: 95, constructive: 100 },
  holdHours: 48,         // повышение режима принимается после стольких часов непрерывного кандидата
  recoveryAnchorPct: 25, // пол восстановления держится, пока MVRV-перцентиль ниже
  recoveryNeed: 2,       // …и подтверждений не меньше двух из трёх
  capitulationPct: 10,   // пол капитуляции: MVRV-перцентиль не выше
  euphoriaPct: 95,       // потолок эйфории: MVRV-перцентиль не ниже
};
const REGIME_WORD = {
  emergency: "аварийный", defensive: "защитный", deteriorating: "ухудшается", transition: "переходный",
  unconfirmed_positive: "положительный, спрос не подтвердил", constructive: "конструктивный", insufficient: "недостаточно данных",
};
const REGIME_SEVERITY = { constructive: 2, unconfirmed_positive: 1, transition: 0, deteriorating: -1, defensive: -2, emergency: -3, insufficient: 0 };
const OVERLAY_WORD = { recovery_floor: "пол восстановления", capitulation_floor: "пол капитуляции", euphoria_safety_cap: "потолок эйфории" };
const BLOCK_NOM = { macro: "мировые условия", demand: "спрос", cycle: "цикл и сеть" };
const BLOCK_GEN = { macro: "мировых условий", demand: "спроса", cycle: "цикла и сети" };
const SOURCE_STATE_WORD = { partial: "частично", stale: "устарели", fail: "недоступны" };
const regimeWord = (r) => REGIME_WORD[r] || r || "—";
const severity = (r) => REGIME_SEVERITY[r] ?? 0;
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Сброс удержания сообщается, только если сорванное удержание успело набрать четверть срока.
// На истории 19.07–10.10.2026 сбросов 18, и по длительности сорванного удержания они распадаются
// на две группы без середины: 12 коротких (0–10 часов — кандидат мигнул и пропал) и 6 длинных
// (19,5–41,5 часа — потеряны сутки и больше до принятого повышения). Порог стоит между ними.
// Пять сбросов 20–21.09 дают при нём ОДНО сообщение — о первом, на 41-м часу из 48; четыре
// следующих удержания прожили меньше 11 часов каждое.
const HOLD_RESET_MIN_H = 12;
// Пауза решения, повторившаяся раньше этого срока после предыдущего сообщения о паузе, идёт только
// в лог: мигающий критический источник не должен превращаться в пару сообщений на каждый такт.
// Сама новая доля после паузы приходит ВСЕГДА — глушится только слово «пауза».
const PAUSE_COOLDOWN_MS = 6 * 3600 * 1000;

// Факты движка из объекта доли. Состояние прежнего формата (до правок 10.10.2026) хранило их
// россыпью и не все — из него берётся то, что есть; у макро-панели фактов движка нет вовсе.
function engineOf(alloc) {
  if (!alloc) return null;
  if (alloc.engine) return alloc.engine;
  if (!alloc.ladder && !alloc.regime) return null;
  const hold = alloc.hold || {};
  const overlays = alloc.overlays || [];
  return {
    legacy: true,
    state: alloc.regime || hold.state || "",
    candidate: hold.candidate || "",
    since: hold.since || "",
    hold_until: hold.hold_until || "",
    count: finite(hold.count) ? hold.count : null,
    base: finite(alloc.ladder?.[alloc.regime]) ? alloc.ladder[alloc.regime] : null,
    overlays,
    ladder: alloc.ladder || null,
    blocks: Object.fromEntries(Object.entries(alloc.blocks || {}).map(([k, b]) => [k, b?.score])),
    mvrv_pct: null,
    quality: alloc.quality || "",
    emergency: overlays.includes("emergency_override") || alloc.regime === "emergency",
  };
}

const bandOf = (score) => (!finite(score) ? "unknown" : score >= V1.bands.supportive ? "supportive" : score <= V1.bands.adverse ? "adverse" : "neutral");
// Ступень режима без оверлеев — и цель, которую режим получил бы СЕЙЧАС, с действующими оверлеями.
const rungOf = (eng, r) => (eng?.contract && finite(V1.ladder[r]) ? V1.ladder[r] : null);
const rungNote = (eng, r) => (finite(rungOf(eng, r)) ? ` (ступень ${rungOf(eng, r)} %)` : "");
const targetOf = (eng, r) => (finite(eng?.ladder?.[r]) ? eng.ladder[r] : rungOf(eng, r));

// Таблица режимов движка по полосам трёх направлений (макро, спрос, цикл) с гейтом оценки и
// правами детекторов — повтор замороженной секции scoring_and_regimes_v1 сборщика.
function regimeFromBands(M, D, C, eng) {
  const adverse = [M, D, C].filter((x) => x === "adverse").length;
  let s = "transition";
  if (adverse >= 2) s = "defensive";
  else if (D === "adverse") s = "deteriorating";
  else if (adverse >= 1) s = "transition";
  else if (D === "supportive" && C === "supportive") s = "constructive";
  else if (D === "supportive" && M === "supportive") s = "constructive";
  else if (M === "supportive" && C === "supportive" && D === "neutral") s = "unconfirmed_positive";
  if ((eng.mvrv_score == null || eng.mvrv_score <= -1) && ["constructive", "unconfirmed_positive"].includes(s)) s = "transition";
  const optimistic = ["constructive", "unconfirmed_positive", "transition"];
  if (eng.macro_shock === "fired" && optimistic.includes(s)) s = "deteriorating";
  if (eng.distribution === "fired" && optimistic.includes(s)) s = "deteriorating";
  if (eng.recovery === "good" && eng.macro_shock !== "fired" && ["defensive", "deteriorating"].includes(s)) s = "transition";
  return s;
}
const bandsOf = (eng) => ({ macro: bandOf(eng.blocks?.macro), demand: bandOf(eng.blocks?.demand), cycle: bandOf(eng.blocks?.cycle) });

// Сходится ли повторённая здесь таблица с тем, что посчитал движок на ЭТОМ снимке.
function engineAgrees(eng) {
  if (!eng || eng.legacy || !eng.contract) return false;
  const b = bandsOf(eng);
  if (Object.values(b).includes("unknown")) return false;
  return regimeFromBands(b.macro, b.demand, b.cycle, eng) === eng.candidate;
}

// Что сдвинет режим: по одному направлению за раз переводим оценку через ближайшую границу полосы
// и смотрим, какой режим даёт та же таблица. dir −1 — ухудшение, +1 — улучшение. Сравнение идёт
// с ОПУБЛИКОВАННЫМ режимом: именно он задаёт цель.
function regimeShifts(eng, dir) {
  const cur = bandsOf(eng);
  const out = [];
  for (const k of ["demand", "macro", "cycle"]) {
    let to = null, threshold = null;
    if (dir < 0 && cur[k] === "supportive") { to = "neutral"; threshold = V1.bands.supportive; }
    else if (dir < 0 && cur[k] === "neutral") { to = "adverse"; threshold = V1.bands.adverse; }
    else if (dir > 0 && cur[k] === "adverse") { to = "neutral"; threshold = V1.bands.adverse; }
    else if (dir > 0 && cur[k] === "neutral") { to = "supportive"; threshold = V1.bands.supportive; }
    if (!to) continue;
    const next = { ...cur, [k]: to };
    const regime = regimeFromBands(next.macro, next.demand, next.cycle, eng);
    if (dir < 0 ? severity(regime) >= severity(eng.state) : severity(regime) <= severity(eng.state)) continue;
    const pct = targetOf(eng, regime);
    if (!finite(pct)) continue;
    out.push({ block: k, score: eng.blocks[k], threshold, margin: Math.abs(eng.blocks[k] - threshold), regime, pct });
  }
  // ближайшее по запасу — первым; при равном запасе выше ставим более сильный исход
  return out.sort((a, b) => a.margin - b.margin || (dir < 0 ? a.pct - b.pct : b.pct - a.pct));
}

function recoveryConfirmations(eng) {
  const m = String(eng?.recovery_inputs || "").match(/подтверждений\s+(\d+)\s*\/\s*(\d+)/);
  return m ? { n: Number(m[1]), of: Number(m[2]) } : null;
}
// Уровень цены, на котором MVRV-перцентиль проходит порог правила (публикует сборщик; поле
// необязательное — без него строка остаётся без цены).
function levelNote(eng, key) {
  const p = eng?.levels?.[key]?.price;
  return finite(p) ? `; это цена ≈ ${fmtPlain(p / 1000, 1)} тыс. $` : "";
}
const cadenceNote = (eng) => (finite(eng?.cadence_min) && eng.cadence_min >= 5 && eng.cadence_min <= 120 ? ` (≈ ${eng.cadence_min} мин)` : "");

// Почему кандидат движка именно такой — правило, которое сработало, в числах самого движка.
// Читается с ТЕКУЩЕГО снимка, без сравнения с соседним, поэтому верно и там, где причина смены
// осталась в прошлом.
function ruleLine(eng) {
  if (!engineAgrees(eng)) return "";
  const b = bandsOf(eng), sc = eng.blocks;
  const show = (k) => `${BLOCK_NOM[k]} ${fmtSigned(sc[k])}`;
  const adverse = ["demand", "macro", "cycle"].filter((k) => b[k] === "adverse");
  const all = ["demand", "macro", "cycle"].map(show).join(", ");
  const quiet = { macro_shock: "", distribution: "", recovery: "" };
  const gated = regimeFromBands(b.macro, b.demand, b.cycle, { ...eng, ...quiet });
  const ungated = regimeFromBands(b.macro, b.demand, b.cycle, { ...eng, ...quiet, mvrv_score: 0 });
  if (gated !== eng.candidate) {
    if (eng.recovery === "good" && eng.candidate === "transition") return "режим поднят до переходного детектором разворота";
    return "режим ограничен сработавшим детектором риска";
  }
  if (gated !== ungated) return `режим выше закрыт дорогой оценкой — MVRV-перцентиль ${fmtPlain(eng.mvrv_pct)}`;
  if (eng.candidate === "defensive") return `неблагоприятны ${adverse.length === 3 ? "все три направления" : "два направления из трёх"} — ${adverse.map(show).join(", ")} (порог −20)`;
  if (eng.candidate === "deteriorating") return `спрос неблагоприятен (${fmtSigned(sc.demand)} при пороге −20)`;
  if (eng.candidate === "transition") {
    if (adverse.length === 1) return `неблагоприятно одно направление — ${show(adverse[0])}; спрос ${fmtSigned(sc.demand)} выше порога −20`;
    return `неблагоприятных направлений нет, но для режима выше нужна поддержка двух из трёх (порог +20) — ${all}`;
  }
  const supportive = ["demand", "macro", "cycle"].filter((k) => b[k] === "supportive");
  return supportive.length ? `поддерживают ${supportive.map(show).join(", ")} (порог +20)` : "";
}

// Кандидат, который лучше опубликованного режима и ждёт своего срока.
function candidateOnHoldLine(eng) {
  if (!eng.candidate || eng.candidate === eng.state || eng.emergency || !(eng.candidate in REGIME_SEVERITY)) return "";
  if (["insufficient", "emergency"].includes(eng.candidate) || severity(eng.candidate) <= severity(eng.state)) return "";
  const until = Date.parse(eng.hold_until || "");
  return `Кандидат «${regimeWord(eng.candidate)}»${rungNote(eng, eng.candidate)} на удержании${finite(until) ? `: не раньше ${ruMoment(until)}` : ""}`;
}
// Кандидат хуже опубликованного режима: понижение уже идёт и ждёт второго снимка.
function pendingDowngrade(eng, pct) {
  if (!eng.candidate || eng.emergency || !(eng.candidate in REGIME_SEVERITY) || ["insufficient", "emergency"].includes(eng.candidate)) return null;
  if (severity(eng.candidate) >= severity(eng.state)) return null;
  const next = targetOf(eng, eng.candidate);
  return finite(next) && next < pct ? { regime: eng.candidate, pct: next } : null;
}

// Какое входное звено неполно и задевает ли это показатели, сдвинувшие долю. Факт вместо
// оговорки «относиться осторожнее» — и отдельной строкой, чтобы его не срезало никакое усечение:
// прежняя оговорка шла последней из причин и терялась в 2 сообщениях о доле из 4.
// Это два независимых факта: состояние источников (из списка источников снимка) и пометка самой
// карточки «посчитана на устаревших входах». Связывать их словами «на них опирается» нельзя:
// 23.09 неполны были биржевые цены, а на устаревших данных стояла карточка потоков ETF.
function qualityLine(eng, causeIds, staleIds) {
  if (!eng.quality || eng.quality === "good") return "";
  const names = [...new Map((eng.bad_sources || []).map((s) => [s.name, `${s.name} (${SOURCE_STATE_WORD[s.state] || s.state})`])).values()];
  const head = names.length ? `Данные неполны: ${names.slice(0, 3).join(", ")}` : "Данные неполны";
  if (!causeIds || !causeIds.length) return head;
  const hit = [...new Set(causeIds.filter((id) => staleIds.has(id)))].map((id) => `«${humanTitle(id)}»`);
  return hit.length ? `${head}. На устаревших данных сейчас ${hit.length > 1 ? "показатели" : "показатель"} этой смены: ${hit.join(", ")}` : `${head} — показатели этой смены не затронуты`;
}

function floorExitLine(eng) {
  const conf = recoveryConfirmations(eng);
  const anchor = `MVRV-перцентиль дойдёт до ${V1.recoveryAnchorPct} (сейчас ${fmtPlain(eng.mvrv_pct)}${levelNote(eng, "recovery_anchor")})`;
  const need = `подтверждений станет меньше ${V1.recoveryNeed}${conf ? ` из ${conf.of} (сейчас ${conf.n})` : ""}`;
  return `Пол снимается одним снимком, если ${anchor} или ${need}.${finite(eng.base) ? ` Цель вернётся к ступени режима — ${eng.base} %` : ""}`;
}
function floorReturnLine(eng, lead = "Пол вернётся одним снимком") {
  const conf = recoveryConfirmations(eng);
  const miss = [];
  if (!(finite(eng.mvrv_pct) && eng.mvrv_pct < V1.recoveryAnchorPct)) miss.push(`MVRV-перцентиль ниже ${V1.recoveryAnchorPct} (сейчас ${fmtPlain(eng.mvrv_pct)}${levelNote(eng, "recovery_anchor")})`);
  if (!conf || conf.n < V1.recoveryNeed) miss.push(`подтверждений не меньше ${V1.recoveryNeed}${conf ? ` из ${conf.of} (сейчас ${conf.n})` : ""}`);
  if (eng.macro_shock === "fired") miss.push("снятие макрошока");
  return miss.length ? `${lead} — нужно: ${miss.join(" и ")}` : `${lead}, как только детектор разворота подтвердится снова`;
}

// «Что отменит» — условие В СТОРОНУ, ПРОТИВОПОЛОЖНУЮ смене: для повышения — что вернёт долю вниз,
// для понижения — что и когда вернёт её вверх. Прежний текст при любой смене говорил «показатель
// должен улучшиться», то есть для повышения описывал не откат, а дальнейший рост.
function undoLines(eng, prevEng, dir, step) {
  const k = changeKind(step);
  const pct = fmtPlain(eng.mvrv_pct);
  if (eng.emergency) return ["Аварийный режим снимается первым снимком без нарушения; цель вернётся к ступени режима, который был до него, или ниже"];
  if (dir === 0) return [];
  const back = finite(eng.base) ? ` Цель вернётся к ступени режима — ${eng.base} %` : "";
  if (dir > 0) {
    if (prevEng?.emergency) return ["Аварийный режим вернётся первым же снимком с нарушением целостности рынка"];
    if (eng.overlays.includes("recovery_floor")) return [floorExitLine(eng)];
    if (eng.overlays.includes("capitulation_floor")) return [`Пол капитуляции снимается одним снимком, если MVRV-перцентиль поднимется выше ${V1.capitulationPct} (сейчас ${pct}${levelNote(eng, "capitulation_floor")}).${back}`];
    if (k.off.includes("euphoria_safety_cap")) return [`Потолок вернётся одним снимком, если MVRV-перцентиль дойдёт до ${V1.euphoriaPct} (сейчас ${pct}${levelNote(eng, "euphoria")})`];
    if (pendingDowngrade(eng, step.to)) return []; // понижение уже идёт — о нём сказано в «что делать»
    const agrees = engineAgrees(eng);
    const o = agrees ? regimeShifts(eng, -1)[0] : null;
    // Одного сдвига не хватает (режим держится удержанием, или вниз ведут только два направления
    // сразу) — тогда честнее общее правило, чем условие, которое таблица не подтверждает.
    if (!o) return [agrees && eng.state === "defensive" ? "Ниже этой ступени — только аварийный режим" : `Понижение принимается вторым снимком подряд${cadenceNote(eng)}`];
    const cross = o.threshold < 0 ? `опустится до ${fmtSigned(o.threshold, 0)}` : `опустится ниже ${fmtSigned(o.threshold, 0)}`;
    return [`Понижение до ${o.pct} % — вторым снимком подряд${cadenceNote(eng)}, если оценка ${BLOCK_GEN[o.block]} ${cross} (сейчас ${fmtSigned(o.score)})`];
  }
  if (eng.overlays.includes("euphoria_safety_cap")) return [`Потолок снимается одним снимком, если MVRV-перцентиль опустится ниже ${V1.euphoriaPct} (сейчас ${pct}${levelNote(eng, "euphoria")}).${back}`];
  const regimeFell = step.regime_from && step.regime_to && severity(step.regime_to) < severity(step.regime_from);
  if (!regimeFell && k.off.includes("recovery_floor")) return [floorReturnLine(eng)];
  if (!regimeFell && k.off.includes("capitulation_floor")) return [`Пол капитуляции вернётся одним снимком, если MVRV-перцентиль опустится до ${V1.capitulationPct} (сейчас ${pct}${levelNote(eng, "capitulation_floor")})`];
  // Понижение по режиму: обратный ход возможен не раньше чем через 48 часов непрерывного кандидата.
  const out = [];
  const earliest = ruMoment(eng.t + V1.holdHours * 3600e3);
  const until = Date.parse(eng.hold_until || "");
  const up = engineAgrees(eng) && eng.candidate === eng.state ? regimeShifts(eng, +1)[0] : null;
  if (severity(eng.candidate) > severity(eng.state) && finite(until) && eng.candidate in REGIME_SEVERITY) {
    out.push(`Возврат уже на удержании: кандидат «${regimeWord(eng.candidate)}»${rungNote(eng, eng.candidate)}, не раньше ${ruMoment(until)}`);
  } else if (up) {
    const cross = up.threshold < 0 ? `выше ${fmtSigned(up.threshold, 0)}` : `не ниже ${fmtSigned(up.threshold, 0)}`;
    out.push(`Возврат к ${up.pct} % — после ${V1.holdHours} часов удержания, не раньше ${earliest}: нужна оценка ${BLOCK_GEN[up.block]} ${cross} (сейчас ${fmtSigned(up.score)})`);
  } else {
    out.push(`Возврат вверх — после ${V1.holdHours} часов удержания, не раньше ${earliest}`);
  }
  // Пол восстановления — единственный путь вверх быстрее двух суток: он включается одним снимком.
  // 08.08 он поднял цель с 5 до 80 % через 25 часов после понижения 20 → 5, о котором прежнее
  // сообщение не говорило ничего, кроме «шаткое».
  const floorOpen = eng.contract && !eng.overlays.includes("recovery_floor") && eng.macro_shock !== "fired" &&
    finite(eng.mvrv_pct) && eng.mvrv_pct < V1.recoveryAnchorPct && ["defensive", "deteriorating", "transition"].includes(eng.state);
  if (floorOpen) out.push(floorReturnLine(eng, "Быстрее — только пол восстановления: включается одним снимком").replace(" — нужно: ", ", нужно: "));
  return out;
}

/* ====================== ЗНАЧИМОСТЬ ДВИЖЕНИЯ ======================
   «Значение изменилось» — слишком слабый повод: дневные ряды шевелятся каждый день, и половина
   сообщений превращалась в рутину (SOPR 1.0013 → 1.0004, 2-летка +28 → +26 б.п.). Значимость
   считается ИЗ САМОГО РЯДА: свежий шаг сравнивается с распределением всех прошлых шагов.
   Ничего не подгоняется руками — ни порогов на показатель, ни таблицы «что важно».

   Такт ряда тоже берётся из данных (медианный промежуток между точками), а не из таблицы:
   у дневного ряда рутину отсекаем, у недельного и реже — НИКОГДА (там каждая публикация
   событие, ради них уведомления и существуют).                                              */
function seriesStats(points) {
  if (!points) return null;
  const rows = Object.entries(points).map(([t, v]) => [Number(t), v]).sort((a, b) => a[0] - b[0]);
  if (rows.length < 12) return null;
  const steps = [];
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    steps.push({ t: rows[i][0], d: Math.abs(rows[i][1] - rows[i - 1][1]) });
    gaps.push((rows[i][0] - rows[i - 1][0]) / 864e5);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const last = steps[steps.length - 1];
  const prior = steps.slice(0, -1);
  if (!prior.length || !finite(last?.d)) return null;
  // Ранг свежего шага среди прошлых: 0.5 — обычный день, 0.95 — сильнее почти всех прошлых.
  const rank = prior.filter((s) => s.d <= last.d).length / prior.length;
  // Когда в последний раз шаг был не меньше нынешнего — из этого получается человеческая фраза
  // «самое сильное движение с такого-то числа».
  let sinceT = null;
  for (let i = prior.length - 1; i >= 0; i--) if (prior[i].d >= last.d) { sinceT = prior[i].t; break; }
  return { rank, lastStep: last.d, medianStep: med(prior.map((s) => s.d)), gapDays: med(gaps), sinceT, count: rows.length };
}

// Порог рутины для ДНЕВНЫХ рядов: наружу идёт верхняя четверть их собственных движений.
// Значение подобрано ЗАМЕРОМ на 48 боевых снимках, а не на глаз: 0.5 пропускал четвёртый знак
// SOPR и ±2 б.п. по 2-летке, 0.9 срезал уже содержательное. На 0.75 остаются сдвиг оценки
// рынка, разворот потоков ETF и движение монет на биржи — то, о чём стоит знать.
// Ряды с календарём реже дневного этот фильтр НЕ ТРОГАЕТ вовсе.
const ROUTINE_RANK = 0.75;
// Порог «заметного» движения, о котором стоит сказать прямо в сообщении.
const NOTABLE_RANK = 0.9;

// Собственная история ПОКАЗАННОЙ величины: значение карточки по датам наблюдения, как его видел
// бот. Нужна там, где ряд карточки — другая величина, чем число на ней.
const OWN_HISTORY_MAX = 90;
function ownHistory(prevHist, i) {
  // копится только там, где пригодится: у рассылаемой карточки с числом, ряд которой — другая величина
  if (i.series_is_value !== false || !i.scheduled || HUMAN[i.id]?.quiet) return prevHist || undefined;
  if (!finite(i.value_num) || !i.observed_at || !isNumericLabel(i.value)) return prevHist || undefined;
  const out = { ...(prevHist || {}), [i.observed_at]: i.value_num };
  const keys = Object.keys(out).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - OWN_HISTORY_MAX))) delete out[k];
  return out;
}
function ownHistoryPoints(hist, i) {
  const out = {};
  for (const [d, v] of Object.entries(hist || {})) { const t = Date.parse(d); if (finite(t) && finite(v)) out[t] = v; }
  const t = Date.parse(i.observed_at || "");
  if (finite(t) && finite(i.value_num)) out[t] = i.value_num;
  return Object.keys(out).length ? out : null;
}
// По какой истории судить о движении показателя. Ряд карточки годится, только если это та же
// величина, что напечатана на ней; иначе — накопленная история самого показанного числа. Пока
// её мало, метки нет вовсе: «1,11 → 1,10 (сильнейшее движение с 28.07)» считалось по цене в
// долларах при значении-отношении. Панели, которые признак не выставляют, идут по ряду как раньше.
const basisPoints = (i, hist) => (i.series_is_value === false ? ownHistoryPoints(hist, i) : i.points);

// Числовая ли подпись у карточки. Словесные («смешанное позиционирование») меток движения и
// знака не получают: их value_num — это балл, и «смена на положительные значения» о нём бессмысленна.
const isNumericLabel = (v) => /^\s*[+\-−–]?\s*[$€]?\s*\d/.test(String(v ?? ""));
const hasValue = (label) => { const s = String(label ?? "").trim(); return s !== "" && s !== "—" && s !== "-"; };

function significance(i, hist) {
  const st = seriesStats(basisPoints(i, hist));
  if (!st) return null; // нет базы для суждения — молчать нельзя, пропускаем как есть
  const daily = st.gapDays <= 1.5;
  return {
    ...st,
    daily,
    routine: daily && st.rank < ROUTINE_RANK,
    notable: st.rank >= NOTABLE_RANK,
    // «самое сильное с ...»: показываем только когда пауза действительно заметная
    sinceLabel: st.sinceT && Date.now() - st.sinceT > 21 * 864e5 ? ruDay(st.sinceT) : "",
  };
}

// В каких единицах напечатано значение карточки: подпись «-244 млн $» при value_num −2,44e8 значит
// масштаб 1e6 и хвост « млн $». История показателя переводится в те же единицы — иначе модель
// получала значение «0,98» и «историю» той же строки в долларах («68 076 … 90 582»).
function labelScale(i) {
  const m = fmtValue(i).replace(/[−–]/g, "-").match(/^\s*[+-]?\s*[$€]?\s*(\d+(?:[.,]\d+)?)(.*)$/);
  if (!m || !finite(i.value_num)) return { scale: 1, unit: "" };
  const shown = Number(m[1].replace(",", "."));
  const unit = /^(\s|%)/.test(m[2]) ? m[2].trimEnd() : "";
  if (!shown || !i.value_num) return { scale: 1, unit };
  const ratio = Math.abs(i.value_num) / shown;
  for (const s of [1, 1e3, 1e6, 1e9, 1e12]) if (Math.abs(ratio / s - 1) < 0.06) return { scale: s, unit };
  return { scale: 1, unit: "" };
}

// Короткая сводка недавней истории показателя — она уходит В КОНТЕКСТ модели, чтобы «насколько
// это существенно» опиралось на цифры, а не на ощущение. Бесплатного консенсуса аналитиков нет
// ни в одном источнике панелей, поэтому «ожидалось» честно заменяется на «как было в последние
// месяцы»: модели прямо запрещено выдумывать прогнозные цифры.
// История берётся по той же величине и в тех же единицах, что значение в строке сообщения.
function historyDigest(i, hist) {
  const pts = basisPoints(i, hist);
  if (!pts) return "";
  const rows = Object.entries(pts).map(([t, v]) => [Number(t), v]).sort((a, b) => a[0] - b[0]);
  if (rows.length < 5) return "";
  // Панель, которая не говорит, та же ли величина в ряду, что на карточке (макро-панель), получает
  // историю как раньше, числами ряда: единица подписи к чужой величине была бы выдумкой.
  const { scale, unit } = i.series_is_value === undefined ? { scale: 1, unit: "" } : labelScale(i);
  const f = (v) => `${fmtPoint(v / scale)}${unit}`;
  const vals = rows.map((r) => r[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const last = rows.slice(-4).map(([t, v]) => `${ruDay(t)} ${f(v)}`).join(", ");
  const monthAgo = rows.filter(([t]) => t <= rows[rows.length - 1][0] - 30 * 864e5).pop();
  return [
    `последние наблюдения: ${last}`,
    monthAgo ? `месяц назад ${f(monthAgo[1])}` : "",
    `за ${rows.length} наблюдений диапазон ${f(min)}…${f(max)}`,
  ].filter(Boolean).join(" · ");
}

function valueChanged(prev, cur) {
  if (prev.value_num != null && cur.value_num != null) return !sameNum(prev.value_num, cur.value_num);
  return String(prev.value) !== String(cur.value);
}

/* ---- Доля BTC-панели: шаги, причина, события ---- */

// Шаги цели между прошлым запуском бота и текущим снимком. Источники по убыванию силы: журнал
// смен монитора (в нём причина), опубликованная история решений (в ней режим, ступень и оверлеи
// каждого такта). Цепочка принимается, только если она сходится с тем, что бот видит сам: начало —
// прежняя доля, конец — нынешняя. Иначе шаг один, и строится он из двух состояний.
function allocationSteps(prevT, curT, from, to, feed) {
  const inWindow = (s) => (!finite(prevT) || s.t > prevT) && s.t <= curT + 1000;
  const chained = (steps) =>
    steps.length > 0 && sameNum(steps[0].from, from) && sameNum(steps[steps.length - 1].to, to) &&
    steps.every((s, k) => k === 0 || sameNum(s.from, steps[k - 1].to));
  for (const [source, list] of [["log", feed?.log], ["history", feed?.history]]) {
    const steps = (list || []).filter(inWindow);
    if (chained(steps) && (steps.length > 1 || !sameNum(from, to))) return { source, steps };
  }
  return { source: "diff", steps: [] };
}

// Что изменилось в устройстве цели: оверлей, режим или и то и другое.
function structureLine(s) {
  const k = changeKind(s);
  const regimeMoved = !!s.regime_from && !!s.regime_to && s.regime_from !== s.regime_to;
  const step = finite(s.base_to) ? ` (ступень ${s.base_to} %)` : "";
  const ladderDat = s.regime_to ? `ступени режима «${regimeWord(s.regime_to)}»${finite(s.base_to) ? ` (${s.base_to} %)` : ""}` : "ступени режима";
  if (k.off.includes("emergency_override") || s.regime_from === "emergency") return `Аварийный режим снят: цель вернулась к ${ladderDat}`;
  const on = k.on.find((o) => OVERLAY_WORD[o]), off = k.off.find((o) => OVERLAY_WORD[o]);
  const moved = regimeMoved ? `режим «${regimeWord(s.regime_from)}» → «${regimeWord(s.regime_to)}»${step}` : "";
  if (on) {
    const over = on === "euphoria_safety_cap" ? "при режиме" : "поверх режима";
    return `Включён ${OVERLAY_WORD[on]} ${s.to} % ${s.regime_to ? `${over} «${regimeWord(s.regime_to)}»${step}` : ""}`.trim() + (regimeMoved ? `; режим при этом сменился с «${regimeWord(s.regime_from)}»` : "");
  }
  if (off) return regimeMoved ? `Снят ${OVERLAY_WORD[off]}, ${moved}` : `Снят ${OVERLAY_WORD[off]}: цель вернулась к ${ladderDat}`;
  return capFirst(moved);
}

// Какие входы сдвинулись в этом такте: из tick_diff сборщика; если его нет — из записи журнала
// монитора о шаге этого же такта (монитор считает ту же разницу сам); а на снимке прежней формы —
// из сравнения с базой, но только если в базе лежит СОСЕДНИЙ снимок (иначе в разницу попадает всё,
// что случилось за пропущенные такты, и причина снова зависит от ритма запусков бота).
// ids — входы конкретного детектора; null — все карточки, голосующие в среднесрочном режиме.
function movedInputs(ctx, ids) {
  // без списка входов — только карточки среднесрочного контура: разница такта несёт и краткосрочные
  const want = (id) => (ids ? ids.includes(id) : !ctx.strategicIds || ctx.strategicIds.has(id));
  const staleNote = (id) => (ctx.staleIds?.has(id) ? ", источник отдал устаревшие данные" : "");
  const rows = ctx.feed?.tick ? ctx.feed.tick.families : ctx.logFamilies;
  if (rows) {
    const fams = rows.filter((f) => asText(f?.id) && want(f.id));
    return { ids: fams.map((f) => f.id), text: fams.map((f) => `«${humanTitle(f.id, f.name)}» (${fmtSigned(f.from)} → ${fmtSigned(f.to)}${staleNote(f.id)})`).join(", ") };
  }
  if (!ctx.consecutive) return { ids: [], text: "" };
  const own = [
    ...(ctx.why || []).filter((w) => want(w.id) && (ids || w.strategic)).map((w) => ({ id: w.id, text: w.sameValue ? `«${w.name}» (${w.worse ? "ухудшился" : "улучшился"})` : `«${w.name}»: ${w.from} → ${w.to}` })),
    ...(ctx.staleMoves || []).filter((w) => want(w.id) && (ids || w.strategic)).map((w) => ({ id: w.id, text: `«${w.name}» (${w.worse ? "ухудшился" : "улучшился"}, источник отдал устаревшие данные)` })),
  ];
  return { ids: own.map((x) => x.id), text: own.map((x) => x.text).join(", ") };
}

const strategicIdsOf = (panel) => new Set((panel.indicators || []).filter((i) => i.strategic).map((i) => i.id));

// Причина смены оверлея. Оверлей включается и снимается ОДНИМ снимком, без гистерезиса, поэтому
// здесь — и только здесь — причина действительно лежит в том же такте, что и смена цели.
// Якорь называется числом: 20.08 пол сняли из-за MVRV-перцентиля 19,5 → 27,2 на растущем рынке,
// а в сообщении стояло «обстановка хуже прежней».
function overlayCause(step, eng, ctx) {
  const k = changeKind(step);
  const pct = fmtPlain(eng.mvrv_pct);
  const tickFrom = ctx.feed?.tick?.mvrv_percentile?.from;
  const was = finite(tickFrom) ? tickFrom
    : ctx.consecutive && finite(ctx.prevEng?.mvrv_pct) ? ctx.prevEng.mvrv_pct
    : ctx.consecutive && finite(ctx.prevState?.indicators?.mvrv_cycle?.value_num) ? ctx.prevState.indicators.mvrv_cycle.value_num : null;
  const path = finite(was) && !sameNum(was, eng.mvrv_pct) ? `${fmtPlain(was)} → ${pct}` : pct;
  const conf = recoveryConfirmations(eng);
  const moved = movedInputs(ctx, ["trend_regime", "etf_regime", "exchange_supply"]);
  const tail = moved.text ? `; сдвинулся показатель ${moved.text}` : "";
  const floorOff = k.off.find((o) => o === "recovery_floor" || o === "capitulation_floor");
  if (floorOff && step.to > step.from) return { text: "Причина: ступень режима поднялась выше пола", ids: [] };
  if (k.on.includes("recovery_floor"))
    return { text: `Причина: детектор разворота подтверждён — MVRV-перцентиль ${pct} (ниже ${V1.recoveryAnchorPct})${conf ? `, подтверждений ${conf.n} из ${conf.of}` : ""}${tail}`, ids: moved.ids };
  if (k.off.includes("recovery_floor")) {
    if (eng.macro_shock === "fired") return { text: "Причина: сработал макрошок — он блокирует пол", ids: [] };
    if (finite(eng.mvrv_pct) && eng.mvrv_pct >= V1.recoveryAnchorPct)
      return { text: `Причина: оценка перестала быть дешёвой — MVRV-перцентиль ${path} при пороге ${V1.recoveryAnchorPct}`, ids: ["mvrv_cycle"] };
    if (conf && conf.n < V1.recoveryNeed) return { text: `Причина: подтверждений осталось ${conf.n} из ${conf.of}, нужно ${V1.recoveryNeed}${tail}`, ids: moved.ids };
    return { text: "Причина: детектор разворота больше не подтверждён", ids: [] };
  }
  if (k.on.includes("capitulation_floor")) return { text: `Причина: MVRV-перцентиль ${path} — не выше ${V1.capitulationPct}`, ids: ["mvrv_cycle"] };
  if (k.off.includes("capitulation_floor")) return { text: `Причина: MVRV-перцентиль ${path} — выше ${V1.capitulationPct}`, ids: ["mvrv_cycle"] };
  if (k.on.includes("euphoria_safety_cap")) return { text: `Причина: MVRV-перцентиль ${path} — не ниже ${V1.euphoriaPct}`, ids: ["mvrv_cycle"] };
  if (k.off.includes("euphoria_safety_cap")) return { text: `Причина: MVRV-перцентиль ${path} — ниже ${V1.euphoriaPct}`, ids: ["mvrv_cycle"] };
  return { text: "", ids: [] };
}

// Причина смены режима из записи о рождении кандидата (regime_birth сборщика): что сдвинулось в
// тот снимок, где кандидат появился, — за 48 часов до повышения или за один снимок до понижения.
const BAND_MOVE = {
  "adverse>neutral": "вышла из неблагоприятной полосы", "neutral>adverse": "ушла в неблагоприятную полосу",
  "neutral>supportive": "вошла в поддерживающую полосу", "supportive>neutral": "вышла из поддерживающей полосы",
  "adverse>supportive": "перешла из неблагоприятной полосы в поддерживающую", "supportive>adverse": "перешла из поддерживающей полосы в неблагоприятную",
};
function birthCause(birth, detName) {
  const ids = [];
  const blocks = [];
  for (const [k, b] of Object.entries(birth.blocks || {})) {
    if (!BLOCK_GEN[k] || !finite(b?.from) || !finite(b?.to)) continue;
    const band = BAND_MOVE[`${b.band_from}>${b.band_to}`];
    blocks.push(`оценка ${BLOCK_GEN[k]} ${fmtSigned(b.from)} → ${fmtSigned(b.to)}${band ? ` (${band})` : ""}`);
  }
  const fams = (birth.families || []).filter((f) => f?.id).map((f) => { ids.push(f.id); return `«${humanTitle(f.id, f.name)}» ${fmtSigned(f.from)} → ${fmtSigned(f.to)}`; });
  const dets = (birth.detectors || []).filter((d) => d?.id).map((d) => `${detName(d.id)}: ${DET_LABEL[d.from] || d.from} → ${DET_LABEL[d.to] || d.to}`);
  const t = Date.parse(birth.t || "");
  const when = finite(t) ? ` (кандидат с ${ruMoment(t)})` : "";
  const body = [blocks.join("; "), fams.join(", "), dets.join(", ")].filter(Boolean).join(": ");
  // пустая запись без пометки о покрытии ничего не объясняет — пусть причину даёт запасная ветка
  if (!body && birth.note !== "coverage") return null;
  if (!body) return { text: `Причина: кандидат сменился из-за покрытия данных, оценки не менялись${when}`, ids };
  return { text: `Причина: ${body}${when}`, ids };
}

// Сообщение о смене доли BTC-панели: собирается из записи решения, а не из разницы снимков.
// По нему должно быть можно действовать, не открывая панель: было → стало, цена и время, что
// именно изменилось (режим или оверлей), причина, что делать по правилу исполнения и что отменит.
function btcAllocationEvent({ panel, prevState, prevEng, lastPct, found, resumed, why, staleMoves, staleIds, consecutive, base }) {
  const curAlloc = panel.allocation, eng = curAlloc.engine, feed = curAlloc.feed || {};
  const asset = panel.assetWord || "рискового актива";
  const from = lastPct, to = curAlloc.pct;
  const dir = Math.sign(to - from);
  // После паузы «прежнего» режима и оверлея нет — шаг знает только, что стало.
  const before = resumed ? null : prevEng;
  const steps = found.steps.length
    ? found.steps.map((s) => ({ ...s }))
    : [{ t: eng.t, from, to, regime_from: before?.state || "", regime_to: eng.state, overlays_from: before ? before.overlays || [] : null, overlays_to: eng.overlays, base_from: before?.base ?? null, base_to: eng.base, price: eng.price }];
  for (const s of steps) {
    // журнал монитора не несёт базовую ступень — она есть в истории панели на тот же момент
    const h = (feed.history || []).find((x) => Math.abs(x.t - s.t) < 1000);
    if (h) {
      for (const f of ["base_from", "base_to", "price"]) if (!finite(s[f]) && finite(h[f])) s[f] = h[f];
      if (!s.regime_to) { s.regime_from = h.regime_from; s.regime_to = h.regime_to; }
    }
    // Шаг взят не из журнала (цепочка журнала не сошлась с тем, что видит бот), но запись о том же
    // переходе в журнале есть — причина берётся из неё. Тот же переход дважды за полчаса невозможен.
    if (!s.cause || !s.born) {
      const e = (feed.log || []).find((x) => sameNum(x.from, s.from) && sameNum(x.to, s.to) && Math.abs(x.t - s.t) <= 30 * 60e3);
      if (e && !s.cause && e.cause) s.cause = e.cause;
      if (e && !s.born && e.born) s.born = e.born;
    }
  }
  const last = steps[steps.length - 1];
  // Последний шаг случился в ТЕКУЩЕМ снимке — тогда факты «сейчас» относятся именно к нему.
  const live = Math.abs(last.t - eng.t) < 1000;
  if (live) {
    if (!finite(last.base_to)) last.base_to = eng.base;
    if (!last.regime_to) last.regime_to = eng.state;
    if (!finite(last.price)) last.price = eng.price;
  }
  // история без режима (снимки ранних версий): у единственного шага он известен из базы сравнения
  if (steps.length === 1 && !resumed && !last.regime_from && prevEng?.state) last.regime_from = prevEng.state;
  const k = changeKind(last);
  const emergencyOn = eng.emergency;
  const emergencyOff = !eng.emergency && !!prevEng?.emergency;
  const regimeMoved = !!last.regime_from && !!last.regime_to && last.regime_from !== last.regime_to;
  const regimeUp = regimeMoved && severity(last.regime_to) > severity(last.regime_from);
  // Выдержал ли кандидат полный срок: момент его рождения — из журнала монитора, а без журнала —
  // из самого снимка (на такте принятия кандидат и есть новый режим).
  const bornAt = Date.parse(last.born || (live ? eng.since : "") || "");
  const heldFull = finite(bornAt) && last.t - bornAt >= (V1.holdHours - 0.5) * 3600e3;
  const detName = (id) => detectorHuman((panel.detectors || []).find((d) => d.id === id)?.name || id);
  const ctx = { feed, prevState, prevEng, why, staleMoves, staleIds, strategicIds: strategicIdsOf(panel), consecutive: consecutive && live, logFamilies: live && last.cause?.families?.length ? last.cause.families : null };

  const verb = dir > 0 ? "увеличена" : "сокращена";
  const title = emergencyOn ? `Аварийный режим: доля ${asset} ${to === 0 ? "обнулена" : verb}`
    : emergencyOff ? `Аварийный режим снят: доля ${asset} ${verb}`
    : dir === 0 ? `Доля ${asset} менялась между запусками`
    : resumed ? `Решение возобновлено: доля ${asset} ${verb}`
    : `Доля ${asset} ${verb}`;

  const causes = [];
  if (resumed) {
    const since = Date.parse(prevState.pause?.since || "");
    const ovl = eng.overlays.find((o) => OVERLAY_WORD[o]);
    causes.push(`Решение возобновлено после паузы${finite(since) ? ` (с ${ruMoment(since)})` : ""}`);
    if (!emergencyOn) causes.push(`Режим «${regimeWord(eng.state)}»${finite(eng.base) ? ` (ступень ${eng.base} %)` : ""}${ovl ? `, действует ${OVERLAY_WORD[ovl]} ${to} %` : ""}`);
    const rule = eng.candidate === eng.state ? ruleLine(eng) : "";
    if (rule && !emergencyOn) causes.push(`Сейчас: ${rule}`);
  }
  if (steps.length > 1) {
    // Бот пропустил такты: между запусками цель прошла несколько шагов. Каждый назван — иначе
    // двухшаговое «80 → 45 → 5» читалось бы как одно «80 → 5», а круг «20 → 80 → 20» не оставлял следа.
    causes.push(`Путь: ${[`${from} %`, ...steps.map((s) => `${s.to} % (${ruMoment(s.t)})`)].join(" → ")}`);
    for (const s of steps.slice(0, -1)) {
      const kind = changeKind(s);
      const on = kind.on.find((o) => OVERLAY_WORD[o]), off = kind.off.find((o) => OVERLAY_WORD[o]);
      const what = on ? `включён ${OVERLAY_WORD[on]}` : off ? `снят ${OVERLAY_WORD[off]}`
        : s.regime_from && s.regime_to && s.regime_from !== s.regime_to ? `режим «${regimeWord(s.regime_from)}» → «${regimeWord(s.regime_to)}»` : "смена цели";
      causes.push(`${s.from} % → ${s.to} % — ${what}${s.cause?.text ? ` (${s.cause.text})` : ""}`);
    }
  }
  // что изменилось
  if (emergencyOn) {
    causes.push(`Сработал аварийный переключатель${eng.override ? `: ${eng.override.toLowerCase()}` : ""}${eng.integrity_inputs ? ` (${detectorInputs(eng.integrity_inputs)})` : ""}. Цель обнулена независимо от режима`);
  } else if (!resumed) {
    let what = structureLine(last);
    if (what && regimeMoved && !emergencyOff && !["insufficient", "emergency"].includes(last.regime_from)) {
      if (regimeUp && heldFull) what += `, принят после ${V1.holdHours} часов удержания`;
      else if (!regimeUp) what += ", подтверждён вторым снимком подряд";
    }
    if (what) causes.push(what);
  }
  // причина
  const causeIds = [];
  const plainStep = !emergencyOn && !emergencyOff && !resumed && dir !== 0;
  // у оверлея входы известны по построению детектора — на них и проверяется качество данных
  const floorIds = k.on.concat(k.off).includes("recovery_floor") ? ["mvrv_cycle", "trend_regime", "etf_regime", "exchange_supply"] : null;
  // У оверлея гистерезиса нет: причина его смены лежит в ЭТОМ же снимке, и детектор называет её
  // числами — перцентиль против порога, счёт подтверждений. Поэтому смена одного оверлея,
  // случившаяся в текущем снимке, объясняется со снимка, одинаково при журнале монитора и без
  // него. Журнал нужен там, где снимок причины не несёт: у смены режима (она родилась за 48 часов
  // до смены цели) и у шага, пропущенного между запусками.
  const oc = plainStep && k.overlay && live ? overlayCause(last, eng, ctx) : null;
  if (oc?.text && !regimeMoved) {
    causes.push(oc.text);
    causeIds.push(...(floorIds || oc.ids));
  } else if (last.cause?.text) {
    const since = Date.parse(last.born || "");
    causes.push(`Причина: ${last.cause.text}${regimeMoved && finite(since) && Math.abs(since - last.t) > 60000 ? ` (кандидат с ${ruMoment(since)})` : ""}`);
    for (const f of last.cause.families || []) if (asText(f.id)) causeIds.push(f.id);
    if (floorIds) causeIds.push(...floorIds);
    else if (k.overlay) causeIds.push("mvrv_cycle");
  } else if (plainStep) {
    if (oc) {
      if (oc.text) causes.push(oc.text);
      causeIds.push(...(floorIds || oc.ids));
    }
    if (regimeMoved) {
      // Без журнала монитора причину смены режима из соседнего снимка НЕ выдумываем: к моменту
      // смены цели соседние снимки одинаковы, а случайное совпадение уже раз назвали причиной
      // (23.09 — качок источника ETF). Есть запись о рождении кандидата — берём её; нет — говорим
      // только то, что известно: режим сменился по правилу удержания, и каков он сейчас.
      const bc = live && feed.birth && feed.birth.candidate === last.regime_to ? birthCause(feed.birth, detName) : null;
      if (bc) {
        causes.push(bc.text);
        causeIds.push(...bc.ids);
      } else {
        causes.push(!regimeUp ? "Причина: смена режима, подтверждённая вторым снимком" : heldFull ? "Причина: смена режима, принятая после удержания" : "Причина: смена режима");
        // правило читается с кандидата — оно объясняет режим, только когда кандидат им и стал
        const rule = live && eng.candidate === eng.state ? ruleLine(eng) : "";
        if (rule) causes.push(`Сейчас: ${rule}`);
      }
    }
  }
  const undo = undoLines(eng, prevEng, dir, last);
  if (!emergencyOn) {
    // после понижения по режиму кандидат на удержании и есть «что отменит» — дважды не печатаем
    const hold = candidateOnHoldLine(eng);
    if (hold && !undo.some((u) => u.startsWith("Возврат уже на удержании"))) causes.push(hold);
  }
  const track = prevState.hold_track;
  if (regimeUp && track && track.state === last.regime_from && track.resets > 0) {
    const first = Date.parse(track.first_since || "");
    causes.push(`Удержание до этого срывалось ${track.resets} ${plural(track.resets, "раз", "раза", "раз")}${finite(first) ? `: первый кандидат на повышение появился ${ruMoment(first)}` : ""}`);
  }
  const quality = qualityLine(eng, causeIds, staleIds);
  if (quality) causes.push(quality);
  // База частот — по журналу монитора, а без него по собственному журналу бота; опубликованная
  // история панели сюда не идёт: на прореженных строках она считала одну смену дважды.
  const past = dir !== 0 ? alikeHistory(feed.log && feed.log.length ? feed.log : prevState.alloc_changes, last) : [];
  if (past.length >= ALIKE_MIN) {
    const what = k.on.length && OVERLAY_WORD[k.on[0]] ? `${capFirst(OVERLAY_WORD[k.on[0]])} включался` : "Такая же смена была";
    causes.push(`${what} ${past.length} ${plural(past.length, "раз", "раза", "раз")}: следующая смена цели наступала через ${past.slice(-5).map((p) => fmtSpan(p.hours)).join(", ")}`);
  }

  // что делать — по правилу исполнения панели: понижение сразу, повышение траншами
  const todo = [];
  const next = pendingDowngrade(eng, to);
  if (eng.contract) {
    if (emergencyOn) todo.push("Понижение — сразу: убрать риск и ждать нормализации");
    else if (dir > 0) todo.push(next ? `Повышение — траншами со следующей сессии; к ней цель может снизиться: кандидат уже «${regimeWord(next.regime)}» (${next.pct} %)` : "Повышение — траншами со следующей сессии");
    else if (dir < 0) todo.push(next ? `Понижение — сразу. Кандидат уже «${regimeWord(next.regime)}»: следующий шаг до ${next.pct} % подтвердится ближайшим снимком` : "Понижение — сразу");
    else todo.push(`Действий не требуется: цель снова ${to} %`);
  }

  return {
    kind: "allocation",
    // Ключ — сам переход с меткой времени события. Прежний ключ времени не знал, и повтор той же
    // смены в течение семи суток глушился: из 20 → 80 → 20 → 80 → 20 доходили два сообщения из
    // четырёх. Метка — время шага, а не запуска: повторный прогон после сбоя даёт тот же ключ.
    key: found.source === "diff" ? `alloc:${from}->${to}@base:${base}` : `alloc:${from}->${to}@${new Date(last.t).toISOString()}`,
    emoji: emergencyOn ? "🚨" : undefined,
    title,
    before: dir === 0 ? "" : `${from}%`,
    after: dir === 0 ? "" : `${to}%`,
    detail: [finite(last.price) ? `BTC ${fmtUsd(last.price)}` : "", ruMoment(last.t)].filter(Boolean).join(" · "),
    causes,
    todo,
    undo,
    // машинночитаемый след: из него пополняется журнал смен и строится шаблонный комментарий
    steps: steps.map(({ cause, born, ...s }) => s),
    facts: {
      dir, source: found.source, resumed: !!resumed,
      what: emergencyOn ? "emergency" : emergencyOff ? "emergency_off" : k.overlay && regimeMoved ? "both" : k.overlay ? "overlay" : regimeMoved ? "regime" : "",
      on: k.on, off: k.off, regime_up: regimeUp, held: heldFull, explained: !!last.cause?.text,
    },
    note: "",
  };
}

function pauseEvent(panel, base, lastPct) {
  const eng = panel.allocation.engine;
  const missing = (eng.missing || []).map((g) => String(g).split("|").map((id) => humanTitle(id.trim())).join(" или "));
  // цель в снимке есть, но гейт действия закрыт: панель её не показывает
  const hidden = eng.gate === "quality" || eng.gate === "monitor";
  const why = eng.gate === "monitor" ? "монитор панели приостановил действие"
    : eng.gate === "quality" || eng.status === "paused" || eng.state === "insufficient"
      ? missing.length ? `не хватает данных — ${missing.slice(0, 3).join("; ")}` : "критических данных недостаточно"
      : "панель не опубликовала решение";
  return {
    kind: "pause",
    key: `pause:on@base:${base}`,
    title: `Решение о доле ${panel.assetWord || "рискового актива"} на паузе`,
    before: "",
    after: "",
    detail: `${hidden ? "Панель скрыла цель" : "Цель не опубликована"}: ${why}`,
    todo: [`Новых действий не предпринимать. Последняя цель — ${lastPct} %`],
    undo: [hidden ? "Цель вернётся первым же снимком, в котором панель снова её покажет" : "Цель вернётся первым же снимком, в котором решение опубликовано"],
    note: "",
  };
}

// Удержание повышения сорвано: кандидат лучше опубликованного режима ждал своих 48 часов и
// пропал. 20–21.09 пять таких сбросов из-за источника ETF сдвинули повышение 20 → 45 примерно
// на 60 часов (цена 81,2 → 86,2 тыс.) — и ни одного сообщения об этом не было.
function holdResetEvent({ panel, prevState, prevEng, why, staleMoves, staleIds, consecutive }) {
  const eng = panel.allocation.engine, feed = panel.allocation.feed || {};
  if (!prevEng || !prevEng.hold_until || eng.state !== prevEng.state || eng.candidate === prevEng.candidate) return null;
  if (!(prevEng.candidate in REGIME_SEVERITY) || severity(prevEng.candidate) <= severity(prevEng.state)) return null;
  const since = Date.parse(prevEng.since || "");
  const prevT = Date.parse(prevState.generated_at || "");
  if (!finite(since) || !finite(prevT)) return null;
  const heldH = (prevT - since) / 3600e3;
  if (heldH < HOLD_RESET_MIN_H) {
    console.log(`удержание повышения сорвано на ${fmtPlain(heldH)} ч (короче ${HOLD_RESET_MIN_H} ч — в рассылку не идёт)`);
    return null;
  }
  const step = (r) => rungNote(eng, r);
  const rule = ruleLine(eng);
  const moved = movedInputs({ feed, why, staleMoves, staleIds, consecutive, strategicIds: strategicIdsOf(panel) }, null);
  const again = severity(eng.candidate) > severity(eng.state) && eng.hold_until && eng.candidate in REGIME_SEVERITY;
  const down = pendingDowngrade(eng, panel.allocation.pct);
  const lines = [
    `Причина: по свежим данным режим ${eng.candidate === eng.state ? "снова" : "уже"} «${regimeWord(eng.candidate)}»${rule ? `: ${rule}` : ""}${moved.text ? `; сдвинулся показатель ${moved.text}` : ""}`,
    again ? `Отсчёт начат заново для кандидата «${regimeWord(eng.candidate)}»${step(eng.candidate)}: не раньше ${ruMoment(Date.parse(eng.hold_until))}`
      : down ? `Кандидат хуже текущего режима: понижение до ${down.pct} % подтвердится ближайшим снимком`
      : `Отсчёт ${V1.holdHours} часов начнётся заново, когда кандидат вернётся`,
  ];
  return {
    kind: "hold",
    // не чаще раза на удержание: ключ — момент рождения сорванного кандидата
    key: `hold:reset@${prevEng.since}`,
    title: `Повышение доли ${panel.assetWord || "рискового актива"} откладывается`,
    before: "",
    after: "",
    detail: `Кандидат «${regimeWord(prevEng.candidate)}»${step(prevEng.candidate)} продержался ${fmtPlain(heldH)} ч из ${V1.holdHours} и сорван ${ruMoment(eng.t)}. Цель остаётся ${panel.allocation.pct} %`,
    lines,
    note: "",
  };
}

// Сигнал риска: детектор сработал или снялся. Промежуточное «наблюдение» (часть условий сошлась,
// подтверждения нет) НЕ рассылается: оно мигает туда-обратно и в проде дало сообщения вида
// «подтверждений 1/3», из которых читателю нечего делать. Наружу идут только срабатывание и снятие.
// В ключе — момент базы сравнения: то же срабатывание после снятия — новое событие, а не повтор
// (раньше оно молча глушилось семь суток), а повторный прогон после сбоя даёт тот же ключ.
function riskEvents(detectorMoves, base, skipId = "") {
  const out = [];
  for (const { d, from, to } of detectorMoves) {
    if (!(to === "fired" || from === "fired")) {
      console.log(`сигнал риска в промежуточном состоянии (в рассылку не идёт): ${detectorHuman(d.name)} ${from} → ${to}`);
      continue;
    }
    if (skipId && d.id === skipId) continue;
    out.push({
      kind: "risk",
      key: `risk:${d.id}:${to}@base:${base}`,
      title: detectorHuman(d.name),
      before: DET_LABEL[from] || from,
      after: DET_LABEL[to] || to,
      detail: detectorInputs(d.inputs).slice(0, 260),
      note: d.note || "",
    });
  }
  return out;
}

// Все события о решении BTC-панели за один такт: пауза, смена доли, возобновление, сброс
// удержания, сигналы риска.
function btcDecisionEvents({ prevState, panel, why, staleMoves, staleIds, detectorMoves }) {
  const out = [];
  const curAlloc = panel.allocation, eng = curAlloc.engine, feed = curAlloc.feed || {};
  const prevAlloc = prevState.allocation || null;
  const prevEng = engineOf(prevAlloc);
  const prevT = Date.parse(prevState.generated_at || "");
  const base = prevState.generated_at || "";
  const consecutive = finite(prevT) && finite(feed.prev_t) && Math.abs(feed.prev_t - prevT) < 1000;
  const hadTarget = !!prevAlloc && finite(prevAlloc.pct);
  // Состояние прежнего формата на паузе доли не хранило вовсе (allocation: null). Последняя
  // опубликованная цель в нём всё же есть — в ряду наблюдений; по ней выкладка, попавшая на
  // паузу решения, не теряет сообщение о возобновлении.
  const legacyLast = prevState.version !== 2 && !prevAlloc ? (prevState.alloc_trend || []).filter((s) => finite(s?.pct) && s.blocks).pop()?.pct : null;
  const lastPct = hadTarget ? prevAlloc.pct : finite(prevState.last_alloc?.pct) ? prevState.last_alloc.pct : finite(legacyLast) ? legacyLast : null;
  // вход в аварийный режим и выход из него называют нарушение целостности сами — отдельный сигнал
  // о том же детекторе был бы повтором
  const risk = () => riskEvents(detectorMoves, base, eng.emergency || prevEng?.emergency ? "integrity" : "");

  if (curAlloc.paused) {
    if (hadTarget) {
      const lastAt = Date.parse(prevState.pause?.notified_at || "");
      if (finite(lastAt) && eng.t - lastAt < PAUSE_COOLDOWN_MS) console.log("пауза решения повторилась раньше чем через 6 часов после прошлого сообщения о паузе (в рассылку не идёт)");
      else out.push(pauseEvent(panel, base, prevAlloc.pct));
    }
    return out.concat(risk());
  }
  // Базы нет: бот впервые видит решение (или состояние прежнего формата застало паузу) — фиксируем.
  if (lastPct === null) return out.concat(risk());

  const resumed = !!prevAlloc?.paused || !hadTarget;
  const found = resumed ? { source: "diff", steps: [] } : allocationSteps(prevT, eng.t, lastPct, curAlloc.pct, feed);
  const shared = { panel, prevState, prevEng, why, staleMoves, staleIds, consecutive };
  if (!sameNum(lastPct, curAlloc.pct) || found.steps.length > 1) {
    out.push(btcAllocationEvent({ ...shared, lastPct, found, resumed, base }));
  } else {
    if (resumed && prevState.pause?.announced) {
      out.push({
        kind: "pause",
        emoji: "▶️",
        key: `pause:off@base:${base}`,
        title: `Решение о доле ${panel.assetWord || "рискового актива"} возобновлено`,
        before: "",
        after: "",
        detail: `Цель прежняя — ${curAlloc.pct} %`,
        note: "",
      });
    }
    const reset = holdResetEvent(shared);
    if (reset) out.push(reset);
  }
  return out.concat(risk());
}

/* ---- Предупреждения сборщика о данных ---- */

// Появление объявляется со второго запуска подряд (мигнувшее на один такт предупреждение — не
// новость), снятие — после шести часов отсутствия (источник, который мигает, не должен слать
// пару «появилось / снято» на каждый такт). Итог: одно сообщение при появлении и одно при снятии.
const WARN_CONFIRM_RUNS = 2;
const WARN_CLEAR_MS = 6 * 3600 * 1000;
function trackWarnings(prevW, list, now, baseline = false) {
  const state = {}, appeared = [], cleared = [];
  const nowIso = new Date(now).toISOString();
  const present = new Map((list || []).map((w) => [w.key, w]));
  for (const [key, w] of present) {
    const was = prevW?.[key];
    // baseline — первый запуск без состояния: всё, что уже висит, принимается за известное
    const rec = { text: w.text, affects: w.affects || [], since: was?.since || nowIso, runs: (was?.runs || 0) + 1, announced: baseline || !!was?.announced, gone_since: null };
    if (!rec.announced && rec.runs >= WARN_CONFIRM_RUNS) { rec.announced = true; appeared.push({ key, ...rec }); }
    state[key] = rec;
  }
  for (const [key, was] of Object.entries(prevW || {})) {
    if (present.has(key) || !was?.announced) continue; // не успело подтвердиться — и снимать нечего
    const gone = was.gone_since || nowIso;
    if (now - Date.parse(gone) >= WARN_CLEAR_MS) cleared.push({ key, ...was });
    else state[key] = { ...was, gone_since: gone };
  }
  return { state, appeared, cleared };
}
function warningEvents(prevState, panel) {
  if (!panel.warnings) return []; // снимок прежней формы: поля нет — нечего ни объявлять, ни снимать
  const now = Date.parse(panel.generated_at || "") || Date.now();
  const { appeared, cleared } = trackWarnings(prevState.warnings, panel.warnings, now);
  const line = (w) => `${w.text}${w.affects?.length ? ` — затронуты: ${w.affects.map((id) => `«${humanTitle(id)}»`).join(", ")}` : ""}`;
  const out = [];
  if (appeared.length) out.push({ kind: "quality", key: `warn:on:${appeared.map((w) => w.key).sort().join("+")}@${appeared[0].since}`, title: "Предупреждение о данных", before: "", after: "", detail: "", lines: appeared.map(line), note: "" });
  if (cleared.length) out.push({ kind: "quality", key: `warn:off:${cleared.map((w) => w.key).sort().join("+")}@${cleared[0].gone_since || ""}`, title: "Предупреждение о данных снято", before: "", after: "", detail: "", lines: cleared.map((w) => w.text), note: "" });
  return out;
}

function diff(prevState, panel) {
  const events = [];
  const releaseGroups = [];
  const revisedSeries = [];
  const bounced = [];
  const switched = [];
  let dust = 0;
  const seenRevised = prevState.revised_points || {};
  const prevInd = prevState.indicators || {};
  const shownMap = prevState.shown || {};

  // Изменения внутри панели (вердикт, зоны показателей, детекторы) сами по себе НЕ рассылаются:
  // это внутренняя кухня. Они собираются как объяснение к единственному внешнему событию о самой
  // панели — смене доли капитала. Исключение: сработавший детектор риска, который долю не сдвинул,
  // уходит коротким отдельным сообщением, потому что это факт о рынке, а не о панели.
  const prevAlloc = prevState.allocation || null;
  const curAlloc = panel.allocation || null;
  const why = [];
  const staleMoves = [];
  const staleIds = new Set((panel.indicators || []).filter((i) => i.stale).map((i) => i.id));
  const detectorMoves = [];

  const prevDet = prevState.detectors || {};
  for (const d of panel.detectors || []) {
    const was = prevDet[d.id];
    if (was && was.state !== d.state) detectorMoves.push({ d, from: was.state, to: d.state });
  }

  // Сменился ли в этом такте поставщик хоть одного набора данных — нужно, чтобы отличить пересмотр
  // истории от подмены ряда резервным источником.
  const providerSwitch = Object.keys(panel.providers || {}).some((k) => prevState.providers?.[k] && panel.providers[k] && prevState.providers[k] !== panel.providers[k]);

  for (const i of panel.indicators || []) {
    const was = prevInd[i.id];
    if (!was) continue; // первый прогон только фиксирует базу, не шлёт историю целиком
    // Карточка на встроенной оценке вместо живого источника: её значение говорит о доступности
    // источника, а не о рынке. Сообщать об этом — значит слать шум при каждом сбое сети раннера
    // (FRED и Stooq режут раннеры GitHub, у страницы на них штатные резервы).
    if (i.degraded || was.degraded) continue;
    // BTC-панель: карточка посчитана на отказавших входах. В рассылку она не идёт и причиной
    // смены доли не называется; база сравнения при этом НЕ двигается (см. snapshotState), поэтому
    // после возврата источника свежее значение сравнится с последним свежим и ничего не потеряется.
    if (i.stale) {
      if (i.score != null && was.score != null && !sameNum(i.score, was.score)) {
        staleMoves.push({ id: i.id, name: humanTitle(i.id, i.name), worse: i.score < was.score, strategic: !!i.strategic });
      }
      continue;
    }
    if (was.stale) continue; // свежей базы ещё не было: карточка впервые увидена уже на отказавших входах

    const zoneChanged =
      (i.zone != null && was.zone != null && i.zone !== was.zone) ||
      (i.score != null && was.score != null && !sameNum(i.score, was.score));
    const dateAdvanced = i.observed_at && was.observed_at && i.observed_at > was.observed_at;
    const sameDate = !!i.observed_at && i.observed_at === was.observed_at;
    const changed = valueChanged(was, i);
    const dict = HUMAN[i.id] || {};

    // Сдвиг оценки показателя — не сообщение, а материал для объяснения смены доли капитала.
    if (zoneChanged) {
      why.push({
        id: i.id,
        name: humanTitle(i.id, i.name),
        from: fmtValue(was),
        to: fmtValue(i),
        worse: (i.score ?? 0) < (was.score ?? 0),
        sameValue: fmtValue(was) === fmtValue(i),
        strategic: !!i.strategic,
      });
    }
    // Релиз: вышли новые данные И значение действительно изменилось.
    // Одна публикация первоисточника обычно двигает несколько карточек (H.15 — сразу пять,
    // ETF — четыре), поэтому релизы собираются в ОДНО сообщение на публикацию, а не на карточку.
    // Обновление в ту же дату (updates) — тоже публикация: у суточных карточек BTC-панели свежее
    // значение меняется без сдвига даты (приток ETF за 17.08 ушёл как +137 млн $, через четыре
    // часа стал +298 млн $ — молча; «Запас на биржах» сменил категорию восемь раз — молча).
    // Карточка с пометкой drift идёт только со сдвигом даты и сравнивается тогда не с прошлым тактом,
    // а с тем, что читатель видел в прошлом сообщении. Её значение успевает смениться ДО сдвига
    // даты (приток на биржи обновляется за час до общей даты ончейн-набора), и в сам такт сдвига
    // оно уже не меняется: по сравнению с прошлым тактом из 73 суточных изменений притока
    // приходило 19 — те, что случайно совпали со сдвигом даты.
    const seen = dict.drift ? shownMap[i.id] : null;
    const unseen = !!seen && hasValue(seen.v) && seen.v !== fmtValue(i);
    if (i.scheduled && !dict.quiet && ((changed && (dateAdvanced || (sameDate && i.updates && !dict.drift))) || (dateAdvanced && unseen))) {
      releaseGroups.push({ i, was, update: !dateAdvanced });
    }
    // Ревизия: дата наблюдения та же, а значение переписали.
    if (i.revisable && i.observed_at && i.observed_at === was.observed_at && changed && !dateAdvanced) {
      events.push({
        kind: "revision",
        key: `rev:${i.id}`,
        title: humanTitle(i.id, i.name),
        before: fmtValue(was),
        after: fmtValue(i),
        detail: `первоисточник пересмотрел значение за ${ruDay(Date.parse(i.observed_at))}`,
        indicator: i,
        note: i.note,
      });
    }

    // Переписанная история ряда: КАКАЯ точка и КАК изменилась, а не «изменено строк: 1».
    // Наблюдение из прода: mempool.space пересчитывает оценку хешрейта за один и тот же день
    // туда-обратно между двумя значениями. Возврат к уже показанному значению — не новость,
    // а качок источника, поэтому такие точки отсеиваются (факт остаётся в логе).
    if (dict.quiet) continue;
    const rev = seriesRevisions(was.points, i.points);
    dust += rev.dust;
    if (!rev.changed.length) continue;
    // Смена источника — не пересмотр. Сборщик, уйдя на резерв, отдаёт ДРУГОЙ ряд, и сравнение
    // точек выдавало это за «первоисточник переписал уже опубликованные данные» (01.08 и 05.08,
    // сдвиги до 14 %). Признаки: у карточки сменилась строка источника либо в такт смены
    // поставщика набора данных ряд переписан целиком.
    const sourceMoved = !!(i.source && was.source && i.source !== was.source);
    const wholesale = rev.compared >= 6 && rev.changed.length / rev.compared >= WHOLESALE_SHARE;
    if (sourceMoved || (wholesale && providerSwitch)) {
      switched.push(`${i.name}: ${sourceMoved ? `${sourceLabel(was.source)} → ${sourceLabel(i.source)}` : "сменился поставщик набора данных"}, точек с другим значением: ${rev.changed.length}`);
      continue;
    }
    const rewritten = rev.changed.filter((c) => {
      const seen = seenRevised[`${i.id}|${c.t}`]?.v;
      if (Array.isArray(seen) && seen.some((v) => sameNum(v, c.after))) {
        bounced.push(`${i.name} за ${ruDay(c.t)}: значение вернулось к ранее показанному`);
        return false;
      }
      return true;
    });
    if (rewritten.length) revisedSeries.push({ i, changed: rewritten });
  }

  // Одна переписанная точка первоисточника отзывается сразу в нескольких карточках (правка
  // хешрейта за день двигает и «Безопасность сети», и «Hash ribbons», и «Экономику майнинга»),
  // поэтому ревизии собираются по ПЕРИОДУ, а карточки с одинаковыми числами склеиваются: три
  // сообщения об одном и том же факте — тот же шум, что и релиз по карточке на каждую.
  if (revisedSeries.length) {
    const byPeriod = new Map();
    for (const r of revisedSeries) {
      const from = r.changed[0].t;
      const to = r.changed[r.changed.length - 1].t;
      const key = `${from}:${to}`;
      if (!byPeriod.has(key)) byPeriod.set(key, { from, to, items: [] });
      byPeriod.get(key).items.push(r);
    }
    for (const [key, g] of byPeriod) {
      const bySignature = new Map();
      for (const { i, changed } of g.items) {
        // Единица ряда — из словаря: ряд карточки лежит в сырых единицах первоисточника, и число без
        // единицы читателю ничего не говорило («9,463·10^20 → 9,404·10^20» — это хешрейт в H/s,
        // «−4 786,4 → −4 763,1» — потоки ETF в биткоинах). Карточки с одинаковыми числами
        // склеиваются, только если и единица у них одна.
        const s = HUMAN[i.id]?.s || null;
        const sig = `${s ? `${s.u}|${s.per || 1}|${s.auto ? 1 : 0}` : ""}#${changed.map((c) => `${c.t}|${c.before}|${c.after}`).join(";")}`;
        if (!bySignature.has(sig)) bySignature.set(sig, { names: [], changed, sources: new Set(), s });
        const slot = bySignature.get(sig);
        // имя — величины ряда, когда она не та, что в заголовке карточки
        const name = s?.n || humanTitle(i.id, i.name);
        if (!slot.names.includes(name)) slot.names.push(name);
        if (i.source) slot.sources.add(sourceLabel(i.source));
      }
      const span = g.from !== g.to;
      const moves = [];
      const sources = new Set();
      let total = 0;
      for (const slot of bySignature.values()) {
        for (const s of slot.sources) sources.add(s);
        total = Math.max(total, slot.changed.length);
        for (const c of slot.changed.slice(-3)) {
          // без объявленной единицы (макро-панель, новая карточка без записи в словаре) — как раньше
          const [before, after] = slot.s ? seriesPair(c.before, c.after, slot.s) : [fmtPoint(c.before), fmtPoint(c.after)];
          moves.push({
            name: (span ? `${ruDay(c.t)} · ` : "") + slot.names.join(" · "),
            before,
            after,
            delta: finite(c.pct) ? `${c.pct > 0 ? "+" : "−"}${Math.abs(c.pct).toFixed(Math.abs(c.pct) < 1 ? 2 : 1).replace(".", ",")}%` : "",
          });
        }
      }
      events.push({
        kind: "revision",
        key: `rev-series:${key}`,
        title: "Пересчёт истории",
        before: "",
        after: "",
        detail: [
          span ? `переписан период ${ruDay(g.from)} — ${ruDay(g.to)}` : `переписаны данные за ${ruDay(g.from)}`,
          total > 3 ? `точек переписано: ${total}, показаны последние` : "",
          sources.size ? `источник: ${[...sources].join(", ")}` : "",
        ].filter(Boolean).join(" · "),
        moves,
        // машинночитаемый след: из него состояние учится, какие значения точки уже показывались
        revisedPoints: g.items.flatMap(({ i, changed }) => changed.map((c) => ({ id: i.id, t: c.t, before: c.before, after: c.after }))),
        note: g.items.map((r) => `${r.i.name}: ${r.i.note}`).join("\n").slice(0, 1200),
      });
    }
  }

  // Сборка релизов: ключ группы — публикация первоисточника (кто и на какую дату наблюдения).
  const groups = new Map();
  for (const { i, was, update } of releaseGroups) {
    const dict = HUMAN[i.id] || {};
    const after = fmtValue(i);
    // «—» на месте значения — отказ источника, а не данные.
    if (!hasValue(after)) continue;
    // «Было» — то, что читатель видел в ПРОШЛОМ СООБЩЕНИИ об этом показателе, а не значение
    // прошлого такта. Между сообщениями значение успевает смениться молча, и цепочка рвалась:
    // у 49 строк из 468 «было» не равнялось «стало» предыдущего сообщения.
    const shown = shownMap[i.id];
    const before = shown && hasValue(shown.v) ? shown.v : fmtValue(was);
    if (!hasValue(before)) continue;
    // «смешанно → смешанно» читателю ничего не говорит: внутри у панели поменялась оценка,
    // а видимое значение осталось прежним. Такие строки в сообщение не идут.
    if (before === after) continue;
    // Источник вернул наблюдение СТАРШЕ уже показанного (качок даты) — это не новые данные.
    if (shown?.d && i.observed_at && i.observed_at < shown.d) continue;
    // Карточка с пометкой drift идёт раз на дату наблюдения: качок даты назад и снова вперёд не
    // должен превращать её обновление в ту же дату в ещё одну строку.
    if (dict.drift && shown?.d && i.observed_at && i.observed_at <= shown.d) continue;
    // ФИЛЬТРА ЗНАЧИМОСТИ ЗДЕСЬ НЕТ — И ЭТО СОЗНАТЕЛЬНО.
    // Правило владельца: всё, что публикуется по календарю (раз в несколько часов, сутки, неделю,
    // месяц, квартал), должно приходить сразу — это «результирующие» данные. Не приходят только
    // непрерывные котировки (золото, биткоин, индексы), которые смотрят в реальном времени; они
    // отсекаются раньше — признаком живого фида и пометкой quiet.
    // Прошлая версия глушила «рутинные» движения дневных рядов и за одни сутки съела SOFR−IORB,
    // HY-спред, VIX и разворот юаня — ровно то, ради чего уведомления и заводились. Шум лечится
    // ГРУППИРОВКОЙ по публикации (одно сообщение на релиз), а не молчанием о данных.
    const numeric = isNumericLabel(i.value);
    // Метка движения считается по шагу «прошлая дата → эта дата», поэтому обновлению в ту же
    // дату она не ставится: там напечатан другой шаг.
    const sig = numeric ? significance(i, was.hist) : null;
    const wasNum = shown && finite(shown.n) ? shown.n : was.value_num;
    // Смена знака = переход через ноль (приток стал оттоком, сжатие — расширением).
    // Подвохи, пойманные на живых данных:
    //   · «−0,0» даёт минус-ноль, и проверка `< 0` его не видит — отрицательную сторону читаем
    //     и по знаку в подписи;
    //   · переход +0,1 → −0,0 формально смена знака, но по сути топтание у нуля, поэтому обе
    //     стороны должны быть заметны на фоне обычного шага ряда;
    //   · словесным карточкам метка не ставится вовсе: их число — балл, и «смена на положительные
    //     значения» при «basis trade → смешанное позиционирование» была о балле −1 → 0.
    const bothMeaningful =
      !sig?.medianStep || Math.max(Math.abs(wasNum ?? 0), Math.abs(i.value_num ?? 0)) >= sig.medianStep * 0.5;
    const toMinus = finite(wasNum) && wasNum > 0 && finite(i.value_num) && (i.value_num < 0 || (i.value_num === 0 && /^\s*[−–-]/.test(after)));
    const toPlus = finite(wasNum) && wasNum < 0 && finite(i.value_num) && i.value_num > 0;
    const flipped = numeric && bothMeaningful && (toMinus || toPlus);
    // Дата «было» печатается, когда между ним и новыми данными больше обычного шага ряда: после
    // простоя бота «было» — значение четырёхдневной давности, и без даты пропуск не виден.
    const refDay = shown?.d || was.observed_at;
    const gapDays = refDay && i.observed_at ? (Date.parse(i.observed_at) - Date.parse(refDay)) / 864e5 : 0;
    const usual = seriesGapDays(i.points) ?? 1;
    const beforeText = gapDays > Math.max(3, 2 * usual) + 0.01 ? `${before} (за ${ruDay(Date.parse(refDay)).slice(0, 5)})` : before;
    const marks = [];
    // Видимый маркер значимости: он и есть ответ на «насколько это существенно», не зависящий
    // от доступности модели.
    if (flipped) marks.push(toMinus ? "смена на отрицательные значения" : "смена на положительные значения");
    else if (sig?.notable && !update) marks.push(sig.sinceLabel ? `сильнейшее движение с ${sig.sinceLabel}` : "заметное движение");
    if (dict.lvl && i.delta) marks.push(`${dict.lvl} ${String(i.delta).replace(/(\d)\.(\d)/g, "$1,$2")}`);
    const release = releaseOf(i);
    const key = `${release}|${i.observed_at}`;
    if (!groups.has(key)) groups.set(key, { release, observed_at: i.observed_at, moves: [], plain: [], history: [], updates: 0 });
    const g = groups.get(key);
    // id, num и date — машинночитаемый след: по нему состояние запоминает показанное значение
    g.moves.push({ id: i.id, name: humanTitle(i.id, i.name), before: beforeText, after, delta: marks.join("; "), num: i.value_num, date: i.observed_at });
    if (update) g.updates++;
    // ВАЖНО: пояснение и история собираются ТОЛЬКО для строк, реально попавших в сообщение.
    // Раньше они брались у всех показателей группы, и комментарий объяснял не тот показатель,
    // чьё движение видел читатель (наблюдалось в проде дважды).
    if (humanPlain(i.id)) g.plain.push(`${humanTitle(i.id, i.name)} — ${humanPlain(i.id)}`);
    const digest = numeric ? historyDigest(i, was.hist) : "";
    if (digest) g.history.push(`${humanTitle(i.id, i.name)}: ${digest}`);
  }
  for (const [key, g] of groups) {
    if (!g.moves.length) continue;
    const day = g.observed_at ? ruDay(Date.parse(g.observed_at)) : "";
    events.push({
      kind: "release",
      key: `rel:${key}`,
      title: g.release,
      before: "",
      after: "",
      detail: !day ? "" : g.updates === g.moves.length ? `обновление данных за ${day}` : `данные за ${day}`,
      moves: g.moves,
      plain: g.plain,
      history: g.history,
      note: "",
    });
  }

  // Алерты ревизий, которые панель ведёт сама, в рассылку НЕ идут: они говорят только «источник
  // переписал N строк» и не отвечают на единственный важный вопрос — что именно и на сколько
  // изменилось. Настоящий ответ даёт сравнение точек ряда выше. Сюда алерт попадает лишь как
  // строка в логе, чтобы факт ревизии не потерялся, если ни одна карточка её не показала.
  const seenRev = new Set((prevState.revisions || []).map((r) => r.key + "|" + r.text));
  const freshAlerts = (panel.revisions || []).filter((r) => !seenRev.has(r.key + "|" + r.text));
  if (freshAlerts.length) {
    const shownIds = new Set(events.filter((e) => e.key.startsWith("rev-series:")).map((e) => e.key.split(":")[1]));
    console.log(
      `алерты ревизии источников: ${freshAlerts.length}` +
        (shownIds.size ? ` (карточек с показанной переписанной историей: ${shownIds.size})` : " (ни одна карточка не изменилась — в рассылку не идёт)")
    );
    for (const r of freshAlerts) console.log(`  · ${r.text}`);
  }

  if (bounced.length) {
    console.log(`качки источника (в рассылку не идут): ${bounced.length}`);
    for (const b of bounced) console.log(`  · ${b}`);
  }
  if (switched.length) {
    console.log(`смена источника ряда (не пересмотр, в рассылку не идёт): ${switched.length}`);
    for (const s of switched) console.log(`  · ${s}`);
  }
  if (dust) console.log(`пересчёт истории меньше ${String(REVISION_MIN_PCT).replace(".", ",")} % (в рассылку не идёт): точек ${dust}`);

  // ---- Доля капитала: что стало, почему и что это отменит ----
  if (curAlloc?.engine) {
    // BTC-панель публикует запись решения — сообщение собирается из неё.
    events.push(...btcDecisionEvents({ prevState, panel, why, staleMoves, staleIds, detectorMoves }));
  } else if (prevAlloc && curAlloc && finite(prevAlloc.pct) && finite(curAlloc.pct) && !sameNum(prevAlloc.pct, curAlloc.pct)) {
    const dir = curAlloc.pct > prevAlloc.pct ? "увеличена" : "сокращена";
    // Пять строк подряд «— оценка ухудшилась» читаются как шум. Однотипное сжимается в одну
    // строку перечислением, а показатели с видимым изменением значения показываются числами.
    const causes = [];
    const named = (list) => list.map((w, k) => { const n = w.name.replace(/ и доступное предложение| и состояние сети/, ""); return k ? n.charAt(0).toLowerCase() + n.slice(1) : n; }).join(", ");
    const moved = why.filter((w) => !w.sameValue);
    for (const w of moved.slice(0, 4)) causes.push(`${w.name}: ${w.from} → ${w.to}`);
    const worse = why.filter((w) => w.sameValue && w.worse);
    const better = why.filter((w) => w.sameValue && !w.worse);
    if (worse.length) causes.push(`${worse.length > 1 ? "Ухудшились" : "Ухудшился"}: ${named(worse)}`);
    if (better.length) causes.push(`${better.length > 1 ? "Улучшились" : "Улучшился"}: ${named(better)}`);
    for (const { d, from, to } of detectorMoves) {
      causes.push(`${detectorHuman(d.name)}: ${DET_LABEL[from] || from} → ${DET_LABEL[to] || to}`);
    }
    events.push({
      kind: "allocation",
      // в ключе — момент базы сравнения: повтор той же смены позже — новое событие, а не дубль
      key: `alloc:${prevAlloc.pct}->${curAlloc.pct}@base:${prevState.generated_at || ""}`,
      title: `Доля ${panel.assetWord || "рискового актива"} ${dir}`,
      before: `${prevAlloc.pct}%`,
      after: `${curAlloc.pct}%`,
      detail: "",
      causes,
      stability: stabilityLines(prevAlloc, curAlloc, prevState),
      note: "",
    });
  } else {
    // Детектор риска сработал или снялся, а доля не изменилась — это всё равно факт о рынке.
    events.push(...riskEvents(detectorMoves, prevState.generated_at || ""));
  }
  events.push(...warningEvents(prevState, panel));
  // Тип, убранный из KIND_ORDER, не рассылается вовсе: так работает «тумблер шума» из
  // УВЕДОМЛЕНИЯ.md. Раньше список задавал только порядок, и убранный тип уезжал в начало пачки.
  const kept = events.filter((ev) => KIND_ORDER.includes(ev.kind));
  if (kept.length !== events.length) console.log(`тип события выключен в KIND_ORDER (в рассылку не идёт): ${events.length - kept.length}`);
  kept.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return kept;
}

/* ================================= 4. ТЕКСТ СООБЩЕНИЙ ================================= */

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtValue(i) {
  // Панели форматируют дробную часть по-разному (BTC-панель — точкой, макро — запятой), и в
  // соседних строках одного сообщения это выглядело неряшливо. Приводим к русской записи,
  // не трогая ничего, кроме разделителя между цифрами.
  const v = sharpen(String(i.value ?? "").trim().replace(/(\d)\.(\d)/g, "$1,$2"), i.value_num);
  return i.unit && !v.includes(i.unit) ? `${v} ${i.unit}` : v;
}

// Сжатая подпись с одной значащей цифрой («+4 млрд $») прячет движение: 3,44 → 3,54 читалось как
// «+3 → +4 млрд $», а 43 строки о потоках ETF не вышли вовсе — обе стороны округлились одинаково.
// Точное число в снимке есть (value_num), одна цифра после запятой берётся из него. Подписи с
// двумя и более значащими цифрами («+137 млн $») не трогаются.
const COMPACT_SCALE = { "тыс.": 1e3, "млн": 1e6, "млрд": 1e9, "трлн": 1e12 };
function sharpen(label, num) {
  const m = label.match(/^([+\-−–]?\$?)(\d)(\s+(тыс\.|млн|млрд|трлн)(?=\s|$).*)$/);
  if (!m || !finite(num)) return label;
  // value_num лежит либо в полных единицах (1,92e9 при «2 млрд»), либо уже в единицах подписи
  for (const scale of [COMPACT_SCALE[m[4]], 1]) {
    const x = Math.abs(num) / scale;
    if (Math.round(x) === Number(m[2]) && x < 10) return `${m[1]}${x.toFixed(1).replace(".", ",")}${m[3]}`;
  }
  return label;
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
  if (NO_COMMENT.has(ev.kind)) return "";
  if (ev.kind === "allocation" && ev.facts) {
    // BTC-панель: шаблон выбирается по тому, ЧТО изменилось, а не по знаку смены. По знаку он
    // противоречил посчитанному: 20.08 пол сняли из-за роста оценки на растущем рынке, а под
    // сообщением стояло «обстановка хуже прежней»; аварийное обнуление шло как «уводит часть позиции».
    const f = ev.facts;
    const overlay = OVERLAY_WORD[f.on[0] || f.off[0]] || "оверлей";
    if (f.what === "emergency") return "Аварийный переключатель срабатывает на нарушение целостности рынка, а не на режим: цель обнуляется сразу и возвращается, как только нарушение уйдёт.";
    if (f.what === "emergency_off") return "Нарушение целостности рынка ушло — цель снова задаёт режим.";
    if (f.dir === 0) return "Смена и обратная смена уместились между двумя запусками бота; сейчас цель прежняя.";
    if (f.resumed) return "Пауза снята — панель снова показывает цель.";
    if (f.what === "overlay" && f.on.length) return `Это ${overlay} поверх режима, а не смена режима: он включается и снимается одним снимком.`;
    if (f.what === "overlay") return `Снят ${overlay}; сам режим при этом не менялся.`;
    if (f.what === "both") return "В одном снимке сошлись смена режима и смена оверлея — цель задаёт то, что сильнее.";
    if (f.what === "regime" && f.regime_up) return f.held
      ? "Режим улучшился и выдержал удержание: повышение принимается только после 48 часов без встречного снимка."
      : "Режим улучшился — цель поднята на его ступень.";
    if (f.what === "regime") return "Режим ухудшился: понижение принимается вторым снимком подряд, обратный ход — не раньше чем через 48 часов.";
    return f.dir > 0 ? "Цель повышена по правилам движка." : "Цель понижена по правилам движка.";
  }
  if (ev.kind === "allocation") {
    const from = parseFloat(ev.before) || 0, to = parseFloat(ev.after) || 0;
    return to > from
      ? "Модель считает обстановку лучше прежней и возвращает часть отложенного риска в позицию."
      : "Модель считает обстановку хуже прежней и уводит часть позиции в резерв.";
  }
  if (ev.kind === "risk") {
    const to = String(ev.after || "");
    return to === "СРАБОТАЛ"
      ? "Условия сошлись одновременно, а не по одному — это то, ради чего сигнал и существует."
      : to === "наблюдение"
        ? "Часть условий выполнена, подтверждения пока нет."
        : "Условия разошлись, сигнал снят.";
  }
  if (ev.kind === "revision") {
    return "Первоисточник переписал уже опубликованные данные задним числом: картина прошлого изменилась, хотя новых событий не происходило.";
  }
  // Разбора от модели нет — значит и осмысления не будет. Честнее дать короткую справку о
  // смысле показателя и прямо сказать, что разбор недоступен, чем выдавать словарное определение
  // за анализ. Формулировка «Что это за показатель» из первой версии была именно этой ошибкой:
  // читатель ждал вывода, а получал определение, которое и так знает.
  const plain = (ev.plain || [])[0];
  const notable = (ev.moves || []).some((m) => /движение/.test(m.delta || ""));
  const tail = notable ? " Движение для этого показателя нерядовое." : "";
  return plain
    ? `${plain}.${tail} (Разбор недоступен — комментатор не ответил.)`
    : `Вышли новые данные первоисточника.${tail} (Разбор недоступен — комментатор не ответил.)`;
}

function renderMessage(ev, comment) {
  const k = KIND[ev.kind] || { emoji: "•", label: ev.kind };
  const head = `${ev.emoji || k.emoji} <b>${esc(ev.title)}</b>`;
  const move = ev.before || ev.after ? `${esc(ev.before || "—")} → <b>${esc(ev.after || "—")}</b>` : "";
  const moves = (ev.moves || [])
    .map((m) => `• ${esc(m.name)}: ${esc(m.before)} → <b>${esc(m.after)}</b>${m.delta ? ` <i>(${esc(m.delta)})</i>` : ""}`)
    .join("\n");
  const bullets = (rows) => (rows || []).map((c) => `• ${esc(c)}`).join("\n");
  const causes = bullets(ev.causes);
  const plainLines = bullets(ev.lines);
  const todo = bullets(ev.todo);
  const undo = bullets(ev.undo);
  // Устойчивость подаётся вердиктом одним словом, а под ним — короткое объяснение обычным
  // языком. Слово всегда одно и то же для одного и того же класса: так оно становится понятным.
  const st = (ev.stability || [])[0];
  const stability =
    st && st.tier
      ? `${TIER[st.tier].mark} <b>${esc(TIER[st.tier].word)}</b>\n${(st.reason || []).map((r) => `• ${esc(r)}`).join("\n")}`
      : (ev.stability || []).map((s) => `• ${esc(s)}`).join("\n");
  // Сообщение о доле BTC-панели несёт три раздела вместо класса устойчивости: причина, действие
  // по правилу исполнения и условие отмены. Качество данных — строка внутри причин, а не хвост
  // списка: под правилом «не больше трёх строк» она выпадала в половине случаев.
  const lines = [
    head,
    move,
    moves,
    ev.detail ? esc(ev.detail) : "",
    plainLines,
    causes ? `\n<b>Что за этим стоит</b>\n${causes}` : "",
    todo ? `\n<b>Что делать</b>\n${todo}` : "",
    undo ? `\n<b>Что отменит</b>\n${undo}` : "",
    stability ? `\n<b>Насколько это устойчиво</b>\n${stability}` : "",
  ].filter(Boolean);
  if (ev.indicator?.observed_at) lines.push(`<i>данные на ${esc(ev.indicator.observed_at)}${ev.indicator.source ? " · " + esc(ev.indicator.source) : ""}</i>`);
  if (comment) {
    lines.push("");
    lines.push("💬 " + esc(comment));
  }
  const text = lines.join("\n");
  return text.length > 4000 ? text.slice(0, 3990) + "…" : text;
}

/* ================================== 5. КОММЕНТАРИИ ================================== */

const LLM_SYSTEM = `Ты — независимый экономический аналитик. К тебе приходят свежие данные, и ты объясняешь читателю, что они означают. Читатель умный, но не финансист: он знает, что такое инфляция и ставка, но не обязан помнить устройство рынка кредитных спредов.

ЯЗЫК ОТВЕТА — ТОЛЬКО РУССКИЙ. Думать можешь как угодно, но весь текст ответа обязан быть на русском языке. Английские фразы недопустимы; общепринятые сокращения (ФРС, ВВП, ETF) — можно. НИКОГДА не смешивай латиницу и кириллицу внутри одного слова: у английского термина либо есть русский эквивалент («количественное ужесточение»), либо пиши его целиком латиницей.

ТВОЯ ЗАДАЧА — осмыслить движение, а не пересказать его:
· что за ним стоит по существу и почему оно могло произойти;
· насколько оно значительно на фоне последних месяцев (динамика передана в recent_history);
· как это вяжется с тем, что сейчас происходит в мировой экономике и на смежных рынках — соседние показатели переданы в market_now;
· к чему это ведёт дальше и за чем имеет смысл следить.

Ты СВОБОДЕН рассуждать, связывать факты и делать выводы. Рядовое движение назови рядовым одной фразой и не раздувай. Важное — объясни, почему оно важное, и доведи мысль до вывода.

ЧЕГО ДЕЛАТЬ НЕЛЬЗЯ:
· Начинать со слов «Что это за показатель» и вообще пересказывать определение — читателю нужен смысл, а не словарь.
· Упоминать панель, дашборд, баллы, зоны, композит, детекторы, вклад в оценку — читатель о них не знает.
· Выдумывать числа, консенсус аналитиков и прогнозы, которых тебе не давали. Про ожидания рынка можно говорить только качественно.
· Приводить числа, которых нет во входных данных. Каждое число в ответе должно быть взято из переданного тебе (округлять можно); ответ с посторонним числом отбрасывается целиком.
· Канцелярит, дисклеймеры, «важно отметить», «стоит подчеркнуть», «в заключение».
· Приказы «покупайте / продавайте» — объясняй механику и последствия.

ЕСЛИ СОБЫТИЕ — ИЗМЕНЕНИЕ ДОЛИ КАПИТАЛА. Причина, действие и условие отмены уже посчитаны и переданы в why_changed, what_to_do и what_cancels; цена, режим, кандидат и оверлей — в decision_now. Других причин не придумывай и готовые строки не пересказывай: скажи одной-тремя фразами, что эта смена значит для позиции и чего ждать дальше, опираясь только на них. Слова «режим», «ступень», «пол», «кандидат», «удержание» здесь допустимы — они стоят в самом сообщении.

ФОРМАТ: 2–5 предложений живого русского на событие. Термин — с короткой расшифровкой прямо в тексте при первом употреблении.

ОТВЕТ строго такой структурой, без вступлений и заголовков:
===0===
текст про событие с номером 0
===1===
текст про событие с номером 1`;

// Модель получает СОСТОЯНИЕ РЫНКА, а не состояние панели: несколько ключевых величин своими
// именами. Ни вердиктов, ни баллов, ни детекторов — иначе они протекут в текст сообщения.
// Исключение — BTC-панель: о её решении модель обязана знать то же, что стоит в сообщении о
// доле (decision_now). Раньше во входе не было ни цены, ни времени снимка, ни режима, ни
// кандидата, ни оверлея, а в 8 сменах доли из 15 — и причины: любое объяснение было выдумкой.
function llmContext(panel) {
  const named = (panel.indicators || [])
    .filter((i) => HUMAN[i.id] && hasValue(fmtValue(i)) && !i.stale)
    .slice(0, 45) // все карточки словаря: в первые двадцать не попадали ни тренд, ни просадка
    .map((i) => `${humanTitle(i.id, i.name)}: ${fmtValue(i)}`);
  const ctx = { market_now: named };
  const eng = panel.allocation?.engine;
  if (eng) {
    const hold = Date.parse(eng.hold_until || "");
    const ovl = (eng.overlays || []).map((o) => OVERLAY_WORD[o] || (o === "emergency_override" ? "аварийный режим" : o));
    ctx.decision_now = [
      finite(eng.price) ? `цена биткоина ${fmtUsd(eng.price)}` : "",
      `снимок ${ruMoment(eng.t)}`,
      panel.allocation.paused ? "решение на паузе, цель не опубликована" : `доля биткоина ${panel.allocation.pct} %`,
      eng.state ? `режим «${regimeWord(eng.state)}»${finite(eng.base) ? ` (ступень ${eng.base} %)` : ""}` : "",
      eng.candidate && eng.candidate !== eng.state ? `кандидат «${regimeWord(eng.candidate)}»${finite(hold) ? `, на удержании до ${ruMoment(hold)}` : ""}` : "кандидат совпадает с режимом",
      ovl.length ? `оверлей: ${ovl.join(", ")}` : "оверлеев нет",
    ].filter(Boolean).join("; ");
  }
  return ctx;
}

/* Сверка чисел: каждое число из комментария модели должно находиться во входе, который она
   получила. Проверялся только язык ответа, а числа и смысл — ничем; при этом именно разбор
   выглядит в сообщении объяснением. Допуск — на формат, а не на содержание: число из ответа
   считается найденным, если это запись входного числа с меньшей точностью («86 тыс.» при 86 198,
   «около 20» при 19,5) или в другой кратности (тысячи, миллионы, миллиарды). Знак не сверяется:
   «упал на 6,3» и «−6,3» — одно и то же. Не нашлось — комментарий отбрасывается, идёт шаблон. */
function numberTokens(text) {
  let s = String(text ?? "").replace(/[−–—]/g, "-").replace(/[   ]/g, " ");
  const out = [];
  const add = (raw, alts) => out.push({ raw: raw.trim(), alts });
  const num = (str) => Number(str.replace(/ /g, "").replace(",", "."));
  // С какой точностью число записано: «19,5» — до десятых, «86 000» — до тысяч. Округление до
  // круглого допускается только у больших чисел и не глубже двух старших разрядов: «20» — это
  // ровно двадцать, а не «от 15 до 25».
  const precision = (str) => {
    const t = str.replace(/ /g, "");
    const frac = (t.split(/[.,]/)[1] || "").length;
    if (frac) return Math.pow(10, -frac);
    const zeros = (t.match(/0+$/) || [""])[0].length;
    return t.length >= 4 ? Math.pow(10, Math.max(0, Math.min(zeros, t.length - 2))) : 1;
  };
  // мантисса со степенью: «3,177·10^11»
  s = s.replace(/(\d+(?:[.,]\d+)?)\s*[·x×*]\s*10\^(-?\d+)/g, (m, a, e) => {
    const v = num(a) * Math.pow(10, Number(e));
    add(m, [[{ v, p: precision(a) * Math.pow(10, Number(e)) }], [{ v: num(a), p: precision(a) }, { v: Number(e), p: 1 }]]);
    return " ";
  });
  // даты и время — по частям: «23.09.2026», «2026-09-23», «07:39»
  s = s.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, (m, d, mo, y) => { add(m, [[{ v: Number(d), p: 1 }, { v: Number(mo), p: 1 }, { v: Number(y), p: 1 }]]); return " "; });
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => { add(m, [[{ v: Number(d), p: 1 }, { v: Number(mo), p: 1 }, { v: Number(y), p: 1 }]]); return " "; });
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h, mi) => { add(m, [[{ v: Number(h), p: 1 }, { v: Number(mi), p: 1 }]]); return " "; });
  // остальное: «86 198», «19,5», «1.11» (последнее — либо дробь, либо «день.месяц»)
  for (const m of s.matchAll(/\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g)) {
    const raw = m[0];
    const alts = [[{ v: num(raw), p: precision(raw) }]];
    const dm = raw.match(/^(\d{1,2})\.(\d{2})$/);
    if (dm) alts.push([{ v: Number(dm[1]), p: 1 }, { v: Number(dm[2]), p: 1 }]);
    add(raw, alts);
  }
  return out;
}
// Числа внутри имён собственных — не данные: «S&P 500» не обязан лежать во входе.
const NAMED_NUMBERS = /S&P\s?500|Nasdaq[\s-]?100|Russell\s?2000|\bH\.\d+(?:\.\d+)?/gi;
function strayNumbers(comment, input) {
  comment = String(comment ?? "").replace(NAMED_NUMBERS, " ");
  const allowed = [];
  for (const t of numberTokens(input)) for (const alt of t.alts) for (const x of alt) if (finite(x.v)) allowed.push(Math.abs(x.v));
  const found = (x) => {
    const tol = x.p / 2 + Math.abs(x.v) * 1e-9;
    return allowed.some((y) => [1, 1e3, 1e6, 1e9, 1e12].some((k) => Math.abs(Math.abs(x.v) - y / k) <= tol || Math.abs(Math.abs(x.v) - y * k) <= tol));
  };
  return numberTokens(comment).filter((t) => !t.alts.some((alt) => alt.every(found))).map((t) => t.raw);
}

/* Разбор ответа модели. Терпимый НАМЕРЕННО: бесплатные и рассуждающие модели плохо держат
   строгий JSON (пропускают запятую, обрамляют ```-блоком, дописывают рассуждение вокруг), и
   строгий разбор молча ронял весь комментарий в шаблон. Основной формат — блоки «===N===»,
   но JSON тоже принимается, если модель вернула его. */
function parseComments(txt, n) {
  const out = new Array(n).fill(null);
  let found = 0;

  // 1) основной формат: ===N=== ... до следующего маркера
  const marker = /^[^\S\n]*=+\s*(\d+)\s*=+[^\S\n]*$/gm;
  const hits = [...txt.matchAll(marker)];
  for (let k = 0; k < hits.length; k++) {
    const idx = Number(hits[k][1]);
    const from = hits[k].index + hits[k][0].length;
    const to = k + 1 < hits.length ? hits[k + 1].index : txt.length;
    const body = txt.slice(from, to).trim().replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
    if (idx >= 0 && idx < n && body) { out[idx] = body; found++; }
  }
  if (found) return out;

  // 2) запасной формат: модель всё-таки ответила JSON-массивом
  const start = txt.indexOf("[");
  const end = txt.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(txt.slice(start, end + 1));
      if (Array.isArray(arr)) {
        for (const x of arr) {
          const idx = Number(x?.i);
          const body = typeof x?.text === "string" ? x.text : typeof x === "string" ? x : "";
          if (Number.isInteger(idx) && idx >= 0 && idx < n && body) { out[idx] = body; found++; }
        }
      }
    } catch {}
  }
  if (found) return out;

  // 3) одно событие — принимаем связный текст целиком, если он похож на комментарий
  if (n === 1) {
    const body = txt.replace(/^```[a-z]*\s*|\s*```$/g, "").trim();
    if (body.length >= 40 && body.length <= 4000) return [body];
  }
  return null;
}

// Какая модель реально ответила — нужно для честной подписи в проверке связи.
let LAST_MODEL = "";

/* Контроль качества текста. Бесплатные модели срываются в узнаваемые дефекты, и все три вида
   наблюдались в живых прогонах:
     · транслитерация — «kvantitativnogo uzhestocheniya» вместо «количественного ужесточения»;
     · чужая письменность посреди фразы — «продажи حكومات»;
     · смешение алфавитов внутри слова — «кванitative tightening».
   Проверка доли кириллицы такое не ловит: одно латинское слово среди двадцати русских не сдвигает
   отношение. Поэтому ищем именно дефекты, а не пропорцию. Найдено — берём следующую модель:
   лучше потратить ещё один запрос, чем показать читателю ломаный текст. */
function textDefect(t) {
  const s = String(t || "");
  // Письменности, которых в русском разборе быть не может ни при каких терминах.
  if (/[؀-ۿ֐-׿一-鿿぀-ヿ가-힯]/.test(s)) return "чужая письменность";
  // Латиница и кириллица внутри ОДНОГО слова.
  if (/[а-яёА-ЯЁ][a-zA-Z]|[a-zA-Z][а-яёА-ЯЁ]/.test(s)) return "смешение алфавитов внутри слова";
  // Транслитерация: длинные СТРОЧНЫЕ латинские слова. Аббревиатуры (ETF, QT, MVRV) заглавные,
  // имена собственные (Nasdaq, Deribit) начинаются с заглавной — они проверку проходят.
  // Порог — ДВА и более таких слова: одиночный устоявшийся англицизм («treasuries») читателю
  // понятен и менять из-за него модель расточительно, а вот пара слов подряд означает, что
  // модель соскользнула на другой язык («kvantitativnogo uzhestocheniya»).
  const translit = s.match(/(?<![A-Za-z])[a-z]{5,}(?![A-Za-z])/g) || [];
  const ok = /^(bitcoin|ethereum|nasdaq|treasuries|futures|options|hedge|spread|basis|carry|funding|stablecoin)$/;
  const bad = translit.filter((w) => !ok.test(w));
  if (bad.length >= 2) return `похоже на транслитерацию: ${bad.slice(0, 3).join(", ")}`;
  return "";
}

// Вход модели одной строкой. Вынесен отдельно, потому что с ним же сверяются числа ответа: что
// модель получила, то она и вправе цитировать.
function llmInput(events, panel) {
  return JSON.stringify({
    panel_context: llmContext(panel),
    events: events.map((e, i) => ({
      i,
      type: KIND[e.kind]?.label || e.kind,
      indicator: e.title,
      before: e.before || undefined,
      after: e.after || undefined,
      // служебные поля строки (id, число, дата) модели не нужны
      moves: e.moves ? e.moves.map((m) => ({ name: m.name, before: m.before, after: m.after, ...(m.delta ? { delta: m.delta } : {}) })) : undefined,
      detail: e.detail || undefined,
      what_it_is: (e.plain || []).join("; ").slice(0, 700) || undefined,
      recent_history: (e.history || []).join("; ").slice(0, 900) || undefined,
      why_changed: (e.causes || []).join("; ").slice(0, 1200) || undefined,
      what_to_do: (e.todo || []).join("; ") || undefined,
      what_cancels: (e.undo || []).join("; ") || undefined,
      stability: e.stability?.[0]?.tier
        ? { verdict: TIER[e.stability[0].tier].word, why: e.stability[0].reason }
        : undefined,
    })),
  });
}

// Одна попытка у одной модели. Возвращает разобранные комментарии либо null; вторым значением —
// признак того, что стоит попробовать СЛЕДУЮЩУЮ модель (перегрузка провайдера, отказ маршрута).
async function askModel(model, events, panel, key, timeoutMs = LLM_TIMEOUT_MS) {
  const input = llmInput(events, panel);
  const payload = {
    model,
    // Рассуждающая модель тратит на размышления НАМНОГО больше, чем на сам ответ, и по
    // документации OpenRouter лимит обязан покрывать и то, и другое. Прежний бюджет (720 токенов
    // на одно событие) уходил на размышления целиком, ответ не начинался вовсе — и в Telegram
    // уезжал англоязычный поток мыслей вида «The user wants me to analyze…».
    max_tokens: Math.min(16000, 2000 * events.length + 6000),
    // Размышления нужны модели, но НЕ нужны нам: просим провайдера их не возвращать, чтобы
    // ответ гарантированно лежал в content и его нельзя было спутать с черновиком.
    reasoning: { exclude: true },
    messages: [
      { role: "system", content: LLM_SYSTEM },
      { role: "user", content: input },
    ],
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs));
  try {
    const send = async (b) =>
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(b),
        signal: ctl.signal,
      });
    const readBody = async (r) => {
      if (!r.ok) return { httpError: `${r.status} — ${(await r.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ")}` };
      return await r.json().catch(() => ({ error: { message: "ответ не является JSON" } }));
    };

    let j = await readBody(await send(payload));
    // Не каждый провайдер понимает подавление размышлений, и отказ приходит по-разному: то
    // HTTP-ошибкой, то телом с полем error при коде 200. Один повтор без параметра дешевле,
    // чем потеря разбора, поэтому проверяем ОБА вида отказа.
    const paramRejected = j.httpError || (j.error && /param|unsupport|invalid|reasoning/i.test(String(j.error.message || "")));
    if (paramRejected && payload.reasoning) {
      console.error(`${model}: запрос с подавлением размышлений отклонён (${j.httpError || j.error?.message}), повтор без него`);
      const { reasoning, ...plain } = payload;
      j = await readBody(await send(plain));
    }
    if (j.httpError) {
      console.error(`${model}: ответ ${j.httpError}`);
      return { comments: null, tryNext: true };
    }
    // OpenRouter умеет вернуть 200 с телом-ошибкой и пустым choices — без этой строки в логе
    // было только «ответ пуст», и причина оставалась невидимой. Именно так выглядит перегрузка
    // бесплатного провайдера: «ResourceExhausted: Worker local total request limit reached».
    if (j?.error) {
      console.error(`${model}: провайдер вернул ошибку — ${String(j.error.message || JSON.stringify(j.error)).slice(0, 180)}`);
      return { comments: null, tryNext: true };
    }
    const choice = j?.choices?.[0] || {};
    const msg = choice.message || {};
    const content = String(msg.content || "").trim();
    const thinking = String(msg.reasoning || "").trim();
    // ЧЕРНОВИК — НЕ ОТВЕТ. `reasoning` это поток мыслей модели («The user wants me to analyze…»,
    // «wait, monthly -50M seems low»), и он однажды уехал пользователю целиком, по-английски.
    // Берём его, только если он СОДЕРЖИТ нашу разметку — то есть модель успела дописать ответ
    // внутри того же потока. Иначе честнее промолчать, чем выдать черновик за разбор.
    const txt = content || (/^[^\S\n]*=+\s*\d+\s*=+[^\S\n]*$/m.test(thinking) ? thinking : "");
    if (!txt) {
      const why =
        choice.finish_reason === "length"
          ? "не хватило бюджета токенов — модель не дошла до ответа"
          : thinking
            ? "вернулись только черновые размышления без ответа"
            : "ответ пуст";
      console.error(`${model}: не дал текста — ${why} (finish_reason: ${choice.finish_reason ?? "?"}, размышлений ${thinking.length} симв.)`);
      return { comments: null, tryNext: true };
    }
    const parsed = parseComments(txt, events.length);
    if (!parsed) {
      // ДИАГНОСТИКА: без неё «шаблон» в логе не отличить от «модель ответила, а я не разобрал».
      console.error(`${model}: ответ не разобран (${txt.length} симв.). Начало: ${txt.slice(0, 250).replace(/\s+/g, " ")}`);
      return { comments: null, tryNext: true };
    }
    // Страховка по языку: промпт требует русский, но требование можно и проигнорировать —
    // англоязычный разбор до читателя доходить не должен. Считаем долю кириллицы среди букв.
    for (let k = 0; k < parsed.length; k++) {
      const t = parsed[k];
      if (!t) continue;
      const cyr = (t.match(/[а-яёА-ЯЁ]/g) || []).length;
      const lat = (t.match(/[a-zA-Z]/g) || []).length;
      if (cyr + lat >= 40 && cyr / (cyr + lat) < 0.5) {
        console.error(`${model}: ответ на событие ${k} не на русском (кириллицы ${Math.round((100 * cyr) / (cyr + lat))}%) — отброшен`);
        parsed[k] = null;
        continue;
      }
      const defect = textDefect(t);
      if (defect) {
        console.error(`${model}: ответ на событие ${k} испорчен — ${defect}; пробую следующую модель`);
        parsed[k] = null;
        continue;
      }
      // Числа ответа сверяются со входом: постороннее число — комментарий отброшен, идёт шаблон.
      const stray = strayNumbers(t, input);
      if (stray.length) {
        console.error(`${model}: в ответе на событие ${k} есть числа, которых нет во входе (${stray.slice(0, 4).join(", ")}) — отброшен`);
        parsed[k] = null;
      }
    }
    // Совсем нечего показать — пусть попробует следующая модель, вдруг она послушнее.
    if (parsed.every((t) => !t)) return { comments: null, tryNext: true };
    return { comments: parsed, tryNext: false };
  } catch (e) {
    console.error(`${model}: запрос не удался — ${String(e.message || e)}`);
    return { comments: null, tryNext: true };
  } finally {
    clearTimeout(timer);
  }
}

// budgetMs — сколько всего можно ждать цепочку моделей. Задаётся, когда в пачке есть сообщение о
// доле: понижение по правилу исполнения немедленное, а цепочка из четырёх моделей по 90 секунд
// могла задержать его на шесть минут. Вышел срок — уходит шаблон из записи решения.
async function llmComments(events, panel, { budgetMs = 0 } = {}) {
  const key = process.env.OPENROUTER_KEY;
  if (!key || !events.length) return null;
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;
  const chain = modelChain();
  // Платный предохранитель: ни одна модель без суффикса :free в сеть не уходит без явного
  // разрешения. Проверяем ВСЮ цепочку, а не только первую.
  const paid = chain.filter((m) => !m.endsWith(":free"));
  if (paid.length && !paidAllowed()) {
    console.error(`модель «${paid[0]}» платная, а NOTIFY_ALLOW_PAID не выставлен — комментарии из шаблона`);
    return null;
  }
  for (let k = 0; k < chain.length; k++) {
    const left = deadline - Date.now();
    if (left <= 0) {
      console.error("время на разбор для сообщения о доле вышло — комментарии из шаблона");
      return null;
    }
    const { comments, tryNext } = await askModel(chain[k], events, panel, key, Math.min(LLM_TIMEOUT_MS, left));
    if (comments) {
      if (k > 0) console.log(`комментарий получен запасной моделью ${chain[k]} (основная не ответила)`);
      LAST_MODEL = chain[k];
      return comments;
    }
    if (!tryNext) break;
    if (k + 1 < chain.length) console.error(`перехожу к следующей модели: ${chain[k + 1]}`);
  }
  console.error("ни одна бесплатная модель не дала разбора — комментарии из шаблона");
  return null;
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

// Второй независимый канал: сохраняет ровно тот же текст в приватной ленте NEXUS.
// Сбой ленты не влияет ни на Telegram, ни на состояние решающего контура.
async function sendNexusEvent(text, eventId, occurredAt) {
  const url = process.env.NEXUS_EVENTS_URL;
  const token = process.env.NEXUS_INGEST_TOKEN;
  const source = process.env.NEXUS_SOURCE_ID;
  if (!url || !token || !source) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source, text, eventId, occurredAt }),
    });
    if (!res.ok) console.error(`NEXUS HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  } catch (error) {
    console.error(`NEXUS недоступен: ${error?.message || error}`);
  }
}

/* ================================ 7. СОСТОЯНИЕ И MAIN ================================ */

// Идемпотентность: база сравнения двигается ОДИН раз в конце прогона, а список уже доставленных
// сообщений пишется после КАЖДОЙ отправки. Поэтому падение Telegram на середине рассылки не
// приводит ни к потере хвоста (база осталась старой — события пересчитаются), ни к повтору
// начала (эти ключи уже в индексе). Ключ включает сами значения: то же событие с другими
// числами — это новое событие.
// У событий без чисел — смены доли, паузы, сигнала риска, сброса удержания — «другим числам»
// взяться неоткуда, поэтому в самом ключе события стоит момент: время шага цели либо время базы
// сравнения. Та же смена, случившаяся позже, — другое событие и глушиться не должна; тот же
// прогон, повторённый после сбоя, даёт тот же ключ и повтора не шлёт.
// Всё это держится на том, что файл состояния переживает упавший прогон, — см. notify.yml.
const SENT_TTL_MS = 7 * 24 * 3600 * 1000;
const sentKey = (ev) => `${ev.key}|${ev.before}→${ev.after}|${(ev.moves || []).map((m) => m.after).join(",")}`;

// Память о показанных значениях переписанных точек: ключ «карточка|метка времени» → значения,
// о которых уже сообщалось. Нужна, чтобы отличить настоящий пересмотр от качка источника
// туда-обратно. Живёт дольше индекса доставленного: качок может вернуться и через месяц.
const REVISED_TTL_MS = 90 * 24 * 3600 * 1000;
const REVISED_MAX_VALUES = 6;

function rememberRevised(prev, events, now) {
  const out = {};
  for (const [k, rec] of Object.entries(prev || {})) {
    const at = Date.parse(rec?.at || "");
    if (Number.isFinite(at) && now - at < REVISED_TTL_MS && Array.isArray(rec.v)) out[k] = { v: rec.v.slice(), at: rec.at };
  }
  for (const ev of events) {
    for (const p of ev.revisedPoints || []) {
      const k = `${p.id}|${p.t}`;
      const rec = (out[k] = out[k] || { v: [], at: new Date(now).toISOString() });
      // Помним ОБЕ стороны показанного пересмотра: качок возвращает точку именно к прежнему
      // значению, то есть к «было», а не к «стало» — на этом первая версия фильтра и промахнулась.
      for (const v of [p.before, p.after]) {
        if (finite(v) && !rec.v.some((x) => sameNum(x, v))) rec.v.push(v);
      }
      if (rec.v.length > REVISED_MAX_VALUES) rec.v = rec.v.slice(-REVISED_MAX_VALUES);
      rec.at = new Date(now).toISOString();
    }
  }
  return out;
}

// Память о значениях, ПОКАЗАННЫХ читателю: подпись, число и дата наблюдения из последнего
// сообщения о показателе. «Было» следующего сообщения берётся отсюда, а не из прошлого такта, —
// так цепочка «стало = следующее было» не рвётся, а возврат источника к уже показанному
// значению не становится новостью.
function rememberShown(prev, events, now) {
  const out = { ...(prev || {}) };
  for (const ev of events) {
    if (ev.kind !== "release") continue;
    for (const m of ev.moves || []) {
      if (m.id) out[m.id] = { v: m.after, n: finite(m.num) ? m.num : null, d: m.date || "", at: new Date(now).toISOString() };
    }
  }
  return out;
}

// Карточка, которая идёт только со сдвигом даты (drift), сравнивается с тем, что читатель видел в
// прошлом сообщении о ней. Пока такого сообщения не было (первый запуск, новая карточка, состояние
// прежнего формата), за известное принимается значение, которое бот застал первым: иначе её
// строка ждала бы дня, когда число сменится ровно в такт сдвига даты.
function seedShown(prev, panel, now) {
  const out = { ...(prev || {}) };
  for (const i of panel.indicators || []) {
    if (!HUMAN[i.id]?.drift || out[i.id] || i.stale || i.degraded) continue;
    const v = fmtValue(i);
    if (hasValue(v)) out[i.id] = { v, n: finite(i.value_num) ? i.value_num : null, d: i.observed_at || "", at: new Date(now).toISOString() };
  }
  return out;
}

// Подпись значения, какой её печатал бот до правок 10.10.2026: без достройки десятых у сжатых
// подписей. По ней узнаются сообщения, разосланные прежней версией.
const legacyLabel = (i) => {
  const v = String(i.value ?? "").trim().replace(/(\d)\.(\d)/g, "$1,$2");
  return i.unit && !v.includes(i.unit) ? `${v} ${i.unit}` : v;
};
// Сообщал ли об этой публикации бот прежней версии. Его ключ доставленного —
// «rel:источник|дата наблюдения|→|значения через запятую». Публикация считается разосланной, если
// ключ с тем же источником и той же датой есть и хотя бы одно из тогдашних значений совпадает с
// тем, что сообщение несёт сейчас. Другое значение за ту же дату (источник вернулся и снял ложную
// тревогу) — новость, и она идёт.
function toldByLegacyBot(ev, sent, panel) {
  if (ev.kind !== "release") return false;
  const head = `${ev.key}|→|`;
  const tails = Object.keys(sent || {}).filter((k) => k.startsWith(head)).map((k) => `,${k.slice(head.length)},`);
  if (!tails.length) return false;
  const byId = new Map((panel.indicators || []).map((i) => [i.id, i]));
  return (ev.moves || []).some((m) =>
    [m.after, byId.has(m.id) ? legacyLabel(byId.get(m.id)) : ""].some((label) => label && tails.some((t) => t.includes(`,${label},`))));
}

function pruneSent(sent, now) {
  const out = {};
  for (const [k, iso] of Object.entries(sent || {})) {
    const t = Date.parse(iso);
    if (Number.isFinite(t) && now - t < SENT_TTL_MS) out[k] = iso;
  }
  return out;
}

// Счёт сбросов удержания за время, пока опубликованный режим не менялся: сообщение о принятом
// повышении говорит, сколько раз отсчёт срывался и когда кандидат появился впервые.
function nextHoldTrack(prev, panel) {
  const eng = panel.allocation.engine;
  if (panel.allocation.paused) return prev?.hold_track || null;
  const prevEng = engineOf(prev?.allocation);
  const track = prev?.hold_track && prev.hold_track.state === eng.state ? { ...prev.hold_track } : { state: eng.state, first_since: "", resets: 0 };
  const held = prevEng && !prev.allocation.paused && prevEng.state === eng.state && prevEng.hold_until && severity(prevEng.candidate) > severity(prevEng.state);
  if (held && prevEng.candidate !== eng.candidate) track.resets++;
  if (eng.hold_until && !track.first_since) track.first_since = eng.since;
  return track;
}

// База сравнения для следующего прогона. prev — прошлое состояние (из него переносится то, что
// текущий снимок двигать не вправе), events — события ЭТОГО прогона (по ним запоминается, о чём
// уже сказано). Без аргументов работает как раньше: чистая проекция снимка.
function snapshotState(panel, prev = null, events = []) {
  const prevInd = prev?.indicators || {};
  const indicators = {};
  for (const i of panel.indicators || []) {
    const was = prevInd[i.id];
    // Карточка на отказавших входах базу НЕ двигает: в базе остаётся последнее свежее значение.
    // Иначе возврат источника терялся — 29.09 «стресс» вернулся из «напряжения» в «нейтрально»
    // молча, потому что в базе уже лежало значение, посчитанное без двух рядов VIX.
    // Запись из состояния прежнего формата свежей не считается: прежний бот признака не знал и мог
    // положить в базу как раз значение с отказавших входов. Такая карточка помечается — и после
    // возврата источника один такт только фиксирует базу.
    if (i.stale && was && !was.stale && prev.version === 2) {
      indicators[i.id] = was;
      continue;
    }
    const rec = {
      value: i.value,
      value_num: i.value_num,
      unit: i.unit,
      zone: i.zone,
      score: i.score,
      observed_at: i.observed_at,
      degraded: !!i.degraded,
      points: i.points || null,
    };
    if (i.stale) rec.stale = true;
    if (i.source) rec.source = i.source;
    const hist = ownHistory(was?.hist, i);
    if (hist) rec.hist = hist;
    indicators[i.id] = rec;
  }
  const detectors = {};
  for (const d of panel.detectors || []) detectors[d.id] = { state: d.state };
  // лента причин живёт один прогон и в состояние не пишется
  const allocation = panel.allocation ? (({ feed, ...rest }) => rest)(panel.allocation) : null;
  const state = {
    version: 2,
    updated_at: new Date().toISOString(),
    generated_at: panel.generated_at || "",
    verdict: { word: panel.verdict?.word || "" },
    allocation,
    indicators,
    detectors,
    revisions: panel.revisions || [],
  };
  if (panel.allocation?.engine) {
    // Последняя ОПУБЛИКОВАННАЯ доля переживает паузу решения: по ней сообщение о возобновлении
    // знает, с чем сравнивать, и 45 → пауза → 20 даёт смену доли, а не тишину.
    const hadPct = !!prev?.allocation && finite(prev.allocation.pct);
    state.last_alloc = finite(allocation.pct)
      ? { pct: allocation.pct, t: panel.generated_at || "" }
      : prev?.last_alloc || (hadPct ? { pct: prev.allocation.pct, t: prev.generated_at || "" } : null);
    const was = prev?.pause || {};
    const told = events.some((e) => e.kind === "pause" && e.key.startsWith("pause:on"));
    state.pause = allocation.paused
      ? { since: was.since || panel.generated_at || "", announced: !!was.announced || told, notified_at: told ? panel.generated_at || "" : was.notified_at || "" }
      : { since: "", announced: false, notified_at: was.notified_at || "" };
    state.hold_track = nextHoldTrack(prev, panel);
  }
  if (panel.warnings) state.warnings = trackWarnings(prev?.warnings, panel.warnings, Date.parse(panel.generated_at || "") || Date.now(), !prev?.indicators).state;
  else if (prev?.warnings) state.warnings = prev.warnings;
  if (panel.providers || prev?.providers) state.providers = panel.providers || prev.providers;
  return state;
}

// Ряд решений копится САМИМ уведомлением: панели публикуют только текущее состояние, а для
// «часто ли такое откатывается» нужна собственная история. 400 наблюдений — это примерно две
// недели часового такта и месяц с лишним у макро-панели.
const TREND_MAX = 400;
// Журнал СМЕН доли живёт отдельно и дольше ряда наблюдений: смены редки (единицы в месяц), и
// подрезать их вместе с почасовыми точками — значит навсегда лишиться базы частот откатов.
const CHANGES_MAX = 200;
// steps — шаги цели из события о доле (с настоящим временем шага и оверлеями); без них строка
// пишется по разнице двух состояний, как раньше. Одна и та же смена дважды не записывается:
// после сбоя посреди рассылки журнал уже лежит на диске, а смена пересчитывается заново.
function appendChanges(prev, panel, prevAlloc, steps = null) {
  const rows = [...(prev || [])];
  const has = (t, to) => rows.some((r) => Math.abs(r.t - t) < 60000 && sameNum(r.to, to));
  if (steps && steps.length) {
    for (const s of steps) {
      if (!finite(s.t) || !finite(s.from) || !finite(s.to) || sameNum(s.from, s.to) || has(s.t, s.to)) continue;
      const known = Array.isArray(s.overlays_from) && Array.isArray(s.overlays_to);
      rows.push({ t: s.t, from: s.from, to: s.to, ...(known ? { overlays_from: s.overlays_from, overlays_to: s.overlays_to } : {}) });
    }
    return rows.sort((a, b) => a.t - b.t).slice(-CHANGES_MAX);
  }
  const cur = panel.allocation;
  if (cur && finite(cur.pct) && prevAlloc && finite(prevAlloc.pct) && !sameNum(prevAlloc.pct, cur.pct)) {
    const t = Date.parse(panel.generated_at || "") || Date.now();
    if (!has(t, cur.pct)) rows.push({ t, from: prevAlloc.pct, to: cur.pct });
  }
  return rows.slice(-CHANGES_MAX);
}
function appendTrend(prev, panel) {
  // BTC-панели ряд наблюдений не нужен: «запас в сутках обычного движения» по нему больше не
  // считается (он мерил не время и не тот механизм) — её сообщение собирается из записи решения.
  if (panel.allocation?.engine) return [];
  const sample = panel.allocation?.sample || (panel.allocation && finite(panel.allocation.pct)
    ? { t: Date.parse(panel.generated_at || "") || Date.now(), pct: panel.allocation.pct, score: panel.allocation.score ?? null }
    : null);
  if (!sample) return prev || [];
  const rows = (prev || []).filter((x) => finite(x?.t) && x.t < sample.t);
  rows.push(sample);
  return rows.slice(-TREND_MAX);
}

// Проверка связи: убедиться, что токен и chat_id верные, не дожидаясь первого настоящего
// изменения. Состояние НЕ трогает — после пинга обычный ход рассылки не сбивается.
function pingMessage(panel) {
  const det = (panel.detectors || []).filter((d) => d.state !== "calm");
  return [
    "✅ <b>Проверка связи</b>",
    "Бот подключён, уведомления настроены.",
    "",
    `Сейчас на панели: <b>${esc(panel.verdict?.word || "—")}</b>`,
    panel.verdict?.extra ? esc(panel.verdict.extra) : "",
    panel.allocation && finite(panel.allocation.pct) ? `Доля ${panel.assetWord || "рискового актива"} сейчас: <b>${panel.allocation.pct}%</b>` : "",
    `Показателей под наблюдением: ${(panel.indicators || []).length}`,
    det.length ? `Детекторы не в покое: ${esc(det.map((d) => `${d.name} (${DET_LABEL[d.state] || d.state})`).join(", "))}` : "Все детекторы спокойны",
  ]
    .filter(Boolean)
    .join("\n");
}

// io — швы для прогона без сети и диска (тесты, воспроизведение на истории снимков):
//   panel     — готовая проекция панели вместо чтения снимка;
//   state     — состояние прошлого запуска вместо файла (null — «состояния нет»);
//   saveState — куда отдать состояние вместо записи файла;
//   deliver   — получатель готового сообщения вместо Telegram и NEXUS. С ним прогон идёт БОЕВОЙ
//               веткой (индекс доставленного, запись состояния после каждой отправки), но ни
//               токен, ни сеть не нужны.
// В бою main() вызывается без аргументов.
async function main(io = {}) {
  const panel = io.panel || (await readPanel());

  if (process.env.NOTIFY_PING === "1" && !io.panel) {
    // Проверка связи проверяет ВСЮ цепочку, включая комментатор: без этого его отказ было не
    // увидеть до первого настоящего события, и он молча простоял в шаблоне весь первый день.
    // Живая карточка панели берётся как повод, чтобы прогнать модель на реальных данных.
    const sample = (panel.indicators || []).find((i) => HUMAN[i.id] && i.value && !HUMAN[i.id].quiet);
    let verdictLine = "Комментатор: ключ не задан, сообщения будут без разбора";
    if (process.env.OPENROUTER_KEY && sample) {
      const probe = [{
        kind: "release",
        title: releaseOf(sample),
        before: "",
        after: "",
        detail: "",
        moves: [{ name: humanTitle(sample.id, sample.name), before: fmtValue(sample), after: fmtValue(sample), delta: "" }],
        plain: humanPlain(sample.id) ? [`${humanTitle(sample.id, sample.name)} — ${humanPlain(sample.id)}`] : [],
        history: historyDigest(sample) ? [`${humanTitle(sample.id, sample.name)}: ${historyDigest(sample)}`] : [],
        note: "",
      }];
      // Остаток бесплатной квоты: бесплатный уровень OpenRouter ограничен по числу запросов в
      // сутки, и квота общая с судьёй новостей макро-панели. Знать запас полезно до того, как
      // он кончится посреди рабочего дня.
      try {
        const kr = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${process.env.OPENROUTER_KEY}` } });
        if (kr.ok) {
          const kd = (await kr.json())?.data || {};
          console.log(`квота OpenRouter: использовано ${kd.usage ?? "?"}, лимит ${kd.limit ?? "без лимита"}, остаток бесплатных запросов ${kd.rate_limit?.requests ?? "?"} / ${kd.rate_limit?.interval ?? "?"}`);
        }
      } catch {}
      const got = await llmComments(probe, panel);
      // Пинг — диагностический режим, поэтому текст разбора печатается и в лог: иначе оценить
      // качество ответа можно только по Telegram, а это неудобно при отладке.
      if (got?.[0]) console.log(`пример разбора (${LAST_MODEL}):\n${got[0]}`);
      verdictLine = got?.[0]
        ? `Комментатор работает (${LAST_MODEL || resolveModel()}). Пример разбора:\n<i>${esc(got[0].slice(0, 600))}</i>`
        : `Комментатор НЕ ответил (${resolveModel()}) — сообщения пойдут без разбора, причина в логе прогона`;
    }
    const text = `${pingMessage(panel)}\n\n${verdictLine}`;
    if (DRY) console.log(text.replace(/<[^>]+>/g, ""));
    else await sendTelegram(text.length > 4000 ? text.slice(0, 3990) + "…" : text);
    console.log(DRY ? "пинг: dry-run, ничего не отправлено" : "пинг отправлен");
    return;
  }

  const prev = io.state !== undefined ? io.state || {} : (await readJSON(STATE_PATH)) || {};
  const dry = io.deliver ? false : DRY;
  const first = !prev.indicators;
  // Снимок СТАРШЕ базы сравнения — не новые данные, а откат: в ветку попал прежний файл (выкладка
  // со снимком-заглушкой, revert коммита снимка). Сравнение с ним дало бы пачку «обновлений» назад
  // во времени, а следующий настоящий снимок — ту же пачку обратно. Такой прогон ничего не шлёт и
  // базу не двигает. Тот же снимок повторно (перезапуск после сбоя) идёт обычным путём.
  const baseT = Date.parse(prev.generated_at || ""), snapT = Date.parse(panel.generated_at || "");
  if (!first && finite(baseT) && finite(snapT) && snapT < baseT) {
    console.log(`снимок от ${panel.generated_at} старше базы сравнения (${prev.generated_at}) — ничего не отправлено, база не тронута`);
    return;
  }
  const now = Date.now();
  const sentIndex = pruneSent(prev.sent, now);
  let revisedSeen = prev.revised_points || {};
  let shownSeen = prev.shown || {};
  const all = first ? [] : diff(prev, panel);
  const events = all.filter((ev) => !sentIndex[sentKey(ev)]);

  if (first) console.log("первый прогон: зафиксирована база, уведомления начнутся со следующего изменения");
  if (all.length !== events.length) console.log(`уже доставлено ранее и пропущено: ${all.length - events.length}`);
  console.log(`событий: ${events.length}`);

  let queue = events;
  // Первый запуск BTC-панели на состоянии ПРЕЖНЕГО формата (сразу после выкладки). Прежний бот
  // двигал базу и на отказавших входах, поэтому после возврата источника к свежему набору данных в
  // его базе лежит вчерашнее значение — и разница с ним повторяет публикацию, которую он сам уже
  // разослал (потоки ETF: 16 тактов из 6 728 на истории 19.07–10.10.2026). Свой повтор он глушил
  // индексом доставленного, но сравнение по равенству ключей здесь не срабатывает: подписи и состав
  // строк стали другими. Поэтому в этом одном прогоне публикация сверяется с ключами прежнего бота
  // по смыслу (toldByLegacyBot). Всё остальное идёт как обычно: придерживать данные целиком значило
  // бы потерять настоящую публикацию, если выкладка попала на её такт (398 тактов из 6 728).
  if (!first && prev.version !== 2 && panel.allocation?.engine) {
    queue = events.filter((ev) => !toldByLegacyBot(ev, sentIndex, panel));
    if (queue.length !== events.length) console.log(`состояние прежнего формата: публикаций, уже разосланных прежней версией, пропущено ${events.length - queue.length}`);
  }
  // Осторожный режим: тесты уведомлений в этом прогоне не прошли (исход шага передаёт notify.yml).
  // Раньше красный тест молча выключал рассылку целиком. Теперь сообщения о решении, сигналы риска
  // и предупреждения о данных идут всё равно — их мало, и ключ каждого привязан к моменту события;
  // публикации и пересмотры, где ошибка кода способна дать лавину, не рассылаются, а о самом сбое
  // раз в сутки приходит служебное сообщение. Без состояния оно не шлётся: помнить «уже сказано»
  // было бы нечем.
  let selftestAlertAt = prev.selftest_alert_at || "";
  if ((io.selftest ?? process.env.NOTIFY_SELFTEST) === "failure") {
    const all = queue.length;
    queue = queue.filter((ev) => SAFE_KINDS.has(ev.kind));
    console.log(`тесты уведомлений не прошли — осторожный режим: публикаций и пересмотров не разослано ${all - queue.length}`);
    const lastAt = Date.parse(selftestAlertAt);
    if (!first && !(finite(lastAt) && now - lastAt < SELFTEST_ALERT_EVERY_MS)) {
      selftestAlertAt = new Date(now).toISOString();
      queue = [{
        kind: "service",
        key: `selftest@${selftestAlertAt}`,
        title: "Тесты уведомлений не проходят",
        before: "",
        after: "",
        detail: "Идут только сообщения о решении, сигналы риска и предупреждения о данных. Публикации и пересмотры не рассылаются, пока тесты не починены. Причина — в журнале прогона «Уведомления в Telegram».",
        note: "",
      }, ...queue];
    }
  }

  const trend = appendTrend(prev.alloc_trend, panel);
  const allocChanges = appendChanges(prev.alloc_changes, panel, prev.allocation, all.filter((ev) => ev.kind === "allocation").flatMap((ev) => ev.steps || []));
  let baseline = null; // сдвигается один раз в самом конце — до тех пор пишем старую базу
  const persist = async () => {
    const state = { ...(baseline || prev), sent: sentIndex, revised_points: revisedSeen, shown: shownSeen, alloc_trend: trend, alloc_changes: allocChanges };
    if (selftestAlertAt) state.selftest_alert_at = selftestAlertAt;
    if (io.saveState) return io.saveState(state);
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 1));
  };

  let sent = 0;
  if (queue.length) {
    const capped = queue.slice(0, MAX_EVENTS);
    if (queue.length > MAX_EVENTS) console.log(`ПРЕДОХРАНИТЕЛЬ: событий ${queue.length} > ${MAX_EVENTS}, отправляются первые ${MAX_EVENTS} по важности`);
    // Разбор нужен не всем событиям; а если в пачке есть сообщение о доле или о паузе, ждать
    // модель дольше отведённого нельзя — понижение по правилу исполнения немедленное.
    const ask = capped.map((ev, idx) => ({ ev, idx })).filter((x) => !NO_COMMENT.has(x.ev.kind));
    const urgent = capped.some((ev) => ev.kind === "allocation" || ev.kind === "pause");
    const got = ask.length ? await llmComments(ask.map((x) => x.ev), panel, { budgetMs: urgent ? DECISION_LLM_BUDGET_MS : 0 }) : null;
    const llm = new Array(capped.length).fill(null);
    if (got) ask.forEach((x, k) => { llm[x.idx] = got[k] || null; });
    console.log(`комментарии: ${got ? `модель (${LAST_MODEL || resolveModel()})` : "шаблон"}`);
    for (let i = 0; i < capped.length; i++) {
      const ev = capped[i];
      const comment = llm[i] || templateComment(ev);
      const text = renderMessage(ev, comment);
      if (dry) {
        const plain = text
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        console.log("\n--- сообщение " + (i + 1) + " ---\n" + plain);
      } else {
        if (io.deliver) await io.deliver(text, ev);
        else {
          await sendTelegram(text);
          await sendNexusEvent(text, sentKey(ev), panel.generated_at);
        }
        console.log(`  → отправлено: ${KIND[ev.kind]?.label || ev.kind} · ${ev.title}${ev.before || ev.after ? ` (${ev.before || "—"} → ${ev.after || "—"})` : ""} · комментарий: ${llm[i] ? "модель" : "шаблон"}`);
        sent++;
        sentIndex[sentKey(ev)] = new Date(now).toISOString();
        if (ev.revisedPoints) revisedSeen = rememberRevised(revisedSeen, [ev], now);
        if (ev.kind === "release") shownSeen = rememberShown(shownSeen, [ev], now);
        await persist(); // индекс доставленного — сразу на диск, база сдвинется в конце
        if (i < capped.length - 1 && !io.deliver) await sleep(SEND_GAP_MS);
      }
    }
  }

  if (dry) {
    revisedSeen = rememberRevised(revisedSeen, queue.filter((e) => e.revisedPoints), now);
    shownSeen = rememberShown(shownSeen, queue, now);
  }
  shownSeen = seedShown(shownSeen, panel, now);
  // В базу идут ВСЕ события прогона, включая отфильтрованные как уже доставленные: память «о чём
  // сказано» (пауза объявлена, предупреждение объявлено) не должна зависеть от того, в каком из
  // двух прогонов — упавшем или повторном — сообщение ушло.
  baseline = snapshotState(panel, prev, all);
  await persist();
  console.log(dry ? "dry-run: ничего не отправлено, база сравнения обновлена" : `отправлено сообщений: ${sent}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("notify.mjs")) {
  main().catch((e) => {
    console.error("notify упал:", e);
    process.exit(1);
  });
}

export { diff, renderMessage, templateComment, fromSnapshotJSON, snapshotState, llmComments, sentKey, pruneSent, rememberRevised, rememberShown, appendTrend, appendChanges, significance, decisionChanges, thresholdFrom, humanRelease, releaseOf, pingMessage, main, llmInput, strayNumbers, engineAgrees, trackWarnings, fmtValue, HUMAN, MACRO_CADENCE, KIND_ORDER };
