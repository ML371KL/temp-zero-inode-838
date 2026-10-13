// Стенд «запись — воспроизведение» для сборщика: один и тот же вход двум версиям кода.
//
// ЗАЧЕМ. Чтобы доказать, что правка не изменила живое решение, обе версии сборщика должны получить
// одни и те же ответы источников и одно и то же «сейчас». В бою это невозможно: ответы бирж меняются
// каждую секунду. Стенд записывает ответы fetch на диск и потом отдаёт их вместо сети, а часы
// замораживает на моменте записи.
//
// КАК ПОЛЬЗОВАТЬСЯ (bash; каталог записи — вне репозитория; TZ=UTC — как на сервере):
//   export TZ=UTC COLLECTOR_REPLAY_DIR=/tmp/rec1
//   # 1. Запись: сборщик идёт в сеть, каждый ответ сохраняется. Часы заморожены на старте.
//   COLLECTOR_REPLAY=record  OUT=/tmp/a.json STATE=/tmp/a.state.json PREVIOUS_STATE=<прошлое состояние> \
//     node --import ./scripts/collector-replay.mjs scripts/fetch-snapshot.mjs
//   # 2. Воспроизведение тем же кодом: сети нет вовсе. Результат обязан совпасть с записью.
//   COLLECTOR_REPLAY=replay  OUT=/tmp/b.json STATE=/tmp/b.state.json PREVIOUS_STATE=<то же> \
//     node --import ./scripts/collector-replay.mjs scripts/fetch-snapshot.mjs
//   node scripts/collector-replay.mjs same /tmp/a.json /tmp/b.json          # детерминизм
//   # 3. Другая версия кода на той же записи. Если она ходит по адресам, которых в записи нет
//   #    (новый контракт, новый набор данных), — «дозапись»: записанное берётся с диска, недостающее
//   #    один раз скачивается и добавляется в запись; часы — те же, из записи.
//   COLLECTOR_REPLAY=append  OUT=/tmp/c.json STATE=/tmp/c.state.json PREVIOUS_STATE=<то же> \
//     node --import <путь к этому файлу> <другое дерево>/scripts/fetch-snapshot.mjs
//   node scripts/collector-replay.mjs compare /tmp/b.json /tmp/c.json       # решение и баллы
//
// ЧТО ЛЕЖИТ В ЗАПИСИ. manifest.json (момент записи, ключ запроса → очередь ответов) и bodies/*.bin.
// Ключ запроса — метод, адрес и хэш тела; значения параметров api_key, apikey, key, token и
// access_token в адресе заменяются на REDACTED до записи. Заголовки запроса (в них ездит ключ
// SosoValue) не сохраняются вовсе. Повторный запрос того же адреса получает следующий ответ из
// очереди — так воспроизводятся и повторы после отказа.
//
// ЧЕГО СТЕНД НЕ ДЕЛАЕТ. Не подменяет файловую систему и таймеры: паузы сборщика (доли секунды между
// порциями истории) остаются настоящими. Порядок ключей в sources и datasets зависит от того, какой
// загрузчик закончил раньше, поэтому сравнение идёт по содержимому, а не по байтам (команда same).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MODE=process.env.COLLECTOR_REPLAY||"",DIR=process.env.COLLECTOR_REPLAY_DIR||"";
const SECRET_PARAMS=new Set(["api_key","apikey","key","token","access_token"]);
const sha=value=>createHash("sha256").update(value).digest("hex");

function redactUrl(raw){
  try{
    const url=new URL(raw);
    for(const name of [...url.searchParams.keys()])if(SECRET_PARAMS.has(name.toLowerCase()))url.searchParams.set(name,"REDACTED");
    return url.toString();
  }catch{return String(raw);}
}
function requestKey(input,init){
  const url=typeof input==="string"?input:input?.url??String(input),method=String(init?.method||"GET").toUpperCase();
  const body=init?.body==null?"":" #"+sha(typeof init.body==="string"?init.body:JSON.stringify(init.body)).slice(0,16);
  return `${method} ${redactUrl(url)}${body}`;
}

if(MODE){
  if(!["record","append","replay"].includes(MODE))throw new Error(`COLLECTOR_REPLAY: неизвестный режим «${MODE}» (record | append | replay)`);
  if(!DIR)throw new Error("COLLECTOR_REPLAY_DIR не задан");
  const manifestPath=join(DIR,"manifest.json"),bodiesDir=join(DIR,"bodies");
  mkdirSync(bodiesDir,{recursive:true});
  const RealDate=Date,realFetch=globalThis.fetch;
  let manifest;
  if(MODE==="record"){
    if(existsSync(manifestPath))throw new Error(`в ${DIR} уже есть запись: для дозаписи — COLLECTOR_REPLAY=append, для новой — другой каталог`);
    manifest={version:1,now:RealDate.now(),recorded_at:new RealDate().toISOString(),tz:process.env.TZ||null,entries:{},bodies:0};
  }else{
    if(!existsSync(manifestPath))throw new Error(`в ${DIR} нет записи (manifest.json)`);
    manifest=JSON.parse(readFileSync(manifestPath,"utf8"));
  }
  const save=()=>writeFileSync(manifestPath,JSON.stringify(manifest,null,1));
  save();
  // Часы заморожены во всех трёх режимах: запись обязана давать ровно тот же результат, что и
  // воспроизведение, а адреса части запросов (окна свечей, DVOL) строятся от «сейчас».
  const frozen=manifest.now;
  globalThis.Date=class extends RealDate{
    constructor(...args){if(!args.length)super(frozen);else super(...args);}
    static now(){return frozen;}
  };
  const served=new Map(); // ключ → сколько ответов уже отдано в этом процессе
  const rebuild=entry=>{
    if(entry.error){const e=new Error(entry.error.message);e.name=entry.error.name||"TypeError";throw e;}
    const nullBody=[101,204,205,304].includes(entry.status);
    return new Response(nullBody?null:readFileSync(join(bodiesDir,entry.file)),{status:entry.status,headers:entry.headers||{}});
  };
  globalThis.fetch=async(input,init={})=>{
    const key=requestKey(input,init),queue=manifest.entries[key]||[],index=served.get(key)||0;
    served.set(key,index+1);
    if(index<queue.length)return rebuild(queue[index]);
    if(MODE==="replay"){
      // Очередь исчерпана — отдаётся последний записанный ответ; адреса в записи нет — это отказ
      // сети, и он обязан быть заметен: молча придуманный ответ обесценил бы сравнение.
      if(queue.length)return rebuild(queue.at(-1));
      appendFileSync(join(DIR,"misses.log"),`${key}\n`);
      throw new TypeError("fetch failed");
    }
    let entry;
    try{
      const response=await realFetch(input,init),buffer=Buffer.from(await response.arrayBuffer());
      const file=`${String(++manifest.bodies).padStart(4,"0")}.bin`;
      writeFileSync(join(bodiesDir,file),buffer);
      const headers={};
      for(const name of ["content-type","retry-after"]){const value=response.headers.get(name);if(value!==null)headers[name]=value;}
      entry={status:response.status,headers,file,bytes:buffer.length};
    }catch(error){
      entry={error:{name:String(error?.name||"TypeError"),message:String(error?.message||error)}};
    }
    (manifest.entries[key]??=[]).push(entry);
    save();
    return rebuild(entry);
  };
}

// ---------------------------------------------------------------------------------------------
// Команды сравнения.
// ---------------------------------------------------------------------------------------------
const stable=value=>value===null||typeof value!=="object"?JSON.stringify(value??null):Array.isArray(value)?`[${value.map(stable).join(",")}]`:`{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
function deepDiff(a,b,path="$",out=[],limit=200){
  if(out.length>=limit)return out;
  if(stable(a)===stable(b))return out;
  const objects=a&&b&&typeof a==="object"&&typeof b==="object"&&Array.isArray(a)===Array.isArray(b);
  if(!objects){out.push({path,a,b});return out;}
  if(Array.isArray(a)){
    // Массивы записей с идентификатором сравниваются по нему, остальные — по позиции.
    const idOf=x=>x&&typeof x==="object"?(x.id??x.name??null):null;
    if(a.every(x=>idOf(x)!==null)&&b.every(x=>idOf(x)!==null)){
      const A=new Map(a.map(x=>[idOf(x),x])),B=new Map(b.map(x=>[idOf(x),x]));
      for(const id of new Set([...A.keys(),...B.keys()]))deepDiff(A.get(id),B.get(id),`${path}[${id}]`,out,limit);
    }else{
      if(a.length!==b.length)out.push({path:`${path}.length`,a:a.length,b:b.length});
      for(let i=0;i<Math.min(a.length,b.length);i++)deepDiff(a[i],b[i],`${path}[${i}]`,out,limit);
    }
    return out;
  }
  for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort())deepDiff(a[key],b[key],`${path}.${key}`,out,limit);
  return out;
}
const short=value=>{const text=stable(value);return text.length>110?text.slice(0,107)+"…":text;};
// Решающая часть снимка: то, что обязано остаться прежним при тех же входах.
function decisionView(s){
  const families={};
  for(const [block,b] of Object.entries(s.blocks||{}))for(const horizon of ["strategic","tactical"])
    for(const [family,score] of Object.entries(b?.[horizon]?.families||{}))families[`${block}.${family}.${horizon}`]=score;
  const d=s.decision||{};
  return{
    regime:s.regime,regime_meta:s.regime_meta,
    decision:{status:d.status,strategic:d.strategic,tactical:d.tactical,base_target_pct:d.base_target_pct,target_pct:d.target_pct,
      regime_targets_pct:d.regime_targets_pct,binding_overlays:d.binding_overlays,reason_codes:d.reason_codes,inputs:d.inputs,
      state_hash:d.state_hash,policy_hash:d.policy_hash,critical_coverage_ok:d.quality?.critical_coverage_ok},
    families,
    voting:Object.fromEntries((s.metrics||[]).filter(m=>m.vote).map(m=>[m.id,m.score])),
    blocks:Object.fromEntries(Object.entries(s.blocks||{}).map(([k,b])=>[k,{strategic:b?.strategic?.score??null,tactical:b?.tactical?.score??null,strategic_coverage:b?.strategic?.coverage??null,tactical_coverage:b?.tactical?.coverage??null}])),
    scores:{strategic:s.scores?.strategic,tactical:s.scores?.tactical,critical_coverage_ok:s.scores?.critical_coverage_ok},
    detectors:Object.fromEntries((s.detectors||[]).map(x=>[x.id,x.state])),
    monitor:{policy_v1:s.monitoring?.strategies?.policy_v1,target_changes:s.monitoring?.target_changes,state_changes:s.monitoring?.state_changes,
      decision_log_length:s.monitoring?.decision_log?.length,started_at:s.monitoring?.started_at},
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [command,pathA,pathB]=process.argv.slice(2);
  if(!["same","compare"].includes(command)||!pathA||!pathB){
    console.error("использование: node scripts/collector-replay.mjs same <a.json> <b.json> | compare <a.json> <b.json>");process.exit(2);
  }
  const A=JSON.parse(readFileSync(pathA,"utf8")),B=JSON.parse(readFileSync(pathB,"utf8"));
  if(command==="same"){
    // Детерминизм: два прогона одного кода на одной записи обязаны дать одно содержимое.
    const diff=deepDiff(A,B);
    if(!diff.length){console.log(`идентичны по содержимому: sha256 ${sha(stable(A)).slice(0,16)}`);process.exit(0);}
    console.log(`различий: ${diff.length}${diff.length>=200?"+":""}`);
    for(const d of diff.slice(0,40))console.log(`  ${d.path}: ${short(d.a)} → ${short(d.b)}`);
    process.exit(1);
  }
  // compare: решение и баллы — обязаны совпасть; остальное печатается перечнем для чтения.
  const decisive=deepDiff(decisionView(A),decisionView(B));
  console.log(decisive.length?`РЕШАЮЩАЯ ЧАСТЬ РАЗЛИЧАЕТСЯ (${decisive.length}):`:"решающая часть совпала: regime, regime_meta, decision (цель, оверлеи, входы, state_hash), баллы 20 голосующих семей, блоки, детекторы, NAV и счётчики монитора");
  for(const d of decisive)console.log(`  ${d.path}: ${short(d.a)} → ${short(d.b)}`);
  const rest=deepDiff(A,B,"$",[],5000);
  const top={};for(const d of rest){const key=d.path.split(/[.\[]/).slice(1,3).join(".");(top[key]??=[]).push(d);}
  console.log(`\nвсе различия по разделам (${rest.length}):`);
  for(const [key,list] of Object.entries(top).sort())console.log(`  ${key.padEnd(38)} ${String(list.length).padStart(4)}  например ${list[0].path.slice(0,70)}: ${short(list[0].a).slice(0,48)} → ${short(list[0].b).slice(0,48)}`);
  const cards=(A.metrics||[]).map(m=>{const n=(B.metrics||[]).find(x=>x.id===m.id);return n&&(m.score!==n.score||m.value!==n.value||m.delta!==n.delta)?`  ${m.id.padEnd(22)} балл ${m.score}→${n.score} · «${m.value}» → «${n.value}» · «${m.delta}» → «${n.delta}»`:null;}).filter(Boolean);
  console.log(`\nкарточки с изменившимся баллом, значением или подписью (${cards.length}):`);for(const line of cards)console.log(line);
  process.exit(decisive.length?1:0);
}
