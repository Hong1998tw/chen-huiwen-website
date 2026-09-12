import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const externalBase = process.env.BASE_URL;
const server = externalBase ? null : spawn('python3', ['-m', 'http.server', '8767', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const base = externalBase || 'http://127.0.0.1:8767/';
let browser;

try {
  if (server) {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'election QA local server did not become ready');
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  await page.goto(base + 'index.html');
  assert(await page.getByRole('heading', { name: '2026 鳳山選戰', exact: true }).isVisible());
  assert.match(await page.locator('.campaign-entry-compact').innerText(), /勝選倒數/);
  assert.match(await page.locator('.campaign-entry-compact').innerText(), /10\/23/);
  assert.match(await page.locator('.campaign-entry-compact').innerText(), /11\/28/);
  assert.equal(await page.locator('.campaign-entry-compact .campaign-nav-grid').count(), 0);
  const countdownColor = await page.locator('.campaign-entry-compact .campaign-kicker').evaluate(el => getComputedStyle(el).color);
  assert.match(countdownColor, /255/);
  const account = await page.locator('.home-account').boundingBox();
  const contact = await page.locator('.home-contact').boundingBox();
  assert(account && contact && account.y < contact.y, 'political donation must appear before contact');
  assert(contact.y - (account.y + account.height) <= 12, 'donation and contact should read as one visual cluster');

  await page.goto(base + 'election.html');
  assert(await page.getByRole('heading', { name: '鳳山選舉資訊中心', exact: true }).isVisible());
  assert.equal(await page.locator('.campaign-nav-card').count(), 5);
  assert.equal(await page.locator('#campaign-platforms').count(), 1);
  assert.equal(await page.locator('#campaign-tracking').count(), 1);
  assert.equal(await page.locator('#campaign-events').count(), 1);
  await page.locator('#campaign-platforms .campaign-data-card').first().waitFor({ state: 'visible' });
  await page.locator('#campaign-tracking .campaign-data-card').first().waitFor({ state: 'visible' });
  assert(await page.getByRole('link', { name: /高雄市選舉委員會選務時程/ }).isVisible());
  const publicText = await page.locator('main').innerText();
  assert(!/待核驗|資料核驗狀態|資料查核|來源邊界|不混為完成|正式選舉公報尚未取得|不等於市府已承諾完成|已依提供圖卡轉錄|依本站已收到並核對/.test(publicText));
  await page.locator('#campaign-search').fill('寵物');
  await page.waitForFunction(() => [...document.querySelectorAll('.campaign-searchable')].some(el => !el.classList.contains('campaign-filter-hidden')));

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(base + 'index.html');
  await page.waitForFunction(() => document.querySelector('.global-search-trigger'));
  const navYs = await page.locator('#navigation > a').evaluateAll(links => links
    .map(link => link.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0)
    .map(rect => Math.round(rect.y)));
  assert(navYs.length >= 10);
  assert(Math.max(...navYs) - Math.min(...navYs) <= 4, `desktop navigation wrapped: ${navYs.join(',')}`);
  const desktopAccount = await page.locator('.home-account').boundingBox();
  const desktopContact = await page.locator('.home-contact').boundingBox();
  assert(desktopAccount && desktopContact && desktopAccount.y < desktopContact.y);
  assert(desktopContact.y - (desktopAccount.y + desktopAccount.height) <= 14);

  await page.goto(base + 'activities.html');
  assert(await page.getByRole('heading', { name: '公開行程與活動', exact: true }).isVisible());
  console.log('Election full-detail and compact-home QA passed');
} finally {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
}
