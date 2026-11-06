import {post,get,waitJob} from '/tmp/sim/drive.mjs'; import fs from 'node:fs'; import {execSync} from 'node:child_process';
const list=(await get('/api/projects')); const p=(list.projects||list).find(x=>x.slug==='focus-timer'); const src='/tmp/sim/projects/focus-timer/source/';
const idx=fs.readFileSync(src+'public/index.html','utf8'); const srv=fs.readFileSync(src+'server.js','utf8');
const cases={
 good:{root_cause:'No dark mode',files:[{path:'public/index.html',content:idx.replace('<h1>Focus Timer</h1>','<h1>Focus Timer</h1><button id="theme">🌙</button>')}],explanation:'Added toggle',risk:'low'},
 syntax:{root_cause:'x',files:[{path:'server.js',content:srv.replace("const PORT","const PORT = (")}],explanation:'oops',risk:'low'},
 prose:'Sure! Here is the change:\n```json\n'+JSON.stringify({root_cause:'x',files:[{path:'public/index.html',content:idx.replace('Focus Timer','Focus Timer Pro')}],explanation:'ok',risk:'low'})+'\n```\nHope it helps!',
 wrongpath:{root_cause:'x',files:[{path:'src/server.js',content:'console.log(1)'},{path:'public/index.html',content:idx.replace('Focus Timer','FT')}],explanation:'x',risk:'low'},
 truncatedjson:JSON.stringify({root_cause:'x',files:[{path:'public/index.html',content:idx}],explanation:'x',risk:'low'}).slice(0,-60),
};
for(const [name,patch] of Object.entries(cases)){
  fs.writeFileSync('/tmp/sim/scenario.json',JSON.stringify({patch}));
  const before=fs.readFileSync(src+'server.js','utf8').length+fs.readFileSync(src+'public/index.html','utf8').length;
  const r=await post(`/api/projects/${p.id}/improve`,{feedback:'Add a dark mode toggle ('+name+')'});
  const j=await waitJob(r.jobId,{label:name,max:90000}).catch(e=>({status:'ERR'}));
  let chk='ok'; try{execSync('node --check '+src+'server.js',{stdio:'pipe'})}catch{chk='SYNTAX BROKEN'}
  const after=fs.readFileSync(src+'server.js','utf8').length+fs.readFileSync(src+'public/index.html','utf8').length;
  const ev=(j.events||[]).map(e=>e.stage+':'+e.status).join(' > ');
  console.log(`### ${name}: job=${j.status} | server.js syntax=${chk} | bytes ${before}→${after}`);
  console.log('    msg:',String(j.error||JSON.stringify(j.result?.explanation||j.result?.message||'')).slice(0,200));
  console.log('    flow:',ev.slice(0,260));
}
