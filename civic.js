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
      schedule.querySelector('.schedule-period-note').textContent='這是 '+month+' 的歷史時間表，已非當月資訊。新月份時段請查看服務處原圖或來電確認。';
    }
  }
  const advanced = document.querySelector('.advanced-filters');
  if (advanced) advanced.open = ['category','subcategory','status','year'].some(key=>new URLSearchParams(location.search).has(key));
  const workspace = document.querySelector('.map-workspace');
  if (!workspace) return;
  const panel = workspace.querySelector('.map-panel');
  const toolbar = document.createElement('div');
  toolbar.className = 'wrap civic-view-controls';
  toolbar.setAttribute('role','group');
  toolbar.setAttribute('aria-label','紀錄顯示方式');
  const label = document.createElement('span');label.textContent='閱讀方式';toolbar.append(label);
  for (const [mode,title] of [['both','地圖與列表'],['list','只看列表']]) {
    const button=document.createElement('button');button.type='button';button.textContent=title;
    button.setAttribute('aria-pressed',String(mode==='both'));
    button.addEventListener('click',()=>{
      panel.hidden=mode==='list';workspace.classList.toggle('civic-list-only',mode==='list');
      toolbar.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
      window.dispatchEvent(new Event('resize'));
    });toolbar.append(button);
  }
  workspace.before(toolbar);
  toolbar.querySelectorAll('button')[new URLSearchParams(location.search).has('case') ? 0 : 1].click();
  // A locate action always restores the map before the existing map handler runs.
  document.addEventListener('click',event=>{
    if (!event.target.closest('[data-locate],a[href="#achievement-map"]') || !panel.hidden) return;
    toolbar.querySelector('button').click();
  },true);
})();
