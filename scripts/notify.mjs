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

/* ====================== 1b. ЧЕЛОВЕЧЕСКИЕ НАЗВАНИЯ ПОКАЗАТЕЛЕЙ ======================
   Сообщение читает человек, который не обязан помнить, что такое «импульс HY-спреда» или
   «китайская нога». Поэтому во внешний текст идёт НЕ подпись карточки панели, а нормальное имя
   официальной статистики плюс одна фраза о том, что показатель вообще значит. Внутренняя терминология
   панели (зоны, баллы, вклад в композит) во внешние сообщения не попадает вовсе.

   Правило пополнения: новый показатель — новая запись здесь, иначе в сообщение уедет
   внутренняя подпись карточки и читатель снова получит «китайскую ногу».              */
const HUMAN = {
  // --- макро-панель ---
  sofr_iorb: { t: "Стоимость overnight-долларов против ставки по резервам (SOFR − IORB)", p: "показывает, дорого ли банкам занимать доллары на ночь: рост — свободных резервов в системе всё меньше" },
  netliq: { t: "Чистая ликвидность ФРС", p: "сколько долларов от ФРС реально доступно рынкам: баланс ФРС минус счёт Минфина и обратное репо" },
  reserves: { t: "Банковские резервы в ФРС, % ВВП", p: "запас прочности банковской системы; ниже ~9-10% исторически начинались сбои денежного рынка" },
  tga: { t: "Счёт Минфина США в ФРС", p: "когда Минфин тратит накопленное — деньги приходят в экономику, когда копит — уходят из неё" },
  rrp: { t: "Обратное репо ФРС", p: "«парковка» лишних денег фондов в ФРС; пока буфер полон, изъятие ликвидности не бьёт по банкам" },
  nfci: { t: "Индекс финансовых условий ФРБ Чикаго", p: "сводная мера того, легко ли занимать в экономике: ноль — историческая норма, выше — жёстче" },
  srf: { t: "Репо-окно ФРС (SRF)", p: "сколько банки занимают у ФРС под залог; всплеск — признак нехватки долларов" },
  ratevol: { t: "Волатильность доходности 10-летних облигаций США", p: "насколько сильно штормит рынок госдолга — от него зависит цена риска везде" , quiet: true },
  hy: { t: "Спред высокодоходных облигаций США", p: "надбавка к доходности, которую платят компании с низким рейтингом; растёт — рынок ждёт больше банкротств" },
  hy_mom: { t: "Спред высокодоходных облигаций: изменение за месяц", p: "скорость расширения кредитных премий важнее их уровня — быстрый рост предшествует кризисам" },
  ig: { t: "Спред облигаций инвестиционного рейтинга", p: "та же премия за риск, но для надёжных заёмщиков; через этот рынок финансируются крупные компании" },
  sloos: { t: "Опрос ФРС об условиях банковского кредитования (SLOOS)", p: "доля банков, ужесточивших требования к кредитам бизнесу; медленный, но надёжный предвестник спада" },
  bizd: { t: "Биржевой фонд компаний прямого кредитования (BIZD)", p: "живая цена непубличного кредита, который обычно переоценивается редко" , quiet: true },
  spx: { t: "S&P 500 относительно 200-дневной средней", p: "простая мера того, в восходящем рынок тренде или в нисходящем" , quiet: true },
  spx_mom: { t: "S&P 500: динамика за месяц", p: "скорость движения широкого рынка акций США" , quiet: true },
  vix: { t: "Индекс волатильности VIX", p: "ожидаемая рынком амплитуда колебаний S&P 500 на месяц вперёд, «индекс страха»" },
  vixterm: { t: "Срочная структура VIX", p: "сравнение цены страховки на ближний и дальний срок; ближняя дороже дальней — острый стресс здесь и сейчас" , quiet: true },
  breadth: { t: "Ширина рынка США", p: "растёт ли рынок широким фронтом или только за счёт нескольких крупнейших компаний" , quiet: true },
  payrolls: { t: "Занятость вне сельского хозяйства США", p: "сколько рабочих мест создаётся в месяц — главный индикатор рынка труда США" },
  sahm: { t: "Правило Сама", p: "насколько безработица выросла от своего минимума; +0,5 п.п. исторически означает, что рецессия уже идёт" },
  claims: { t: "Продолжающиеся заявки на пособие по безработице (США)", p: "сколько человек продолжают получать пособие — видно, легко ли уволенным найти работу" },
  curve: { t: "Наклон кривой доходности США (10 лет минус 3 месяца)", p: "когда короткие ставки выше длинных, это классический предвестник рецессии" },
  real10: { t: "Реальная доходность 10-летних облигаций США", p: "доходность за вычетом инфляции: настоящая цена денег для всей экономики" },
  jpy: { t: "Курс доллара к иене", p: "резкое укрепление иены обычно означает принудительное закрытие сделок carry trade по всему миру" },
  goldreal: { t: "Золото", p: "растёт вместе с реальными ставками — рынок голосует против доверия к валюте; падает вместе с акциями — идут маржин-коллы" , quiet: true },
  btc: { t: "Биткоин как индикатор долларовой ликвидности", p: "крипта обычно сдаёт первой, когда ликвидность уходит с рынков" , quiet: true },
  stagf: { t: "Инфляционные ожидания рынка на 10 лет", p: "какую среднюю инфляцию закладывают в цены облигаций" },
  oil: { t: "Нефть WTI", p: "цена энергии — прямой вход в инфляцию и в издержки компаний" },
  cny: { t: "Курс доллара к юаню", p: "ослабление юаня означает, что Китай экспортирует дефляцию и напряжение на мировые рынки" },
  dxy: { t: "Курс доллара к корзине валют", p: "дорогой доллар ужесточает финансовые условия для всего мира" },
  // --- BTC-панель ---
  liquidity_regime: { t: "Чистая ликвидность ФРС", p: "сколько долларов от ФРС реально доступно рынкам" },
  netliq_4w: { t: "Чистая ликвидность ФРС за 4 недели", p: "краткосрочное направление долларовой ликвидности" },
  netliq_13w: { t: "Чистая ликвидность ФРС за квартал", p: "среднесрочное направление долларовой ликвидности" },
  financial_conditions: { t: "Реальные ставки и курс доллара", p: "две главные цены, определяющие спрос на рисковые активы" },
  two_year: { t: "Доходность 2-летних облигаций США", p: "во что рынок оценивает будущую политику ФРС" },
  system_stress: { t: "Кредитный и рыночный стресс", p: "сводка по кредитным премиям, страховке на акции и волатильности госдолга" },
  macro_lens: { t: "Связь биткоина с индексом Nasdaq", p: "торгуется ли биткоин как обычный рисковый актив или живёт своей жизнью" , quiet: true },
  etf_regime: { t: "Потоки в биткоин-ETF в США", p: "сколько денег институциональные инвесторы вложили в биткоин или вывели через биржевые фонды" },
  etf_1d: { t: "Потоки в биткоин-ETF за день", p: "приток или отток денег через американские биржевые фонды за последний торговый день" },
  etf_5d: { t: "Потоки в биткоин-ETF за неделю", p: "приток или отток за пять торговых дней" },
  etf_20d: { t: "Потоки в биткоин-ETF за месяц", p: "приток или отток за двадцать торговых дней" },
  stablecoin_regime: { t: "Объём стейблкоинов", p: "сколько «долларов» находится внутри криптосистемы и может быть потрачено на покупки" },
  exchange_supply: { t: "Запас биткоинов на биржах", p: "растёт — монеты несут продавать, падает — уносят на хранение" },
  exchange_netflow_30d: { t: "Приток биткоинов на биржи за месяц", p: "чистое движение монет на биржи и с бирж" },
  institutional_quality: { t: "Позиции фондов во фьючерсах CME (отчёт CFTC)", p: "видно, покупают ли институционалы направленно или зарабатывают на арбитраже" },
  us_spot_premium: { t: "Премия американских бирж", p: "покупают ли биткоин дороже именно в США" , quiet: true },
  mvrv_cycle: { t: "Оценка рынка биткоина (MVRV)", p: "насколько цена выше средней цены покупки всех монет — мера накопленной прибыли рынка" },
  network_security: { t: "Мощность сети биткоина и сложность майнинга", p: "устойчивое падение означает, что майнеры выключают оборудование и вынуждены продавать монеты" },
  fee_pressure: { t: "Комиссии в сети биткоина", p: "спрос на место в блоках" , quiet: true },
  network_activity: { t: "Активность сети биткоина", p: "сколько адресов и транзакций реально работает в сети" },
  miner_regime: { t: "Доходность майнинга", p: "сколько майнеры зарабатывают на единицу мощности" },
  trend_regime: { t: "Тренд цены биткоина", p: "положение цены относительно её долгосрочных средних" , quiet: true },
  drawdown: { t: "Падение биткоина от исторического максимума", p: "на какой стадии цикла находится рынок" , quiet: true },
  realized_volatility: { t: "Волатильность биткоина за 30 дней", p: "насколько сильно цена колебалась в последний месяц" , quiet: true },
  volume_confirmation: { t: "Объём торгов биткоином", p: "подкреплено ли движение цены реальным оборотом" , quiet: true },
  tga_daily: { t: "Счёт Минфина США в ФРС (ежедневно)", p: "когда Минфин тратит накопленное — деньги приходят в экономику" },
  g3_liquidity: { t: "Совокупные балансы ФРС, ЕЦБ и Банка Японии", p: "мировая долларовая ликвидность целиком, а не только американская" },
  gold_axis: { t: "Связь биткоина с золотом", p: "ведёт ли себя биткоин как защитный актив" , quiet: true },
  sth_pricing: { t: "Цена биткоина относительно средней цены покупки недавних держателей", p: "ниже единицы — недавние покупатели сидят в убытке, это типично для медвежьей фазы" },
  realized_pnl: { t: "Продают ли биткоин в прибыль или в убыток", p: "устойчивые продажи в убыток — признак капитуляции" },
  hash_ribbons: { t: "Тренд мощности сети биткоина", p: "классический индикатор конца капитуляции майнеров" , quiet: true },
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

const humanTitle = (id, fallback) => HUMAN[id]?.t || fallback || id;
const humanPlain = (id) => HUMAN[id]?.p || "";
const humanRelease = (s) => {
  const raw = String(s || "").trim().toLowerCase();
  return RELEASE_HUMAN[raw] || RELEASE_HUMAN[raw.split("·")[0].trim()] || sourceLabel(s);
};

// BTC-панель: карточка считается непрерывной, если её наблюдение моложе этого возраста —
// это живой рыночный фид (споты, деривативы, пеги, комиссии мемпула), у него нет релизов.
const LIVE_FEED_MAX_AGE_MS = 6 * 3600 * 1000;

// Сколько последних точек ряда каждой карточки помним, чтобы поймать переписанную историю.
// Ревизия может уехать на месяцы назад (наблюдавшийся случай: 24.07 переписана точка за 27.05),
// поэтому окно широкое. Ряды публикуют 30 карточек из 40; те, что не публикуют, — живые фиды
// (деривативы, споты, пеги, комиссии), они по своей природе не пересматриваются.
const POINT_MEMORY = 150;

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
      revisable: false, // ревизия ловится сравнением точек ряда, а не текущего значения
      release: live ? "живой рыночный фид" : m.source || "",
      points: compactSeries(m.series),
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
  // Аллокация и её устойчивость. Порог смены режима опубликован политикой (полосы ±20), балл
  // блока — среднее по его семьям × 50, поэтому «сколько до разворота» считается честно:
  // видно, хватит ли одного шага одной группы показателей, чтобы доля вернулась обратно.
  const bands = { adverse: -20, supportive: 20 };
  const blocks = {};
  for (const [k, b] of Object.entries(snap.blocks || {})) {
    const fams = Object.keys(b?.strategic?.families || {}).length;
    const score = b?.strategic?.score;
    if (!finite(score) || !fams) continue;
    blocks[k] = { title: BLOCK_TITLE[k] || k, score, families: fams, step: 50 / fams };
  }
  const allocation = finite(snap.decision?.target_pct)
    ? {
        pct: snap.decision.target_pct,
        regime: snap.regime?.strategic || "",
        ladder: snap.decision.regime_targets_pct || null,
        overlays: snap.decision.binding_overlays || [],
        reasons: snap.decision.reason_codes || [],
        quality: snap.decision.quality?.status || "",
        blocks,
        bands,
        hold: snap.regime_meta?.strategic || null,
      }
    : null;

  return {
    generated_at: snap.generated_at || "",
    assetWord: "биткоина",
    allocation,
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
  allocation: { emoji: "🎯", label: "изменение доли капитала" },
  risk: { emoji: "⚠️", label: "сигнал риска" },
  release: { emoji: "📊", label: "вышли новые данные" },
  revision: { emoji: "♻️", label: "пересмотр опубликованных данных" },
};

// Порядок важен: сначала то, что меняет вывод, потом то, что его питает.
const KIND_ORDER = ["allocation", "risk", "release", "revision"];

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

// Читаемое число для точки ряда: у карточек разный масштаб (хешрейт 7·10²⁰ H/s и MVRV 1,8
// живут рядом), поэтому крайние порядки уходят в экспоненту, остальное — обычным числом.
function fmtPoint(v) {
  if (!finite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e7 || a < 1e-3)) return v.toExponential(3).replace(".", ",").replace("e+", "·10^").replace("e-", "·10^−");
  const digits = a >= 100 ? 1 : a >= 1 ? 2 : 4;
  return v.toLocaleString("ru-RU", { maximumFractionDigits: digits });
}

const dayLabel = (t) => new Date(Number(t)).toISOString().slice(0, 10);
// В сообщении дата читается человеком, а не машиной: 27.05.2026 вместо 2026-05-27.
const ruDay = (t) => { const d = new Date(Number(t)); return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`; };

// Переписанная история: сравниваем ТЕ ЖЕ метки времени в старом и новом ряду. Точки от
// последней запомненной и новее не считаются — последняя точка суток ещё формируется, её
// изменение это ход рынка, а не ревизия.
function seriesRevisions(wasPoints, curPoints) {
  if (!wasPoints || !curPoints) return [];
  const frontier = Math.max(...Object.keys(wasPoints).map(Number));
  const changed = [];
  for (const [tRaw, oldV] of Object.entries(wasPoints)) {
    const t = Number(tRaw);
    if (!finite(t) || t >= frontier) continue;
    const newV = curPoints[tRaw];
    if (!finite(newV) || !finite(oldV)) continue;
    const scale = Math.max(Math.abs(oldV), Math.abs(newV), 1e-12);
    if (Math.abs(newV - oldV) <= scale * 1e-9) continue;
    changed.push({ t, before: oldV, after: newV, pct: oldV === 0 ? null : ((newV / oldV - 1) * 100) });
  }
  changed.sort((a, b) => a.t - b.t);
  return changed;
}

// Названия детекторов у панелей внутренние («Слом маржинального спроса»); наружу идёт то же
// самое, но словами, которые понятны без чтения методологии.
const DETECTOR_HUMAN = {
  "Слом маржинального спроса": "Приток денег в биткоин прекратился",
  "Макрошок ликвидности": "Долларовая ликвидность резко сжимается",
  "Дистрибуция и потеря тренда": "Крупные держатели распродают на фоне слома тренда",
  "Капитуляция → восстановление": "Признаки разворота после капитуляции",
  "Перегрев / каскад плеча": "Риск каскада ликвидаций из-за плеча",
  "Условия short squeeze": "Условия для короткого сжатия (short squeeze)",
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

// Насколько смена доли устойчива: близко ли решающие величины к своим порогам и подтверждена ли
// смена выдержкой. Отвечает на вопрос «не откатится ли это завтра обратно».
function stabilityLines(prevAlloc, curAlloc) {
  const out = [];
  // BTC-панель: блок считается неблагоприятным при балле ≤ −20; шаг одной группы показателей
  // двигает блок на 50/N пунктов. Значит видно, хватит ли одного шага, чтобы всё отыграть назад.
  const blocks = Object.values(curAlloc.blocks || {});
  if (blocks.length && curAlloc.bands) {
    // Решение держат именно НЕБЛАГОПРИЯТНЫЕ блоки: пока их два, доля минимальна. Поэтому запас
    // прочности — это расстояние такого блока до выхода из неблагоприятной зоны, а не расстояние
    // любого блока до любой границы (иначе в оценку попадёт блок, который на решение не влияет).
    const withMargin = blocks.map((b) => ({ ...b, adverse: b.score <= curAlloc.bands.adverse, margin: Math.abs(b.score - curAlloc.bands.adverse) }));
    const holding = withMargin.filter((b) => b.adverse);
    const near = (holding.length ? holding : withMargin).sort((a, b) => a.margin - b.margin)[0];
    if (near) {
      const steps = near.margin / near.step;
      const stepWord = steps < 1 ? "меньше одного шага" : `${fmtPoint(steps)} шага`;
      out.push(
        near.adverse
          ? `чтобы решение отыграло назад, блоку «${near.title}» нужно подняться на ${fmtPoint(near.margin)} ${plural(near.margin, "пункт", "пункта", "пунктов")} — это ${stepWord} одной из ${near.families} групп показателей внутри него`
          : `ближайший риск: блок «${near.title}» в ${fmtPoint(near.margin)} ${plural(near.margin, "пункте", "пункта", "пунктах")} от неблагоприятной зоны (${stepWord} одной из ${near.families} групп)`
      );
      if (holding.length > 1) out.push(`сейчас неблагоприятны ${holding.length} ${plural(holding.length, "блок", "блока", "блоков")} из ${blocks.length} — отката одного из них для смены решения не хватит`);
    }
  }
  if (curAlloc.hold && finite(curAlloc.hold.count)) {
    out.push(
      curAlloc.hold.candidate && curAlloc.hold.candidate !== curAlloc.hold.state
        ? `сейчас копится встречное изменение: оно держится ${curAlloc.hold.count} ${plural(curAlloc.hold.count, "наблюдение", "наблюдения", "наблюдений")} подряд`
        : `текущее состояние подтверждено ${curAlloc.hold.count} ${plural(curAlloc.hold.count, "наблюдением", "наблюдениями", "наблюдениями")} подряд`
    );
  }
  // Макро-панель: страница сама печатает пороги возврата на соседнюю ступень.
  if (curAlloc.up) out.push(`что вернёт долю выше: ${curAlloc.up}`);
  if (curAlloc.down) out.push(`что снизит её дальше: ${curAlloc.down}`);
  if (finite(curAlloc.score)) out.push(`сводная оценка обстановки сейчас ${curAlloc.score > 0 ? "+" : ""}${curAlloc.score} по шкале от −100 до +100`);
  if (curAlloc.frozen) out.push("повышение доли заморожено сработавшим детектором риска");
  if (curAlloc.override) out.push("сработал аварийный переключатель — доля выставлена принудительно");
  if (curAlloc.pending) out.push("следующая ступень уже накапливает подтверждение");
  if (curAlloc.quality && curAlloc.quality !== "good") out.push(`качество входных данных: ${curAlloc.quality}`);
  return out;
}

// Короткая сводка недавней истории показателя — она уходит В КОНТЕКСТ модели, чтобы «насколько
// это существенно» опиралось на цифры, а не на ощущение. Бесплатного консенсуса аналитиков нет
// ни в одном источнике панелей, поэтому «ожидалось» честно заменяется на «как было в последние
// месяцы»: модели прямо запрещено выдумывать прогнозные цифры.
function historyDigest(i) {
  const pts = i.points;
  if (!pts) return "";
  const rows = Object.entries(pts).map(([t, v]) => [Number(t), v]).sort((a, b) => a[0] - b[0]);
  if (rows.length < 5) return "";
  const vals = rows.map((r) => r[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const last = rows.slice(-4).map(([t, v]) => `${ruDay(t)} ${fmtPoint(v)}`).join(", ");
  const monthAgo = rows.filter(([t]) => t <= rows[rows.length - 1][0] - 30 * 864e5).pop();
  return [
    `последние наблюдения: ${last}`,
    monthAgo ? `месяц назад ${fmtPoint(monthAgo[1])}` : "",
    `за ${rows.length} наблюдений диапазон ${fmtPoint(min)}…${fmtPoint(max)}`,
  ].filter(Boolean).join(" · ");
}

function valueChanged(prev, cur) {
  if (prev.value_num != null && cur.value_num != null) return !sameNum(prev.value_num, cur.value_num);
  return String(prev.value) !== String(cur.value);
}

function diff(prevState, panel) {
  const events = [];
  const releaseGroups = [];
  const revisedSeries = [];
  const bounced = [];
  const seenRevised = prevState.revised_points || {};
  const prevInd = prevState.indicators || {};

  // Изменения внутри панели (вердикт, зоны показателей, детекторы) сами по себе НЕ рассылаются:
  // это внутренняя кухня. Они собираются как объяснение к единственному внешнему событию о самой
  // панели — смене доли капитала. Исключение: сработавший детектор риска, который долю не сдвинул,
  // уходит коротким отдельным сообщением, потому что это факт о рынке, а не о панели.
  const prevAlloc = prevState.allocation || null;
  const curAlloc = panel.allocation || null;
  const allocMoved =
    prevAlloc && curAlloc && finite(prevAlloc.pct) && finite(curAlloc.pct) && !sameNum(prevAlloc.pct, curAlloc.pct);
  const why = [];
  const detectorMoves = [];

  const prevDet = prevState.detectors || {};
  for (const d of panel.detectors || []) {
    const was = prevDet[d.id];
    if (was && was.state !== d.state) detectorMoves.push({ d, from: was.state, to: d.state });
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

    // Сдвиг оценки показателя — не сообщение, а материал для объяснения смены доли капитала.
    if (zoneChanged) {
      why.push({
        id: i.id,
        name: humanTitle(i.id, i.name),
        from: fmtValue(was),
        to: fmtValue(i),
        worse: (i.score ?? 0) < (was.score ?? 0),
        sameValue: fmtValue(was) === fmtValue(i),
      });
    }
    // Релиз: вышли новые данные И значение действительно изменилось.
    // Одна публикация первоисточника обычно двигает несколько карточек (H.15 — сразу пять,
    // ETF — четыре), поэтому релизы собираются в ОДНО сообщение на публикацию, а не на карточку.
    if (i.scheduled && dateAdvanced && changed && !HUMAN[i.id]?.quiet) {
      releaseGroups.push({ i, was });
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
    const rewritten = (HUMAN[i.id]?.quiet ? [] : seriesRevisions(was.points, i.points)).filter((c) => {
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
        const sig = changed.map((c) => `${c.t}|${c.before}|${c.after}`).join(";");
        if (!bySignature.has(sig)) bySignature.set(sig, { names: [], changed, sources: new Set() });
        const slot = bySignature.get(sig);
        slot.names.push(humanTitle(i.id, i.name));
        if (i.source) slot.sources.add(sourceLabel(i.source));
      }
      const span = g.from !== g.to;
      const moves = [];
      const sources = new Set();
      for (const slot of bySignature.values()) {
        for (const s of slot.sources) sources.add(s);
        for (const c of slot.changed.slice(-3)) {
          moves.push({
            name: (span ? `${ruDay(c.t)} · ` : "") + slot.names.join(" · "),
            before: fmtPoint(c.before),
            after: fmtPoint(c.after),
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
  for (const { i, was } of releaseGroups) {
    const key = `${humanRelease(i.release || i.source)}|${i.observed_at}`;
    if (!groups.has(key))
      groups.set(key, { release: humanRelease(i.release || i.source), cadence: i.cadence || "", observed_at: i.observed_at, moves: [], plain: [], history: [] });
    const g = groups.get(key);
    // «смешанно → смешанно» читателю ничего не говорит: внутри у панели поменялась оценка,
    // а видимое значение осталось прежним. Такие строки в сообщение не идут.
    if (fmtValue(was) !== fmtValue(i)) g.moves.push({ name: humanTitle(i.id, i.name), before: fmtValue(was), after: fmtValue(i), delta: "" });
    g.plain.push(...(humanPlain(i.id) ? [`${humanTitle(i.id, i.name)} — ${humanPlain(i.id)}`] : []));
    g.history.push(...(historyDigest(i) ? [`${humanTitle(i.id, i.name)}: ${historyDigest(i)}`] : []));
  }
  for (const [key, g] of groups) {
    if (!g.moves.length) continue;
    events.push({
      kind: "release",
      key: `rel:${key}`,
      title: g.release,
      before: "",
      after: "",
      detail: g.observed_at ? `данные за ${ruDay(Date.parse(g.observed_at))}` : "",
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

  // ---- Доля капитала: что стало, почему и насколько это устойчиво ----
  if (allocMoved) {
    const dir = curAlloc.pct > prevAlloc.pct ? "увеличена" : "сокращена";
    const causes = [];
    for (const w of why.slice(0, 6)) {
      causes.push(w.sameValue ? `${w.name} — оценка ${w.worse ? "ухудшилась" : "улучшилась"}` : `${w.name}: ${w.from} → ${w.to}`);
    }
    for (const { d, from, to } of detectorMoves) {
      causes.push(`${detectorHuman(d.name)}: ${DET_LABEL[from] || from} → ${DET_LABEL[to] || to}`);
    }
    events.push({
      kind: "allocation",
      key: `alloc:${prevAlloc.pct}->${curAlloc.pct}`,
      title: `Доля ${panel.assetWord || "рискового актива"} ${dir}`,
      before: `${prevAlloc.pct}%`,
      after: `${curAlloc.pct}%`,
      detail: "",
      causes,
      stability: stabilityLines(prevAlloc, curAlloc),
      note: "",
    });
  } else {
    // Детектор риска сработал или успокоился, а доля не изменилась — это всё равно факт о рынке.
    for (const { d, from, to } of detectorMoves) {
      if (to === "calm" && from === "watch") continue; // снятие предварительной тревоги — не новость
      events.push({
        kind: "risk",
        key: `risk:${d.id}:${to}`,
        title: detectorHuman(d.name),
        before: DET_LABEL[from] || from,
        after: DET_LABEL[to] || to,
        detail: String(d.inputs || "").slice(0, 260),
        note: d.note || "",
      });
    }
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
  const plain = (ev.plain || [])[0];
  return plain ? `Что это за показатель: ${plain}.` : "Вышли новые данные первоисточника.";
}

function renderMessage(ev, comment) {
  const k = KIND[ev.kind] || { emoji: "•", label: ev.kind };
  const head = `${k.emoji} <b>${esc(ev.title)}</b>`;
  const move = ev.before || ev.after ? `${esc(ev.before || "—")} → <b>${esc(ev.after || "—")}</b>` : "";
  const moves = (ev.moves || [])
    .map((m) => `• ${esc(m.name)}: ${esc(m.before)} → <b>${esc(m.after)}</b>${m.delta ? ` <i>(${esc(m.delta)})</i>` : ""}`)
    .join("\n");
  const causes = (ev.causes || []).map((c) => `• ${esc(c)}`).join("\n");
  const stability = (ev.stability || []).map((s) => `• ${esc(s)}`).join("\n");
  const lines = [
    head,
    move,
    moves,
    ev.detail ? esc(ev.detail) : "",
    causes ? `\n<b>Что за этим стоит</b>\n${causes}` : "",
    stability ? `\n<b>Насколько это устойчиво</b>\n${stability}` : "",
  ].filter(Boolean);
  if (ev.indicator?.observed_at) lines.push(`<i>данные на ${esc(ev.indicator.observed_at)}${ev.indicator.source ? " · " + esc(ev.indicator.source) : ""}</i>`);
  lines.push("");
  lines.push("💬 " + esc(comment));
  const text = lines.join("\n");
  return text.length > 4000 ? text.slice(0, 3990) + "…" : text;
}

/* ================================== 5. КОММЕНТАРИИ ================================== */

const LLM_SYSTEM = `Ты — экономический обозреватель. Пишешь короткие пояснения к вышедшим данным для умного читателя БЕЗ финансового образования.

О ЧЁМ ПИСАТЬ (в таком порядке, сплошным текстом, без заголовков и списков):
1. Что означает это движение по существу.
2. Насколько оно существенно — опирайся на «recent_history», которую тебе дали: рядовое колебание, заметный сдвиг или редкая величина.
3. Какие наиболее вероятные последствия и за чем стоит следить дальше.

ЖЁСТКИЕ ПРАВИЛА:
· НИКОГДА не упоминай панель, дашборд, баллы, зоны, композит, детекторы, вклад в оценку. Читатель ничего о них не знает и знать не должен.
· Любой термин объясняй в двух-трёх словах прямо в тексте при первом употреблении.
· Числа бери ТОЛЬКО из переданных данных. Не выдумывай консенсус аналитиков, прогнозы и цифры, которых тебе не дали. Если уместно сказать про ожидания рынка — говори качественно и честно оговаривай, что это не свежий опрос.
· 2–4 предложения. Живой русский, короткие фразы, без канцелярита, без дисклеймеров, без «важно отметить».
· Не давай приказов вида «покупайте/продавайте» — описывай механику и следствия.
· Рядовое движение так и назови рядовым: пустая тревога хуже молчания.

Ответ — СТРОГО JSON-массив вида [{"i":0,"text":"..."}] и ничего больше.`;

// Модель получает СОСТОЯНИЕ РЫНКА, а не состояние панели: несколько ключевых величин своими
// именами. Ни вердиктов, ни баллов, ни детекторов — иначе они протекут в текст сообщения.
function llmContext(panel) {
  const named = (panel.indicators || [])
    .filter((i) => HUMAN[i.id] && i.value)
    .slice(0, 20)
    .map((i) => `${humanTitle(i.id, i.name)}: ${fmtValue(i)}`);
  return { market_now: named };
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
              what_it_is: (e.plain || []).join("; ").slice(0, 700) || undefined,
              recent_history: (e.history || []).join("; ").slice(0, 900) || undefined,
              why_changed: (e.causes || []).join("; ").slice(0, 600) || undefined,
              stability: (e.stability || []).join("; ").slice(0, 600) || undefined,
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
      points: i.points || null,
    };
  }
  const detectors = {};
  for (const d of panel.detectors || []) detectors[d.id] = { state: d.state };
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    generated_at: panel.generated_at || "",
    verdict: { word: panel.verdict?.word || "" },
    allocation: panel.allocation || null,
    indicators,
    detectors,
    revisions: panel.revisions || [],
  };
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

async function main() {
  const panel = await readPanel();

  if (process.env.NOTIFY_PING === "1") {
    const text = pingMessage(panel);
    if (DRY) console.log(text.replace(/<[^>]+>/g, ""));
    else await sendTelegram(text);
    console.log(DRY ? "пинг: dry-run, ничего не отправлено" : "пинг отправлен");
    return;
  }

  const prev = (await readJSON(STATE_PATH)) || {};
  const first = !prev.indicators;
  const now = Date.now();
  const sentIndex = pruneSent(prev.sent, now);
  let revisedSeen = prev.revised_points || {};
  const all = first ? [] : diff(prev, panel);
  const events = all.filter((ev) => !sentIndex[sentKey(ev)]);

  if (first) console.log("первый прогон: зафиксирована база, уведомления начнутся со следующего изменения");
  if (all.length !== events.length) console.log(`уже доставлено ранее и пропущено: ${all.length - events.length}`);
  console.log(`событий: ${events.length}`);

  let baseline = null; // сдвигается один раз в самом конце — до тех пор пишем старую базу
  const persist = async () => {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify({ ...(baseline || prev), sent: sentIndex, revised_points: revisedSeen }, null, 1));
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
        if (ev.revisedPoints) revisedSeen = rememberRevised(revisedSeen, [ev], now);
        await persist(); // индекс доставленного — сразу на диск, база сдвинется в конце
        if (i < capped.length - 1) await sleep(SEND_GAP_MS);
      }
    }
  }

  if (DRY) revisedSeen = rememberRevised(revisedSeen, events.filter((e) => e.revisedPoints), now);
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

export { diff, renderMessage, templateComment, fromSnapshotJSON, snapshotState, llmComments, sentKey, pruneSent, rememberRevised, pingMessage, HUMAN, MACRO_CADENCE };
