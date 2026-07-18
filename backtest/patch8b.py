# -*- coding: utf-8 -*-
# Remainder of the final-audit batch (engine part already applied by patch8).
import re

# ============ docs/index.html ============
p = 'docs/index.html'
src = open(p, encoding='utf8').read()

# (7) gauge legends: score words, not regime words
old = '<div class="labels"><span>≤−60 защита</span><span>0 переход</span><span>≥+60 расширение</span></div>'
new = '<div class="labels"><span>≤−60 сильный негатив</span><span>0 нейтрально</span><span>≥+60 сильный позитив</span></div>'
assert old in src, 'labels s'
src = src.replace(old, new)
old = '<div class="labels"><span>≤−60 делеверидж</span><span>0 нет преимущества</span><span>≥+60 устойчивый импульс</span></div>'
new = '<div class="labels"><span>≤−60 сильное давление</span><span>0 нет преимущества</span><span>≥+60 сильная поддержка</span></div>'
assert old in src, 'labels t'
src = src.replace(old, new)

# (8a) recovery trigger only when the anchor is plausible (MVRV <25th pct, data present)
old = 'if((S==="defensive"||S==="deteriorating")&&!recovGood&&!shockFired&&target<80)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>80%</b> — детектор «Восстановление» (не при макрошоке)</div>`;'
new = 'if((S==="defensive"||S==="deteriorating")&&!recovGood&&!shockFired&&target<80&&Number.isFinite(mvrvPct)&&mvrvPct<25)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>80%</b> — детектор «Восстановление» (не при макрошоке)</div>`;'
assert old in src, 'recovery trigger anchor'
src = src.replace(old, new)

# (8b) valuation-gate mirror: MISSING MVRV also closes constructive/unconfirmed in the engine
old = 'const gateBlocked=reg=>Number.isFinite(mvrvPct)&&mvrvPct>=82&&(reg==="constructive"||reg==="unconfirmed_positive");'
new = 'const gateBlocked=reg=>(reg==="constructive"||reg==="unconfirmed_positive")&&(!Number.isFinite(mvrvPct)||mvrvPct>=82);'
assert old in src, 'gateBlocked'
src = src.replace(old, new)

# (8c) explain the empty up-trigger when the valuation gate is the reason
old = 'if(up)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>${up.pct}%</b> — режим «${up.name}» (подтверждение ≥48 ч)</div>`;'
new = 'if(up)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>${up.pct}%</b> — режим «${up.name}» (подтверждение ≥48 ч)</div>`;\n  else if(i>=0&&i<ORDER.length-1&&gateBlocked(ORDER[ORDER.length-1]))trig+=`<div class="t">цели выше закрыты гейтом оценки (${Number.isFinite(mvrvPct)?"MVRV ≥82-го пц":"нет данных MVRV"})</div>`;'
assert old in src, 'gate note'
src = src.replace(old, new)

# (8d) score formatting parity with fmtScore (toFixed half-away-from-zero, not Math.round)
old = 'const sc=Number.isFinite(SNAP.scores?.strategic)?(SNAP.scores.strategic>0?"+":"")+Math.round(SNAP.scores.strategic):"—";'
assert old in src, 'sc fmt'
new = 'const sc=Number.isFinite(SNAP.scores?.strategic)?(SNAP.scores.strategic>=0?"+":"")+SNAP.scores.strategic.toFixed(0):"—";'
src = src.replace(old, new)

# (8e) tactical map completeness
old = 'balanced:["·","var(--soft)","Структура нейтральна. Обычная ребалансировка, вход — по среднесрочному режиму."]}'
assert old in src, 'TW'
new = 'balanced:["·","var(--soft)","Структура нейтральна. Обычная ребалансировка, вход — по среднесрочному режиму."],insufficient:["·","var(--soft)","Краткосрочная структура не рассчитана: критических данных недостаточно."],emergency:["⚠","var(--bad)","Аварийный режим рынка: не полагаться на котировки и сигналы до восстановления целостности."]}'
src = src.replace(old, new)

# (9) periodic re-render (freshness captions + 12h age gate honest in a long-lived tab)
old = 'let rsz=null;addEventListener("resize",()=>{clearTimeout(rsz);rsz=setTimeout(()=>{if(SNAP){renderBlocks();drawTape();}},250)});load();'
assert old in src, 'interval'
new = 'let rsz=null;addEventListener("resize",()=>{clearTimeout(rsz);rsz=setTimeout(()=>{if(SNAP){renderBlocks();drawTape();}},250)});setInterval(()=>{if(SNAP)render()},5*60*1000);load();'
src = src.replace(old, new)

# (10) AI payload/prompt fixes
old = 'detectors:SNAP.detectors,factors:SNAP.factors,'
assert old in src, 'aiCompact'
new = 'detectors:SNAP.detectors.map(d=>({id:d.id,name:d.name,state:d.state,inputs:d.inputs,logic:d.logic})),factors:SNAP.factors,'
src = src.replace(old, new)
old = 'детекторы — нелинейные события с правом голоса. Баллы семей — от −2 до +2 полушагами.'
assert old in src, 'prompt head'
new = 'детекторы — нелинейные события: право голоса имеют три (макрошок и дистрибуция ограничивают вердикт сверху, восстановление поднимает защитный/ухудшающийся до переходного), остальные — предупреждающие чипы. Баллы семей — от −2 до +2 полушагами; блочные и композитные шкалы — от −100 до +100 (полосы гейтов ±20, реалистичный диапазон ≈±60).'
src = src.replace(old, new)
old = 'с умеренной структурой (заголовки/списки markdown).'
assert old in src, 'prompt md'
new = 'с умеренной структурой (только markdown-заголовки, **жирный** и списки — таблицы и ссылки не отрисуются).'
src = src.replace(old, new)
open(p, 'w', encoding='utf8').write(src)
print('index.html done')

# ============ РАЗВЁРТЫВАНИЕ.md ============
p = 'РАЗВЁРТЫВАНИЕ.md'
src = open(p, encoding='utf8').read()
old = 'Распакуйте `btc-21m-dashboard-v2.7.3.zip` в любую папку.'
assert old in src, 'zip'
src = src.replace(old, 'Распакуйте архив релиза (`btc-21m-dashboard-v*.zip`) в любую папку.')
old = '`.gitignore` можно не заливать — он ни на что не влияет.'
assert old in src, 'gitignore'
src = src.replace(old, '`.gitignore` ОБЯЗАТЕЛЕН: workflow-test проверяет, что внутренний кэш состояния игнорируется гитом, — без этого файла CI не пройдёт.')
open(p, 'w', encoding='utf8').write(src)
print('РАЗВЁРТЫВАНИЕ.md done')

# ============ README.md ============
p = 'README.md'
src = open(p, encoding='utf8').read()
src = src.replace('# Сейсмостанция «21M» v2.8.3', '# Сейсмостанция «21M» v2.8.4')
if 'ростом биржевого предложения и/или потерей ценовых опор' in src:
    src = src.replace('ростом биржевого предложения и/или потерей ценовых опор',
                      'одновременно ростом биржевого предложения и потерей ценовых опор (оба условия — «сработал», одно — «наблюдение»)')
open(p, 'w', encoding='utf8').write(src)
print('README.md done')

# ============ package.json ============
p = 'package.json'
src = open(p, encoding='utf8').read()
src = src.replace('"version": "2.8.3"', '"version": "2.8.4"')
open(p, 'w', encoding='utf8').write(src)
print('package.json done')

# ============ self-test dead guard ============
p = 'scripts/self-test.mjs'
src = open(p, encoding='utf8').read()
old = '\nif(internalRaw&&staleInternal&&process.env.REQUIRE_LIVE==="1")fail.push("candidate snapshot and candidate state are out of sync");'
assert old in src, 'dead guard'
src = src.replace(old, '')
open(p, 'w', encoding='utf8').write(src)
print('self-test done')

# ============ unit-test vacuous ============
p = 'scripts/unit-test.mjs'
src = open(p, encoding='utf8').read()
old = 'ok(candles[0].t<candles[1].t===false||true,"candles keep day-aligned timestamps");'
assert old in src, 'vacuous'
src = src.replace(old, 'ok(candles[0].t<candles[1].t,"candles keep ascending day-aligned timestamps");')
open(p, 'w', encoding='utf8').write(src)
print('unit-test done')

# ============ probe / fred-smoke UA ============
for f in ['scripts/probe.mjs', 'scripts/fred-smoke-test.mjs']:
    s = open(f, encoding='utf8').read()
    if 'PKG_VERSION' not in s:
        nl = s.index('\n')
        inject = '\nimport { readFileSync as __rf } from "node:fs";\nconst PKG_VERSION = JSON.parse(__rf(new URL("../package.json", import.meta.url), "utf8")).version;\n'
        s = s[:nl] + inject + s[nl:]
    s = s.replace('"btc-21m-dashboard/2.7.3-probe"', '"btc-21m-dashboard/"+PKG_VERSION+"-probe"')
    s = s.replace('"btc-21m-dashboard/2.7"', '"btc-21m-dashboard/"+PKG_VERSION')
    assert 'btc-21m-dashboard/2.7' not in s, f
    open(f, 'w', encoding='utf8').write(s)
    print(f, 'done')

# ============ static-audit assertions ============
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
assert.ok(mdBody.indexOf("esc(")>=0&&mdBody.indexOf("esc(")<mdBody.indexOf("<b>"),"mdRender must escape before markdown substitution");
// The page must re-render periodically so freshness captions and the 12h gate stay honest.
assert.match(html,/setInterval\\(\\(\\)=>\\{if\\(SNAP\\)render\\(\\)\\}/,"periodic re-render missing");
'''
src = src.replace(anchor, addition + anchor)
open(p, 'w', encoding='utf8').write(src)
print('static-audit done')

# ============ negative-test: stabilize anchor scenario ============
p = 'scripts/negative-test.mjs'
src = open(p, encoding='utf8').read()
anchor = 'console.log("Negative validation tests OK");'
assert anchor in src
addition = '''
// stabilize(): a stale optimistic anchor must never outrank today's candidate. Craft a previous
// state that sat in an outage with anchor=constructive while the mock candidate is defensive:
// the published regime must follow the candidate (risk-off is fast), not the resurrected anchor.
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
print('negative-test done')
