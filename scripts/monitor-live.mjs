import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { POLICY_SUITE_V1 } from "../docs/policy-suite-v1.mjs";
import { evaluateActionGateV1 } from "../docs/action-gate-v1.mjs";
import { policySuiteDigestV1, sha256, verifyDecisionLogChainV1 } from "./forward-monitor-v1.mjs";

const DEFAULT_URL="https://ml371kl.github.io/temp-zero-inode-838/snapshot.json";
const ISSUE_TITLE="[monitor] BTC dashboard stale or invalid";
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));
const PACKAGE_VERSION=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version;
const PUBLISHED_ASSETS=["index.html","policy-v1.mjs","model-policy-v1.mjs","execution-policy-v1.mjs","policy-suite-v1.mjs","action-gate-v1.mjs","policy-v2-candidate.mjs"];
const normalizedAsset=text=>String(text).replace(/\r\n/g,"\n");

export async function validatePublishedAssetsV1(snapshotUrl,fetchImpl=fetch){
  const issues=[];
  for(const name of PUBLISHED_ASSETS){
    const url=new URL(name,snapshotUrl);
    try{
      const response=await fetchImpl(url,{headers:{"cache-control":"no-cache"}});
      if(!response.ok){issues.push(`asset_http:${name}:${response.status}`);continue;}
      const remote=normalizedAsset(await response.text()),local=normalizedAsset(readFileSync(new URL(`../docs/${name}`,import.meta.url),"utf8"));
      if(sha256(remote)!==sha256(local))issues.push(`asset_content_mismatch:${name}`);
    }catch(error){issues.push(`asset_fetch_failed:${name}:${error.message}`);}
  }
  return{ok:issues.length===0,issues,checked_assets:PUBLISHED_ASSETS.length};
}

export function validateSnapshotV1(snapshot,now=Date.now()){
  const issues=[];
  if(snapshot?.schema!==3)issues.push(`schema:${snapshot?.schema}`);
  const generated=Date.parse(snapshot?.generated_at||"");
  const ageHours=(now-generated)/36e5,maxAge=MODEL_POLICY_V1.forward_monitoring.operational_pause.snapshot_stale_hours;
  // Окно релиза: бамп версии в main опережает переопубликование страницы на один цикл коллектора.
  // Свежий рассинхрон версий — штатная гонка, а не инцидент; протухший — реальная проблема.
  if(snapshot?.version!==PACKAGE_VERSION&&!(ageHours<=1.5))issues.push(`snapshot_version_mismatch:${snapshot?.version||"missing"}:${PACKAGE_VERSION}`);
  const actionGate=evaluateActionGateV1({generatedAt:snapshot?.generated_at,now,staleLimitHours:maxAge,decision:snapshot?.decision,operationalStatus:snapshot?.monitoring?.health?.operational_status});
  if(actionGate.code==="time_invalid")issues.push("generated_at_invalid");
  else if(actionGate.code==="snapshot_in_future")issues.push("generated_at_in_future");
  else if(actionGate.code==="snapshot_stale")issues.push(`snapshot_stale:${ageHours.toFixed(1)}h`);
  const expectedPolicyHash=policySuiteDigestV1();
  if(POLICY_SUITE_V1.contract_sha256!==expectedPolicyHash)issues.push("local_policy_contract_mismatch");
  if(snapshot?.policy_suite?.contract_sha256!==expectedPolicyHash)issues.push("snapshot_policy_contract_mismatch");
  const d=snapshot?.decision;
  if(!d)issues.push("decision_missing");
  else{
    if(d.policy_id!==POLICY_SUITE_V1.id||d.policy_hash!==expectedPolicyHash)issues.push("decision_policy_mismatch");
    const copy={...d};delete copy.decision_hash;
    if(d.decision_hash!==sha256(copy))issues.push("decision_hash_mismatch");
    const reproduced=allocationDecisionV1({strategic:d.inputs?.strategic,recoveryState:d.inputs?.recovery_state,macroShockState:d.inputs?.macro_shock_state,mvrvPercentile:d.inputs?.mvrv_percentile});
    if(reproduced.status!==d.status||reproduced.base_target_pct!==d.base_target_pct||reproduced.target_pct!==d.target_pct||JSON.stringify(reproduced.binding_overlays)!==JSON.stringify(d.binding_overlays))issues.push("decision_reproduction_failure");
    if(d.status==="actionable"&&!finite(d.target_pct))issues.push("actionable_target_missing");
    if(d.status!=="actionable")issues.push("decision_not_actionable");
    if(!["good","degraded"].includes(d.quality?.status))issues.push("decision_quality_not_actionable");
  }
  if(snapshot?.monitoring?.health?.operational_status!=="healthy")issues.push(`forward_monitor_not_healthy:${(snapshot?.monitoring?.health?.operational_issues||[]).join(",")}`);
  const lastLog=snapshot?.monitoring?.decision_log?.at(-1);
  if(!lastLog||lastLog.decision_hash!==d?.decision_hash){issues.push("decision_log_missing_or_stale");}
  else{
    // «Append-only» обязан проверяться по ВСЕЙ retained-цепи: валидатор одной последней записи
    // пропускал переписывание, усечение и полную замену прошлого (подтверждено мутациями в аудите).
    const chain=verifyDecisionLogChainV1(snapshot.monitoring.decision_log);
    if(!chain.ok)issues.push(`decision_log_chain_invalid:${chain.issues.slice(0,3).join("|")}`);
  }
  const vintage=snapshot?.source_vintages;
  if(!vintage?.sources||vintage.contract_sha256!==sha256(vintage.sources))issues.push("source_vintage_contract_invalid");
  return{ok:issues.length===0,checked_at:new Date(now).toISOString(),generated_at:snapshot?.generated_at||null,age_hours:Number.isFinite(ageHours)?ageHours:null,issues,decision_hash:d?.decision_hash||null};
}

async function githubRequest(path,{method="GET",body}={}){
  const token=process.env.GITHUB_TOKEN,repo=process.env.GITHUB_REPOSITORY;
  if(!token||!repo)return null;
  const r=await fetch(`https://api.github.com/repos/${repo}${path}`,{method,headers:{Accept:"application/vnd.github+json",Authorization:`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"btc-policy-monitor"},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw new Error(`GitHub API ${r.status}: ${(await r.text()).slice(0,300)}`);
  return r.status===204?null:r.json();
}

async function syncAlert(result){
  if(process.env.MONITOR_ALERT!=="1")return;
  const issues=await githubRequest("/issues?state=open&per_page=100");
  if(!issues)return;
  const open=issues.find(x=>!x.pull_request&&x.title===ISSUE_TITLE);
  if(!result.ok){
    const body=`Проверка ${result.checked_at} не пройдена.\n\n\`\`\`json\n${JSON.stringify(result,null,2)}\n\`\`\``;
    if(open)await githubRequest(`/issues/${open.number}/comments`,{method:"POST",body:{body}});
    else await githubRequest("/issues",{method:"POST",body:{title:ISSUE_TITLE,body,labels:["bug"]}}).catch(()=>githubRequest("/issues",{method:"POST",body:{title:ISSUE_TITLE,body}}));
  }else if(open){
    await githubRequest(`/issues/${open.number}/comments`,{method:"POST",body:{body:`Восстановлено: проверка ${result.checked_at} прошла; decision ${result.decision_hash?.slice(0,12)||"—"}.`}});
    await githubRequest(`/issues/${open.number}`,{method:"PATCH",body:{state:"closed",state_reason:"completed"}});
  }
}

// Регресс started_at против опорной копии = потеря состояния монитора (класс инцидента 2026-07-21:
// молчаливый генезис уничтожил 58-записный журнал, и ни одна проверка этого не заметила). Опора —
// последний закоммиченный docs/snapshot.json из checkout самого сторожа: живой снимок может быть
// только РАВЕН ему или ПРОДОЛЖАТЬ его цепь, но никогда — начинать более молодую.
export function monitorResetIssues(liveMonitoring,referenceMonitoring){
  const issues=[];
  const liveStarted=Date.parse(liveMonitoring?.started_at||""),refStarted=Date.parse(referenceMonitoring?.started_at||"");
  if(referenceMonitoring&&!liveMonitoring){issues.push("monitor_state_lost");return issues;}
  // Эталон НОВЕЕ живой страницы = окно деплоя (свежий коммит ещё не раздан Pages/CDN), а не сброс:
  // настоящая молчаливая потеря состояния всегда даёт live.updated_at >= reference.updated_at.
  // Без этого гарда первый же тик сторожа после пуша графта открывал ложный инцидент (ревью 2026-07-21).
  const liveUpdated=Date.parse(liveMonitoring?.updated_at||""),refUpdated=Date.parse(referenceMonitoring?.updated_at||"");
  if(Number.isFinite(liveUpdated)&&Number.isFinite(refUpdated)&&refUpdated>liveUpdated)return issues;
  if(Number.isFinite(liveStarted)&&Number.isFinite(refStarted)&&liveStarted>refStarted)issues.push(`monitor_state_reset:${liveMonitoring.started_at}>${referenceMonitoring.started_at}`);
  const freshReset=(liveMonitoring?.reset_events||[]).at(-1);
  if(freshReset&&Date.now()-Date.parse(freshReset.t)<26*36e5)issues.push(`monitor_reset_event:${freshReset.t}:${freshReset.reason}`);
  // Непрерывность append-only между прогонами: голова опорной цепи обязана присутствовать в живой
  // (по log_hash либо по original_log_hash после явного графта-рестейтмента) — если её время всё ещё
  // внутри retained-окна живого лога. Отсутствие = усечение или переписывание прошлого.
  const referenceHead=(referenceMonitoring?.decision_log||[]).at(-1);
  const liveLog=liveMonitoring?.decision_log||[];
  if(referenceHead&&liveLog.length){
    const known=new Set(liveLog.flatMap(x=>[x.log_hash,x.original_log_hash].filter(Boolean)));
    const windowCovers=Date.parse(liveLog[0].t||"")<=Date.parse(referenceHead.t||"");
    if(windowCovers&&!known.has(referenceHead.log_hash))issues.push(`decision_log_history_rewritten:${referenceHead.t}`);
  }
  return issues;
}

async function main(){
  const snapshotUrl=process.env.SNAPSHOT_URL||DEFAULT_URL;
  const snapshot=process.env.SNAPSHOT_FILE?JSON.parse(readFileSync(process.env.SNAPSHOT_FILE,"utf8")):await fetch(snapshotUrl,{headers:{"cache-control":"no-cache"}}).then(async r=>{if(!r.ok)throw new Error(`snapshot HTTP ${r.status}`);return r.json()});
  const result=validateSnapshotV1(snapshot);
  if(!process.env.SNAPSHOT_FILE||process.env.MONITOR_REPO_SNAPSHOT){
    try{
      const referencePath=process.env.MONITOR_REPO_SNAPSHOT||new URL("../docs/snapshot.json",import.meta.url);
      const reference=JSON.parse(readFileSync(referencePath,"utf8"));
      result.issues.push(...monitorResetIssues(snapshot?.monitoring,reference?.monitoring));
      result.ok=result.issues.length===0;
    }catch{}
  }
  if(!process.env.SNAPSHOT_FILE||process.env.DASHBOARD_BASE_URL){
    const assets=await validatePublishedAssetsV1(process.env.DASHBOARD_BASE_URL?new URL("snapshot.json",process.env.DASHBOARD_BASE_URL).href:snapshotUrl);
    // Окно релиза: свежий рассинхрон версий (checkout новее ещё-не-передеплоенной страницы) делает
    // расхождения/404 ассетов той же самой гонкой деплоя, а не инцидентом — новый файл появится
    // на Pages первым же прогоном публикации. Протухшая страница теряет этот грейс вместе с версионным.
    const releaseWindow=snapshot?.version!==PACKAGE_VERSION&&(Date.now()-Date.parse(snapshot?.generated_at||""))/36e5<=1.5;
    const assetIssues=releaseWindow?[]:assets.issues;
    result.asset_checks=assets.checked_assets;result.issues.push(...assetIssues);
    if(releaseWindow&&assets.issues.length)result.release_window_suppressed_assets=assets.issues;
    result.ok=result.issues.length===0;
  }
  await syncAlert(result);
  console.log(JSON.stringify(result,null,2));
  if(!result.ok)process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(async error=>{
  const result={ok:false,checked_at:new Date().toISOString(),issues:[`monitor_exception:${error.message}`]};
  try{await syncAlert(result)}catch(alertError){result.issues.push(`alert_exception:${alertError.message}`)}
  console.error(JSON.stringify(result,null,2));process.exitCode=1;
});
