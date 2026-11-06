const B='http://127.0.0.1:18555';
export async function post(p,body){const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});let j={};try{j=await r.json()}catch{};return {status:r.status,...j};}
export async function get(p){const r=await fetch(B+p);return r.json();}
export async function waitJob(id,{max=120000,label=''}={}){const t0=Date.now();let seen=0;
  for(;;){const j=await get('/api/jobs/'+id); const ev=j.events||[]; for(;seen<ev.length;seen++){const e=ev[seen];console.log(`  [${((Date.now()-t0)/1000).toFixed(1)}s] ${e.stage||e.step||''}·${e.status||''}  ${String(e.message||'').slice(0,150)}`);} 
    if(['done','failed','cancelled','paused'].includes(j.status)){console.log(`  => ${label} job ${j.status} in ${((Date.now()-t0)/1000).toFixed(1)}s`); return j;}
    if(Date.now()-t0>max){console.log('  => TIMEOUT waiting'); return j;} await new Promise(r=>setTimeout(r,400));}}
if (process.argv[1].endsWith('drive.mjs')) {
  const [,, cmd, ...rest]=process.argv;
  if(cmd==='create'){const r=await post('/api/projects',{idea:rest.join(' '),autoBuild:true});console.log('POST',r.status,r.jobId||r.error);const j=await waitJob(r.jobId,{label:'create'});console.log('RESULT',JSON.stringify(j.result||j.error||{}).slice(0,700));}
}
