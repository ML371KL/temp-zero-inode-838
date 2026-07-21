import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
const y=readFileSync(new URL("../.github/workflows/snapshot.yml",import.meta.url),"utf8");
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
assert.match(y,/OUT:\s*\.candidate\/snapshot\.json/,"live candidate must be collected into a temporary path");
assert.match(y,/REQUIRE_LIVE:\s*"1"/,"strict live verification step missing");
{
  // Шлюз обязан стоять ВНУТРИ шага верификации и смотреть на КАНДИДАТА. Иначе его можно обойти
  // вхолостую, перенацелив OUT на уже опубликованный снимок: проверка станет проверять сама себя.
  const i=y.indexOf("Проверить live-кандидата");
  assert.ok(i>0,"шаг верификации кандидата пропал из пайплайна");
  const step=y.slice(i,i+700);
  assert.match(step,/REQUIRE_LIVE:\s*"1"/,"шлюз REQUIRE_LIVE обязан жить внутри шага верификации");
  assert.match(step,/OUT:\s*\.candidate\/snapshot\.json/,"верификация обязана смотреть на КАНДИДАТА, а не на опубликованный снимок");
  assert.match(step,/npm run verify/,"шаг верификации обязан запускать verify");
}
assert.match(y,/cp \.candidate\/snapshot\.json docs\/snapshot\.json/,"verified candidate is never promoted");
// Сравнение порядка обязано опираться на СУЩЕСТВОВАНИЕ обоих шагов: при удалении шага indexOf
// возвращает -1, и проверка «раньше» становится тождественно истинной — снимок, не прошедший
// REQUIRE_LIVE, опубликовался бы на продакшен-страницу при зелёном CI.
assert.match(y,/npm run verify/,"шаг верификации пропал из пайплайна");
assert.ok(y.indexOf("cp .candidate/snapshot.json")>0,"шаг промоушена кандидата пропал из пайплайна");
assert.ok(y.indexOf("npm run verify")<y.indexOf("cp .candidate/snapshot.json"),"publication must happen after verification");
assert.doesNotMatch(y,/fetch-depth:\s*0/,"a full clone gets slower every day and is not needed for a rebase");
assert.match(y,/continue-on-error:\s*true/,"probe must never block publication");
assert.match(y,/REQUIRE_LIVE:\s*"1"/);
assert.match(y,/branch="\$\{GITHUB_REF_NAME:-main\}"/,"branch must not be hardcoded");
assert.doesNotMatch(y,/pull --rebase origin main/,"hardcoded main branch remains");
assert.match(y,/git push origin "HEAD:\$branch"/);
// Коммит снимка обязан разрешать гонку ДЕТЕРМИНИРОВАННО: ребейз снимка на разошедшийся origin
// конфликтует одинаково на каждой попытке, поэтому ретраи ребейза = три гарантированных падения.
assert.doesNotMatch(y,/git rebase/,"ребейз в шаге коммита снимка приводит к неразрешимому конфликту docs/snapshot.json");
assert.match(y,/git reset -q "origin\/\$branch"/,"пропал перенос свежего снимка поверх origin");
// `--soft` здесь — тихий откат чужой работы: он двигает только HEAD, оставляя ИНДЕКС с деревом
// старого коммита, и последующий `git commit` фиксирует это старое дерево целиком. Всё, что кто-то
// запушил, пока шёл получасовой прогон, исчезает без следа и без конфликта. Воспроизведено на
// тестовом репозитории: правка в scripts/ откатывалась до предыдущей версии.
assert.doesNotMatch(y,/git reset[^\n]*--soft/,"смешанный reset обязателен: --soft оставляет индекс со старым деревом и откатывает чужие пуши");
assert.match(y,/cp \.candidate\/snapshot\.json docs\/snapshot\.json/,"побеждать обязан снимок этого прогона, уже опубликованный на Pages");
assert.match(y,/git add docs\/snapshot\.json/,"public snapshot must be committed");
assert.doesNotMatch(y,/git add[^\n]*\.state\/cache\.json/,"raw internal state must not be committed");
assert.match(y,/"package\.json"/,"package changes must trigger workflow");
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
assert.ok(y.indexOf("cp .candidate/snapshot.json")<y.indexOf("upload-pages-artifact"),"the artifact must be uploaded AFTER the verified candidate is promoted");
// Honest partial verdicts must publish rather than freeze the site, so the production gate is
// REQUIRE_LIVE only. REQUIRE_COMPLETE stays an opt-in capability (self-test.mjs), not a workflow gate.
assert.doesNotMatch(y,/REQUIRE_COMPLETE/,"the production publish gate must not force both regimes complete");
console.log("Workflow static tests OK");
