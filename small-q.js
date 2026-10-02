/* Homepage-only illustrated companion. Local assets; no audio, storage or tracking. */
(() => {
  'use strict';
  const root = document.getElementById('small-q');
  if (!root || root.dataset.mounted) return;
  root.dataset.mounted = 'true';
  const base = new URL('assets/small-q/', document.currentScript.src);
  const actions = {idle:'待機', wave:'揮手', nod:'點頭', happy:'開心', guide:'引導'};
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  root.innerHTML = '<button class="small-q-figure" type="button" aria-label="小 Q，點一下換個動作"><img width="320" height="320" alt="陳慧文小 Q 卡通形象" decoding="async"></button><div class="small-q-bar"><button class="small-q-toggle" type="button" aria-expanded="false" aria-controls="small-q-panel">小 Q 設定</button><button class="small-q-hide" type="button" aria-label="收起小 Q">收起</button></div><div id="small-q-panel" class="small-q-panel" hidden><p>小 Q · 無聲卡通角色</p><div class="small-q-actions" role="group" aria-label="小 Q 動作">' + Object.entries(actions).map(([key,label]) => '<button type="button" data-q-action="'+key+'" aria-pressed="'+(key==='idle')+'">'+label+'</button>').join('') + '</div><button class="small-q-pause" type="button" aria-pressed="false">暫停動態</button><small>AI 卡通形象，姿勢搭配輕動態。</small><span class="small-q-status" role="status" aria-live="polite"></span></div>';
  const image = root.querySelector('img');
  const figure = root.querySelector('.small-q-figure');
  const toggle = root.querySelector('.small-q-toggle');
  const hide = root.querySelector('.small-q-hide');
  const panel = root.querySelector('.small-q-panel');
  const pause = root.querySelector('.small-q-pause');
  const status = root.querySelector('.small-q-status');
  let action='idle', paused=false, collapsed=false, sequence=0;
  function closePanel(focus=false) { panel.hidden=true; toggle.setAttribute('aria-expanded','false'); if(focus)toggle.focus({preventScroll:true}); }
  function sync() {
    root.dataset.paused=String(paused||reduced.matches||document.hidden||collapsed);
    root.dataset.reduced=String(reduced.matches);
    root.dataset.collapsed=String(collapsed);
    figure.hidden=collapsed;
    hide.hidden=collapsed;
    toggle.textContent=collapsed?'顯示小 Q':'小 Q 設定';
    pause.textContent=reduced.matches?'已減少動態':paused?'繼續動態':'暫停動態';
    pause.disabled=reduced.matches;
    pause.setAttribute('aria-pressed',String(paused||reduced.matches));
  }
  function showAction(key) {
    if(!actions[key])return;
    const ticket=++sequence;
    const next=new Image();
    next.onload=()=>{if(ticket!==sequence)return;action=key;image.src=next.src;image.alt='小 Q 卡通角色：'+actions[key];root.dataset.action='';void image.offsetWidth;root.dataset.action=key;root.querySelectorAll('[data-q-action]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.qAction===key)));status.textContent='已選擇'+actions[key];root.hidden=false;sync();};
    next.onerror=()=>{if(ticket!==sequence)return;status.textContent='圖片暫時無法載入，請稍後再試。';};
    next.src=new URL(key+'.webp',base).href;
  }
  figure.addEventListener('click',()=>{const keys=Object.keys(actions);showAction(keys[(keys.indexOf(action)+1)%keys.length]);});
  root.querySelectorAll('[data-q-action]').forEach(b=>b.addEventListener('click',()=>showAction(b.dataset.qAction)));
  toggle.addEventListener('click',()=>{if(collapsed){collapsed=false;sync();return;}panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));});
  hide.addEventListener('click',()=>{collapsed=true;closePanel();sync();toggle.focus({preventScroll:true});});
  pause.addEventListener('click',()=>{if(!reduced.matches)paused=!paused;sync();});
  root.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden){event.preventDefault();closePanel(true);}});
  document.addEventListener('click',event=>{if(!root.contains(event.target))closePanel();});
  document.addEventListener('visibilitychange',sync);
  if(reduced.addEventListener)reduced.addEventListener('change',sync);else reduced.addListener(sync);
  sync();
  // Delay nonessential image work until the primary page has loaded.
  const start=()=>{if('requestIdleCallback' in window)window.requestIdleCallback(()=>showAction('idle'),{timeout:1200});else window.setTimeout(()=>showAction('idle'),100);};
  if(document.readyState==='complete')start();else window.addEventListener('load',start,{once:true});
})();
