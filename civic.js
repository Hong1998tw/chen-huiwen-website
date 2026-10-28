'use strict';
(() => {
  const form = document.querySelector('.civic-search');
  if (form) {
    const enhance = () => {
      if (!document.querySelector('.global-search-trigger')) return;
      form.querySelector('[data-search-hint]').textContent = '搜尋政績、新聞、歷屆政見、活動與服務資訊。';
    };
    enhance();
    window.addEventListener('load', enhance, {once:true});
    form.addEventListener('submit', event => {
      if (!document.querySelector('.global-search-trigger')) return;
      event.preventDefault();
      document.dispatchEvent(new CustomEvent('huiwen:search', {detail:{query:form.elements.q.value}}));
    });
  }
  const schedule = document.querySelector('[data-schedule-month]');
  if (schedule) {
    const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const month = schedule.dataset.scheduleMonth;
    const past = [...schedule.querySelectorAll('[data-session-date]')].filter(row => row.dataset.sessionDate < today);
    if (today.slice(0,7) === month && past.length) {
      const toggle=document.createElement('button');toggle.type='button';toggle.className='schedule-history-toggle';
      toggle.setAttribute('aria-expanded','false');toggle.textContent='顯示本月全部日期';
      past.forEach(row=>{row.hidden=true;});
      const caption=schedule.querySelector('caption'), original=caption.textContent;
      caption.textContent=original+' · 僅顯示今日起的日期';
      toggle.addEventListener('click',()=>{
        const show=toggle.getAttribute('aria-expanded')!=='true';
        toggle.setAttribute('aria-expanded',String(show));toggle.textContent=show?'只看今日起的日期':'顯示本月全部日期';
        past.forEach(row=>{row.hidden=!show;});caption.textContent=original+(show?'':' · 僅顯示今日起的日期');
      });schedule.querySelector('table').before(toggle);
    } else if (today.slice(0,7) > month) {
      schedule.querySelector('.schedule-period-note').textContent='這是 '+month+' 的歷史時間表，已非當月資訊。新月份時段請查看服務處最新公告或來電確認。';
    }
  }
  const advanced = document.querySelector('.advanced-filters');
  if (advanced) advanced.open = ['category','subcategory','status','year'].some(key=>new URLSearchParams(location.search).has(key));
  const filterFields = document.getElementById('case-filter-fields');
  const filterDialog = document.getElementById('case-filter-dialog');
  const filterDialogSlot = filterDialog?.querySelector('.case-filter-dialog-slot');
  const filterTrigger = document.getElementById('case-filter-open');
  const filterClose = document.getElementById('case-filter-close');
  const filterHome = document.querySelector('.map-controls');
  const filterChips = document.querySelector('.active-case-filters');
  const mobileFilterLayout = window.matchMedia?.('(max-width: 780px)') || {matches:false};
  const supportsFilterDialog = Boolean(filterFields && filterDialog?.showModal && filterDialog?.close && filterDialogSlot && filterTrigger && filterClose && filterHome && window.matchMedia);
  let filterCloseFocus = filterTrigger;
  if (supportsFilterDialog) {
    const syncFilterLayout = () => {
      const useDialog = mobileFilterLayout.matches;
      const ready = document.documentElement.classList.contains('case-filter-dialog-ready');
      if (useDialog) {
        const focusedField = filterFields.contains(document.activeElement);
        if (filterFields.parentElement !== filterDialogSlot) filterDialogSlot.append(filterFields);
        document.documentElement.classList.add('case-filter-dialog-ready');
        filterTrigger.hidden = false;
        if (!ready && focusedField) filterTrigger.focus({preventScroll:true});
        return;
      }
      const activeElement = document.activeElement;
      if (filterDialog.open) {
        filterCloseFocus = filterFields.contains(activeElement) ? activeElement : filterFields.querySelector('select');
        filterDialog.close();
      } else if (ready && activeElement === filterTrigger) {
        filterCloseFocus = filterFields.querySelector('select');
      }
      if (filterFields.parentElement !== filterHome) filterHome.insertBefore(filterFields, filterChips);
      document.documentElement.classList.remove('case-filter-dialog-ready');
      filterTrigger.hidden = true;
      if (ready && !filterDialog.open && activeElement === filterTrigger) {
        requestAnimationFrame(() => filterCloseFocus?.focus({preventScroll:true}));
      }
    };
    filterTrigger.addEventListener('click', () => {
      if (!mobileFilterLayout.matches || filterDialog.open) return;
      filterCloseFocus = filterTrigger;
      filterDialog.showModal();
      filterTrigger.setAttribute('aria-expanded', 'true');
      document.documentElement.classList.add('case-filter-dialog-open');
      document.body.classList.add('case-filter-dialog-open');
      requestAnimationFrame(() => filterFields.querySelector('select')?.focus({preventScroll:true}));
    });
    filterDialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || !filterDialog.open) return;
      const tabStops = [...filterDialog.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(element => {
        if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length) return false;
        for (let ancestor = element.parentElement; ancestor && ancestor !== filterDialog; ancestor = ancestor.parentElement) {
          if (ancestor.tagName === 'DETAILS' && !ancestor.open && ancestor.querySelector(':scope > summary') !== element) return false;
        }
        return true;
      });
      if (!tabStops.length) return;
      const activeIndex = tabStops.indexOf(document.activeElement);
      const wraps = event.shiftKey ? activeIndex <= 0 : activeIndex === -1 || activeIndex === tabStops.length - 1;
      if (!wraps) return;
      event.preventDefault();
      tabStops[event.shiftKey ? tabStops.length - 1 : 0].focus({preventScroll:true});
    });
    filterClose.addEventListener('click', () => filterDialog.close());
    filterDialog.addEventListener('close', () => {
      document.documentElement.classList.remove('case-filter-dialog-open');
      document.body.classList.remove('case-filter-dialog-open');
      filterTrigger.setAttribute('aria-expanded', 'false');
      const target = filterCloseFocus;
      filterCloseFocus = filterTrigger;
      if (target?.isConnected && !target.hidden) requestAnimationFrame(() => target.focus({preventScroll:true}));
    });
    mobileFilterLayout.addEventListener?.('change', syncFilterLayout);
    window.addEventListener('resize', syncFilterLayout, {passive:true});
    syncFilterLayout();
  }
  const workspace = document.querySelector('.map-workspace');
  if (!workspace) return;
  const panel = workspace.querySelector('.map-panel');
  const toolbar = document.querySelector('.civic-view-controls');
  for (const button of toolbar.querySelectorAll('[data-view]')) {
    const mode = button.dataset.view;
    button.disabled = false;
    button.addEventListener('click',()=>{
      panel.hidden=mode==='list';workspace.classList.toggle('civic-list-only',mode==='list');
      toolbar.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
      window.dispatchEvent(new Event('resize'));
    });
  }
  const directCase = new URLSearchParams(location.search).get('case');
  const directCard = [...document.querySelectorAll('#case-list [data-case]')].find(card => card.dataset.case === directCase);
  let directCoordinates = null;
  try { directCoordinates = directCard ? JSON.parse(directCard.dataset.meta).coordinates : null; } catch {}
  const hasPoint = Array.isArray(directCoordinates) && directCoordinates.length === 2 && directCoordinates.every(Number.isFinite);
  toolbar.querySelector(`[data-view="${hasPoint ? 'both' : 'list'}"]`).click();
  // A locate action always restores the map before the existing map handler runs.
  document.addEventListener('click',event=>{
    if (!event.target.closest('[data-locate],a[href="#achievement-map"]') || !panel.hidden) return;
    toolbar.querySelector('button').click();
  },true);
})();
