/* FRED connectivity check. FRED_KEY is OPTIONAL: without it the collector reads FRED through the
import { readFileSync as __rf } from "node:fs";
const PKG_VERSION = JSON.parse(__rf(new URL("../package.json", import.meta.url), "utf8")).version;

   keyless CSV endpoint (fredgraph.csv). This step validates a provided key when present and always
   confirms the keyless CSV path is alive. It must NEVER fail the build merely because no key is set —
   the workflow runs it non-blocking and the real publish gate is `npm run verify`. */
const key=String(process.env.FRED_KEY||"").trim();
const hasKey=/^[a-z0-9]{32}$/.test(key);
let apiError=null;
if(!key){
  console.log("FRED_KEY не задан — проверяю keyless CSV-эндпоинт (это штатный режим работы).");
}else if(!hasKey){
  console.warn("FRED_KEY задан, но не похож на 32-символьный ключ FRED — пропускаю API-плечо, проверяю keyless CSV.");
  apiError=new Error("FRED_KEY malformed");
}else{
  const api=new URL("https://api.stlouisfed.org/fred/series/observations");
  for(const [k,v] of Object.entries({series_id:"WALCL",api_key:key,file_type:"json",sort_order:"desc",limit:"3"}))api.searchParams.set(k,v);
  try{
    const r=await fetch(api,{headers:{"User-Agent":"btc-21m-dashboard/"+PKG_VERSION,"Accept":"application/json"},signal:AbortSignal.timeout(20_000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);const b=await r.json();if(b?.error_code||b?.error_message)throw new Error(`API error ${b.error_code||""}`.trim());const row=(b?.observations||[]).find(x=>x?.value!=="."&&Number.isFinite(Number(x.value)));if(!row)throw new Error("valid WALCL observation not found");const age=Date.now()-Date.parse(`${row.date}T00:00:00Z`);if(age< -3_600_000||age>30*86_400_000)throw new Error("WALCL observation stale/future");console.log(`FRED API smoke OK: WALCL ${row.date}`);process.exit(0);
  }catch(e){apiError=e;}
}
try{
  const r=await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL",{headers:{"User-Agent":"btc-21m-dashboard/"+PKG_VERSION,"Accept":"text/csv,text/plain,*/*"},signal:AbortSignal.timeout(20_000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);const text=await r.text(),lines=text.trim().split(/\r?\n/),last=lines.reverse().find(x=>/^\d{4}-\d{2}-\d{2},[-+0-9.]+$/.test(x));if(!last)throw new Error("valid WALCL CSV row not found");const date=last.split(",")[0],age=Date.now()-Date.parse(`${date}T00:00:00Z`);if(age< -3_600_000||age>30*86_400_000)throw new Error("WALCL CSV stale/future");
  if(apiError)console.warn(`FRED API недоступен (${apiError?.message}); keyless CSV работает: WALCL ${date}`);
  else console.log(`FRED keyless CSV OK: WALCL ${date}`);
  process.exit(0);
}catch(e){
  // Keyless CSV is the mandatory continuity path; if it is down that is a genuine issue worth surfacing.
  // The workflow step is non-blocking, so this exit code is advisory, not a publish gate.
  console.error(`FRED smoke: API ${apiError?.message||apiError||"—"}; keyless CSV ${e?.message||e}`);
  process.exit(1);
}
