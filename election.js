'use strict';
(() => {
  const q=(s,r=document)=>r.querySelector(s);
  const qa=(s,r=document)=>[...r.querySelectorAll(s)];
  const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const normalize=v=>String(v??'').normalize('NFKC').toLocaleLowerCase('zh-Hant-TW');
  const statuses=new Set(['持續追蹤','爭取規劃','政策實施']);
  const latest=item=>[...(item.history||[])].sort((a,b)=>String(b.date).localeCompare(String(a.date)))[0];
  const dateLabel=value=>new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Taipei'}).format(new Date(value));
  let expanded=false;
  function announce(id,text) { const n=q(id); if(n) n.textContent=text; }
  async function loadJSON(path) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),5000);
    try {const r=await fetch(path,{cache:'no-store',signal:controller.signal});if(!r.ok)throw new Error(String(r.status));return await r.json();}
    finally {clearTimeout(timer);}
  }
  function card(root,html,search,extra='') {
    const n=document.createElement('article');n.className=`campaign-data-card campaign-searchable ${extra}`;n.dataset.search=normalize(search);n.innerHTML=html;root.append(n);return n;
  }
  function renderPlatforms(data) {
    const root=q('#campaign-platforms'), item=(data.elections||[]).find(x=>Number(x.year)===2026);
    if(!root||!item)return;
    root.replaceChildren();
    for(const s of item.sections||[]) card(root,`<h3>${esc(s.heading)}</h3><ul>${(s.items||[]).map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`,[s.heading,...s.items].join(' '));
    announce('#campaign-platform-count',String(item.sections.reduce((n,s)=>n+s.items.length,0)));
  }
  function renderTracking(items) {
    if(!Array.isArray(items))throw new Error('Invalid public records');
    const root=q('#campaign-tracking');if(!root)return;
    const records=items.filter(i=>statuses.has(i.status)&&(i.sources||[]).length).sort((a,b)=>String(latest(b)?.date||'').localeCompare(String(latest(a)?.date||''))||a.id.localeCompare(b.id));
    root.replaceChildren();
    for(const item of records) {
      const event=latest(item), source=event&&(item.sources||[]).filter(s=>s.sourceDate===event.date).at(-1);
      const url=`achievement-${encodeURIComponent(item.id)}.html`;
      const time=event?`<time${/^\d{4}-\d{2}(?:-\d{2})?$/.test(event.date)?` datetime="${esc(event.date)}"`:''}>${esc(event.date)}</time>`:'日期尚未確認';
      card(root,`<p class="campaign-kicker">紀錄所載狀態 · ${esc(item.status)}</p><h3><a href="${url}">${esc(item.title)}</a></h3><p>${esc(item.summary||'查看公開紀錄與來源。')}</p><p class="campaign-record"><span>最新收錄事件 · ${time}</span>${event?`<strong>${esc(event.title)}</strong>`:''}</p><p class="campaign-note">歷史紀錄；目前狀態請核對最新公告。</p><div class="campaign-actions"><a class="text-link" href="${url}">完整歷程 →</a><a class="text-link" href="${esc(source?.url||url+'#case-sources')}"${source?' target="_blank" rel="noopener noreferrer"':''}>${source?'此階段來源 ↗':'全部來源 →'}</a></div>`,[item.title,item.summary,item.status,...(item.categories||[]),...(item.subcategories||[]),...(item.villages||[]),...(item.history||[]).flatMap(h=>[h.date,h.title,h.text])].join(' '),'campaign-tracking-card');
    }
    announce('#campaign-tracking-count',String(records.length));
    root.dataset.total=String(records.length);
  }
  function calendarURL(event) {
    const fmt=v=>new Date(v).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    return 'https://calendar.google.com/calendar/render?'+new URLSearchParams({action:'TEMPLATE',text:event.name,dates:`${fmt(event.start)}/${fmt(event.end||event.start)}`,ctz:'Asia/Taipei',details:`${event.content||''}\n\n儲存的是當下副本，不會自動更新；出發前請回本站確認。\nhttps://www.huiwen.tw/activities.html#event-${event.id}`,location:event.location||''});
  }
  function renderEvents(data) {
    const root=q('#campaign-events');if(!root)return;
    const events=(data.events||[]).filter(e=>new Date(e.end||e.start).getTime()>=Date.now()).sort((a,b)=>new Date(a.start)-new Date(b.start));
    root.replaceChildren();
    for(const event of events) {
      const cancelled=event.status==='cancelled',rescheduled=event.status==='rescheduled';
      const state=cancelled?'已取消':rescheduled?'已改期':'已公告行程';
      const previous=rescheduled&&event.previousSchedule?`<p>原時間：${esc(dateLabel(event.previousSchedule.start))}；請以新時間為準。</p>`:'';
      card(root,`<p class="campaign-kicker">${state}</p><h3>${esc(event.name)}</h3><time datetime="${esc(event.start)}">${esc(dateLabel(event.start))}</time>${previous}${event.changeNote?`<p>${esc(event.changeNote)}</p>`:''}<p>${esc(event.content||'')}</p><p class="campaign-note">資料更新：${esc(event.updatedAt||event.verifiedAt||'尚未標示')}</p><div class="campaign-actions">${event.sourceUrl?`<a class="text-link" href="${esc(event.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方資訊 ↗</a>`:''}${!cancelled?`<a class="text-link" href="${esc(calendarURL(event))}" target="_blank" rel="noopener noreferrer">加入 Google Calendar ↗</a>`:''}</div>${!cancelled?'<p class="campaign-note">儲存的是當下副本，不會自動更新；出發前請回本站確認。</p>':''}`,[event.name,event.content,event.location,state].join(' '),'campaign-event');
    }
    if(!events.length)root.innerHTML='<p class="campaign-empty">目前沒有即將舉行的公開行程。<a href="activities.html">查看行程紀錄 →</a></p>';
    announce('#campaign-event-count',String(events.filter(e=>e.status!=='cancelled').length));
  }
  function filter() {
    const term=normalize(q('#campaign-search')?.value.trim()||'');let total=0,tracking=0;
    qa('.campaign-searchable').forEach(card=>{
      const match=!term||normalize(card.dataset.search||card.textContent).includes(term);
      let shown=match;
      if(card.classList.contains('campaign-tracking-card')&&match){tracking++;if(!term&&!expanded&&tracking>8)shown=false;}
      card.hidden=!shown;card.classList.toggle('campaign-filter-hidden',!shown);if(match)total++;
    });
    announce('#campaign-search-count',term?`本頁找到 ${total} 個符合項目（搜尋涵蓋全部收錄紀錄）`:'搜尋本頁政見、全部追蹤紀錄與未來公開行程');
    announce('#campaign-tracking-summary',term?`符合追蹤紀錄 ${tracking} 筆`:`收錄 ${tracking} 筆；${expanded?'顯示全部':'先顯示最近收錄事件的 '+Math.min(8,tracking)+' 筆'}`);
    const more=q('#campaign-tracking-more');if(more){more.hidden=Boolean(term)||expanded||tracking<=8;more.textContent=`顯示全部 ${tracking} 筆追蹤紀錄`;}
    const empty=q('#campaign-no-results');if(empty)empty.hidden=!term||total>0;
  }
  function init() {
    q('#campaign-search')?.addEventListener('input',filter);
    q('#campaign-tracking-more')?.addEventListener('click',()=>{expanded=true;filter();});
    q('#campaign-search-all')?.addEventListener('click',()=>document.dispatchEvent(new CustomEvent('huiwen:search',{detail:{query:q('#campaign-search')?.value||''}})));
    q('#campaign-tracking-more')?.removeAttribute('hidden');filter();
    // Each request updates its own section immediately; a stalled source never gates the others.
    const sources=[['data/election-2026.json',d=>window.HuiwenCampaign?.apply(d),'#campaign-date-error'],['data/platforms.json',renderPlatforms,'#campaign-platform-error'],['data/achievements-public.json',renderTracking,'#campaign-tracking-error'],['data/events.json',renderEvents,'#campaign-events-error']];
    for(const [url,render,status] of sources) loadJSON(url).then(data=>{render(data);filter();q(status)?.setAttribute('hidden','');}).catch(()=>{const n=q(status);if(n){n.hidden=false;n.textContent='更新資料暫時無法載入；以下保留發布時的公開紀錄，請核對來源日期。';}});
    window.HuiwenElection=Object.freeze({filter,ready:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
