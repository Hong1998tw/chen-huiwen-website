'use strict';
(() => {
  const panel = document.querySelector('[data-news-filters]');
  const grid = document.querySelector('[data-news-grid]');
  if (!panel || !grid) return;

  const records = [...grid.querySelectorAll('[data-news-categories]')];
  const buttons = [...panel.querySelectorAll('[data-news-filter]')];
  const status = document.querySelector('[data-news-count]');
  const empty = document.querySelector('[data-news-empty]');
  if (!records.length || !buttons.length) return;

  const labels = new Map(buttons.map(button => [button.dataset.newsFilter, button.textContent.trim()]));
  const applyFilter = category => {
    let visible = 0;
    records.forEach(record => {
      const categories = (record.dataset.newsCategories || '').split(/\s+/).filter(Boolean);
      const matches = category === 'all' || categories.includes(category);
      record.hidden = !matches;
      if (matches) visible += 1;
    });

    buttons.forEach(button => {
      const active = button.dataset.newsFilter === category;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    if (status) {
      status.textContent = category === 'all'
        ? `共 ${records.length} 筆`
        : `${labels.get(category) || '此分類'}：${visible} 筆`;
    }
    if (empty) empty.hidden = visible !== 0;
  };

  panel.hidden = false;
  buttons.forEach(button => button.addEventListener('click', () => applyFilter(button.dataset.newsFilter)));
  applyFilter('all');
})();
