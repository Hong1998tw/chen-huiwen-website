'use strict';
(() => {
  const main = document.querySelector('.home-redesign');
  if (!main) return;
  const month = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'}).format(new Date());
  const legal = main.querySelector('[data-home-legal-month]');
  if (legal && legal.dataset.homeLegalMonth !== month) {
    legal.querySelector('strong').textContent = '律師時間表 ↗';
    legal.querySelector('small').textContent = '查看已公布場次，來電確認預約';
  }
  main.addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button || !main.contains(button)) return;
    const filter = button.dataset.filter;
    main.querySelectorAll('[data-filter]').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
    let count = 0;
    main.querySelectorAll('.place[data-topic]').forEach(node => {
      node.hidden = filter !== 'all' && node.dataset.topic !== filter;
      if (!node.hidden) count++;
    });
    const status = main.querySelector('#filter-status');
    if (status) status.textContent = '本頁精選' + count + '筆，不代表全部案件或完工數。';
  });
})();
