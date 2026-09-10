'use strict';
(() => {
  const PAGE_SIZE = 10;
  const pressReleases = [
    {date:'2026-09-02',category:'選舉與公共參與',title:'陳慧文完成鳳山市議員選舉登記',summary:'完成高雄市鳳山區市議員選舉候選人登記，攜手高雄大聯盟，持續關注交通、教育、長照與地方建設。',href:'news-articles.html#news-candidate-registration-20260902',keywords:'鳳山 候選人 登記 高雄大聯盟 賴瑞隆 陳其邁 交通 教育 長照'},
    {date:'2026-08-17',category:'民生消保',title:'毛動力嘟嘟車團訟收件倒數兩週 陳慧文拜訪台灣消保協會 籲受害者8月31日前寄出文件',summary:'拜訪台灣消費者保護協會確認團體訴訟收件進度；原定收件已於 2026 年 8 月 31 日截止。',href:'news-articles.html#news-dudu-lawsuit-20260817',keywords:'毛動力 嘟嘟車 鷹騰 團訟 消費者保護協會 消保 團體訴訟 8月31日'},
    {date:'2026-08-10',category:'國際交流',title:'12 年前的那雙手，我們一直記得',summary:'記錄高雄與熊本在災害中相互扶持的情誼，以及 0728 日本熊本賑災專案；該次募款已截止。',href:'news-articles.html#news-kumamoto-relief-20260810',keywords:'熊本 高雄 氣爆 地震 賑災 捐款 國合會 0728'},
    {date:'2026-06-28',category:'地方文化',title:'高雄鳳山五福市場職人展開展，7 月 12 日前免費看攤商故事',summary:'走進五福市場，看市場職人展與攤位微整形計畫如何記錄攤商故事、連結青年設計與傳統市場。',href:'news-articles.html#news-wufu-market-20260628',keywords:'五福市場 五甲 市場職人展 張曦勻 超鮮水餃 無名雜貨舖 公民參與 傳統市場'},
    {date:'2025-12-17',category:'科技治理',title:'科技助攻民主！陳慧文首創「憑證地圖」結合群眾回報，打造公投連署科技新模式',summary:'以開放資料與公民回報製作自然人憑證即時地圖，協助市民掌握製卡名額與電子連署準備資訊。',href:'news-articles.html#news-certificate-map-20251217',keywords:'自然人憑證 地圖 電子連署 公投 數位民主 開放資料 公民回報'},
    {date:'2025-11-25',category:'教育兒少',title:'高雄研擬校事會議分流 吳立森：調查費由教育局全額支應',summary:'質詢校事會議分流與調查經費，要求降低學校行政負擔並建立輕重案件處理機制。',href:'news-articles.html#news-school-review-20251125',keywords:'校事會議 教育局 吳立森 調查費 分流 教師 教育'},
    {date:'2025-11-25',category:'民生消保',title:'誤信話術買「毛動力」非法車 高雄傳多起受害 揹債買廢鐵求助無門',summary:'議會質詢聚焦未經型式認證電動載具的消費爭議、融資契約與警方偵辦等問題。',href:'news-articles.html#news-dudu-illegal-20251125',keywords:'毛動力 電動載具 型式認證 融資 消費爭議 交通局 警察局'},
    {date:'2025-11-25',category:'教育與社福',title:'霸氣喊「經費不是問題」！陳其邁承諾特教生交通補助 護理師薪資補足',summary:'總質詢關注特教學校護理師薪資、重症學童交通補助與照護支持，市府回應將組成專案小組改善。',href:'news-articles.html#news-special-education-20251125',keywords:'特教 重症學童 交通補助 護理師 薪資 陳其邁 教育'},
    {date:'2025-11-18',category:'民生消保',title:'嗆告議員？陳慧文、張博洋火大：要告就來告！ 陳慧文揭毛動力5.6萬「廢鐵」詐術 批業者鴨霸',summary:'記者會回應毛動力嘟嘟車消費爭議，聚焦車輛合法上路、產品安全、業者提告與團體訴訟等問題。',href:'news-articles.html#news-dudu-press-20251118',keywords:'毛動力 嘟嘟車 張博洋 鷹騰科技 消費爭議 記者會 團體訴訟'},
    {date:'2025-11-10',category:'經濟與產業',title:'陳慧文促高雄畜產轉型 農業局允3個月內提計畫',summary:'農林部門質詢提出畜產轉型三項策略，並關注鳳山水資源中心小水力發電與公共開放。',href:'news-articles.html#news-livestock-transition-20251110',keywords:'畜產 非洲豬瘟 廚餘養豬 黑豬 農業局 鳳山水資源中心 小水力'},
    {date:'2025-11-06',category:'教育與社福',title:'重症學童照護人力、資源陷困境 重症交通費1000元，一天都不夠 吳立森允諾研議',summary:'教育部門質詢聚焦重症學童鑑定安置、護理人力、教助員與跨局處資源整合。',href:'news-articles.html#news-severe-students-20251106',keywords:'重症學童 護理師 教助員 交通費 教育局 吳立森 鑑定安置'},
    {date:'2025-10-27',category:'科技治理',title:'市府APP疊床架屋、鳳山車位難求 陳慧文質詢促整合平台、打造友善職場',summary:'質詢市府 APP 整合、1999 數位服務，以及鳳山行政中心停車、公托與日照等友善職場需求。',href:'news-articles.html#news-city-app-workplace-20251027',keywords:'APP 數位市民平台 1999 鳳山行政中心 停車 公托 日照 友善職場'},
    {date:'2025-10-22',category:'地方建設',title:'鳳山擋土牆案4年未解 議員質詢促市府解決爭議',summary:'質詢過埤路二巷擋土牆修繕協調、新強公園涼亭、國嶺公園與營建土石方管理。',href:'news-articles.html#news-retaining-wall-20251022',keywords:'過埤路 擋土牆 工務局 國產署 新強公園 國嶺公園 土石方 GPS'},
    {date:'2025-10-15',category:'社福照護',title:'心理健康資源斷層與長照給付困境：陳慧文籲補足 45+ 照顧缺口',summary:'警消衛環部門質詢聚焦 45 歲以上心理健康資源、長照機構成本資料與三高防治政策。',href:'news-articles.html#news-mental-health-20251015',keywords:'心理健康 45歲 長照 雄健康 三高 健康臺灣888 衛生局'},
    {date:'2025-10-09',category:'交通與科技',title:'鳳山交通網、市府APP整合陷多頭馬車？ 陳慧文批智慧城市讓民眾更混亂',summary:'交通部門質詢聚焦中崙、過埤大眾運輸與捷運路網，以及市府 APP 與一站式數位服務整合。',href:'news-articles.html#news-transit-superapp-20251009',keywords:'中崙 過埤 黃線 Y19 Y20 橘12 公車 APP Super APP 智慧城市'},
    {date:'2025-09-09',category:'科技治理',title:'註冊率不足2%成警訊！高雄市議會四議員聯手，要求市府打造「有感」數位市民平台',summary:'公聽會由陳慧文、邱俊憲、湯詠瑜、張博洋共同主持，聚焦數位市民平台入口、誘因、隱私與數據治理。',href:'news-articles.html#news-digital-citizen-20250909',keywords:'數位市民平台 公聽會 邱俊憲 湯詠瑜 張博洋 LINE 個資 數據治理 44193'}
  ];

  const normalize = value => String(value || '').toLocaleLowerCase('zh-Hant-TW').replace(/\s+/g,' ').trim();
  const formatDate = date => date.replaceAll('-','.');
  const createPagination = ({container,totalItems,currentPage,onChange,label}) => {
    container.replaceChildren();
    const totalPages=Math.max(1,Math.ceil(totalItems/PAGE_SIZE));
    if(totalItems<=PAGE_SIZE){container.hidden=true;return;}
    container.hidden=false;
    const makeButton=(text,page,options={})=>{
      const button=document.createElement('button');button.type='button';button.className='news-page-button';button.textContent=text;button.disabled=Boolean(options.disabled);
      if(options.current)button.setAttribute('aria-current','page');button.setAttribute('aria-label',options.ariaLabel||`${label}第 ${page} 頁`);button.addEventListener('click',()=>onChange(page));return button;
    };
    container.append(makeButton('上一頁',Math.max(1,currentPage-1),{disabled:currentPage===1,ariaLabel:`${label}上一頁`}));
    for(let page=1;page<=totalPages;page+=1)container.append(makeButton(String(page),page,{current:page===currentPage}));
    container.append(makeButton('下一頁',Math.min(totalPages,currentPage+1),{disabled:currentPage===totalPages,ariaLabel:`${label}下一頁`}));
  };

  const initPressReleases=()=>{
    const host=document.querySelector('.news-layout');if(!host)return;
    host.classList.add('press-release-enhanced');host.replaceChildren();
    const head=document.createElement('div');head.className='section-head';const headText=document.createElement('div');headText.innerHTML='<p class="eyebrow">PRESS RELEASES &amp; UPDATES</p><h2>新聞稿與公告</h2>';const status=document.createElement('p');status.className='news-filter-status';status.setAttribute('aria-live','polite');head.append(headText,status);
    const searchPanel=document.createElement('div');searchPanel.className='news-search-panel';const label=document.createElement('label');label.className='news-search-label';label.htmlFor='press-news-search';label.textContent='搜尋新聞稿';const input=document.createElement('input');input.id='press-news-search';input.className='news-search-input';input.type='search';input.placeholder='輸入關鍵字、議題或人物';input.autocomplete='off';searchPanel.append(label,input);
    const note=document.createElement('p');note.className='source-note news-filter-note';note.textContent='每頁顯示 10 筆；點選摘要或「閱讀全文」後進入完整內文。期限型公告會保留原始新聞稿，並標示目前狀態。';
    const grid=document.createElement('div');grid.className='news-summary-grid';const empty=document.createElement('p');empty.className='news-filter-empty';empty.textContent='目前沒有符合搜尋條件的新聞稿。';empty.hidden=true;const pagination=document.createElement('nav');pagination.className='news-pagination';pagination.setAttribute('aria-label','新聞稿分頁');host.append(head,searchPanel,note,grid,empty,pagination);
    let currentPage=1,query='';
    const render=()=>{const term=normalize(query);const matches=pressReleases.filter(item=>!term||normalize([item.date,item.category,item.title,item.summary,item.keywords].join(' ')).includes(term));const totalPages=Math.max(1,Math.ceil(matches.length/PAGE_SIZE));currentPage=Math.min(currentPage,totalPages);const start=(currentPage-1)*PAGE_SIZE;const visibleItems=matches.slice(start,start+PAGE_SIZE);grid.replaceChildren();visibleItems.forEach(item=>{const card=document.createElement('a');card.className='news-summary-card';card.href=item.href;card.innerHTML=`<div class="news-summary-meta"><span>${item.category}</span><time datetime="${item.date}">${formatDate(item.date)}</time></div><h3>${item.title}</h3><p>${item.summary}</p><span class="text-link news-summary-more">閱讀全文 →</span>`;grid.append(card);});status.textContent=term?`搜尋結果 ${matches.length} 筆 · 第 ${currentPage}/${totalPages} 頁`:`共 ${matches.length} 筆 · 第 ${currentPage}/${totalPages} 頁`;empty.hidden=matches.length!==0;createPagination({container:pagination,totalItems:matches.length,currentPage,label:'新聞稿',onChange:page=>{currentPage=page;render();host.scrollIntoView({behavior:'smooth',block:'start'});}});};
    input.addEventListener('input',event=>{query=event.target.value;currentPage=1;render();});render();
  };

  const initMediaReports=()=>{
    const panel=document.querySelector('[data-news-filters]');const grid=document.querySelector('[data-news-grid]');if(!panel||!grid)return;
    const records=[...grid.querySelectorAll('[data-news-categories]')];const buttons=[...panel.querySelectorAll('[data-news-filter]')];const status=document.querySelector('[data-news-count]');const empty=document.querySelector('[data-news-empty]');if(!records.length||!buttons.length)return;
    const searchPanel=document.createElement('div');searchPanel.className='news-search-panel news-search-panel--reports';const label=document.createElement('label');label.className='news-search-label';label.htmlFor='media-news-search';label.textContent='搜尋媒體報導';const input=document.createElement('input');input.id='media-news-search';input.className='news-search-input';input.type='search';input.placeholder='輸入標題、媒體、議題或人物';input.autocomplete='off';searchPanel.append(label,input);panel.before(searchPanel);
    const pagination=document.createElement('nav');pagination.className='news-pagination';pagination.setAttribute('aria-label','相關新聞報導分頁');grid.after(pagination);
    const labels=new Map(buttons.map(button=>[button.dataset.newsFilter,button.textContent.trim()]));let category='all',query='',currentPage=1;
    const render=()=>{const term=normalize(query);const matches=records.filter(record=>{const categories=(record.dataset.newsCategories||'').split(/\s+/).filter(Boolean);return(category==='all'||categories.includes(category))&&(!term||normalize(record.textContent).includes(term));});const totalPages=Math.max(1,Math.ceil(matches.length/PAGE_SIZE));currentPage=Math.min(currentPage,totalPages);const start=(currentPage-1)*PAGE_SIZE;const visible=new Set(matches.slice(start,start+PAGE_SIZE));records.forEach(record=>{record.hidden=!visible.has(record);});buttons.forEach(button=>{const active=button.dataset.newsFilter===category;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));});if(status){const categoryText=category==='all'?'全部':(labels.get(category)||'此分類');const prefix=term?`${categoryText}搜尋結果`:categoryText==='全部'?'共':categoryText;status.textContent=`${prefix} ${matches.length} 筆 · 第 ${currentPage}/${totalPages} 頁`;}if(empty)empty.hidden=matches.length!==0;createPagination({container:pagination,totalItems:matches.length,currentPage,label:'相關新聞',onChange:page=>{currentPage=page;render();document.querySelector('#news-reports')?.scrollIntoView({behavior:'smooth',block:'start'});}});};
    panel.hidden=false;buttons.forEach(button=>button.addEventListener('click',()=>{category=button.dataset.newsFilter;currentPage=1;render();}));input.addEventListener('input',event=>{query=event.target.value;currentPage=1;render();});render();
  };

  initPressReleases();
  initMediaReports();
})();
