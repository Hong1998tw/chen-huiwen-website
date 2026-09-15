import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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
  'press.html',
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
  edgeRetries: [],
  edgeNormalization: 'Cloudflare browser envelope only; all site-owned bytes are live Production',
};

async function check(name, fn) {
  console.log(`[live-check:start] ${name}`);
  try {
    await fn();
    report.checks.push({ name, status: 'Passed' });
    console.log(`[live-check:pass] ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'Failed', error: String(error) });
    report.failures.push(name);
    console.error(`[live-check:fail] ${name}: ${String(error)}`);
  }
}

async function gotoLive(page, target) {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response = null;
    try {
      response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      attempts.push({ attempt, status: response?.status() ?? null, url: response?.url() || page.url() });
    } catch (error) {
      attempts.push({ attempt, status: null, url: page.url(), error: error.name });
    }

    try {
      // Cloudflare can first return a challenge response to hosted runners, then
      // restore the requested page. The real pass condition is the canonical
      // site runtime becoming ready, not the first navigation status alone.
      await page.locator('html.menu-ready').waitFor({ state: 'attached', timeout: 8000 });
      assert.equal(new URL(page.url()).hostname, baseHost, 'live runtime left the production host');
      if (attempt > 1 || !response?.ok()) {
        report.edgeRetries.push({ target, attempts: [...attempts] });
      }
      return;
    } catch (error) {
      attempts[attempts.length - 1].runtimeError = error.name;
      const diagnostic = await page.evaluate(() => ({
        title: document.title,
        h1: document.querySelector('h1')?.textContent?.trim() || null,
        lang: document.documentElement.lang || null,
        menuReady: document.documentElement.classList.contains('menu-ready'),
        scripts: [...document.scripts].slice(0, 16).map(script => ({
          src: script.src || null, type: script.type || null, defer: script.defer,
        })),
        bodyPrefix: document.body?.innerText?.slice(0, 220) || null,
      })).catch(evalError => ({ diagnosticError: String(evalError) }));
      console.error(`[live-runtime-miss] ${new URL(target).pathname || '/'} ${JSON.stringify(diagnostic)}`);
      if (attempt < 2) await page.waitForTimeout(attempt * 1000);
    }
  }
  const detail = attempts.map(item => `${item.attempt}:${item.status ?? 'ERR'} ${item.url}`).join(' | ');
  throw new Error(`${new URL(target).pathname || '/'}: live runtime unavailable after retries (${detail})`);
}

const proxyPort = Number(process.env.LIVE_PROXY_PORT || 8799);
const proxyBase = `http://127.0.0.1:${proxyPort}`;
const proxy = spawn('python3', [
  fileURLToPath(new URL('./live_production_proxy.py', import.meta.url)),
  '--host', baseHost, '--port', String(proxyPort),
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function waitForProxy() {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${proxyBase}/healthz`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError || new Error('live production proxy did not start');
}
await waitForProxy();

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      deviceScaleFactor: 1,
      locale: 'zh-TW',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' },
    });

    // Keep the browser on the canonical Production URL, while same-origin bytes
    // are fetched by an independent APIRequestContext using the same stable verifier
    // identity as verify_production.py. GitHub-hosted Chromium can trigger Cloudflare
    // bot challenges based on browser automation/IP heuristics; this transport still
    // fetches the live Production edge response, then Chromium renders/interacts with
    // those bytes. Checkout files are never used as a browser response source.
    await context.route('**/*', async route => {
      const browserRequest = route.request();
      const url = new URL(browserRequest.url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
      if (url.hostname !== baseHost) return route.abort();

      if (!['GET', 'HEAD'].includes(browserRequest.method())) return route.abort('blockedbyclient');
      try {
        const response = await fetch(`${proxyBase}/fetch?url=${encodeURIComponent(browserRequest.url())}`, {
          method: browserRequest.method(),
        });
        const body = browserRequest.method() === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
        const headers = Object.fromEntries(response.headers.entries());
        delete headers['content-length'];
        delete headers['x-huiwen-live-proxy'];
        delete headers['x-huiwen-edge-normalized'];
        return route.fulfill({ status: response.status, headers, body });
      } catch {
        return route.abort('failed');
      }
    });

    const page = await context.newPage();
    page.on('pageerror', error => console.error(`[live-pageerror] ${error.message}`));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.hostname === baseHost && (response.status() >= 400 || /site\.js|news\.js|press\.js/.test(url.pathname))) {
        console.log(`[live-response] ${response.status()} ${url.pathname}`);
      }
    });
    console.log(`[live-preflight:start] ${width}px ${base}`);
    await gotoLive(page, base);
    console.log(`[live-preflight:pass] ${width}px ${base}`);

    for (const file of corePages) {
      await check(`${file} ${width}px: live page`, async () => {
        const pageErrors = [];
        const failedResponses = [];
        const onPageError = error => pageErrors.push(error.message);
        const onResponse = response => {
          const url = new URL(response.url());
          const isEdgeControl = url.pathname.startsWith('/cdn-cgi/');
          const isNavigation = response.request().isNavigationRequest();
          if (url.hostname === baseHost && response.status() >= 400 && !isNavigation && !isEdgeControl) {
            failedResponses.push(`${response.status()} ${response.url()}`);
          }
        };
        page.on('pageerror', onPageError);
        page.on('response', onResponse);

        const target = file === 'index.html' ? base : new URL(file, base).href;
        await gotoLive(page, target);
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
      await gotoLive(page, base);
      const toggle = page.locator('.menu-toggle');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert(await page.locator('#navigation').isVisible());
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    });

    await check(`achievements interaction ${width}px`, async () => {
      await gotoLive(page, new URL('achievements.html', base).href);
      await page.waitForFunction(() => Boolean(window.HuiwenCases?.getState));
      const visibleCases = () => page.locator('[data-case]:visible').count();
      assert((await visibleCases()) > 0, 'no achievement cards');
      const search = page.locator('#case-search');
      assert(await search.isVisible(), 'achievement search missing');
      await search.fill('文龍');
      await page.waitForFunction(() => !document.querySelector('#case-count')?.textContent?.includes('54 個專題'));
      assert((await visibleCases()) > 0, 'search returned no results');
      await page.locator('#reset-map-filters').click();
      await page.locator('.leaflet-container').waitFor({ state: 'visible' });
      if (await page.locator('.case-pagination').isVisible()) {
        await page.getByRole('button', { name: '第 2 頁' }).click();
        assert.equal(await page.locator('.case-page-button[aria-current="page"]').innerText(), '2');
      }
    });

    await check(`news interaction ${width}px`, async () => {
      await gotoLive(page, new URL('news.html', base).href);
      await page.locator('#news-search').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('.news-media-grid > *').length === 10);
      await page.locator('#news-sort').selectOption('date');
      assert.equal(await page.locator('#news-sort').inputValue(), 'date');
      await page.locator('[data-filter-menu="topic"] summary').click();
      await page.locator('[data-filter-menu="topic"] input[value="education"]').check();
      await page.locator('[data-filter-menu="topic"] input[value="transport"]').check();
      await page.locator('[data-filter-menu="tag"] summary').click();
      await page.locator('[data-filter-menu="tag"] input[value="鳳山車站"]').check();
      assert((await page.locator('.news-media-grid > *').count()) > 0, 'news multi-select returned no results');
      await page.locator('[data-filter-clear]').click();
      await page.locator('#news-search').fill('鳳山');
      assert((await page.locator('.news-media-grid > *').count()) > 0, 'news search empty');
      assert.equal(await page.locator('.news-press-card').count(), 0, 'press cards leaked into news');
    });

    await check(`press release interaction ${width}px`, async () => {
      await gotoLive(page, new URL('press.html', base).href);
      await page.locator('#press-search').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('.news-press-grid > *').length === 10);
      await page.locator('#press-sort').selectOption('date');
      assert.equal(await page.locator('#press-sort').inputValue(), 'date');
      await page.locator('[data-filter-menu="topic"] summary').click();
      await page.locator('[data-filter-menu="topic"] input[value="education"]').check();
      await page.locator('[data-filter-menu="topic"] input[value="livelihood"]').check();
      await page.locator('[data-filter-menu="tag"] summary').click();
      await page.locator('[data-filter-menu="tag"] input[value="特教"]').check();
      await page.locator('[data-filter-menu="tag"] input[value="毛動力"]').check();
      assert((await page.locator('.news-press-grid > *').count()) > 0, 'press multi-select returned no results');
      await page.locator('[data-filter-clear]').click();
      await page.locator('#press-search').fill('特教');
      assert((await page.locator('.news-press-grid > *').count()) > 0, 'press search empty');
    });

    await check(`service interaction ${width}px`, async () => {
      await gotoLive(page, new URL('service.html', base).href);
      const legal = await page.locator('.legal-section').boundingBox();
      const monthly = await page.locator('.monthly-schedule').boundingBox();
      assert(legal && monthly && legal.y < monthly.y, 'lawyer rules are not before monthly schedule');
      const phone = await page.locator('.schedule-phone-cta').boundingBox();
      assert(phone && phone.height >= 60, 'phone CTA too small');
    });

    if (width === 1440 || width === 390) {
      for (const file of ['index.html', 'election.html', 'achievements.html', 'news.html', 'press.html', 'service.html']) {
        const target = file === 'index.html' ? base : new URL(file, base).href;
        await gotoLive(page, target);
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
  proxy.kill('SIGTERM');
}

report.status = report.failures.length ? 'Failed' : 'Passed';
await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
