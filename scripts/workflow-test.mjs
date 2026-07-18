import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
const y=readFileSync(new URL("../.github/workflows/snapshot.yml",import.meta.url),"utf8");
assert.match(y,/cron:\s*"23 \* \* \* \*"/,"hourly schedule missing");
assert.match(y,/actions\/checkout@v6/);
assert.match(y,/actions\/setup-node@v6/);
assert.match(y,/actions\/cache@v5/,"internal state must use Actions cache");
assert.match(y,/path:\s*\.state\/cache\.json/,"state cache path missing");
assert.match(y,/restore-keys:[\s\S]*btc21m-state-/,"rolling state restore key missing");
assert.match(y,/node-version:\s*24/);
assert.match(y,/package-manager-cache:\s*false/,"automatic package-manager cache must stay disabled");
assert.match(y,/timeout-minutes:\s*30/,"job timeout must stay bounded (30m covers the worst-case retry budget across ~40 network calls)");
// FRED_KEY is OPTIONAL (the collector has a keyless fredgraph.csv fallback): the workflow must not
// hard-gate on it, or a keyless deployment — the project's headline promise — would fail CI.
assert.doesNotMatch(y,/::error::[^\n]*SOSO/,"SOSO_API_KEY обязан оставаться необязательным");
{
  const collectStep=y.slice(y.indexOf("Собрать live-кандидата"),y.indexOf("Проверить live-кандидата"));
  assert.match(collectStep,/SOSO_API_KEY/,"дополняющий слой должен получать ключ, если он задан");
}
const html=readFileSync(new URL("../docs/index.html",import.meta.url),"utf8");
assert.match(html,/id="uiVersion"/,"dynamic UI version element missing");
assert.match(html,/SNAP\.version/,"UI version is not tied to snapshot version");
// No literal version may be baked into the markup: it silently desynchronises from package.json.
const baked=[...html.matchAll(/v\d+\.\d+\.\d+/g)].map(x=>x[0]);
assert.deepEqual(baked,[],`hardcoded version in markup: ${baked.join(", ")}`);
assert.match(html,/value="anthropic\/claude-fable-5"/,"default OpenRouter model must be an explicit valid slug");
// The AI answer must stream: a fixed-timeout non-streaming request dies on reasoning models.
assert.match(html,/"stream":?\s*true|stream:\s*true/,"OpenRouter request must use streaming");
assert.match(html,/id="aiRemember"/,"opt-in remember-on-device checkbox missing");
assert.match(html,/"X-OpenRouter-Title"/,"OpenRouter attribution should use the current X-OpenRouter-Title header");
// The site MUST be deployed by the workflow itself. GitHub does not rebuild a "Deploy from a branch"
// Pages site for commits pushed with the GITHUB_TOKEN — the run would be green, the data would land
// in the repo, and the live page would serve a stale snapshot forever. So the workflow deploys Pages.
assert.match(y,/actions\/configure-pages/,"Pages must be configured by the workflow");
assert.match(y,/actions\/upload-pages-artifact/,"the site must be uploaded as a Pages artifact");
assert.match(y,/actions\/deploy-pages/,"the site must be deployed by the workflow, not by a commit");
assert.match(y,/path:\s*docs/,"the Pages artifact must be the docs/ folder");
assert.match(y,/pages:\s*write/,"pages: write permission missing");
assert.match(y,/id-token:\s*write/,"id-token: write permission missing");
assert.match(y,/name:\s*github-pages/,"the github-pages environment is required by deploy-pages");
assert.ok(y.indexOf("cp .candidate/snapshot.json")<y.indexOf("upload-pages-artifact"),"the artifact must be uploaded AFTER the verified candidate is promoted");
// Honest partial verdicts must publish rather than freeze the site, so the production gate is
// REQUIRE_LIVE only. REQUIRE_COMPLETE stays an opt-in capability (self-test.mjs), not a workflow gate.
assert.doesNotMatch(y,/REQUIRE_COMPLETE/,"the production publish gate must not force both regimes complete");
console.log("Workflow static tests OK");
