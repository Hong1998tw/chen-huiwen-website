'use strict';
(async () => {
  const root = document.getElementById('achievement-map');
  if (!root) return;
  root.classList.add('leaflet-container');
  const config = JSON.parse(document.getElementById('map-data').textContent);
  const PAGE_SIZE = 10;
  const list = document.getElementById('case-list');
  const cards = [...list.querySelectorAll('[data-case]')];
  // Keep the full server-rendered list for no-JS readers. The compact card
  // metadata is enough to start filtering without downloading map/search data.
  cards.forEach((card, index) => { card.hidden = index >= PAGE_SIZE; });
  const controls = Object.fromEntries(['q','village','category','subcategory','status','year'].map((key, i) => [key, document.getElementById(['case-search','village-filter','category-filter','subcategory-filter','status-filter','year-filter'][i])]));
  const count = document.getElementById('case-count');
  const empty = document.getElementById('case-empty');
  const message = document.getElementById('map-message');
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-Hant-TW').replace(/臺/g,'台').trim();
  const data = cards.map(card => JSON.parse(card.dataset.meta));
  const textById = new Map(cards.map(card => [card.dataset.case, normalize(card.innerText)]));
  const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  let map, markers, boundaries, mapPromise, dataPromise, fullDataLoaded = false, visible = data, currentPage = 1, selectedId = null, groupIds = [], searchTimer;
  const boundaryLayers = new Map();
  list.dataset.pageSize = String(PAGE_SIZE);
  const pagination = document.createElement('nav');
  pagination.className = 'case-pagination';
  pagination.setAttribute('aria-label', '建設與服務紀錄分頁');
  pagination.dataset.pageSize = String(PAGE_SIZE);
  list.after(pagination);
  const live=document.querySelector('.case-live-summary');
  const params = () => Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value]));
  function getState() { return { data, visible, selectedId, groupIds, filters: params(), page: currentPage }; }
  function announce() { document.dispatchEvent(new CustomEvent('huiwen:cases-change', { detail: getState() })); }
  async function ensureData() {
    if (fullDataLoaded) return true;
    if (dataPromise) return dataPromise;
    dataPromise = (async () => {
      try {
        const response = await fetch(config.url, {signal:AbortSignal.timeout(8000)});
        if (!response.ok) throw Error('records unavailable');
        const rows = await response.json();
        const ids = new Set(cards.map(card => card.dataset.case));
        if (!Array.isArray(rows) || rows.length !== cards.length || rows.some(row => !ids.has(row.id))) throw Error('invalid records');
        data.splice(0, data.length, ...rows);
        for (const row of rows) textById.set(row.id, normalize(row.searchText));
        fullDataLoaded = true;
        message.textContent = '點選里界可篩選；數字標記代表附近專題數，放大可分開查看。';
        return true;
      } catch {
        message.textContent = '地圖資料暫時無法載入；列表篩選仍可使用。';
        return false;
      }
    })().finally(() => { dataPromise = null; });
    return dataPromise;
  }
  function fits(c) {
    const f = params();
    const tokens = normalize(f.q).split(/\s+/).filter(Boolean);
    const villageOK = f.village === 'all' || (f.village === 'unassigned' ? !c.villages.length && !['全市政策','跨區服務'].includes(c.scope) : f.village.startsWith('v:') ? c.villages.includes(f.village.slice(2)) : c.scope === f.village.slice(2));
    return tokens.every(token => (textById.get(c.id) || '').includes(token)) && villageOK &&
      (f.category === 'all' || c.categories.includes(f.category)) &&
      (f.subcategory === 'all' || c.subcategories.includes(f.subcategory)) &&
      (f.status === 'all' || c.status === f.status) &&
      (f.year === 'all' || (f.year === 'undated' ? !c.years.length : c.years.includes(f.year)));
  }
  function syncURL() {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(params())) if (value.trim() && value !== 'all') p.set(key, value.trim());
    if (selectedId) p.set('case', selectedId);
    if (currentPage > 1) p.set('page', String(currentPage));
    history.replaceState(null, '', location.pathname + (p.size ? '?' + p : '') + location.hash);
  }
  function pageButton(label, page, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'case-page-button'; button.textContent = label; button.disabled = disabled;
    button.setAttribute('aria-label', /^\d+$/.test(label) ? `第 ${page} 頁` : label);
    if (String(currentPage) === label) button.setAttribute('aria-current','page');
    button.addEventListener('click', () => { currentPage = page; selectedId = null; groupIds = []; renderCards(); syncURL(); announce(); document.getElementById('case-results').scrollIntoView({behavior:motion(),block:'start'}); });
    return button;
  }
  function renderFilterChips() {
    const host = document.querySelector('.active-case-filters');
    if (!host) return;
    host.replaceChildren();
    for (const [key, control] of Object.entries(controls)) {
      if (!control.value.trim() || control.value === 'all') continue;
      const label = key === 'q' ? control.value.trim() : control.selectedOptions[0].textContent;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = label + ' ×';
      chip.setAttribute('aria-label', '移除篩選：' + label);
      chip.addEventListener('click', () => {
        control.value = key === 'q' ? '' : 'all';
        clearTimeout(searchTimer);
        filter();
        control.focus();
      });
      host.append(chip);
    }
    host.hidden = !host.childElementCount;
    const related = document.querySelector('[data-explore-filter-link]');
    if (related) {
      const query = new URLSearchParams();
      for (const key of ['q', 'village', 'category', 'status']) {
        const value = controls[key].value.trim();
        if (value && value !== 'all') query.set(key, value);
      }
      related.href = 'explore.html' + (query.size ? '?' + query : '');
    }
  }
  function renderCards() {
    renderFilterChips();
    const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(1, currentPage), pages);
    const ids = new Set(visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(c => c.id));
    cards.forEach(card => { card.hidden = !ids.has(card.dataset.case); card.classList.toggle('is-selected', card.dataset.case === selectedId); });
    const mapped = visible.filter(c => c.coordinates).length;
    count.textContent = visible.length ? `共 ${visible.length} 個專題 · 第 ${currentPage}/${pages} 頁 · ${mapped} 個有點位紀錄` : '共 0 個專題';
    live.replaceChildren(document.createTextNode(`目前找到 ${visible.length} 個專題 · `));const resultLink=document.createElement('a');resultLink.href='#case-results';resultLink.textContent='查看結果 ↓';live.append(resultLink);
    empty.hidden = visible.length > 0;
    pagination.replaceChildren(); pagination.hidden = pages <= 1;
    if (pages > 1) {
      pagination.append(pageButton('上一頁', currentPage - 1, currentPage === 1));
      for (let p = 1; p <= pages; p++) pagination.append(pageButton(String(p), p));
      pagination.append(pageButton('下一頁', currentPage + 1, currentPage === pages));
    }
  }
  function selectCase(id, group = []) {
    const i = visible.findIndex(c => c.id === id);
    if (i < 0) return;
    selectedId = id; groupIds = group.filter(id => visible.some(c => c.id === id));
    currentPage = Math.floor(i / PAGE_SIZE) + 1;
    renderCards(); syncURL(); announce();
    if (map && markers) {
      draw();
      markers.eachLayer(marker => { if (marker.options.caseIds?.includes(id)) marker.openPopup(); });
    }
  }
  function fit() {
    if (!map) return;
    const v = controls.village.value;
    if (v.startsWith('v:') && boundaryLayers.has(v.slice(2))) {
      map.fitBounds(boundaryLayers.get(v.slice(2)).getBounds(), {padding:[24,24],maxZoom:15,animate:false}); return;
    }
    const pts = visible.filter(c => c.coordinates).map(c => c.coordinates);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), {padding:[35,35],maxZoom:15,animate:false});
    else if (boundaries) map.fitBounds(boundaries.getBounds(), {padding:[15,15],animate:false});
  }
  function draw() {
    if (!map) return;
    markers.clearLayers();
    const groups = new Map();
    for (const c of visible.filter(c => c.coordinates)) {
      const key = c.coordinates.join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    // A11Y-01: group overlapping screen-space targets without changing source coordinates.
    // Each marker stays at a real recorded location; zooming separates nearby records.
    const separated = [];
    for (const cases of groups.values()) {
      const point = map.latLngToLayerPoint(cases[0].coordinates);
      const neighbor = separated.find(group => point.distanceTo(map.latLngToLayerPoint(group[0].coordinates)) < 52);
      if (neighbor) neighbor.push(...cases); else separated.push([...cases]);
    }
    for (const cases of separated) {
      const selectedCase = cases.find(c => c.id === selectedId);
      const popupCases = selectedCase ? [selectedCase, ...cases.filter(c => c.id !== selectedCase.id)] : cases;
      const pop = document.createElement('div'); pop.className = 'map-popup';
      const title = document.createElement('strong'); title.textContent = selectedCase ? selectedCase.title : cases.length > 1 ? `${cases.length} 個附近專題（放大地圖可分開查看）` : cases[0].title; pop.append(title);
      for (const c of popupCases) {
        const item = document.createElement('section'); item.className = 'map-popup-case';
        if (c.id === selectedId) {
          item.classList.add('is-selected');
          const selected = document.createElement('p'); selected.className = 'map-popup-selected'; selected.textContent = '目前選取'; item.append(selected);
        }
        const a = document.createElement('a'); a.href = `achievement-${c.id}.html`; a.textContent = c.title + ' →'; item.append(a);
        if (c.funding) {
          const f = c.funding, amount = value => (value / 10000).toLocaleString('zh-TW', {maximumFractionDigits: 2}) + '萬元';
          const total = document.createElement('p'); total.className = 'case-funding-total'; total.textContent = f.basis + ' ' + amount(f.total); item.append(total);
          const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '經費與共同爭取'; details.append(summary);
          for (const text of ['中央補助 ' + amount(f.centralGrant), f.approvedOn + ' 核定 · ' + f.approvalReference, f.collaboration, '新臺幣核定計畫口徑，非決算或已撥款。']) {
            const p = document.createElement('p'); p.textContent = text; details.append(p);
          }
          const source = document.createElement('a'); source.href = f.sourceUrl; source.textContent = f.sourceTitle + ' ↗'; source.target = '_blank'; source.rel = 'noopener noreferrer'; details.append(source);
          const full = document.createElement('a'); full.href = `achievement-${c.id}.html#case-sources`; full.textContent = '完整經費說明與來源 →'; details.append(full); item.append(details);
        }
        pop.append(item);
      }
      const marker = L.marker(cases[0].coordinates, {icon:L.divIcon({className:'case-marker', html:`<span>${cases.length}</span>`,iconSize:[44,44],iconAnchor:[22,22]}), title:cases.map(c=>c.title).join('、'),caseIds:cases.map(c=>c.id),keyboard:true}).bindPopup(pop,{maxWidth:320,autoPan:false}).addTo(markers);
      marker.on('click', () => selectCase(cases[0].id, cases.map(c => c.id)));
      marker.getElement()?.addEventListener('keydown', event => {
        if (event.key === ' ') { event.preventDefault(); marker.fire('click'); }
      });
    }
    boundaries?.setStyle(f => { const selected = controls.village.value === 'v:' + f.properties.name; return {color:selected?'#c36a32':'#4b7464',weight:selected?3:1,fillColor:selected?'#def68d':'#8faf9a',fillOpacity:selected?.45:.08}; });
  }
  function filter(update = true, resetPage = true) {
    if (resetPage) currentPage = 1;
    visible = data.filter(fits); selectedId = null; groupIds = [];
    renderCards(); draw();
    if (update) { syncURL(); fit(); }
    announce();
  }
  function reset() {
    clearTimeout(searchTimer);
    for (const [key, el] of Object.entries(controls)) el.value = key === 'q' ? '' : 'all';
    filter();
  }
  function readURL() {
    const p = new URLSearchParams(location.search);
    for (const [key, el] of Object.entries(controls)) {
      const val = p.get(key) || (key === 'q' ? '' : 'all');
      el.value = key === 'q' || [...el.options].some(o => o.value === val) ? val : 'all';
    }
    currentPage = Math.max(1, Number.parseInt(p.get('page'),10) || 1);
    filter(false,false);
    const requested = visible.find(c => c.id === p.get('case'));
    if (requested) selectCase(requested.id);
    fit();
  }
  window.HuiwenCases = Object.freeze({getState, setFilter(key,value) {const el=controls[key];if(!el)return;if(key!=='q'&&![...el.options].some(o=>o.value===value))return;el.value=value;clearTimeout(searchTimer);if(key==='q'&&String(value).trim())ensureData().finally(()=>filter());else filter();}, selectCase, clearSelection(){selectedId=null;groupIds=[];renderCards();syncURL();announce();}});
  controls.q.addEventListener('input', event => {
    clearTimeout(searchTimer);
    if (!event.isComposing) searchTimer = setTimeout(() => {
      if (controls.q.value.trim()) ensureData().finally(() => filter()); else filter();
    }, 100);
  });
  controls.q.addEventListener('compositionend', () => {
    clearTimeout(searchTimer);
    if (controls.q.value.trim()) ensureData().finally(() => filter()); else filter();
  });
  for (const [key, el] of Object.entries(controls)) if (key !== 'q') el.addEventListener('change', () => {clearTimeout(searchTimer);filter();});
  document.getElementById('reset-map-filters').addEventListener('click',reset);
  document.querySelector('[data-clear-filters]').addEventListener('click',reset);
  document.getElementById('map-fit').addEventListener('click', async () => { await ensureMap(); fit(); });
  window.addEventListener('popstate',readURL);
  for (const button of document.querySelectorAll('[data-locate]')) button.addEventListener('click', async () => {
    const c = visible.find(c => c.id === button.dataset.locate);
    if (!c) return;
    selectCase(c.id);
    await ensureMap();
    if (!map || !c.coordinates) {message.textContent='地圖目前無法使用，請直接閱讀專題詳情。';return;}
    map.setView(c.coordinates,16,{animate:false});
    markers.eachLayer(marker => { if (marker.options.caseIds?.includes(c.id)) marker.openPopup(); });
    root.scrollIntoView({behavior:motion(),block:'center'});
  });
  async function loadLeaflet() {
    if (window.L) return;
    if (!document.querySelector('link[data-leaflet]')) {
      const style=document.createElement('link');style.rel='stylesheet';style.href='assets/vendor/leaflet.css';style.dataset.leaflet='';document.head.append(style);
    }
    await new Promise((resolve,reject)=>{
      const existing=document.querySelector('script[data-leaflet]');
      if(window.L)return resolve();
      if(existing){existing.addEventListener('load',resolve,{once:true});existing.addEventListener('error',reject,{once:true});return;}
      const script=document.createElement('script');script.src='assets/vendor/leaflet.js';script.dataset.leaflet='';
      script.addEventListener('load',resolve,{once:true});script.addEventListener('error',reject,{once:true});document.head.append(script);
    });
  }
  readURL();
  if (new URLSearchParams(location.search).has('case')) ensureMap();
  else if (controls.q.value.trim()) ensureData().then(() => filter(false,false));
  function ensureMap() {
    if (map) return Promise.resolve(map);
    if (mapPromise) return mapPromise;
    mapPromise=(async()=>{
      if (!await ensureData()) return null;
      filter(false,false);
      const requestedCase = new URLSearchParams(location.search).get('case');
      if (requestedCase) selectCase(requestedCase);
      try{await loadLeaflet();}catch{message.textContent='互動地圖暫時無法載入，篩選與完整紀錄仍可使用。';return null;}
      root.replaceChildren();
      map=L.map(root,{scrollWheelZoom:false,zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false}).setView([22.615,120.351],13);
      markers=L.layerGroup().addTo(map);
      map.on('zoomend',draw);
      let errors=0;
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map).on('tileerror',()=>{if(++errors>=3)message.textContent='部分底圖未能載入；里界、點位及完整紀錄仍可使用。';});
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
      fetch('assets/fengshan-villages.geojson',{signal:controller.signal}).then(r=>{if(!r.ok)throw Error('boundaries');return r.json();}).then(geo=>{
        boundaries=L.geoJSON(geo,{onEachFeature:(f,layer)=>{
          boundaryLayers.set(f.properties.name,layer);layer.bindTooltip(f.properties.name);
          const choose=()=>window.HuiwenCases.setFilter('village','v:'+f.properties.name);
          layer.on('click',choose);
          layer.on('add',()=>{const el=layer.getElement();if(el){el.setAttribute('role','button');el.setAttribute('aria-label','篩選'+f.properties.name);el.setAttribute('tabindex','0');el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}});}});
        }}).addTo(map);draw();
        const selected=visible.find(record=>record.id===selectedId);
        if(selected?.coordinates){
          map.setView(selected.coordinates,16,{animate:false});
          requestAnimationFrame(()=>requestAnimationFrame(()=>markers.eachLayer(marker=>{if(marker.options.caseIds?.includes(selected.id))marker.openPopup();})));
        }else fit();
      }).catch(()=>{message.textContent='里界圖暫時無法載入，可用里別選單與專題點位查詢。';}).finally(()=>clearTimeout(timeout));
      draw();fit();announce();
      const directCase = new URLSearchParams(location.search).get('case');
      const directRecord = directCase && visible.find(record => record.id === directCase);
      if (directRecord?.coordinates) {
        const showSelectedPoint = () => {
          markers.eachLayer(marker => {
            if (marker.options.caseIds?.includes(directCase)) marker.openPopup();
          });
        };
        map.once('moveend',showSelectedPoint);
        map.setView(directRecord.coordinates,16,{animate:false});
        requestAnimationFrame(() => requestAnimationFrame(() => {
          showSelectedPoint();
          root.scrollIntoView({behavior:motion(),block:'center'});
        }));
      } else if (directCase && directRecord) {
        message.textContent='這筆紀錄沒有可定位座標；完整專題與列表篩選仍可使用。';
      }
      return map;
    })().finally(()=>{if(!map)mapPromise=null;});
    return mapPromise;
  }
  document.querySelector('[data-view="both"]')?.addEventListener('click', () => { ensureMap(); });
  if('IntersectionObserver' in window){
    const mapObserver=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){mapObserver.disconnect();ensureMap();}
    },{rootMargin:'0px 0px'});
    mapObserver.observe(root);
    window.addEventListener('scroll',()=>{
      const rect=root.getBoundingClientRect();
      if(rect.height && rect.top < innerHeight && rect.bottom > 0){mapObserver.disconnect();ensureMap();}
    },{once:true,passive:true});
  }else{
    window.addEventListener('scroll',()=>{if(root.getBoundingClientRect().height)ensureMap();},{once:true,passive:true});
  }
})();
