import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('./results/', import.meta.url);
await mkdir(output, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', '8768', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const base = 'http://127.0.0.1:8768/';
const report = { scope: 'Election mode v1 QA', checks: [], failures: [] };
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

  await page.goto(base + 'election.html');
  await check('election hub loads verified countdown and key dates', async () => {
    assert.match(await page.locator('h1').innerText(), /鳳山選舉資訊中心/);
    await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#campaign-countdown')?.textContent || ''));
    assert(Number(await page.locator('#campaign-countdown').innerText()) >= 0);
    assert.match(await page.locator('#campaign-number-draw').innerText(), /2026.*10.*23|10.*23/);
    assert.match(await page.locator('#campaign-vote-date').innerText(), /2026.*11.*28|11.*28/);
    assert.match(await page.locator('#campaign-election-source').innerText(), /高雄市選舉委員會/);
  });
  await check('2026 platform keeps source boundary', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#campaign-platforms .campaign-data-card').length > 0);
    assert((await page.locator('#campaign-platforms .campaign-data-card').count()) >= 4);
    assert.match(await page.locator('#campaign-platform-status').innerText(), /正式選舉公報尚未取得/);
    assert.match(await page.locator('#campaign-platforms').innerText(), /推動寵物友善城市/);
  });
  await check('tracking and public schedule derive from canonical data', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#campaign-tracking .campaign-data-card').length > 0);
    assert((await page.locator('#campaign-tracking .campaign-data-card').count()) > 0);
    await page.waitForFunction(() => document.querySelectorAll('#campaign-events .campaign-event').length > 0);
    assert.match(await page.locator('#campaign-events').innerText(), /官方資訊/);
    assert.match(await page.locator('#campaign-events').innerText(), /Google Calendar/);
  });
  await check('election hub search filters campaign content', async () => {
    await page.locator('#campaign-search').fill('寵物');
    await page.waitForTimeout(30);
    assert((await page.locator('.campaign-searchable:not(.campaign-filter-hidden)').count()) > 0);
    assert.match(await page.locator('.campaign-searchable:not(.campaign-filter-hidden)').first().innerText(), /寵物/);
  });

  await page.goto(base + 'press.html');
  await check('press page exposes public media assets', async () => {
    assert.match(await page.locator('h1').innerText(), /記者與媒體專區/);
    assert((await page.locator('a[download]').count()) >= 3);
    assert.match(await page.locator('main').innerText(), /07-821-2536/);
  });

  await page.goto(base + 'facts.html');
  await check('fact-check page states evidence boundaries', async () => {
    const text = await page.locator('main').innerText();
    assert.match(text, /提出不等於完成/);
    assert.match(text, /政見不當成政績/);
    assert.match(text, /正式選舉公報尚未取得/);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + 'election.html');
  await check('election mode has no 390px horizontal overflow', async () => {
    await page.waitForFunction(() => document.querySelector('#campaign-countdown')?.textContent !== '—');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const menu = page.getByRole('button', { name: '選單', exact: true });
    await menu.click();
    assert(await page.locator('#navigation a[href="election.html"]').isVisible());
  });

  await context.close();
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await writeFile(new URL('election-mode-report.json', output), JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
