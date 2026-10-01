/* An optional personal reminder is chosen by the visitor, never an event end. */
(() => {
  'use strict';
  const allowedMinutes = new Set(['15', '30', '60']);
  const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  document.querySelectorAll('[data-event-reminder]').forEach(picker => {
    const select = picker.querySelector('.event-reminder-duration');
    const link = picker.querySelector('.event-reminder-link');
    const status = picker.querySelector('.event-reminder-status');
    if (!select || !link || !status) return;
    let event;
    try {
      event = JSON.parse(picker.dataset.eventReminder);
      const page = new URL(event.url);
      if (page.origin !== 'https://www.huiwen.tw' || !/^\/event-[a-z0-9]+(?:-[a-z0-9]+)*\.html$/.test(page.pathname) || page.search || page.hash) return;
      if (typeof event.name !== 'string' || typeof event.content !== 'string' || typeof event.location !== 'string' || typeof event.start !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(event.start) || !Number.isFinite(Date.parse(event.start))) return;
    } catch { return; }
    // Browsers may restore form state on Back; require an explicit choice each visit.
    const reset = () => {
      select.value = '';
      link.hidden = true;
      link.removeAttribute('href');
      status.textContent = '';
    };
    reset();
    window.addEventListener('pageshow', reset);
    select.addEventListener('change', () => {
      link.hidden = true;
      link.removeAttribute('href');
      status.textContent = '';
      if (!allowedMinutes.has(select.value)) return;
      const minutes = Number(select.value);
      const start = new Date(event.start);
      const end = new Date(start.getTime() + minutes * 60000);
      const url = new URL('https://calendar.google.com/calendar/r/eventedit');
      const details = event.content + '\n\n活動結束時間尚未公布。這是您選擇的 ' + minutes + ' 分鐘個人開始提醒，不是活動時長。\n儲存的是當下副本，不會自動更新；出發前請回本站確認。\n' + event.url;
      url.search = new URLSearchParams({action: 'TEMPLATE', text: event.name + '（開始提醒）', dates: stamp(start) + '/' + stamp(end), stz: 'Asia/Taipei', etz: 'Asia/Taipei', details, location: event.location}).toString();
      link.href = url.href;
      link.hidden = false;
      status.textContent = '已選擇 ' + minutes + ' 分鐘個人開始提醒；活動結束時間仍未公布。';
    });
  });
})();
