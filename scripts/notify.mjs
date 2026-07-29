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
const FREE_CHAIN = [
  FREE_MODEL,                          // NVIDIA, самая крупная — первый выбор по качеству
  "google/gemma-4-31b-it:free",        // Google
  "openai/gpt-oss-20b:free",           // OpenAI OSS
  "inclusionai/ling-3.0-flash:free",   // InclusionAI
];
const resolveModel = () => (process.env.NOTIFY_MODEL || "").trim() || FREE_MODEL;
const paidAllowed = () => process.env.NOTIFY_ALLOW_PAID === "1";
// Если модель задана явно — уважаем выбор и цепочку не подставляем.
const modelChain = () => ((process.env.NOTIFY_MODEL || "").trim() ? [resolveModel()] : FREE_CHAIN);
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
  liquidity_regime: { t: "Чистая ликвидность ФРС", p: "сколько долларов от ФРС реально доступно рынкам", rel: "Баланс ФРС" },
  netliq_4w: { t: "Чистая ликвидность ФРС за 4 недели", p: "краткосрочное направление долларовой ликвидности", rel: "Баланс ФРС" },
  netliq_13w: { t: "Чистая ликвидность ФРС за квартал", p: "среднесрочное направление долларовой ликвидности", rel: "Баланс ФРС" },
  financial_conditions: { t: "Реальные ставки и курс доллара", p: "две главные цены, определяющие спрос на рисковые активы", rel: "Ставки и курс доллара (ФРС)" },
  two_year: { t: "Доходность 2-летних облигаций США", p: "во что рынок оценивает будущую политику ФРС", rel: "Доходности гособлигаций США (ФРС)" },
  system_stress: { t: "Кредитный и рыночный стресс", p: "сводка по кредитным премиям, страховке на акции и волатильности госдолга", rel: "Кредитные спреды и волатильность" },
  macro_lens: { t: "Связь биткоина с индексом Nasdaq", p: "торгуется ли биткоин как обычный рисковый актив или живёт своей жизнью" , quiet: true },
  etf_regime: { t: "Потоки в биткоин-ETF в США", p: "сколько денег институциональные инвесторы вложили в биткоин или вывели через биржевые фонды", rel: "Потоки в биткоин-ETF" },
  etf_1d: { t: "Потоки в биткоин-ETF за день", p: "приток или отток денег через американские биржевые фонды за последний торговый день", rel: "Потоки в биткоин-ETF" },
  etf_5d: { t: "Потоки в биткоин-ETF за неделю", p: "приток или отток за пять торговых дней", rel: "Потоки в биткоин-ETF" },
  etf_20d: { t: "Потоки в биткоин-ETF за месяц", p: "приток или отток за двадцать торговых дней", rel: "Потоки в биткоин-ETF" },
  stablecoin_regime: { t: "Объём стейблкоинов", p: "сколько «долларов» находится внутри криптосистемы и может быть потрачено на покупки", rel: "Стейблкоины" },
  exchange_supply: { t: "Запас биткоинов на биржах", p: "растёт — монеты несут продавать, падает — уносят на хранение", rel: "Ончейн-данные сети биткоина" },
  exchange_netflow_30d: { t: "Приток биткоинов на биржи за месяц", p: "чистое движение монет на биржи и с бирж", rel: "Ончейн-данные сети биткоина" },
  institutional_quality: { t: "Позиции фондов во фьючерсах CME (отчёт CFTC)", p: "видно, покупают ли институционалы направленно или зарабатывают на арбитраже", rel: "Отчёт CFTC о позициях во фьючерсах" },
  us_spot_premium: { t: "Премия американских бирж", p: "покупают ли биткоин дороже именно в США" , quiet: true },
  mvrv_cycle: { t: "Оценка рынка биткоина (MVRV)", p: "насколько цена выше средней цены покупки всех монет — мера накопленной прибыли рынка", rel: "Ончейн-данные сети биткоина" },
  network_security: { t: "Мощность сети биткоина и сложность майнинга", p: "устойчивое падение означает, что майнеры выключают оборудование и вынуждены продавать монеты", rel: "Сеть биткоина" },
  fee_pressure: { t: "Комиссии в сети биткоина", p: "спрос на место в блоках" , quiet: true },
  network_activity: { t: "Активность сети биткоина", p: "сколько адресов и транзакций реально работает в сети", rel: "Ончейн-данные сети биткоина" },
  miner_regime: { t: "Доходность майнинга", p: "сколько майнеры зарабатывают на единицу мощности", rel: "Ончейн-данные сети биткоина" },
  trend_regime: { t: "Тренд цены биткоина", p: "положение цены относительно её долгосрочных средних" , quiet: true },
  drawdown: { t: "Падение биткоина от исторического максимума", p: "на какой стадии цикла находится рынок" , quiet: true },
  realized_volatility: { t: "Волатильность биткоина за 30 дней", p: "насколько сильно цена колебалась в последний месяц" , quiet: true },
  volume_confirmation: { t: "Объём торгов биткоином", p: "подкреплено ли движение цены реальным оборотом" , quiet: true },
  tga_daily: { t: "Счёт Минфина США в ФРС (ежедневно)", p: "когда Минфин тратит накопленное — деньги приходят в экономику", rel: "Минфин США" },
  g3_liquidity: { t: "Совокупные балансы ФРС, ЕЦБ и Банка Японии", p: "мировая долларовая ликвидность целиком, а не только американская", rel: "Балансы центробанков ФРС, ЕЦБ и Банка Японии" },
  gold_axis: { t: "Связь биткоина с золотом", p: "ведёт ли себя биткоин как защитный актив" , quiet: true },
  sth_pricing: { t: "Цена биткоина относительно средней цены покупки недавних держателей", p: "ниже единицы — недавние покупатели сидят в убытке, это типично для медвежьей фазы", rel: "Ончейн-данные сети биткоина" },
  realized_pnl: { t: "Продают ли биткоин в прибыль или в убыток", p: "устойчивые продажи в убыток — признак капитуляции", rel: "Ончейн-данные сети биткоина" },
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
  [/coinmetrics|coin metrics|bitcoin-data|bgeometrics/i, "Ончейн-данные сети биткоина"],
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

// BTC-панель: карточка считается непрерывной, если её наблюдение моложе этого возраста —
// это живой рыночный фид (споты, деривативы, пеги, комиссии мемпула), у него нет релизов.
const LIVE_FEED_MAX_AGE_MS = 6 * 3600 * 1000;

// Сколько последних точек ряда каждой карточки помним, чтобы поймать переписанную историю.
// Ревизия может уехать на месяцы назад (наблюдавшийся случай: 24.07 переписана точка за 27.05),
// поэтому окно широкое. Ряды публикуют 30 карточек из 40; те, что не публикуют, — живые фиды
// (деривативы, споты, пеги, комиссии), они по своей природе не пересматриваются.
const POINT_MEMORY = 150;

// Журнал смен доли из опубликованной панелью истории: [{t, from, to}]. Записи истории идут
// по времени, доля лежит в decision.target_pct; берём только моменты, где она изменилась.
function decisionChanges(history) {
  const rows = (history || [])
    .map((r) => ({ t: Date.parse(r?.t || ""), pct: r?.decision?.target_pct }))
    .filter((r) => finite(r.t) && finite(r.pct))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (!sameNum(rows[i].pct, rows[i - 1].pct)) out.push({ t: rows[i].t, from: rows[i - 1].pct, to: rows[i].pct });
  }
  return out;
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
        sample: { t: Date.parse(snap.generated_at || "") || Date.now(), pct: snap.decision.target_pct, score: snap.scores?.strategic ?? null,
                  blocks: Object.fromEntries(Object.entries(blocks).map(([k, b]) => [k, b.score])) },
        // Панель публикует собственную историю решений — из неё сразу видно, как часто такие
        // смены откатывались. Без этого «сколько раз откатывалось» пришлось бы копить с нуля
        // неделями, и самый сильный довод об устойчивости молчал бы всё это время.
        changes: decisionChanges(snap.history),
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
   1. ЭМПИРИКА. Как часто такие решения откатывались назад в собственной истории панели. База
      частот сильнее любых рассуждений о механизме.
   2. ЗАПАС В ЕДИНИЦАХ ОБЫЧНОГО ШУМА. Не «5 пунктов», а «меньше, чем эта величина обычно проходит
      за сутки»: абсолютные числа читателю ничего не говорят, отношение к дневному ходу — говорит.
   3. СКОЛЬКО НЕЗАВИСИМЫХ ФАКТОРОВ держат решение. Если против прежней доли работает один фактор,
      его разворота достаточно; если два — нужно, чтобы развернулись оба.
   4. ВОЗРАСТ решения: свежие смены откатываются чаще устоявшихся.                            */
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

// Слияние журналов смен по времени с устранением дублей: у панели своя история, у нас своя,
// и в пересечении они описывают одни и те же события.
function mergeChanges(published, own) {
  const all = [...(published || []), ...(own || [])].filter((c) => finite(c?.t) && finite(c?.to));
  const seen = new Map();
  for (const c of all) seen.set(`${Math.round(c.t / 60000)}|${c.to}`, c);
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

// Как часто смена решения откатывалась обратно в течение двух суток — собственная база частот.
function revertStats(changes) {
  if (!Array.isArray(changes) || changes.length < 3) return null;
  let reverted = 0;
  for (let i = 0; i < changes.length - 1; i++) {
    const a = changes[i], b = changes[i + 1];
    if (b.t - a.t <= 48 * 3600e3 && sameNum(b.to, a.from)) reverted++;
  }
  return { total: changes.length, reverted, rate: reverted / changes.length };
}

// Насколько смена доли устойчива: близко ли решающие величины к своим порогам и подтверждена ли
// смена выдержкой. Отвечает на вопрос «не откатится ли это завтра обратно».
function stabilityLines(prevAlloc, curAlloc, prevState) {
  const out = [];
  // BTC-панель: блок считается неблагоприятным при балле ≤ −20; шаг одной группы показателей
  // двигает блок на 50/N пунктов. Значит видно, хватит ли одного шага, чтобы всё отыграть назад.
  // --- что именно держит решение и что его развернёт ---
  const blocks = Object.values(curAlloc.blocks || {});
  let holders = null, needFlips = null, marginRaw = null, nearTitle = "";
  if (blocks.length && curAlloc.bands) {
    const withMargin = blocks.map((b) => ({ ...b, adverse: b.score <= curAlloc.bands.adverse, margin: Math.abs(b.score - curAlloc.bands.adverse) }));
    const holding = withMargin.filter((b) => b.adverse);
    holders = holding.map((b) => b.title);
    const near = (holding.length ? holding : withMargin).sort((a, b) => a.margin - b.margin)[0];
    if (near) {
      marginRaw = near.margin;
      needFlips = Math.max(1, Math.ceil(near.margin / near.step));
      nearTitle = near.title;
    }
  }

  // --- макро-панель: запас до порога берётся из условий, которые страница печатает сама ---
  // «↓ до 35%: композит ≤ −13» при текущей оценке +9 означает запас 22 пункта. Обе цифры уже
  // есть на странице, и без этого вердикт для макро-панели был почти всегда «умеренный» без
  // единого числового довода.
  if (marginRaw === null && finite(curAlloc.score)) {
    const th = thresholdFrom(curAlloc.down) ?? thresholdFrom(curAlloc.up);
    if (finite(th)) {
      marginRaw = Math.abs(curAlloc.score - th);
      nearTitle = "";
    }
  }

  // --- эмпирика: как часто такие решения откатывались и как сильно величина гуляет за сутки ---
  const trend = (prevState.alloc_trend || []).concat(curAlloc.sample ? [curAlloc.sample] : []);
  const decisiveSeries = trend
    .map((s) => ({ t: s.t, v: blocks.length ? s.blocks?.[nearKey(curAlloc, nearTitle)] : s.score }))
    .filter((x) => finite(x.v) && finite(x.t));
  const noise = typicalDailyMove(decisiveSeries);
  const marginDays = finite(marginRaw) && noise ? marginRaw / noise : null;

  // Журнал смен: опубликованный панелью (сразу даёт базу) + накопленный самим уведомлением.
  // Второй нужен там, где панель историю решений не публикует (макро-панель).
  const changes = mergeChanges(curAlloc.changes, prevState.alloc_changes);
  const reverts = revertStats(changes);
  const ageH = curAlloc.hold && finite(curAlloc.hold.count) ? curAlloc.hold.count : null;

  // --- класс устойчивости ---
  // ВАЖНО про лестницу: потеря ОДНОГО неблагоприятного фактора уже поднимает долю на ступень
  // (два неблагоприятных → защитный режим, один → ухудшение). Поэтому решающее — запас у САМОГО
  // СЛАБОГО из них, а не то, сколько их всего. Первая версия считала наоборот и выдавала
  // «отката одного не хватит» там, где его как раз хватало.
  let tier = "moderate";
  if (curAlloc.override) tier = "forced";
  else if ((needFlips !== null && needFlips <= 1) || (marginDays !== null && marginDays < 1) || (reverts && reverts.rate >= 0.34 && (ageH ?? 99) < 24)) tier = "shaky";
  else if ((needFlips !== null && needFlips >= 3) || (marginDays !== null && marginDays >= 3)) tier = "firm";

  // --- объяснение обычными словами: самые сильные доводы, без механики ---
  const reason = [];
  if (tier === "forced") reason.push("доля выставлена аварийным переключателем и вернётся, как только он снимется");
  else if (needFlips !== null && nearTitle) {
    reason.push(
      needFlips <= 1
        ? `ближе всего к развороту — ${nearTitle}: достаточно, чтобы один показатель внутри этого направления улучшился на ступень`
        : `чтобы развернулось направление «${nearTitle}», улучшиться должны минимум ${needFlips} показателя внутри него — одного мало`
    );
    if (holders && holders.length >= 2) reason.push("но и это вернёт долю не полностью, а на одну ступень вверх: против неё работает ещё " + holders.filter((h) => h !== nearTitle)[0]);
  }
  if (marginDays !== null) {
    reason.push(
      marginDays < 1
        ? "до отката осталось меньше, чем обстановка обычно проходит за сутки"
        : `запас до отката — примерно ${fmtPoint(Math.min(marginDays, 10))} ${plural(Math.round(marginDays), "день", "дня", "дней")} обычного движения`
    );
  } else if (finite(marginRaw) && !nearTitle) {
    // Числовой запас есть, но накопленной истории ещё мало, чтобы перевести его в дни.
    reason.push(`обстановке нужно ухудшиться ещё на ${fmtPoint(marginRaw)} ${plural(Math.round(marginRaw), "пункт", "пункта", "пунктов")} по шкале от −100 до +100, чтобы доля упала на ступень ниже`);
  }
  if (reverts && reverts.total >= 3) {
    reason.push(
      reverts.reverted === 0
        ? `похожих смен в прошлом было ${reverts.total}, и ни одна не откатилась обратно в течение двух суток`
        : `в прошлом из ${reverts.total} таких смен ${reverts.reverted} ${plural(reverts.reverted, "откатилась", "откатились", "откатились")} обратно в течение двух суток`
    );
  }
  if (curAlloc.up && tier !== "forced") reason.push(`вернуть прежнюю долю может: ${curAlloc.up.replace(/^апгрейд разблокируется, когда/, "снятие паузы, когда")}`);
  if (curAlloc.frozen) reason.push("повышение доли пока заморожено сработавшим сигналом риска");
  if (curAlloc.pending) reason.push("следующее изменение уже накапливает подтверждение");
  if (curAlloc.quality && curAlloc.quality !== "good") reason.push(`часть входных данных неполна (${curAlloc.quality}) — к оценке стоит относиться осторожнее`);

  out.push({ tier, reason: reason.slice(0, 3) });
  return out;
}

// Ключ блока по его человеческому названию — нужен, чтобы вытащить его ряд из накопленной истории.
function nearKey(alloc, title) {
  for (const [k, b] of Object.entries(alloc.blocks || {})) if (b.title === title) return k;
  return "";
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

function significance(i) {
  const st = seriesStats(i.points);
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
    // «смешанно → смешанно» читателю ничего не говорит: внутри у панели поменялась оценка,
    // а видимое значение осталось прежним. Такие строки в сообщение не идут.
    if (fmtValue(was) === fmtValue(i)) continue;
    // ФИЛЬТРА ЗНАЧИМОСТИ ЗДЕСЬ НЕТ — И ЭТО СОЗНАТЕЛЬНО.
    // Правило владельца: всё, что публикуется по календарю (раз в несколько часов, сутки, неделю,
    // месяц, квартал), должно приходить сразу — это «результирующие» данные. Не приходят только
    // непрерывные котировки (золото, биткоин, индексы), которые смотрят в реальном времени; они
    // отсекаются раньше — признаком живого фида и пометкой quiet.
    // Прошлая версия глушила «рутинные» движения дневных рядов и за одни сутки съела SOFR−IORB,
    // HY-спред, VIX и разворот юаня — ровно то, ради чего уведомления и заводились. Шум лечится
    // ГРУППИРОВКОЙ по публикации (одно сообщение на релиз), а не молчанием о данных.
    const sig = significance(i);
    // Смена знака = переход через ноль (приток стал оттоком, сжатие — расширением).
    // Два подвоха, пойманные на живых данных:
    //   · «−0,0» даёт минус-ноль, и проверка `< 0` его не видит — направление считаем по СТАРОМУ
    //     значению, а не по новому;
    //   · переход +0,1 → −0,0 формально смена знака, но по сути топтание у нуля, поэтому обе
    //     стороны должны быть заметны на фоне обычного шага ряда.
    const bothMeaningful =
      !sig?.medianStep || Math.max(Math.abs(was.value_num ?? 0), Math.abs(i.value_num ?? 0)) >= sig.medianStep * 0.5;
    const flipped =
      finite(was.value_num) && finite(i.value_num) && bothMeaningful &&
      ((was.value_num > 0 && i.value_num <= 0) || (was.value_num < 0 && i.value_num >= 0));
    const release = releaseOf(i);
    const key = `${release}|${i.observed_at}`;
    if (!groups.has(key)) groups.set(key, { release, observed_at: i.observed_at, moves: [], plain: [], history: [] });
    const g = groups.get(key);
    g.moves.push({
      name: humanTitle(i.id, i.name),
      before: fmtValue(was),
      after: fmtValue(i),
      // Видимый маркер значимости: он и есть ответ на «насколько это существенно», не зависящий
      // от доступности модели.
      delta: flipped
        ? (was.value_num > 0 ? "смена на отрицательные значения" : "смена на положительные значения")
        : sig?.notable
          ? (sig.sinceLabel ? `сильнейшее движение с ${sig.sinceLabel}` : "заметное движение")
          : "",
    });
    // ВАЖНО: пояснение и история собираются ТОЛЬКО для строк, реально попавших в сообщение.
    // Раньше они брались у всех показателей группы, и комментарий объяснял не тот показатель,
    // чьё движение видел читатель (наблюдалось в проде дважды).
    if (humanPlain(i.id)) g.plain.push(`${humanTitle(i.id, i.name)} — ${humanPlain(i.id)}`);
    if (historyDigest(i)) g.history.push(`${humanTitle(i.id, i.name)}: ${historyDigest(i)}`);
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
      key: `alloc:${prevAlloc.pct}->${curAlloc.pct}`,
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
    // Промежуточное «наблюдение» (часть условий сошлась, подтверждения нет) НЕ рассылается:
    // оно мигает туда-обратно и в проде дало сообщения вида «подтверждений 1/3», из которых
    // читателю нечего делать. Наружу идут только срабатывание и его снятие.
    for (const { d, from, to } of detectorMoves) {
      const fired = to === "fired" || from === "fired";
      if (!fired) {
        console.log(`сигнал риска в промежуточном состоянии (в рассылку не идёт): ${detectorHuman(d.name)} ${from} → ${to}`);
        continue;
      }
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
  // Панели форматируют дробную часть по-разному (BTC-панель — точкой, макро — запятой), и в
  // соседних строках одного сообщения это выглядело неряшливо. Приводим к русской записи,
  // не трогая ничего, кроме разделителя между цифрами.
  const v = String(i.value ?? "").trim().replace(/(\d)\.(\d)/g, "$1,$2");
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
  const head = `${k.emoji} <b>${esc(ev.title)}</b>`;
  const move = ev.before || ev.after ? `${esc(ev.before || "—")} → <b>${esc(ev.after || "—")}</b>` : "";
  const moves = (ev.moves || [])
    .map((m) => `• ${esc(m.name)}: ${esc(m.before)} → <b>${esc(m.after)}</b>${m.delta ? ` <i>(${esc(m.delta)})</i>` : ""}`)
    .join("\n");
  const causes = (ev.causes || []).map((c) => `• ${esc(c)}`).join("\n");
  // Устойчивость подаётся вердиктом одним словом, а под ним — короткое объяснение обычным
  // языком. Слово всегда одно и то же для одного и того же класса: так оно становится понятным.
  const st = (ev.stability || [])[0];
  const stability =
    st && st.tier
      ? `${TIER[st.tier].mark} <b>${esc(TIER[st.tier].word)}</b>\n${(st.reason || []).map((r) => `• ${esc(r)}`).join("\n")}`
      : (ev.stability || []).map((s) => `• ${esc(s)}`).join("\n");
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

const LLM_SYSTEM = `Ты — независимый экономический аналитик. К тебе приходят свежие данные, и ты объясняешь читателю, что они означают. Читатель умный, но не финансист: он знает, что такое инфляция и ставка, но не обязан помнить устройство рынка кредитных спредов.

ЯЗЫК ОТВЕТА — ТОЛЬКО РУССКИЙ. Думать можешь как угодно, но весь текст ответа обязан быть на русском языке. Английские фразы недопустимы; общепринятые сокращения (ФРС, ВВП, ETF) — можно.

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
· Канцелярит, дисклеймеры, «важно отметить», «стоит подчеркнуть», «в заключение».
· Приказы «покупайте / продавайте» — объясняй механику и последствия.

ФОРМАТ: 2–5 предложений живого русского на событие. Термин — с короткой расшифровкой прямо в тексте при первом употреблении.

ОТВЕТ строго такой структурой, без вступлений и заголовков:
===0===
текст про событие с номером 0
===1===
текст про событие с номером 1`;

// Модель получает СОСТОЯНИЕ РЫНКА, а не состояние панели: несколько ключевых величин своими
// именами. Ни вердиктов, ни баллов, ни детекторов — иначе они протекут в текст сообщения.
function llmContext(panel) {
  const named = (panel.indicators || [])
    .filter((i) => HUMAN[i.id] && i.value)
    .slice(0, 20)
    .map((i) => `${humanTitle(i.id, i.name)}: ${fmtValue(i)}`);
  return { market_now: named };
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

// Одна попытка у одной модели. Возвращает разобранные комментарии либо null; вторым значением —
// признак того, что стоит попробовать СЛЕДУЮЩУЮ модель (перегрузка провайдера, отказ маршрута).
async function askModel(model, events, panel, key) {
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
              stability: e.stability?.[0]?.tier
                ? { verdict: TIER[e.stability[0].tier].word, why: e.stability[0].reason }
                : undefined,
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

async function llmComments(events, panel) {
  const key = process.env.OPENROUTER_KEY;
  if (!key || !events.length) return null;
  const chain = modelChain();
  // Платный предохранитель: ни одна модель без суффикса :free в сеть не уходит без явного
  // разрешения. Проверяем ВСЮ цепочку, а не только первую.
  const paid = chain.filter((m) => !m.endsWith(":free"));
  if (paid.length && !paidAllowed()) {
    console.error(`модель «${paid[0]}» платная, а NOTIFY_ALLOW_PAID не выставлен — комментарии из шаблона`);
    return null;
  }
  for (let k = 0; k < chain.length; k++) {
    const { comments, tryNext } = await askModel(chain[k], events, panel, key);
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

// Ряд решений копится САМИМ уведомлением: панели публикуют только текущее состояние, а для
// «часто ли такое откатывается» нужна собственная история. 400 наблюдений — это примерно две
// недели часового такта и месяц с лишним у макро-панели.
const TREND_MAX = 400;
// Журнал СМЕН доли живёт отдельно и дольше ряда наблюдений: смены редки (единицы в месяц), и
// подрезать их вместе с почасовыми точками — значит навсегда лишиться базы частот откатов.
const CHANGES_MAX = 200;
function appendChanges(prev, panel, prevAlloc) {
  const rows = [...(prev || [])];
  const cur = panel.allocation;
  if (cur && finite(cur.pct) && prevAlloc && finite(prevAlloc.pct) && !sameNum(prevAlloc.pct, cur.pct)) {
    rows.push({ t: Date.parse(panel.generated_at || "") || Date.now(), from: prevAlloc.pct, to: cur.pct });
  }
  return rows.slice(-CHANGES_MAX);
}
function appendTrend(prev, panel) {
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

async function main() {
  const panel = await readPanel();

  if (process.env.NOTIFY_PING === "1") {
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
      const got = await llmComments(probe, panel);
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

  const trend = appendTrend(prev.alloc_trend, panel);
  const allocChanges = appendChanges(prev.alloc_changes, panel, prev.allocation);
  let baseline = null; // сдвигается один раз в самом конце — до тех пор пишем старую базу
  const persist = async () => {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify({ ...(baseline || prev), sent: sentIndex, revised_points: revisedSeen, alloc_trend: trend, alloc_changes: allocChanges }, null, 1));
  };

  let sent = 0;
  if (events.length) {
    const capped = events.slice(0, MAX_EVENTS);
    if (events.length > MAX_EVENTS) console.log(`ПРЕДОХРАНИТЕЛЬ: событий ${events.length} > ${MAX_EVENTS}, отправляются первые ${MAX_EVENTS} по важности`);
    const llm = await llmComments(capped, panel);
    console.log(`комментарии: ${llm ? `модель (${LAST_MODEL || resolveModel()})` : "шаблон"}`);
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
        console.log(`  → отправлено: ${KIND[ev.kind]?.label || ev.kind} · ${ev.title}${ev.before || ev.after ? ` (${ev.before || "—"} → ${ev.after || "—"})` : ""} · комментарий: ${llm && llm[i] ? "модель" : "шаблон"}`);
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

export { diff, renderMessage, templateComment, fromSnapshotJSON, snapshotState, llmComments, sentKey, pruneSent, rememberRevised, appendTrend, appendChanges, significance, decisionChanges, thresholdFrom, humanRelease, releaseOf, pingMessage, HUMAN, MACRO_CADENCE };
