import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { allocationDecisionV1 } from "../docs/policy-v1.mjs";
import { MODEL_POLICY_V1 } from "../docs/model-policy-v1.mjs";
import { POLICY_SUITE_V1 } from "../docs/policy-suite-v1.mjs";
import { policySuiteDigestV1, sha256 } from "./forward-monitor-v1.mjs";

const DEFAULT_URL="https://ml371kl.github.io/temp-zero-inode-838/snapshot.json";
const ISSUE_TITLE="[monitor] BTC dashboard stale or invalid";
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));

export function validateSnapshotV1(snapshot,now=Date.now()){
  const issues=[];
  if(snapshot?.schema!==3)issues.push(`schema:${snapshot?.schema}`);
  const generated=Date.parse(snapshot?.generated_at||"");
  const ageHours=(now-generated)/36e5,maxAge=MODEL_POLICY_V1.forward_monitoring.operational_pause.snapshot_stale_hours;
  if(!Number.isFinite(generated))issues.push("generated_at_invalid");
  else if(ageHours<-.25)issues.push("generated_at_in_future");
  else if(ageHours>maxAge)issues.push(`snapshot_stale:${ageHours.toFixed(1)}h`);
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
    if(d.quality?.status==="paused")issues.push("decision_quality_paused");
  }
  if(snapshot?.monitoring?.health?.operational_status==="paused")issues.push(`forward_monitor_paused:${(snapshot.monitoring.health.operational_issues||[]).join(",")}`);
  const lastLog=snapshot?.monitoring?.decision_log?.at(-1);
  if(!lastLog||lastLog.decision_hash!==d?.decision_hash){issues.push("decision_log_missing_or_stale");}
  else{const copy={...lastLog};delete copy.log_hash;if(lastLog.log_hash!==sha256(copy))issues.push("decision_log_hash_mismatch");}
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

async function main(){
  const snapshot=process.env.SNAPSHOT_FILE?JSON.parse(readFileSync(process.env.SNAPSHOT_FILE,"utf8")):await fetch(process.env.SNAPSHOT_URL||DEFAULT_URL,{headers:{"cache-control":"no-cache"}}).then(async r=>{if(!r.ok)throw new Error(`snapshot HTTP ${r.status}`);return r.json()});
  const result=validateSnapshotV1(snapshot);
  await syncAlert(result);
  console.log(JSON.stringify(result,null,2));
  if(!result.ok)process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(async error=>{
  const result={ok:false,checked_at:new Date().toISOString(),issues:[`monitor_exception:${error.message}`]};
  try{await syncAlert(result)}catch(alertError){result.issues.push(`alert_exception:${alertError.message}`)}
  console.error(JSON.stringify(result,null,2));process.exitCode=1;
});
