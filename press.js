'use strict';
(() => {
  const PAGE_SIZE = 10;
  const section = document.querySelector('[data-press-index]');
  const grid = section?.querySelector('[data-press-grid]');
  if (!section || !grid) return;
  const controls = section.querySelector('[data-press-controls]');
  const filterPanel = section.querySelector('[data-press-filters]');
  const search = section.querySelector('#press-search');
  const sort = section.querySelector('#press-sort');
  const status = section.querySelector('[data-press-count]');
  const empty = section.querySelector('[data-press-empty]');
  const pagination = section.querySelector('[data-press-pagination]');
  const buttons = [...section.querySelectorAll('[data-news-filter]')];
  const cards = [...grid.querySelectorAll('[data-news-categories]')].map((node,index) => ({
    node,
    date:node.dataset.newsDate || '0000-00-00',
    categories:(node.dataset.newsCategories || '').split(/\s+/).filter(Boolean),
    text:`${node.textContent || ''} ${node.dataset.newsKeywords || ''}`.toLocaleLowerCase('zh-Hant-TW'),
    order:index
  }));
  const labels = new Map(buttons.map(button => [button.dataset.newsFilter, button.textContent.trim()]));
  let category='all', query='', sortMode='important', currentPage=1;
  if (controls) controls.hidden=false;
  if (filterPanel) filterPanel.hidden=false;

  const makeButton=(text,page,options={})=>{
    const button=document.createElement('button'); button.type='button'; button.className='news-page-button'; button.textContent=text;
    button.disabled=Boolean(options.disabled); if(options.current)button.setAttribute('aria-current','page');
    button.setAttribute('aria-label',options.label||`新聞發稿第 ${page} 頁`);
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
    const term=query.trim().toLocaleLowerCase('zh-Hant-TW');
    let matches=cards.filter(item=>(category==='all'||item.categories.includes(category))&&(!term||item.text.includes(term)));
    matches=[...matches].sort((a,b)=>sortMode==='date'?(b.date.localeCompare(a.date)||a.order-b.order):a.order-b.order);
    const pages=Math.max(1,Math.ceil(matches.length/PAGE_SIZE)); currentPage=Math.min(Math.max(1,currentPage),pages);
    const start=(currentPage-1)*PAGE_SIZE; grid.replaceChildren(...matches.slice(start,start+PAGE_SIZE).map(item=>item.node));
    buttons.forEach(button=>{const active=button.dataset.newsFilter===category;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));});
    if(status)status.textContent=matches.length?`${category==='all'?'全部':(labels.get(category)||'此主題')} ${matches.length} 筆 · 第 ${currentPage}/${pages} 頁`:`${category==='all'?'全部':(labels.get(category)||'此主題')} 0 筆`;
    if(empty)empty.hidden=matches.length!==0; renderPagination(matches.length,pages);
  };
  buttons.forEach(button=>button.addEventListener('click',()=>{category=button.dataset.newsFilter;currentPage=1;render();}));
  search?.addEventListener('input',event=>{query=event.target.value;currentPage=1;render();});
  sort?.addEventListener('change',event=>{sortMode=event.target.value;currentPage=1;render();});
  render();
})();
