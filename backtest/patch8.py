# -*- coding: utf-8 -*-
# Final whole-dashboard audit: 23 confirmed findings fixed in one batch (v2.8.4).
import re

# ============ scripts/fetch-snapshot.mjs ============
p = 'scripts/fetch-snapshot.mjs'
src = open(p, encoding='utf8').read()

# (1) stabilize: an anchor must never outrank the candidate; risk-off streak survives outages;
#     a degraded state can never itself become the anchor (fresh deployments skip the 48h hold).
start = src.index('function stabilize(candidate,type,hard){')
end = src.index('\n}', start) + 2
new_stab = '''function stabilize(candidate,type,hard){
  const prevMeta=previous?.regime_meta?.[type]||{};
  const DEGRADED=["insufficient","emergency"];
  const prevState=previous?.regime?.[type];
  // The anchor is the last REAL regime. A degraded state never becomes the anchor itself: a fresh
  // deployment recovering from «insufficient» has no anchor, and its exit must not serve a 48h hold.
  const anchor=DEGRADED.includes(prevState)?(prevMeta.anchor||null):prevState;
  if(hard||candidate==="insufficient"||candidate==="emergency"||!previous||previous.mock)
    // Degraded snapshots keep the accumulated risk-off streak: a one-hour outage must not re-arm
    // the 2-snapshot downgrade confirmation forever under a flapping source.
    return{state:candidate,candidate,count:1,since:iso(NOW),anchor,downStreak:prevMeta.downStreak||0};
  const meta=prevMeta,count=meta.candidate===candidate?(meta.count||0)+1:1,prev=previous.regime?.[type]||candidate;
  const since=meta.candidate===candidate&&meta.since?meta.since:iso(NOW);
  const ref=DEGRADED.includes(prev)?(anchor??prev):prev;
  const sevRef=severity(ref),worse=severity(candidate)<sevRef;
  const downStreak=worse?(meta.downStreak||0)+1:0;
  // Exiting a degraded state with no real anchor is not an "upgrade" — only the 2-snapshot rule applies.
  const upgrade=severity(candidate)>sevRef&&!DEGRADED.includes(ref);
  const heldLongEnough=NOW-Date.parse(since)>=UPGRADE_HOLD_H*HOUR&&count>=UPGRADE_MIN_SNAPSHOTS;
  const adopt=(count>=2&&(!upgrade||heldLongEnough))||(worse&&downStreak>=2);
  // While an upgrade out of a degraded state is held, publish the anchor — but NEVER an anchor that
  // is better than today's candidate: degradation must not resurrect stale optimism («deterioration
  // is fast» applies to the anchor path too).
  const held=!adopt&&DEGRADED.includes(prev)&&anchor?(severity(candidate)<severity(anchor)?candidate:anchor):prev;
  const state=adopt?candidate:held;
  return{state,candidate,count,since,downStreak,anchor:DEGRADED.includes(state)?anchor:state};
}
'''
src = src[:start] + new_stab + src[end:]

# (2) USDC peg: Coinbase has no USDC-USD book (live 404) — Bitstamp is the real third leg.
old = 'async function exchangePeg(sym){const tasks=await Promise.all([settled("Coinbase",()=>request(`https://api.exchange.coinbase.com/products/${sym}-USD/ticker`,{tries:1})),settled("Kraken",()=>krakenRequest(`https://api.kraken.com/0/public/Ticker?pair=${sym}USD`)),settled("Gemini",()=>request(`https://api.gemini.com/v1/pubticker/${sym}USD`,{tries:1}))]),vals=[];for(const x of tasks){if(!x.ok){errors.push(`${sym} ${x.label}: ${x.error}`);continue;}let px=null;if(x.label==="Coinbase")px=num(x.value?.price);else if(x.label==="Gemini")px=num(x.value?.last);else px=num(Object.values(x.value?.result||{})[0]?.c?.[0]);if(finite(px)&&px>.01&&px<5)vals.push(px);else errors.push(`${sym} ${x.label}: invalid price`);}'
new = 'async function exchangePeg(sym){const tasks=await Promise.all([settled("Coinbase",()=>request(`https://api.exchange.coinbase.com/products/${sym}-USD/ticker`,{tries:1})),settled("Kraken",()=>krakenRequest(`https://api.kraken.com/0/public/Ticker?pair=${sym}USD`)),settled("Gemini",()=>request(`https://api.gemini.com/v1/pubticker/${sym}USD`,{tries:1})),\n  // Coinbase Exchange has no USDC-USD book (live 404), so Bitstamp keeps the redundancy real for BOTH pegs.\n  settled("Bitstamp",()=>request(`https://www.bitstamp.net/api/v2/ticker/${sym.toLowerCase()}usd/`,{tries:1}))]),vals=[];for(const x of tasks){if(!x.ok){errors.push(`${sym} ${x.label}: ${x.error}`);continue;}let px=null;if(x.label==="Coinbase")px=num(x.value?.price);else if(x.label==="Gemini"||x.label==="Bitstamp")px=num(x.value?.last);else px=num(Object.values(x.value?.result||{})[0]?.c?.[0]);if(finite(px)&&px>.01&&px<5)vals.push(px);else errors.push(`${sym} ${x.label}: invalid price`);}'
assert old in src, 'exchangePeg'
src = src.replace(old, new)
old = 'const out={},errors=[],urls=[SOURCE_URLS.defillama,SOURCE_URLS.coinbase,SOURCE_URLS.kraken,SOURCE_URLS.gemini];'
new = 'const out={},errors=[],urls=[SOURCE_URLS.defillama,SOURCE_URLS.coinbase,SOURCE_URLS.kraken,SOURCE_URLS.gemini,SOURCE_URLS.bitstamp];'
assert old in src, 'peg urls'
src = src.replace(old, new)

# (3) ETF cards: honest source label when the mirror/Farside actually served the data
old = 'score:etfScore,source:`The Block · ${datasetSource("market","market price")}`'
new = 'score:etfScore,source:`${datasetSource("etf","The Block")} · ${datasetSource("market","market price")}`'
assert old in src, 'etf regime label'
src = src.replace(old, new)
src = src.replace('note:"Событийный компонент; один день не меняет среднесрочный режим.",score:null,source:"The Block"',
 'note:"Событийный компонент; один день не меняет среднесрочный режим.",score:null,source:datasetSource("etf","The Block")')
src = src.replace('note:"Быстрый компонент семейства.",score:null,source:"The Block"',
 'note:"Быстрый компонент семейства.",score:null,source:datasetSource("etf","The Block")')
src = src.replace('note:"Среднесрочный компонент семейства.",score:null,source:"The Block"',
 'note:"Среднесрочный компонент семейства.",score:null,source:datasetSource("etf","The Block")')

# (4) distribution: both confirmations => fired; wording said «и/или»
old = 'logic:"Высокая накопленная прибыль (MVRV) — обязательный якорь; штраф только когда высокая оценка сопровождается ростом биржевого предложения и/или потерей ценовых опор."'
new = 'logic:"Высокая накопленная прибыль (MVRV) — обязательный якорь. Оба подтверждения (рост биржевого предложения И потеря ценовых опор) — «сработал» и ограничение вердикта сверху; одно из двух — «наблюдение»."'
assert old in src, 'distribution logic'
src = src.replace(old, new)

# (5) recovery: unify the description with its actual verdict power
old = 'logic:"Низкая циклическая оценка (MVRV) — обязательный якорь; плюс минимум два подтверждения стабилизации тренда/ETF/биржевого предложения."'
new = 'logic:"Низкая циклическая оценка (MVRV <25-го перцентиля) — обязательный якорь; плюс минимум два подтверждения стабилизации тренда/ETF/биржевого предложения. Положительный статус поднимает защитный/ухудшающийся вердикт до переходного (не действует при сработавшем макрошоке)."'
assert old in src, 'recovery logic'
src = src.replace(old, new)

# (6) spot_integrity note: it is penalty-only, there is no «положительный голос»
old = 'note:"USD-площадки (Coinbase/Kraken/Bitstamp/Gemini) и USDT-площадки (OKX/Kraken/Coinbase) сравниваются только внутри одинаковой валюты котирования. Положительный голос требует обеих полных пар; одна доступная группа может только предупредить о расхождении."'
new = 'note:"USD-площадки (Coinbase/Kraken/Bitstamp/Gemini) и USDT-площадки (OKX/Kraken/Coinbase) сравниваются только внутри одинаковой валюты котирования. Семья голосует только штрафом: ноль (отсутствие тревоги) требует обеих полных пар, одна доступная группа может лишь предупредить о расхождении."'
assert old in src, 'integrity note'
src = src.replace(old, new)

src = src.replace('const VERSION = "2.8.3";', 'const VERSION = "2.8.4";')
open(p, 'w', encoding='utf8').write(src)
print('fetch-snapshot.mjs: 6 fixes + version')

# ============ docs/index.html ============
p = 'docs/index.html'
src = open(p, encoding='utf8').read()

# (7) gauge legends: score words, not regime words (verdicts are decided by gates, not the needle)
old = '<div class="labels"><span>≤−60 защита</span><span>0 переход</span><span>≥+60 расширение</span></div>'
new = '<div class="labels"><span>≤−60 сильный негатив</span><span>0 нейтрально</span><span>≥+60 сильный позитив</span></div>'
assert old in src, 'labels s'
src = src.replace(old, new)
old = '<div class="labels"><span>≤−60 делеверидж</span><span>0 нет преимущества</span><span>≥+60 устойчивый импульс</span></div>'
new = '<div class="labels"><span>≤−60 сильное давление</span><span>0 нет преимущества</span><span>≥+60 сильная поддержка</span></div>'
assert old in src, 'labels t'
src = src.replace(old, new)

# (8) strip: valuation-gate mirror (no MVRV -> constructive/unconfirmed unreachable), recovery
#     trigger only when the anchor is plausible, score formatting parity, tactical map completeness
old = '''  if((S==="defensive"||S==="deteriorating")&&!recovGood&&!shockFired&&target<80)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>80%</b> — детектор «Восстановление» (не при макрошоке)</div>`;
  // ближайшая ЭФФЕКТИВНАЯ цель выше/ниже текущей (оверлеи могут сплющивать соседние ступени)
  let up=null;for(let k=i+1;k<ORDER.length;k++){const e=eff(ORDER[k]);if(e!=null&&e>target){up={pct:e,name:SHORT[ORDER[k]]};break;}}'''
new = '''  if((S==="defensive"||S==="deteriorating")&&!recovGood&&!shockFired&&target<80&&Number.isFinite(mvrvPct)&&mvrvPct<25)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>80%</b> — детектор «Восстановление» (не при макрошоке)</div>`;
  // ближайшая ЭФФЕКТИВНАЯ цель выше/ниже текущей (оверлеи могут сплющивать соседние ступени);
  // без данных MVRV гейт оценки в движке закрывает constructive/unconfirmed — их не обещаем
  const gateClosed=!Number.isFinite(mvrvPct);
  let up=null;for(let k=i+1;k<ORDER.length;k++){if(gateClosed&&["constructive","unconfirmed_positive"].includes(ORDER[k]))continue;const e=eff(ORDER[k]);if(e!=null&&e>target){up={pct:e,name:SHORT[ORDER[k]]};break;}}'''
assert old in src, 'strip triggers'
src = src.replace(old, new)
old = '''  if(up)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>${up.pct}%</b> — режим «${up.name}» (подтверждение ≥48 ч)</div>`;'''
new = '''  if(up)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>${up.pct}%</b> — режим «${up.name}» (подтверждение ≥48 ч)</div>`;
  else if(gateClosed&&i>=0&&i<ORDER.length-1)trig+=`<div class="t">цели выше закрыты гейтом оценки — нет данных MVRV</div>`;'''
assert old in src, 'strip gate note'
src = src.replace(old, new)
old = 'const sc=Number.isFinite(SNAP.scores?.strategic)?(SNAP.scores.strategic>0?"+":"")+Math.round(SNAP.scores.strategic):"—";'
new = 'const sc=Number.isFinite(SNAP.scores?.strategic)?(SNAP.scores.strategic>=0?"+":"")+SNAP.scores.strategic.toFixed(0):"—";'
assert old in src, 'strip score fmt'
src = src.replace(old, new)
old = 'balanced:["·","var(--soft)","Структура нейтральна. Обычная ребалансировка, вход — по среднесрочному режиму."]}'
new = 'balanced:["·","var(--soft)","Структура нейтральна. Обычная ребалансировка, вход — по среднесрочному режиму."],insufficient:["·","var(--soft)","Краткосрочная структура не рассчитана: критических данных недостаточно."],emergency:["⚠","var(--bad)","Аварийный режим рынка: не полагаться на котировки и сигналы до восстановления целостности."]}'
assert old in src, 'TW map'
src = src.replace(old, new)

# (9) page re-renders every 5 minutes: freshness captions and the 12h strategy gate stay honest in a long-lived tab
old = 'let rsz=null;addEventListener("resize",()=>{clearTimeout(rsz);rsz=setTimeout(()=>{if(SNAP){renderBlocks();drawTape();}},250)});load();'
new = 'let rsz=null;addEventListener("resize",()=>{clearTimeout(rsz);rsz=setTimeout(()=>{if(SNAP){renderBlocks();drawTape();}},250)});setInterval(()=>{if(SNAP)render()},5*60*1000);load();'
assert old in src, 'rerender interval'
src = src.replace(old, new)

# (10) AI: payload without inert detector points; prompt describes the real detector powers,
#      the ±100 scale, and markdown limits the renderer can actually display
old = 'detectors:SNAP.detectors,factors:SNAP.factors,'
new = 'detectors:SNAP.detectors.map(d=>({id:d.id,name:d.name,state:d.state,inputs:d.inputs,logic:d.logic})),factors:SNAP.factors,'
assert old in src, 'aiCompact detectors'
src = src.replace(old, new)
old = 'детекторы — нелинейные события с правом голоса. Баллы семей — от −2 до +2 полушагами.'
new = 'детекторы — нелинейные события: право голоса имеют три (макрошок и дистрибуция ограничивают вердикт сверху, восстановление поднимает защитный/ухудшающийся до переходного), остальные — предупреждающие чипы. Баллы семей — от −2 до +2 полушагами; блочные и композитные шкалы — от −100 до +100 (полосы гейтов ±20, реалистичный диапазон ≈±60).'
assert old in src, 'ai prompt head'
src = src.replace(old, new)
old = 'с умеренной структурой (заголовки/списки markdown).'
new = 'с умеренной структурой (только markdown-заголовки, **жирный** и списки — таблицы и ссылки не отрисуются).'
assert old in src, 'ai prompt md'
src = src.replace(old, new)
open(p, 'w', encoding='utf8').write(src)
print('index.html: 7 fixes')

# ============ РАЗВЁРТЫВАНИЕ.md ============
p = 'РАЗВЁРТЫВАНИЕ.md'
src = open(p, encoding='utf8').read()
old = 'Распакуйте `btc-21m-dashboard-v2.7.3.zip` в любую папку.'
new = 'Распакуйте архив релиза (`btc-21m-dashboard-v*.zip`) в любую папку.'
assert old in src, 'zip name'
src = src.replace(old, new)
old = '`.gitignore` можно не заливать — он ни на что не влияет.'
new = '`.gitignore` ОБЯЗАТЕЛЕН: workflow-test проверяет, что внутренний кэш состояния не попадает в git, и без этого файла CI не пройдёт.'
assert old in src, 'gitignore'
src = src.replace(old, new)
open(p, 'w', encoding='utf8').write(src)
print('РАЗВЁРТЫВАНИЕ.md: 2 fixes')

# ============ README.md ============
p = 'README.md'
src = open(p, encoding='utf8').read()
src = src.replace('# Сейсмостанция «21M» v2.8.3', '# Сейсмостанция «21M» v2.8.4')
old = '«Капитуляция →\n  восстановление» (дешёвый MVRV + ≥2 подтверждения; +10% за 30д, hit 0.82) поднимает\n  защитный/ухудшающийся режим до переходного.'
if old not in src:
    old = None
if old: src = src.replace(old, old)  # wording fine; distribution «и/или» lives elsewhere
m = re.search(r'ростом биржевого предложения и/или потерей ценовых опор', src)
if m:
    src = src.replace('ростом биржевого предложения и/или потерей ценовых опор',
                      'одновременно ростом биржевого предложения и потерей ценовых опор (оба условия — «сработал», одно — «наблюдение»)')
open(p, 'w', encoding='utf8').write(src)
print('README.md: version + distribution wording')

# ============ package.json ============
p = 'package.json'
src = open(p, encoding='utf8').read()
src = src.replace('"version": "2.8.3"', '"version": "2.8.4"')
open(p, 'w', encoding='utf8').write(src)
print('package.json bumped')

# ============ scripts/self-test.mjs: dead guard removed ============
p = 'scripts/self-test.mjs'
src = open(p, encoding='utf8').read()
old = '\nif(internalRaw&&staleInternal&&process.env.REQUIRE_LIVE==="1")fail.push("candidate snapshot and candidate state are out of sync");'
assert old in src, 'dead guard'
# under REQUIRE_LIVE staleInternal is always false, so this line could never fire; the line-above
# guard (hasInternal + generated_at/version match) already fails a desynced candidate pair.
src = src.replace(old, '')
open(p, 'w', encoding='utf8').write(src)
print('self-test.mjs: dead code removed')

# ============ scripts/unit-test.mjs: vacuous assertion fixed ============
p = 'scripts/unit-test.mjs'
src = open(p, encoding='utf8').read()
old = 'ok(candles[0].t<candles[1].t===false||true,"candles keep day-aligned timestamps");'
new = 'ok(candles[0].t<candles[1].t,"candles keep ascending day-aligned timestamps");'
assert old in src, 'vacuous'
src = src.replace(old, new)
open(p, 'w', encoding='utf8').write(src)
print('unit-test.mjs: vacuous assertion fixed')

# ============ probe/fred-smoke: UA derived from package.json ============
for f in ['scripts/probe.mjs', 'scripts/fred-smoke-test.mjs']:
    s = open(f, encoding='utf8').read()
    if 'PKG_VERSION' not in s:
        first_import_end = s.index('\n', s.index('import ')) if 'import ' in s else 0
        inject = '\nimport { readFileSync as __rf } from "node:fs";\nconst PKG_VERSION = JSON.parse(__rf(new URL("../package.json", import.meta.url), "utf8")).version;\n'
        s = s[:first_import_end] + inject + s[first_import_end:]
    s = s.replace('"btc-21m-dashboard/2.7.3-probe"', '"btc-21m-dashboard/"+PKG_VERSION+"-probe"')
    s = s.replace('"btc-21m-dashboard/2.7"', '"btc-21m-dashboard/"+PKG_VERSION')
    open(f, 'w', encoding='utf8').write(s)
    print(f, 'UA versioned')

# ============ static-audit: the strip and AI block get real assertions ============
p = 'scripts/static-audit.mjs'
src = open(p, encoding='utf8').read()
anchor = 'console.log(`Static audit OK:'
assert anchor in src
addition = '''
// Strategy strip: the backtested contract must stay literally in the markup.
assert.match(html,/PCT=\\{emergency:0,defensive:5,deteriorating:20,transition:45,unconfirmed_positive:95,constructive:100\\}/,"strip ladder drifted from the backtested 0/5/20/45/95/100");
assert.match(html,/recovGood&&!shockFired&&t<80/,"recovery overlay must be gated on macro_shock and capped at 80");
assert.match(html,/mvrvPct<=10&&t<40/,"capitulation floor 40 missing");
assert.match(html,/mvrvPct>=95&&t>60/,"euphoria cap 60 missing");
assert.match(html,/ageH>12/,"12h snapshot age gate missing from the strip");
assert.match(html,/модельная иллюстрация, не персональная рекомендация/,"strip disclaimer missing");
// mdRender must escape BEFORE inline markdown substitution (XSS ordering).
const mdIdx=html.indexOf("function mdRender");assert.ok(mdIdx>0,"mdRender missing");
const mdBody=html.slice(mdIdx,html.indexOf("function",mdIdx+10));
assert.ok(mdBody.indexOf("esc(")<mdBody.indexOf("replace(/\\\\*\\\\*"),"mdRender must escape before markdown substitution");
// The page must re-render periodically so freshness captions and the 12h gate stay honest.
assert.match(html,/setInterval\\(\\(\\)=>\\{if\\(SNAP\\)render\\(\\)\\}/,"periodic re-render missing");
'''
src = src.replace(anchor, addition + anchor)
open(p, 'w', encoding='utf8').write(src)
print('static-audit.mjs: strip assertions added')

# ============ negative-test: stabilize anchor semantics get executable coverage ============
p = 'scripts/negative-test.mjs'
src = open(p, encoding='utf8').read()
anchor = 'console.log("Negative validation tests OK");'
assert anchor in src
addition = '''
// stabilize(): a stale optimistic anchor must never outrank today's candidate. Craft a previous
// state that exited an outage with anchor=constructive while the mock candidate is defensive:
// the published regime must be the candidate (risk-off fast), not the resurrected anchor.
{
  const prevPath=join(tmpdir(),`btc21m-anchor-prev-${process.pid}.json`),outPath=join(tmpdir(),`btc21m-anchor-out-${process.pid}.json`),statePath2=join(tmpdir(),`btc21m-anchor-state-${process.pid}.json`);
  const old=new Date(Date.now()-3*3600e3).toISOString();
  writeFileSync(prevPath,JSON.stringify({mock:false,version:"0.0.0",generated_at:old,regime:{strategic:"insufficient",tactical:"insufficient"},regime_meta:{strategic:{candidate:"insufficient",count:3,since:old,anchor:"constructive",downStreak:0},tactical:{candidate:"insufficient",count:3,since:old,anchor:"balanced",downStreak:0}},history:[]}));
  const r=spawnSync(process.execPath,[fileURLToPath(new URL("./fetch-snapshot.mjs",import.meta.url))],{encoding:"utf8",env:{...process.env,MOCK:"1",OUT:outPath,STATE:statePath2,PREVIOUS_STATE:prevPath,PREVIOUS_PUBLIC:prevPath}});
  if(r.status!==0)throw new Error(`anchor scenario build failed:\\n${r.stdout||""}${r.stderr||""}`);
  const snap=JSON.parse(readFileSync(outPath,"utf8"));
  if(snap.regime.strategic==="constructive")throw new Error(`stale optimistic anchor resurrected: published ${snap.regime.strategic} while candidate was ${snap.regime_meta.strategic.candidate}`);
  try{unlinkSync(prevPath)}catch{}try{unlinkSync(outPath)}catch{}try{unlinkSync(statePath2)}catch{}
}
'''
src = src.replace(anchor, addition + anchor)
open(p, 'w', encoding='utf8').write(src)
print('negative-test.mjs: anchor scenario added')
