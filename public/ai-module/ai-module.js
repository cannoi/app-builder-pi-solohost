/**
 * Universal AI client helper.
 * Host app keeps its existing UI; only one image/FAB button is required.
 */
window.UniversalAI = (() => {
  async function json(url, options={}) {
    const r=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
    const j=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j.error||`HTTP ${r.status}`);
    return j;
  }
  function create(opts={}) {
    const history=[];
    const button=opts.button;
    const open=()=>opts.onOpen?.();
    if(button) button.addEventListener('click',open);
    return {
      async status(){return json('/api/ai/status');},
      async settings(){return json('/api/ai/settings');},
      async models(){return json('/api/ai/models');},
      async testConnection(){return json('/api/ai/test',{method:'POST'});},
      async saveSettings(v){return json('/api/ai/settings',{method:'POST',body:JSON.stringify(v)});},
      async catalog(){return json('/api/ai/catalog');},
      async chat(message,context={},extra={}){
        const out=await json('/api/ai/chat',{method:'POST',body:JSON.stringify({
          message,context,history:history.slice(-8),actions:extra.actions||[]
        })});
        history.push({role:'user',content:message});
        history.push({role:'assistant',content:out.reply||''});
        while(history.length>20) history.splice(0,2);
        if(Array.isArray(out.actions)) opts.onActions?.(out.actions);
        return out;
      },
      clearHistory(){history.length=0;},
      history
    };
  }
  return {create};
})();
