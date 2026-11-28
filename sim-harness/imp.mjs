import {get,waitJob} from '/tmp/sim/drive.mjs';
import fs from 'node:fs';
const mode=process.argv[2]||'build'; const zip=process.argv[3];
const fd=new FormData(); fd.append('file',new Blob([fs.readFileSync(zip)]),zip.split('/').pop()); fd.append('idea','Nitro Shootout racing game'); if(mode==='upgrade') fd.append('upgrade','true');
const r=await fetch('http://127.0.0.1:18555/api/projects/import',{method:'POST',body:fd}); const j=await r.json(); console.log('POST',r.status,j.jobId||j.error);
const done=await waitJob(j.jobId,{label:'import-'+mode,max:180000}); console.log('RESULT',JSON.stringify(done.result||done.error||{}).slice(0,600));
