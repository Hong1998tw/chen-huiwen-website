'use strict';
const HUIWEN_ASSET_BASE = new URL('.', document.currentScript.src);
// Reserve the actual sticky header height for hash links and keyboard scrolling.
(() => {
  const header = document.querySelector('.site-header');
  if (!header) return;
  // ResizeObserver supplies the completed layout size; avoid forcing a full
  // page reflow during startup, especially on the long achievement index.
  new ResizeObserver(([entry]) => {
    const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height + 1;
    document.documentElement.style.setProperty('--site-header-height', `${Math.ceil(height)}px`);
  }).observe(header, {box:'border-box'});
})();
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
  if (!navigation.querySelector('.nav-group') && !navigation.querySelector('a[href="election.html"],a[href="/election.html"]')) {
    const election = document.createElement('a');
    election.href = 'election.html';
    election.textContent = '2026選舉';
    const donation = navigation.querySelector('a[href="political-donation.html"],a[href="/political-donation.html"]');
    if (donation) donation.after(election); else navigation.append(election);
  }
  if (!navigation.querySelector('.nav-group') && !navigation.querySelector('a[href="service.html#monthly-heading"],a[href="/service.html#monthly-heading"]')) {
    const lawyer = document.createElement('a');
    lawyer.href = 'service.html#monthly-heading';
    lawyer.textContent = '律師時間表';
    const election = navigation.querySelector('a[href="election.html"],a[href="/election.html"]');
    if (election) election.after(lawyer); else navigation.append(lawyer);
  }
  toggle.setAttribute('aria-label', '開啟主要選單');
  const links = [...navigation.querySelectorAll('a')];
  const groups = [...navigation.querySelectorAll('.nav-group')];
  const mobile = window.matchMedia('(max-width: 780px)');
  const arrangeGroups = () => groups.forEach(group => { group.open = mobile.matches; });
  arrangeGroups(); mobile.addEventListener('change', arrangeGroups);
  groups.forEach(group => group.addEventListener('toggle', () => {
    if (group.open && !mobile.matches) groups.filter(other => other !== group).forEach(other => { other.open = false; });
  }));
  document.addEventListener('click', event => {
    if (!mobile.matches && !navigation.contains(event.target)) groups.forEach(group => { group.open = false; });
  });
  const background = [...document.body.children].filter(node =>
    node !== backdrop && !node.contains(toggle) && !['SCRIPT', 'STYLE', 'DIALOG'].includes(node.tagName));
  let inertBefore = [];
  function positionMenu() {
    const bottom = document.querySelector('.site-header').getBoundingClientRect().bottom;
    navigation.style.setProperty('--menu-top', `${Math.ceil(bottom + 12)}px`);
  }
  function closeMenu(returnFocus = false) {
    navigation.classList.remove('is-open'); document.body.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded', 'false'); backdrop.hidden = true;
    toggle.setAttribute('aria-label', '開啟主要選單');
    inertBefore.forEach(([node, value]) => { node.inert = value; }); inertBefore = [];
    if (returnFocus) toggle.focus({preventScroll:true});
  }
  function openMenu() {
    positionMenu();
    navigation.classList.add('is-open'); document.body.classList.add('menu-open');
    toggle.setAttribute('aria-expanded', 'true'); backdrop.hidden = false;
    toggle.setAttribute('aria-label', '關閉主要選單');
    inertBefore = background.map(node => [node, node.inert]);
    background.forEach(node => { node.inert = true; });
    const search = navigation.querySelector('.global-search-trigger');
    (search || links.find(link => link.getClientRects().length))?.focus({preventScroll:true});
  }
  toggle.addEventListener('click', () => toggle.getAttribute('aria-expanded') === 'true' ? closeMenu(true) : openMenu());
  backdrop.addEventListener('click', () => closeMenu(true));
  navigation.addEventListener('click', event => { if (event.target.closest('a') || event.target.closest('.global-search-trigger')) closeMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !mobile.matches) {
      const open = groups.find(group => group.open);
      if (open) { open.open = false; open.querySelector('summary').focus({preventScroll:true}); }
    }
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') closeMenu(true);
    if (event.key === 'Tab' && toggle.getAttribute('aria-expanded') === 'true') {
      const search = navigation.querySelector('.global-search-trigger');
      const focusable = [toggle, ...navigation.querySelectorAll('a, button, summary')].filter(node => node.getClientRects().length && !node.disabled); const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus({preventScroll:true}); }
    }
  });
  window.matchMedia('(min-width: 781px)').addEventListener('change', event => { if (event.matches) closeMenu(); });
  window.addEventListener('resize', () => { if (toggle.getAttribute('aria-expanded') === 'true') positionMenu(); });
  document.addEventListener('site:close-menu', () => closeMenu());
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


// Shared digital-civic layer: global search, PWA, view transitions, timeline reveal
// and cross-content exploration. Kept separate so existing page logic stays isolated.
(() => {
  const VERSION = '20260912-p0-v2';
  if (!document.querySelector(`link[data-digital-civic="${VERSION}"]`)) {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = new URL(`digital.css?v=${VERSION}`, HUIWEN_ASSET_BASE).href;
    style.dataset.digitalCivic = VERSION;
    document.head.append(style);
  }
  if (!document.querySelector(`script[data-digital-civic="${VERSION}"]`)) {
    const script = document.createElement('script');
    script.src = new URL('digital.js?v=20260922-public-service-v11', HUIWEN_ASSET_BASE).href;
    script.async = false;
    script.dataset.digitalCivic = VERSION;
    document.body.append(script);
  }
})();

// Mobile navigation owns the global search trigger at phone/tablet widths; this is regression-tested at 390px.
// Desktop keeps search beside the primary navigation; mobile keeps the header to logo + menu only.
(() => {
  const header = document.querySelector('.site-header .nav-wrap');
  const navigation = document.getElementById('navigation');
  const menuToggle = header?.querySelector('.menu-toggle');
  if (!header || !navigation || !menuToggle) return;
  const media = window.matchMedia('(max-width: 780px)');
  const placeSearch = () => {
    const trigger = document.querySelector('.global-search-trigger');
    if (!trigger) return false;
    if (media.matches) {
      if (trigger.parentElement !== navigation) navigation.prepend(trigger);
      trigger.classList.add('global-search-trigger--menu');
    } else {
      if (trigger.parentElement !== header) header.insertBefore(trigger, menuToggle);
      trigger.classList.remove('global-search-trigger--menu');
    }
    return true;
  };
  if (!placeSearch()) {
    const observer = new MutationObserver(() => {
      if (placeSearch()) observer.disconnect();
    });
    observer.observe(header, {childList:true, subtree:true});
  }
  media.addEventListener('change', placeSearch);
})();
