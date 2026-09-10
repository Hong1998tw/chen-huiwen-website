'use strict';
(() => {
  const PAGE_SIZE = 10;
  const host = document.querySelector('.news-layout');
  const reportSection = document.querySelector('#news-reports');
  const mediaGrid = document.querySelector('[data-news-grid]');
  if (!host || !reportSection || !mediaGrid) return;

  if (!document.querySelector('link[href^="news-unified.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'news-unified.css?v=20260910-1';
    document.head.append(link);
  }

  const normalize = value => String(value || '').toLocaleLowerCase('zh-Hant-TW').replace(/\s+/g, ' ').trim();
  const extractDate = node => {
    const time = node.querySelector('time[datetime]');
    if (time?.dateTime) return time.dateTime.slice(0, 10);
    const text = node.querySelector('.eyebrow')?.textContent || node.textContent;
    const match = text.match(/(20\d{2})[.\/-](\d{2})[.\/-](\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : '0000-00-00';
  };
  const categoryTokens = label => {
    const text = String(label || '');
    const tokens = [];
    if (/交通|建設/.test(text)) tokens.push('transport');
    if (/教育|兒少|文化/.test(text)) tokens.push('education');
    if (/社福|照護|長照/.test(text)) tokens.push('social');
    if (/民生|消保|產業|經濟/.test(text)) tokens.push('livelihood');
    if (/環境|動保/.test(text)) tokens.push('environment');
    if (/運動/.test(text)) tokens.push('sports');
    if (/科技|數位/.test(text)) tokens.push('technology');
    if (/公共參與|選舉|國際交流/.test(text)) tokens.push('public');
    return tokens;
  };
  const filters = [
    ['all', '全部'], ['transport', '交通建設'], ['education', '教育兒少'],
    ['social', '社福照護'], ['livelihood', '民生消保'], ['environment', '環境動保'],
    ['sports', '運動文化'], ['technology', '科技治理'], ['public', '公共參與']
  ];

  const pressItems = [];
  const seenPress = new Set();
  const capturePressPage = () => {
    host.querySelectorAll('.news-summary-card').forEach(card => {
      const key = card.getAttribute('href') || normalize(card.querySelector('h3')?.textContent);
      if (!key || seenPress.has(key)) return;
      seenPress.add(key);
      const meta = card.querySelector('.news-summary-meta');
      const category = meta?.querySelector('span')?.textContent || '';
      const badge = document.createElement('span');
      badge.className = 'news-type-badge';
      badge.textContent = '新聞稿／公告';
      meta?.after(badge);
      pressItems.push({
        node: card,
        date: extractDate(card),
        categories: categoryTokens(category),
        text: normalize(card.textContent),
        importance: pressItems.length
      });
    });
  };
  capturePressPage();
  const oldPageButtons = [...host.querySelectorAll('.news-pagination .news-page-button')]
    .filter(button => /^\d+$/.test(button.textContent.trim()));
  oldPageButtons.forEach(button => {
    button.click();
    capturePressPage();
  });

  const mediaItems = [...mediaGrid.querySelectorAll('[data-news-categories]')].map((node, index) => ({
    node,
    date: extractDate(node),
    categories: (node.dataset.newsCategories || '').split(/\s+/).filter(Boolean),
    text: normalize(node.textContent),
    importance: pressItems.length + index
  }));
  const items = [...pressItems, ...mediaItems];

  host.classList.add('news-unified');
  host.replaceChildren();
  reportSection.remove();

  const head = document.createElement('div');
  head.className = 'section-head';
  const heading = document.createElement('div');
  heading.innerHTML = '<p class="eyebrow">NEWS &amp; COVERAGE</p><h2>新聞與公告</h2>';
  const status = document.createElement('p');
  status.className = 'news-filter-status';
  status.setAttribute('aria-live', 'polite');
  head.append(heading, status);

  const searchPanel = document.createElement('div');
  searchPanel.className = 'news-search-panel news-search-panel--unified';
  const searchLabel = document.createElement('label');
  searchLabel.className = 'news-search-label';
  searchLabel.htmlFor = 'unified-news-search';
  searchLabel.textContent = '搜尋新聞';
  const input = document.createElement('input');
  input.id = 'unified-news-search';
  input.className = 'news-search-input';
  input.type = 'search';
  input.placeholder = '輸入標題、媒體、議題或人物';
  input.autocomplete = 'off';
  searchPanel.append(searchLabel, input);

  const controls = document.createElement('div');
  controls.className = 'news-unified-controls';
  const filterPanel = document.createElement('div');
  filterPanel.className = 'news-filter-panel news-filter-panel--unified';
  const filterLabel = document.createElement('span');
  filterLabel.className = 'news-filter-label';
  filterLabel.textContent = '主題篩選';
  const filterList = document.createElement('div');
  filterList.className = 'news-filter-list';
  filterList.setAttribute('role', 'group');
  filterList.setAttribute('aria-label', '新聞主題篩選');
  const buttons = filters.map(([value, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `news-filter-button${value === 'all' ? ' is-active' : ''}`;
    button.dataset.newsFilter = value;
    button.setAttribute('aria-pressed', String(value === 'all'));
    button.textContent = label;
    filterList.append(button);
    return button;
  });
  filterPanel.append(filterLabel, filterList);

  const sortWrap = document.createElement('div');
  sortWrap.className = 'news-sort-control';
  const sortLabel = document.createElement('label');
  sortLabel.htmlFor = 'news-sort';
  sortLabel.textContent = '排序';
  const sort = document.createElement('select');
  sort.id = 'news-sort';
  sort.className = 'news-sort-select';
  sort.innerHTML = '<option value="importance">重要優先</option><option value="date">日期優先（新到舊）</option>';
  sortWrap.append(sortLabel, sort);
  controls.append(filterPanel, sortWrap);

  const note = document.createElement('p');
  note.className = 'source-note news-filter-note';
  note.textContent = '新聞稿、公告與媒體報導已合併為同一列表；同一事件的多家媒體來源仍整合在同一報導卡內。';
  const grid = document.createElement('div');
  grid.className = 'content-grid news-unified-grid';
  const empty = document.createElement('p');
  empty.className = 'news-unified-empty';
  empty.textContent = '目前沒有符合條件的新聞。';
  empty.hidden = true;
  const pagination = document.createElement('nav');
  pagination.className = 'news-pagination';
  pagination.setAttribute('aria-label', '新聞分頁');
  host.append(head, searchPanel, controls, note, grid, empty, pagination);

  let category = 'all';
  let query = '';
  let sortMode = 'importance';
  let currentPage = 1;

  const pageButton = (text, page, {current = false, disabled = false, label = ''} = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'news-page-button';
    button.textContent = text;
    button.disabled = disabled;
    if (current) button.setAttribute('aria-current', 'page');
    button.setAttribute('aria-label', label || `新聞第 ${page} 頁`);
    button.addEventListener('click', () => {
      currentPage = page;
      render();
      host.scrollIntoView({behavior: 'smooth', block: 'start'});
    });
    return button;
  };

  const renderPagination = (totalItems, totalPages) => {
    pagination.replaceChildren();
    if (totalItems <= PAGE_SIZE) {
      pagination.hidden = true;
      return;
    }
    pagination.hidden = false;
    pagination.append(pageButton('上一頁', Math.max(1, currentPage - 1), {disabled: currentPage === 1, label: '上一頁'}));
    for (let page = 1; page <= totalPages; page += 1) {
      pagination.append(pageButton(String(page), page, {current: page === currentPage}));
    }
    pagination.append(pageButton('下一頁', Math.min(totalPages, currentPage + 1), {disabled: currentPage === totalPages, label: '下一頁'}));
  };

  const render = () => {
    const term = normalize(query);
    let matches = items.filter(item =>
      (category === 'all' || item.categories.includes(category)) && (!term || item.text.includes(term))
    );
    matches = [...matches].sort((a, b) => sortMode === 'date'
      ? (b.date.localeCompare(a.date) || a.importance - b.importance)
      : a.importance - b.importance);
    const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(1, currentPage), totalPages);
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = matches.slice(start, start + PAGE_SIZE);
    pageItems.forEach(item => { item.node.hidden = false; });
    grid.replaceChildren(...pageItems.map(item => item.node));
    buttons.forEach(button => {
      const active = button.dataset.newsFilter === category;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const categoryLabel = category === 'all' ? '全部' : (filters.find(([value]) => value === category)?.[1] || '此分類');
    status.textContent = matches.length ? `${categoryLabel} ${matches.length} 筆 · 第 ${currentPage}/${totalPages} 頁` : `${categoryLabel} 0 筆`;
    empty.hidden = matches.length !== 0;
    renderPagination(matches.length, totalPages);
  };

  buttons.forEach(button => button.addEventListener('click', () => {
    category = button.dataset.newsFilter;
    currentPage = 1;
    render();
  }));
  input.addEventListener('input', event => {
    query = event.target.value;
    currentPage = 1;
    render();
  });
  sort.addEventListener('change', () => {
    sortMode = sort.value;
    currentPage = 1;
    render();
  });
  render();
})();
