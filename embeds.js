'use strict';
// Opt-in preserves remote content without loading third parties on every visit.
(() => {
  const origins = { facebook: 'https://www.facebook.com', canva: 'https://www.canva.com' };
  const legacyFacebook = document.querySelector('#facebook .facebook-frame:has(#load-facebook)');
  if (legacyFacebook) {
    legacyFacebook.dataset.embedProvider = 'facebook';
    legacyFacebook.classList.add('external-embed');
    const button = legacyFacebook.querySelector('#load-facebook');
    const template = legacyFacebook.querySelector('#facebook-template');
    const slot = legacyFacebook.querySelector('#facebook-content');
    if (button) button.dataset.embedLoad = '';
    if (slot) slot.classList.add('embed-slot');
    if (template && !legacyFacebook.querySelector('[data-embed-status]')) {
      const status = document.createElement('p');
      status.dataset.embedStatus = '';
      status.setAttribute('role','status');
      slot?.after(status);
    }
  }
  document.querySelectorAll('[data-embed-provider]').forEach(container => {
    const button = container.querySelector('[data-embed-load]');
    const template = container.querySelector('template');
    const slot = container.querySelector('.embed-slot');
    const status = container.querySelector('[data-embed-status]');
    if (!button || !template || !slot || !status) return;
    button.hidden = false;
    let timer;
    button.addEventListener('click', () => {
      const frame = template.content.querySelector('iframe')?.cloneNode(true);
      if (!frame) return;
      const url = new URL(frame.src, document.baseURI);
      if (url.protocol !== 'https:' || url.origin !== origins[container.dataset.embedProvider]) return;
      if (container.dataset.embedProvider === 'facebook') {
        url.searchParams.set('width', String(Math.max(180, Math.min(500, Math.floor(container.clientWidth)))));
      }
      clearTimeout(timer);
      frame.src = url.href;
      frame.loading = 'eager';
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      status.textContent = '正在連線至外部服務；也可使用原站連結閱讀。';
      frame.addEventListener('load', () => {
        clearTimeout(timer);
        status.textContent = '若內容未顯示，請使用原站連結，或重新載入。';
      }, {once:true});
      slot.replaceChildren(frame);
      container.dataset.loaded = 'true';
      button.textContent = '重新載入';
      timer = setTimeout(() => {
        status.textContent = '外部服務回應較慢，請使用原站連結，或重新載入。';
      }, 10000);
    });
  });
})();
