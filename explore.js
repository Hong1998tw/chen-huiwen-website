'use strict';
(() => {
  const state = {
    achievements: [], platforms: [], news: [],
    taxonomy: {topics: {
      '交通與基建':['交通','道路','捷運','車站','鐵路','公車','停車','橋','排水','下水道','自行車','人行','通學'],
      '教育與文化':['教育','學校','國小','國中','校園','學童','兒少','文化','活動中心','課輔','午餐'],
      '環境與綠地':['環境','公園','綠地','綠化','景觀','動物','動保','水環境','河川','減碳','生態'],
      '社福與衛環':['社福','長照','老人','長者','身障','弱勢','健康','醫療','護理','心理','消費','婦幼','托育'],
      '經濟與產業':['經濟','產業','市場','商圈','就業','觀光','創業','招商','數位','科技','農產']
    }}
  };
  const PAGE_SIZE = 10;
  const root = document.querySelector('[data-explore-root]');
  if (!root) return;
  const typeSelect = document.getElementById('explore-type');
  const valueSelect = document.getElementById('explore-value');
  const keywordInput = document.getElementById('explore-keyword');
  const statusSelect = document.getElementById('explore-status');
  const title = document.getElementById('explore-title');
  const subtitle = document.getElementById('explore-subtitle');
  const summary = document.getElementById('explore-summary');
  const achievementBox = document.getElementById('explore-achievements');
  const relatedBox = document.getElementById('explore-related');
  const newsBox = document.getElementById('explore-news-list');
  const platformBox = document.getElementById('explore-platforms-list');
  const pagination = document.getElementById('explore-pagination');
  const empty = document.getElementById('explore-empty');
  const loadState = document.getElementById('explore-load-state');
  const loadMessage = loadState.querySelector('p');
  const retryButton = loadState.querySelector('button');
  let currentPage = 1;
  let loading = false;

  const escapeHTML = value => String(value).replace(/[&<>\'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-Hant-TW').replace(/\s+/g,' ').trim();
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

  async function load() {
    if (loading) return;
    loading = true;
    retryButton.disabled = true;
    loadMessage.textContent = '正在載入政績、新聞與歷屆政見…';
    loadState.hidden = false;
    try {
      const responses = await Promise.all([
        fetch('data/achievements-public.json',{cache:'no-store'}),
        fetch('data/platforms.json',{cache:'no-store'}),
        fetch('news.html',{cache:'no-store'})
      ]);
      if (!responses.every(response => response.ok)) throw new Error('explore-data');
      const achievements = await responses[0].json();
      const platforms = await responses[1].json();
      const news = parseNews(await responses[2].text());
      if (!Array.isArray(achievements) || !Array.isArray(platforms.elections)) throw new Error('explore-format');
      state.achievements = achievements.filter(item => item.status !== '待核驗');
      state.platforms = platforms.elections;
      state.news = news;
      populateControls();
      applyFromURL();
      loadState.hidden = true;
      render('replace');
    } catch {
      loadMessage.textContent = '探索資料暫時無法載入。你選擇的條件仍保留，可重新載入或直接查看完整紀錄。';
      loadState.hidden = false;
    } finally {
      loading = false;
      retryButton.disabled = false;
    }
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
    statusSelect.innerHTML = '<option value="all">全部進度</option>' + [...new Set(state.achievements.map(item => item.status).filter(Boolean))].sort().map(status => '<option value="' + escapeHTML(status) + '">' + escapeHTML(status) + '</option>').join('');
    const topics = Object.keys(state.taxonomy.topics || {});
    const villages = [...new Set(state.achievements.flatMap(item => item.villages || []))].sort((a,b)=>a.localeCompare(b,'zh-Hant-TW'));
    typeSelect.innerHTML = '<option value="topic">主題探索</option><option value="village">里別探索</option>';
    const params = new URLSearchParams(location.search);
    typeSelect.value = (params.get('type') === 'village' || params.get('village')?.startsWith('v:')) ? 'village' : 'topic';
    updateValueOptions(typeSelect.value, typeSelect.value === 'village' ? villages : topics);
  }

  function updateValueOptions(type, values) {
    valueSelect.innerHTML = values.map(value => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join('');
    valueSelect.setAttribute('aria-label', type === 'village' ? '選擇里別' : '選擇主題');
  }

  function applyFromURL() {
    const params = new URLSearchParams(location.search);
    const type = (params.get('type') === 'village' || params.get('village')?.startsWith('v:')) ? 'village' : 'topic';
    if (typeSelect.value !== type) {
      typeSelect.value = type;
      const values = type === 'village' ? [...new Set(state.achievements.flatMap(item=>item.villages||[]))].sort((a,b)=>a.localeCompare(b,'zh-Hant-TW')) : Object.keys(state.taxonomy.topics || {});
      updateValueOptions(type,values);
    }
    const value = params.get('village')?.startsWith('v:') ? params.get('village').slice(2) : params.get('category') || params.get('value');
    if (value && [...valueSelect.options].some(option=>option.value===value)) valueSelect.value=value;
    keywordInput.value=params.get('q')||'';
    const requestedStatus = params.get('status');
    statusSelect.value = [...statusSelect.options].some(option => option.value === requestedStatus) ? requestedStatus : 'all';
    currentPage = Math.max(1, Number.parseInt(params.get('page'),10) || 1);
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

  function matchingResults() {
    const type = typeSelect.value;
    const value = valueSelect.value;
    const query = normalize(keywordInput.value);
    const filtered = state.achievements.filter(item => {
      const scopeMatch = type==='village' ? (item.villages||[]).includes(value) : (item.categories||[]).includes(value);
      return scopeMatch && (statusSelect.value === 'all' || item.status === statusSelect.value) && matchesKeyword(item,query);
    });
    const topics = type==='topic' ? [value] : [...new Set(filtered.flatMap(item=>item.categories||[]))];
    const keywords = [...new Set(topics.flatMap(topic=>topicKeywords(topic)))];
    const news = state.news.filter(item => relationMatch(`${item.title} ${item.text}`,keywords));
    const platforms = state.platforms.map(item=>({
      year:item.year,
      title:`${item.year} ${item.election}`,
      url:`vision.html#platform-${item.year}`,
      text:(item.sections||[]).flatMap(section=>[section.heading,...(section.items||[])]).join(' ')
    })).filter(item=>relationMatch(item.text,keywords)).sort((a,b)=>b.year-a.year);
    return {filtered,news,platforms};
  }

  function render() {
    const type = typeSelect.value;
    const value = valueSelect.value;
    const {filtered,news,platforms} = matchingResults();
    const pageCount = Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));
    currentPage = Math.min(Math.max(1,currentPage),pageCount);
    const mapped = filtered.filter(item=>Array.isArray(item.coordinates)&&item.coordinates.length===2).length;
    const statuses = [...new Set(filtered.map(item=>item.status).filter(Boolean))];
    title.textContent = type==='village' ? `探索 ${value}` : `${value}｜主題探索`;
    subtitle.textContent = type==='village' ? `查看 ${value} 收錄的建設與服務，並延伸到共同主題內容。` : `查看${value}相關的政績、新聞與歷屆政見。`;
    document.title = `${title.textContent}｜陳慧文・高雄市議員`;
    summary.replaceChildren();
    for (const [number,label] of [[filtered.length,'筆政績／服務紀錄'],[mapped,'筆有地圖代表點位'],[statuses.length,'種辦理階段']]) {
      const stat=node('div',undefined,'digital-stat');
      stat.append(node('strong',String(number)),node('span',label));
      summary.append(stat);
    }
    achievementBox.replaceChildren();
    const pageItems = filtered.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE);
    pageItems.forEach(item => {
      const article=node('article',undefined,'explore-result-card');
      const category=(item.categories||[])[0]||'公開紀錄';
      const subcategory=(item.subcategories||[]).slice(0,2).join('・');
      const place=(item.villages||[]).join('、')||item.scope||'地區未載';
      const latest=item.lastRecordDate||'未載明';
      article.append(node('p',subcategory?`${category}・${subcategory}`:category,'eyebrow'));
      article.append(node('h3',item.title));
      article.append(node('p',item.summary||'查看完整說明與歷史紀錄。'));
      article.append(node('p',`地區：${place} · 階段：${item.status||'未標示'} · 最後紀錄：${latest}`,'explore-relation-note'));
      const link=node('a','閱讀完整紀錄 →');
      link.href=`achievement-${encodeURIComponent(item.id)}.html`;
      article.append(link);
      achievementBox.append(article);
    });
    renderPagination(pageCount,filtered.length);
    document.querySelector('[data-explore-count="achievements"]').textContent=String(filtered.length);
    document.querySelector('[data-explore-count="news"]').textContent=String(news.length);
    document.querySelector('[data-explore-count="platforms"]').textContent=String(platforms.length);
    renderRelations(news,platforms);
    const matching = new URLSearchParams();
    matching.set(type === 'village' ? 'village' : 'category', type === 'village' ? 'v:' + value : value);
    if (keywordInput.value.trim()) matching.set('q', keywordInput.value.trim());
    if (statusSelect.value !== 'all') matching.set('status', statusSelect.value);
    document.getElementById('explore-list-link').href = 'achievements.html?' + matching;
    document.getElementById('explore-reading-note').textContent = type === 'village'
      ? `從 ${value} 收錄的地方問題開始，閱讀各案行動、辦理階段與原始來源。地圖代表位置不等於施工範圍。`
      : `從「${value}」相關的生活問題開始，閱讀各案行動、辦理階段與原始來源。收錄紀錄數不代表完工成果數。`;
    empty.hidden=filtered.length>0;
    if(!filtered.length){
      empty.replaceChildren();
      empty.append(node('p','目前條件下沒有收錄政績紀錄。你可以清除關鍵字與進度篩選，或改用完整列表。'));
      const actions=node('div',undefined,'explore-empty-actions');
      const clear=node('button','清除關鍵字與進度篩選');clear.type='button';
      clear.addEventListener('click',()=>{keywordInput.value='';statusSelect.value='all';currentPage=1;render();syncURL('push');keywordInput.focus();});
      const list=node('a','查看完整地方紀錄 →');list.href='achievements.html';
      const service=node('a','聯絡服務處 →');service.href='service.html#contact';
      actions.append(clear,list,service);empty.append(actions);
    }
  }

  function renderPagination(pageCount,total) {
    pagination.replaceChildren();
    pagination.hidden = pageCount<=1;
    if (pageCount<=1) return;
    const addButton=(label,page,disabled=false)=>{
      const button=node('button',label,'explore-page-button');
      button.type='button';button.disabled=disabled;
      if (/^\d+$/.test(label) && Number(label)===currentPage) button.setAttribute('aria-current','page');
      if (/^\d+$/.test(label)) button.setAttribute('aria-label',`第 ${page} 頁，共 ${pageCount} 頁`);
      button.addEventListener('click',()=>{
        currentPage=page;
        render();syncURL('push');
        const heading=document.getElementById('explore-achievement-heading');
        heading.scrollIntoView({behavior:'instant',block:'start'});
        heading.focus({preventScroll:true});
      });
      pagination.append(button);
    };
    addButton('上一頁',currentPage-1,currentPage===1);
    for(let page=1;page<=pageCount;page++) addButton(String(page),page);
    addButton('下一頁',currentPage+1,currentPage===pageCount);
    pagination.setAttribute('aria-label',`建設與服務紀錄分頁，目前第 ${currentPage} 頁，共 ${pageCount} 頁；共 ${total} 筆`);
  }

  function renderRelations(news,platforms) {
    relatedBox.hidden=false;
    if(!relatedBox.querySelector(':scope > .explore-relation-note')){
      relatedBox.prepend(node('p','依共同主題整理相關政績、新聞與歷屆政見，方便延伸閱讀。','explore-relation-note'));
    }
    newsBox.replaceChildren();
    platformBox.replaceChildren();
    document.getElementById('explore-news-count').textContent=`共 ${news.length} 則相關新聞`;
    document.getElementById('explore-platforms-count').textContent=`共 ${platforms.length} 組歷屆政見`;
    if(news.length){
      news.forEach(item=>{
        const a=node('a',undefined,'explore-related-item');a.href=item.url;
        a.append(node('span','新聞','global-search-type'),node('strong',item.title),node('small',item.date));newsBox.append(a);
      });
    }else newsBox.append(node('p','目前沒有符合主題的新聞。'));
    if(platforms.length){
      platforms.forEach(item=>{
        const a=node('a',undefined,'explore-related-item');a.href=item.url;
        a.append(node('span','政見','global-search-type'),node('strong',item.title),node('small','歷屆政見原文'));platformBox.append(a);
      });
    }else platformBox.append(node('p','目前沒有符合主題的歷屆政見。'));
  }

  function syncURL(mode='replace') {
    const params=new URLSearchParams();
    params.set('type',typeSelect.value);params.set('value',valueSelect.value);
    if(keywordInput.value.trim())params.set('q',keywordInput.value.trim());
    if(statusSelect.value!=='all')params.set('status',statusSelect.value);
    if(currentPage>1)params.set('page',String(currentPage));
    const next=`${location.pathname}?${params.toString()}`;
    const current=`${location.pathname}${location.search}`;
    if(mode==='push' && current!==next)history.pushState(null,'',next);
    else if(mode==='replace')history.replaceState(null,'',next);
  }

  typeSelect.addEventListener('change',()=>{
    const values=typeSelect.value==='village'?[...new Set(state.achievements.flatMap(item=>item.villages||[]))].sort((a,b)=>a.localeCompare(b,'zh-Hant-TW')):Object.keys(state.taxonomy.topics||{});
    updateValueOptions(typeSelect.value,values);currentPage=1;render();syncURL('push');
  });
  valueSelect.addEventListener('change',()=>{currentPage=1;render();syncURL('push');});
  statusSelect.addEventListener('change',()=>{currentPage=1;render();syncURL('push');});
  keywordInput.addEventListener('input',()=>{currentPage=1;render();syncURL('replace');});
  retryButton.addEventListener('click',load);
  window.addEventListener('popstate',()=>{applyFromURL();render();});
  load();
})();
