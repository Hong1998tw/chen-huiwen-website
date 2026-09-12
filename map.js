'use strict';
(() => {
  const root = document.getElementById('achievement-map');
  if (!root) return;
  const data = JSON.parse(document.getElementById('map-data').textContent);
  const PAGE_SIZE = 10;
  const controls = Object.fromEntries(['q','village','category','subcategory','status','year'].map((key, i) => [key, document.getElementById(['case-search','village-filter','category-filter','subcategory-filter','status-filter','year-filter'][i])]));
  const list = document.getElementById('case-list');
  const cards = [...list.querySelectorAll('[data-case]')];
  const count = document.getElementById('case-count');
  const empty = document.getElementById('case-empty');
  const message = document.getElementById('map-message');
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-Hant-TW').replace(/臺/g,'台').trim();
  const textById = new Map(data.map(c => [c.id, normalize(c.searchText)]));
  const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  let map, markers, boundaries, visible = data, currentPage = 1, selectedId = null, groupIds = [], searchTimer;
  const boundaryLayers = new Map();
  list.dataset.pageSize = String(PAGE_SIZE);
  const pagination = document.createElement('nav');
  pagination.className = 'case-pagination';
  pagination.setAttribute('aria-label', '建設與服務紀錄分頁');
  pagination.dataset.pageSize = String(PAGE_SIZE);
  list.after(pagination);
  const live=document.createElement('p');live.className='case-live-summary';live.setAttribute('role','status');document.querySelector('.map-controls').append(live);
  const params = () => Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value]));
  function getState() { return { data, visible, selectedId, groupIds, filters: params(), page: currentPage }; }
  function announce() { document.dispatchEvent(new CustomEvent('huiwen:cases-change', { detail: getState() })); }
  function fits(c) {
    const f = params();
    const tokens = normalize(f.q).split(/\s+/).filter(Boolean);
    const villageOK = f.village === 'all' || (f.village === 'unassigned' ? !c.villages.length && !['全市政策','跨區服務'].includes(c.scope) : f.village.startsWith('v:') ? c.villages.includes(f.village.slice(2)) : c.scope === f.village.slice(2));
    return tokens.every(token => textById.get(c.id).includes(token)) && villageOK &&
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
  function renderCards() {
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
    for (const cases of groups.values()) {
      const pop = document.createElement('div'); pop.className = 'map-popup';
      const title = document.createElement('strong'); title.textContent = cases.length > 1 ? `${cases.length} 個相關專題` : cases[0].title; pop.append(title);
      for (const c of cases) { const a = document.createElement('a'); a.href = `achievement-${c.id}.html`; a.textContent = c.title + ' →'; pop.append(a); }
      const marker = L.marker(cases[0].coordinates, {icon:L.divIcon({className:'case-marker', html:`<span>${cases.length}</span>`,iconSize:[34,34],iconAnchor:[17,17]}), title:cases.map(c=>c.title).join('、'),keyboard:true}).bindPopup(pop,{maxWidth:320,autoPan:false}).addTo(markers);
      marker.on('click', () => selectCase(cases[0].id, cases.map(c => c.id)));
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
  window.HuiwenCases = Object.freeze({getState, setFilter(key,value) {const el=controls[key];if(!el)return;if(key!=='q'&&![...el.options].some(o=>o.value===value))return;el.value=value;clearTimeout(searchTimer);filter();}, selectCase, clearSelection(){selectedId=null;groupIds=[];renderCards();syncURL();announce();}});
  controls.q.addEventListener('input', event => { clearTimeout(searchTimer); if (!event.isComposing) searchTimer = setTimeout(() => filter(), 100); });
  controls.q.addEventListener('compositionend', () => { clearTimeout(searchTimer); filter(); });
  for (const [key, el] of Object.entries(controls)) if (key !== 'q') el.addEventListener('change', () => {clearTimeout(searchTimer);filter();});
  document.getElementById('reset-map-filters').addEventListener('click',reset);
  document.querySelector('[data-clear-filters]').addEventListener('click',reset);
  document.getElementById('map-fit').addEventListener('click',fit);
  window.addEventListener('popstate',readURL);
  for (const button of document.querySelectorAll('[data-locate]')) button.addEventListener('click', () => {
    const c = visible.find(c => c.id === button.dataset.locate);
    if (!c) return;
    selectCase(c.id);
    if (!map || !c.coordinates) {message.textContent='地圖目前無法使用，請直接閱讀專題詳情。';return;}
    map.setView(c.coordinates,16,{animate:false});
    markers.eachLayer(marker => {const p=marker.getLatLng();if(p.lat===c.coordinates[0]&&p.lng===c.coordinates[1])marker.openPopup();});
    root.scrollIntoView({behavior:motion(),block:'center'});
  });
  readURL();
  if (!window.L) { message.textContent='互動地圖暫時無法載入，篩選與完整紀錄仍可使用。';root.querySelector('.map-startup').textContent='請由列表閱讀完整紀錄。';return; }
  root.replaceChildren();
  map=L.map(root,{scrollWheelZoom:false,zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false}).setView([22.615,120.351],13);
  markers=L.layerGroup().addTo(map);
  let errors=0;
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map).on('tileerror',()=>{if(++errors>=3)message.textContent='部分底圖未能載入；里界、點位及完整紀錄仍可使用。';});
  const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),12000);
  fetch('assets/fengshan-villages.geojson',{signal:controller.signal}).then(r=>{if(!r.ok)throw Error('boundaries');return r.json();}).then(geo=>{
    boundaries=L.geoJSON(geo,{onEachFeature:(f,layer)=>{
      boundaryLayers.set(f.properties.name,layer);layer.bindTooltip(f.properties.name);
      const choose=()=>window.HuiwenCases.setFilter('village','v:'+f.properties.name);
      layer.on('click',choose);
      layer.on('add',()=>{const el=layer.getElement();if(el){el.setAttribute('role','button');el.setAttribute('aria-label','篩選'+f.properties.name);el.setAttribute('tabindex','0');el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}});}});
    }}).addTo(map);draw();fit();
  }).catch(()=>{message.textContent='里界圖暫時無法載入，可用里別選單與專題點位查詢。';}).finally(()=>clearTimeout(timeout));
  draw();fit();announce();
})();
