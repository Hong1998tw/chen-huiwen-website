/** Real browser-to-edge smoke. No routing, snapshots, resource blocking or DOM rewriting. */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const base = (process.env.BASE_URL || 'https://www.huiwen.tw/').replace(/\/?$/, '/');
// Match the reviewed checkout, not whichever cached registration happens to be
// active. Keep the version in the same source that registers the site's worker.
const registrationSource = await readFile(new URL('../../digital.js', import.meta.url), 'utf8');
const expectedWorkerVersion = registrationSource.match(/\bconst\s+SERVICE_WORKER_VERSION\s*=\s*(['"])([^'"]+)\1\s*;/)?.[2];
assert(expectedWorkerVersion, 'Cannot read the reviewed service worker version from digital.js');
const expectedWorkerURL = new URL(`sw.js?v=${encodeURIComponent(expectedWorkerVersion)}`, base).href;
const output = new URL('./results/native-edge/', import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  scope: 'Native edge smoke; direct browser, all resources allowed, service workers allowed',
  baseUrl: base, observedAt: new Date().toISOString(), status: 'PASS', checks: [],
  expectedServiceWorker: { scriptURL: expectedWorkerURL, version: expectedWorkerVersion, state: 'activated' },
  limits: ['Chromium automation is not a real iPhone/Safari or assistive-technology audit.',
    'No forms, appointments, messages, payments or calendar events are submitted.'],
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', serviceWorkers: 'allow' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));

function blocked(message) {
  const error = new Error(message);
  error.blocked = true;
  return error;
}

async function navigate(path) {
  let response;
  try {
    response = await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (error) {
    throw blocked(`Direct navigation unavailable (${error.name})`);
  }
  const body = (await page.locator('body').innerText()).slice(0, 1800);
  if ([403, 429, 503].includes(response?.status()) || /Just a moment|Checking your browser|Verify you are human|驗證您是人類/i.test(body)) {
    throw blocked(`Edge challenge or access limit (HTTP ${response?.status() ?? 'unknown'})`);
  }
  assert(response?.ok(), `${path}: HTTP ${response?.status()}`);
  assert.equal(new URL(page.url()).origin, new URL(base).origin, 'navigation left expected origin');
  await page.locator('html.menu-ready').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('main').count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
}

async function check(name, operation) {
  try {
    await operation();
    report.checks.push({ name, status: 'PASS' });
  } catch (error) {
    const status = error.blocked ? 'BLOCKED' : 'FAIL';
    // Playwright request failures append HTTP headers, including session cookies.
    // Keep the actionable reason; never persist the request call log.
    const reason = String(error.message).split(/\r?\nCall log:/, 1)[0];
    report.checks.push({ name, status, reason });
    if (status === 'FAIL' || report.status === 'PASS') report.status = status;
    return false;
  }
  return true;
}

try {
  const accessible = await check('Native mobile home, portrait and navigation', async () => {
    await navigate('');
    const portrait = page.locator('.hero-portrait img').first();
    await portrait.scrollIntoViewIfNeeded();
    await portrait.evaluate(image => image.decode());
    assert(await portrait.evaluate(image => image.complete && image.naturalWidth > 0), 'portrait failed to load');
    const menu = page.locator('.menu-toggle');
    await menu.click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: fileURLToPath(new URL('home-mobile.png', output)), fullPage: false });
  });
  if (accessible) {
    await check('Service facts remain usable through real edge', async () => {
      await navigate('service.html');
      assert.equal(await page.locator('.schedule-phone-cta').getAttribute('href'), 'tel:+88678212536');
      assert((await page.locator('.schedule-text tbody tr').count()) > 0);
      assert((await page.locator('.hours-card').innerText()).includes('09:00'));
    });
    await check('Public data boundary served by the edge', async () => {
      const response = await context.request.get(new URL('data/achievements-public.json', base).href);
      if ([403, 429, 503].includes(response.status())) throw blocked('Public data request blocked by edge');
      assert(response.ok(), `public projection HTTP ${response.status()}`);
      const rows = await response.json();
      assert(Array.isArray(rows) && rows.length > 0, 'empty public projection');
      assert(rows.every(row => row.status !== '待核驗' && !('editorialReview' in row) && !('verification' in row)), 'raw editorial records reached production');
      const legacy = await context.request.get(new URL('data/achievements.json', base).href);
      assert(legacy.ok());
      assert.deepEqual(await legacy.json(), rows, 'legacy public URL is not sanitized');
    });
    await check('Source and governance routes are excluded from public hosting', async () => {
      for (const path of ['docs/CANONICAL-SOURCE.md', 'scripts/build_cases.py', 'data/content-governance.json']) {
        const response = await context.request.get(new URL(path, base).href);
        if ([403, 429, 503].includes(response.status())) throw blocked(`${path}: edge access limit`);
        assert([404, 410].includes(response.status()), `${path}: excluded route returned HTTP ${response.status()}`);
      }
    });
    await check('Native achievements list and interactive data', async () => {
      await navigate('achievements.html');
      await page.waitForFunction(() => Boolean(window.HuiwenCases?.getState), null, { timeout: 12000 });
      assert((await page.locator('[data-case]:visible').count()) > 0);
    });
    await check('Native representative detail and desktop reflow', async () => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await navigate('achievement-metro-green-line.html');
      assert((await page.locator('.case-latest').innerText()).trim().length > 0);
      assert((await page.locator('#case-sources a').count()) > 0);
      await page.screenshot({ path: fileURLToPath(new URL('detail-desktop.png', output)), fullPage: false });
    });
    await check('Native election content loads independently', async () => {
      await navigate('election.html');
      await page.locator('#campaign-platforms .campaign-data-card').first().waitFor({ timeout: 12000 });
      await page.locator('#campaign-tracking .campaign-data-card').first().waitFor({ timeout: 12000 });
    });
    if (new URL(base).protocol === 'https:') {
      await check('Real service worker activation', async () => {
        await navigate('');
        // A fresh registration can take over asynchronously; wait at most 30s
        // for that natural transition without forcing an update or unregistering.
        try {
          await page.waitForFunction(expectedURL => {
            const worker = navigator.serviceWorker?.controller;
            return worker?.state === 'activated' && worker.scriptURL === expectedURL;
          }, expectedWorkerURL, { timeout: 30000 });
        } catch (error) {
          if (error.name !== 'TimeoutError') throw error;
        } finally {
          report.serviceWorker = await page.evaluate(() => {
            const worker = navigator.serviceWorker?.controller;
            return worker ? { scriptURL: worker.scriptURL, state: worker.state } : null;
          });
        }
        assert.equal(report.serviceWorker?.state, 'activated', 'Expected service worker did not activate within 30 seconds');
        assert.equal(report.serviceWorker?.scriptURL, expectedWorkerURL,
          'Active service worker differs from the reviewed checkout after 30 seconds');
      });
    } else {
      report.checks.push({ name: 'Real service worker activation', status: 'NOT_TESTED', reason: 'Local HTTP smoke; production HTTPS required.' });
    }
  }
} finally {
  report.browserErrors = [...new Set(errors)];
  if (report.browserErrors.length && report.status === 'PASS') report.status = 'FAIL';
  await browser.close();
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = report.status === 'PASS' ? 0 : report.status === 'BLOCKED' ? 2 : 1;
