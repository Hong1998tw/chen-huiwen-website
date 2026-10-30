'use strict';
(() => {
  const main = document.querySelector('.home-redesign');
  if (!main) return;
  const taipei = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'});
  const month = taipei.format(new Date());
  const legal = main.querySelector('[data-home-legal-month]');
  if (legal && legal.dataset.homeLegalMonth !== month) {
    const note = legal.querySelector('small');
    if (note) note.textContent = '查看律師時間表';
  }

  // External thumbnails can fail (or fail before this script runs). Try the reviewed
  // local fallback once, then keep the text and original-source link.
  const failImage = image => {
    const figure = image.closest('[data-latest-media]');
    if (!figure || figure.classList.contains('is-failed')) return;
    const fallback = image.dataset.latestFallback;
    if (fallback && image.getAttribute('src') !== fallback) {
      image.src = fallback;
      if (image.dataset.latestFallbackAlt) image.alt = image.dataset.latestFallbackAlt;
      const credit = figure.querySelector('[data-latest-credit]');
      if (credit && image.dataset.latestFallbackCredit) credit.textContent = image.dataset.latestFallbackCredit;
      image.removeAttribute('referrerpolicy');
      return;
    }
    figure.classList.add('is-failed');
    figure.querySelector('[data-latest-media-fallback]')?.removeAttribute('hidden');
    // Keep the caption's space so a late image failure never shifts the page.
    const credit = figure.querySelector('[data-latest-credit]');
    if (credit) credit.style.visibility = 'hidden';
  };
  // Capture listener also covers items the CMS preview inserts later.
  main.addEventListener('error', event => {
    if (event.target instanceof HTMLImageElement && event.target.closest('[data-latest-media]')) failImage(event.target);
  }, true);
  main.querySelectorAll('[data-latest-media] img').forEach(image => {
    if (image.complete && image.naturalWidth === 0) failImage(image);
  });

  // Upcoming / past labels use the visitor's current time; the build stays time-independent.
  const now = Date.now();
  main.querySelectorAll('[data-event-start]').forEach(item => {
    const badge = item.querySelector('[data-latest-event-badge]');
    const start = Date.parse(item.dataset.eventStart);
    if (!badge || Number.isNaN(start)) return;
    // A passed date does not prove the event happened; cancellations come from the source status.
    badge.textContent = start > now ? '即將舉行' : '日期已過';
    badge.hidden = false;
  });

  const section = main.querySelector('[data-home-latest]');
  if (!section) return;
  const tablist = section.querySelector('[role="tablist"]');
  const tabs = [...section.querySelectorAll('[role="tab"]')];
  const panel = section.querySelector('[role="tabpanel"]');
  const list = section.querySelector('[data-latest-items]');
  const empty = section.querySelector('[data-latest-empty]');
  const more = section.querySelector('[data-latest-more]');
  const status = section.querySelector('[data-latest-status]');
  if (!tablist || !tabs.length || !list) return;
  const INITIAL = 3, STEP = 5;
  let filter = 'all', visible = INITIAL;
  const labels = Object.fromEntries(tabs.map(tab => [tab.dataset.latestFilter, tab.textContent.trim()]));

  const currentItems = () => [...list.querySelectorAll('.latest-item')];
  const render = (announce = false) => {
    const items = currentItems();
    const matching = items.filter(item => filter === 'all' || item.dataset.latestType === filter);
    items.forEach(item => { item.hidden = true; item.classList.remove('is-lead'); });
    matching.slice(0, visible).forEach((item, index) => {
      item.hidden = false;
      if (index === 0) {
        item.classList.add('is-lead');
        const image = item.querySelector('[data-latest-media] img');
        if (image) image.loading = 'eager';
      }
    });
    const lead = matching[0];
    list.classList.toggle('is-text-only', !lead || !lead.querySelector('[data-latest-media]'));
    if (empty) empty.hidden = matching.length > 0;
    if (more) {
      more.hidden = matching.length <= visible;
      more.textContent = `查看更多${filter === 'all' ? '資訊' : labels[filter]}`;
    }
    if (status && announce) {
      status.textContent = matching.length
        ? `${labels[filter]}：顯示 ${Math.min(visible, matching.length)} 則，共 ${matching.length} 則。`
        : `${labels[filter]}：目前沒有收錄的內容。`;
    }
  };

  const select = (tab, focus = false) => {
    filter = tab.dataset.latestFilter;
    visible = INITIAL;
    tabs.forEach(other => {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', tab.id);
    if (focus) tab.focus();
    render(true);
  };

  tabs.forEach(tab => tab.addEventListener('click', () => select(tab)));
  tablist.addEventListener('keydown', event => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const keys = {ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1};
    if (!(event.key in keys)) return;
    event.preventDefault();
    select(tabs[(keys[event.key] + tabs.length) % tabs.length], true);
  });
  more?.addEventListener('click', () => {
    const firstNew = visible;
    visible += STEP;
    render(true);
    const matching = currentItems().filter(item => filter === 'all' || item.dataset.latestType === filter);
    matching[firstNew]?.querySelector('.latest-title a')?.focus();
  });
  // The CMS preview reorders rendered items when pins change.
  document.addEventListener('huiwen:latest-order', () => render(false));
  tablist.hidden = false;
  render(false);
})();
