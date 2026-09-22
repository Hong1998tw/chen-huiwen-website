'use strict';
(() => {
  const assetBase = new URL('.', document.currentScript.src);
  const VERSION = '20260912-p0-v2';
  const SERVICE_WORKER_VERSION = '20260922-public-service-v11';
  const TOPICS = new Set(['交通與基建','教育與文化','環境與綠地','社福與衛環','經濟與產業']);
  const STATIC_PAGES = [
    ['首頁','./','服務處、問政與官網入口','頁面'],
    ['2026鳳山選戰','election.html','勝選倒數、重要選務日期、2026政見、政績與公開行程','選舉'],
    ['關於慧文','about.html','陳慧文經歷與介紹','頁面'],
    ['政績地圖','achievements.html','鳳山建設、服務與進度查詢','頁面'],
    ['里別／主題探索','explore.html','依里別或主題跨內容探索','探索'],
    ['歷屆政見','vision.html','歷屆選舉政見與願景','政見'],
    ['新聞與議會問政','news.html','新聞、議會問政與地方服務紀錄','新聞'],
    ['公開行程與活動','activities.html','近期公開行程與活動資訊','頁面'],
    ['服務資訊','service.html','服務時間、法律諮詢與聯絡方式','頁面'],
    ['服務案件陳情','petition.html','服務案件公開表單入口','頁面'],
    ['政治獻金','political-donation.html','政治獻金專戶與注意事項','頁面'],
    ['議會紀錄','council-records.html','高雄市議會公開紀錄','頁面']
  ];

  const escapeHTML = value => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-Hant-TW').replace(/臺/g,'台').replace(/\s+/g,' ').trim();

  function addHeadAssets() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const manifest = document.createElement('link');
      manifest.rel = 'manifest';
      manifest.href = new URL(`manifest.webmanifest?v=${VERSION}`, assetBase).href;
      document.head.append(manifest);
    }
    if (!document.querySelector('meta[name="application-name"]')) {
      const meta = document.createElement('meta');
      meta.name = 'application-name';
      meta.content = '陳慧文官網';
      document.head.append(meta);
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    if (['localhost','127.0.0.1'].includes(location.hostname)) return;
    window.addEventListener('load', () => navigator.serviceWorker.register(new URL(`sw.js?v=${SERVICE_WORKER_VERSION}`,assetBase).href).catch(() => {}), {once:true});
  }

  function installTimelineReveal() {
    const items = [...document.querySelectorAll('.case-timeline > li')];
    if (!items.length) return;
    items.forEach(item => item.classList.add('timeline-reveal'));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      items.forEach(item => item.classList.add('is-visible'));
      return;
    }
    const revealAll = () => items.forEach(item => item.classList.add('is-visible'));
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    media.addEventListener('change', event => { if (event.matches) revealAll(); });
    window.addEventListener('beforeprint', revealAll);
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, {rootMargin:'0px 0px -10% 0px',threshold:0.12});
    items.forEach(item => { observer.observe(item); item.addEventListener('focusin', () => item.classList.add('is-visible')); });
  }

  async function shareCurrentPage(event) {
    const button=event?.currentTarget;
    const url=location.href;
    const data={title:document.title,text:document.querySelector('meta[name="description"]')?.content||document.title,url};
    if(navigator.share){try{await navigator.share(data);return;}catch(error){if(error?.name==='AbortError')return;}}
    try{
      await navigator.clipboard.writeText(url);
      if(button){const old=button.textContent;button.textContent='網址已複製';button.setAttribute('aria-live','polite');setTimeout(()=>{button.textContent=old;},1800);}
    }catch(_){
      const dialog=document.createElement('dialog');dialog.className='share-fallback';dialog.setAttribute('aria-label','複製分享網址');
      dialog.innerHTML='<h2>分享這一頁</h2><p>請選取並複製下方網址。</p><input readonly aria-label="分享網址"><button type="button">關閉</button>';
      document.body.append(dialog);const input=dialog.querySelector('input');input.value=url;
      dialog.querySelector('button').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{dialog.remove();button?.focus();});dialog.showModal();input.select();
    }
  }

  function addAchievementRelations() {
    const head = document.querySelector('.case-head');
    const layout = document.querySelector('.case-layout');
    if (!head || !layout || document.querySelector('.cross-content-explore')) return;
    const labels = [...head.querySelectorAll('.case-tags span')].map(el => el.textContent.trim());
    const topic = TOPICS.has(head.dataset.topic) ? head.dataset.topic : labels.find(label => TOPICS.has(label));
    const villages = labels.filter(label => label.endsWith('里') && !TOPICS.has(label));
    if (!topic && !villages.length) return;
    const links = [];
    if (topic) links.push(`<a class="explore-chip" href="explore.html?type=topic&value=${encodeURIComponent(topic)}">${escapeHTML(topic)}：政績 × 新聞 × 政見 →</a>`);
    villages.slice(0,3).forEach(village => links.push(`<a class="explore-chip" href="explore.html?type=village&value=${encodeURIComponent(village)}">探索 ${escapeHTML(village)} →</a>`));
    const section = document.createElement('section');
    section.className = 'wrap cross-content-explore';
    section.setAttribute('aria-labelledby','cross-content-heading');
    section.innerHTML = `<p class="eyebrow">延伸閱讀</p><h2 id="cross-content-heading">延伸探索</h2><p>依里別與共同主題串連政績、新聞與政見，方便一次閱讀相關內容。</p><div class="explore-chip-list">${links.join('')}</div><button type="button" class="share-current-page">分享這一頁</button>`;
    layout.after(section);
    section.querySelector('.share-current-page')?.addEventListener('click',shareCurrentPage);
  }

  function scoreResult(item, query) {
    if (!query) return item.priority || 0;
    const title = normalize(item.title), text = normalize(`${item.title} ${item.description || ''} ${item.keywords || ''}`);
    const tokens = query.split(' ').filter(Boolean);
    if (!tokens.every(token => text.includes(token))) return 0;
    const serviceIntent = (item.intents || []).some(intent => normalize(intent) === query);
    return (serviceIntent ? 300 : 0) + 20 + (title === query ? 120 : title.startsWith(query) ? 70 : title.includes(query) ? 45 : 0) + tokens.filter(token => title.includes(token)).length * 15;
  }

  async function loadSearchIndex() {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(new URL('data/search-index.json',assetBase), {signal:controller.signal});
      if (!response.ok) throw Error('index unavailable');
      const payload = await response.json();
      if (!Array.isArray(payload.items) || !payload.items.length) throw Error('invalid index');
      // Search results are navigation within this site, never executable or external URLs.
      // This is defense in depth against malformed generated data, not an HTML sanitizer.
      const items = payload.items.filter(item => {
        if (!item || typeof item.title !== 'string' || typeof item.url !== 'string') return false;
        try {
          const url = new URL(item.url, assetBase);
          return ['http:', 'https:'].includes(url.protocol) && url.origin === location.origin && !url.username && !url.password;
        } catch { return false; }
      });
      if (!items.length) throw Error('invalid index destinations');
      return {items, partial:false};
    } catch (_) {
      return {items:STATIC_PAGES.map(([title,url,description,type],i) => ({title,url,description,type,priority:30-i})),partial:true};
    } finally { clearTimeout(timeout); }
  }

  function installAchievementInsights() {
    const api = window.HuiwenCases;
    const map = document.getElementById('achievement-map');
    const existing = document.querySelector('.map-insight-panel');
    if (!map || existing?.dataset.ready === 'true') return;
    if (!api) { document.addEventListener('huiwen:cases-change', installAchievementInsights, {once:true}); return; }
    const insight = existing || document.createElement('aside');
    insight.dataset.ready = 'true';
    insight.className = 'map-insight-panel'; insight.setAttribute('aria-label','地圖資訊');
    if (!insight.isConnected) map.after(insight);
    function render() {
      const {visible,selectedId,groupIds,filters}=api.getState();
      const mapped=visible.filter(c=>c.coordinates).length;
      const item=visible.find(c=>c.id===selectedId);
      if(item){
        const latest=item.history.at(-1);
        insight.innerHTML=`<div class="insight-top"><p class="eyebrow">SELECTED PLACE</p><button type="button" class="insight-clear" aria-label="取消地圖選取">取消選取 ×</button></div><h2>${escapeHTML(item.title)}</h2><p>${escapeHTML(item.summary)}</p><div class="insight-breakdown"><span>${escapeHTML(item.status)}</span><span>${escapeHTML(item.villages.join('、')||item.scope)}</span></div>${latest?`<p class="insight-history">最後一筆歷程 · ${escapeHTML(latest.date)}<br>${escapeHTML(latest.title)}</p>`:''}<p class="insight-location">${escapeHTML(item.locationNote||'點位為代表位置，不是工程範圍。')}</p><a href="achievement-${encodeURIComponent(item.id)}.html">閱讀完整紀錄與來源 →</a>${groupIds.length>1?'<div class="insight-group"><h3>附近的其他專題</h3></div>':''}`;
        insight.querySelector('.insight-clear').addEventListener('click',()=>{api.clearSelection();document.getElementById('map-fit').focus();});
        if(groupIds.length>1) for(const id of groupIds){const c=visible.find(c=>c.id===id);if(!c||id===selectedId)continue;const button=document.createElement('button');button.type='button';button.textContent=c.title;button.addEventListener('click',()=>api.selectCase(id,groupIds));insight.querySelector('.insight-group').append(button);}
      }else{
        const village=filters.village.startsWith('v:')?filters.village.slice(2):null;
        insight.innerHTML=`<p class="eyebrow">LIVE MAP VIEW</p><h2>${escapeHTML(village||'目前篩選結果')}：${visible.length} 筆</h2><p>${mapped} 筆有代表點位，${visible.length-mapped} 筆由列表閱讀。</p><p>點選里界可篩選，點選點位或「地圖定位」可查看專題進度。</p><a href="#case-results">查看目前結果 ↓</a>`;
      }
    }
    document.addEventListener('huiwen:cases-change',render);
    render();
  }

  function buildSearchUI() {
    const header=document.querySelector('.site-header .nav-wrap');
    if(!header||document.querySelector('.global-search-trigger'))return;
    const trigger=document.createElement('button');trigger.type='button';trigger.className='global-search-trigger';
    trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-label','搜尋陳慧文官網');
    trigger.innerHTML='<span aria-hidden="true">⌕</span><span>搜尋</span><kbd>⌘ K</kbd>';
    header.insertBefore(trigger,header.querySelector('.menu-toggle'));
    let dialog,input,box,status,more,retry,indexPromise,buttons=[],active=0,limit=12,returnFocus;
    const updateActive=()=>{buttons.forEach((button,i)=>{button.classList.toggle('is-active',i===active);button.setAttribute('aria-selected',String(i===active));});if(buttons[active])input.setAttribute('aria-activedescendant',buttons[active].id);else input.removeAttribute('aria-activedescendant');};
    const highlight=(text,query)=>{
      const span=document.createElement('span');span.textContent=text;
      if(!query)return span.innerHTML;
      // Highlight exact matched words using text nodes; never interpret search input as HTML.
      const tokens=query.split(' ').filter(Boolean).sort((a,b)=>b.length-a.length);
      // Keep offsets in the original string: NFKC/whitespace normalization changes
      // string lengths and used to highlight the characters AFTER the match.
      const value=String(text), lower=value.toLocaleLowerCase('zh-Hant-TW');let pos=0;
      span.replaceChildren();
      while(pos<value.length){let best=-1,token='';for(const t of tokens){const i=lower.indexOf(t,pos);if(i>=0&&(best<0||i<best)){best=i;token=t;}}if(best<0){span.append(document.createTextNode(value.slice(pos)));break;}span.append(document.createTextNode(value.slice(pos,best)));const mark=document.createElement('mark');mark.textContent=value.slice(best,best+token.length);span.append(mark);pos=best+token.length;}
      return span.innerHTML;
    };
    async function render(){
      if(!input)return;
      const payload=await(indexPromise||(indexPromise=loadSearchIndex()));
      if(!dialog.open)return;
      const query=normalize(input.value);
      const all=payload.items.map(item=>({...item,score:scoreResult(item,query)})).filter(item=>query?item.score>0:item.priority>0).sort((a,b)=>b.score-a.score||b.priority-a.priority);
      box.replaceChildren();
      all.slice(0,limit).forEach((item,i)=>{
        const link=document.createElement('a');link.href=new URL(item.url,assetBase).href;link.id=`global-result-${i}`;link.className='global-search-result';link.setAttribute('role','option');
        let snippet=item.description||item.url;
        if(query&&item.type!=='服務'&&!normalize(snippet).includes(query.split(' ')[0])){const body=String(item.keywords||'');const offset=body.toLocaleLowerCase('zh-Hant-TW').indexOf(query.split(' ')[0]);if(offset>=0)snippet=(offset>22?'…':'')+body.slice(Math.max(0,offset-22),offset+95);}
        link.innerHTML=`<span class="global-search-type">${escapeHTML(item.type)}</span><span class="global-search-result-copy"><strong>${highlight(item.title,query)}</strong><small>${highlight(snippet,query)}</small></span><span aria-hidden="true">→</span>`;
        box.append(link);
      });
      buttons=[...box.querySelectorAll('a')];active=0;updateActive();
      more.hidden=all.length<=limit;retry.hidden=!payload.partial;
      status.textContent=(payload.partial?'搜尋資料暫時無法載入，目前僅顯示常用頁面。 ': '')+(query?(all.length?`找到 ${all.length} 個結果，顯示 ${buttons.length} 個`:'找不到符合內容，試試不同關鍵字。'):'搜尋全站政績、新聞、政見、活動與服務資訊。');
    }
    const close=()=>dialog?.close();
    function ensure(){
      if(dialog)return;
      dialog=document.createElement('dialog');dialog.id='global-search-dialog';dialog.className='global-search-dialog';dialog.setAttribute('aria-label','全站搜尋');
      dialog.innerHTML=`<div class="global-search-shell" role="search"><div class="global-search-input-row"><span aria-hidden="true">⌕</span><input type="search" autocomplete="off" spellcheck="false" aria-label="搜尋陳慧文官網" aria-controls="global-search-results" aria-autocomplete="list" placeholder="搜尋政績、新聞、政見、里別……"><button type="button" class="global-search-close" aria-label="關閉搜尋">Esc</button></div><div class="global-search-status" role="status">搜尋資料載入中…</div><div class="global-search-results" id="global-search-results" role="listbox" aria-label="搜尋結果"></div><div class="search-extra"><button type="button" data-search-more hidden>顯示更多結果</button><button type="button" data-search-retry hidden>重新載入搜尋資料</button></div><div class="global-search-footer"><span>↑↓ 選擇 · Enter 開啟 · Esc 關閉</span><a href="${new URL('explore.html',assetBase).href}">進階探索 →</a></div></div>`;
      document.body.append(dialog);input=dialog.querySelector('input');box=dialog.querySelector('.global-search-results');status=dialog.querySelector('.global-search-status');more=dialog.querySelector('[data-search-more]');retry=dialog.querySelector('[data-search-retry]');
      input.addEventListener('input',e=>{limit=12;if(!e.isComposing)render();});input.addEventListener('compositionend',()=>render());
      more.addEventListener('click',()=>{limit+=12;render();});retry.addEventListener('click',()=>{indexPromise=null;status.textContent='重新載入中…';render();});
      dialog.querySelector('.global-search-close').addEventListener('click',close);
      dialog.addEventListener('close',()=>{document.body.classList.remove('search-open');const target=returnFocus?.isConnected&&returnFocus.getClientRects().length?returnFocus:document.querySelector('.menu-toggle');target?.focus();});
      dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}});
      dialog.addEventListener('keydown',e=>{
        if(e.isComposing)return;
        if(e.key==='Escape'){e.preventDefault();close();return;}
        if(document.activeElement!==input||!buttons.length)return;
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();active=(active+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;updateActive();buttons[active].scrollIntoView({block:'nearest'});}
        if(e.key==='Enter'){e.preventDefault();buttons[active]?.click();}
      });
    }
    const open=(query)=>{document.dispatchEvent(new Event('site:close-menu'));ensure();returnFocus=document.activeElement;dialog.showModal();document.body.classList.add('search-open');if(typeof query==='string'){input.value=query.slice(0,300);limit=12;}input.focus();render();};
    trigger.addEventListener('click',open);
    document.addEventListener('huiwen:search', event => {
      if (typeof event.detail?.query !== 'string') return;
      open(event.detail.query);
    });
    document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&!e.isComposing){e.preventDefault();dialog?.open?close():open();}});
    if(!/Mac|iPhone|iPad/.test(navigator.platform))trigger.querySelector('kbd').textContent='Ctrl K';
  }

  function setupInstallPrompt() {
    let promptEvent = null;
    window.addEventListener('beforeinstallprompt',event => {
      event.preventDefault();
      promptEvent = event;
      const footer = document.querySelector('.footer-bottom div');
      if (!footer || footer.querySelector('[data-install-app]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-link pwa-install-link';
      button.dataset.installApp = '';
      button.textContent = '加入主畫面';
      button.addEventListener('click',async () => {
        if (!promptEvent) return;
        await promptEvent.prompt();
        promptEvent = null;
        button.remove();
      });
      footer.append(document.createTextNode(' '),button);
    });
  }

  addHeadAssets();
  registerServiceWorker();
  buildSearchUI();
  installAchievementInsights();
  installTimelineReveal();
  addAchievementRelations();
  setupInstallPrompt();
  if (!document.querySelector('.share-current-page')) { const footer=document.querySelector('.footer-bottom div');if(footer){const button=document.createElement('button');button.type='button';button.className='share-current-page';button.textContent='分享這一頁';button.addEventListener('click',shareCurrentPage);footer.append(button);} }
})();
