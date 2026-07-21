import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
const y=readFileSync(new URL("../.github/workflows/snapshot.yml",import.meta.url),"utf8");
const monitorY=readFileSync(new URL("../.github/workflows/monitor.yml",import.meta.url),"utf8");
const monitorScript=readFileSync(new URL("./monitor-live.mjs",import.meta.url),"utf8");
assert.match(y,/cron:\s*"23 \* \* \* \*"/,"hourly schedule missing");
assert.match(y,/actions\/checkout@v6/);
assert.match(y,/actions\/setup-node@v6/);
assert.match(y,/actions\/cache@v5/,"internal state must use Actions cache");
assert.match(y,/path:\s*\.state\/cache\.json/,"state cache path missing");
assert.match(y,/restore-keys:[\s\S]*btc21m-state-/,"rolling state restore key missing");
assert.match(y,/node-version:\s*24/);
assert.match(y,/package-manager-cache:\s*false/,"automatic package-manager cache must stay disabled");
assert.match(y,/timeout-minutes:\s*30/,"job timeout must stay bounded (30m covers the worst-case retry budget across ~40 network calls)");
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
// The site MUST be deployed by the workflow itself. GitHub does not rebuild a "Deploy from a branch"
// Pages site for commits pushed with the GITHUB_TOKEN — the run would be green, the data would land
// in the repo, and the live page would serve a stale snapshot forever. So the workflow deploys Pages.
// Привязка к СТРУКТУРЕ, а не к упоминанию: грепом по всему файлу инвариант удовлетворяется
// комментарием, и шаг можно удалить целиком, оставив CI зелёным. Проверено мутацией: замена
// «uses: actions/deploy-pages» на закомментированную строку раньше не краснела.
assert.match(y,/^\s*uses:\s*actions\/configure-pages/m,"настройка Pages обязана быть ШАГОМ uses:, а не упоминанием в комментарии");
assert.match(y,/^\s*uses:\s*actions\/upload-pages-artifact/m,"загрузка артефакта обязана быть ШАГОМ uses:, а не упоминанием");
assert.match(y,/^\s*uses:\s*actions\/deploy-pages/m,"деплой обязан быть ШАГОМ uses:, а не упоминанием");
assert.match(y,/path:\s*docs/,"the Pages artifact must be the docs/ folder");
assert.match(y,/pages:\s*write/,"pages: write permission missing");
assert.match(y,/id-token:\s*write/,"id-token: write permission missing");
assert.match(y,/name:\s*github-pages/,"the github-pages environment is required by deploy-pages");
assert.ok(promoteAt.index<y.match(/^\s*uses:\s*actions\/upload-pages-artifact/m).index,"the artifact must be uploaded AFTER the verified candidate is promoted");
// Honest partial verdicts must publish rather than freeze the site, so the production gate is
// REQUIRE_LIVE only. REQUIRE_COMPLETE stays an opt-in capability (self-test.mjs), not a workflow gate.
assert.doesNotMatch(y,/REQUIRE_COMPLETE/,"the production publish gate must not force both regimes complete");
assert.match(monitorY,/^\s*-\s*cron:\s*"53 \*\/2 \* \* \*"\s*$/m,"independent two-hour live monitor schedule missing");
assert.match(monitorY,/^\s*workflow_dispatch:\s*$/m,"monitor must accept an external dispatch (cron-job.org backup trigger)");
assert.match(monitorY,/^\s*issues:\s*write\s*$/m,"monitor cannot open/close an external incident issue");
assert.match(monitorY,/^\s*run:\s*node scripts\/monitor-live\.mjs\s*$/m,"monitor runner missing");
assert.match(monitorY,/^\s*MONITOR_ALERT:\s*"1"\s*$/m,"GitHub issue alerting is not enabled");
assert.match(monitorY,/ml371kl\.github\.io\/temp-zero-inode-838\/snapshot\.json/,"monitor must check the published Pages artifact, not a local file");
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
  // Сторож обязан стоять ПОСЛЕ деплоя и коммита: перенесённый выше, он каждый час сравнивал бы
  // свежий кандидат со СТАРОЙ ещё-не-передеплоенной страницей и открывал/закрывал ложный инцидент.
  assert.ok(inRunMonitorAt>y.match(/^\s*uses:\s*actions\/deploy-pages/m).index,"in-run monitor must run AFTER the Pages deploy");
  assert.ok(inRunMonitorAt>y.indexOf("Сохранить снимок в репозиторий"),"in-run monitor must run AFTER the snapshot commit");
}
for(const asset of ["index.html","policy-v1.mjs","model-policy-v1.mjs","execution-policy-v1.mjs","policy-suite-v1.mjs","action-gate-v1.mjs"])assert.ok(monitorScript.includes(`"${asset}"`),`external monitor does not check ${asset}`);
console.log("Workflow static tests OK");
