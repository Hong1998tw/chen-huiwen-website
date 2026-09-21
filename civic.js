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
  // A locate action always restores the map before the existing map handler runs.
  document.addEventListener('click',event=>{
    if (!event.target.closest('[data-locate],a[href="#achievement-map"]') || !panel.hidden) return;
    toolbar.querySelector('button').click();
  },true);
})();
