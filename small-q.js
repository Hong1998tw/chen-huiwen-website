/* Homepage-only companion; the character appears only after an explicit open. */
(() => {
  'use strict';
  const scriptURL = document.currentScript && document.currentScript.src;
  if (!scriptURL) return;

  const initialize = () => {
    const root = document.getElementById('small-q');
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    const base = new URL('assets/small-q/', scriptURL);
    const styleURL = new URL('small-q.css?v=ab5f76031523', scriptURL);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const durations = {wave: 1800, nod: 1500, happy: 1700, guide: 2400};
    root.innerHTML = '<div class="small-q-panel" id="small-q-panel" role="region" aria-label="小 Q AI 卡通角色" hidden><img class="small-q-figure" id="small-q-figure" width="320" height="320" alt="陳慧文的小 Q AI 卡通形象" decoding="async"><button class="small-q-close" type="button" aria-label="收合小 Q">×</button></div><button class="small-q-toggle" id="small-q-toggle" type="button" aria-expanded="false" aria-controls="small-q-panel" aria-label="展開小 Q 卡通角色"><span aria-hidden="true">Q</span></button>';
    const panel = root.querySelector('#small-q-panel');
    const image = panel.querySelector('img');
    const toggle = root.querySelector('.small-q-toggle');
    const close = root.querySelector('.small-q-close');
    const cached = new Map();
    let ready = false;
    let opened = false;
    let departing = false;
    let pageVisible = !document.hidden;
    let sequence = 0;
    let timer = null;
    let lastAction = -Infinity;
    const played = new Set();
    const idleURL = new URL('idle.webp', base).href;

    function loadPose(key) {
      const url = key === 'idle' ? idleURL : new URL(key + '.webp', base).href;
      if (cached.has(url)) return cached.get(url);
      const promise = new Promise((resolve, reject) => {
        const probe = new Image();
        probe.onload = () => resolve(url);
        probe.onerror = () => reject(new Error('companion image unavailable'));
        probe.src = url;
      });
      cached.set(url, promise);
      promise.catch(() => cached.delete(url));
      return promise;
    }

    function idle() {
      sequence += 1;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      root.dataset.action = 'idle';
      if (ready && opened && pageVisible && !departing) image.src = idleURL;
    }

    async function play(key, once = false) {
      if (!ready || !opened || departing || !pageVisible || document.hidden || reduced.matches ||
          !durations[key] || (once && played.has(key)) || performance.now() - lastAction < 12000) return false;
      lastAction = performance.now();
      if (once) played.add(key);
      const ticket = ++sequence;
      try {
        const url = await loadPose(key);
        if (ticket !== sequence || !opened || departing || !pageVisible || document.hidden || reduced.matches) return false;
        image.src = url;
        root.dataset.action = key;
        timer = window.setTimeout(idle, durations[key]);
        return true;
      } catch {
        if (ticket === sequence) idle();
        return false;
      }
    }

    async function openPanel() {
      if (opened || departing) return;
      toggle.setAttribute('aria-busy', 'true');
      try {
        const url = await loadPose('idle');
        if (departing || !root.isConnected) return;
        image.src = url;
        ready = true;
        opened = true;
        panel.hidden = false;
        root.dataset.expanded = 'true';
        toggle.setAttribute('aria-expanded', 'true');
        toggle.setAttribute('aria-label', '收合小 Q 卡通角色');
        toggle.removeAttribute('aria-busy');
        if (reduced.matches) idle();
        else play('wave', true);
      } catch {
        toggle.removeAttribute('aria-busy');
        root.dataset.imageError = 'true';
      }
    }

    function closePanel(returnFocus = true) {
      if (!opened) return;
      opened = false;
      panel.hidden = true;
      root.dataset.expanded = 'false';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', '展開小 Q 卡通角色');
      idle();
      if (returnFocus) toggle.focus();
    }

    toggle.addEventListener('click', () => opened ? closePanel(false) : openPanel());
    close.addEventListener('click', () => closePanel(true));
    document.addEventListener('keydown', event => {
      const anotherLayerOwnsEscape = document.querySelector('.menu-toggle[aria-expanded="true"], dialog[open]');
      if (event.key === 'Escape' && opened && root.contains(document.activeElement) && !anotherLayerOwnsEscape) closePanel(true);
    });
    document.addEventListener('visibilitychange', () => {
      pageVisible = !document.hidden;
      if (!pageVisible) idle();
    });
    const syncMotion = () => {
      root.dataset.reduced = String(reduced.matches);
      if (reduced.matches) idle();
    };
    if (reduced.addEventListener) reduced.addEventListener('change', syncMotion);
    else reduced.addListener(syncMotion);
    window.addEventListener('pagehide', () => { departing = true; idle(); });
    window.addEventListener('pageshow', () => { departing = false; pageVisible = !document.hidden; });

    if ('IntersectionObserver' in window) {
      const contextual = new IntersectionObserver(entries => {
        if (!opened) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target.id === 'progress') play('guide', true);
          if (entry.target.id === 'contact') play('happy', true);
        }
      }, {threshold: 0.3});
      for (const id of ['progress', 'contact']) {
        const target = document.getElementById(id);
        if (target) contextual.observe(target);
      }
    }
    document.getElementById('home-village')?.addEventListener('change', () => play('nod'));

    const addStyles = () => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = styleURL.href;
      link.onload = () => { root.hidden = false; };
      link.onerror = () => { root.hidden = true; };
      document.head.append(link);
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(addStyles, {timeout: 1200});
    else window.setTimeout(addStyles, 100);
  };

  const begin = () => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(initialize, {timeout: 1200});
    else window.setTimeout(initialize, 100);
  };
  if (document.readyState === 'complete') begin();
  else window.addEventListener('load', begin, {once: true});
})();
