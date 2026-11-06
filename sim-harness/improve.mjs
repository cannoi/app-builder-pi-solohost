import {post,get,waitJob} from '/tmp/sim/drive.mjs';
const list=await get('/api/projects'); const arr=list.projects||list;
const p=arr.find(x=>String(x.slug).includes(process.env.SLUG||''))||arr[0]; console.log('project',p.slug,p.status);
const r=await post('/api/projects/'+p.id+'/improve',{feedback:process.argv.slice(2).join(' ')}); console.log('POST',r.status,r.jobId||r.error);
const j=await waitJob(r.jobId,{label:'improve',max:200000}); console.log('RESULT',JSON.stringify(j.result||j.error||{}).slice(0,500));
