import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir=mkdtempSync(join(tmpdir(),"btc21m-live-regression-")),out=join(dir,"snapshot.json"),state=join(dir,"cache.json");
const run=(script,env={})=>spawnSync(process.execPath,[new URL(script,import.meta.url).pathname],{encoding:"utf8",env:{...process.env,OUT:out,STATE:state,...env}});
try{
  let r=run("./fetch-snapshot.mjs",{MOCK:"1"});if(r.status!==0)throw new Error(`mock build failed:\n${r.stdout}${r.stderr}`);
  const pub=JSON.parse(readFileSync(out,"utf8")),internal=JSON.parse(readFileSync(state,"utf8"));
  pub.mock=false;internal.mock=false;
  for(const x of Object.values(pub.sources||{}))if(x.state==="mock")x.state="ok";
  for(const x of Object.values(internal.sources||{}))if(x.state==="mock")x.state="ok";
  writeFileSync(out,JSON.stringify(pub));writeFileSync(state,JSON.stringify(internal));
  r=run("./self-test.mjs",{REQUIRE_LIVE:"1",REQUIRE_COMPLETE:"1"});if(r.status!==0)throw new Error(`live-like verification failed:\n${r.stdout}${r.stderr}`);
  r=spawnSync(process.execPath,[new URL("./negative-test.mjs",import.meta.url).pathname],{encoding:"utf8",env:{...process.env}});if(r.status!==0)throw new Error(`negative suite depends on live files:\n${r.stdout}${r.stderr}`);
  console.log("Live workflow regression OK");
}finally{rmSync(dir,{recursive:true,force:true});}
