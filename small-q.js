/* Homepage-only, silent contextual companion. No tracking, storage or settings. */
(() => {
  'use strict';
  const root=document.getElementById('small-q');
  if(!root||root.dataset.mounted)return;
  root.dataset.mounted='true';
  document.querySelector('.home-redesign .hero')?.after(root);
  const base=new URL('assets/small-q/',document.currentScript.src);
  const styleURL=new URL('small-q.css?v=2c1b99baab17',document.currentScript.src);
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  const durations={wave:1800,nod:1500,happy:1700,guide:2400};
  root.innerHTML='<img class="small-q-figure" width="320" height="320" alt="陳慧文的小 Q AI 卡通形象" decoding="async"><button class="small-q-dismiss" type="button" aria-label="收起小 Q" title="收起小 Q">×</button>';
  const image=root.querySelector('img');
  const dismiss=root.querySelector('button');
  let ready=false,closed=false,visible=!('IntersectionObserver' in window),sequence=0,timer=null,lastAction=-Infinity;
  const played=new Set();
  const idleURL=new URL('idle.webp',base).href;
  function idle(){sequence++;if(timer!==null)window.clearTimeout(timer);timer=null;if(ready)image.src=idleURL;root.dataset.action='idle';}
  function play(key,once=false){
    if(!ready||closed||!visible||document.hidden||reduced.matches||!durations[key]||(once&&played.has(key))||performance.now()-lastAction<12000)return false;
    lastAction=performance.now();if(once)played.add(key);
    const ticket=++sequence,next=new Image();
    next.onload=()=>{if(ticket!==sequence||closed||!visible||document.hidden||reduced.matches)return;image.src=next.src;root.dataset.action=key;timer=window.setTimeout(idle,durations[key]);};
    next.onerror=()=>{if(ticket===sequence)idle();};
    next.src=new URL(key+'.webp',base).href;
    return true;
  }
  function enter(){if(ready&&visible)play('wave',true);}
  dismiss.addEventListener('click',()=>{closed=true;idle();root.hidden=true;});
  const sync=()=>{root.dataset.reduced=String(reduced.matches);if(reduced.matches||document.hidden)idle();else enter();};
  if(reduced.addEventListener)reduced.addEventListener('change',sync);else reduced.addListener(sync);
  document.addEventListener('visibilitychange',sync);
  if('IntersectionObserver' in window){
    const visibility=new IntersectionObserver(entries=>{for(const entry of entries){visible=entry.isIntersecting;if(!visible)idle();else enter();}});
    visibility.observe(root);
    const context=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;if(entry.target.id==='projects')play('guide',true);if(entry.target.id==='contact')play('happy',true);}},{threshold:0.3});
    for(const id of ['projects','contact']){const target=document.getElementById(id);if(target)context.observe(target);}
  }
  document.querySelectorAll('.home-redesign .filters button[data-filter]').forEach(button=>button.addEventListener('click',()=>play('nod')));
  const show=()=>{const first=new Image();first.onload=()=>{if(closed)return;ready=true;image.src=idleURL;root.hidden=false;sync();enter();};first.onerror=()=>{root.hidden=true;};first.src=idleURL;};
  const start=()=>{const load=()=>{const link=document.createElement('link');link.rel='stylesheet';link.href=styleURL.href;link.onload=show;link.onerror=()=>{root.hidden=true;};document.head.append(link);};if('requestIdleCallback' in window)window.requestIdleCallback(load,{timeout:1200});else window.setTimeout(load,100);};
  sync();if(document.readyState==='complete')start();else window.addEventListener('load',start,{once:true});
})();
