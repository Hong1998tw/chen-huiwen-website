'use strict';
// Progressive enhancement: navigation remains usable when JavaScript is disabled.
(() => {
  const toggle = document.querySelector('.menu-toggle');
  const navigation = document.getElementById('navigation');
  if (!toggle || !navigation) return;
  document.documentElement.classList.add('menu-ready');
  function closeMenu(returnFocus = false) {
    navigation.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle.focus();
  }
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    navigation.classList.toggle('is-open', open);
  });
  navigation.addEventListener('click', event => {
    if (event.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') closeMenu(true);
  });
  window.matchMedia('(min-width: 781px)').addEventListener('change', () => closeMenu());
})();

(() => {
  const search = document.getElementById('record-search');
  if (search) {
    const records = [...document.querySelectorAll('[data-record]')];
    const count = document.querySelector('[data-count]');
    const empty = document.querySelector('[data-empty]');
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      records.forEach(record => {record.hidden = !record.textContent.toLocaleLowerCase().includes(query);if (!record.hidden) visible++;});
      count.textContent = `顯示 ${visible} 筆紀錄`;
      empty.hidden = visible !== 0;
    };
    search.addEventListener('input', filter);filter();
  }
  const dialog = document.getElementById('photo-dialog');
  if (dialog && typeof dialog.showModal === 'function') {
    document.querySelectorAll('[data-lightbox]').forEach(link => link.addEventListener('click', event => {
      event.preventDefault();
      const img = dialog.querySelector('img');img.src = link.href;img.alt = link.querySelector('img').alt;
      dialog.querySelector('p').textContent = img.alt;dialog.showModal();
    }));
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {if (event.target === dialog) {const r = dialog.getBoundingClientRect();if(event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();}});
  }
})();
