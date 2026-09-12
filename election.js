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
  function renderElectionDates(data) {
    const countdown = q('#campaign-countdown');
    if (!countdown || !data?.voteDate) return;
    const target = new Date(`${data.voteDate}T00:00:00+08:00`).getTime();
    const update = () => {
      const diff = Math.max(0,target-Date.now());
      countdown.textContent = String(Math.ceil(diff/86400000));
      const unit = q('#campaign-countdown-unit');
      if (unit) unit.textContent = diff > 0 ? '天，距離投票日' : '投票日';
    };
    update();
    const timer = window.setInterval(update,60000);
    window.addEventListener('pagehide',() => clearInterval(timer),{once:true});
  }
  function renderPlatforms(data) {
    const root = q('#campaign-platforms');
    if (!root) return [];
    const item = (data.elections || []).find(entry => Number(entry.year) === 2026);
    if (!item) { root.innerHTML = '<p class="campaign-empty">目前尚未收錄 2026 政見資料。</p>'; return []; }
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
    if (!trackable.length) { root.innerHTML = '<p class="campaign-empty">目前沒有進行中的公開追蹤項目。</p>'; return []; }
    trackable.forEach(item => {
      const article = document.createElement('article');
      article.className = 'campaign-data-card campaign-searchable';
      article.dataset.search = normalize([item.title,item.summary,item.status,...(item.categories || []),...(item.subcategories || []),...(item.villages || [])].join(' '));
      const source = item.sources?.[0];
      const updated = item.updated ? `<p class="campaign-note">最近更新：${esc(item.updated)}</p>` : '';
      article.innerHTML = `<div class="campaign-badges"><span class="campaign-badge">${esc(item.status)}</span>${(item.subcategories || []).slice(0,2).map(tag => `<span class="campaign-badge">${esc(tag)}</span>`).join('')}</div><h3>${esc(item.title)}</h3><p>${esc(item.summary || '查看完整紀錄與資料來源。')}</p>${updated}<div class="campaign-actions"><a class="text-link" href="achievement-${encodeURIComponent(item.id)}.html">查看完整內容 →</a>${source ? `<a class="text-link" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">資料來源 ↗</a>` : ''}</div>`;
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
    if (!events.length) { root.innerHTML = '<p class="campaign-empty">目前沒有即將舉行的公開行程。</p>'; q('#campaign-event-count')?.replaceChildren(document.createTextNode('0')); return []; }
    events.forEach(event => {
      const article = document.createElement('article');
      article.className = 'campaign-panel campaign-event campaign-searchable';
      article.dataset.search = normalize([event.name,event.content,event.location,event.registration].join(' '));
      const updated = event.verifiedAt ? `<p class="campaign-note">資料更新：${esc(event.verifiedAt)}</p>` : '';
      article.innerHTML = `<time datetime="${esc(event.start)}">${esc(dateLabel(event.start))}</time><div><h3>${esc(event.name)}</h3><p>${esc(event.content || '')}</p>${updated}<div class="campaign-actions">${event.sourceUrl ? `<a class="text-link" href="${esc(event.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方資訊 ↗</a>` : ''}<a class="text-link" href="${googleCalendar(event)}" target="_blank" rel="noopener noreferrer">加入 Google Calendar ↗</a></div></div>`;
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
      if (count) count.textContent = term ? `找到 ${visible} 個符合項目` : '搜尋政見、追蹤與公開行程';
    };
    input.addEventListener('input',filter);
    filter();
  }
  async function init() {
    const [election,platforms,achievements,events] = await Promise.allSettled([loadJSON('data/election-2026.json'),loadJSON('data/platforms.json'),loadJSON('data/achievements.json'),loadJSON('data/events.json')]);
    if (election.status === 'fulfilled') renderElectionDates(election.value);
    if (platforms.status === 'fulfilled') renderPlatforms(platforms.value); else if (q('#campaign-platforms')) q('#campaign-platforms').innerHTML = '<p class="campaign-empty">政見資料暫時無法載入，請至歷屆政見頁查看。</p>';
    if (achievements.status === 'fulfilled') renderTracking(achievements.value); else if (q('#campaign-tracking')) q('#campaign-tracking').innerHTML = '<p class="campaign-empty">推動紀錄暫時無法載入，請至政績頁查看。</p>';
    if (events.status === 'fulfilled') renderEvents(events.value); else if (q('#campaign-events')) q('#campaign-events').innerHTML = '<p class="campaign-empty">公開行程暫時無法載入，請至公開行程與活動頁查看。</p>';
    installSearch();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
