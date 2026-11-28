import fs from 'node:fs';
// Mock AI preload for the Builder simulation harness (no real API calls). Directory comes from SIM_DIR.
const SIM = process.env.SIM_DIR || '/tmp/sim';
const LOG = SIM + '/ai.jsonl'; let n=0;
const scen=()=>{ try{return JSON.parse(fs.readFileSync(SIM + '/scenario.json','utf8'));}catch{return {};} };
const ok=(content)=>new Response(JSON.stringify({id:'x',model:'deepseek-v4-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}),{status:200,headers:{'content-type':'application/json'}});
const files = {
 'package.json': JSON.stringify({name:'focus-timer',version:'1.0.0',type:'commonjs',scripts:{start:'node server.js',test:'node test.js'}},null,2),
 'server.js': `const http=require('http'),fs=require('fs'),path=require('path');
const PORT=process.env.PORT||8080; let tasks=[];
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true}));}
  if(req.url==='/api/tasks'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(tasks));}
  if(req.url==='/api/tasks'&&req.method==='POST'){let b='';req.on('data',d=>b+=d);req.on('end',()=>{try{const t=JSON.parse(b);tasks.push({id:Date.now(),title:String(t.title||'').slice(0,100)});res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify(tasks));}catch{res.writeHead(400);res.end('{}');}});return;}
  const f=path.join(__dirname,'public',req.url==='/'?'index.html':req.url.replace(/\\.\\./g,''));
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'content-type':mime[path.extname(f)]||'text/plain'});res.end(d);});
}).listen(PORT,'0.0.0.0',()=>console.log('listening',PORT));`,
 'public/index.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Focus Timer</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Focus Timer</h1><div id="clock">25:00</div><button id="start">Start</button><h2>Tasks</h2><input id="t" placeholder="New task"><button id="add">Add</button><ul id="list"></ul></main><script src="app.js"></script></body></html>`,
 'public/style.css': `body{font-family:system-ui;margin:0;background:#fff;color:#111}main{max-width:480px;margin:auto;padding:16px}#clock{font-size:64px;text-align:center}button{padding:10px 16px}`,
 'public/app.js': `let s=1500,timer=null;const c=document.getElementById('clock');function r(){c.textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
document.getElementById('start').onclick=()=>{if(timer)return;timer=setInterval(()=>{s--;r();if(s<=0){clearInterval(timer);timer=null}},1000)};
async function load(){const l=await (await fetch('/api/tasks')).json();document.getElementById('list').innerHTML=l.map(t=>'<li>'+t.title.replace(/</g,'&lt;')+'</li>').join('')}
document.getElementById('add').onclick=async()=>{const v=document.getElementById('t').value;if(!v)return;await fetch('/api/tasks',{method:'POST',body:JSON.stringify({title:v})});load()};load();`,
 'test.js': `const {spawn}=require('child_process');const p=spawn('node',['server.js'],{env:{...process.env,PORT:'18999'}});setTimeout(async()=>{try{const r=await fetch('http://127.0.0.1:18999/health');if(!r.ok)throw new Error('bad');console.log('ok');p.kill();process.exit(0)}catch(e){console.error(e);p.kill();process.exit(1)}},700);`,
 'Dockerfile': `FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8080\nCMD ["node","server.js"]\n`,
 '.gitignore': 'node_modules\n.env\n', '.env.example': 'PORT=8080\n',
 'README.md': '# Focus Timer\nA tiny focus timer with tasks.\n', 'INSTALL.md': '# Install\nUse SoloHost.\n', 'CHANGELOG.md': '# Changelog\n- 1.0.0 first version\n',
};
globalThis.__files=files;
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,opts={})=>{
  const u=String(url);
  if(!/deepseek\.com|generativelanguage|mock-ai/.test(u)) return realFetch(url,opts);
  if(/\/models(\?|$)/.test(u)&&(!opts.method||opts.method==='GET')) return new Response(JSON.stringify({data:[{id:'deepseek-v4-flash'}],models:[{name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']}]}),{status:200});
  let body={};try{body=JSON.parse(opts.body||'{}')}catch{}
  const msgs=body.messages||[]; const prompt=msgs.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
  const S=scen(); n++; let kind='UNKNOWN',out='{"ok":true}';
  if(/Reply with exactly: OK/.test(prompt)){kind='PROBE';out='OK';}
  else if(/first-message router/.test(prompt)){kind='ROUTER';out='{"route":"build","reply":"","reason":"clear build request"}';}
  else if(/Analyze this app idea/.test(prompt)){kind='ANALYSIS';out=JSON.stringify({name:'Focus Timer',slug:'focus-timer',summary:'A focus timer with a task list.',target_users:['students'],core_features:['timer','tasks'],optional_features:[],recommended_stack:{language:'javascript',runtime:'node',framework:'none',database:'json',frontend:'static-html'},risks:[],questions:S.questions||[],estimated_complexity:'low'});}
  else if(/Create a product plan/.test(prompt)){kind='PLAN';out=JSON.stringify({name:'Focus Timer',summary:'Timer + tasks',user_flow:['open','start'],features:['timer','tasks'],architecture:'node http + static',data_model:'tasks[]',security_model:'validate input',testing_strategy:'health test',deployment_strategy:'docker',decisions:[],complexity:'low'});}
  else if(/Generate a complete small production-ready application/.test(prompt)){kind='CODE';
    const list=Object.entries(files).filter(([p])=>!(S.omit||[]).includes(p)).map(([path,content])=>({path,content}));
    out=JSON.stringify({files:list,notes:'ok'});
    if(S.codeMode==='fenced') out='Here is your app:\n```json\n'+out+'\n```\nLet me know!';
    if(S.codeMode==='truncated') out=out.slice(0,Math.floor(out.length*0.7));
    if(S.codeMode==='badjson') out=out.replace(/"notes":"ok"/,'"notes":"ok",');
  }
  else if(/SAFE REPAIR|\[ACTION:/.test(prompt)){kind='PATCH';
    globalThis.__pc=globalThis.__pc||{}; let h=S.patch;
    if(Array.isArray(S.patchSeq)){ const k=S.seqId||'x'; const i=globalThis.__pc[k]||0; globalThis.__pc[k]=i+1; h=S.patchSeq[Math.min(i,S.patchSeq.length-1)]; }
    out=typeof h==='string'?h:JSON.stringify(h||{root_cause:'n/a',files:[],explanation:'no change'});}
  else if(/Describe this project|description/i.test(prompt)&&/release|store/i.test(prompt)){kind='DESC';out=JSON.stringify({short:'Focus timer',long:'A focus timer.'});}
  fs.appendFileSync(LOG,JSON.stringify({n,t:new Date().toISOString(),kind,promptChars:prompt.length,head:prompt.slice(0,90).replace(/\n/g,' ')})+'\n');
  if(S.dumpKind===kind) fs.writeFileSync(SIM + '/prompt-'+kind+'-'+n+'.txt',prompt);
  if(S.delayMs) await new Promise(r=>setTimeout(r,S.delayMs));
  return ok(out);
};
