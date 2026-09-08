'use strict';
// Keep the Facebook plugin's requested width consistent with its rendered frame.
(() => {
  const frame = document.querySelector('.home-facebook iframe');
  if (!frame) return;
  let timer;
  const resize = () => {
    const width = Math.min(500, Math.floor(frame.getBoundingClientRect().width));
    if (width < 180) return;
    const url = new URL(frame.src);
    if (url.searchParams.get('width') === String(width)) return;
    url.searchParams.set('width', String(width));
    frame.src = url.href;
  };
  resize();
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(resize, 200); });
})();
