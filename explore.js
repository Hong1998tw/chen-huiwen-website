'use strict';
(() => {
  const state = {achievements:[], platforms:[], news:[], taxonomy:{topics:{'交通與基建':['交通','道路','捷運','車站','鐵路','公車','停車','橋','排水','下水道','自行車','人行','通學'],'教育與文化':['教育','學校','國小','國中','校園','學童','兒少','文化','活動中心','課輔','午餐'],'環境與綠地':['環境','公園','綠地','綠化','景觀','動物','動保','水環境','河川','減碳','生態'],'社福與衛環':['社福','長照','老人','長者','身障','弱勢','健康','醫療','護理','心理','消費','婦幼','托育'],'經濟與產業':['經濟','產業','市場','商圈','就業','觀光','創業','招商','數位','科技','農產']}}};
  const root = document.querySelector('[data-explore-root]');
  if (!root) return;
  const typeSelect = document.getElementById('explore-type');
  const valueSelect = document.getElementById('explore-value');
  const keywordInput = document.getElementById('explore-keyword');
  const title = document.getElementById('explore-title');
  const subtitle = document.getElementById('explore-subtitle');
  const summary = document.getElementById('explore-summary');
  const achievementBox = document.getElementById('explore-achievements');
  const relatedBox = document.getElementById('explore-related');
  const empty = document.getElementById('explore-empty');

  const escapeHTML = value => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-Hant-TW').replace(/\s+/g,' ').trim();

  async function load() {
    const responses = await Promise.all([
      fetch('data/achievements.json',{cache:'no-store'}),
      fetch('data/platforms.json',{cache:'no-store'}),
      fetch('news.html',{cache:'no-store'})
    ]);
    if (!responses.every(response => response.ok)) throw new Error('explore-data');
    state.achievements = await responses[0].json();
    const platforms = await responses[1].json();
    state.platforms = platforms.elections || [];
    state.news = parseNews(await responses[2].text());
    populateControls();
    applyFromURL();
    render();
  }

  function parseNews(html) {
    const doc = new DOMParser().parseFromString(html,'text/html');
    const seen = new Set();
    const items = [];
    [...doc.querySelectorAll('main article, [data-news-grid] [data-record]')].forEach(article => {
      const heading = article.querySelector('h1,h2,h3');
      if (!heading) return;
      const titleText = heading.textContent.trim();
      const direct = article.querySelector('a[href^="news-"],a[href*="news-"]');
      const url = direct?.getAttribute('href') || (article.id ? `news.html#${article.id}` : 'news.html');
      const key = `${titleText}|${url}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({title:titleText,url,date:article.querySelector('time,.eyebrow')?.textContent.trim() || '',text:article.textContent.replace(/\s+/g,' ').trim()});
    });
    return items;
  }

  function populateControls() {
    const topics = Object.keys(state.taxonomy.topics || {});
    const villages = [...new Set(state.achievements.flatMap(item => item.villages || []))].sort((a,b)=>a.localeCompare(b,'zh-Hant-TW'));
    typeSelect.innerHTML = '<option value="topic">主題探索</option><option value="village">里別探索</option>';
    const params = new URLSearchParams(location.search);
    typeSelect.value = params.get('type') === 'village' ? 'village' : 'topic';
    updateValueOptions(typeSelect.value, typeSelect.value === 'village' ? villages : topics);
  }

  function updateValueOptions(type, values) {
    valueSelect.innerHTML = values.map(value => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join('');
    valueSelect.setAttribute('aria-label', type === 'village' ? '選擇里別' : '選擇主題');
  }

  function applyFromURL() {
    const params = new URLSearchParams(location.search);
    const type = params.get('type') === 'village' ? 'village' : 'topic';
    if (typeSelect.value !== type) {
      typeSelect.value = type;
      const values = type === 'village' ? [...new Set(state.achievements.flatMap(item=>item.villages||[]))].sort((a,b)=>a.localeCompare(b,'zh-Hant-TW')) : Object.keys(state.taxonomy.topics || {});
      updateValueOptions(type,values);
    }
    const value = params.get('value');
    if (value && [...valueSelect.options].some(option=>option.value===value)) valueSelect.value=value;
    keywordInput.value=params.get('q')||'';
  }

  function matchesKeyword(item, query) {
    if (!query) return true;
    const haystack = normalize([item.title,item.summary,item.scope,item.status,...(item.categories||[]),...(item.subcategories||[]),...(item.villages||[]),...(item.paragraphs||[]),...((item.history||[]).flatMap(h=>[h.title,h.text,h.date]))].filter(Boolean).join(' '));
    return query.split(' ').filter(Boolean).every(token=>haystack.includes(token));
  }

  function topicKeywords(topic) {
    return state.taxonomy.topics?.[topic] || [topic];
  }

  function relationMatch(text, keywords) {
    const normalized = normalize(text);
    return keywords.some(keyword => normalized.includes(normalize(keyword)));
  }

  function render() {
    const type=typeSelect.value;
    const value=valueSelect.value;
    const query=normalize(keywordInput.value);
    const filtered=state.achievements.filter(item => {
      const scopeMatch = type==='village' ? (item.villages||[]).includes(value) : (item.categories||[]).includes(value);
      return scopeMatch && matchesKeyword(item,query);
    });
    const mapped=filtered.filter(item=>Array.isArray(item.coordinates)&&item.coordinates.length===2).length;
    const statuses=[...new Set(filtered.map(item=>item.status).filter(Boolean))];
    title.textContent=type==='village'?`探索 ${value}`:`${value}｜主題探索`;
    subtitle.textContent=type==='village'?`查看 ${value} 收錄的建設與服務，並延伸到共同主題內容。`:`把 ${value} 的政績、新聞與歷屆政見放在同一個探索視角。`;
    document.title=`${title.textContent}｜陳慧文・高雄市議員`;
    summary.innerHTML=`
      <div class="digital-stat"><strong>${filtered.length}</strong><span>政績／服務紀錄</span></div>
      <div class="digital-stat"><strong>${mapped}</strong><span>有地圖代表點位</span></div>
      <div class="digital-stat"><strong>${statuses.length}</strong><span>進度類型</span></div>`;
    achievementBox.replaceChildren();
    filtered.forEach(item => {
      const article=document.createElement('article');article.className='explore-result-card';
      const place=(item.villages||[]).join('、')||item.scope||'鳳山區';
      article.innerHTML=`<p class="eyebrow">${escapeHTML([...(item.categories||[]),...(item.subcategories||[])].join('・'))}</p><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.summary||'查看完整說明與歷史紀錄。')}</p><p class="explore-relation-note">${escapeHTML(place)} · ${escapeHTML(item.status||'')}</p><a href="achievement-${encodeURIComponent(item.id)}.html">閱讀完整紀錄 →</a>`;
      achievementBox.append(article);
    });
    empty.hidden=filtered.length>0;
    renderRelations(type,value,filtered);
    syncURL();
  }

  function renderRelations(type,value,filtered) {
    relatedBox.replaceChildren();
    const topics = type==='topic' ? [value] : [...new Set(filtered.flatMap(item=>item.categories||[]))];
    const keywords=[...new Set(topics.flatMap(topic=>topicKeywords(topic)))];
    const news=state.news.filter(item=>relationMatch(`${item.title} ${item.text}`,keywords)).slice(0,6);
    const platforms=state.platforms.map(item=>({
      year:item.year,
      title:`${item.year} ${item.election}`,
      url:`vision.html#platform-${item.year}`,
      text:(item.sections||[]).flatMap(section=>[section.heading,...(section.items||[])]).join(' ')
    })).filter(item=>relationMatch(item.text,keywords)).sort((a,b)=>b.year-a.year).slice(0,5);
    const heading=document.createElement('div');heading.innerHTML='<p class="eyebrow">CONNECTED CONTENT</p><h2>政績 × 新聞 × 政見</h2><p class="explore-relation-note">依共同主題詞彙建立站內探索關聯；僅供閱讀導覽，不等於新聞直接證明政績，也不代表歷屆政見已完成。</p>';
    relatedBox.append(heading);
    const list=document.createElement('div');list.className='explore-related-list';
    news.forEach(item=>{const a=document.createElement('a');a.className='explore-related-item';a.href=item.url;a.innerHTML=`<span class="global-search-type">新聞</span><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.date)}</small>`;list.append(a);});
    platforms.forEach(item=>{const a=document.createElement('a');a.className='explore-related-item';a.href=item.url;a.innerHTML=`<span class="global-search-type">政見</span><strong>${escapeHTML(item.title)}</strong><small>歷屆政見原文</small>`;list.append(a);});
    if(!news.length&&!platforms.length){const p=document.createElement('p');p.textContent='目前沒有找到可可靠串連的新聞或政見內容。';list.append(p);}
    relatedBox.append(list);
  }

  function syncURL(){const params=new URLSearchParams();params.set('type',typeSelect.value);params.set('value',valueSelect.value);if(keywordInput.value.trim())params.set('q',keywordInput.value.trim());history.replaceState(null,'',`${location.pathname}?${params.toString()}`);}

  typeSelect.addEventListener('change',()=>{const values=typeSelect.value==='village'?[...new Set(state.achievements.flatMap(item=>item.villages||[]))].sort((a,b)=>a.localeCompare(b,'zh-Hant-TW')):Object.keys(state.taxonomy.topics||{});updateValueOptions(typeSelect.value,values);render();});
  valueSelect.addEventListener('change',render);
  keywordInput.addEventListener('input',render);
  load().catch(()=>{root.innerHTML='<div class="wrap"><h2>探索資料暫時無法載入</h2><p>你仍可前往 <a href="achievements.html">政績地圖</a>、<a href="news.html">新聞</a>與<a href="vision.html">歷屆政見</a>閱讀公開內容。</p></div>';});
})();
