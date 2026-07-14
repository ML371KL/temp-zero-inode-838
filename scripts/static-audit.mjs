import { readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

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
assert.ok(statSync(new URL("../docs/snapshot.json",import.meta.url)).size<2_500_000,"public snapshot too large");
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

console.log(`Static audit OK: ${ids.length} DOM ids, ${lookups.length} DOM lookups, ${snap.metrics.length} metrics, ${Object.keys(snap.sources||{}).length} sources`);
