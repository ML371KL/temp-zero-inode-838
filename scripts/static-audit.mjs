import { readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { POLICY_V1 } from "../docs/policy-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { compactHistoryEntryV1, HISTORY_MAX_ROWS, jsonBytesV1, projectedPublicSnapshotBytesV1, PUBLIC_SNAPSHOT_MAX_BYTES } from "./public-snapshot-contract.mjs";

const root=new URL("../",import.meta.url);
const html=readFileSync(new URL("../docs/index.html",import.meta.url),"utf8");
const collector=readFileSync(new URL("./fetch-snapshot.mjs",import.meta.url),"utf8");
const workflow=readFileSync(new URL("../.github/workflows/snapshot.yml",import.meta.url),"utf8");
const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
const snap=JSON.parse(readFileSync(new URL("../docs/snapshot.json",import.meta.url),"utf8"));
const readme=readFileSync(new URL("../README.md",import.meta.url),"utf8");

// DOM integrity: unique IDs and every $("id") lookup has a target.
const ids=[...html.matchAll(/\bid=["']([^"']+)["']/g)].map(x=>x[1]);
const duplicates=ids.filter((x,i)=>ids.indexOf(x)!==i);
assert.deepEqual([...new Set(duplicates)],[],`duplicate DOM ids: ${duplicates.join(", ")}`);
const lookups=[...html.matchAll(/\$\(["']([^"']+)["']\)/g)].map(x=>x[1]);
const missing=[...new Set(lookups.filter(x=>!ids.includes(x)))];
assert.deepEqual(missing,[],`missing DOM targets: ${missing.join(", ")}`);

// Static single-file frontend: no supply-chain dependency or mixed content.
assert.doesNotMatch(html,/<script[^>]+src=/i,"external script dependency found");
assert.doesNotMatch(html,/<link[^>]+rel=["']stylesheet/i,"external stylesheet dependency found");
assert.doesNotMatch(html,/\b(?:src|href)=["']http:\/\//i,"mixed-content link found");
assert.match(html,/Content-Security-Policy/i,"CSP missing");
assert.match(html,/<meta[^>]+name=["']referrer["'][^>]+content=["'](?:no-referrer|strict-origin-when-cross-origin)["']/i,"referrer policy missing");
assert.match(html,/rel=["'][^"']*noopener/i,"noopener missing from generated external links");

// Check embedded JavaScript syntax independently of the browser.
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]);
assert.ok(scripts.length>=1,"inline application script missing");
const temp=join(tmpdir(),`btc21m-frontend-${process.pid}.mjs`);
try{
  writeFileSync(temp,scripts.join("\n"));
  const syntax=spawnSync(process.execPath,["--check",temp],{encoding:"utf8"});
  assert.equal(syntax.status,0,`frontend JS syntax error:\n${syntax.stderr}`);
} finally {try{unlinkSync(temp)}catch{}}

// Public payload and source metadata.
assert.equal(snap.version,pkg.version,"snapshot/package version mismatch");
assert.match(readme,new RegExp(`v${pkg.version.replaceAll(".","\\.")}`),"README version mismatch");
assert.equal("datasets" in snap,false,"raw datasets leaked into public snapshot");
const publicSnapshotBytes=statSync(new URL("../docs/snapshot.json",import.meta.url)).size;
assert.ok(publicSnapshotBytes<PUBLIC_SNAPSHOT_MAX_BYTES,"public snapshot too large");
if(snap.monitoring?.daily?.length&&snap.monitoring?.decision_log?.length&&snap.history?.length){
  const cfg=MODEL_POLICY_V1.forward_monitoring;
  const compactedHistory=snap.history.map(compactHistoryEntryV1);
  const compactedSnapshotBytes=publicSnapshotBytes-jsonBytesV1(snap.history)+jsonBytesV1(compactedHistory);
  const projected=projectedPublicSnapshotBytesV1({
    snapshotBytes:compactedSnapshotBytes,
    snapshot:{...snap,history:compactedHistory},
    dailyLimit:cfg.daily_history_days,
    decisionLogLimit:cfg.observation_log_limit,
    historyMaxRows:HISTORY_MAX_ROWS,
  });
  assert.ok(projected<PUBLIC_SNAPSHOT_MAX_BYTES,`retention policy would eventually grow the public snapshot to ${(projected/1e6).toFixed(2)} MB`);
}
for(const m of snap.metrics||[])for(const u of m.source_urls||[])assert.equal(new URL(u).protocol,"https:",`non-HTTPS metric URL ${m.id}`);
for(const [key,state] of Object.entries(snap.sources||{}))for(const u of state.urls||[])assert.equal(new URL(u).protocol,"https:",`non-HTTPS source URL ${key}`);

// Forward-monitor graft pack: if present, it must be intact — a corrupted pack silently disables
// the P0 chain restoration (fetch-snapshot loads it inside try/catch). Absence is legitimate ONLY
// after a deliberate future monitor genesis (delete the pack in the same commit — see README).
{
  const packUrl=new URL("../docs/monitor-graft-v1.json",import.meta.url);
  const {existsSync}=await import("node:fs");
  if(existsSync(packUrl)){
    const pack=JSON.parse(readFileSync(packUrl,"utf8"));
    assert.ok(pack?.archive?.monitor?.decision_log?.length>0,"graft pack: archive chain missing");
    assert.ok(pack?.era?.started_at&&pack?.era?.strategies,"graft pack: era boot record missing");
    const {verifyDecisionLogChainV1}=await import("./forward-monitor-v1.mjs");
    assert.equal(verifyDecisionLogChainV1(pack.archive.monitor.decision_log).ok,true,"graft pack: archive hash chain invalid");
  }
}
// Governance contract must ship with the repo (РАЗВЁРТЫВАНИЕ.md lists it as required).
assert.ok((await import("node:fs")).existsSync(new URL("../POLICY.md",import.meta.url)),"POLICY.md missing");

// Workflow/state separation and operational invariants.
assert.match(workflow,/actions\/cache@v5/,"Actions cache missing");
assert.match(workflow,/path:\s*\.state\/cache\.json/,"internal state cache path missing");
assert.doesNotMatch(workflow,/git add[^\n]*\.state\/cache\.json/,"raw state is committed");
assert.match(workflow,/^\s*REQUIRE_LIVE:\s*["']1["']\s*$/m,"strict live validation missing (anchored: a commented-out gate must not satisfy this)");

// Secret scan: common token shapes and accidental literal FRED secret assignment.
const files={html,collector,workflow,readme};
const secretPatterns=[
  /sk-or-v1-[A-Za-z0-9_-]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /FRED_KEY\s*=\s*["'][^"']{8,}["']/,
];
for(const [name,text] of Object.entries(files))for(const re of secretPatterns)assert.doesNotMatch(text,re,`possible secret in ${name}`);

// Every production endpoint host has a corresponding official documentation link.
const requiredDocs=[
  "fred.stlouisfed.org","farside.co.uk","defillama.com","docs.coinmetrics.io",
  "publicreporting.cftc.gov","docs.deribit.com","bybit-exchange.github.io",
  "okx.com","docs.cdp.coinbase.com","docs.kraken.com",
  "docs.coingecko.com","mempool.space","bitstamp.net","blockchain.com","blockstream","gemini.com",
  "theblock.co","bitview.space","hyperliquid","fiscaldata.treasury.gov"
];
for(const host of requiredDocs)assert.ok(collector.includes(host),`documentation/source host missing: ${host}`);


const pageWarnings=[];
// Strategy strip displays the signed server decision and never recomputes allocation in the browser.
assert.equal(POLICY_V1.id,"btc-allocation-policy-v1");
assert.match(html,/import \{ POLICY_V1, applyStrategicDetectorPolicyV1 \} from "\.\/policy-v1\.mjs"/,"frontend policy-v1 metadata import missing");
assert.match(html,/import \{ EXECUTION_POLICY_V1 \} from "\.\/execution-policy-v1\.mjs"/,"frontend execution-policy-v1 import missing");
assert.match(html,/import \{ evaluateActionGateV1 \} from "\.\/action-gate-v1\.mjs"/,"frontend fail-closed action gate import missing");
// Боевой набор v3: страница берёт из его контракта только числа правил (ступени пола, час фикса, пороги «дёшево»).
// Ни одна функция движка в браузер не импортируется: режим, пол и цель считает сервер.
assert.match(html,/import \{ POLICY_SUITE_V3 \} from "\.\/policy-suite-v3\.mjs"/,"страница обязана знать боевой набор правил v3");
assert.match(html,/import \{ POLICY_V3_CANDIDATE \} from "\.\/policy-v3-candidate\.mjs"/,"числа правил v3 обязаны приходить из контракта движка, а не из литералов");
assert.doesNotMatch(html,/allocationTargetV1|allocationDecisionV1|allocationDecisionV3|dailyHysteresisStepV3|fixClockV3|evaluateV3Inputs|evaluateShadowVariantsV1|scoreValuationV3|buildLiveDecisionV3/,"frontend must not calculate allocation");
assert.match(html,/const target=Number\.isFinite\(D\.target_pct\)/,"strategy strip must display the server target");
assert.match(html,/evaluateActionGateV1\(/,"strategy strip must use the shared fail-closed action gate");
assert.match(html,/decision:SNAP\.decision/,"strategy strip must gate the signed server decision");
assert.match(html,/operationalStatus:SNAP\.monitoring\?\.health\?\.operational_status/,"strategy strip must fail closed when operational health is not healthy");
assert.match(html,/executionPolicySentence\(SNAP\.monitoring\?\.assumptions\?\.tranched_execution\)/,"execution guidance must be rendered from the execution contract");
assert.match(html,/E\.off_cycle_rebalance_drift_pp/,"execution drift threshold must come from the execution contract");
assert.doesNotMatch(html,/больше чем на 15 п\.п\./,"execution drift threshold is duplicated as a UI literal");
assert.match(collector,/applyStrategicDetectorPolicyV1\(/,"snapshot engine must delegate detector overlays to policy-v1");
assert.match(collector,/buildDecisionRecordV1\(/,"snapshot engine must create a server decision record");
const strategyStart=html.indexOf("function renderStrategy"),strategyEnd=html.indexOf("function renderWhy",strategyStart),strategyBody=html.slice(strategyStart,strategyEnd);
const policyStatusStart=html.indexOf("function renderPolicyStatus"),policyStatusEnd=html.indexOf("function renderMonitoring",policyStatusStart),policyStatusBody=html.slice(policyStatusStart,policyStatusEnd);
assert.ok(strategyStart>0&&strategyEnd>strategyStart&&policyStatusStart>0&&policyStatusEnd>policyStatusStart,"frontend render functions moved: the slices below would check the wrong text");
assert.doesNotMatch(strategyBody,/качество .*решение|историческая перекалибровка|ступень политики, а не вероятность/i,"service metadata must not clutter the action strip");
assert.match(policyStatusBody,/Историческая перекалибровка отключена/,"frozen policy explanation missing from the methodology panel");
assert.match(policyStatusBody,/отдельной версией policy/,"methodology must explain how a future policy change is versioned");
assert.match(policyStatusBody,/решение \$\{esc\(hash\)\}/,"decision audit hash must remain available in the methodology panel");
assert.match(policyStatusBody,/пересмотры старых точек временного ряда сохраняются в журнале аудита/,"methodology must distinguish current data quality from historical revision evidence");
assert.match(html,/operational_pause\.snapshot_stale_hours/,"contractual snapshot age gate missing from the strip");
assert.match(policyStatusBody,/ступень модельной аллокации, а не вероятность/,"confidence/evidence boundary missing from the methodology panel");
assert.match(policyStatusBody,/лимита B: вашего собственного потолка позиции/,"единица главного числа («лимит B») обязана быть определена в панели методики");
// Единица главного числа стоит в подписи и при цели, и при паузе (аудит 2.15: при оверлее подпись пропадала).
assert.ok(strategyBody.includes("const unit=`<div class=\"eyebrow\">Цель · доля лимита B</div>`")&&strategyBody.split("${unit}").length-1>=2,"подпись «доля лимита B» обязана стоять у числа во всех состояниях полосы");
assert.match(html,/форвард-наблюдение/,"forward evidence panel missing");
// Указание владельца: на витрине нет оговорок и дисклеймеров — они живут в документах.
assert.doesNotMatch(html,/не персональная рекомендация|Дисклеймер/i,"дисклеймер вернулся на витрину");
// mdRender must escape BEFORE inline markdown substitution (XSS ordering).
const mdIdx=html.indexOf("function mdRender");assert.ok(mdIdx>0,"mdRender missing");
const mdBody=html.slice(mdIdx,html.indexOf("function",mdIdx+10));
assert.ok(mdBody.indexOf("esc(")>=0&&mdBody.indexOf("esc(")<mdBody.indexOf("<b>"),"mdRender must escape before markdown substitution");
// Вкладка обязана ПЕРЕЧИТЫВАТЬ снимок по таймеру и при возврате на неё, а не перерисовывать загруженный однажды
// (аудит 10.10.2026, 2.5: один запрос за 200 минут, три часа старая цель подавалась как текущая).
assert.match(html,/setInterval\(refresh,POLL_MS\)/,"периодическая перезагрузка снимка пропала");
assert.match(html,/addEventListener\("visibilitychange",\(\)=>\{if\(document\.visibilityState==="visible"\)refresh\(\)\}\)/,"перезагрузка снимка при возврате на вкладку пропала");
assert.doesNotMatch(html,/setInterval\(\(\)=>\{if\(SNAP\)render\(\)\}/,"интервал снова перерисовывает старый снимок вместо загрузки");
// Тексты, которые расходились с расчётом (аудит 10.10.2026, 2.1–2.16), не возвращаются.
for(const [re,why] of [
  [/Сокращать риск\. Докупки — стоп|Держать почти полную\. Без агрессивных докупок/,"фраза-действие снова привязана к названию режима"],
  [/капитуляция позади|восстановление подтверждено/i,"формулировка пола сильнее расчёта"],
  [/(?:—|:) аварийный override/,"нижний триггер назван жаргоном вместо условия"],
  [/~2 часа|примерно раз в час/,"такт снова зашит в текст числом"],
  [/Math\.random/,"лента снова рисует случайный шум при пустой истории"],
  [/fallback’ы для MVRV/,"резерв MVRV назван неверно"],
  [/Три детектора влияют/,"число детекторов с правом голоса названо неверно"],
  [/Таблица вкладов всех индикаторов/,"панель индикаторов снова названа таблицей вкладов без вкладов"],
  [/реальных forward-срабатываний/,"витрина снова обещает выборку по потолку эйфории"],
  [/id="(?:strategicNeedle|tacticalNeedle|shortBehavior|mediumBehavior|phase)"/,"вернулась стрелка среднего балла, блок «Как вести себя» или строка фазы"],
  // Выпуск 2.15.0: боевое решение принимает набор v3. Правил, которых в нём нет, витрина не утверждает.
  [/euphoria_cap_pct|euphoria_min_mvrv_percentile|euphoria_safety_cap|[Пп]отолок эйфории|[Пп]олы и потолок|полы\/потолок/,"потолка эйфории в боевых правилах нет: витрина не имеет права его называть"],
  [/[Мм]акрошок и дистрибуция|дистрибуция (?:не да[её]т|ограничива)|distributionState:det\(/,"у «Дистрибуции» нет права на режим и цель"],
  [/ЗАМОРОЖЕННОЙ policy v1|живое решение задаёт v1|<b>Policy v1<\/b>|status:"frozen 2026-07-19/,"боевой политикой снова названа v1"],
])assert.doesNotMatch(html,re,why);

// ПОВЕДЕНИЕ ВИТРИНЫ. Блок VIEW страницы — чистые функции «снимок → что показать»; он исполняется здесь в Node.
// Проверяется смысл на экране, а не текст исходника: фраза-действие, триггеры, полосы, пауза, перезагрузка.
{
  const viewSrc=/\/\* VIEW:START[\s\S]*?\/\* VIEW:END \*\//.exec(html)?.[0];
  assert.ok(viewSrc,"блок VIEW не найден");
  assert.doesNotMatch(viewSrc,/\bdocument\b|\bwindow\b|\$\(|Date\.now\(|localStorage|\bSNAP\b/,"блок VIEW обязан оставаться чистым: DOM, часы и состояние страницы — снаружи");
  const {pathToFileURL}=await import("node:url");
  const {allocationDecisionV1}=await import("../docs/policy-v1.mjs");
  // Фикстуры набора v3 собираются теми же функциями, что и боевой снимок: портами движка и сборкой записи решения.
  // Форма фикстуры не может разойтись с формой сборщика, а её решение проверяется правилом набора.
  const E3=await import("../docs/policy-v3-candidate.mjs"),L3=await import("./live-decision-v3.mjs");
  const u=name=>JSON.stringify(new URL(`../docs/${name}`,import.meta.url).href);
  // Импорты харнеса — те же строки, что стоят в самой странице: новый импорт страницы не роняет все проверки
  // VIEW с ReferenceError. Модули — только соседние файлы docs/.
  const pageImports=[...scripts.join("\n").matchAll(/^import (\{[^}]+\}) from "\.\/([\w.-]+\.mjs)";$/gm)];
  assert.ok(pageImports.length>=5,"импорты страницы не разобраны");
  assert.equal([...scripts.join("\n").matchAll(/^import\b/gm)].length,pageImports.length,"у страницы появился импорт не из соседнего модуля docs/");
  const viewFile=join(tmpdir(),`btc21m-view-${process.pid}.mjs`);
  let V;
  try{
    writeFileSync(viewFile,`${pageImports.map(m=>`import ${m[1]} from ${u(m[2])};`).join("\n")}\n${viewSrc}\nexport default VIEW;\n`);
    V=(await import(pathToFileURL(viewFile).href)).default;
  }finally{try{unlinkSync(viewFile)}catch{}}
  const HOUR=3600e3,DAY=24*HOUR,NB=String.fromCharCode(160),plain=s=>String(s).replaceAll(NB," ");
  const lines=a=>a.map(x=>plain(x.text??x));

  // 1. Закоммиченный снимок — какой бы формы он ни был (старой, новой, на паузе). Проверка НЕ фатальна:
  //    `npm run check` на сервере стоит перед сбором, и отображение не имеет права останавливать конвейер данных
  //    из-за формы одного снимка. Отказ печатается; сами функции проверяются ниже на синтетических состояниях.
  {
    const now=Date.parse(snap.generated_at)+5*60e3,gate={actionable:false,code:"snapshot_stale",age_hours:5},run=(name,fn)=>{try{fn()}catch(e){pageWarnings.push(`${name}: ${e.message}`)}};
    for(const f of ["changeLog","blockRows","whyOf","tactRows","dataNotes","warnMap","holdOf","overlayLines","monitorModel","levelsText","resultText","tactOf","detView","alarmCount","policyFacts","methodParts","aiPolicy"])run(f,()=>V[f](snap));
    for(const f of ["leadOf","triggersOf"])run(f,()=>V[f](snap,now));
    for(const code of ["snapshot_stale","time_invalid","snapshot_in_future","decision_missing","decision_not_actionable","decision_quality_not_actionable","operational_status_not_healthy"])run(`pauseOf:${code}`,()=>assert.ok(V.pauseOf(snap,{...gate,code},{okAt:now},now,3).lead));
    for(const m of snap.metrics||[])run(`карточка ${m.id}`,()=>{V.cardFace(m);V.badge(m.score)});
    // Копия дерева гейтов обязана воспроизводить кандидата сервера на живом снимке — иначе подсказки называют только ступени.
    // Кандидат сервера у набора v3 — то, что правило читает на этом прогоне (live_inputs), у прежнего — regime_meta.
    run("правило полос не воспроизвело кандидата сервера",()=>{const cand=V.whyOf(snap).cand;if(["defensive","deteriorating","transition","unconfirmed_positive","constructive"].includes(cand)&&!snap.mock)assert.equal(V.whyOf(snap).ok,true)});
  }

  // 2. Синтетические состояния. Время — параметр, а не часы машины; набор прогоняется на семи днях недели подряд.
  const FAM={macro:{liquidity:"liquidity_regime",conditions:"financial_conditions",stress:"system_stress"},demand:{etf:"etf_regime",stablecoins:"stablecoin_regime",exchange_supply:"exchange_supply",institutional:"institutional_quality"},cycle:{valuation:"mvrv_cycle",network:"network_security",activity:"network_activity",miners:"miner_regime",trend:"trend_regime"}};
  // mk — снимок ПРЕЖНЕЙ формы: решение набора v1 (policy_id названо в записи). Такой снимок лежит в репозитории и
  // на витрине до первого сбора новым кодом; страница показывает его по правилам v1. Снимок набора v3 — mk3, ниже.
  // По умолчанию — состояние 10.10.2026: Макро −41,7 (неблагоприятен), Спрос −6,3, Цикл +25 → «переходный», 45 %.
  const SUITE_V1="btc-decision-suite-v1";
  function mk({now,scores={},mvrv=42,strategic="transition",candidate=strategic,tactical="balanced",recovery="calm",shock="calm",events=[],hold=null,extra={}}){
    const sc={liquidity_regime:0,financial_conditions:-2,system_stress:-0.5,etf_regime:-0.5,stablecoin_regime:0,exchange_supply:0,institutional_quality:0,us_spot_premium:0,mvrv_cycle:mvrv>=95?-2:mvrv>=82?-1:mvrv<=10?1:0,network_security:0,network_activity:0.5,miner_regime:0,trend_regime:2,...scores};
    const metrics=Object.entries(FAM).flatMap(([block,f])=>Object.entries(f).map(([family,id])=>({id,block,family,name:`«${id}»`,vote:true,strategic:true,tactical:id!=="mvrv_cycle",score:sc[id],value_num:id==="mvrv_cycle"?mvrv:sc[id],value:"слово движка",delta:"числа движка",note:"",observed_at:new Date(now-DAY).toISOString(),stale:false})));
    metrics.push({id:"us_spot_premium",block:"demand",family:"us_spot",name:"«us_spot_premium»",vote:true,strategic:false,tactical:true,score:sc.us_spot_premium,value_num:0,value:"0 б.п.",delta:"",note:""});
    const blocks=Object.fromEntries(Object.entries(FAM).map(([block,f])=>{const families=Object.fromEntries(Object.entries(f).filter(([,id])=>sc[id]!=null).map(([k,id])=>[k,sc[id]])),v=Object.values(families);return[block,{strategic:{score:v.length?v.reduce((a,b)=>a+b,0)/v.length*50:null,coverage:1,families,expected:Object.keys(f)},tactical:{score:0,families:{}}}]}));
    blocks.leverage={strategic:{score:null,families:{}},tactical:{score:0,families:{}}};blocks.market={strategic:{score:null,families:{}},tactical:{score:0,families:{}}};
    const alloc=r=>allocationDecisionV1({strategic:r,recoveryState:recovery,macroShockState:shock,mvrvPercentile:mvrv}),d=alloc(strategic);
    return{generated_at:new Date(now-5*60e3).toISOString(),verdict:"ВЕРДИКТ",regime:{strategic,tactical},regime_meta:{strategic:{state:strategic,candidate,since:new Date(now-6*HOUR).toISOString(),...(hold?{hold_until:new Date(now+hold*HOUR).toISOString()}:{})},tactical:{state:tactical,candidate:tactical}},
      scores:{critical_coverage_ok:true,critical_missing:{strategic:[],tactical:[]}},metrics,blocks,
      detectors:[["recovery",recovery],["macro_shock",shock],["distribution","calm"],["integrity","calm"]].map(([id,state])=>({id,state})),
      decision:{...d,policy_id:SUITE_V1,regime_targets_pct:Object.fromEntries(POLICY_V1.strategic_order.map(r=>[r,alloc(r).target_pct])),quality:{status:"good"}},
      history:Array.from({length:14},(_,i)=>({t:new Date(now-(14-i)*15*60e3).toISOString()})),
      monitoring:{started_at:new Date(now-83*DAY).toISOString(),days_elapsed:83,health:{operational_status:"healthy"},decision_events:events.map(([hoursAgo,s,target_pct,binding_overlays=[]])=>({t:new Date(now-hoursAgo*HOUR).toISOString(),strategic:s,tactical:"balanced",target_pct,binding_overlays}))},...extra};
  }
  const weakDemand={etf_regime:-1,stablecoin_regime:-1,exchange_supply:-1,financial_conditions:0,system_stress:0}; // Спрос −37,5, Макро 0, Цикл +25 → «ухудшается»
  for(let weekday=0;weekday<7;weekday++){
    const now=Date.parse("2026-03-02T09:30:00.000Z")+weekday*DAY;
    // 2.1. Фраза-действие — из направления и возраста смены цели. Повышение 5 → 20 % при режиме «ухудшается»
    //      не имеет права читаться как приказ сокращать.
    const up=mk({now,strategic:"deteriorating",scores:weakDemand,events:[[400,"defensive",5],[2,"deteriorating",20]]});
    const leadUp=plain(V.leadOf(up,now).text);
    assert.match(leadUp,/^Цель поднята 5 → 20 % \d\d\.\d\d — добирать траншами$/,`после повышения цели фраза обязана звать добирать, а не сокращать: «${leadUp}»`);
    assert.match(plain(V.leadOf(up,now).cause),/^Причина: режим «защитный» → «ухудшается»$/,"причина смены восстанавливается из decision_events, пока нет журнала");
    const down=mk({now,strategic:"deteriorating",scores:weakDemand,events:[[400,"transition",45],[3,"deteriorating",20]]});
    assert.match(plain(V.leadOf(down,now).text),/^Цель снижена 45 → 20 % \d\d\.\d\d — долю выше цели сократить сразу$/,"понижение не знает, сколько читатель успел добрать траншами: сокращается только доля выше цели");
    const steady=mk({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    assert.match(plain(V.leadOf(steady,now).text),/^Цель 45 % без изменений с \d\d\.\d\d — действий нет$/,"старая смена цели не имеет права оставаться приказом действовать");
    assert.match(plain(V.leadOf(steady,now).cause),/^Последняя смена: 20 → 45 %/);
    // Окно призыва к действию. Повышение — пока по соглашению монитора остаются транши (три, по одному в сутки,
    // первый не раньше 06:00 UTC следующих суток); понижение — ACT_DOWN_H часов. «Сейчас» в наборе — 09:30 UTC.
    assert.match(plain(V.leadOf(up,now).plan),/^Транши: осталось 3 из 3, следующий не раньше \d\d\.\d\d \d\d:\d\d$/,"после повышения названы остаток плана и срок следующего транша");
    const upAt=h=>mk({now,strategic:"deteriorating",scores:weakDemand,events:[[400,"defensive",5],[h,"deteriorating",20]]});
    assert.equal(plain(V.leadOf(upAt(47.5),now).plan).slice(0,24),"Транши: осталось 1 из 3,","позавчерашнее повышение: два транша позади, один впереди");
    // Третий транш стал исполнимым в 06:00, «сейчас» 09:30: призыв обязан стоять весь день транша, а не исчезать в его срок.
    assert.match(plain(V.leadOf(upAt(71.5),now).text),/добирать траншами$/,"в день последнего транша призыв добирать на месте");
    assert.match(plain(V.leadOf(upAt(71.5),now).plan),/^Транши: последний из 3 — с \d\d\.\d\d \d\d:\d\d$/);
    assert.match(plain(V.leadOf(upAt(95.5),now).text),/действий нет$/,"через сутки после третьего транша призыв добирать снят");assert.equal(V.leadOf(upAt(95.5),now).plan,undefined);
    const ruled=upAt(47.5);ruled.monitoring.assumptions={tranched_execution:{tranches:2,per:"utc_day",first_not_before_utc_hour:6}};
    assert.match(plain(V.leadOf(ruled,now).plan),/^Транши: последний из 2 — с /,"число траншей берётся из соглашения монитора, когда оно опубликовано");
    const ruledLater=upAt(71.5);ruledLater.monitoring.assumptions=ruled.monitoring.assumptions;
    assert.match(plain(V.leadOf(ruledLater,now).text),/действий нет$/,"через сутки после последнего транша по соглашению призыв снят");
    // Соглашение пишет другой поток: дробное, нулевое, строковое или огромное число траншей и час вне суток
    // не принимаются — остаются три транша с 06:00 UTC.
    for(const bad of [2.5,0,-1,"3",11,null]){const odd=upAt(47.5);odd.monitoring.assumptions={tranched_execution:{tranches:bad,first_not_before_utc_hour:99}};
      assert.equal(plain(V.leadOf(odd,now).plan).slice(0,24),"Транши: осталось 1 из 3,",`мусор в соглашении о траншах (${bad}) не принимается`);}
    assert.match(plain(V.leadOf(mk({now,strategic:"deteriorating",scores:weakDemand,events:[[400,"transition",45],[V.ACT_DOWN_H-1,"deteriorating",20]]}),now).text),/долю выше цели сократить сразу$/);
    assert.match(plain(V.leadOf(mk({now,strategic:"deteriorating",scores:weakDemand,events:[[400,"transition",45],[V.ACT_DOWN_H+1,"deteriorating",20]]}),now).text),/действий нет$/);
    // Журнал нового поля главнее decision_events и несёт причину сервера.
    const withLog=mk({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    withLog.monitoring.target_change_log=[{t:new Date(now-30*HOUR).toISOString(),from_pct:20,to_pct:45,direction:"up",price:86198,cause:{text:"блок «Спрос» вышел из неблагоприятной полосы"}}];
    assert.match(plain(V.leadOf(withLog,now).text),/^Цель поднята 20 → 45 %/);assert.equal(V.leadOf(withLog,now).cause,"Причина: блок «Спрос» вышел из неблагоприятной полосы");
    assert.equal(V.changeLog(withLog).at(-1).price,86198);
    // Журнал, начатый с выкладки, дополняется сменами из decision_events, случившимися до его первой записи.
    const merged=mk({now,events:[[900,"defensive",5],[600,"deteriorating",20],[17*24,"transition",45]]});
    merged.monitoring.target_change_log=[{t:new Date(now-17*24*HOUR).toISOString(),from_pct:20,to_pct:45,price:86198,cause:{text:"причина сервера"}}];
    assert.deepEqual(V.changeLog(merged).map(x=>[x.from,x.to,x.price]),[[5,20,null],[20,45,86198]],"смены до первой записи журнала берутся из decision_events, без повторов");
    // Журнал, не сходящийся с текущей целью, не подставляет чужую дату.
    assert.equal(plain(V.leadOf(mk({now,events:[[900,"deteriorating",20],[40,"transition",95]]}),now).text),"Цель 45 %");
    // Тактика, запрещающая докупки, не имеет права стоять рядом с «добирать траншами».
    assert.match(plain(V.leadOf(mk({now,tactical:"demand_break",strategic:"deteriorating",scores:weakDemand,events:[[400,"defensive",5],[2,"deteriorating",20]]}),now).text),/добор отложен: слом спроса$/);

    // 2.2–2.4. Пол восстановления при «защитном» режиме: первым стоит снятие пола, названы посчитанные баллы, тон — по цели.
    const floor=mk({now,strategic:"defensive",candidate:"transition",hold:40,mvrv:19,recovery:"good",scores:{financial_conditions:0,system_stress:0,liquidity_regime:-0.5,etf_regime:0,stablecoin_regime:-1,network_security:-1,network_activity:0.5,trend_regime:-1},events:[[400,"defensive",5],[1,"defensive",80,["recovery_floor"]]]});
    assert.equal(floor.decision.target_pct,80);assert.deepEqual(floor.decision.binding_overlays,["recovery_floor"]);
    const ft=V.triggersOf(floor,now);
    assert.equal(ft[0].dir,"dn","при связывающем поле первым триггером обязано стоять его снятие");assert.equal(ft[0].pct,5);
    assert.match(plain(ft[0].text),/^пол снимается одним снимком: подтверждений станет меньше двух \(сейчас 2 из 3\) или MVRV ≥ 25-го пц \(сейчас 19-й\)$/);
    assert.ok(!lines(ft).some(x=>/аварийн/.test(x)),"при поле единственным нижним триггером снова назван аварийный режим");
    assert.equal(plain(V.overlayLines(floor)[0]),"Пол восстановления 80 %: MVRV 19-й пц (< 25) · тренд −1 · ETF 0 · биржи 0 — 2 из 3 не ниже нуля","строка пола обязана называть посчитанное");
    assert.equal(V.toneOf(floor.decision.target_pct),"good","цвет полосы следует за целью 80 %, а не за «защитным» режимом");
    assert.match(plain(V.holdOf(floor)[0]),/^Среднесрок удерживается: по свежим данным «переходный» — кандидат с \d\d\.\d\d \d\d:\d\d · не раньше \d\d\.\d\d \d\d:\d\d$/,"удержание обязано быть подписано рядом с вердиктом");
    floor.valuation_levels={levels:[{key:"recovery_anchor",percentile:25,price_usd:72800},{key:"capitulation_floor",percentile:10,price_usd:63600},{key:"valuation_gate",percentile:82,price_usd:121200}]};
    assert.match(plain(V.triggersOf(floor,now)[0].text),/или MVRV ≥ 25-го пц — выше ≈ 73 тыс\. \$ \(сейчас 19-й\)$/,"уровень цены у якоря берётся из valuation_levels и стоит при пороге, а не при текущем перцентиле");
    assert.match(plain(V.levelsText(floor)),/пол 40 % — ниже ≈ 64 тыс\. \$ · якорь восстановления — ниже ≈ 73 тыс\. \$ · гейт оценки — выше ≈ 121 тыс\. \$$/);
    floor.regime_birth={strategic:{t:new Date(now-6*HOUR).toISOString(),candidate:"transition",blocks:{demand:{from:-31.25,to:-18.75}},families:[{name:"Качество институционального спроса",from:-1,to:0}],detectors:[]}};
    assert.match(plain(V.holdOf(floor)[0]),/, причина: Спрос −31,3 → −18,8 \(«Качество институционального спроса» −1 → 0\) · не раньше/,"причина рождения кандидата берётся из regime_birth");
    // В причину идут блоки, сменившие полосу, и их семьи; блок, сдвинувшийся внутри полосы, — фон.
    floor.regime_birth.strategic.blocks={macro:{from:-8.33,to:-16.67,band_from:"neutral",band_to:"neutral"},demand:{from:-31.25,to:-18.75,band_from:"adverse",band_to:"neutral"}};
    floor.regime_birth.strategic.families=[{block:"macro",name:"Кредит и системный стресс",from:0,to:-0.5},{block:"demand",name:"Качество институционального спроса",from:-1,to:0}];
    assert.match(plain(V.holdOf(floor)[0]),/, причина: Спрос −31,3 → −18,8 \(«Качество институционального спроса» −1 → 0\) · не раньше/);
    // Пол не включён, но якорь по MVRV уже выполнен — подсказка стоит и в «переходном» режиме.
    const near=mk({now,mvrv:20,scores:{trend_regime:-1,etf_regime:-0.5,exchange_supply:-0.5},events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    assert.ok(lines(V.triggersOf(near,now)).some(x=>/^пол восстановления: MVRV уже ниже 25-го пц, нужно два неотрицательных балла из трёх \(сейчас 0\)$/.test(x)),"подсказка про пол 80 % обязана стоять и в «переходном» режиме");
    // Пол капитуляции: в «защитном» режиме падение цены цель поднимает — экран обязан это назвать.
    const cap=mk({now,strategic:"defensive",mvrv:12,scores:{etf_regime:-1,stablecoin_regime:-1,exchange_supply:-1,trend_regime:-1,network_security:-1,network_activity:-1,miner_regime:-1},events:[[900,"transition",45],[100,"defensive",5]]});
    assert.ok(V.triggersOf(cap,now).some(x=>x.dir==="up"&&x.pct===40&&/^пол капитуляции: MVRV ≤ 10-го пц \(сейчас 12-й\)$/.test(plain(x.text))));

    // 2.6–2.7 и 4.3. Полосы блоков, расстояние в полушагах, вывод вердикта, ближайшая РЕАЛЬНАЯ ступень.
    const live=mk({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    const rows=Object.fromEntries(V.blockRows(live).map(r=>[r.key,r]));
    assert.deepEqual([rows.macro.band,rows.demand.band,rows.cycle.band],["adverse","neutral","supportive"]);
    assert.deepEqual([rows.macro.near,rows.demand.near,rows.cycle.near],[{to:"neutral",k:3},{to:"adverse",k:3},{to:"neutral",k:2}],"расстояние до смены полосы считается в полушагах семей");
    assert.ok(Math.abs(rows.macro.families.reduce((a,f)=>a+f.contrib,0)-rows.macro.score)<1e-9,"пункты семей обязаны в сумме давать балл блока");
    const w=V.whyOf(live);assert.equal(w.ok,true);assert.equal(w.rule,"неблагоприятен только Макро → «переходный»");
    const lt=V.triggersOf(live,now),dn=lt.find(x=>x.dir==="dn"),upT=lt.find(x=>x.dir==="up");
    assert.equal(dn.pct,5,"при уже неблагоприятном Макро ближайшая ступень вниз — 5 %, а не 20 %");
    assert.equal(plain(dn.text),"Спрос — в неблагоприятную (3 полушага) · двумя снимками подряд (≈ 15 мин)");
    assert.equal(upT.pct,95);assert.equal(plain(upT.text),"Макро — в благоприятную (8 полушагов) · удержание 48 ч");
    // Гейт оценки закрывает верхние ступени — подсказка их не обещает.
    const gated=mk({now,mvrv:85,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    assert.ok(!V.triggersOf(gated,now).some(x=>x.dir==="up"&&x.pct>45));assert.ok(lines(V.triggersOf(gated,now)).some(x=>/^цели выше закрыты гейтом оценки: MVRV 85-й пц/.test(x)));
    // Копия дерева, не воспроизводящая кандидата сервера, молчит об условиях и называет только соседние ступени.
    const odd=mk({now,candidate:"constructive",events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    assert.equal(V.whyOf(odd).ok,false);assert.equal(V.whyOf(odd).rule,null);
    // Удерживаемое повышение: триггер называет насчитанный режим и границу.
    const held=mk({now,strategic:"deteriorating",candidate:"transition",hold:19,events:[[900,"transition",45],[150,"deteriorating",20]]});
    assert.match(plain(V.triggersOf(held,now).find(x=>x.dir==="up").text),/^уже насчитан «переходный» — не раньше \d\d\.\d\d \d\d:\d\d$/);
    assert.match(plain(V.leadOf(held,now).text),/^Цель 20 % без изменений с /);
    // Ухудшение, ждущее второго снимка, названо со сроком.
    const pending=mk({now,candidate:"defensive",scores:{etf_regime:-1,stablecoin_regime:-1,exchange_supply:-1},events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    assert.equal(plain(V.triggersOf(pending,now).find(x=>x.dir==="dn").text),"уже насчитан «защитный» — вступит следующим снимком (≈ 15 мин)");
    assert.match(plain(V.holdOf(pending)[0]),/· вступит следующим снимком$/);

    // 2.5 и 2.12. Пауза: два рода устаревания различимы; авария при неполных данных не читается как «ничего не делать».
    const stale={actionable:false,code:"snapshot_stale",age_hours:4};
    assert.match(plain(V.pauseOf(live,stale,{okAt:now-60e3},now,3).lead),/^Сервер не публикует снимки: последний от /);
    const tab=V.pauseOf(live,stale,{okAt:now-4*HOUR,err:"HTTP 503"},now,3);
    assert.match(plain(tab.lead),/^Вкладка не обновлялась с /);assert.equal(tab.tab,true);assert.match(tab.sub,/^Нет связи с сервером \(HTTP 503\)\./);
    assert.equal(V.pauseOf(live,stale,{okAt:now-60e3},now,3).stale,true);
    const crash=mk({now,strategic:"emergency",extra:{override:"НАРУШЕНИЕ ЦЕЛОСТНОСТИ РЫНКА"}});crash.scores.critical_missing={strategic:[],tactical:["etf_regime | us_spot_premium"]};
    const cp=V.pauseOf(crash,{actionable:false,code:"decision_quality_not_actionable"},{okAt:now},now,3);
    assert.equal(cp.lead,"Аварийный режим: целостность рынка нарушена");assert.equal(cp.sub,"Нет данных: «etf_regime» или «us_spot_premium».","при паузе по покрытию названо, чего не хватает");
    assert.ok(!cp.stale,"пауза по покрытию не гасит вердикт: данные свежие");
  }

  // 3. НАБОР v3 (выпуск 2.15.0, «бой на правилах v3»). Среднесрочный режим, полы и цель решаются раз в сутки, на
  //    фиксе: понижение — на этом фиксе, повышение — на втором фиксе подряд; пол восстановления 40 / 60 / 80 % по
  //    фиксам подряд; «дёшево» — по согласию двух окон MVRV; потолка эйфории и права «Дистрибуции» нет.
  //    Фикстура собирается портами движка и сборкой боевой записи решения — теми же функциями, что снимок сборщика.
  const dmtL=t=>{const d=new Date(t),p=x=>String(x).padStart(2,"0");return`${p(d.getDate())}.${p(d.getMonth()+1)} ${p(d.getHours())}:${p(d.getMinutes())}`};
  const OWN={trend:"cycle",network:"cycle",valuation:"cycle",exchange_supply:"demand"};
  const DET_TEXT={recovery:["оценка низкая · подтверждений 1/3","Низкая циклическая оценка (MVRV <25-го перцентиля) — обязательный якорь; плюс минимум два подтверждения стабилизации тренда/ETF/биржевого предложения."],macro_shock:["условий 1/3","Сжатие Net Liquidity, ужесточение ставок/доллара и кредитный стресс должны подтвердить друг друга."],
    distribution:["оценка не высокая · подтверждений 1/2","Высокая накопленная прибыль (MVRV) — обязательный якорь. Оба подтверждения (рост биржевого предложения И потеря ценовых опор) — «сработал» и ограничение вердикта сверху; одно из двух — «наблюдение»."],integrity:["peg 0.10% · spread 6 б.п.","Hard override."]};
  // Что правило прочитало бы на этих баллах. own — баллы семей, которые движок считает сам (иначе — как на карточке).
  function calc3({now,scores={},own={},mvrv=42,deep=mvrv,hard=false}){
    const cards=mk({now,scores,mvrv}).metrics,fam=Object.fromEntries(Object.entries(FAM).map(([block,f])=>[block,Object.fromEntries(Object.entries(f).map(([family,id])=>[family,cards.find(m=>m.id===id).score]))]));
    const valuation=E3.scoreValuationV3({percentile:mvrv,percentileDeep:deep});fam.cycle.valuation=valuation.score;
    for(const [family,score] of Object.entries(own))fam[OWN[family]][family]=score;
    const blocks=E3.blockScoresV1Port(fam),shock=E3.macroShockStateV1Port(fam.macro),recovery=E3.recoveryStateV1Port({anchor:valuation.anchor,trend:fam.cycle.trend,etf:fam.demand.etf,exchangeSupply:fam.demand.exchange_supply});
    return{candidate:E3.strategicCandidateV1Port({families:fam,criticalOk:true,hardOverride:hard,macroShockState:shock,distributionState:"calm",recoveryState:recovery.state}),families:fam,blocks,macro_shock_state:shock,recovery,valuation,
      record:{mvrv_percentile:mvrv,mvrv_percentile_deep:deep,deep_window_used:deep!=null,observed:{closed_day:new Date(now-DAY).toISOString().slice(0,10)}}};
  }
  // fix — чем входы на фиксе отличались от нынешних (по умолчанию фикс видел то же, что видно сейчас); strategic —
  // действующий режим (по умолчанию — кандидат фикса); floor — число фиксов подряд с подтверждённым восстановлением;
  // pending — повышение, ждущее второго фикса; hard — аварийный режим; view — вид линии целиком (для паузы).
  function mk3({now,scores={},own={},mvrv=42,deep=mvrv,fix=null,strategic=null,floor=0,pending=null,hard=false,fixHoursAgo=3.5,tactical="balanced",events=[],extra={},view}){
    const cur=calc3({now,scores,own,mvrv,deep,hard}),at=fix?calc3({now,scores:{...scores,...fix.scores},own:{...own,...fix.own},mvrv:fix.mvrv??mvrv,deep:"deep" in fix?fix.deep:deep}):hard?calc3({now,scores,own,mvrv,deep}):cur;
    const state=strategic??at.candidate,alloc=E3.allocationDecisionV3({strategic:state,floorCloses:floor,cheap:at.valuation.cheap}),fixMs=now-fixHoursAgo*HOUR,generatedAt=new Date(now-5*60e3).toISOString();
    const record={blocks:at.blocks,families:Object.fromEntries(Object.keys(OWN).map(f=>[f,{v3:at.families[OWN[f]][f]}])),mvrv_percentile:at.record.mvrv_percentile,mvrv_percentile_deep:at.record.mvrv_percentile_deep,deep_window_used:at.record.deep_window_used,recovery:at.recovery,macro_shock_state:at.macro_shock_state,notes:[]};
    const line=view!==undefined?view:{target_pct:hard?0:alloc.target_pct,base_target_pct:alloc.base_target_pct,state:hard?"emergency":state,candidate:hard?"emergency":at.candidate,fix_at:new Date(fixMs).toISOString(),next_fix_at:new Date(E3.fixClockV3(now,Math.floor(fixMs/DAY)).next_at).toISOString(),
      floor:{active:floor>0,rung:floor||null,level_pct:alloc.floor_level_pct,closes:floor},binding_overlays:hard?["emergency_override"]:alloc.binding_overlays,pending,inputs:record,reason_codes:hard?["emergency_override","between_fixes"]:["between_fixes",`base:${state}`,...alloc.binding_overlays,...(pending?[`upgrade_pending:${pending.candidate}:${pending.fixes}/${pending.need}`]:[])]};
    const decision=L3.buildLiveDecisionV3({generatedAt,v1Decision:{tactical,quality:{critical_coverage_ok:true},input_hash:"fixture"},view:line});
    assert.equal(decision.policy_id,L3.LIVE_SUITE_ID_V3);assert.equal(L3.reproduceDecisionV3(decision).ok,true,"фикстура набора v3 обязана воспроизводиться правилом набора");
    // Карточки, блоки и детекторы снимка — по методике v1: якорь восстановления по одному окну, баллы карточек.
    const S=mk({now,scores,mvrv,strategic:hard?"emergency":state,tactical,events,extra}),card=id=>S.metrics.find(m=>m.id===id).score;
    const cardState={recovery:E3.recoveryStateV1Port({anchor:mvrv<25,trend:card("trend_regime"),etf:card("etf_regime"),exchangeSupply:card("exchange_supply")}).state,macro_shock:cur.macro_shock_state,distribution:"calm",integrity:hard?"fired":"calm"};
    S.detectors=Object.entries(DET_TEXT).map(([id,[inputs,logic]])=>({id,name:`«${id}»`,state:cardState[id],inputs,logic}));
    return Object.assign(S,{regime:{strategic:decision.strategic,tactical},regime_meta:{strategic:L3.liveRegimeMetaV3({decision,view:line,previousMeta:null,now,calc:at}),tactical:{state:tactical,candidate:tactical}},decision,live_inputs:L3.liveInputsV3(cur,generatedAt),
      reference_v1:{decision:{strategic:state,target_pct:S.decision.target_pct,binding_overlays:S.decision.binding_overlays}},...(hard?{override:"НАРУШЕНИЕ ЦЕЛОСТНОСТИ РЫНКА"}:{})});
  }
  // Весь текст среднесрока на первом экране и под вердиктом — для проверок «чего экран не говорит».
  const screen=(S,now)=>[...lines(V.triggersOf(S,now)),...V.overlayLines(S).map(plain),plain(V.levelsText(S)),...V.holdOf(S).map(plain).filter(x=>x.startsWith("Среднесрок"))];
  // Всё, что страница пишет словами о правилах: первый экран, справка, статус, детекторы, промпт и данные ИИ-разбора.
  const everything=(S,now)=>[...screen(S,now),plain(V.whyOf(S).rule),...V.methodParts(S).flat().map(plain),...Object.values(V.policyFacts(S)).map(plain),...V.detView(S).flatMap(d=>[plain(d.role),plain(d.logic),plain(d.inputs)]),plain(V.aiHead()),plain(JSON.stringify(V.aiPolicy(S)))];
  const twoAdverse={stablecoin_regime:-2,institutional_quality:-1,etf_regime:0,trend_regime:-1}; // Макро −41,7 и Спрос −37,5 неблагоприятны
  for(let weekday=0;weekday<7;weekday++){
    const now=Date.parse("2026-03-02T09:30:00.000Z")+weekday*DAY,RX_FIX="на фиксе \\d\\d\\.\\d\\d \\d\\d:\\d\\d";
    // 3.1. Режим без изменений: условия — из live_inputs, сроки — в фиксах. Числа целей — только из снимка.
    const base=mk3({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    assert.equal(base.decision.target_pct,45);assert.deepEqual(base.decision.binding_overlays,[]);assert.equal(base.regime_meta.strategic.next_fix_at,new Date(Math.floor(now/DAY)*DAY+DAY+6*HOUR).toISOString());
    const fixAt=dmtL(base.regime_meta.strategic.next_fix_at),bw=V.whyOf(base);
    assert.equal(bw.ok,true,"копия дерева гейтов обязана воспроизводить кандидата правила из live_inputs");assert.equal(bw.rule,"неблагоприятен только Макро → «переходный»");assert.equal(bw.note,null);
    const bt=V.triggersOf(base,now),bdn=bt.find(x=>x.dir==="dn"),bup=bt.find(x=>x.dir==="up");
    assert.equal(bdn.pct,5);assert.equal(plain(bdn.text),"Спрос — в неблагоприятную (3 полушага) · на первом же фиксе","понижение принимается на первом же фиксе");
    assert.equal(bup.pct,95);assert.equal(plain(bup.text),"Макро — в благоприятную (8 полушагов) · на втором фиксе подряд","повышение — на втором фиксе подряд");
    assert.deepEqual(V.holdOf(base),[],"режим равен кандидату и повышений не ждёт — под вердиктом пусто");
    assert.equal(plain(V.levelsText(base)).split(" · ")[0],`следующий фикс — ${fixAt}`,"срок ближайшего решения стоит на первом экране");
    assert.match(plain(V.leadOf(base,now).text),/^Цель 45 % без изменений с \d\d\.\d\d — действий нет$/);
    for(const x of screen(base,now))assert.doesNotMatch(x,/снимк|удержание|48 ч/,`среднесрок набора v3 решается на фиксе, а экран говорит о снимках: «${x}»`);
    // Браузер цель не считает: числа ступеней — те, что стоят в снимке, даже если они «неправильные».
    const odd=mk3({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});odd.decision.regime_targets_pct={...odd.decision.regime_targets_pct,defensive:7,unconfirmed_positive:93};
    assert.equal(V.triggersOf(odd,now).find(x=>x.dir==="dn").pct,7,"число нижней ступени обязано прийти из regime_targets_pct снимка");assert.equal(V.triggersOf(odd,now).find(x=>x.dir==="up").pct,93);
    // Баллы сети, бирж, оценки и тренда — те, что считает правило: дорожки и расчёт сходятся с ними, а не с карточками.
    const ownTrend=mk3({now,own:{trend:0},events:[[900,"deteriorating",20],[17*24,"transition",45]]}),oc=V.blockRows(ownTrend).find(r=>r.key==="cycle");
    assert.ok(Math.abs(oc.score-5)<1e-9&&oc.band==="neutral","балл блока — тот, что читает правило (тренд 0), а не балл по карточкам (+25)");
    assert.deepEqual([oc.families.find(f=>f.id==="trend_regime").score,oc.families.find(f=>f.id==="trend_regime").card],[0,2],"балл карточки, расходящийся с баллом правила, остаётся рядом");
    assert.equal(V.blockRows(base).flatMap(r=>r.families).every(f=>f.card===null),true,"без расхождения балл карточки рядом не печатается");
    assert.ok(Math.abs(oc.families.reduce((a,f)=>a+f.contrib,0)-oc.score)<1e-9,"пункты семей в сумме дают балл блока и у набора v3");

    // 3.2 (а). Пол восстановления растёт ступенями 40 / 60 / 80 по фиксам подряд — экран называет свою ступень.
    const rung=(n,strategic,pending=null)=>mk3({now,strategic,pending,floor:n,mvrv:19,deep:21,scores:twoAdverse,events:[[400,"defensive",5],[3.5,strategic,[40,60,80][n-1],["recovery_floor"]]]});
    const r1=rung(1,"defensive",{candidate:"transition",fixes:1,need:2}),r2=rung(2,"transition"),r3=rung(3,"transition");
    assert.deepEqual([r1,r2,r3].map(s=>[s.decision.base_target_pct,s.decision.target_pct,s.decision.binding_overlays.join()]),[[5,40,"recovery_floor"],[45,60,"recovery_floor"],[45,80,"recovery_floor"]]);
    assert.equal(plain(V.overlayLines(r1)[0]),"Пол восстановления 40 % — ступень 1 из 3 · MVRV сейчас 19-й пц за 4 года, 21-й по всей истории (якорь — ниже 25-го в обоих окнах) · тренд −1 · ETF 0 · биржи 0 — 2 из 3 не ниже нуля","строка пола называет свою ступень и посчитанное");
    assert.match(plain(V.overlayLines(r2)[0]),/^Пол восстановления 60 % — ступень 2 из 3 · /);assert.match(plain(V.overlayLines(r3)[0]),/^Пол восстановления 80 % — ступень 3 из 3 · /);
    for(const x of screen(r1,now))assert.doesNotMatch(x,/Пол восстановления 80|пол 80/,`первая ступень пола подана как 80 %: «${x}»`);
    const t1=V.triggersOf(r1,now),t2=V.triggersOf(r2,now),t3=V.triggersOf(r3,now);
    assert.deepEqual([t1[0].dir,t1[0].pct,t1[0].more],["dn",5,true],"при связывающем поле первым стоит его снятие");
    assert.match(plain(t1[0].text),new RegExp(`^пол снимается ${RX_FIX}, если восстановление не подтверждено: подтверждений меньше двух \\(сейчас 2 из 3\\), MVRV ≥ 25-го пц в любом из окон \\(сейчас 19-й пц за 4 года, 21-й по всей истории\\) или макрошок$`));
    assert.ok(plain(t1[0].text).includes(`на фиксе ${fixAt}`),"срок снятия пола — следующий фикс из снимка");
    assert.deepEqual([t1[1].dir,t1[1].pct,plain(t1[1].text)],["up",60,`пол восстановления — ступень 2 из 3 на фиксе ${fixAt}, если детектор подтверждён (сейчас 2 из 3)`],"следующая ступень пола названа со сроком");
    assert.deepEqual([t2[0].pct,t2[1].pct,plain(t2[1].text)],[45,80,`пол восстановления — ступень 3 из 3 на фиксе ${fixAt}, если детектор подтверждён (сейчас 2 из 3)`]);
    assert.equal(t3[0].pct,45);assert.ok(!t3.some(x=>/ступень/.test(x.text)),"на последней ступени следующей нет");
    for(const t of [t1,t2,t3])assert.ok(!lines(t).some(x=>/аварийн/.test(x)),"при поле единственным нижним триггером снова назван аварийный режим");
    assert.deepEqual([40,60,80].map(V.toneOf),["neutral","neutral","good"],"цвет полосы следует за ступенью пола");
    assert.equal(plain(V.detView(r1).find(d=>d.id==="recovery").role),"поднимает «защитный» и «ухудшается» до «переходного» и включает пол 40 / 60 / 80 % — по числу фиксов подряд");
    // Пол не включён, якорь по MVRV выполнен в обоих окнах: подсказка называет первую ступень, а не 80 %.
    const nearFloor=mk3({now,mvrv:20,deep:22,scores:{...twoAdverse,etf_regime:-1,exchange_supply:-0.5},events:[[900,"transition",45],[100,"defensive",5]]});
    assert.equal(nearFloor.decision.target_pct,5);
    assert.ok(V.triggersOf(nearFloor,now).some(x=>x.dir==="up"&&x.pct===40&&plain(x.text)==="пол восстановления: MVRV уже ниже 25-го пц в обоих окнах, нужно два неотрицательных балла из трёх (сейчас 0) · ступени 40 / 60 / 80 по фиксам подряд"),"подсказка про пол называет первую ступень 40 %");
    // Детектор подтверждён по текущим данным, а фикс его ещё не видел: первая ступень — на ближайшем фиксе.
    const armed=mk3({now,strategic:"defensive",mvrv:20,deep:22,scores:twoAdverse,fix:{scores:{etf_regime:-1,exchange_supply:-0.5}},events:[[900,"transition",45],[100,"defensive",5]]});
    assert.equal(armed.decision.target_pct,5);assert.deepEqual(armed.decision.binding_overlays,[]);
    assert.ok(V.triggersOf(armed,now).some(x=>x.dir==="up"&&x.pct===40&&plain(x.text)===`пол восстановления: детектор подтверждён (2 из 3) — первая ступень на фиксе ${fixAt}`));
    // Якорь выполнен только в окне четырёх лет: пол восстановления экран не обещает, детектор показан состоянием правила.
    const oneWin=mk3({now,mvrv:20,deep:31,scores:{...twoAdverse,trend_regime:0},events:[[900,"transition",45],[100,"defensive",5]]});
    assert.equal(oneWin.detectors.find(d=>d.id==="recovery").state,"good","карточка детектора (методика v1, одно окно) считает восстановление выполненным");
    const oneDet=V.detView(oneWin).find(d=>d.id==="recovery");
    assert.deepEqual([oneDet.state,plain(oneDet.inputs)],["calm","оценка не низкая хотя бы в одном окне MVRV · подтверждений 3/3"],"детектор восстановления показан так, как его читает боевое правило");
    assert.match(plain(oneDet.logic),/MVRV <25-го перцентиля за 4 года и по всей истории/);
    // Обе правки текста карточек детекторов — замена подстроки в тексте сборщика (он в запертой секции v1). Если
    // сборщик эти слова изменит, замена на странице молча перестанет срабатывать — поэтому слова закреплены здесь.
    for(const phrase of [" и ограничение вердикта сверху","(MVRV <25-го перцентиля)"])assert.equal(collector.split(phrase).length,2,`текст детектора в сборщике изменился: страница правит фразу «${phrase.trim()}» заменой подстроки`);
    assert.doesNotMatch(plain(V.detView(oneWin).find(d=>d.id==="distribution").logic),/ограничение вердикта сверху/,"право «Дистрибуции» из текста карточки убрано");
    assert.ok(!screen(oneWin,now).some(x=>/пол восстановления/i.test(x)),"якорь по одному окну пол восстановления не обещает");

    // 3.3 (б). «Дёшево» — только при согласии двух окон. MVRV ≤ 10 за четыре года, но выше по всей истории:
    //          пола капитуляции нет, и экран его не обещает.
    const allAdverse={...twoAdverse,etf_regime:-1,exchange_supply:-1,network_security:-1,network_activity:-1,miner_regime:-1};
    const half=mk3({now,mvrv:7,deep:18,scores:allAdverse,events:[[900,"transition",45],[100,"defensive",5]]});
    assert.equal(half.decision.target_pct,5);assert.deepEqual(half.decision.binding_overlays,[]);assert.equal(half.decision.inputs.cheap,false);
    assert.equal(half.metrics.find(m=>m.id==="mvrv_cycle").score,1,"карточка оценки (одно окно) при этом показывает «дёшево»");
    const ht=V.triggersOf(half,now),hcap=ht.filter(x=>/капитуляц/.test(x.text));
    assert.deepEqual(hcap.map(x=>[x.dir,x.pct,plain(x.text)]),[["up",40,"пол капитуляции: нужен MVRV ≤ 10-го пц в обоих окнах — сейчас 7-й пц за 4 года, 18-й по всей истории"]],"условие пола капитуляции названо по двум окнам");
    for(const x of screen(half,now))assert.doesNotMatch(x,/капитуляции[^·]*(?:включится|включён)|Пол капитуляции/,`экран обещает пол капитуляции при несогласии окон: «${x}»`);
    assert.match(plain(V.levelsText(half)),/· MVRV 7-й пц за 4 года, 18-й по всей истории на \d\d\.\d\d · пол 40 % — ≤ 10-го пц в обоих окнах · якорь восстановления — < 25-го пц в обоих окнах · гейт оценки — ≥ 82-го пц$/);
    half.valuation_levels={window_days:1460,levels:[{key:"recovery_anchor",percentile:25,price_usd:72800},{key:"capitulation_floor",percentile:10,price_usd:63600},{key:"valuation_gate",percentile:82,price_usd:121200}]};
    assert.match(plain(V.levelsText(half)),/пол 40 % — ≤ 10-го пц в обоих окнах \(за 4 года — ниже ≈ 64 тыс\. \$\) · якорь восстановления — < 25-го пц в обоих окнах \(за 4 года — ниже ≈ 73 тыс\. \$\) · гейт оценки — выше ≈ 121 тыс\. \$$/,"уровень цены подписан окном, по которому посчитан");
    assert.equal(V.blockRows(half).find(r=>r.key==="cycle").families.find(f=>f.id==="mvrv_cycle").score,0,"балл оценки в расчёте — правила (0), а не карточки (+1)");
    assert.deepEqual(V.ruleScore(half,half.metrics.find(m=>m.id==="mvrv_cycle")),{score:0,why:"«дёшево» — по двум окнам MVRV"},"карточка оценки называет балл боевого правила, когда он расходится с её баллом");
    assert.deepEqual(V.ruleScore(ownTrend,ownTrend.metrics.find(m=>m.id==="trend_regime")),{score:0,why:"тренд — по закрытому дню"});
    assert.ok(base.metrics.every(m=>V.ruleScore(base,m)===null),"без расхождения балл правила на карточке не печатается");
    // Округление не переносит перцентиль через порог: 10,3 не печатается «10-м».
    const edge=mk3({now,mvrv:10.3,deep:9,scores:allAdverse,events:[[900,"transition",45],[100,"defensive",5]]});
    assert.ok(lines(V.triggersOf(edge,now)).includes("пол капитуляции: нужен MVRV ≤ 10-го пц в обоих окнах — сейчас 10,3-й пц за 4 года, 9-й по всей истории"));
    // Оба окна согласны, фикс этого ещё не видел: пол включится на фиксе. После фикса — строка пола с перцентилями фикса.
    const both=mk3({now,strategic:"defensive",mvrv:7,deep:9,fix:{deep:18},scores:allAdverse,events:[[900,"transition",45],[100,"defensive",5]]});
    assert.equal(both.decision.target_pct,5);
    assert.ok(V.triggersOf(both,now).some(x=>x.dir==="up"&&x.pct===40&&plain(x.text)===`пол капитуляции: MVRV ≤ 10-го пц в обоих окнах (7-й пц за 4 года, 9-й по всей истории) — включится на фиксе ${fixAt}`));
    const capOn=mk3({now,mvrv:7,deep:9,scores:allAdverse,events:[[900,"transition",45],[3.5,"defensive",40,["capitulation_floor"]]]});
    assert.equal(capOn.decision.target_pct,40);assert.deepEqual(capOn.decision.binding_overlays,["capitulation_floor"]);
    assert.equal(plain(V.overlayLines(capOn)[0]),"Пол капитуляции 40 %: на фиксе MVRV 7-й пц за 4 года и 9-й по всей истории (≤ 10 в обоих окнах)");
    assert.deepEqual([V.triggersOf(capOn,now)[0].pct,plain(V.triggersOf(capOn,now)[0].text)],[5,`пол снимается на фиксе ${fixAt}, если MVRV выше 10-го пц в любом из окон (сейчас 7-й пц за 4 года, 9-й по всей истории)`]);
    // Ряд всей истории негоден — правило честно работает по одному окну, и экран второе окно не выдумывает.
    const single=mk3({now,mvrv:7,deep:null,scores:allAdverse,events:[[900,"transition",45],[3.5,"defensive",40,["capitulation_floor"]]]});
    assert.equal(single.decision.target_pct,40);assert.equal(plain(V.overlayLines(single)[0]),"Пол капитуляции 40 %: на фиксе MVRV 7-й пц (≤ 10)");
    assert.ok(!screen(single,now).some(x=>/в обоих окнах|по всей истории|в любом из окон/.test(x)),"при одном окне экран о двух окнах не говорит");

    // 3.4 (в). Повышение принято на первом фиксе и ждёт второго: «на фиксе …» со сроком из снимка.
    const pend=mk3({now,strategic:"deteriorating",pending:{candidate:"transition",fixes:1,need:2},events:[[900,"transition",45],[150,"deteriorating",20]]});
    assert.equal(pend.decision.target_pct,20);assert.equal(pend.regime_meta.strategic.hold_until,pend.regime_meta.strategic.next_fix_at,"пока повышение ждёт, hold_until — следующий фикс");
    const holdAt=dmtL(pend.regime_meta.strategic.hold_until),pu=V.triggersOf(pend,now).find(x=>x.dir==="up");
    assert.deepEqual([pu.pct,plain(pu.text)],[45,`уже насчитан «переходный» (фикс 1 из 2) — вступит на фиксе ${holdAt}, если кандидат тот же`],"ожидающее повышение названо со сроком фикса");
    assert.equal(plain(V.holdOf(pend)[0]),`Среднесрок удерживается: на фиксе ${dmtL(pend.regime_meta.strategic.since)} насчитан «переходный» (1 из 2) · вступит на фиксе ${holdAt}, если кандидат тот же`,"ожидание второго фикса подписано рядом с вердиктом");
    assert.match(plain(V.leadOf(pend,now).text),/^Цель 20 % без изменений с /);
    pend.regime_birth={strategic:{t:pend.regime_meta.strategic.fix_at,candidate:"transition",from_candidate:"deteriorating",blocks:{demand:{from:-31.25,to:-18.75,band_from:"adverse",band_to:"neutral"}},families:[{block:"demand",name:"Качество институционального спроса",from:-1,to:0}],detectors:[],note:null}};
    assert.match(plain(V.holdOf(pend)[0]),/насчитан «переходный» \(1 из 2\), причина: Спрос −31,3 → −18,8 \(«Качество институционального спроса» −1 → 0\) · вступит на фиксе /,"причина рождения кандидата — разница между фиксами из regime_birth");
    // Срок берётся из hold_until; без него — из next_fix_at; срок, прошедший к моменту снимка, датой не печатается.
    const noHold=structuredClone(pend);delete noHold.regime_meta.strategic.hold_until;
    assert.ok(plain(V.triggersOf(noHold,now).find(x=>x.dir==="up").text).includes(`вступит на фиксе ${holdAt}`));
    const late=structuredClone(pend);late.regime_meta.strategic.hold_until=late.regime_meta.strategic.next_fix_at=late.decision.inputs.next_fix_at=new Date(now-HOUR).toISOString();
    assert.ok(plain(V.triggersOf(late,now).find(x=>x.dir==="up").text).includes("вступит на следующем фиксе, если кандидат тот же"));assert.ok(!plain(V.levelsText(late)).includes("следующий фикс"),"прошедший срок фикса датой не печатается");
    // Текущие данные повышение уже не поддерживают — экран это называет.
    const fading=mk3({now,strategic:"deteriorating",pending:{candidate:"transition",fixes:1,need:2},scores:weakDemand,fix:{scores:{etf_regime:-0.5,stablecoin_regime:0,exchange_supply:0,financial_conditions:-2,system_stress:-0.5}},events:[[900,"transition",45],[150,"deteriorating",20]]});
    assert.ok(plain(V.triggersOf(fading,now).find(x=>x.dir==="up").text).endsWith("если кандидат тот же; по текущим данным «ухудшается»"));assert.ok(plain(V.holdOf(fading)[0]).endsWith("если кандидат тот же · по текущим данным «ухудшается»"));
    // Режим по текущим данным уже хуже действующего: понижение вступит на ближайшем фиксе.
    const worse=mk3({now,scores:weakDemand,fix:{scores:{etf_regime:-0.5,stablecoin_regime:0,exchange_supply:0,financial_conditions:-2,system_stress:-0.5}},events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    assert.deepEqual([worse.regime.strategic,worse.live_inputs.candidate,worse.decision.target_pct],["transition","deteriorating",45]);
    const wd=V.triggersOf(worse,now).find(x=>x.dir==="dn");
    assert.deepEqual([wd.pct,plain(wd.text)],[20,`по текущим данным «ухудшается» — вступит на фиксе ${fixAt}`]);
    assert.equal(plain(V.holdOf(worse)[0]),`Среднесрок: по текущим данным «ухудшается» · вступит на фиксе ${fixAt}`);
    assert.equal(V.whyOf(worse).note,"действует «переходный»: режим решается на фиксе","расчёт по текущим данным подписан, когда расходится с действующим режимом");
    // Режим по текущим данным лучше действующего, фикс его ещё не видел: нужны два фикса подряд.
    const better=mk3({now,fix:{scores:weakDemand},events:[[900,"transition",45],[150,"deteriorating",20]]});
    assert.deepEqual([better.regime.strategic,better.live_inputs.candidate,better.regime_meta.strategic.pending],["deteriorating","transition",null]);
    assert.deepEqual([V.triggersOf(better,now).find(x=>x.dir==="up").pct,plain(V.triggersOf(better,now).find(x=>x.dir==="up").text)],[45,`по текущим данным «переходный» — нужен на двух фиксах подряд, первый — ${fixAt}`]);
    assert.equal(plain(V.holdOf(better)[0]),`Среднесрок: по текущим данным «переходный» · нужен на двух фиксах подряд, первый — ${fixAt}`);
    // Тактика набором v3 не менялась: её гистерезис — по снимкам, строка удержания прежняя.
    const tactHeld=mk3({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});tactHeld.regime_meta.tactical={state:"balanced",candidate:"spot_led",since:new Date(now-6*HOUR).toISOString(),hold_until:new Date(now+40*HOUR).toISOString()};
    assert.match(plain(V.holdOf(tactHeld)[0]),/^Тактика удерживается: по свежим данным «спот ведёт» — кандидат с \d\d\.\d\d \d\d:\d\d · не раньше \d\d\.\d\d \d\d:\d\d$/);
    // Аварийный режим — сразу, на любом прогоне; выход выше прежнего режима — через два фикса.
    const crash3=mk3({now,hard:true,events:[[900,"transition",45],[1,"emergency",0,["emergency_override"]]]});
    assert.deepEqual([crash3.regime.strategic,crash3.decision.target_pct,crash3.decision.binding_overlays.join()],["emergency",0,"emergency_override"]);
    assert.deepEqual(V.triggersOf(crash3,now).map(x=>plain(x.text)),["выход: первый прогон без нарушения целостности возвращает прежний режим; выше него — на втором фиксе подряд"]);
    assert.deepEqual(V.overlayLines(crash3),[]);assert.deepEqual(V.holdOf(crash3),[]);assert.equal(V.whyOf(crash3).ok,false);
    assert.match(plain(V.leadOf(crash3,now).text),/^Цель снижена 45 → 0 % \d\d\.\d\d — выйти сразу$/);
    // Решение на паузе: цели нет, причина названа; функции экрана не падают.
    const blind=mk3({now,view:null}),noFix=mk3({now,view:{state:"transition",target_pct:null,candidate:"transition",reason_codes:["fix_deferred","insufficient_data"]}});
    assert.deepEqual([blind.decision.status,blind.decision.target_pct,noFix.decision.status,noFix.regime.strategic],["paused",null,"paused","transition"]);
    const gatePaused={actionable:false,code:"decision_not_actionable"};
    assert.equal(V.pauseOf(blind,gatePaused,{okAt:now},now,3).sub,"Решение сервера приостановлено: расчёт правил не выполнен.");assert.equal(V.pauseOf(noFix,gatePaused,{okAt:now},now,3).sub,"Решение сервера приостановлено: на фиксе не хватило данных.");
    for(const s of [blind,noFix]){assert.deepEqual(V.triggersOf(s,now),[]);for(const f of ["holdOf","overlayLines","levelsText","whyOf","blockRows","detView","alarmCount","methodParts","policyFacts","aiPolicy"])assert.doesNotThrow(()=>V[f](s),`VIEW.${f} упала на решении набора v3 на паузе`);}

    // 3.5 (г). Потолка эйфории и права «Дистрибуции» в правилах нет — страница их нигде не утверждает, даже когда
    //          детектор «сработал», а MVRV выше 95-го перцентиля.
    const hot=mk3({now,mvrv:96,deep:97,scores:{financial_conditions:1,system_stress:0,liquidity_regime:1,etf_regime:1,stablecoin_regime:1},events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    const calmDist=[V.whyOf(hot).ok,V.whyOf(hot).cand,V.whyOf(hot).rule,lines(V.triggersOf(hot,now)).join("|"),V.alarmCount(hot)];
    hot.detectors.find(d=>d.id==="distribution").state="fired";
    assert.deepEqual([hot.regime.strategic,hot.decision.target_pct,hot.decision.binding_overlays.join()],["transition",45,""],"при MVRV выше 95-го перцентиля цель задаёт режим: потолка нет");
    assert.deepEqual([V.whyOf(hot).ok,V.whyOf(hot).cand,V.whyOf(hot).rule,lines(V.triggersOf(hot,now)).join("|"),V.alarmCount(hot)],calmDist,"сработавшая «Дистрибуция» не меняет ни расчёта режима, ни подсказок, ни счёта тревожных детекторов");
    assert.equal(V.whyOf(hot).rule,"благоприятны Макро и Спрос → «конструктивный»; гейт оценки (MVRV 96-й пц) → «переходный»");
    assert.ok(lines(V.triggersOf(hot,now)).includes("цели выше закрыты гейтом оценки: MVRV 96-й пц (≥ 82)"));
    const dist=V.detView(hot).find(d=>d.id==="distribution");
    assert.deepEqual([dist.state,dist.reference,plain(dist.role)],["fired",true,"справочный: на режим и цель не влияет"]);
    assert.equal(plain(dist.logic),"Высокая накопленная прибыль (MVRV) — обязательный якорь. Оба подтверждения (рост биржевого предложения И потеря ценовых опор) — «сработал»; одно из двух — «наблюдение».","текст карточки не обещает ограничения вердикта");
    for(const s of [base,r1,half,capOn,pend,hot,crash3])for(const x of everything(s,now))
      assert.doesNotMatch(x,/потол\S* эйфори|[Пп]отолок \d|полы и потолок|euphoria|ограничение вердикта сверху|дистрибуци\S* (?:ограничива|не да[её]т)|ЗАМОРОЖЕННОЙ|задаёт v1/i,`страница утверждает правило, которого в наборе v3 нет: «${String(x).slice(0,160)}»`);
    assert.equal(V.detView(base).find(d=>d.id==="macro_shock").role,"не даёт среднесрочному режиму быть лучше «ухудшается» и запрещает пол восстановления");

    // 3.6. Справка, статус и слой правил ИИ-разбора говорят правилами набора v3.
    const parts=Object.fromEntries(V.methodParts(base).map(([k,x])=>[k,plain(x)]));
    assert.deepEqual(Object.keys(parts),["Полосы блоков","Баллы правила","Гейт оценки","Смена режима","Полы","Детекторы"]);
    // Сроки на первом экране — по часам устройства; если они не московские, справка называет час фикса и по ним.
    const ownHour=fixAt.slice(-5);
    assert.ok(parts["Смена режима"].includes(ownHour==="09:00"?"(09:00 МСК)":`(09:00 МСК, по часам устройства — ${ownHour})`),"час фикса в справке сходится со сроками первого экрана");
    assert.match(parts["Смена режима"],/^Среднесрочный режим, полы и цель решаются раз в сутки, на фиксе: первый снимок не раньше 06:00 UTC \(09:00 МСК(?:, по часам устройства — \d\d:\d\d)?\)\. Ухудшение принимается на этом фиксе, улучшение — на втором фиксе подряд с тем же кандидатом; пропущенные сутки обнуляют счёт фиксов\. Между фиксами режим и цель не меняются; аварийный режим — сразу, на любом снимке\. Краткосрочный режим считается на каждом снимке: ухудшение — двумя снимками подряд \(сейчас между снимками ≈ 15 мин\), улучшение — после 48 ч без встречного снимка\.$/);
    assert.match(parts["Полы"],/^Пол восстановления 40 \/ 60 \/ 80 % — по одному, двум и трём фиксам подряд .* снимается на фиксе, где детектор не подтверждён\. Пол капитуляции 40 %: MVRV не выше 10-го перцентиля\. «Дёшево» в обоих полах — только при согласии двух окон MVRV: четырёх лет и всей истории\. Потолка у цели нет\.$/);
    assert.match(parts["Детекторы"],/«Дистрибуция» — справочный детектор: на режим и цель не влияет\.$/);
    assert.deepEqual([V.policyFacts(base).name,plain(V.policyFacts(base).since)],["Правила v3","утверждены 20.11.2026"]);
    const ai=V.aiPolicy(base);
    assert.deepEqual([ai.id,ai.target_pct,ai.rules.daily_fix.hour_utc,ai.rules.recovery_floor_ladder_pct.join(),ai.decision_inputs.next_fix_at],[L3.LIVE_SUITE_ID_V3,45,6,"40,60,80",base.regime_meta.strategic.next_fix_at]);
    assert.deepEqual(ai.live_inputs,base.live_inputs,"ИИ-разбор получает то, что читает боевое правило");assert.deepEqual(ai.ladder_pct,base.decision.regime_targets_pct);
    assert.match(V.aiHead(),/РАЗ В СУТКИ, на фиксе — первом снимке не раньше 06:00 UTC: понижение режима принимается на этом фиксе, повышение — на втором фиксе подряд/);

    // 3.7. Мусор в полях набора v3 (их пишут другие потоки) не роняет экран и не отнимает цели.
    const junk=mk3({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    Object.assign(junk,{live_inputs:{blocks:"x",families:7},reference_v1:"x",regime_birth:{strategic:7}});Object.assign(junk.regime_meta.strategic,{pending:7,floor:"x",fix:1,next_fix_at:"не дата",hold_until:{},since:null});junk.decision.inputs="x";
    const junk2=mk3({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    Object.assign(junk2.live_inputs,{families:{macro:"x",demand:null,cycle:{trend:"2",valuation:{}}},blocks:{macro:"−41",demand:null},recovery:"x",candidate:42,mvrv_percentile:"7",mvrv_percentile_deep:{},cheap:"да"});junk2.regime_meta.strategic={pending:{candidate:"неведомый",fixes:"1"},floor:{closes:99,level_pct:"x"}};junk2.decision.inputs={floor_closes:-3,pending:"x"};
    for(const s of [junk,junk2]){
      for(const f of ["changeLog","blockRows","whyOf","tactRows","dataNotes","warnMap","holdOf","overlayLines","monitorModel","levelsText","resultText","tactOf","detView","alarmCount","methodParts","policyFacts","aiPolicy"])assert.doesNotThrow(()=>V[f](s),`VIEW.${f} упала на мусоре в полях набора v3`);
      assert.doesNotThrow(()=>V.triggersOf(s,now));assert.doesNotThrow(()=>s.metrics.map(m=>V.ruleScore(s,m)));assert.match(plain(V.leadOf(s,now).text),/^Цель 45 % без изменений с \d\d\.\d\d — действий нет$/,"мусор в полях набора v3 не отнимает цель и её историю");
    }
    // Снимок набора v3 без live_inputs (расчёт входов не удался): условий экран не выдумывает, называет соседние ступени.
    const bare=mk3({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});bare.live_inputs=null;
    assert.equal(V.whyOf(bare).ok,false);
    assert.deepEqual(V.triggersOf(bare,now).map(x=>[x.dir,x.pct,plain(x.text)]),[["up",95,"режим «спрос не подтв.» · на втором фиксе подряд"],["dn",20,"ухудшение режима · на первом же фиксе"]]);

    // 3.8 (д). Снимок прежней формы (решение набора v1) показан по правилам v1 и без исключений: такой снимок
    //          лежит на витрине до первого сбора новым кодом.
    const old=mk({now,strategic:"defensive",candidate:"transition",hold:40,mvrv:19,recovery:"good",scores:{financial_conditions:0,system_stress:0,liquidity_regime:-0.5,etf_regime:0,stablecoin_regime:-1,network_security:-1,network_activity:0.5,trend_regime:-1},events:[[400,"defensive",5],[1,"defensive",80,["recovery_floor"]]]});
    assert.equal(old.decision.policy_id,SUITE_V1);
    for(const f of ["changeLog","blockRows","whyOf","tactRows","dataNotes","warnMap","holdOf","overlayLines","monitorModel","levelsText","resultText","tactOf","detView","alarmCount","methodParts","policyFacts","aiPolicy"])assert.doesNotThrow(()=>V[f](old),`VIEW.${f} упала на снимке прежней формы`);
    assert.doesNotThrow(()=>V.triggersOf(old,now));assert.doesNotThrow(()=>V.leadOf(old,now));
    assert.match(plain(V.overlayLines(old)[0]),/^Пол восстановления 80 %: MVRV 19-й пц \(< 25\)/,"пол прежнего набора — 80 % одним снимком, так и показан");
    assert.match(plain(V.triggersOf(old,now)[0].text),/^пол снимается одним снимком: /);assert.match(plain(V.holdOf(old)[0]),/^Среднесрок удерживается: по свежим данным «переходный» — кандидат с .* · не раньше /);
    assert.ok(!plain(V.levelsText(old)).includes("следующий фикс"),"у прежнего набора фиксов нет");
    assert.deepEqual([V.policyFacts(old).name,V.methodParts(old)[0][0]],["Правила v1","Снимок прежних правил"],"снимок прежней формы подписан как принятый прежними правилами");
    assert.match(plain(V.methodParts(old)[0][1]),/^Решение этого снимка принято набором v1: режим менялся по снимкам/);
    assert.match(V.aiPolicy(old).status,/ЭТОТ снимок ещё принят прежним набором v1/);assert.equal(V.aiPolicy(old).live_inputs,null);
    old.live_inputs={families:{cycle:{trend:2}},blocks:{cycle:99}};
    assert.ok(old.metrics.every(m=>V.ruleScore(old,m)===null)&&V.blockRows(old).find(r=>r.key==="cycle").score!==99,"у снимка прежней формы баллы — с карточек, даже если в нём окажется live_inputs");
    assert.equal(plain(V.detView(old).find(d=>d.id==="recovery").role),"поднимает «защитный» и «ухудшается» до «переходного» и включает пол 80 %");
  }

  // 2.5. Снимок перечитывается: 304 оставляет прежний, 200 заменяет, отказ сети не стирает экран.
  {
    let clock=1e12;const now=()=>clock,calls=[];
    const res=(status,body,etag)=>({status,ok:status>=200&&status<300,json:async()=>body,headers:{get:k=>k==="etag"?etag:null}});
    let reply=()=>res(200,{generated_at:"A"},'"a"');
    const fetchStub=async(url,opt)=>{calls.push({url,opt});return reply()};
    let st=await V.pullSnapshot({snap:null,etag:null,okAt:0,err:null},fetchStub,now);
    assert.equal(st.snap.generated_at,"A");assert.equal(st.changed,true);assert.equal(st.etag,'"a"');assert.equal(st.okAt,1e12);
    assert.match(calls[0].url,/^\.\/snapshot\.json\?ts=\d+$/);assert.equal(calls[0].opt.cache,"no-store");assert.deepEqual(calls[0].opt.headers,{});
    clock+=3e5;reply=()=>res(304,null,'"a"');st=await V.pullSnapshot(st,fetchStub,now);
    assert.deepEqual(calls[1].opt.headers,{"If-None-Match":'"a"'},"повторный запрос обязан быть условным");
    assert.equal(st.snap.generated_at,"A");assert.equal(st.changed,false);assert.equal(st.okAt,clock,"304 — это успешная сверка: метка связи обязана обновиться");
    clock+=3e5;reply=()=>{throw new Error("сеть недоступна")};st=await V.pullSnapshot(st,fetchStub,now);
    assert.equal(st.snap.generated_at,"A","отказ сети не имеет права стирать загруженный снимок");assert.equal(st.err,"сеть недоступна");assert.equal(st.okAt,clock-3e5,"метка связи не двигается на отказе");
    clock+=3e5;reply=()=>res(503,{},null);st=await V.pullSnapshot(st,fetchStub,now);assert.equal(st.err,"HTTP 503");assert.equal(st.snap.generated_at,"A");
    clock+=3e5;reply=()=>res(200,{generated_at:"B"},'"b"');st=await V.pullSnapshot(st,fetchStub,now);
    assert.equal(st.snap.generated_at,"B");assert.equal(st.changed,true);assert.equal(st.err,null);assert.equal(st.etag,'"b"');
    assert.ok(V.POLL_MS>0&&V.POLL_MS<=15*60e3,"вкладка обязана перечитывать снимок не реже, чем сервер его выпускает");
  }

  // 2.10, 2.11, 2.14 и таблица монитора.
  {
    assert.equal(plain(V.badge(-0.5)),"−0,5 слабое напряжение");assert.equal(plain(V.badge(0.5)),"+0,5 слабая поддержка");
    assert.equal(plain(V.badge(-1)),"−1 напряжение");assert.equal(plain(V.badge(2)),"+2 сильная поддержка");assert.equal(plain(V.badge(0)),"0 нейтрально");assert.equal(V.badge(null),"нет данных");
    const weak=V.cardFace({id:"system_stress",vote:true,score:-0.5,value_num:-0.5,value:"нейтрально",delta:"HY 45 б.п."});
    assert.equal(weak.value,"HY 45 б.п.","при балле ±0,5 на месте слова движка стоят числа");assert.equal(weak.delta,"");
    assert.equal(V.cardFace({id:"trend_regime",vote:true,score:2,value_num:2,value:"выше 20W и 200D",delta:"цена к 200D 15.0%"}).value,"выше 20W и 200D");
    assert.equal(V.cardFace({id:"etf_5d",vote:false,score:null,value:"-512 млн $",delta:"20-й перцентиль"}).delta,"20-й перцентиль суммы в BTC");
    assert.equal(V.num(-0.4),"0");assert.equal(V.sgn(0),"0");assert.equal(V.sgn(-41.67,1),"−41,7");assert.equal(V.sgn(25,1),"+25,0");assert.equal(V.num(null),"—");
    const now=Date.parse("2026-03-04T12:00:00.000Z"),s=mk({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    // Слово движка при ±0,5 заменяется одинаково на карточке, в строке семьи и в таблице индикаторов.
    assert.equal(V.wordOf({vote:true,score:-0.5,value_num:-0.5,value:"нейтрально"}),"слабое напряжение");assert.equal(V.wordOf({vote:true,score:0.5,value_num:0.5,value:"стабильна"}),"слабая поддержка");
    assert.equal(V.wordOf({vote:true,score:-0.5,value_num:42,value:"42-й перцентиль"}),"42-й перцентиль","числовое значение словом не подменяется");
    assert.equal(V.wordOf({vote:false,score:null,value:"+0.1%"}),"+0.1%");assert.equal(V.wordOf({vote:true,score:-1,value_num:-1,value:"сжатие"}),"сжатие");
    assert.equal(V.cardFace({id:"x",vote:true,score:0.5,value_num:0.5,value:"стабильна",delta:""}).value,"слабая поддержка","без чисел в delta на карточке стоит слово бейджа, а не слово движка");
    const fams=V.blockRows(s).flatMap(r=>r.families);
    assert.equal(fams.find(f=>f.id==="system_stress").value,"слабое напряжение","в строке семьи при −0,5 — то же слово, что на бейдже");
    assert.equal(fams.find(f=>f.id==="network_activity").value,"слабая поддержка");assert.equal(fams.find(f=>f.id==="trend_regime").value,"слово движка");
    const P=(net,sharpe,cur)=>({net_return_pct:net,sharpe_excess:sharpe,max_drawdown_pct:-3,annualized_volatility_pct:12,turnover_pct:100,transaction_cost_pct:0.1,current_target_pct:cur});
    Object.assign(s.monitoring,{target_changes:15,next_review_day:90,v2_theta:{pct:null,fixed_at_day:null},performance:{policy_v1:P(1.4,0.3,45),buy_and_hold:P(27.8,2.9,100),fixed_50:P(13.9,2.9,50),cash:P(0.9,0,0),trend_vol_25:P(14.2,2.5,58),static_theta:P(5.8,2.2,33.6),policy_v2_shadow:P(2.4,0.7,45)},
      daily:[{t:s.monitoring.started_at,nav:{policy_v1:1,buy_and_hold:1,fixed_50:1,cash:1,trend_vol_25:1}},{t:new Date(Date.parse(s.monitoring.started_at)+4*DAY).toISOString(),nav:{policy_v1:1,static_theta:1,policy_v2_shadow:1}}],
      revision_alerts:Array.from({length:100},(_,i)=>({quality_impact:i<3?"quality":"audit",detected_at:new Date(now-(100-i)*26*60e3).toISOString()}))});
    let m=V.monitorModel(s);
    assert.deepEqual(m.groups.map(g=>g.kind),["live","benchmark","candidate"],"без strategy_meta группы восстанавливаются по известным именам");
    // Линии выпуска 2.15.0. Ключ policy_v1 — боевая политика (правила v1 до выпуска, затем v3); прежние правила v1
    // ведёт policy_v1_frozen. Без strategy_meta они подписаны запасными подписями, с ним — подписями монитора.
    const s215=structuredClone(s);Object.assign(s215.monitoring.performance,{policy_v1_frozen:P(1.1,0.2,40),policy_v3_shadow:P(1.2,0.3,5)});
    const lab=id=>plain(V.monitorModel(s215).groups.flatMap(g=>g.rows).find(r=>r.id===id).label);
    assert.deepEqual(V.monitorModel(s215).groups.map(g=>g.kind),["live","benchmark","candidate","attribution"]);
    assert.deepEqual([lab("policy_v1"),lab("policy_v1_frozen"),lab("policy_v3_shadow")],["боевая политика · мгновенный переход к цели","прежние правила v1","правила v3, след с 13.10"],"запасные подписи линий не называют боевую политику «v1»");
    s215.monitoring.strategy_meta={policy_v1:{kind:"live",label:"боевая политика (v1 до выпуска 2.15.0, затем v3)"},policy_v1_frozen:{kind:"attribution",label:"прежние правила v1 (после 2.15.0)"}};
    assert.deepEqual([lab("policy_v1"),lab("policy_v1_frozen")],["боевая политика (v1 до выпуска 2.15.0, затем v3) · мгновенный переход к цели","прежние правила v1 (после 2.15.0)"],"подписи монитора главнее запасных");
    assert.match(m.groups[1].rows.find(r=>r.id==="static_theta").label,/^сглаженная доля политики, до фиксации на 90-й день · с \d\d\.\d\d$/,"static_theta до фиксации обязана быть подписана тем, что она есть");
    assert.equal(m.groups[1].rows.find(r=>r.id==="static_theta").gap,null,"стратегию с более поздним стартом нельзя сравнивать с политикой без общего окна");
    assert.ok(Math.abs(m.groups[1].rows.find(r=>r.id==="fixed_50").gap.pp-12.5)<1e-9);
    assert.equal(plain(m.revisions),"последние 100 событий за 43 ч, влияют на качество — 3","счётчик пересмотров — охват буфера, а не «зафиксировано: 100»");
    assert.ok(Math.abs(m.inv.ret-12.5)<1e-9&&m.inv.retLimit===10&&Math.abs(m.inv.sharpe-2.6)<1e-9&&m.inv.sharpeLimit===0.25&&m.inv.fromDay===180,"числа против порогов расследования");
    assert.equal(plain(V.resultText(s)),`с ${V.dm(s.monitoring.started_at)}: политика +1,4 % · 50/50 +13,9 % · BTC +27,8 %`);
    // Новая форма монитора: роли, подписи, общее окно, честный ноль тайминга.
    Object.assign(s.monitoring,{v2_theta:{pct:34.5,fixed_at_day:90},strategy_meta:{policy_v1:{kind:"live",label:"политика v1",started_at:s.monitoring.started_at},policy_v2_shadow:{kind:"candidate",label:"кандидат v2"},v1_no_cftc:{kind:"attribution",label:"v1 без CFTC"},policy_v1_tranched:{kind:"execution",label:"v1, повышения траншами"}},
      comparisons:{policy_v2_shadow:{vs:"policy_v1",days:80,net_return_gap_pp:0.98,sharpe_gap:0.36}},
      timing_null:{since_start:{from:s.monitoring.started_at,days:83.1,share_pct:32.9,policy_net_return_pct:1.43,null_net_return_pct:9.38,hodl_net_return_pct:27.82,level_pp:-18.5,timing_pp:-7.4,costs_pp:-0.4,capture_ratio:0.05}}});
    s.monitoring.performance.v1_no_cftc=P(1.6,0.3,45);s.monitoring.performance.policy_v1_tranched=P(2.3,0.6,45);
    m=V.monitorModel(s);
    assert.deepEqual(m.groups.map(g=>g.kind),["live","benchmark","candidate","attribution","execution"]);
    assert.equal(m.groups[1].rows[0].id,"timing_null","строка честного нуля обязана стоять среди ориентиров");assert.ok(Math.abs(m.groups[1].rows[0].gap.pp-7.95)<1e-9);
    assert.deepEqual(m.groups[2].rows[0].gap,{pp:0.98,days:80},"сравнение кандидата — на общем окне из monitoring.comparisons");
    assert.match(m.groups[1].rows.find(r=>r.id==="static_theta").label,/^постоянная доля Θ, зафиксирована на 90-й день/);
    assert.equal(plain(m.decomp),"Отставание от BTC 26,4 п.п.: уровень доли −18,5 · тайминг −7,4 · издержки −0,4 · захват роста BTC 5 %");
    assert.equal(plain(V.resultText(s)),`с ${V.dm(s.monitoring.started_at)}: политика +1,4 % · постоянная средняя доля +9,4 % · BTC +27,8 %`);
    // Годовой Sharpe молодой линии печатается со своей ошибкой: за трое суток она впятеро больше, чем за 84.
    s.monitoring.observation_days=84;s.monitoring.comparisons.v1_no_cftc={vs:"policy_v1",days:3.2,closed_days:3,net_return_gap_pp:0.2};s.monitoring.comparisons.policy_v2_shadow.closed_days=80;
    m=V.monitorModel(s);
    assert.equal(m.se,"2,1","ошибка годового Sharpe на окне политики — в шапке таблицы");
    assert.equal(plain(m.groups[3].rows[0].sharpe),"0,3 ± 11,0","Sharpe трёхдневной линии — со своей ошибкой");
    s.monitoring.comparisons.v1_no_cftc.closed_days=2;assert.equal(plain(V.monitorModel(s).groups[3].rows[0].sharpe),"0,3 ± 13,5","двое закрытых суток — состояние линии в первом снимке после выкладки");
    s.monitoring.comparisons.v1_no_cftc.closed_days=0;assert.equal(plain(V.monitorModel(s).groups[3].rows[0].sharpe),"0,3","без закрытых суток ошибку считать не из чего");
    s.monitoring.comparisons.v1_no_cftc.closed_days=3;
    assert.equal(plain(m.groups[2].rows[0].sharpe),"0,7","у линии с окном политики ошибка не повторяется");
    // Настоящий снимок 13.10.2026: у политики 87 дневных точек, у линии 82 закрытых суток — ошибки 2,05 и 2,11
    // округляются по-разному, но окно то же: «±» в строке не нужен. Втрое более короткое окно — нужен.
    s.monitoring.observation_days=87;s.monitoring.comparisons.policy_v2_shadow.closed_days=82;
    assert.equal(V.monitorModel(s).se,"2,0");assert.equal(plain(V.monitorModel(s).groups[2].rows[0].sharpe),"0,7","разница окон в считанные дни не печатается как своя ошибка");
    s.monitoring.comparisons.policy_v2_shadow.closed_days=30;assert.equal(plain(V.monitorModel(s).groups[2].rows[0].sharpe),"0,7 ± 3,5");
    s.monitoring.observation_days=84;s.monitoring.comparisons.policy_v2_shadow.closed_days=80;
    assert.equal(plain(m.groups[0].rows[0].sharpe),"0,3");assert.equal(m.groups[1].rows[0].sharpe,undefined,"у строки честного нуля Sharpe нет");
    // Предупреждения о данных и отметки на затронутых карточках.
    s.data_warnings=[{code:"redundancy_lost",text:"Потоки ETF идут с одного источника из трёх",affects:["etf_regime"]}];s.metrics.find(x=>x.id==="trend_regime").stale=true;
    assert.deepEqual(V.dataNotes(s),["Потоки ETF идут с одного источника из трёх","Цель посчитана на запоздавших данных: «trend_regime»"]);
    assert.deepEqual(V.warnMap(s),{etf_regime:["Потоки ETF идут с одного источника из трёх"]});
    assert.equal(V.tactOf(s),15,"такт снимков берётся из истории");
    assert.doesNotMatch(V.executionPolicySentence(),/сесси/,"у круглосуточного рынка нет сессий");
    for(const bad of [2.5,0,"3",11])assert.equal(V.executionPolicySentence({tranches:bad}),V.executionPolicySentence(),`мусорное число траншей (${bad}) в правило исполнения не попадает`);
    assert.match(V.executionPolicySentence({tranches:3,first_not_before_utc_hour:6}),/^Исполнение: вверх — тремя траншами, по одному в сутки со следующего дня, вниз — сразу/,"число траншей — из соглашения, которым монитор меряет исполнение");
    // Когда окно «с начала» закрылось (старт ушёл из дневных строк), честный ноль берётся из окна 365 дней.
    const win=s.monitoring.timing_null.since_start;s.monitoring.timing_null={since_start:null,d90:null,d180:null,d365:{...win,days:365}};
    assert.equal(plain(V.resultText(s)),"за 365 дн.: политика +1,4 % · постоянная средняя доля +9,4 % · BTC +27,8 %");
    assert.equal(V.monitorModel(s).groups[1].rows[0].label,`постоянная средняя доля политики · ${V.resultText(s).split(":")[0]}`);
    // Числа против порогов расследования — те, что опубликовал монитор; свой счёт — только без них.
    s.monitoring.health.performance_numbers={sharpe_gap_vs_best_simple_benchmark:2.63,net_return_gap_vs_fixed_50_pct_points:12.51,thresholds:{investigation:{min_days:180,sharpe_gap_vs_best_simple_benchmark:0.25,net_return_gap_vs_fixed_50_pct_points:10}}};
    assert.deepEqual(V.monitorModel(s).inv,{ret:12.51,retLimit:10,sharpe:2.63,sharpeLimit:0.25,fromDay:180});
    // Смена цели при закрытом гейте помечена в журнале.
    s.monitoring.target_change_log=[{t:new Date(now-30*HOUR).toISOString(),from_pct:20,to_pct:45,price:86198,cause:{text:"причина сервера"},gate:"closed"},{t:s.monitoring.started_at,from_pct:null,to_pct:5,kind:"start",direction:"start",cause:{text:"старт наблюдения"}}];
    assert.deepEqual(V.changeLog(s).filter(x=>x.price).map(x=>x.cause),["причина сервера · при паузе панели"]);
    assert.ok(V.changeLog(s).every(x=>Number.isFinite(x.from)&&Number.isFinite(x.to)),"запись старта (from_pct: null) сменой цели не считается");
    // Источник данных: резерв потерян, когда живых ног меньше двух; одна мёртвая из трёх тревогой не считается.
    const leg=(...ok)=>ok.map((x,i)=>({name:"нога "+i,state:x?"ok":"fail"}));
    assert.equal(V.srcState({state:"ok",legs:leg(1,1,0)}),"ok");assert.equal(V.srcState({state:"ok",legs:leg(0,1,0)}),"partial");
    assert.equal(V.srcState({state:"ok"}),"ok");assert.equal(V.srcState({state:"stale",legs:leg(1,1,1)}),"stale");assert.equal(V.srcState({state:"неведомое"}),"fail");
    // Мусор в новых полях (их пишут другие потоки) не роняет функции и не отнимает главного — цели и её истории.
    const g=mk({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    Object.assign(g,{regime_birth:"x",valuation_levels:{levels:{a:1}},data_warnings:"oops",tick_diff:7});
    Object.assign(g.monitoring,{target_change_log:[null,7,{t:"не дата",from_pct:5,to_pct:20},{from_pct:"5"}],strategy_meta:[1],comparisons:"x",timing_null:{since_start:"x"},corrections:{},revision_alerts:"x",performance:{policy_v1:null,odd:7},daily:"x",v2_theta:"x"});
    for(const f of ["changeLog","blockRows","whyOf","tactRows","dataNotes","warnMap","holdOf","overlayLines","monitorModel","levelsText","resultText","tactOf"])assert.doesNotThrow(()=>V[f](g),`VIEW.${f} упала на мусоре в новых полях`);
    assert.doesNotThrow(()=>V.triggersOf(g,now));
    assert.match(plain(V.leadOf(g,now).text),/^Цель 45 % без изменений с \d\d\.\d\d — действий нет$/,"мусор в журнале не отнимает историю из decision_events");
    // Мусорный элемент в metrics, detectors, history и дневных строках монитора (найден на испорченном входе
    // фаззера сборщика) функции экрана пропускают: цель, полосы и такт остаются.
    const j=mk({now,events:[[900,"deteriorating",20],[17*24,"transition",45]]});
    j.metrics.unshift(null,7,"x");j.detectors.unshift(null,"x");j.history.push(null,3);
    j.monitoring.daily=[null,7,{t:j.monitoring.started_at,nav:{policy_v1:1}}];j.monitoring.performance={policy_v1:{net_return_pct:1,sharpe_excess:0.2}};
    for(const f of ["blockRows","whyOf","tactRows","dataNotes","holdOf","overlayLines","monitorModel","levelsText","tactOf"])assert.doesNotThrow(()=>V[f](j),`VIEW.${f} упала на мусорном элементе массива`);
    assert.doesNotThrow(()=>V.triggersOf(j,now));assert.equal(V.tactOf(j),15,"такт считается по целым записям истории");
    assert.match(plain(V.whyOf(j).rule),/→ «переходный»$/,"мусорный элемент в карточках не отнимает вывод режима");
  }
}
// — конец раздела витрины —

// Загрузчик, переданный в loadDataset по имени, вызывается БЕЗ аргументов — если он сам
// не попросил кэш через cacheAware. Проверка появилась после того, как обратное стоило
// суток источнику золота: `loader(cached)` отдавал кэш всем подряд первым позиционным
// аргументом, а `fetchPaxgHistory(days=420)` ждёт там число. Он получил объект,
// `NOW - {}*DAY` дал NaN, цикл не выполнился ни разу — и вместо внятного отказа вышло
// «PAXG history too short: 0» при полностью живом источнике. Отказ был тихим: снимок
// продолжал публиковаться на кэше.
//
// Проверяется СИГНАТУРА, а не намерение: любой будущий загрузчик с параметром по
// умолчанию попадёт в ту же ловушку, и покраснеет здесь, а не через сутки на витрине.
{
  // Механизм обязан оставаться ЯВНЫМ. Пока вызов был безусловным, кэш доставался всем.
  assert.match(collector,/await\s*\(\s*cacheAware\s*\?\s*loader\(cached\)\s*:\s*loader\(\)\s*\)/,
    "кэш обязан передаваться загрузчику только по явному cacheAware, а не всем подряд");
  // А тот, кто его просит, обязан ждать его первым аргументом — иначе кэш снова займёт
  // чужое место, только теперь в одном загрузчике вместо всех.
  // Окно не имеет права перепрыгнуть в соседний вызов, иначе сообщение назовёт чужой
  // источник и отправит читателя чинить не то место.
  const optedIn=[...collector.matchAll(/loadDataset\(\s*"([a-z_]+)"((?:(?!loadDataset\()[\s\S]){0,600}?)cacheAware:\s*true/g)];
  assert.ok(optedIn.length>=1,"ни один источник не просит кэш — проверка ниже прошла бы впустую");
  for(const [call,key] of optedIn){
    const loader=/,\s*(fetch[A-Za-z0-9]+)\s*,/.exec(call);
    assert.ok(loader,`"${key}": загрузчик не разобран`);
    const signature=new RegExp(`async function ${loader[1]}\\(([^)]*)\\)`).exec(collector);
    assert.ok(signature,`"${key}": загрузчик ${loader[1]} объявлен не здесь`);
    assert.match(signature[1].trim(),/^cached\b/,
      `"${key}" просит cacheAware, но ${loader[1]}(${signature[1].trim()}) ждёт первым аргументом не кэш`);
  }
}

// Интервал между обращениями к источнику с квотой обязан отсчитываться от СЫРОГО прошлого
// пакета, а не от `cached`. `cached` — это результат `oldDataset`, то есть null, как только
// пакет старше ttl; отсчёт от него отключает защиту ровно в том случае, ради которого она
// написана: источник не отвечает дольше ttl, и в него начинают ломиться каждый такт.
// Ошибка тихая — снимок продолжает публиковаться, а квота кончается за один вечер.
// Вторая половина той же защиты: метка обязана переживать НЕУДАЧУ. Пока она жила только внутри
// пакета и ставилась при успехе, отказ её не обновлял — интервал переставал действовать ровно
// тогда, когда источник отвечал отказом, и в него уходил запрос каждый такт. На такте в 15 минут
// это 4 обращения в час против часовой квоты в 10: один 429 выжигал окно и продлевал сам себя
// (bitcoin-data.com завис на двое суток, 10–12.08).
{
  const guard=/if\(minFetchInterval>0&&!legNeedsRefetch\((\w+)\(key\),minFetchInterval\)\)/.exec(collector);
  assert.ok(guard,"порог между обращениями к источнику с квотой не найден");
  assert.equal(guard[1],"lastAttemptFor",
    `интервал отсчитывается от "${guard[1]}"; годен только реестр попыток — он один переживает и ttl, и отказ`);
  assert.match(collector,/const lastAttemptFor=key=>attempts\[key\]\?\?previous\?\.attempts\?\.\[key\]\?\?lastAttemptAt\(previous\?\.datasets\?\.\[key\]\|\|null\)/,
    "реестр попыток обязан читаться из прошлого снимка напрямую, без фильтра по ttl");
  // Метка ставится ДО обращения — иначе провалившаяся попытка её не поставит.
  const mark=collector.indexOf("attempts[key]=iso(NOW);"),tryStart=collector.indexOf("try{",mark);
  assert.ok(mark>0,"метка попытки не ставится вовсе");
  assert.ok(tryStart>mark&&/^\s*$/.test(collector.slice(mark+"attempts[key]=iso(NOW);".length,tryStart).replace(/\/\/[^\n]*\n/g,"").replace(/\n/g,"")),
    "между меткой попытки и try не должно быть кода: метка обязана фиксировать ПОПЫТКУ, а не её исход");
  assert.match(collector,/attempts:\{\.\.\.\(previous\?\.attempts\|\|\{\}\),\.\.\.attempts\}/,
    "реестр попыток обязан публиковаться в снимке и переноситься вперёд — иначе метка теряется между прогонами");
}
{
  // ДИАГНОСТИКА НЕ КАЧАЕТ ИСТОРИЮ. У bitview.space ограничен «вес» запроса, а проба ходит каждый
  // такт: только последняя точка (/latest), пакетные и диапазонные запросы в пробе запрещены.
  const probe=readFileSync(new URL("./probe.mjs",import.meta.url),"utf8");
  const bitview=[...probe.matchAll(/https:\/\/bitview\.space\/api\/[^"'`\s]+/g)].map(m=>m[0]);
  assert.equal(bitview.length,2,"probe.mjs: ожидались две строки bitview.space (MVRV и STH-RP)");
  for(const u of bitview)assert.ok(u.endsWith("/latest"),`probe.mjs: история ряда в диагностике запрещена (${u})`);
  assert.doesNotMatch(probe,/bitcoin-data\.com\/v1/,"probe.mjs: bitcoin-data.com больше не источник — его строки не нужны");
}
{
  // РЕЗЕРВ MVRV КОРОЧЕ COIN METRICS — ИНВАРИАНТ ГЛУБОКОГО ОКНА v2. mvrvDeepSeries берёт БОЛЕЕ
  // ДЛИННЫЙ из двух рядов, а у bitview.space история с 2010 года. Резерв длиннее Coin Metrics молча
  // перевёл бы теневой кандидат v2 на другого поставщика и другое окно при исправном основном.
  const fallbackDays=/const MVRV_FALLBACK_DAYS = (\d+)\*365;/.exec(collector);
  const cmYears=/const start=new Date\(NOW-(\d+)\*365\*DAY\)/.exec(collector);
  assert.ok(fallbackDays&&cmYears,"глубина резерва MVRV или окна Coin Metrics не найдена");
  assert.ok(Number(fallbackDays[1])<Number(cmYears[1]),`резерв MVRV (${fallbackDays[1]} г.) обязан быть короче Coin Metrics (${cmYears[1]} г.)`);
  assert.match(collector,/const mvrvDeepSeries=\[cmSeries\("CapMVRVCur"\),bcSeries\("MVRV"\)\]\.sort\(\(a,b\)=>b\.length-a\.length\)/,
    "выбор глубокого окна изменился — пересмотри инвариант глубины резерва");
  // Ряды bitview.space — только поимённо с общим абсолютным диапазоном: в ответе нет имени ряда, и
  // пакетный /bulk при смене порядка молча поменял бы местами sopr_24h и lth_sopr_24h.
  assert.doesNotMatch(collector,/bitview\.space\/api\/series\/bulk|\$\{BITVIEW_API\}\/series\/bulk/,"пакетный /bulk для bitview.space запрещён");
}
if(pageWarnings.length)console.error("Static audit: витрина споткнулась на закоммиченном снимке (не фатально):\n- "+pageWarnings.join("\n- "));
console.log(`Static audit OK: ${ids.length} DOM ids, ${lookups.length} DOM lookups, ${snap.metrics.length} metrics, ${Object.keys(snap.sources||{}).length} sources`);
