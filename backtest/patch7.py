# -*- coding: utf-8 -*-
# Strategy strip: final-audit fixes — overlay-aware triggers/lead, macro_shock gate on the recovery
# overlay, honest texts, age-guard fix, contrast, (grid overflow fix already applied locally).
p = 'docs/index.html'
src = open(p, encoding='utf8').read()

start = src.index('function renderStrategy(){')
end = src.index('function renderFactors(')
new_fn = '''function renderStrategy(){
// Лестница и оверлеи проверены walk-forward реконструкцией 2013–2026 (backtest/eval4/eval5.mjs):
// база 0/5/20/45/95/100 по среднесрочному режиму; поверх — оверлеи из публикуемых полей снимка:
// «Восстановление» (не при макрошоке — как в движке) поднимает цель до 80%, MVRV ≤10-го перцентиля
// — пол 40%, MVRV ≥95-го — потолок 60%. Оверлеи не действуют в emergency/insufficient. Триггеры и
// заголовок считаются от ЭФФЕКТИВНЫХ целей (с оверлеями), чтобы стрелки не указывали на числа
// ниже/выше уже показанной цели.
const PCT={emergency:0,defensive:5,deteriorating:20,transition:45,unconfirmed_positive:95,constructive:100};
const ORDER=["emergency","defensive","deteriorating","transition","unconfirmed_positive","constructive"];
const SHORT={emergency:"аварийный",defensive:"защитный",deteriorating:"ухудшается",transition:"переходный",unconfirmed_positive:"спрос не подтв.",constructive:"конструктивный"};
const META={constructive:{tone:"good",step:5,lead:"Держать полную позицию. Добирать ступенчато."},unconfirmed_positive:{tone:"good",step:4,lead:"Держать почти полную. Без агрессивных докупок."},transition:{tone:"neutral",step:3,lead:"Держать умеренную долю. Ждать согласования."},deteriorating:{tone:"warn",step:2,lead:"Сокращать риск. Докупки — стоп."},defensive:{tone:"bad",step:1,lead:"Держать ядро. Без плеча."},insufficient:{tone:"neutral",step:0,lead:"Держать текущую. Выводов не делать."},emergency:{tone:"bad",step:0,lead:"Убрать риск. Ждать нормализации."}};
const S=SNAP.regime?.strategic,T=SNAP.regime?.tactical,m=META[S]||META.insufficient;
const genTs=Date.parse(SNAP.generated_at||"");
const ageH=(Date.now()-genTs)/36e5;
// Снимок старше 12 часов (или без валидной даты) = конвейер молчит: уверенную цель показывать нельзя.
if(!Number.isFinite(ageH)||ageH>12){$("strategy").className="strategy";$("strategy").innerHTML=`<div class="dial"><div class="eyebrow">Модельная аллокация</div><div class="num"><div class="pct neutral">—</div></div><div class="sub">${Number.isFinite(ageH)?`снимок устарел (${Math.round(ageH)} ч)`:"время снимка неизвестно"} — целям не следовать</div></div><div class="act"><div class="lead">Держать текущую позицию.</div><div class="warnline">Конвейер данных давно не обновлялся; сверьте картину вручную, прежде чем действовать.</div></div><div class="trig"><div class="t">цель вернётся со свежим снимком</div></div><div class="foot">действие — только на смене ступени · модельная иллюстрация, не персональная рекомендация</div>`;return;}
const mvrvPct=(SNAP.metrics.find(x=>x.id==="mvrv_cycle")||{}).value_num;
const recovGood=(SNAP.detectors.find(d=>d.id==="recovery")||{}).state==="good";
const shockFired=(SNAP.detectors.find(d=>d.id==="macro_shock")||{}).state==="fired";
// эффективная цель режима = база + оверлеи (в emergency оверлеи не действуют)
const applyOvl=b=>{let t=b;
  if(recovGood&&!shockFired&&t<80)t=80;
  if(Number.isFinite(mvrvPct)&&mvrvPct<=10&&t<40)t=40;
  if(Number.isFinite(mvrvPct)&&mvrvPct>=95&&t>60)t=60;
  return t;};
const eff=reg=>reg==="emergency"?0:reg==="insufficient"?null:applyOvl(PCT[reg]);
const base=S==="insufficient"?null:PCT[S];
const target=S==="insufficient"?null:S==="emergency"?0:applyOvl(base);
const ovl=[];
if(target!=null&&S!=="emergency"){
  if(recovGood&&!shockFired&&base<80&&target>=80)ovl.push(["⤒","var(--good)","Детектор «Восстановление» подтверждён: капитуляция позади, потоки стабилизируются — цель поднята до 80%."]);
  if(recovGood&&shockFired)ovl.push(["·","var(--soft)","Детектор «Восстановление» активен, но макрошок его блокирует — цель не поднята (как и в самом движке)."]);
  if(Number.isFinite(mvrvPct)&&mvrvPct<=10&&base<40&&target>=40&&!(recovGood&&!shockFired))ovl.push(["⤒","var(--good)","Пол капитуляции: MVRV в нижнем дециле своей 4-летней истории — держать не меньше 40% (не действует только в аварийном режиме)."]);
  if(Number.isFinite(mvrvPct)&&mvrvPct>=95&&base>60)ovl.push(["⤓","var(--warn)","Потолок эйфории: MVRV ≥95-го перцентиля — не выше 60% даже при конструктивном режиме."]);
}
// lead согласован с оверлеем, который реально двигает цель
let lead=m.lead;
if(target!=null&&base!=null&&target>base)lead=recovGood&&!shockFired?"Наращивать к цели траншами: восстановление подтверждено.":"Дно цикла: держать пол капитуляции, не продавать в панику.";
const toneCol={good:"var(--good)",warn:"var(--warn)",bad:"var(--bad)",neutral:"var(--neutral)"}[m.tone];
const pctTxt=target==null?"—":target+"%";
const meter=[1,2,3,4,5].map(i=>`<i style="height:${5+(i-1)*4}px${i<=m.step?";background:"+toneCol:""}"></i>`).join("");
const TW={demand_break:["⚠","var(--bad)","Докупки на паузе: <b>маржинальный спрос сломан</b>. Не покупать откаты, ждать разворота ETF-потоков."],deleveraging:["⚠","var(--bad)","Идёт принудительный делеверидж. Апгрейды ступени не исполнять, пока OI не сброшен и funding не стабилен."],fragile:["⚠","var(--warn)","Рынок хрупок: каскад возможен без смены среднесрока. Не опережать план — исполнять цели без спешки."],overheated_supported:["⚠","var(--warn)","Не догонять цену: плечо перегрето и обычно остывает откатом. Апгрейды — только после очистки funding/OI."],short_squeeze:["↺","var(--soft)","Возможен резкий отскок, но это не разворот режима. Не наращивать сверх цели."],spot_led:["✓","var(--good)","Спот ведёт движение — исполнять апгрейды по обычному плану, частями на откатах."],balanced:["·","var(--soft)","Структура нейтральна. Обычная ребалансировка, вход — по среднесрочному режиму."]}[T]||["·","var(--soft)","Действовать по среднесрочному режиму."];
const i=ORDER.indexOf(S);let trig="";
if(S==="emergency")trig+=`<div class="t">выход — в режим по данным: два подтверждённых снимка, вверх — с задержкой гистерезиса</div>`;
else if(S==="insufficient")trig+=`<div class="t">цель появится после восстановления критических данных</div>`;
else{
  if((S==="defensive"||S==="deteriorating")&&!recovGood&&!shockFired&&target<80)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>80%</b> — детектор «Восстановление» (не при макрошоке)</div>`;
  // ближайшая ЭФФЕКТИВНАЯ цель выше/ниже текущей (оверлеи могут сплющивать соседние ступени)
  let up=null;for(let k=i+1;k<ORDER.length;k++){const e=eff(ORDER[k]);if(e!=null&&e>target){up={pct:e,name:SHORT[ORDER[k]]};break;}}
  let down=null;for(let k=i-1;k>=0;k--){const e=eff(ORDER[k]);if(e!=null&&e<target){down={pct:e,name:SHORT[ORDER[k]],em:ORDER[k]==="emergency"};break;}}
  if(up)trig+=`<div class="t"><span style="color:var(--good)">↑</span> до <b>${up.pct}%</b> — режим «${up.name}» (подтверждение ≥48 ч)</div>`;
  if(down)trig+=down.em?`<div class="t"><span style="color:var(--bad)">↓</span> до <b>0%</b> — аварийный override</div>`:`<div class="t"><span style="color:var(--bad)">↓</span> до <b>${down.pct}%</b> или ниже — ухудшение режима (вниз возможен прыжок через ступени)</div>`;
}
const sc=Number.isFinite(SNAP.scores?.strategic)?(SNAP.scores.strategic>0?"+":"")+Math.round(SNAP.scores.strategic):"—";
$("strategy").className="strategy "+m.tone;
const ovlHtml=ovl.map(o=>`<div class="warnline"><span style="color:${o[1]}">${o[0]}</span> ${o[2]}</div>`).join("");
const baseNote=target!=null&&base!=null&&target!==base?`режим даёт ${base}% · оверлей ${target>base?"поднял цель до":"опустил цель до"} ${target}%`:`доля BTC от вашего лимита <b>B</b>${m.step?" · ступень "+m.step+"/5":""}`;
$("strategy").innerHTML=`<div class="dial"><div class="eyebrow">Что делать сейчас · модельная аллокация</div><div class="num"><div class="pct ${m.tone}">${pctTxt}</div><div class="meter">${meter}</div></div><div class="sub">${baseNote}</div></div><div class="act"><div class="lead">${lead}</div>${ovlHtml}<div class="warnline"><span style="color:${TW[1]}">${TW[0]}</span> ${TW[2]}</div></div><div class="trig">${trig||'<div class="t">держать до смены режима</div>'}<div class="ctx">среднесрочный балл сейчас ${sc}${Number.isFinite(mvrvPct)?" · MVRV "+Math.round(mvrvPct)+"-й пц":""}</div></div><div class="foot">действие — на смене ступени; внепланово — если факт отклонился от цели больше чем на 15 п.п. · апгрейды исполнять траншами со следующей сессии, даунгрейды — сразу · свободный кэш — в доходный инструмент · без плеча · модельная иллюстрация, не персональная рекомендация</div>`;}
'''
src = src[:start] + new_fn + src[end:]

# contrast: load-bearing footer/context lines get the readable soft ink instead of #98a09a
old = '.strategy .ctx{font:11px var(--mono);color:#98a09a;padding-top:2px}'
new = '.strategy .ctx{font:11px var(--mono);color:var(--soft);padding-top:2px}'
assert old in src, 'ctx contrast'
src = src.replace(old, new)
old = '.strategy .foot{grid-column:1/-1;border-top:1px dotted var(--line);padding:6px 16px;font:11px var(--mono);color:#98a09a}'
new = '.strategy .foot{grid-column:1/-1;border-top:1px dotted var(--line);padding:6px 16px;font:11px var(--mono);color:var(--soft)}'
assert old in src, 'foot contrast'
src = src.replace(old, new)

open(p, 'w', encoding='utf8').write(src)
print('strip audit fixes applied')
