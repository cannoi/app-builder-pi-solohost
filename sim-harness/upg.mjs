import {post,get,waitJob} from '/tmp/sim/drive.mjs';
const arr=(await get('/api/projects')); const list=arr.projects||arr;
const p=list.filter(x=>String(x.status).startsWith('UPGRADE')).pop()||list[list.length-1]; console.log('project',p.slug,p.status);
let r=await post(`/api/projects/${p.id}/upgrade/inspect`,{}); console.log('inspect POST',r.status,r.jobId||r.error);
let j=await waitJob(r.jobId,{label:'inspect',max:120000}); console.log('  result keys:',Object.keys(j.result||{}).join(','), '| err:',j.error||'');
r=await post(`/api/projects/${p.id}/upgrade/request`,{request:'Add LAN multiplayer so players on the same Wi-Fi can race together'}); console.log('request POST',r.status,r.jobId||r.error);
j=await waitJob(r.jobId,{label:'request',max:120000}); console.log('  result:',JSON.stringify(j.result||j.error||{}).slice(0,700));
