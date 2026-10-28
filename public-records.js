'use strict';
(() => {
  // All record text/history remains server-rendered and visible without JS.
  const records = [...document.querySelectorAll('article[id^="record-"]')];
  if (!records.length) return;
  const byId = new Map(records.map(record => [record.id.slice('record-'.length), record]));
  const parent = records[0].parentElement;
  const toolbar = document.createElement('div');
  toolbar.className = 'public-record-controls';
  const status = document.createElement('p');
  status.className = 'public-record-status';
  status.setAttribute('role', 'status');
  const showAll = document.createElement('button');
  showAll.type = 'button';
  showAll.className = 'button';
  showAll.textContent = '顯示全部工作紀錄';
  showAll.hidden = true;
  toolbar.append(status, showAll);
  parent.before(toolbar);

  function requestedId() {
    let fragment;
    try { fragment = decodeURIComponent(location.hash.slice(1)); }
    catch { return { requested: true, id: '' }; }
    if (fragment.startsWith('record-')) return { requested: true, id: fragment.slice('record-'.length) };
    const query = new URLSearchParams(location.search);
    return query.has('record') ? { requested: true, id: query.get('record') || '' } : { requested: false, id: '' };
  }
  function focusRecord(record) {
    const heading = record.querySelector('h2, h3') || record;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    const applyFocus = () => requestAnimationFrame(() => {
      if (!record.classList.contains('is-selected')) return;
      heading.focus({ preventScroll: true });
      record.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
    // Native initial-fragment navigation can reset focus after a deferred script.
    if (document.readyState === 'complete') applyFocus();
    else window.addEventListener('load', applyFocus, { once: true });
  }
  function render({ focus = true } = {}) {
    const request = requestedId();
    const selected = byId.get(request.id);
    // Unknown IDs leave the complete collection available instead of blanking it.
    for (const record of records) {
      record.hidden = Boolean(selected && record !== selected);
      record.classList.toggle('is-selected', record === selected);
    }
    showAll.hidden = !request.requested;
    if (selected) {
      status.textContent = `目前顯示 1 筆工作紀錄，共 ${records.length} 筆可供查閱。`;
      if (focus) focusRecord(selected);
    } else {
      status.textContent = request.requested
        ? `找不到這筆工作紀錄，以下顯示全部 ${records.length} 筆。`
        : `共 ${records.length} 筆工作紀錄。`;
      if (request.requested && focus) {
        status.setAttribute('tabindex', '-1');
        status.focus({ preventScroll: true });
      }
    }
  }
  showAll.addEventListener('click', () => {
    const url = new URL(location.href);
    url.searchParams.delete('record');
    url.hash = '';
    history.pushState(null, '', url.pathname + url.search);
    render({ focus: false });
    status.setAttribute('tabindex', '-1');
    status.focus({ preventScroll: true });
    toolbar.scrollIntoView({ block: 'start', behavior: 'auto' });
  });
  window.addEventListener('hashchange', () => render());
  window.addEventListener('popstate', () => render());
  render();
})();
