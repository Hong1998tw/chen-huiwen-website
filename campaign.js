'use strict';
(() => {
  const q = (sel, root=document) => root.querySelector(sel);
  const qa = (sel, root=document) => [...root.querySelectorAll(sel)];
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-Hant-TW');
  const dateLabel = value => {
    try { return new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Taipei'}).format(new Date(value)); }
    catch { return value || ''; }
  };
  const googleCalendar = event => {
    const fmt = value => new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    const params = new URLSearchParams({action:'TEMPLATE',text:event.name || '公開行程',dates:`${fmt(event.start)}/${fmt(event.end || event.start)}`,details:event.content || '',location:event.location || ''});
    return `https://calendar.google.com/calendar/render?${params}`;
  };

  async function loadJSON(path) {
    const response = await fetch(path,{cache:'no-store'});
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }

  function renderPlatforms(data) {
    const root = q('#campaign-platforms');
    const status = q('#campaign-platform-status');
    if (!root) return [];
    const item = (data.elections || []).find(entry => Number(entry.year) === 2026);
    if (!item) { root.innerHTML = '<p class="campaign-empty">目前尚未收錄 2026 政見資料。</p>'; return []; }
    if (status) status.textContent = item.status || '';
    const cards = [];
    (item.sections || []).forEach(section => {
      const article = document.createElement('article');
      article.className = 'campaign-data-card campaign-searchable';
      article.dataset.search = normalize([section.heading,...(section.items || [])].join(' '));
      article.innerHTML = `<p class="campaign-kicker">2026 政見</p><h3>${esc(section.heading)}</h3><ul>${(section.items || []).map(text => `<li>${esc(text)}</li>`).join('')}</ul>`;
      root.append(article); cards.push(article);
    });
    q('#campaign-platform-count')?.replaceChildren(document.createTextNode(String((item.sections || []).reduce((n,s) => n + (s.items || []).length,0))));
    return cards;
  }

  function renderTracking(items) {
    const root = q('#campaign-tracking');
    if (!root) return [];
    const trackable = (items || []).filter(item => item.status && item.status !== '待核驗' && item.status !== '已完成' && (item.sources || []).length)
      .sort((a,b) => String(b.updated || '').localeCompare(String(a.updated || ''))).slice(0,8);
    if (!trackable.length) { root.innerHTML = '<p class="campaign-empty">目前沒有符合公開來源條件的追蹤項目。</p>'; return []; }
    trackable.forEach(item => {
      const article = document.createElement('article');
      article.className = 'campaign-data-card campaign-searchable';
      article.dataset.search = normalize([item.title,item.summary,item.status,...(item.categories || []),...(item.subcategories || []),...(item.villages || [])].join(' '));
      const source = item.sources?.[0];
      article.innerHTML = `<div class="campaign-badges"><span class="campaign-badge">${esc(item.status)}</span>${(item.subcategories || []).slice(0,2).map(tag => `<span class="campaign-badge">${esc(tag)}</span>`).join('')}</div><h3>${esc(item.title)}</h3><p>${esc(item.summary || '查看完整紀錄與來源。')}</p><p class="campaign-note">最近更新：${esc(item.updated || '未標示')}</p><div class="campaign-actions"><a class="text-link" href="achievement-${encodeURIComponent(item.id)}.html">查看追蹤紀錄 →</a>${source ? `<a class="text-link" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">第一手來源 ↗</a>` : ''}</div>`;
      root.append(article);
    });
    q('#campaign-tracking-count')?.replaceChildren(document.createTextNode(String(trackable.length)));
    return trackable;
  }

  function renderEvents(data) {
    const root = q('#campaign-events');
    if (!root) return [];
    const now = Date.now();
    const events = (data.events || []).filter(event => new Date(event.end || event.start).getTime() >= now).sort((a,b) => new Date(a.start) - new Date(b.start));
    if (!events.length) { root.innerHTML = '<p class="campaign-empty">目前沒有已核驗的未來公開行程；新增行程後會從活動資料自動顯示。</p>'; return []; }
    events.forEach(event => {
      const article = document.createElement('article');
      article.className = 'campaign-panel campaign-event campaign-searchable';
      article.dataset.search = normalize([event.name,event.content,event.registration].join(' '));
      article.innerHTML = `<time datetime="${esc(event.start)}">${esc(dateLabel(event.start))}</time><div><h3>${esc(event.name)}</h3><p>${esc(event.content || '')}</p><p class="campaign-note">資料查核：${esc(event.verifiedAt || '未標示')}</p><div class="campaign-actions">${event.sourceUrl ? `<a class="text-link" href="${esc(event.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方資訊 ↗</a>` : ''}<a class="text-link" href="${googleCalendar(event)}" target="_blank" rel="noopener noreferrer">加入 Google Calendar ↗</a></div></div>`;
      root.append(article);
    });
    q('#campaign-event-count')?.replaceChildren(document.createTextNode(String(events.length)));
    return events;
  }

  function installSearch() {
    const input = q('#campaign-search');
    if (!input) return;
    const count = q('#campaign-search-count');
    const filter = () => {
      const term = normalize(input.value.trim());
      let visible = 0;
      qa('.campaign-searchable').forEach(card => {
        const match = !term || (card.dataset.search || normalize(card.textContent)).includes(term);
        card.classList.toggle('campaign-filter-hidden',!match);
        if (match) visible += 1;
      });
      if (count) count.textContent = term ? `找到 ${visible} 個符合項目` : '搜尋 2026 政見、追蹤與公開行程';
    };
    input.addEventListener('input',filter);
    filter();
  }

  async function init() {
    const [platforms,achievements,events] = await Promise.allSettled([loadJSON('data/platforms.json'),loadJSON('data/achievements.json'),loadJSON('data/events.json')]);
    if (platforms.status === 'fulfilled') renderPlatforms(platforms.value); else q('#campaign-platforms').innerHTML = '<p class="campaign-empty">政見資料暫時無法載入，請改至歷屆政見頁查看。</p>';
    if (achievements.status === 'fulfilled') renderTracking(achievements.value); else q('#campaign-tracking').innerHTML = '<p class="campaign-empty">追蹤資料暫時無法載入，請改至政績頁查看。</p>';
    if (events.status === 'fulfilled') renderEvents(events.value); else q('#campaign-events').innerHTML = '<p class="campaign-empty">公開行程暫時無法載入，請改至活動公告查看。</p>';
    installSearch();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
