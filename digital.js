'use strict';
(() => {
  const VERSION = '20260912-election1';
  const TOPICS = new Set(['交通與基建','教育與文化','環境與綠地','社福與衛環','經濟與產業']);
  const STATIC_PAGES = [
    ['首頁','./','服務處、問政與官網入口','頁面'],
    ['2026選舉資訊','election.html','2026政見、慧文追蹤中、公開行程與選務日期','選舉'],
    ['記者與媒體專區','press.html','新聞、人物資料、公開照片與媒體聯絡','媒體'],
    ['資料查核與澄清','facts.html','查核方法、來源邊界與澄清入口','查核'],
    ['關於慧文','about.html','陳慧文經歷與介紹','頁面'],
    ['政績地圖','achievements.html','鳳山建設、服務與進度查詢','頁面'],
    ['里別／主題探索','explore.html','依里別或主題跨內容探索','探索'],
    ['歷屆政見','vision.html','歷屆選舉政見與願景','政見'],
    ['新聞與議會問政','news.html','新聞、議會問政與地方服務紀錄','新聞'],
    ['活動公告','activities.html','近期活動與公告','頁面'],
    ['服務資訊','service.html','服務時間、法律諮詢與聯絡方式','頁面'],
    ['服務案件陳情','petition.html','服務案件公開表單入口','頁面'],
    ['政治獻金','political-donation.html','政治獻金專戶與注意事項','頁面'],
    ['議會紀錄','council-records.html','高雄市議會公開紀錄','頁面']
  ];

  const escapeHTML = value => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-Hant-TW').replace(/\s+/g,' ').trim();

  function addHeadAssets() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const manifest = document.createElement('link');
      manifest.rel = 'manifest';
      manifest.href = `manifest.webmanifest?v=${VERSION}`;
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
    window.addEventListener('load', () => navigator.serviceWorker.register(`sw.js?v=${VERSION}`).catch(() => {}), {once:true});
  }

  function installTimelineReveal() {
    const items = [...document.querySelectorAll('.case-timeline > li')];
    if (!items.length) return;
    items.forEach(item => item.classList.add('timeline-reveal'));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      items.forEach(item => item.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, {rootMargin:'0px 0px -10% 0px',threshold:0.12});
    items.forEach(item => observer.observe(item));
  }

  async function shareCurrentPage() {
    const data = {title:document.title,text:document.querySelector('meta[name="description"]')?.content || document.title,url:location.href};
    if (navigator.share) {
      try { await navigator.share(data); return; } catch (error) { if (error?.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(location.href);
      const button = document.activeElement;
      if (button instanceof HTMLButtonElement) {
        const old = button.textContent;
        button.textContent = '網址已複製';
        setTimeout(() => { button.textContent = old; },1800);
      }
    } catch (_) {}
  }

  function addAchievementRelations() {
    const head = document.querySelector('.case-head');
    const layout = document.querySelector('.case-layout');
    if (!head || !layout || document.querySelector('.cross-content-explore')) return;
    const labels = [...head.querySelectorAll('.case-tags span')].map(el => el.textContent.trim());
    const topic = labels.find(label => TOPICS.has(label));
    const villages = labels.filter(label => label.endsWith('里') && !TOPICS.has(label));
    if (!topic && !villages.length) return;
    const links = [];
    if (topic) links.push(`<a class="explore-chip" href="explore.html?type=topic&value=${encodeURIComponent(topic)}">${escapeHTML(topic)}：政績 × 新聞 × 政見 →</a>`);
    villages.slice(0,3).forEach(village => links.push(`<a class="explore-chip" href="explore.html?type=village&value=${encodeURIComponent(village)}">探索 ${escapeHTML(village)} →</a>`));
    const section = document.createElement('section');
    section.className = 'wrap cross-content-explore';
    section.setAttribute('aria-labelledby','cross-content-heading');
    section.innerHTML = `<p class="eyebrow">CONNECTED CONTENT</p><h2 id="cross-content-heading">延伸探索</h2><p>依里別與共同主題串連站內內容；關聯僅供探索，不代表個別政見已完成或新聞即為政績證明。</p><div class="explore-chip-list">${links.join('')}</div><button type="button" class="share-current-page">分享這一頁</button>`;
    layout.after(section);
    section.querySelector('.share-current-page')?.addEventListener('click',shareCurrentPage);
  }

  function scoreResult(item,query) {
    if (!query) return item.priority || 0;
    const title = normalize(item.title);
    const text = normalize(`${item.title} ${item.description || ''} ${item.keywords || ''}`);
    let score = 0;
    if (title === query) score += 120;
    if (title.startsWith(query)) score += 70;
    if (title.includes(query)) score += 45;
    if (text.includes(query)) score += 20;
    query.split(' ').filter(Boolean).forEach(token => {
      if (title.includes(token)) score += 15;
      else if (text.includes(token)) score += 5;
    });
    return score;
  }

  async function loadSearchIndex() {
    const results = STATIC_PAGES.map(([title,url,description,type],index) => ({title,url,description,type,keywords:'',priority:30-index}));
    const requests = await Promise.allSettled([
      fetch('data/achievements.json',{cache:'no-store'}).then(r => r.ok ? r.json() : Promise.reject()),
      fetch('data/platforms.json',{cache:'no-store'}).then(r => r.ok ? r.json() : Promise.reject()),
      fetch('news.html',{cache:'no-store'}).then(r => r.ok ? r.text() : Promise.reject())
    ]);
    const achievements = requests[0].status === 'fulfilled' ? requests[0].value : [];
    achievements.forEach(item => results.push({
      title:item.title,
      url:`achievement-${item.id}.html`,
      description:item.summary || `${item.scope || '鳳山區'} · ${item.status || '政績紀錄'}`,
      type:'政績',
      keywords:[...(item.categories || []),...(item.subcategories || []),...(item.villages || []),item.scope,item.status,...(item.paragraphs || []),...((item.history || []).flatMap(h => [h.title,h.text,h.date]))].filter(Boolean).join(' '),
      priority:80
    }));
    const platforms = requests[1].status === 'fulfilled' ? requests[1].value?.elections || [] : [];
    platforms.forEach(item => {
      const text = (item.sections || []).flatMap(section => [section.heading,...(section.items || [])]).join(' ');
      results.push({title:`${item.year} ${item.election}`,url:`vision.html#platform-${item.year}`,description:`${item.district || ''}${item.status ? ` · ${item.status}` : ''}`,type:'政見',keywords:text,priority:50});
    });
    if (requests[2].status === 'fulfilled') {
      const doc = new DOMParser().parseFromString(requests[2].value,'text/html');
      const seen = new Set();
      [...doc.querySelectorAll('main article, [data-news-grid] [data-record]')].forEach(article => {
        const heading = article.querySelector('h1,h2,h3');
        if (!heading) return;
        const title = heading.textContent.trim();
        const direct = article.querySelector('a[href^="news-"],a[href*="news-"]');
        const url = direct?.getAttribute('href') || (article.id ? `news.html#${article.id}` : 'news.html');
        const key = `${title}|${url}`;
        if (seen.has(key)) return;
        seen.add(key);
        const date = article.querySelector('time,.eyebrow')?.textContent.trim() || '';
        const description = article.querySelector('.section-intro,p:not(.source-note)')?.textContent.trim() || '';
        results.push({title,url,description,type:'新聞',keywords:`${date} ${article.textContent}`,priority:60});
      });
    }
    return results;
  }

  function installAchievementDashboard() {
    const mapData = document.getElementById('map-data');
    const controls = document.querySelector('.map-controls');
    const mapRoot = document.getElementById('achievement-map');
    if (!mapData || !controls || !mapRoot || document.querySelector('.digital-dashboard')) return;
    let data;
    try { data = JSON.parse(mapData.textContent); } catch (_) { return; }
    const search = document.getElementById('case-search');
    const village = document.getElementById('village-filter');
    const category = document.getElementById('category-filter');
    const subcategory = document.getElementById('subcategory-filter');
    const status = document.getElementById('status-filter');
    const caseList = document.getElementById('case-list');
    const caseCount = document.getElementById('case-count');
    if (!search || !village || !category || !subcategory || !status || !caseList) return;
    const villages = [...new Set(data.flatMap(item => item.villages || []))];
    const topics = [...new Set(data.flatMap(item => item.categories || []))];
    const mapped = data.filter(item => Array.isArray(item.coordinates) && item.coordinates.length === 2).length;
    const dashboard = document.createElement('section');
    dashboard.className = 'wrap digital-dashboard';
    dashboard.setAttribute('aria-label','政績統計儀表板');
    dashboard.innerHTML = `<div class="digital-dashboard-grid"><div class="digital-stat"><strong>${data.length}</strong><span>建設與服務專題</span></div><div class="digital-stat"><strong>${villages.length}</strong><span>已有紀錄里別</span></div><div class="digital-stat"><strong>${topics.length}</strong><span>主題分類</span></div><div class="digital-stat"><strong>${mapped}</strong><span>有代表點位紀錄</span></div></div><div class="digital-dashboard-topics" aria-label="依主題快速篩選"></div>`;
    const topicBox = dashboard.querySelector('.digital-dashboard-topics');
    topics.forEach(topic => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${topic} ${data.filter(item => (item.categories || []).includes(topic)).length}`;
      button.addEventListener('click',() => {
        category.value = topic;
        category.dispatchEvent(new Event('change',{bubbles:true}));
        controls.scrollIntoView({behavior:'smooth',block:'start'});
      });
      topicBox.append(button);
    });
    const explore = document.createElement('a');
    explore.className = 'explore-chip';
    explore.href = 'explore.html';
    explore.textContent = '里別／主題進階探索 →';
    topicBox.append(explore);
    controls.before(dashboard);

    const insight = document.createElement('aside');
    insight.className = 'map-insight-panel';
    insight.setAttribute('aria-live','polite');
    mapRoot.after(insight);
    const fits = item => {
      const q = search.value.trim().toLocaleLowerCase();
      const text = [item.title,item.summary,...(item.categories || []),...(item.subcategories || []),...(item.villages || []),item.scope].join(' ').toLocaleLowerCase();
      const villageOK = village.value === 'all' || (village.value === 'unassigned' ? !(item.villages || []).length && !['全市政策','跨區服務'].includes(item.scope) : village.value.startsWith('v:') ? (item.villages || []).includes(village.value.slice(2)) : item.scope === village.value.slice(2));
      return (!q || text.includes(q)) && (category.value === 'all' || (item.categories || []).includes(category.value)) && (subcategory.value === 'all' || (item.subcategories || []).includes(subcategory.value)) && (status.value === 'all' || item.status === status.value) && villageOK;
    };
    const breakdown = cases => {
      const counts = new Map();
      cases.forEach(item => (item.categories || []).forEach(topic => counts.set(topic,(counts.get(topic) || 0) + 1)));
      return [...counts.entries()].sort((a,b) => b[1]-a[1]).slice(0,5);
    };
    const render = () => {
      const visible = data.filter(fits);
      const selected = caseList.querySelector('.case-card.is-selected');
      if (selected) {
        const item = data.find(entry => entry.id === selected.dataset.case);
        if (item) {
          insight.innerHTML = `<p class="eyebrow">MAP POINT</p><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.summary || `${item.scope || '鳳山區'} · ${item.status || ''}`)}</p><div class="insight-breakdown">${(item.categories || []).map(topic => `<span>${escapeHTML(topic)}</span>`).join('')}${(item.villages || []).map(name => `<span>${escapeHTML(name)}</span>`).join('')}</div><a href="achievement-${encodeURIComponent(item.id)}.html">閱讀完整紀錄 →</a>`;
          return;
        }
      }
      if (village.value.startsWith('v:')) {
        const name = village.value.slice(2);
        const cases = visible.filter(item => (item.villages || []).includes(name));
        insight.innerHTML = `<p class="eyebrow">VILLAGE VIEW</p><h3>${escapeHTML(name)}</h3><p>目前條件下收錄 ${cases.length} 筆建設與服務紀錄。</p><div class="insight-breakdown">${breakdown(cases).map(([topic,total]) => `<span>${escapeHTML(topic)} ${total}</span>`).join('')}</div><a href="explore.html?type=village&value=${encodeURIComponent(name)}">完整探索 ${escapeHTML(name)} →</a>`;
        return;
      }
      const visibleMapped = visible.filter(item => item.coordinates).length;
      insight.innerHTML = `<p class="eyebrow">LIVE VIEW</p><h3>目前篩選結果：${visible.length} 筆</h3><p>${visibleMapped} 筆有地圖代表點位。點選里界、點位或卡片可繼續探索。</p><div class="insight-breakdown">${breakdown(visible).map(([topic,total]) => `<span>${escapeHTML(topic)} ${total}</span>`).join('')}</div><a href="explore.html">開啟里別／主題探索 →</a>`;
    };
    [search,village,category,subcategory,status].forEach(control => control.addEventListener(control === search ? 'input' : 'change',() => requestAnimationFrame(render)));
    if (caseCount) new MutationObserver(() => requestAnimationFrame(render)).observe(caseCount,{childList:true,subtree:true,characterData:true});
    new MutationObserver(() => requestAnimationFrame(render)).observe(caseList,{subtree:true,attributes:true,attributeFilter:['class']});
    render();
  }

  function buildSearchUI() {
    if (document.querySelector('.global-search-trigger')) return;
    const header = document.querySelector('.site-header .nav-wrap');
    if (!header) return;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'global-search-trigger';
    trigger.setAttribute('aria-haspopup','dialog');
    trigger.setAttribute('aria-label','搜尋陳慧文官網');
    trigger.innerHTML = '<span aria-hidden="true">⌕</span><span>搜尋</span><kbd>⌘ K</kbd>';
    const menuToggle = header.querySelector('.menu-toggle');
    header.insertBefore(trigger,menuToggle || header.querySelector('nav'));

    let dialog = null;
    let input = null;
    let resultBox = null;
    let status = null;
    let indexPromise = null;
    let buttons = [];
    let active = 0;

    const updateActive = () => buttons.forEach((button,index) => {
      button.classList.toggle('is-active',index === active);
      button.setAttribute('aria-selected',String(index === active));
    });

    const render = async () => {
      if (!input || !resultBox || !status) return;
      const index = await (indexPromise || (indexPromise = loadSearchIndex()));
      const query = normalize(input.value);
      const matches = index.map(item => ({...item,score:scoreResult(item,query)})).filter(item => query ? item.score > 0 : item.priority > 0).sort((a,b) => b.score-a.score || b.priority-a.priority).slice(0,12);
      resultBox.replaceChildren();
      matches.forEach((item,indexValue) => {
        const link = document.createElement('a');
        link.href = item.url;
        link.className = 'global-search-result';
        link.setAttribute('role','option');
        link.dataset.index = String(indexValue);
        link.innerHTML = `<span class="global-search-type">${escapeHTML(item.type)}</span><span class="global-search-result-copy"><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.description || item.url)}</small></span><span aria-hidden="true">→</span>`;
        resultBox.append(link);
      });
      buttons = [...resultBox.querySelectorAll('a')];
      active = 0;
      updateActive();
      status.textContent = query ? (matches.length ? `找到 ${matches.length} 個最相關結果` : '找不到符合內容，試試不同關鍵字。') : '快速前往常用頁面；輸入關鍵字可搜尋政績、新聞與政見。';
    };

    const close = () => {
      if (!dialog) return;
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      document.body.classList.remove('search-open');
    };

    const ensureDialog = () => {
      if (dialog) return;
      dialog = document.createElement('dialog');
      dialog.id = 'global-search-dialog';
      dialog.className = 'global-search-dialog';
      dialog.innerHTML = `<form method="dialog" class="global-search-shell" role="search"><div class="global-search-input-row"><span aria-hidden="true">⌕</span><input type="search" autocomplete="off" spellcheck="false" aria-label="搜尋陳慧文官網" placeholder="搜尋政績、新聞、政見、里別……"><button class="global-search-close" value="cancel" aria-label="關閉搜尋">Esc</button></div><div class="global-search-status" aria-live="polite">輸入關鍵字搜尋全站內容</div><div class="global-search-results" role="listbox" aria-label="搜尋結果"></div><div class="global-search-footer"><span>↑↓ 選擇 · Enter 開啟 · Esc 關閉</span><a href="explore.html">進階探索 →</a></div></form>`;
      document.body.append(dialog);
      input = dialog.querySelector('input');
      resultBox = dialog.querySelector('.global-search-results');
      status = dialog.querySelector('.global-search-status');
      input.addEventListener('input',render);
      dialog.addEventListener('close',() => { document.body.classList.remove('search-open'); trigger.focus(); });
      dialog.addEventListener('click',event => { if (event.target === dialog) close(); });
      dialog.addEventListener('keydown',event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        if (!buttons.length) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); active = (active + 1) % buttons.length; updateActive(); buttons[active].scrollIntoView({block:'nearest'}); }
        if (event.key === 'ArrowUp') { event.preventDefault(); active = (active - 1 + buttons.length) % buttons.length; updateActive(); buttons[active].scrollIntoView({block:'nearest'}); }
        if (event.key === 'Enter' && document.activeElement === input) { event.preventDefault(); buttons[active]?.click(); }
      });
    };

    const open = () => {
      ensureDialog();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open','');
      document.body.classList.add('search-open');
      if (!indexPromise) indexPromise = loadSearchIndex();
      requestAnimationFrame(() => { input.focus(); render(); });
    };

    trigger.addEventListener('click',open);
    document.addEventListener('keydown',event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        dialog?.open ? close() : open();
      }
    });
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) trigger.querySelector('kbd').textContent = 'Ctrl K';
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
  installAchievementDashboard();
  installTimelineReveal();
  addAchievementRelations();
  setupInstallPrompt();
})();
