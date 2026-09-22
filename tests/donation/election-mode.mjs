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
  const heroStatus = page.locator('.hero-copy > .hero-election-status');
  assert.equal(await heroStatus.count(), 1);
  assert.match(await heroStatus.innerText(), /距離投票日/);
  assert.match(await heroStatus.innerText(), /2026\.11\.28/);
  assert.doesNotMatch(await page.locator('main').innerText(), /10\/23|候選人姓名號次抽籤/);
  assert.equal(await page.locator('.campaign-entry-compact').count(), 0);
  assert.equal(await heroStatus.evaluate(el => el.previousElementSibling?.tagName), 'H1');
  const countdownColor = await heroStatus.locator('strong').evaluate(el => getComputedStyle(el).color);
  assert.equal(countdownColor, 'rgb(213, 249, 124)');
  const account = await page.locator('.home-account').boundingBox();
  const contact = await page.locator('.home-contact').boundingBox();
  assert(account && contact && account.y < contact.y, 'political donation must appear before contact');
  assert(contact.y - (account.y + account.height) <= 12, 'donation and contact should read as one visual cluster');
  const homeFacebook = page.locator('.home-facebook');
  await homeFacebook.scrollIntoViewIfNeeded();
  await homeFacebook.locator('iframe').waitFor({ state: 'attached' });
  assert.equal(await homeFacebook.locator('iframe').count(), 1, 'homepage Facebook should auto-load');
  assert.match(await homeFacebook.locator('iframe').getAttribute('title'), /Facebook/, 'homepage Facebook iframe needs an accessible title');
  assert.equal(await homeFacebook.locator('a[href="https://www.facebook.com/hwcfs/"]').count(), 1, 'homepage Facebook keeps a direct-link fallback');
  assert(await homeFacebook.locator('[data-embed-load]').isVisible(), 'homepage Facebook keeps a reload fallback');
  const homeFrameBox = await homeFacebook.locator('.facebook-frame').boundingBox();
  assert(homeFrameBox && homeFrameBox.x >= 0 && homeFrameBox.x + homeFrameBox.width <= 390, 'homepage Facebook stays inside mobile viewport');

  await page.goto(base + 'about.html');
  const portrait = await page.locator('.about-portrait').boundingBox();
  const profileName = await page.locator('.profile-name').boundingBox();
  assert(portrait && profileName && portrait.width <= 120, 'mobile about portrait must remain compact');
  assert(profileName.x > portrait.x + portrait.width, 'mobile about portrait must sit beside the profile name');

  await page.goto(base + 'news.html');
  const newsFacebook = page.locator('#facebook .facebook-frame');
  await newsFacebook.scrollIntoViewIfNeeded();
  await newsFacebook.locator('iframe').waitFor({ state: 'attached' });
  assert.equal(await newsFacebook.locator('iframe').count(), 1, 'news Facebook should auto-load');
  assert.match(await newsFacebook.locator('iframe').getAttribute('title'), /Facebook/, 'news Facebook iframe needs an accessible title');
  assert.equal(await newsFacebook.locator('a[href="https://www.facebook.com/hwcfs/"]').count(), 1, 'news Facebook keeps a direct-link fallback');
  assert(await newsFacebook.locator('[data-embed-load]').isVisible(), 'news Facebook keeps a reload fallback');

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
  const navYs = await page.locator('#navigation .nav-group > summary').evaluateAll(links => links
    .map(link => link.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0)
    .map(rect => Math.round(rect.y)));
  assert(navYs.length === 5);
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
