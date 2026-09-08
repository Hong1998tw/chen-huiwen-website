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
