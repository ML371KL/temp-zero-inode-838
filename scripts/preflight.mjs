import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

if(!process.env.FRED_KEY){console.error("FRED_KEY is required for live preflight");process.exitCode=1;}
else{
  const dir=mkdtempSync(join(tmpdir(),"btc21m-preflight-")),out=join(dir,"snapshot.json"),state=join(dir,"cache.json");
  const run=(args,extra={})=>spawnSync(process.execPath,args,{stdio:"inherit",env:{...process.env,OUT:out,STATE:state,...extra}}).status===0;
  try{
    if(!run([new URL("./fetch-snapshot.mjs",import.meta.url).pathname]))throw new Error("live collector failed");
    if(!run([new URL("./self-test.mjs",import.meta.url).pathname],{REQUIRE_LIVE:"1"}))throw new Error("live snapshot validation failed");
    console.log("Live preflight OK");
  }catch(error){console.error(error.message);process.exitCode=1;}
  finally{rmSync(dir,{recursive:true,force:true});}
}
