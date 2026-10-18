'use strict';
(() => {
  const main = document.querySelector('.home-redesign');
  if (!main) return;
  const month = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'}).format(new Date());
  const legal = main.querySelector('[data-home-legal-month]');
  if (legal && legal.dataset.homeLegalMonth !== month) {
    legal.textContent = '查看公益律師時間表 →';
  }
})();
