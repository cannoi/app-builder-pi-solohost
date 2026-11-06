const $ = (id) => document.getElementById(id);
const state = { items: [], categories: [], matches: null, loading: false, searchTimer: null, selectedId: null };
const locale = () => {
  try { return window.pafI18n?.locale || localStorage.getItem('paf_locale') || 'en'; } catch { return 'en'; }
};
const vi = () => String(locale()).toLowerCase().startsWith('vi');
const tr = (en, vn) => vi() ? vn : en;
async function request(url, options={}) {
  const headers = { 'Content-Type':'application/json', ...(options.headers||{}) };
  try {
    const token=sessionStorage.getItem('builder_access_token');
    if(token && !headers['X-Builder-Access']) { headers['X-Builder-Access']=token; headers.Authorization=`Bearer ${token}`; }
  } catch {}
  const res=await fetch(url,{credentials:'include',...options,headers});
  const body=await res.text(); let data={};
  try { data=body?JSON.parse(body):{}; } catch { data={message:body}; }
  if(!res.ok) throw new Error(data.message||data.error||`HTTP ${res.status}`);
  return data;
}
function el(tag,cls,text) {
  const n=document.createElement(tag);
  if(cls)n.className=cls;
  if(text!=null)n.textContent=String(text);
  return n;
}
function typeLabel(kind) {
  return kind==='source'?tr('Editable source','Mã nguồn chỉnh sửa được'):kind==='package'?tr('Docker package','Gói Docker'):tr('Reference only','Chỉ tham khảo');
}
function categoryLabel(id) {
  return state.categories.find(c=>c.id===id)?.label||id;
}
function setStatus(message,isError=false) {
  const n=$('templateMatchStatus'); if(!n)return;
  n.textContent=message||''; n.style.color=isError?'var(--bad)':'var(--muted)';
}
function safeUpstream(t) {
  const url=t.source?.url||t.homepage||'';
  try { const u=new URL(url); return u.protocol==='https:'?u.href:''; } catch { return ''; }
}
function renderCards(items) {
  const host=$('templateResults'); host.replaceChildren();
  if(!items.length) { host.append(el('div','template-empty',tr('No templates found. Try another search or Start from Scratch.','Không tìm thấy template. Hãy thử từ khóa khác hoặc tạo từ đầu.'))); return; }
  const scoreMap=new Map((state.matches?.results||[]).map(x=>[x.template_id,x.score]));
  for(const t of items) {
    const card=el('article','template-card');
    const top=el('div','template-card-top');
    top.append(el('h3','',t.name));
    top.append(el('span',`template-kind ${t.kind}`,t.internalOnly?tr('Internal source','Mã nguồn nội bộ'):typeLabel(t.kind)));
    card.append(top);
    card.append(el('p','',t.description||t.tags?.slice(0,4).join(' · ')||t.category));
    const tags=el('div','template-tags');
    for(const tag of (t.tags||[]).slice(0,4)) tags.append(el('span','template-tag',tag));
    card.append(tags);
    const meta=el('div','template-meta');
    meta.append(el('span','',categoryLabel(t.category)));
    meta.append(el('span','',`${tr('License','Giấy phép')}: ${t.license||'UNKNOWN'}`));
    card.append(meta);
    const score=scoreMap.get(t.id);
    if(score!=null) card.append(el('div','template-meta',`${tr('Match score','Điểm phù hợp')}: ${score}/100`));
    const actions=el('div','template-actions');
    const detail=el('button','ws-btn',tr('Details','Chi tiết'));
    detail.type='button'; detail.addEventListener('click',()=>showDetail(t));
    actions.append(detail);
    if(t.kind==='source'&&t.instantiable) {
      const use=el('button','primary',tr('Use source','Dùng mã nguồn'));
      use.type='button'; use.addEventListener('click',()=>createFrom(t));
      actions.append(use);
    } else {
      const info=el('button','ws-btn',t.kind==='package'?tr('Not install-ready','Chưa sẵn sàng cài'):tr('Not editable','Không thể chỉnh sửa'));
      info.type='button'; info.disabled=true; actions.append(info);
    }
    const url=safeUpstream(t);
    if(url) {
      const link=el('a','',tr('Upstream ↗','Mã nguồn gốc ↗'));
      link.href=url; link.target='_blank'; link.rel='noopener noreferrer'; actions.append(link);
    }
    card.append(actions);
    host.append(card);
  }
}
function showDetail(t) {
  const box=$('templateDetail'); box.hidden=false; box.replaceChildren();
  const title=el('strong','',`${t.name} · ${typeLabel(t.kind)}`);
  box.append(title);
  const rows=[
    `${tr('ID','Mã')}: ${t.id}`,
    `${tr('Category','Danh mục')}: ${categoryLabel(t.category)}`,
    `${tr('License','Giấy phép')}: ${t.license||'UNKNOWN'}`,
    `${tr('Source present','Có mã nguồn')}: ${t.sourcePresent?'Yes':'No'}`,
    `${tr('Instantiable','Có thể tạo app')}: ${t.instantiable?'Yes':'No'}`,
    `${tr('SoloHost package verified','Gói SoloHost đã xác minh')}: ${t.verification?.solohostPackageValidated?'Yes':'No'}`,
    `${tr('Upstream','Nguồn gốc')}: ${safeUpstream(t)||'—'}`,
    `${tr('Tags','Thẻ')}: ${(t.tags||[]).join(', ')}`,
    t.internalOnly?tr('Internal verification fixture. It is not offered as a user app starter.','Mẫu kiểm thử nội bộ, không dùng làm ứng dụng khởi đầu cho người dùng.'):
      t.kind==='package'?tr('This is catalog metadata only. No image, ports, environment variables or volumes are assumed.','Đây mới là metadata danh mục. Không tự suy đoán image, port, biến môi trường hay volume.'):
      t.kind==='reference'?tr('Reference entry only. Acquire and verify the upstream source before editing.','Chỉ là mục tham khảo. Cần tải và xác minh mã nguồn gốc trước khi chỉnh sửa.'):
      tr('Editable source template. The original library files are copied, never edited in place.','Template mã nguồn có thể chỉnh sửa. File gốc trong thư viện được giữ nguyên.'),
  ];
  box.append(el('div','',rows.join('\n')));
}
async function loadCatalog() {
  state.loading=true; $('templateCount').textContent=tr('Loading catalog…','Đang tải danh mục…');
  try {
    const [list,cats,health]=await Promise.all([
      request('/api/templates'),request(`/api/templates/categories?locale=${encodeURIComponent(locale())}`),request('/api/templates/catalog-health')
    ]);
    state.items=list.templates||[]; state.categories=cats.categories||[];
    const select=$('templateCategory'); const previous=select.value;
    select.replaceChildren(new Option(tr('All categories','Tất cả danh mục'),''));
    for(const c of state.categories) select.add(new Option(`${c.label} (${c.count})`,c.id));
    if(state.categories.some(c=>c.id===previous)) select.value=previous;
    $('templateSummary').textContent=tr(
      `${health.total} entries · ${health.counts.source} source · ${health.counts.package} Docker packages · ${health.counts.reference} references`,
      `${health.total} mục · ${health.counts.source} mã nguồn · ${health.counts.package} gói Docker · ${health.counts.reference} tham khảo`
    );
    $('templateKindCounts').textContent=`${health.counts.source} / ${health.counts.package} / ${health.counts.reference}`;
    renderCards(state.items);
    $('templateCount').textContent=tr(`${state.items.length} templates`,` ${state.items.length} template`);
  } catch(e) {
    $('templateCount').textContent=tr('Catalog unavailable','Không tải được danh mục');
    setStatus(e.message,true);
  } finally { state.loading=false; }
}
async function filterCatalog() {
  const params=new URLSearchParams();
  if($('templateSearch').value.trim())params.set('q',$('templateSearch').value.trim());
  if($('templateCategory').value)params.set('category',$('templateCategory').value);
  if($('templateKind').value)params.set('kind',$('templateKind').value);
  try {
    const r=await request(`/api/templates?${params}`);
    renderCards(r.templates||[]);
    $('templateCount').textContent=tr(`${r.total} results`,` ${r.total} kết quả`);
  } catch(e) { setStatus(e.message,true); }
}
async function findMatch() {
  const query=$('templateIdea').value.trim();
  if(!query){setStatus(tr('Describe the app first.','Hãy mô tả ứng dụng trước.'),true);return;}
  const btn=$('templateMatchBtn');btn.disabled=true;btn.textContent=tr('Matching…','Đang tìm…');
  try {
    const r=await request('/api/templates/match',{method:'POST',body:JSON.stringify({query,limit:10})});
    state.matches=r;
    const summary=r.selected
      ? `${tr('Best match','Phù hợp nhất')}: ${r.selected.name} (${r.match_score}/100) · ${r.selection_reason}`
      : `${tr('No confident match.','Chưa có kết quả đủ tin cậy.')} ${r.selection_reason}`;
    setStatus(summary);
    if(r.results?.length) {
      const ids=new Set(r.results.map(x=>x.template_id));
      renderCards(state.items.filter(t=>ids.has(t.id)).sort((a,b)=>(r.results.find(x=>x.template_id===b.id)?.score||0)-(r.results.find(x=>x.template_id===a.id)?.score||0)));
      $('templateCount').textContent=tr(`${r.results.length} suggested matches`,` ${r.results.length} gợi ý phù hợp`);
    }
  } catch(e) { setStatus(e.message,true); }
  finally {btn.disabled=false;btn.textContent=tr('Find a match','Tìm template');}
}
async function createFrom(t) {
  if(t.kind!=='source'||!t.instantiable){setStatus(tr('This entry is not an editable source template.','Mục này không phải template mã nguồn có thể chỉnh sửa.'),true);return;}
  const idea=$('templateIdea').value.trim()||`Create an app based on ${t.name}`;
  const btns=[...$('templateResults').querySelectorAll('button')];btns.forEach(b=>b.disabled=true);
  setStatus(tr(`Creating a new project from ${t.name}…`,`Đang tạo dự án mới từ ${t.name}…`));
  try {
    const r=await request(`/api/templates/${encodeURIComponent(t.id)}/instantiate`,{
      method:'POST',body:JSON.stringify({idea,name:t.name})
    });
    setStatus(tr('Project created. Opening it…','Đã tạo dự án. Đang mở…'));
    window.location.assign(`/?p=${encodeURIComponent(r.projectId)}`);
  } catch(e) {setStatus(e.message,true);btns.forEach(b=>b.disabled=false);}
}
function openModal() {
  $('templateLibraryModal').hidden=false;
  document.body.style.overflow='hidden';
  if(!state.items.length)loadCatalog();
  $('templateIdea').focus();
}
function closeModal() {
  $('templateLibraryModal').hidden=true;
  document.body.style.overflow='';
}
function templatesEnabled() {
  try {
    const v = localStorage.getItem('paf.templatesEnabled');
    if (v === null || v === undefined || v === '') return true; // default ON
    return v === '1' || v === 'true';
  } catch { return true; }
}
function setTemplatesEnabled(on) {
  try { localStorage.setItem('paf.templatesEnabled', on ? '1' : '0'); } catch {}
  const btn = $('templatesBtn');
  if (!btn) return;
  btn.classList.toggle('templates-on', on);
  btn.classList.toggle('templates-off', !on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const onLabel = tr('▦ Templates ON','▦ Template BẬT');
  const offLabel = tr('▦ Templates OFF','▦ Template TẮT');
  btn.textContent = on ? onLabel : offLabel;
  btn.title = on
    ? tr('Templates ON — click to turn off. Right-click to open library.','Template BẬT — bấm để tắt. Chuột phải để mở thư viện.')
    : tr('Templates OFF — click to turn on. Right-click to open library.','Template TẮT — bấm để bật. Chuột phải để mở thư viện.');
  window.dispatchEvent(new CustomEvent('paf-templates-toggle',{detail:{enabled:on}}));
}
function toggleTemplates() {
  setTemplatesEnabled(!templatesEnabled());
}
$('templatesBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  toggleTemplates();
});
$('templatesBtn')?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openModal();
});
$('templatesBtn')?.addEventListener('auxclick', (e) => {
  if (e.button === 1) { e.preventDefault(); openModal(); }
});
setTemplatesEnabled(templatesEnabled());
window.pafTemplatesEnabled = templatesEnabled;
$('closeTemplates')?.addEventListener('click',closeModal);
$('templateLibraryModal')?.addEventListener('click',e=>{if(e.target===$('templateLibraryModal'))closeModal();});
$('templateMatchBtn')?.addEventListener('click',findMatch);
$('templateIdea')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();findMatch();}});
$('templateSearch')?.addEventListener('input',()=>{clearTimeout(state.searchTimer);state.searchTimer=setTimeout(filterCatalog,180);});
$('templateCategory')?.addEventListener('change',filterCatalog);
$('templateKind')?.addEventListener('change',filterCatalog);
$('templateScratch')?.addEventListener('click',()=>{
  const idea=$('templateIdea').value.trim();
  const message=document.getElementById('message');
  if(message&&idea){message.value=idea;message.focus();}
  closeModal();
});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('templateLibraryModal').hidden)closeModal();});
window.addEventListener('paf-locale',()=>{if(!$('templateLibraryModal').hidden)loadCatalog();});
