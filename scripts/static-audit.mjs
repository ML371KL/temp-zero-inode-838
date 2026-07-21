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

// Workflow/state separation and operational invariants.
assert.match(workflow,/actions\/cache@v5/,"Actions cache missing");
assert.match(workflow,/path:\s*\.state\/cache\.json/,"internal state cache path missing");
assert.doesNotMatch(workflow,/git add[^\n]*\.state\/cache\.json/,"raw state is committed");
assert.match(workflow,/REQUIRE_LIVE:\s*["']1["']/,"strict live validation missing");

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
  "theblock.co","bitcoin-data.com","hyperliquid"
];
for(const host of requiredDocs)assert.ok(collector.includes(host),`documentation/source host missing: ${host}`);


// Strategy strip displays the signed server decision and never recomputes allocation in the browser.
assert.equal(POLICY_V1.id,"btc-allocation-policy-v1");
assert.match(html,/import \{ POLICY_V1 \} from "\.\/policy-v1\.mjs"/,"frontend policy-v1 metadata import missing");
assert.match(html,/import \{ EXECUTION_POLICY_V1 \} from "\.\/execution-policy-v1\.mjs"/,"frontend execution-policy-v1 import missing");
assert.match(html,/import \{ evaluateActionGateV1 \} from "\.\/action-gate-v1\.mjs"/,"frontend fail-closed action gate import missing");
assert.doesNotMatch(html,/allocationTargetV1|allocationDecisionV1/,"frontend must not calculate allocation");
assert.match(html,/const target=Number\.isFinite\(D\.target_pct\)/,"strategy strip must display the server target");
assert.match(html,/evaluateActionGateV1\(/,"strategy strip must use the shared fail-closed action gate");
assert.match(html,/decision:SNAP\.decision/,"strategy strip must gate the signed server decision");
assert.match(html,/operationalStatus:SNAP\.monitoring\?\.health\?\.operational_status/,"strategy strip must fail closed when operational health is not healthy");
assert.match(html,/executionPolicySentence\(\)/,"execution guidance must be rendered from the execution contract");
assert.match(html,/E\.off_cycle_rebalance_drift_pp/,"execution drift threshold must come from the execution contract");
assert.doesNotMatch(html,/больше чем на 15 п\.п\./,"execution drift threshold is duplicated as a UI literal");
assert.match(collector,/applyStrategicDetectorPolicyV1\(/,"snapshot engine must delegate detector overlays to policy-v1");
assert.match(collector,/buildDecisionRecordV1\(/,"snapshot engine must create a server decision record");
const strategyStart=html.indexOf("function renderStrategy"),strategyEnd=html.indexOf("function renderFactors",strategyStart),strategyBody=html.slice(strategyStart,strategyEnd);
const policyStatusStart=html.indexOf("function renderPolicyStatus"),policyStatusEnd=html.indexOf("function renderMonitoring",policyStatusStart),policyStatusBody=html.slice(policyStatusStart,policyStatusEnd);
assert.doesNotMatch(strategyBody,/качество .*решение|историческая перекалибровка|ступень политики, а не вероятность/,"service metadata must not clutter the action strip");
assert.match(policyStatusBody,/Историческая перекалибровка отключена/,"frozen policy explanation missing from the methodology panel");
assert.match(policyStatusBody,/отдельная policy v2/,"methodology must explain how a future policy change is versioned");
assert.match(policyStatusBody,/решение \$\{esc\(hash\)\}/,"decision audit hash must remain available in the methodology panel");
assert.match(policyStatusBody,/пересмотры старых точек временного ряда сохраняются в журнале аудита/,"methodology must distinguish current data quality from historical revision evidence");
assert.match(html,/operational_pause\.snapshot_stale_hours/,"contractual snapshot age gate missing from the strip");
assert.match(policyStatusBody,/ступень модельной аллокации, а не вероятность/,"confidence/evidence boundary missing from the methodology panel");
assert.match(html,/Forward\/OOS-наблюдение/,"forward evidence panel missing");
assert.match(html,/модельная иллюстрация, не персональная рекомендация/,"strip disclaimer missing");
// mdRender must escape BEFORE inline markdown substitution (XSS ordering).
const mdIdx=html.indexOf("function mdRender");assert.ok(mdIdx>0,"mdRender missing");
const mdBody=html.slice(mdIdx,html.indexOf("function",mdIdx+10));
assert.ok(mdBody.indexOf("esc(")>=0&&mdBody.indexOf("esc(")<mdBody.indexOf("<b>"),"mdRender must escape before markdown substitution");
// The page must re-render periodically so freshness captions and the contractual age gate stay honest.
assert.match(html,/setInterval\(\(\)=>\{if\(SNAP\)render\(\)\}/,"periodic re-render missing");
console.log(`Static audit OK: ${ids.length} DOM ids, ${lookups.length} DOM lookups, ${snap.metrics.length} metrics, ${Object.keys(snap.sources||{}).length} sources`);
