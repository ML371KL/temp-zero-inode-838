import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
const y=readFileSync(new URL("../.github/workflows/snapshot.yml",import.meta.url),"utf8");
const monitorY=readFileSync(new URL("../.github/workflows/monitor.yml",import.meta.url),"utf8");
const monitorScript=readFileSync(new URL("./monitor-live.mjs",import.meta.url),"utf8");
const notifyY=readFileSync(new URL("../.github/workflows/notify.yml",import.meta.url),"utf8");
// Сбор данных живёт на VPS (systemd-таймер dash-838), а этот прогон выключен условием.
// Инвариант сторожит не «выключенность» саму по себе, а то, что включение не пройдёт
// незамеченным: два писателя в один docs/snapshot.json — это гонка и два разных ответа
// на вопрос «какие сейчас данные». Возврат сюда обязан быть осознанным.
assert.match(y,/^\s*if:\s*vars\.COLLECTOR\s*==\s*'github'\s*$/m,"прогон сборки обязан оставаться под условием: писатель должен быть один");
// Уведомления будит коммит снимка, а не прогон сборки, которого больше не бывает.
// Без этой проверки переезд сборщика молча выключил бы Telegram — ровно тот класс
// поломки, который не виден ни в одном красном прогоне.
assert.match(notifyY,/^\s*push:\s*$/m,"уведомления обязаны просыпаться на push");
assert.match(notifyY,/^\s*- "docs\/snapshot\.json"\s*$/m,"уведомления обязаны следить за файлом снимка");
assert.doesNotMatch(notifyY,/^\s*workflow_run:\s*$/m,"workflow_run сборки больше не наступает: этот триггер молчал бы вечно");
assert.match(y,/cron:\s*"23 \* \* \* \*"/,"hourly schedule missing");
assert.match(y,/actions\/checkout@v6/);
assert.match(y,/actions\/setup-node@v6/);
assert.match(y,/actions\/cache@v5/,"internal state must use Actions cache");
assert.match(y,/path:\s*\.state\/cache\.json/,"state cache path missing");
assert.match(y,/restore-keys:[\s\S]*btc21m-state-/,"rolling state restore key missing");
assert.match(y,/node-version:\s*24/);
assert.match(y,/package-manager-cache:\s*false/,"automatic package-manager cache must stay disabled");
assert.match(y,/^\s*timeout-minutes:\s*20\s*$/m,"job timeout must stay bounded (20m covers the worst-case retry budget across ~40 network calls; the half-hour of GitHub Pages queue it used to cover left with the queue)");
// FRED_KEY is OPTIONAL (the collector has a keyless fredgraph.csv fallback): the workflow must not
// hard-gate on it, or a keyless deployment — the project's headline promise — would fail CI.
assert.doesNotMatch(y,/::error::[^\n]*FRED_KEY/,"FRED_KEY must stay optional — no hard secret gate");
assert.match(y,/npm run fred-smoke/,"FRED smoke (optional, non-blocking) step missing");
assert.match(y,/npm run probe/,"endpoint probe step missing");
// The live candidate must never be written straight into docs/: publication happens only after
// the candidate has passed strict verification.
// ЯКОРЯ: публикационно-критичные инварианты матчатся только как РЕАЛЬНЫЕ строки (^\s* + конец строки),
// а не как подстроки. Незаякоренная регулярка удовлетворяется закомментированной строкой — мутации
// «# REQUIRE_LIVE», «# run: npm run verify», «# cp .candidate/…» держали CI зелёным (аудит 2026-07-21).
const CANDIDATE_OUT_LINE=/^\s*OUT:\s*\.candidate\/snapshot\.json\s*$/m;
const REQUIRE_LIVE_LINE=/^\s*REQUIRE_LIVE:\s*"1"\s*$/m;
const VERIFY_RUN_LINE=/^\s*run:\s*npm run verify\s*$/m;
const PROMOTE_LINE=/^\s*cp \.candidate\/snapshot\.json docs\/snapshot\.json\s*$/m;
assert.match(y,CANDIDATE_OUT_LINE,"live candidate must be collected into a temporary path");
assert.match(y,REQUIRE_LIVE_LINE,"strict live verification step missing");
{
  // Шлюз обязан стоять ВНУТРИ шага верификации и смотреть на КАНДИДАТА. Иначе его можно обойти
  // вхолостую, перенацелив OUT на уже опубликованный снимок: проверка станет проверять сама себя.
  const i=y.indexOf("Проверить live-кандидата");
  assert.ok(i>0,"шаг верификации кандидата пропал из пайплайна");
  const step=y.slice(i,i+700);
  assert.match(step,REQUIRE_LIVE_LINE,"шлюз REQUIRE_LIVE обязан жить внутри шага верификации");
  assert.match(step,CANDIDATE_OUT_LINE,"верификация обязана смотреть на КАНДИДАТА, а не на опубликованный снимок");
  assert.match(step,VERIFY_RUN_LINE,"шаг верификации обязан запускать verify");
}
assert.match(y,PROMOTE_LINE,"verified candidate is never promoted");
// Сравнение порядка обязано опираться на ЗАЯКОРЕННЫЕ совпадения (match.index), а не на indexOf по
// тексту: indexOf находит и комментарий, а при удалении шага возвращает -1 и «раньше» становится
// тождественно истинным — снимок, не прошедший REQUIRE_LIVE, опубликовался бы при зелёном CI.
const verifyRunAt=y.match(VERIFY_RUN_LINE),promoteAt=y.match(PROMOTE_LINE);
assert.ok(verifyRunAt,"шаг верификации пропал из пайплайна");
assert.ok(promoteAt,"шаг промоушена кандидата пропал из пайплайна");
assert.ok(verifyRunAt.index<promoteAt.index,"publication must happen after verification");
assert.doesNotMatch(y,/fetch-depth:\s*0/,"a full clone gets slower every day and is not needed for a rebase");
assert.match(y,/continue-on-error:\s*true/,"probe must never block publication");
assert.match(y,/^\s*branch="\$\{GITHUB_REF_NAME:-main\}"\s*$/m,"branch must not be hardcoded");
assert.doesNotMatch(y,/pull --rebase origin main/,"hardcoded main branch remains");
assert.match(y,/^\s*if git push origin "HEAD:\$branch"; then/m,"snapshot push line missing");
// Коммит снимка обязан разрешать гонку ДЕТЕРМИНИРОВАННО: ребейз снимка на разошедшийся origin
// конфликтует одинаково на каждой попытке, поэтому ретраи ребейза = три гарантированных падения.
assert.doesNotMatch(y,/git rebase/,"ребейз в шаге коммита снимка приводит к неразрешимому конфликту docs/snapshot.json");
assert.match(y,/^\s*git reset -q "origin\/\$branch"/m,"пропал перенос свежего снимка поверх origin");
// `--soft` здесь — тихий откат чужой работы: он двигает только HEAD, оставляя ИНДЕКС с деревом
// старого коммита, и последующий `git commit` фиксирует это старое дерево целиком. Всё, что кто-то
// запушил, пока шёл получасовой прогон, исчезает без следа и без конфликта. Воспроизведено на
// тестовом репозитории: правка в scripts/ откатывалась до предыдущей версии.
assert.doesNotMatch(y,/git reset[^\n]*--soft/,"смешанный reset обязателен: --soft оставляет индекс со старым деревом и откатывает чужие пуши");
assert.ok([...y.matchAll(new RegExp(PROMOTE_LINE.source,"gm"))].length>=2,"побеждать обязан снимок этого прогона (промоушен и в шаге коммита), уже опубликованный на Pages");
assert.match(y,/^\s*git add docs\/snapshot\.json\s*$/m,"public snapshot must be committed");
assert.doesNotMatch(y,/git add[^\n]*\.state\/cache\.json/,"raw internal state must not be committed");
assert.match(y,/"package\.json"/,"package changes must trigger workflow");
assert.match(y,/"docs\/\*\*"/,"every deployed policy/frontend file under docs must trigger the workflow");
const gitignore=readFileSync(new URL("../.gitignore",import.meta.url),"utf8");
assert.match(gitignore,/^\.state\/cache\.json$/m,"internal cache must be ignored by git");
const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
assert.match(pkg.scripts?.["fred-smoke"]||"",/fred-smoke-test\.mjs/,"FRED smoke command missing");
assert.match(pkg.scripts?.probe||"",/probe\.mjs/,"probe command missing");
assert.match(pkg.scripts?.["live-regression"]||"",/live-regression-test\.mjs/,"live regression command missing");
assert.ok(existsSync(new URL("./probe.mjs",import.meta.url)),"probe script missing");
assert.ok(existsSync(new URL("./fred-smoke-test.mjs",import.meta.url)),"FRED smoke script missing");
const probe=readFileSync(new URL("./probe.mjs",import.meta.url),"utf8");
assert.match(probe,/The Block ETF API/,"primary ETF endpoint missing from runner probe");
assert.match(probe,/tbstat ETF mirror/,"ETF mirror missing from runner probe");
assert.match(probe,/Bitstamp daily OHLC/,"Bitstamp history fallback missing from runner probe");
// Разведка SosoValue: ключ живёт ТОЛЬКО в диагностике и никогда не печатается.
assert.match(probe,/SosoValue ETF current/,"разведочная проверка SosoValue пропала из probe");
assert.match(probe,/SOSO_API_KEY/,"probe должен читать ключ SosoValue из окружения");
assert.doesNotMatch(probe,/SOSO-[A-Za-z0-9]{8}/,"ключ SosoValue не должен быть зашит в код");
assert.match(y,/SOSO_API_KEY: \$\{\{ secrets\.SOSO_API_KEY \}\}/,"секрет SosoValue не проброшен в шаг диагностики");
// Ключ SosoValue пробрасывается в сборку (слой принят), но обязан оставаться НЕОБЯЗАТЕЛЬНЫМ:
// хардгейта на секрет быть не должно — панель работает и без ключей.
assert.doesNotMatch(y,/::error::[^\n]*SOSO/,"SOSO_API_KEY обязан оставаться необязательным");
{
  const collectStep=y.slice(y.indexOf("Собрать live-кандидата"),y.indexOf("Проверить live-кандидата"));
  assert.match(collectStep,/SOSO_API_KEY/,"дополняющий слой должен получать ключ, если он задан");
}
const html=readFileSync(new URL("../docs/index.html",import.meta.url),"utf8");
assert.match(html,/id="uiVersion"/,"dynamic UI version element missing");
assert.match(html,/SNAP\.version/,"UI version is not tied to snapshot version");
// No literal version may be baked into the markup: it silently desynchronises from package.json.
const baked=[...html.matchAll(/v\d+\.\d+\.\d+/g)].map(x=>x[0]);
assert.deepEqual(baked,[],`hardcoded version in markup: ${baked.join(", ")}`);
assert.match(html,/value="anthropic\/claude-fable-5"/,"default OpenRouter model must be an explicit valid slug");
// The AI answer must stream: a fixed-timeout non-streaming request dies on reasoning models.
assert.match(html,/"stream":?\s*true|stream:\s*true/,"OpenRouter request must use streaming");
assert.match(html,/id="aiRemember"/,"opt-in remember-on-device checkbox missing");
assert.match(html,/"X-OpenRouter-Title"/,"OpenRouter attribution should use the current X-OpenRouter-Title header");
// ДАННЫЕ ПУБЛИКУЮТСЯ В R2, а сайт — отдельным прогоном в Cloudflare Pages. Прежний
// инвариант требовал здесь шагов GitHub Pages; он ушёл вместе с ними 6 августа, когда
// очередь Pages встала и остановила вместе с публикацией ещё и сбор данных. Те же
// правила привязки остаются в силе: только ЗАЯКОРЕННЫЕ строки, потому что незаякоренная
// регулярка удовлетворяется комментарием, и шаг можно вырезать, оставив CI зелёным.
const R2_PUT_LINE=/^\s*"\$\{endpoint\}\/dash-838\/snapshot\.json"\)?\s*$/m;
assert.match(y,/^\s*--aws-sigv4 "aws:amz:auto:s3"\s*\\?\s*$/m,"публикация в R2 обязана быть подписанным запросом, а не упоминанием");
assert.match(y,R2_PUT_LINE,"публикация обязана идти в бакет dash-838 по ключу snapshot.json");
assert.match(y,/^\s*--data-binary @docs\/snapshot\.json \\\s*$/m,"в R2 обязан уезжать именно принятый снимок, а не кандидат");
assert.match(y,/^\s*if ! cmp -s docs\/snapshot\.json \/tmp\/r2-readback\.json; then\s*$/m,"опубликованное обязано считываться обратно и сверяться побайтово");
// GitHub Pages не должен вернуться незамеченным: два публикатора на один и тот же файл —
// это два разных ответа на вопрос «какие сейчас данные», и какой из них увидит владелец,
// зависело бы от того, чья очередь оказалась быстрее.
assert.doesNotMatch(y,/^\s*uses:\s*actions\/(configure-pages|upload-pages-artifact|deploy-pages)/m,"GitHub Pages больше не публикует эту панель — данные идут в R2, сайт в Cloudflare");
assert.doesNotMatch(y,/^\s*pages:\s*write\s*$/m,"право на публикацию GitHub Pages этому прогону больше не нужно");
assert.doesNotMatch(y,/^\s*id-token:\s*write\s*$/m,"id-token нужен был только actions/deploy-pages");
{
  const r2At=y.indexOf("Опубликовать снимок в R2");
  assert.ok(r2At>0,"шаг публикации в R2 отсутствует");
  assert.ok(promoteAt.index<r2At,"в R2 уезжает только проверенный и принятый кандидат");
  // Порядок 6 августа: коммит ДО внешней публикации. Пока он стоял после, отказ Pages
  // уносил вместе с собой и данные — снимок замер на шесть часов при живом сборщике.
  assert.ok(y.indexOf("Сохранить снимок в репозиторий")<r2At,"коммит обязан идти ДО внешней публикации: её отказ не должен уносить данные");
}
// Сайт публикуется отдельно и только по изменению кода — иначе бесплатный потолок
// Cloudflare Pages в 500 сборок в месяц выбирается за трое суток одними данными.
{
  const siteY=readFileSync(new URL("../.github/workflows/site.yml",import.meta.url),"utf8");
  assert.match(siteY,/^\s*- "!docs\/snapshot\.json"\s*$/m,"обновление снимка не должно публиковать сайт");
  assert.match(siteY,/^\s*rm -f site\/snapshot\.json\s*$/m,"снимок обязан быть исключён из публикации: статический файл спорил бы с функцией за один путь");
  assert.match(siteY,/^\s*npx --yes wrangler@\d+\.\d+\.\d+ pages deploy site \\\s*$/m,"версия wrangler обязана быть зафиксирована точечно");
  assert.match(siteY,/--project-name tzi-838/,"проект публикации задан неверно");
  const fn=readFileSync(new URL("../functions/snapshot.json.js",import.meta.url),"utf8");
  assert.match(fn,/env\.DATA\.get\("snapshot\.json"/,"функция обязана читать снимок из привязанного бакета");
}
// Honest partial verdicts must publish rather than freeze the site, so the production gate is
// REQUIRE_LIVE only. REQUIRE_COMPLETE stays an opt-in capability (self-test.mjs), not a workflow gate.
assert.doesNotMatch(y,/REQUIRE_COMPLETE/,"the production publish gate must not force both regimes complete");
assert.match(monitorY,/^\s*-\s*cron:\s*"53 \*\/2 \* \* \*"\s*$/m,"independent two-hour live monitor schedule missing");
assert.match(monitorY,/^\s*workflow_dispatch:\s*$/m,"monitor must accept an external dispatch (cron-job.org backup trigger)");
assert.match(monitorY,/^\s*issues:\s*write\s*$/m,"monitor cannot open/close an external incident issue");
assert.match(monitorY,/^\s*run:\s*node scripts\/monitor-live\.mjs\s*$/m,"monitor runner missing");
assert.match(monitorY,/^\s*MONITOR_ALERT:\s*"1"\s*$/m,"GitHub issue alerting is not enabled");
assert.match(monitorY,/tzi-838\.pages\.dev\/snapshot\.json/,"monitor must check the published artifact over the network, not a local file");
// Сторож продублирован ВНУТРИ ежечасного прогона: GitHub-планировщик отдаёт монитору 2–6 тиков из
// ожидаемых, и единственный реальный инцидент (протухание >3ч ночью 21.07) пришёлся на несработавший
// тик. Встроенный шаг не блокирует публикацию, но синхронизирует инцидент каждым прогоном.
assert.match(y,/^\s*run:\s*node scripts\/monitor-live\.mjs\s*$/m,"in-run live monitor step missing from snapshot workflow");
assert.match(y,/^\s*issues:\s*write\s*(#.*)?$/m,"snapshot workflow needs issues:write for the in-run monitor");
{
  const inRunMonitorAt=y.indexOf("Проверить живой контур");
  assert.ok(inRunMonitorAt>0,"in-run monitor step missing");
  const inRunMonitor=y.slice(inRunMonitorAt,inRunMonitorAt+600);
  assert.match(inRunMonitor,/continue-on-error:\s*true/,"in-run monitor must never block publication");
  assert.match(inRunMonitor,/^\s*MONITOR_ALERT:\s*"1"\s*$/m,"in-run monitor must sync the incident issue");
  // Сторож обязан стоять ПОСЛЕ публикации и коммита: перенесённый выше, он каждый час сравнивал бы
  // свежий кандидат со СТАРЫМ ещё-не-переписанным объектом и открывал/закрывал ложный инцидент.
  assert.ok(inRunMonitorAt>y.indexOf("Опубликовать снимок в R2"),"in-run monitor must run AFTER the R2 publish");
  assert.ok(inRunMonitorAt>y.indexOf("Сохранить снимок в репозиторий"),"in-run monitor must run AFTER the snapshot commit");
}
for(const asset of ["index.html","policy-v1.mjs","model-policy-v1.mjs","execution-policy-v1.mjs","policy-suite-v1.mjs","action-gate-v1.mjs","policy-v2-candidate.mjs"])assert.ok(monitorScript.includes(`"${asset}"`),`external monitor does not check ${asset}`);
console.log("Workflow static tests OK");
