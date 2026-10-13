// Разовый засев истории форвард-монитора при переходе с версии 2.13.0 (аудит 2026-10-10).
//
// Новые поля монитора (журнал смен цели, старты линий, путь доли политики, краткосрочное состояние
// в дневных строках) должны появиться не «с сегодняшнего дня», а за всё окно с 19.07.2026: иначе
// первый экран три месяца показывал бы пустой журнал, а честный ноль тайминга считался бы по
// обрезанному окну. Всё, что можно вывести из самого состояния (список событий решения полон с
// генезиса), выводится из него; то, чего в состоянии нет, — цены, причины и старты линий — лежит
// здесь статичной таблицей, собранной из git-истории снимков и таблицы 4.3 отчёта аудита.
//
// Засев идемпотентен и применяется по данным, а не по флагу: каждая часть сама видит, что уже
// сделана. Таблица сверяется с `decision_events` состояния; строка, которой события не
// подтверждают, не применяется и попадает в `monitoring.backfill`. На чужом состоянии (тесты,
// будущий генезис) таблица не применяется вовсе — работают только общие правила.

import { POLICY_V1 } from "../docs/policy-v1.mjs";
import { POLICY_V2_CANDIDATE } from "../docs/policy-v2-candidate.mjs";
import { TARGET_CHANGE_LOG_LIMIT, targetChangeRecordV1 } from "./monitor-changes-v1.mjs";

const DAY=86_400_000;
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const round=(x,d)=>Number(Number(x).toFixed(d));
const deepFreeze=value=>{if(value&&typeof value==="object"&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;};

// Род и подпись каждой линии монитора. kind: live — живая политика; benchmark — ориентир;
// candidate — теневой кандидат; attribution — «v1 с одной правкой»; execution — исполнение по правилу панели.
export const STRATEGY_REGISTRY_V1=deepFreeze({
  policy_v1:{kind:"live",label:"политика v1"},
  previous_policy_shadow:{kind:"benchmark",label:"прежняя политика v0"},
  buy_and_hold:{kind:"benchmark",label:"BTC купить и держать"},
  fixed_50:{kind:"benchmark",label:"постоянные 50 %"},
  cash:{kind:"benchmark",label:"кэш"},
  trend_vol_25:{kind:"benchmark",label:"тренд и волатильность 25 %"},
  policy_v2_shadow:{kind:"candidate",label:"кандидат v2"},
  static_theta:{kind:"benchmark",label:"static Θ, прежний ноль"},
  policy_v3_shadow:{kind:"candidate",label:"кандидат v3"},
  v1_daily_close:{kind:"attribution",label:"v1 по суточному фиксу"},
  v1_floor_handoff:{kind:"attribution",label:"v1, пол до провала подтверждений"},
  v1_no_cftc:{kind:"attribution",label:"v1 без CFTC"},
  policy_v1_tranched:{kind:"execution",label:"v1, исполнение траншами"},
});
export const strategyKindV1=name=>STRATEGY_REGISTRY_V1[name]?.kind||"benchmark";

const GENESIS="2026-07-19T06:30:22.915Z",GENESIS_PRICE=64686.945;
// Тень v2 и static_theta рождены выпуском 2.13.0 — на трое суток позже монитора. Опорные числа
// policy_v1 и кэша на этот прогон нужны, чтобы сравнивать линии на ОБЩЕМ окне.
const V2_BIRTH={started_at:"2026-07-22T09:03:56.510Z",start_price:65957.36499999999,base:{cash_nav:1.0003213264864799,policy_v1_nav:0.9990021521827205,policy_v1_target_pct:80}};

export const MONITOR_BACKFILL_V1=deepFreeze({
  table:"2026-10-10",
  monitor_started_at:GENESIS,
  strategies:{
    policy_v1:{started_at:GENESIS,start_price:GENESIS_PRICE,start_target_pct:5},
    previous_policy_shadow:{started_at:GENESIS,start_price:GENESIS_PRICE,start_target_pct:10},
    buy_and_hold:{started_at:GENESIS,start_price:GENESIS_PRICE,start_target_pct:100},
    fixed_50:{started_at:GENESIS,start_price:GENESIS_PRICE,start_target_pct:50},
    cash:{started_at:GENESIS,start_price:GENESIS_PRICE,start_target_pct:0},
    trend_vol_25:{started_at:GENESIS,start_price:GENESIS_PRICE,start_target_pct:0},
    policy_v2_shadow:{...V2_BIRTH,start_target_pct:20},
    static_theta:{...V2_BIRTH,start_target_pct:27.5},
  },
  // Графт 21.07.2026 восстановил пик policy_v1 по дневным точкам новой эры и потерял её
  // внутридневной пик (14:51 UTC, 1,0051986546 в склеенной шкале). До 21.08 опубликованный пик был
  // занижен на 0,118 % NAV, и рекорд просадки 11.08 19:08 UTC записан как −3,657 % вместо −3,708 %.
  // Верное число — NAV 0,9679247812819466 против настоящего пика 1,0051986546063107.
  drawdown_correction:{field:"strategies.policy_v1.max_drawdown_pct",from:-3.656930649291834,to:-3.70811014853204,reason:"графт 21.07 потерял внутридневной пик",graft_commit:"5165340"},
  // Сутки, в которые градуированный пол тени v2 держал её цель выше базовой ступени хотя бы на одном
  // прогоне (лента снимков): два эпизода, 23–24.07 и 09–12.08. По одним закрытиям дня первый эпизод
  // не виден вовсе — пол действовал 23.07 00:00–05:51 и 24.07 00:00–02:51 UTC.
  v2_floor_days:["2026-07-23","2026-07-24","2026-08-09","2026-08-10","2026-08-11","2026-08-12"],
  // Шестнадцать смен цели 19.07–23.09.2026: время и цена — снимок смены; причина режима — снимок
  // рождения принятого кандидата, причина оверлея — разница со снимком до смены (отчёт аудита, 4.3).
  target_changes:[
    {"t":"2026-07-19T06:30:22.915Z","from_pct":null,"to_pct":5,"direction":"start","price":64686.945,"strategic_from":null,"strategic_to":"defensive","overlays_from":[],"overlays_to":[],"kind":"start","cause":{"text":"старт наблюдения: режим «защитный»","families":[],"detectors":[],"candidate_since":null}},
    {"t":"2026-07-21T01:51:00.411Z","from_pct":5,"to_pct":20,"direction":"up","price":65258.18,"strategic_from":"defensive","strategic_to":"deteriorating","overlays_from":[],"overlays_to":[],"kind":"regime","cause":{"text":"режим «защитный» → «ухудшается»: истекли 48 ч удержания, входы не менялись","families":[],"detectors":[],"candidate_since":"2026-07-19T01:50:51.009Z"}},
    {"t":"2026-07-22T02:51:10.456Z","from_pct":20,"to_pct":80,"direction":"up","price":66295.35,"strategic_from":"deteriorating","strategic_to":"deteriorating","overlays_from":[],"overlays_to":["recovery_floor"],"kind":"overlay","cause":{"text":"пол восстановления включён: биржевое предложение BTC −0,5 → 0","families":[{"block":"demand","family":"exchange_supply","id":"exchange_supply","name":"Биржевое предложение BTC","from":-0.5,"to":0}],"detectors":[{"id":"recovery","from":"watch","to":"good"}],"candidate_since":null}},
    {"t":"2026-07-24T02:51:08.267Z","from_pct":80,"to_pct":45,"direction":"down","price":64942.09,"strategic_from":"transition","strategic_to":"transition","overlays_from":["recovery_floor"],"overlays_to":[],"kind":"overlay","cause":{"text":"пол восстановления снят: биржевое предложение BTC 0 → −0,5","families":[{"block":"demand","family":"exchange_supply","id":"exchange_supply","name":"Биржевое предложение BTC","from":0,"to":-0.5}],"detectors":[{"id":"recovery","from":"good","to":"watch"}],"candidate_since":null}},
    {"t":"2026-07-24T03:15:33.769Z","from_pct":45,"to_pct":5,"direction":"down","price":65304.955,"strategic_from":"transition","strategic_to":"defensive","overlays_from":[],"overlays_to":[],"kind":"regime","cause":{"text":"блок «Спрос» ушёл в неблагоприятную полосу: стейблкоин-ликвидность −1 → −1,5, биржевое предложение BTC 0 → −0,5; детектор «Восстановление»: подтверждён → наблюдение","families":[{"block":"demand","family":"stablecoins","id":"stablecoin_regime","name":"Стейблкоин-ликвидность","from":-1,"to":-1.5},{"block":"demand","family":"exchange_supply","id":"exchange_supply","name":"Биржевое предложение BTC","from":0,"to":-0.5}],"detectors":[{"id":"recovery","from":"good","to":"watch"}],"candidate_since":"2026-07-24T02:51:08.267Z"}},
    {"t":"2026-08-06T11:51:00.877Z","from_pct":5,"to_pct":20,"direction":"up","price":64548.82,"strategic_from":"defensive","strategic_to":"deteriorating","overlays_from":[],"overlays_to":[],"kind":"regime","cause":{"text":"блок «Цикл» вышел из неблагоприятной полосы: старший ценовой тренд −2 → −1","families":[{"block":"cycle","family":"trend","id":"trend_regime","name":"Старший ценовой тренд","from":-2,"to":-1}],"detectors":[],"candidate_since":"2026-08-04T10:51:25.729Z"}},
    {"t":"2026-08-07T01:44:23.134Z","from_pct":20,"to_pct":5,"direction":"down","price":64323.634999999995,"strategic_from":"deteriorating","strategic_to":"defensive","overlays_from":[],"overlays_to":[],"kind":"regime","cause":{"text":"блок «Цикл» ушёл в неблагоприятную полосу: безопасность сети −0,5 → −1,5","families":[{"block":"cycle","family":"network","id":"network_security","name":"Безопасность сети","from":-0.5,"to":-1.5}],"detectors":[],"candidate_since":"2026-08-07T00:51:00.019Z"}},
    {"t":"2026-08-08T02:38:50.503Z","from_pct":5,"to_pct":80,"direction":"up","price":64887.23,"strategic_from":"defensive","strategic_to":"defensive","overlays_from":[],"overlays_to":["recovery_floor"],"kind":"overlay","cause":{"text":"пол восстановления включён: биржевое предложение BTC −0,5 → 0","families":[{"block":"demand","family":"exchange_supply","id":"exchange_supply","name":"Биржевое предложение BTC","from":-0.5,"to":0}],"detectors":[{"id":"recovery","from":"watch","to":"good"}],"candidate_since":null}},
    {"t":"2026-08-12T01:53:54.436Z","from_pct":80,"to_pct":45,"direction":"down","price":63788.494999999995,"strategic_from":"transition","strategic_to":"transition","overlays_from":["recovery_floor"],"overlays_to":[],"kind":"overlay","cause":{"text":"пол восстановления снят: биржевое предложение BTC 0 → −1,5","families":[{"block":"demand","family":"exchange_supply","id":"exchange_supply","name":"Биржевое предложение BTC","from":0,"to":-1.5}],"detectors":[{"id":"recovery","from":"good","to":"watch"}],"candidate_since":null}},
    {"t":"2026-08-12T02:08:54.116Z","from_pct":45,"to_pct":5,"direction":"down","price":63806.744999999995,"strategic_from":"transition","strategic_to":"defensive","overlays_from":[],"overlays_to":[],"kind":"regime","cause":{"text":"блок «Спрос» ушёл в неблагоприятную полосу: биржевое предложение BTC 0 → −1,5; детектор «Восстановление»: подтверждён → наблюдение","families":[{"block":"demand","family":"exchange_supply","id":"exchange_supply","name":"Биржевое предложение BTC","from":0,"to":-1.5}],"detectors":[{"id":"recovery","from":"good","to":"watch"}],"candidate_since":"2026-08-12T01:53:54.436Z"}},
    {"t":"2026-08-18T00:53:47.659Z","from_pct":5,"to_pct":20,"direction":"up","price":64315.43,"strategic_from":"defensive","strategic_to":"deteriorating","overlays_from":[],"overlays_to":[],"kind":"regime","cause":{"text":"блок «Цикл» вышел из неблагоприятной полосы: безопасность сети −0,5 → 0","families":[{"block":"cycle","family":"network","id":"network_security","name":"Безопасность сети","from":-0.5,"to":0}],"detectors":[],"candidate_since":"2026-08-16T00:38:49.388Z"}},
    {"t":"2026-08-19T20:53:48.466Z","from_pct":20,"to_pct":80,"direction":"up","price":69115.565,"strategic_from":"deteriorating","strategic_to":"deteriorating","overlays_from":[],"overlays_to":["recovery_floor"],"kind":"overlay","cause":{"text":"пол восстановления включён: старший ценовой тренд −1 → 2","families":[{"block":"cycle","family":"trend","id":"trend_regime","name":"Старший ценовой тренд","from":-1,"to":2}],"detectors":[{"id":"recovery","from":"watch","to":"good"}],"candidate_since":null}},
    {"t":"2026-08-20T03:53:47.973Z","from_pct":80,"to_pct":20,"direction":"down","price":69158.25,"strategic_from":"deteriorating","strategic_to":"deteriorating","overlays_from":["recovery_floor"],"overlays_to":[],"kind":"overlay","cause":{"text":"пол восстановления снят: перцентиль MVRV 19,5 → 27,2, якорь «оценка низкая» потерян через 7 ч","families":[],"detectors":[{"id":"recovery","from":"good","to":"calm"}],"candidate_since":null}},
    {"t":"2026-08-23T02:08:50.439Z","from_pct":20,"to_pct":45,"direction":"up","price":77105.91500000001,"strategic_from":"deteriorating","strategic_to":"transition","overlays_from":[],"overlays_to":[],"kind":"regime","cause":{"text":"блок «Спрос» вышел из неблагоприятной полосы: стейблкоин-ликвидность −1 → −0,5, биржевое предложение BTC −0,5 → 0","families":[{"block":"demand","family":"stablecoins","id":"stablecoin_regime","name":"Стейблкоин-ликвидность","from":-1,"to":-0.5},{"block":"demand","family":"exchange_supply","id":"exchange_supply","name":"Биржевое предложение BTC","from":-0.5,"to":0}],"detectors":[],"candidate_since":"2026-08-21T02:08:47.320Z"}},
    {"t":"2026-09-16T02:08:44.363Z","from_pct":45,"to_pct":20,"direction":"down","price":75563.325,"strategic_from":"transition","strategic_to":"deteriorating","overlays_from":[],"overlays_to":[],"kind":"regime","cause":{"text":"блок «Спрос» ушёл в неблагоприятную полосу: биржевое предложение BTC 0 → −0,5","families":[{"block":"demand","family":"exchange_supply","id":"exchange_supply","name":"Биржевое предложение BTC","from":0,"to":-0.5}],"detectors":[],"candidate_since":"2026-09-16T01:53:44.750Z"}},
    {"t":"2026-09-23T07:39:19.463Z","from_pct":20,"to_pct":45,"direction":"up","price":86197.93,"strategic_from":"deteriorating","strategic_to":"transition","overlays_from":[],"overlays_to":[],"kind":"regime","cause":{"text":"блок «Спрос» вышел из неблагоприятной полосы: потоки спотовых ETF −0,5 → 0; 20–21.09 отсчёт 48 ч пять раз обнулялся встречным снимком","families":[{"block":"demand","family":"etf","id":"etf_regime","name":"US spot-ETF · режим потоков","from":-0.5,"to":0}],"detectors":[],"candidate_since":"2026-09-21T07:24:19.700Z"}},
  ],
});

// Путь исполненной доли политики по событиям решения. Цель кусочно-постоянна между событиями;
// событие без цели (insufficient) держит прежнюю долю — так же, как сам монитор.
export function policyPathFromEventsV1(events){
  const path=[];let held=0;
  for(const event of Array.isArray(events)?events:[]){
    const t=Date.parse(event?.t);if(!finite(t))continue;
    if(finite(event.target_pct))held=clamp(Number(event.target_pct),0,100);
    path.push({t,target:held,strategic:event.strategic??null,tactical:event.tactical??null,binding_overlays:Array.isArray(event.binding_overlays)?event.binding_overlays:[],finite:finite(event.target_pct)});
  }
  return path;
}
// Список событий полон с генезиса: первое событие — прогон старта, а счётчик смен состояния равен
// числу событий без первого. При усечении списка (лимит 1000 событий) точный путь из него уже не
// восстановить; к этому времени монитор ведёт путь сам, прогон за прогоном (strategies.*.gross_nav
// и exposure_pct_days, `path` в дневных строках), и события ему больше не нужны.
export function decisionEventsCompleteV1(monitor){
  const events=monitor?.decision_events;
  return Array.isArray(events)&&events.length>0&&events[0].t===monitor.started_at&&events.length===Number(monitor.state_changes)+1;
}
// Накопленная доля (доля·сутки) и множитель издержек (вход и все смены цели) на момент t.
function pathStateAt(path,t,costRate){
  let exposure=0,costs=1,previous=0;
  for(let i=0;i<path.length&&path[i].t<=t;i++){
    costs*=1-Math.abs(path[i].target-previous)/100*costRate;previous=path[i].target;
    const until=i+1<path.length?Math.min(path[i+1].t,t):t;
    exposure+=path[i].target*Math.max(0,until-path[i].t)/DAY;
  }
  return{exposure,costs};
}
const stateAt=(path,t)=>{let found=null;for(const point of path){if(point.t<=t)found=point;else break;}return found;};

export function applyMonitorBackfillV1(monitor,{at,costRate}){
  const table=MONITOR_BACKFILL_V1,ours=monitor.started_at===table.monitor_started_at;
  const events=monitor.decision_events||[],complete=decisionEventsCompleteV1(monitor),path=complete?policyPathFromEventsV1(events):[];
  // 1. Старты и род линий. Для чужого состояния — что видно из дневных строк.
  monitor.strategy_meta=monitor.strategy_meta&&typeof monitor.strategy_meta==="object"?monitor.strategy_meta:{};
  for(const name of Object.keys(monitor.strategies||{})){
    if(monitor.strategy_meta[name])continue;
    const known=ours?table.strategies[name]:null,registry=STRATEGY_REGISTRY_V1[name]||{kind:"benchmark",label:name};
    if(known){monitor.strategy_meta[name]={started_at:known.started_at,kind:registry.kind,label:registry.label,start_price:known.start_price,start_target_pct:known.start_target_pct,...(known.base?{base:{...known.base}}:{})};continue;}
    const firstRow=(monitor.daily||[]).find(row=>finite(row.nav?.[name])),fromGenesis=!firstRow||firstRow===monitor.daily[0];
    monitor.strategy_meta[name]={started_at:fromGenesis?monitor.started_at:firstRow.t,kind:registry.kind,label:registry.label,start_price:null,start_target_pct:null,approximate:true};
  }
  // 2. Путь политики: накопленная доля и валовой NAV — точно из событий. Проверка тождеством:
  // вход и сумма модулей смен по событиям обязаны дать опубликованный оборот; иначе события и
  // исполненный путь расходятся (пауза решения), и засев по ним был бы неверным.
  const policy=monitor.strategies?.policy_v1;
  if(policy&&policy.gross_nav===undefined&&path.length){
    const turnover=path.reduce((sum,point,i)=>sum+Math.abs(point.target-(i?path[i-1].target:0)),0);
    const last=Date.parse(monitor.last_at);
    if(Math.abs(turnover-Number(policy.turnover_pct))<1e-6&&finite(last)){
      const now=pathStateAt(path,last,costRate);
      policy.gross_nav=Number(policy.nav)/now.costs;policy.exposure_pct_days=now.exposure;
      for(const row of monitor.daily||[]){
        const t=Date.parse(row.t);
        if(row.path?.policy_v1||!finite(row.nav?.policy_v1)||!finite(t)||t<path[0].t)continue;
        const state=pathStateAt(path,t,costRate);
        row.path={...(row.path||{}),policy_v1:[round(state.exposure,4),round(Number(row.nav.policy_v1)/state.costs,9)]};
      }
      // Опорные числа policy_v1 на рождение более поздних линий.
      for(const meta of Object.values(monitor.strategy_meta)){
        const t=Date.parse(meta.started_at);
        if(!meta.base||finite(meta.base.policy_v1_gross)||!finite(meta.base.policy_v1_nav)||!finite(t))continue;
        const state=pathStateAt(path,t,costRate);
        meta.base.policy_v1_w_days=state.exposure;meta.base.policy_v1_gross=Number(meta.base.policy_v1_nav)/state.costs;
      }
    }
  }
  // 3. Дневные строки прежней формы: краткосрочное состояние — из событий; признак «пол тени
  // держал цель в эти сутки» — из таблицы, а на чужом состоянии — по закрытию дня (цель тени на
  // ступени пола и выше базовой ступени лестницы режима).
  if(path.length){
    const rung1=POLICY_V2_CANDIDATE.floor_ladder_pct[0],floorDays=new Set(ours?table.v2_floor_days:[]);
    for(const row of monitor.daily||[]){
      if(row.tactical!==undefined)continue;
      const state=stateAt(path,Date.parse(row.t));if(!state)continue;
      const shadow=row.targets?.policy_v2_shadow,base=POLICY_V1.ladder[state.strategic];
      if(floorDays.has(row.date)||(finite(shadow)&&Number(shadow)>=rung1&&finite(base)&&Number(shadow)>Number(base)))row.v2_floor=true;
      row.tactical=state.tactical;
    }
  }
  // 4. Журнал смен цели: каждая смена — из событий; цена и причина — из таблицы, если строка
  // таблицы совпала с событием (время, цель до и после). Несовпавшие строки не применяются.
  if(!Array.isArray(monitor.target_change_log)&&path.length){
    const byTime=new Map((ours?table.target_changes:[]).map(row=>[row.t,row])),log=[],unconfirmed=new Set(byTime.keys());
    let previous=null,seeded=0;
    for(const point of path){
      if(!point.finite)continue;
      const decision={target_pct:point.target,strategic:point.strategic,binding_overlays:point.binding_overlays};
      const record=targetChangeRecordV1({at:new Date(point.t).toISOString(),price:null,previous,decision});
      if(record){
        const row=byTime.get(record.t);
        if(row&&row.to_pct===record.to_pct&&row.from_pct===record.from_pct){log.push(structuredClone(row));unconfirmed.delete(record.t);seeded++;}else log.push(record);
      }
      previous=decision;
    }
    monitor.target_change_log=log.slice(-TARGET_CHANGE_LOG_LIMIT);
    monitor.backfill={...(monitor.backfill||{}),table:table.table,applied_at:at,target_changes:{from_events:log.length,from_table:seeded,table_rows_unconfirmed:[...unconfirmed]}};
  }
  // 5. Просадка policy_v1 после графта — только пока в состоянии стоит именно то число, которое
  // оставил графт: более глубокая просадка, случившаяся позже, уже посчитана от верного пика.
  const fix=table.drawdown_correction;
  if(ours&&policy&&monitor.graft?.archive_source_commit===fix.graft_commit&&Math.abs(Number(policy.max_drawdown_pct)-fix.from)<1e-9){
    policy.max_drawdown_pct=fix.to;
    monitor.corrections=[...(monitor.corrections||[]),{t:at,field:fix.field,from:fix.from,to:fix.to,reason:fix.reason}].slice(-20);
  }
  return monitor;
}
