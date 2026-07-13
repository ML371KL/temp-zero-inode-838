/*
  Minimal live validation of FRED credentials and response shape.
  The API key is read only from FRED_KEY and is never printed.
*/
const key=String(process.env.FRED_KEY||"").trim();
if(!/^[a-z0-9]{32}$/.test(key)){
  console.error("FRED smoke test failed: FRED_KEY must be a 32-character lowercase alphanumeric key");
  process.exit(1);
}
const url=new URL("https://api.stlouisfed.org/fred/series/observations");
url.searchParams.set("series_id","WALCL");
url.searchParams.set("api_key",key);
url.searchParams.set("file_type","json");
url.searchParams.set("sort_order","desc");
url.searchParams.set("limit","3");
let lastError=null;
for(let attempt=1;attempt<=2;attempt++){
  try{
    const response=await fetch(url,{headers:{"User-Agent":"btc-21m-dashboard/2.1.4","Accept":"application/json"},signal:AbortSignal.timeout(20_000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const body=await response.json();
    if(body?.error_code||body?.error_message)throw new Error(`API error ${body.error_code||""}`.trim());
    const rows=Array.isArray(body?.observations)?body.observations:[];
    const row=rows.find(x=>x&&x.value!=="."&&Number.isFinite(Number(x.value))&&!Number.isNaN(Date.parse(`${x.date}T00:00:00Z`)));
    if(!row)throw new Error("valid WALCL observation not found");
    const age=Date.now()-Date.parse(`${row.date}T00:00:00Z`);
    if(age< -3_600_000||age>30*86_400_000)throw new Error("WALCL observation is unexpectedly stale or in the future");
    console.log(`FRED smoke test OK: WALCL ${row.date}`);
    process.exit(0);
  }catch(error){
    lastError=error;
    if(attempt<2)await new Promise(r=>setTimeout(r,1200));
  }
}
console.error(`FRED smoke test failed: ${String(lastError?.message||lastError)}`);
process.exit(1);
