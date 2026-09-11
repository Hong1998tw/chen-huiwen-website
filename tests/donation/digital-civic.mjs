import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('./results/', import.meta.url);
await mkdir(output, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', '8766', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const base = 'http://127.0.0.1:8766/';
const report = { scope: 'Digital civic feature QA', checks: [], failures: [] };
let browser;

async function check(name, fn) {
  try { await fn(); report.checks.push({ name, status: 'Passed' }); }
  catch (error) { report.checks.push({ name, status: 'Failed', error: String(error) }); report.failures.push(name); }
}

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage();
  const items = JSON.parse(await readFile(new URL('../../data/achievements.json', import.meta.url)));

  await page.goto(base + 'index.html');
  await check('global search opens with Ctrl+K and finds achievement', async () => {
    const trigger = page.getByRole('button', { name: '搜尋陳慧文官網' });
    assert.equal(await trigger.count(), 1);
    await page.keyboard.press('Control+k');
    const dialog = page.locator('#global-search-dialog');
    await dialog.waitFor({ state: 'visible' });
    const input = dialog.getByRole('searchbox', { name: '搜尋陳慧文官網' });
    await input.fill('文德國小');
    const result = dialog.locator('a[href="achievement-wende-school-center.html"]');
    await result.waitFor({ state: 'visible' });
    assert.match(await result.textContent(), /文德國小活動中心/);
    await input.fill('寵物');
    const petResult = dialog.locator('a[href="achievement-consumer-dudu.html"]');
    await petResult.waitFor({ state: 'visible' });
    assert.match(await petResult.textContent(), /毛動力嘟嘟車消費爭議協助/);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + 'index.html');
  await check('mobile header keeps search inside the opened menu', async () => {
    await page.waitForFunction(() => document.querySelector('.global-search-trigger'));
    const trigger = page.locator('.global-search-trigger');
    assert.equal(await trigger.evaluate(el => el.parentElement?.id), 'navigation');
    assert.equal(await trigger.isVisible(), false);
    const menu = page.locator('.menu-toggle');
    await menu.click();
    await trigger.waitFor({ state: 'visible' });
    assert.equal(await trigger.evaluate(el => el.parentElement?.id), 'navigation');
    const menuBox = await menu.boundingBox();
    const searchBox = await trigger.boundingBox();
    assert(menuBox && searchBox);
    assert(searchBox.y > menuBox.y + menuBox.height);
    await trigger.click();
    await page.locator('#global-search-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#navigation').evaluate(el => el.classList.contains('is-open')), false);
    await page.keyboard.press('Escape');
  });
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.goto(base + 'achievements.html');
  await check('achievement dashboard derives from source data', async () => {
    const dashboard = page.locator('.digital-dashboard');
    await dashboard.waitFor({ state: 'visible' });
    assert.equal(await dashboard.locator('.digital-stat').count(), 4);
    assert.equal(Number(await dashboard.locator('.digital-stat strong').first().textContent()), items.length);
    await page.locator('.map-insight-panel').waitFor({ state: 'visible' });
  });
  await check('achievement live search and ten-item pagination remain functional', async () => {
    await page.locator('#case-search').fill('文德國小');
    await page.waitForFunction(() => document.querySelector('#case-count')?.textContent.includes('共 1 個專題'));
    assert.equal(await page.locator('#case-list .case-card:not([hidden])').count(), 1);
    await page.locator('#case-search').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#case-list .case-card:not([hidden])').length === 10);
  });

  await check('achievement subcategory filter supports pet cases', async () => {
    const select = page.locator('#subcategory-filter');
    assert.equal(await select.count(), 1);
    assert((await select.locator('option').allTextContents()).includes('寵物'));
    await select.selectOption({ label: '寵物' });
    await page.waitForFunction(() => document.querySelector('#case-count')?.textContent.includes('共 1 個專題'));
    const visible = page.locator('#case-list .case-card:not([hidden])');
    assert.equal(await visible.count(), 1);
    assert.match(await visible.first().textContent(), /毛動力嘟嘟車消費爭議協助/);
    assert((await visible.first().boundingBox()).height < 360);
    await page.locator('#reset-map-filters').click();
  });

  await page.goto(base + 'explore.html?type=village&value=' + encodeURIComponent('文德里'));
  await check('village exploration loads matching achievements', async () => {
    await page.waitForFunction(() => document.querySelector('#explore-title')?.textContent.includes('文德里'));
    const result = page.locator('#explore-achievements a[href="achievement-wende-school-center.html"]');
    await result.waitFor({ state: 'visible' });
  });

  await page.goto(base + 'explore.html?type=topic&value=' + encodeURIComponent('教育與文化'));
  await check('topic exploration and cross-content relationship disclaimer', async () => {
    await page.waitForFunction(() => document.querySelector('#explore-title')?.textContent.includes('教育與文化'));
    assert((await page.locator('#explore-achievements .explore-result-card').count()) > 0);
    await page.locator('#explore-related').waitFor({ state: 'visible' });
    assert.match(await page.locator('#explore-related').textContent(), /僅供閱讀導覽/);
  });

  await page.goto(base + 'achievement-wende-school-center.html');
  await check('achievement public copy uses council action and city response', async () => {
    const mainText = await page.locator('main').innerText();
    assert.match(mainText, /陳慧文議員於2025年5月14日市政總質詢/);
    assert.match(mainText, /教育局回應/);
    assert(!/這件事，為什麼重要？|STEP BY STEP|官方公開紀錄/.test(mainText));
    assert.match(mainText, /重點說明/);
    assert.match(mainText, /重要進度/);
    assert.match(mainText, /資料來源/);
  });
  await check('achievement timeline progressive reveal and related exploration', async () => {
    const timeline = page.locator('.case-timeline > li');
    assert((await timeline.count()) > 0);
    await timeline.first().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.case-timeline > li')?.classList.contains('is-visible'));
    assert.equal(await page.locator('.cross-content-explore').count(), 1);
  });
  await check('achievement OG remains content-specific', async () => {
    assert.match(await page.locator('meta[property="og:title"]').getAttribute('content'), /文德國小活動中心/);
    assert.match(await page.locator('meta[property="og:url"]').getAttribute('content'), /achievement-wende-school-center\.html$/);
    assert.match(await page.locator('meta[property="og:image"]').getAttribute('content'), /^https:\/\/www\.huiwen\.tw\/assets\//);
  });

  await check('PWA manifest and service worker assets are valid', async () => {
    const manifestResponse = await fetch(base + 'manifest.webmanifest');
    assert.equal(manifestResponse.ok, true);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.short_name, '陳慧文官網');
    assert.equal(manifest.display, 'standalone');
    const swResponse = await fetch(base + 'sw.js');
    assert.equal(swResponse.ok, true);
    const sw = await swResponse.text();
    assert.match(sw, /networkFirst/);
    assert.match(sw, /staleWhileRevalidate/);
  });

  await check('view transition enhancement is present', async () => {
    const cssResponse = await fetch(base + 'digital.css');
    assert.equal(cssResponse.ok, true);
    assert.match(await cssResponse.text(), /@view-transition\s*\{\s*navigation:\s*auto/);
  });

  await context.close();
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await writeFile(new URL('digital-civic-report.json', output), JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
