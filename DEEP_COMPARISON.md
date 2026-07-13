# Глубокое сравнение и финальный синтез v2.4.0

## Главный вывод

Полное удаление Coin Metrics было чрезмерной реакцией на риск отказа одного поставщика. Оно делало проект устойчивее технически, но вырезало четыре причинных слоя, ради которых вообще нужен BTC-специфический дэшборд:

1. циклическую оценку через MVRV;
2. биржевое предложение и netflow;
3. сетевую активность;
4. экономику майнеров.

Правильная архитектура — не «обязательный Coin Metrics» и не «никакого Coin Metrics», а **optional enrichment + asymmetric information gate**.

## Что лучше в присланной версии

- Coin Metrics возвращён как необязательный слой;
- MVRV нормируется по собственному четырёхлетнему распределению;
- exchange inflow/outflow/supply формируют отдельную семью предложения;
- активность адресов и транзакций используется с ограниченным весом;
- miner revenue делится на независимый hashrate mempool.space, что избегает двойного счёта;
- отсутствие MVRV не выключает панель, но запрещает конструктивный вердикт;
- сохраняется USD/USDT разделение котировок;
- live-кандидат собирается отдельно и публикуется только после проверки.

Эти решения сохранены.

## Что было лучше в устойчивой ветке без Coin Metrics

- цена, объём и market cap не зависели от Coin Metrics;
- hashrate и difficulty шли из mempool.space;
- derivatives не являлись обязательным гейтом;
- геоблокировка Bybit/OKX не уничтожала тактический режим;
- публикация требовала пригодности обоих горизонтов;
- была отдельная regression-проверка live workflow.

Эти решения также сохранены.

## Исправления поверх присланной версии

### 1. Coin Metrics запрашивает только уникальные данные

Удалены из CM-запроса дублирующие ряды:

- PriceUSD;
- CapMrktCurUSD;
- HashRate;
- reported spot volume.

Они уже поступают из независимых источников. CM теперь запрашивает только:

- CapMVRVCur;
- FlowInExNtv / FlowOutExNtv / SplyExNtv;
- IssTotUSD / FeeTotNtv;
- AdrActCnt / TxCnt / TxTfrCnt.

Это уменьшает payload, снижает риск отказа комбинированного запроса и делает роль поставщика прозрачной.

### 2. Платный host не вызывается без ключа

Без `CM_API_KEY` используется только официальный Community host. Платный `api.coinmetrics.io` больше не получает заведомо неавторизованные запросы.

### 3. Исправлена атрибуция источников

- BTC↔Nasdaq использует FRED + Coinbase market history, а не Coin Metrics;
- OI quality использует derivatives venues, а не Coin Metrics.

### 4. Явное on-chain покрытие

В snapshot добавлены:

- `scores.onchain_coverage`;
- `scores.onchain_status` (`full`, `partial`, `minimal`).

В шапке сайта отображается процент доступных уникальных on-chain семей.

### 5. Строгая публикация обоих горизонтов

Workflow теперь передаёт `REQUIRE_COMPLETE=1`. Если хотя бы один режим `insufficient`, кандидат не заменяет последний подтверждённый snapshot.

### 6. Возвращён live regression test

Тест доказывает одновременно:

- live-like snapshot проходит строгую проверку;
- negative tests после этого остаются изолированными;
- исходный production blocker не может вернуться.

### 7. Исправлена документация

Удалены устаревшие заявления о CSV archive, обязательном MVRV/carry и старой логике краткосрочного гейта.

## Финальная логика

### Независимое ядро

- FRED macro;
- Farside ETF;
- DefiLlama stablecoins;
- Coinbase price/volume + modelled supply;
- CoinGecko ATH;
- mempool.space hashrate/difficulty;
- USD/USDT spot groups;
- realized volatility.

### Уникальное on-chain enrichment

- MVRV;
- exchange supply/netflow;
- activity;
- miner economics.

### Асимметричный гейт

- отсутствие MVRV не создаёт `insufficient` само по себе;
- отсутствие MVRV запрещает `constructive` и `unconfirmed_positive`;
- `deteriorating` и `defensive` остаются достижимыми;
- наличие негативного on-chain сигнала всегда может ухудшить режим.

Это наиболее консервативная трактовка отсутствующей информации: **она не считается ни хорошей, ни достаточной для оптимизма**.
