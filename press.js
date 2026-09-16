'use strict';
(() => {
  const PAGE_SIZE = 10;
  const pageLabel = '新聞發稿';
  const section = document.querySelector('[data-press-index]');
  const grid = section?.querySelector('[data-press-grid]');
  if (!section || !grid) return;
  const controls = section.querySelector('[data-press-controls]');
  const search = section.querySelector('#press-search');
  const sort = section.querySelector('#press-sort');
  const status = section.querySelector('[data-press-count]');
  const empty = section.querySelector('[data-press-empty]');
  const pagination = section.querySelector('[data-press-pagination]');
  const TOPIC_LABELS = new Map([
    ['transport','交通建設'],['education','教育兒少'],['social','社福照護'],['livelihood','民生消保'],
    ['environment','環境動保'],['sports','運動文化'],['technology','科技治理'],['public','公共參與']
  ]);
  const TOPIC_ORDER = [...TOPIC_LABELS.keys()];
  const normalize = value => String(value || '').toLocaleLowerCase('zh-Hant-TW').replace(/\s+/g,' ').trim();
  const filterSelectors = section.querySelector('[data-filter-selectors]');
  const topicMenu = section.querySelector('[data-filter-menu="topic"]');
  const tagMenu = section.querySelector('[data-filter-menu="tag"]');
  const clearFilters = section.querySelector('[data-filter-clear]');
  const selectedTopics = new Set();
  const selectedTags = new Set();
  const cards = [...grid.querySelectorAll('[data-news-categories]')].map((node,index) => {
    const source = node.querySelector('.card-body > .eyebrow, time[datetime]')?.textContent || node.textContent;
    const match = source.match(/(20\d{2})[.\/-](\d{2})[.\/-](\d{2})/);
    return {
      node,
      date: node.dataset.newsDate || (match ? `${match[1]}-${match[2]}-${match[3]}` : '0000-00-00'),
      categories:(node.dataset.newsCategories || '').split(/\s+/).filter(Boolean),
      tags:(node.dataset.newsTags || '').split(/\s+/).filter(Boolean),
      text:normalize(`${node.textContent || ''} ${node.dataset.newsKeywords || ''}`),
      order:index
    };
  });
  const topicValues = [...new Set(cards.flatMap(item => item.categories))].sort((a,b) => TOPIC_ORDER.indexOf(a)-TOPIC_ORDER.indexOf(b));
  const tagCounts = new Map();
  cards.flatMap(item => item.tags).forEach(tag => tagCounts.set(tag,(tagCounts.get(tag)||0)+1));
  const tagValues = [...tagCounts.keys()].sort((a,b) => (tagCounts.get(b)-tagCounts.get(a)) || a.localeCompare(b,'zh-Hant-TW'));

  const optionLabel = (kind,value) => kind === 'topic' ? (TOPIC_LABELS.get(value)||value) : `#${value}`;
  const updateSummary = (menu,selected,kind) => {
    const target = menu?.querySelector('[data-filter-summary]');
    if (!target) return;
    if (!selected.size) target.textContent = kind === 'topic' ? '全部主題' : '全部標籤';
    else if (selected.size === 1) target.textContent = optionLabel(kind,[...selected][0]);
    else target.textContent = `已選 ${selected.size} 項`;
  };
  const buildMenu = (menu,values,selected,kind,onChange) => {
    const host = menu?.querySelector('[data-filter-options]');
    if (!host) return;
    host.replaceChildren(...values.map(value => {
      const label=document.createElement('label'); label.className='news-multiselect-option';
      const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.value=value;
      const text=document.createElement('span'); text.textContent=optionLabel(kind,value);
      const count=document.createElement('small');
      count.textContent=String(kind==='tag' ? tagCounts.get(value) : cards.filter(item=>item.categories.includes(value)).length);
      checkbox.addEventListener('change',()=>{ checkbox.checked ? selected.add(value) : selected.delete(value); updateSummary(menu,selected,kind); onChange(); });
      label.append(checkbox,text,count); return label;
    }));
    updateSummary(menu,selected,kind);
  };
  const closeOtherMenus = event => {
    if (!event.target.open) return;
    [topicMenu,tagMenu].filter(menu => menu && menu !== event.target).forEach(menu => menu.removeAttribute('open'));
  };
  [topicMenu,tagMenu].forEach(menu => menu?.addEventListener('toggle',closeOtherMenus));
  document.addEventListener('click',event => {
    if (event.target.closest('.news-multiselect')) return;
    [topicMenu,tagMenu].forEach(menu => menu?.removeAttribute('open'));
  });
  let query='', sortMode='important', currentPage=1;
  const makeButton = (text,page,options={}) => {
    const button=document.createElement('button'); button.type='button'; button.className='news-page-button'; button.textContent=text;
    button.disabled=Boolean(options.disabled); if(options.current)button.setAttribute('aria-current','page');
    button.setAttribute('aria-label',options.label||`${pageLabel}第 ${page} 頁`);
    button.addEventListener('click',()=>{currentPage=page;render();section.scrollIntoView({behavior:'smooth',block:'start'});});
    return button;
  };
  const renderPagination=(total,pages)=>{
    if(!pagination)return; pagination.replaceChildren();
    if(total<=PAGE_SIZE){pagination.hidden=true;return;} pagination.hidden=false;
    pagination.append(makeButton('上一頁',Math.max(1,currentPage-1),{disabled:currentPage===1,label:'上一頁'}));
    for(let page=1;page<=pages;page+=1)pagination.append(makeButton(String(page),page,{current:page===currentPage}));
    pagination.append(makeButton('下一頁',Math.min(pages,currentPage+1),{disabled:currentPage===pages,label:'下一頁'}));
  };
  const render=()=>{
    const term=normalize(query);
    let matches=cards.filter(item =>
      (!selectedTopics.size || item.categories.some(value=>selectedTopics.has(value))) &&
      (!selectedTags.size || item.tags.some(value=>selectedTags.has(value))) &&
      (!term || item.text.includes(term))
    );
    matches=[...matches].sort((a,b)=>sortMode==='date'?(b.date.localeCompare(a.date)||a.order-b.order):a.order-b.order);
    const pages=Math.max(1,Math.ceil(matches.length/PAGE_SIZE)); currentPage=Math.min(Math.max(1,currentPage),pages);
    const start=(currentPage-1)*PAGE_SIZE; grid.replaceChildren(...matches.slice(start,start+PAGE_SIZE).map(item=>item.node));
    const active=[]; if(selectedTopics.size)active.push(`主題 ${selectedTopics.size}`); if(selectedTags.size)active.push(`# ${selectedTags.size}`);
    const prefix=active.length?`${active.join(' · ')} · `:'全部 · ';
    if(status)status.textContent=matches.length?`${prefix}${matches.length} 筆 · 第 ${currentPage}/${pages} 頁`:`${prefix}0 筆`;
    if(empty)empty.hidden=matches.length!==0;
    if(clearFilters)clearFilters.disabled=!selectedTopics.size&&!selectedTags.size&&!query.trim()&&sortMode==='important';
    renderPagination(matches.length,pages);
  };
  const filterChanged=()=>{currentPage=1;render();};
  buildMenu(topicMenu,topicValues,selectedTopics,'topic',filterChanged);
  buildMenu(tagMenu,tagValues,selectedTags,'tag',filterChanged);
  if (controls) { controls.hidden=false; controls.removeAttribute('data-progressive-controls'); }
  if (filterSelectors) { filterSelectors.hidden=false; filterSelectors.removeAttribute('data-progressive-controls'); }
  search?.addEventListener('input',event=>{query=event.target.value;currentPage=1;render();});
  sort?.addEventListener('change',event=>{sortMode=event.target.value;currentPage=1;render();});
  clearFilters?.addEventListener('click',()=>{
    selectedTopics.clear(); selectedTags.clear(); query=''; sortMode='important'; currentPage=1;
    section.querySelectorAll('.news-multiselect input[type="checkbox"]').forEach(input=>{input.checked=false;});
    if(search)search.value=''; if(sort)sort.value='important';
    updateSummary(topicMenu,selectedTopics,'topic'); updateSummary(tagMenu,selectedTags,'tag');
    [topicMenu,tagMenu].forEach(menu=>menu?.removeAttribute('open')); render();
  });
  render();
})();
