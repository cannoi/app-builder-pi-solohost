/**
 * App Builder template library adapter.
 * Catalog metadata is intentionally separate from executable source templates.
 * Package/reference records are recommendations only until a verified deployment
 * manifest is available; they are never installed by guessing image/ports/env.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureUpstreamMaterial } from './fetch-upstream.js';

const CATEGORY_LABELS = {
  'ai-agents':['AI & AI Agents','AI & Agent'],
  'business-crm':['Business & CRM','Kinh doanh & CRM'],
  'erp-admin':['ERP & Administration','ERP & Quản trị'],
  'ecommerce-marketplace':['E-commerce & Marketplace','Thương mại & Marketplace'],
  'social-community':['Social Network & Community','Mạng xã hội & Cộng đồng'],
  'chat-communication':['Chat & Communication','Chat & Giao tiếp'],
  'media-streaming':['Media & Streaming','Media & Streaming'],
  'developer-api':['Developer Tools & API','Công cụ Dev & API'],
  'monitoring-analytics':['Monitoring & Analytics','Giám sát & Phân tích'],
  'storage-files':['Storage & File Management','Lưu trữ & Quản lý tệp'],
  'productivity-pm':['Productivity & Project Management','Năng suất & Quản lý dự án'],
  'education-knowledge':['Education & Knowledge Management','Giáo dục & Tri thức'],
  'cms-publishing':['Website, CMS & Publishing','Website, CMS & Xuất bản'],
  'finance-payment':['Finance & Payment','Tài chính & Thanh toán'],
  'games-entertainment':['Games & Entertainment','Game & Giải trí'],
  starter:['Starters','Mẫu khởi đầu'],
};
const FEATURE_HINTS = [
  ['business-crm',['crm','customer','customers','client','clients','lead','sales','pipeline','khách hàng','quản lý khách hàng']],
  ['erp-admin',['erp','inventory','stock','warehouse','kho hàng','kế toán','accounting']],
  ['ecommerce-marketplace',['shop','store','ecommerce','e-commerce','marketplace','cart','checkout','đơn hàng','cửa hàng']],
  ['social-community',['community','social','forum','mạng xã hội','cộng đồng','fediverse']],
  ['chat-communication',['chat','messaging','message','support inbox','nhắn tin','live chat']],
  ['media-streaming',['video','music','photo','media','stream','ảnh','nhạc','phim']],
  ['ai-agents',['ai','llm','rag','agent','chatbot','model','trí tuệ nhân tạo']],
  ['monitoring-analytics',['monitor','monitoring','analytics','dashboard','uptime','giám sát']],
  ['storage-files',['storage','file','drive','backup','lưu trữ','tệp']],
  ['productivity-pm',['project','task','kanban','sprint','công việc','quản lý dự án']],
  ['education-knowledge',['wiki','knowledge','course','lms','education','tri thức','học tập']],
  ['cms-publishing',['cms','blog','website','newsletter','publishing']],
  ['finance-payment',['invoice','payment','finance','accounting','hóa đơn','thanh toán']],
  ['developer-api',['git','api','devops','developer','repository','code']],
  ['games-entertainment',['game','gaming','minecraft','trò chơi']],
];
const TEXT_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|html|css|md|txt|ya?ml|env|example|sh|xml|svg)$/i;
const SKIP_DIR = /(^|\/)(?:\.git|node_modules|\.next|dist|coverage|\.cache)(\/|$)/i;
function shouldSkip(rel) {
  const normalized=String(rel).split(path.sep).join('/');
  const base=path.posix.basename(normalized);
  if (SKIP_DIR.test(normalized)) return true;
  if (base === '.env') return true;
  if (/^\.env\./i.test(base) && !/^\.env\.(?:example|sample|template)$/i.test(base)) return true;
  if (base === 'id_rsa' || /\.(?:pem|key|p12)$/i.test(base)) return true;
  return false;
}

function safeId(value) {
  const id=String(value||'');
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) throw Object.assign(new Error('Invalid template id'),{code:'INVALID_TEMPLATE_ID'});
  return id;
}
function inside(root,candidate) {
  const r=path.resolve(root), c=path.resolve(candidate);
  return c===r || c.startsWith(r+path.sep);
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file,'utf8')); } catch { return null; }
}
export async function readTemplateCatalog(templatesDir) {
  const root=path.resolve(templatesDir||'./templates');
  const data=await readJson(path.join(root,'catalog','catalog.json'));
  const entries=Array.isArray(data?.templates)?data.templates:[];
  const byId=new Map();
  for (const raw of entries) {
    if (!raw?.id || !['source','package','reference'].includes(raw.kind)) continue;
    const item={...raw, tags:Array.isArray(raw.tags)?raw.tags:[], source:raw.source||{}};
    if (item.kind==='source') {
      const rel=item.source.path||item.id;
      const dir=path.resolve(root,rel);
      item.instantiable=item.internalOnly!==true && inside(root,dir) && await fs.stat(dir).then(s=>s.isDirectory()).catch(()=>false);
      item.sourcePresent=item.instantiable;
    } else {
      item.instantiable=false;
      item.sourcePresent=false;
    }
    byId.set(item.id, item);
  }
  // Merge on-disk standard SoloHost source templates (template.json in subfolders)
  try {
    const ents=await fs.readdir(root,{withFileTypes:true});
    for (const e of ents) {
      if (!e.isDirectory() || e.name==='catalog' || e.name==='assets' || e.name==='cache' || e.name==='library') continue;
      const dir=path.join(root,e.name);
      const manifest=await readJson(path.join(dir,'template.json'));
      if (!manifest?.id) continue;
      const item={
        schemaVersion:1,
        id:manifest.id,
        version:manifest.version||'1.0.0',
        name:manifest.name||manifest.id,
        description:manifest.description||'',
        category:manifest.category|| 'starter',
        kind:'source',
        tags:Array.isArray(manifest.tags)?manifest.tags:[],
        capabilities:Array.isArray(manifest.capabilities)?manifest.capabilities:[],
        features:Array.isArray(manifest.features)?manifest.features:[],
        tech:Array.isArray(manifest.tech)?manifest.tech:['node'],
        license:manifest.license||'MIT',
        source:{type:manifest.source?.type||(manifest.fetch?'github':'local'),path:e.name,url:manifest.source?.url,ref:manifest.source?.ref||manifest.fetch?.ref},
        fetch:manifest.fetch||null,
        overlay:manifest.overlay||(manifest.thinOverlay||manifest.fetch?{path:'overlay'}:null),
        thinOverlay:Boolean(manifest.thinOverlay||manifest.fetch),
        compatibility:Object.assign({solohost:true,privilegedForbidden:true,dockerSocketForbidden:true},manifest.compatibility||{solohostStatus:(manifest.thinOverlay||manifest.fetch)?'overlay-ready-fetch-on-create':'source-standard'}),
        verified:Boolean(manifest.verified),
        verification:manifest.verification||{sourcePresent:!(manifest.thinOverlay||manifest.fetch),productionReady:false},
        instantiable:true,
        sourcePresent:!(manifest.thinOverlay||manifest.fetch),
        standardSoloHost:String(manifest.id).startsWith('std-') || Boolean(manifest.standardSoloHost),
        attribution:manifest.attribution||'Standard SoloHost template',
      };
      // On-disk source wins over catalog package/reference with same id
      const prev=byId.get(item.id);
      byId.set(item.id, item);
    }
  } catch { /* ignore scan errors */ }
  return [...byId.values()];
}
export async function listTemplateCategories(templatesDir,locale='en') {
  const items=await readTemplateCatalog(templatesDir);
  const lang=String(locale).toLowerCase().startsWith('vi')?1:0;
  const ids=[...new Set(items.map(x=>x.category))].sort();
  return ids.map(id=>({id,label:CATEGORY_LABELS[id]?.[lang]||id,count:items.filter(x=>x.category===id).length}));
}
export async function searchTemplates(templatesDir,{q='',category='',kind=''}={}) {
  const items=await readTemplateCatalog(templatesDir);
  const query=String(q||'').trim().toLowerCase();
  return items.filter(t=>{
    if(category && t.category!==category) return false;
    if(kind && t.kind!==kind) return false;
    if(!query) return true;
    const hay=[t.id,t.name,t.description,t.category,t.license,...t.tags].join(' ').toLowerCase();
    return hay.includes(query);
  });
}
export async function getTemplateById(templatesDir,id) {
  const key=safeId(id);
  return (await readTemplateCatalog(templatesDir)).find(t=>t.id===key)||null;
}
function words(s) { return String(s||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]+/g)||[]; }
export async function matchTemplates(templatesDir,query,{limit=8}={}) {
  const raw=String(query||'').trim();
  const q=raw.toLowerCase();
  const tokens=[...new Set(words(raw).filter(w=>w.length>2))];
  const hinted=FEATURE_HINTS.filter(([,keys])=>keys.some(k=>q.includes(k))).map(([cat])=>cat);
  const items=await readTemplateCatalog(templatesDir);
  const ranked=items.map(t=>{
    const hay=words([t.id,t.name,t.description,t.category,...t.tags].join(' '));
    const set=new Set(hay); let score=0; const matched=[];
    for(const token of tokens){ if(set.has(token)){score+=4;matched.push(token);} }
    if(hinted.includes(t.category)){score+=18;matched.push(`category:${t.category}`);}
    if(q.includes(t.id)||q.includes(t.name.toLowerCase())){score+=30;matched.push('exact-name');}
    if(t.kind==='source'&&t.instantiable) score+=5;
    if(t.thinOverlay&&t.instantiable) score+=8;
    if(t.standardSoloHost||String(t.id).startsWith('std-')) score+=3;
    if(t.kind==='reference') score-=1;
    if(t.demo===true||['hello-ai-app','sandbox-benchmark'].includes(t.id)) score-=50;
    if(String(t.id).startsWith('std-')||t.thinOverlay||t.standardSoloHost||t.qualityBaseline) score+=6;
    return {template:t,template_id:t.id,name:t.name,kind:t.kind,score:Math.min(100,score),matched_requirements:matched,missing_requirements:hinted.filter(c=>c!==t.category).map(c=>`category:${c}`),instantiable:!!t.instantiable};
  }).sort((a,b)=>b.score-a.score||a.template_id.localeCompare(b.template_id));
  let results=ranked.slice(0,Math.max(1,Math.min(Number(limit)||8,20)));
  let top=results[0];
  // When best catalog hit is package/reference, remap to standard SoloHost source std-<category>
  if (top && !top.instantiable) {
    const cat = top.template?.category;
    const sameIdThin = ranked.find((r) => r.instantiable && r.template_id === top.template_id);
    const catThin = ranked.find((r) => r.instantiable && r.template?.thinOverlay && r.template?.category === cat);
    const stdId = cat ? `std-${cat}` : null;
    const std = stdId ? ranked.find((r) => r.template_id === stdId && r.instantiable) : null;
    const anyStd = ranked.find((r) => r.instantiable && String(r.template_id).startsWith('std-') && (!cat || r.template?.category === cat));
    const pick = sameIdThin || catThin || std || anyStd;
    if (pick) {
      top = {
        ...pick,
        score: Math.max(pick.score, Math.min(95, (top.score || 0) + 10)),
        matched_requirements: [...(top.matched_requirements || []), `mapped-from:${top.template_id}`],
        missing_requirements: top.missing_requirements || [],
        mapped_from: top.template_id,
      };
      results = [top, ...results.filter((r) => r.template_id !== top.template_id)];
    }
  }
  const confident=Boolean(top&&top.score>=20);
  return {
    query:raw,language:/[ăâđêôơưáàảãạ]/i.test(raw)?'vi':'en',
    selected_template_id:confident?top.template_id:null,
    selected:confident?{id:top.template_id,name:top.name,kind:top.kind,category:top.template.category,license:top.template.license,instantiable:top.instantiable,source:top.template.source}:null,
    match_score:confident?top.score:0,
    selection_reason:confident?(top.mapped_from?`Catalog «${top.mapped_from}» is not editable source; using standard SoloHost template «${top.template_id}».`:`Matched ${top.matched_requirements.slice(0,4).join(', ')||'application keywords'}.`):'No reliable catalog match. Start from Scratch is available.',
    matched_requirements:confident?top.matched_requirements:[],
    missing_requirements:confident?top.missing_requirements:hinted.map(c=>`category:${c}`),
    alternative_template_ids:results.slice(1,5).map(x=>x.template_id),
    results:results.map(x=>({template_id:x.template_id,name:x.name,kind:x.kind,category:x.template.category,score:x.score,matched_requirements:x.matched_requirements,missing_requirements:x.missing_requirements,instantiable:x.instantiable,license:x.template.license,sourceUrl:x.template.source?.url||x.template.homepage||null})),
  };
}
export async function copySourceTree(src,dest,vars) {
  await fs.mkdir(dest,{recursive:true});
  const files=[];
  async function walk(from,rel='') {
    const ents=await fs.readdir(from,{withFileTypes:true});
    for(const ent of ents) {
      const child=rel?`${rel}/${ent.name}`:ent.name;
      if(shouldSkip(child)||['template.json','template.manifest.json','.template.json'].includes(ent.name)) continue;
      const full=path.join(from,ent.name), out=path.join(dest,child);
      if(!inside(src,full)||!inside(dest,out)) throw Object.assign(new Error('Unsafe template path'),{code:'UNSAFE_TEMPLATE_PATH'});
      const st=await fs.lstat(full);
      if(st.isSymbolicLink()) throw Object.assign(new Error(`Template symlink rejected: ${child}`),{code:'UNSAFE_TEMPLATE_SYMLINK'});
      if(st.isDirectory()){await fs.mkdir(out,{recursive:true});await walk(full,child);continue;}
      if(!st.isFile()) continue;
      await fs.mkdir(path.dirname(out),{recursive:true});
      const buf=await fs.readFile(full);
      if(TEXT_EXT.test(child)&&buf.length<2*1024*1024&&!buf.includes(0)) {
        let text=buf.toString('utf8');
        for(const [k,v] of Object.entries(vars)) text=text.replaceAll(`{{${k}}}`,String(v));
        await fs.writeFile(out,text,'utf8');
      } else await fs.writeFile(out,buf);
      files.push(child);
    }
  }
  await walk(src);
  return files;
}
export async function instantiateTemplateProject({templatesDir,projects,jobs=null,templateId,idea='',name=''}) {
  const tpl=await getTemplateById(templatesDir,templateId);
  if(!tpl) throw Object.assign(new Error('Template not found'),{code:'TEMPLATE_NOT_FOUND'});
  if(tpl.kind!=='source'||!tpl.instantiable) throw Object.assign(new Error('This catalog entry is not an editable source template. Package deployment is not enabled until a verified SoloHost package manifest exists.'),{code:'TEMPLATE_NOT_INSTANTIABLE'});
  const root=path.resolve(templatesDir||'./templates');
  const source=path.resolve(root,tpl.source.path||tpl.id);
  if(!inside(root,source)) throw Object.assign(new Error('Template source path is outside the template directory'),{code:'UNSAFE_TEMPLATE_PATH'});
  let current=root;
  for(const segment of path.relative(root,source).split(path.sep).filter(Boolean)) {
    current=path.join(current,segment);
    const st=await fs.lstat(current).catch(()=>null);
    if(!st||st.isSymbolicLink()) throw Object.assign(new Error('Template source directory is missing or unsafe'),{code:'TEMPLATE_SOURCE_MISSING'});
  }
  const sourceStat=await fs.lstat(source).catch(()=>null);
  if(!sourceStat?.isDirectory()) throw Object.assign(new Error('Template source directory is missing or unsafe'),{code:'TEMPLATE_SOURCE_MISSING'});
  const appName=String(name||tpl.name||'New App').trim().slice(0,80);
  const project=await projects.create({
    idea:String(idea||`Create an app from ${tpl.name}`).slice(0,4000),
    name:appName,
    analysis:{name:appName,slug:tpl.id,recommended_stack:{language:'node',framework:'express'},templateId:tpl.id},
    plan:{mode:'template-source',templateId:tpl.id,templateName:tpl.name,steps:[]},
  });
  const dest=projects.sourceDir(project.slug);
  try {
    const vars={APP_NAME:appName,APP_SLUG:project.slug,APP_SUMMARY:String(idea||tpl.description||''),APP_IDEA:String(idea||'')};
    const files=await copySourceTree(source,dest,vars);
    const provenance={schemaVersion:1,templateId:tpl.id,templateVersion:tpl.version||'1.0.0',templateName:tpl.name,kind:'source',license:tpl.license,upstream:tpl.source?.url||null,createdAt:new Date().toISOString(),filesWritten:files,originalTemplateUntouched:true};
    await fs.writeFile(path.join(dest,'.builder-template.json'),JSON.stringify(provenance,null,2)+'\n');
    await projects.saveMetadata(project,'template-provenance.json',provenance);
    await projects.saveMetadata(project,'template-match.json',{selected_template_id:tpl.id,match_score:100,selected:{id:tpl.id,name:tpl.name,kind:'source',instantiable:true}});
    await projects.chat(project,String(idea||`Create ${tpl.name}`),'user');
    await projects.chat(project,`Created from template: ${tpl.name}\nFiles copied: ${files.length}\nThe built-in source template remains unchanged. AI will now apply your requested changes, then you can Run and Publish.`, 'assistant',{templateId:tpl.id,templateSource:true});
    projects.setStatus(project,'READY_TO_BUILD');
    let job=null;
    if(jobs && String(idea||'').trim()) {
      try {
        job=jobs.enqueue({type:'improve',projectId:project.id,payload:{projectId:project.id,feedback:String(idea).slice(0,4000)}});
      } catch { /* project remains available; user can request Improve manually */ }
    }
    return {ok:true,projectId:project.id,projectName:project.name,template:{id:tpl.id,name:tpl.name,kind:tpl.kind},filesWritten:files.length,jobId:job?.id||null,customizationQueued:Boolean(job)};
  } catch(err) {
    await fs.rm(dest,{recursive:true,force:true}).catch(()=>{});
    throw err;
  }
}

export async function fillProjectFromTemplate({templatesDir, project, projects, templateId, idea='', snapshots=null}) {
  const tpl = await getTemplateById(templatesDir, templateId);
  if (!tpl || !tpl.instantiable) {
    return { ok:false, code:'NOT_INSTANTIABLE', message:'Template is not an editable SoloHost source.' };
  }
  const root = path.resolve(templatesDir, tpl.source?.path || tpl.id);
  const dest = projects.sourceDir(project.slug);
  await fs.mkdir(dest, { recursive: true });
  const vars = {
    APP_NAME: project.name || tpl.name,
    APP_SLUG: project.slug,
    APP_SUMMARY: String(idea || tpl.description || '').slice(0, 500),
    APP_IDEA: String(idea || ''),
  };

  let materialDir = root;
  let fetched = null;
  const needsFetch = Boolean(tpl.fetch || tpl.thinOverlay);
  if (needsFetch && tpl.fetch) {
    fetched = await ensureUpstreamMaterial({
      templatesDir,
      templateId: tpl.id,
      fetchSpec: tpl.fetch,
      source: tpl.source,
    });
    materialDir = fetched.sourceDir;
  }

  let files = await copySourceTree(materialDir, dest, vars);
  if (needsFetch) {
    const overlayDir = path.join(root, tpl.overlay?.path || 'overlay');
    try {
      const st = await fs.stat(overlayDir);
      if (st.isDirectory()) {
        const overFiles = await copySourceTree(overlayDir, dest, vars);
        files = [...new Set([...files, ...overFiles])];
      }
    } catch { /* optional overlay */ }
    for (const name of ['docker-compose.yml', 'config_options.yml', 'SOLOHOST.md']) {
      try {
        await fs.copyFile(path.join(root, name), path.join(dest, name));
        if (!files.includes(name)) files.push(name);
      } catch { /* missing ok */ }
    }
  }

  const provenance = {
    schemaVersion: 1,
    templateId: tpl.id,
    templateVersion: tpl.version || '1.0.0',
    templateName: tpl.name,
    kind: 'source',
    license: tpl.license,
    thinOverlay: Boolean(tpl.thinOverlay),
    standardSoloHost: Boolean(tpl.standardSoloHost) || String(tpl.id).startsWith('std-'),
    upstream: fetched?.github || (tpl.source?.url ? { url: tpl.source.url, ref: tpl.source.ref } : null),
    fetchedFromCache: fetched == null ? null : Boolean(fetched.fromCache),
    createdAt: new Date().toISOString(),
    filesWritten: files,
    originalTemplateUntouched: true,
    idea: String(idea || '').slice(0, 2000),
    solohost: { privilegedForbidden: true, dockerSocketForbidden: true, loopbackPorts: true },
  };
  await fs.writeFile(path.join(dest, '.builder-template.json'), JSON.stringify(provenance, null, 2) + '\n');
  await projects.saveMetadata(project, 'template-provenance.json', provenance);
  return { ok:true, templateId: tpl.id, files, provenance, fetched: Boolean(fetched) };
}

export function catalogHealth(items) {
  const ids=items.map(t=>t.id);
  return {total:items.length,uniqueIds:new Set(ids).size,duplicateIds:ids.filter((id,i)=>ids.indexOf(id)!==i),counts:{source:items.filter(t=>t.kind==='source').length,package:items.filter(t=>t.kind==='package').length,reference:items.filter(t=>t.kind==='reference').length}};
}
