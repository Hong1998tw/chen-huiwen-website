import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = (process.env.BASE_URL || 'https://www.huiwen.tw/').replace(/\/?$/, '/');
const baseHost = new URL(base).hostname;
const output = new URL('./results/production-live/', import.meta.url);
await mkdir(output, { recursive: true });

const corePages = [
  'index.html',
  'about.html',
  'election.html',
  'achievements.html',
  'vision.html',
  'news.html',
  'activities.html',
  'service.html',
  'petition.html',
  'political-donation.html',
];

const report = {
  scope: 'Independent Production Live Verification',
  baseUrl: base,
  checks: [],
  failures: [],
};

async function check(name, fn) {
  try {
    await fn();
    report.checks.push({ name, status: 'Passed' });
  } catch (error) {
    report.checks.push({ name, status: 'Failed', error: String(error) });
    report.failures.push(name);
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      deviceScaleFactor: 1,
    });

    // Production itself must load normally. Third-party embeds/resources are
    // deliberately blocked so their availability cannot make the site gate flaky.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (!['http:', 'https:'].includes(url.protocol) || url.hostname === baseHost) {
        return route.continue();
      }
      return route.abort();
    });

    const page = await context.newPage();

    for (const file of corePages) {
      await check(`${file} ${width}px: live page`, async () => {
        const pageErrors = [];
        const failedResponses = [];
        const onPageError = error => pageErrors.push(error.message);
        const onResponse = response => {
          const url = new URL(response.url());
          if (url.hostname === baseHost && response.status() >= 400) {
            failedResponses.push(`${response.status()} ${response.url()}`);
          }
        };
        page.on('pageerror', onPageError);
        page.on('response', onResponse);

        const target = file === 'index.html' ? base : new URL(file, base).href;
        const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
        assert(response && response.ok(), `${file}: navigation failed`);
        assert.equal(await page.locator('html').getAttribute('lang'), 'zh-Hant-TW');
        assert.equal(await page.locator('main').count(), 1, `${file}: main`);
        assert.equal(await page.locator('h1').count(), 1, `${file}: h1`);
        assert(await page.locator('title').count(), `${file}: title`);
        assert(await page.locator('meta[name="description"]').getAttribute('content'), `${file}: description`);

        const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
        assert(canonical, `${file}: canonical`);
        assert.equal(new URL(canonical).hostname, baseHost, `${file}: canonical host`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${file}: overflow`);

        const axe = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        const serious = axe.violations.filter(v => ['serious', 'critical'].includes(v.impact));
        await writeFile(
          new URL(`axe-${file}-${width}.json`, output),
          JSON.stringify(axe.violations, null, 2),
        );
        assert.deepEqual(
          serious.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })),
          [],
          `${file}: axe serious/critical`,
        );
        assert.deepEqual(pageErrors, [], `${file}: page errors`);
        assert.deepEqual(failedResponses, [], `${file}: local HTTP failures`);

        page.off('pageerror', onPageError);
        page.off('response', onResponse);
      });
    }

    await check(`mobile navigation ${width}px`, async () => {
      if (width !== 390) return;
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      const toggle = page.getByRole('button', { name: '選單', exact: true });
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert(await page.locator('#navigation').isVisible());
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    });

    await check(`achievements interaction ${width}px`, async () => {
      await page.goto(new URL('achievements.html', base).href, { waitUntil: 'domcontentloaded' });
      const visibleCases = () => page.locator('[data-case]:visible').count();
      assert((await visibleCases()) > 0, 'no achievement cards');
      const toggle = page.locator('#toggle-map-search');
      await toggle.click();
      assert(await page.locator('#case-search').isVisible(), 'search did not open');
      await page.locator('#case-search').fill('文龍');
      assert((await visibleCases()) > 0, 'search returned no results');
      await page.locator('#reset-map-filters').click();
      assert(await page.locator('.leaflet-container').isVisible(), 'map missing');
      if (await page.locator('.case-pagination').isVisible()) {
        await page.getByRole('button', { name: '第 2 頁' }).click();
        assert.equal(await page.locator('.case-page-button[aria-current="page"]').innerText(), '2');
      }
    });

    await check(`news interaction ${width}px`, async () => {
      await page.goto(new URL('news.html', base).href, { waitUntil: 'domcontentloaded' });
      await page.locator('#unified-news-search').waitFor({ state: 'visible' });
      assert((await page.locator('.news-unified-grid > *').count()) > 0, 'news list empty');
      await page.locator('#news-sort').selectOption('date');
      assert.equal(await page.locator('#news-sort').inputValue(), 'date');
      await page.locator('#unified-news-search').fill('鳳山');
      assert((await page.locator('.news-unified-grid > *').count()) > 0, 'news search empty');
    });

    await check(`service interaction ${width}px`, async () => {
      await page.goto(new URL('service.html', base).href, { waitUntil: 'domcontentloaded' });
      const legal = await page.locator('.legal-section').boundingBox();
      const monthly = await page.locator('.monthly-schedule').boundingBox();
      assert(legal && monthly && legal.y < monthly.y, 'lawyer rules are not before monthly schedule');
      const phone = await page.locator('.schedule-phone-cta').boundingBox();
      assert(phone && phone.height >= 60, 'phone CTA too small');
    });

    if (width === 1440 || width === 390) {
      for (const file of ['index.html', 'election.html', 'achievements.html', 'news.html', 'service.html']) {
        const target = file === 'index.html' ? base : new URL(file, base).href;
        await page.goto(target, { waitUntil: 'domcontentloaded' });
        await page.screenshot({
          path: fileURLToPath(new URL(`${file}-${width}.png`, output)),
          fullPage: true,
        });
      }
    }

    await context.close();
  }
} finally {
  await browser.close();
}

report.status = report.failures.length ? 'Failed' : 'Passed';
await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
