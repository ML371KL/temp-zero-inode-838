# -*- coding: utf-8 -*-
# Strategy strip v2 (backtested ladder + overlays + honest triggers + age gate)
# and the stabilize() hold-inheritance fix for insufficient/emergency transits.
import re

# ================= docs/index.html: renderStrategy rewrite =================
p = 'docs/index.html'
src = open(p, encoding='utf8').read()

start = src.index('function renderStrategy(){')
end = src.index('\nfunction renderFactors(')
new_fn = '''function renderStrategy(){
// Лестница и оверлеи проверены walk-forward реконструкцией 2019–2026 (backtest/eval4.mjs):
// база 0/10/20/55/90/100 по среднесрочному режиму; поверх неё три оверлея из публикуемых полей
// снимка: детектор «Восстановление» поднимает цель до 70%, MVRV ≤10-го перцентиля — пол 40%
// (капитуляция), MVRV ≥95-го — потолок 60% (эйфория). Оверлеи не применяются в emergency/insufficient.
const PCT={emergency:0,defensive:10,deteriorating:20,transition:55,unconfirmed_positive:90,constructive:100};
const ORDER=["emergency","defensive","deteriorating","transition","unconfirmed_positive","constructive"];
const SHORT={emergency:"аварийный",defensive:"защитный",deteriorating:"ухудшается",transition:"переходный",unconfirmed_positive:"спрос не подтв.",constructive:"конструктивный"};
const META={constructive:{tone:"good",step:5,lead:"Держать полную позицию. Добирать ступенчато."},unconfirmed_positive:{tone:"good",step:4,lead:"Держать почти полную. Без агрессивных докупок."},transition:{tone:"neutral",step:3,lead:"Держать половину. Ждать согласования."},deteriorating:{tone:"warn",step:2,lead:"Сокращать риск. Докупки — стоп."},defensive:{tone:"bad",step:1,lead:"Держать ядро. Без плеча."},insufficient:{tone:"neutral",step:0,lead:"Держать текущую. Выводов не делать."},emergency:{tone:"bad",step:0,lead:"Убрать риск. Ждать нормализации."}};
const S=SNAP.regime?.strategic,T=SNAP.regime?.tactical,m=META[S]||META.insufficient;
const ageH=(Date.now()-Date.parse(SNAP.generated_at||0))/36e5;
// Снимок старше 12 часов = конвейер молчит: уверенную цель показывать нельзя.
if(!Number.isFinite(ageH)||ageH>12){$("strategy").className="strategy";$("strategy").innerHTML=`<div class="dial"><div class="eyebrow">Модельная аллокация</div><div class="num"><div class="pct neutral">—</div></div><div class="sub">снимок устарел (${Number.isFinite(ageH)?Math.round(ageH):"?"} ч) — целям не следовать</div></div><div class="act"><div class="lead">Держать текущую позицию.</div><div class="warnline">Конвейер данных давно не обновлялся; сверьте картину вручную, прежде чем действовать.</div></div><div class="trig"><div class="t">цель вернётся со свежим снимком</div></div><div class="foot">действие — только на смене ступени · модельная иллюстрация, не персональная рекомендация</div>`;return;}
// оверлеи из публикуемых полей
const mvrvPct=(SNAP.metrics.find(x=>x.id==="mvrv_cycle")||{}).value_num;
const recovGood=(SNAP.detectors.find(d=>d.id==="recovery")||{}).state==="good";
const base=S==="insufficient"?null:PCT[S];
let target=base;const ovl=[];
if(target!=null&&S!=="emergency"&&S!=="insufficient"){
  if(recovGood&&target<70){target=70;ovl.push(["⤒","var(--good)","Детектор «Восстановление» подтверждён: капитуляция позади, потоки стабилизируются — цель поднята до 70%."]);}
  if(Number.isFinite(mvrvPct)&&mvrvPct<=10&&target<40){target=40;ovl.push(["⤒","var(--good)","Пол капитуляции: MVRV в нижнем дециле своей 4-летней истории — держать не меньше 40% независимо от режима."]);}
  if(Number.isFinite(mvrvPct)&&mvrvPct>=95&&target>60){target=60;ovl.push(["⤓","var(--warn)","Потолок эйфории: MVRV ≥95-го перцентиля — не выше 60% даже при конструктивном режиме."]);}
}
const toneCol={good:"var(--good)",warn:"var(--warn)",bad:"var(--bad)",neutral:"var(--neutral)"}[m.tone];
const pctTxt=target==null?"—":target+"%";
const meter=[1,2,3,4,5].map(i=>`<i style="height:${5+(i-1)*4}px${i<=m.step?";background:"+toneCol:""}"></i>`).join("");
const TW={demand_break:["⚠","var(--bad)","Докупки на паузе: <b>маржинальный спрос сломан</b>. Не покупать откаты, ждать разворота ETF-потоков."],deleveraging:["⚠","var(--bad)","Идёт принудительный делеверидж. Апгрейды ступени не исполнять, пока OI не сброшен и funding не стабилен."],fragile:["⚠","var(--warn)","Рынок хрупок: каскад возможен без смены среднесрока. Не опережать план — исполнять цели без спешки."],overheated_supported:["⚠","var(--warn)","Не догонять цену: плечо перегрето и обычно остывает откатом. Апгрейды — только после очистки funding/OI."],short_squeeze:["↺","var(--soft)","Возможен резкий отскок, но это не разворот режима. Не наращивать сверх цели."],spot_led:["✓","var(--good)","Спот ведёт движение — апгрейды можно исполнять без задержки, частями на откатах."],balanced:["·","var(--soft)","Структура нейтральна. Обычная ребалансировка, вход — по среднесрочному режиму."]}[T]||["·","var(--soft)","Действовать по среднесрочному режиму."];
const i=ORDER.indexOf(S);let trig="";
if(S==="emergency")trig+=`<div class="t">выход — в режим по данным после двух подтверждённых снимков</div>`;
else if(S==="insufficient")trig+=`<div class="t">цель появится после восстановления критических данных</div>`;
else{
  if((S==="defensive"||S==="deteriorating")&&!recovGood)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>70%</b> — детектор «Восстановление» (не при макрошоке)</div>`;
  if(i>=0&&i<ORDER.length-1)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>${PCT[ORDER[i+1]]}%</b> — режим «${SHORT[ORDER[i+1]]}» (подтверждение ≥48 ч)</div>`;
  if(i>1)trig+=`<div class="t"><span style="color:var(--bad)">↓</span> до <b>${PCT[ORDER[i-1]]}%</b> или ниже — ухудшение режима (вниз возможен прыжок через ступени)</div>`;
  else if(i===1)trig+=`<div class="t"><span style="color:var(--bad)">↓</span> до <b>0%</b> — аварийный override</div>`;
}
const sc=Number.isFinite(SNAP.scores?.strategic)?(SNAP.scores.strategic>0?"+":"")+Math.round(SNAP.scores.strategic):"—";
$("strategy").className="strategy "+m.tone;
const ovlHtml=ovl.map(o=>`<div class="warnline"><span style="color:${o[1]}">${o[0]}</span> ${o[2]}</div>`).join("");
const baseNote=target!=null&&base!=null&&target!==base?`режим даёт ${base}% · оверлей поднял/ограничил цель`:`доля BTC от вашего лимита <b>B</b>${m.step?" · ступень "+m.step+"/5":""}`;
$("strategy").innerHTML=`<div class="dial"><div class="eyebrow">Что делать сейчас · модельная аллокация</div><div class="num"><div class="pct ${m.tone}">${pctTxt}</div><div class="meter">${meter}</div></div><div class="sub">${baseNote}</div></div><div class="act"><div class="lead">${m.lead}</div>${ovlHtml}<div class="warnline"><span style="color:${TW[1]}">${TW[0]}</span> ${TW[2]}</div></div><div class="trig">${trig||'<div class="t">держать до смены режима</div>'}<div class="ctx">среднесрочный балл сейчас ${sc}${Number.isFinite(mvrvPct)?" · MVRV "+Math.round(mvrvPct)+"-й пц":""}</div></div><div class="foot">действие — только на смене ступени и при отклонении факта от цели >15 п.п. · апгрейды исполнять траншами со следующей сессии, даунгрейды — сразу · свободный кэш — в доходный инструмент · без плеча · модельная иллюстрация, не персональная рекомендация</div>`;}
'''
src = src[:start] + new_fn + src[end:]
open(p, 'w', encoding='utf8').write(src)
print('renderStrategy rewritten')

# ================= fetch-snapshot.mjs: stabilize hold inheritance =================
p = 'scripts/fetch-snapshot.mjs'
src = open(p, encoding='utf8').read()

old = """function stabilize(candidate,type,hard){
  if(hard||candidate==="insufficient"||candidate==="emergency"||!previous||previous.mock)return{state:candidate,candidate,count:1,since:iso(NOW)};
  const meta=previous.regime_meta?.[type]||{},count=meta.candidate===candidate?(meta.count||0)+1:1,prev=previous.regime?.[type]||candidate;
  const since=meta.candidate===candidate&&meta.since?meta.since:iso(NOW);"""
new = """function stabilize(candidate,type,hard){
  const prevMeta=previous?.regime_meta?.[type]||{};
  // The last REAL (non-degraded) state anchors upgrade severity: a transit through
  // insufficient/emergency (data outage) must not launder a defensive->constructive jump past the
  // 48h hold. The anchor survives in regime_meta across degraded snapshots.
  const prevState=previous?.regime?.[type];
  const anchor=["insufficient","emergency"].includes(prevState)?(prevMeta.anchor||prevState):prevState;
  if(hard||candidate==="insufficient"||candidate==="emergency"||!previous||previous.mock)return{state:candidate,candidate,count:1,since:iso(NOW),anchor};
  const meta=prevMeta,count=meta.candidate===candidate?(meta.count||0)+1:1,prev=previous.regime?.[type]||candidate;
  const since=meta.candidate===candidate&&meta.since?meta.since:iso(NOW);"""
assert old in src, 'stabilize head'
src = src.replace(old, new)

old = """  const sevPrev=severity(prev),worse=severity(candidate)<sevPrev;
  const downStreak=worse?(meta.downStreak||0)+1:0;
  const upgrade=severity(candidate)>sevPrev&&prev!=="emergency"&&prev!=="insufficient";
  const heldLongEnough=NOW-Date.parse(since)>=UPGRADE_HOLD_H*HOUR;
  const adopt=(count>=2&&(!upgrade||heldLongEnough))||(worse&&downStreak>=2);
  return{state:adopt?candidate:prev,candidate,count,since,downStreak};
}"""
new = """  // Severity is compared against the ANCHOR (last real regime), so exiting insufficient/emergency
  // into a better state still requires the hold; exiting into the same-or-worse state is fast.
  const ref=["insufficient","emergency"].includes(prev)&&anchor?anchor:prev;
  const sevPrev=severity(ref),worse=severity(candidate)<sevPrev;
  const downStreak=worse?(meta.downStreak||0)+1:0;
  const upgrade=severity(candidate)>sevPrev;
  // The hold is wall-clock AND observation-count: after a multi-day pipeline gap `since` alone
  // would let the first snapshot back adopt an upgrade instantly.
  const heldLongEnough=NOW-Date.parse(since)>=UPGRADE_HOLD_H*HOUR&&count>=UPGRADE_MIN_SNAPSHOTS;
  const adopt=(count>=2&&(!upgrade||heldLongEnough))||(worse&&downStreak>=2);
  return{state:adopt?candidate:prev,candidate,count,since,downStreak,anchor:["insufficient","emergency"].includes(adopt?candidate:prev)?anchor:(adopt?candidate:prev)};
}"""
assert old in src, 'stabilize body'
src = src.replace(old, new)

old = 'const UPGRADE_HOLD_H = 48;'
new = 'const UPGRADE_HOLD_H = 48;\n// ...and at least this many observed snapshots: wall-clock alone would let a pipeline gap skip the hold.\nconst UPGRADE_MIN_SNAPSHOTS = 12;'
assert old in src, 'const'
src = src.replace(old, new)

src = src.replace('const VERSION = "2.8.1";', 'const VERSION = "2.8.2";')
open(p, 'w', encoding='utf8').write(src)
print('stabilize patched, version 2.8.2')

# ================= version bumps =================
for f, a, b in [('package.json', '"version": "2.8.1"', '"version": "2.8.2"'),
                ('README.md', '# Сейсмостанция «21M» v2.8.1', '# Сейсмостанция «21M» v2.8.2')]:
    s = open(f, encoding='utf8').read(); assert a in s, f
    open(f, 'w', encoding='utf8').write(s.replace(a, b)); print('bumped', f)
