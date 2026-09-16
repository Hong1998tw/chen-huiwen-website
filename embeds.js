'use strict';
(() => {
  const origins = { facebook: 'https://www.facebook.com', canva: 'https://www.canva.com' };

  const innerWidth = element => {
    const style = getComputedStyle(element);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    return Math.max(180, Math.floor(element.clientWidth - padding));
  };

  document.querySelectorAll('[data-embed-provider]').forEach(container => {
    const provider = container.dataset.embedProvider;
    const button = container.querySelector('[data-embed-load]');
    const template = container.querySelector('template');
    const slot = container.querySelector('.embed-slot');
    const status = container.querySelector('[data-embed-status]');
    if (!origins[provider] || !template || !slot || !status) return;

    if (button) {
      button.hidden = false;
      button.textContent = '重新載入';
    }

    let timer;
    const load = () => {
      const frame = template.content.querySelector('iframe')?.cloneNode(true);
      if (!frame) return;
      const url = new URL(frame.src, document.baseURI);
      if (url.protocol !== 'https:' || url.origin !== origins[provider]) return;

      if (provider === 'facebook') {
        const width = Math.min(500, innerWidth(container));
        url.searchParams.set('width', String(width));
        frame.setAttribute('width', String(width));
      }

      clearTimeout(timer);
      frame.src = url.href;
      frame.loading = 'eager';
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      status.textContent = '正在載入外部內容…';

      frame.addEventListener('load', () => {
        clearTimeout(timer);
        status.textContent = '';
      }, { once: true });
      frame.addEventListener('error', () => {
        clearTimeout(timer);
        status.textContent = '外部內容載入失敗，可重新載入或使用原站連結。';
      }, { once: true });

      slot.replaceChildren(frame);
      container.dataset.loaded = 'true';
      timer = setTimeout(() => {
        status.textContent = '若內容未顯示，可重新載入或使用原站連結。';
      }, 12000);
    };

    button?.addEventListener('click', load);

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      }, { rootMargin: '120px 0px' });
      observer.observe(container);
    } else {
      load();
    }
  });
})();
