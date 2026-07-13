import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const dir=mkdtempSync(join(tmpdir(),"btc21m-live-regression-")),out=join(dir,"snapshot.json"),state=join(dir,"cache.json");
const run=(script,env={})=>spawnSync(process.execPath,[fileURLToPath(new URL(script,import.meta.url))],{encoding:"utf8",env:{...process.env,OUT:out,STATE:state,...env}});
try{
  let r=run("./fetch-snapshot.mjs",{MOCK:"1"});if(r.status!==0)throw new Error(`mock build failed:\n${r.stdout}${r.stderr}`);
  const pub=JSON.parse(readFileSync(out,"utf8")),internal=JSON.parse(readFileSync(state,"utf8"));
  pub.mock=false;internal.mock=false;
  for(const x of Object.values(pub.sources||{}))if(x.state==="mock")x.state="ok";
  for(const x of Object.values(internal.sources||{}))if(x.state==="mock")x.state="ok";
  writeFileSync(out,JSON.stringify(pub));writeFileSync(state,JSON.stringify(internal));
  // Mirror the production publish gate: REQUIRE_LIVE only. Honest partial verdicts publish rather than
  // freeze the site; REQUIRE_COMPLETE stays an opt-in capability exercised by negative-test.mjs.
  r=run("./self-test.mjs",{REQUIRE_LIVE:"1"});if(r.status!==0)throw new Error(`live-like verification failed:\n${r.stdout}${r.stderr}`);
  r=spawnSync(process.execPath,[fileURLToPath(new URL("./negative-test.mjs",import.meta.url))],{encoding:"utf8",env:{...process.env}});if(r.status!==0)throw new Error(`negative suite depends on live files:\n${r.stdout}${r.stderr}`);
  console.log("Live workflow regression OK");
}finally{rmSync(dir,{recursive:true,force:true});}
