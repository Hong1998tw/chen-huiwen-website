'use strict';
// Progressive enhancement: navigation remains usable when JavaScript is disabled.
(() => {
  const toggle = document.querySelector('.menu-toggle');
  const navigation = document.getElementById('navigation');
  if (!toggle || !navigation) return;
  document.documentElement.classList.add('menu-ready');
  const backdrop = document.createElement('button');
  backdrop.type = 'button'; backdrop.className = 'menu-backdrop'; backdrop.hidden = true;
  backdrop.setAttribute('aria-label', '關閉選單');
  document.body.append(backdrop);
  const links = [...navigation.querySelectorAll('a')];
  function closeMenu(returnFocus = false) {
    navigation.classList.remove('is-open'); document.body.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded', 'false'); backdrop.hidden = true;
    if (returnFocus) toggle.focus();
  }
  function openMenu() {
    navigation.classList.add('is-open'); document.body.classList.add('menu-open');
    toggle.setAttribute('aria-expanded', 'true'); backdrop.hidden = false;
    links[0]?.focus();
  }
  toggle.addEventListener('click', () => toggle.getAttribute('aria-expanded') === 'true' ? closeMenu(true) : openMenu());
  backdrop.addEventListener('click', () => closeMenu(true));
  navigation.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') closeMenu(true);
    if (event.key === 'Tab' && toggle.getAttribute('aria-expanded') === 'true') {
      const focusable = [toggle, ...links]; const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.matchMedia('(min-width: 781px)').addEventListener('change', event => { if (event.matches) closeMenu(); });
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

// News article pages keep a compact static footer for no-JS readability; enhance it
// with the same public contact/social destinations used across the rest of the site.
(() => {
  if (!document.querySelector('.news-full-article')) return;
  const footerLinks = document.querySelector('.footer .footer-bottom div');
  if (!footerLinks) return;
  const required = [
    ['tel:+88678212536', '07-821-2536', false],
    ['https://line.me/R/ti/p/@yve2766q', 'LINE ↗', true],
    ['https://www.facebook.com/hwcfs/', 'Facebook ↗', true],
    ['https://www.instagram.com/huiwen.ifs/', 'Instagram ↗', true],
    ['https://www.youtube.com/channel/UCJPIvufDGcdD8PgYUi_YyDQ', 'YouTube ↗', true],
    ['https://www.threads.com/@huiwen.ifs?igshid=NTc4MTIwNjQ2YQ==', 'Threads（脆） ↗', true],
  ];
  const hasHref = href => [...footerLinks.querySelectorAll('a')].some(link => link.getAttribute('href') === href);
  required.forEach(([href, label, external]) => {
    if (hasHref(href)) return;
    footerLinks.append(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'text-link';
    link.href = href;
    link.textContent = label;
    if (external) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    footerLinks.append(link);
  });
})();

// The news page first lets news.js enhance its legacy sections, then consolidates
// those rendered cards into one searchable, filterable and sortable interface.
(() => {
  if (!document.querySelector('#news-reports')) return;
  window.addEventListener('DOMContentLoaded', () => {
    const script = document.createElement('script');
    script.src = 'news-unified.js?v=20260910-1';
    script.async = false;
    document.body.append(script);
  }, {once: true});
})();
