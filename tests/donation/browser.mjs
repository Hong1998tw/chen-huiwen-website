import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('./results/', import.meta.url);
await mkdir(output, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const base = 'http://127.0.0.1:8765/';
const report = { checks: [], failures: [], externalResources: 'Blocked deliberately; third-party live availability is a separate manual check.' };
let browser;
async function check(name, fn) {
  try { await fn(); report.checks.push({ name, status: 'Passed' }); }
  catch (e) { report.checks.push({ name, status: 'Failed', error: String(e) }); report.failures.push(name); }
}
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true });
  const pages = (await readdir(root)).filter(n => n.endsWith('.html'));
  const items = JSON.parse(await readFile(new URL('../../data/achievements.json', import.meta.url)));
  for (const width of [1440, 1100, 1024, 780, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, deviceScaleFactor: 1 });
    // Exercise usable fallback when embeds and map tile providers are unreachable.
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const localFailures = [];
    page.on('response', r => { if (r.url().startsWith(base) && r.status() >= 400) localFailures.push(r.url()); });
    await page.goto(base + 'political-donation.html');
    await check(`donation ${width}px: no overflow`, async () => {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
    });
    await check(`donation ${width}px: keyboard FAQ and focus`, async () => {
      const summary = page.locator('summary').first();
      await summary.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('details').first().getAttribute('open'), '');
      assert(await summary.evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
      await page.keyboard.press('Enter');
    });
    if (width === 390) await check('mobile menu: Enter, Escape, focus return', async () => {
      const toggle = page.getByRole('button', { name: /選單/ });
      await toggle.focus(); await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert(await page.locator('#navigation a[href="political-donation.html"]').isVisible());
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert(await toggle.evaluate(el => el === document.activeElement));
    });
    await check(`donation ${width}px: axe WCAG2 A/AA`, async () => {
      // Open every FAQ to include hidden content in accessibility coverage.
      for (const summary of await page.locator('summary').all()) await summary.click();
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
      await writeFile(new URL(`axe-${width}.json`, output), JSON.stringify(axe.violations, null, 2));
      assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
    });
    if ([1440,390].includes(width)) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: fileURLToPath(new URL(`donation-${width}.png`, output)), fullPage: true });
      await page.screenshot({ path: fileURLToPath(new URL(`donation-top-${width}.png`, output)) });
      await check(`all pages ${width}px: navigation and layout`, async () => {
        for (const file of pages) {
          await page.goto(base + file);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${file}: overflow`);
          assert.equal(await page.locator('#navigation a[href="political-donation.html"]').count(), 1, file);
          assert.equal(await page.locator('footer a[href="political-donation.html"]').count(), 1, file);
        }
      });
      await check(`homepage CTA ${width}px and back navigation`, async () => {
        await page.goto(base + 'index.html');
        await page.getByRole('link', { name: '查看政治獻金資訊' }).click();
        assert(page.url().endsWith('/political-donation.html'));
        await page.getByRole('link', { name: '先看捐贈須知', exact: true }).click();
        assert(page.url().endsWith('#eligibility'));
        await page.getByRole('link', { name: '查看專戶資訊' }).click();
        assert(page.url().endsWith('#account'));
        await page.getByRole('link', { name: '← 回官網首頁' }).click();
        assert(page.url().endsWith('/index.html'));
        await page.goBack(); assert(page.url().includes('/political-donation.html'));
      });
      await check(`map filters ${width}px against source`, async () => {
        await page.goto(base + 'achievements.html');
        const count = () => page.locator('[data-case]:visible').count();
        assert.equal(await count(), items.length);
        await page.locator('#case-search').fill('文龍');
        assert((await count()) > 0 && (await count()) < items.length);
        await page.locator('#reset-map-filters').click();
        for (const [selector, key] of [['#category-filter','categories'], ['#status-filter','status']]) {
          const value = Array.isArray(items[0][key]) ? items[0][key][0] : items[0][key];
          await page.locator(selector).selectOption(value);
          const expected = items.filter(x => Array.isArray(x[key]) ? x[key].includes(value) : x[key] === value).length;
          assert.equal(await count(), expected);
          await page.locator('#reset-map-filters').click();
        }
        const village = items.find(x => x.villages.length).villages[0];
        await page.locator('#village-filter').selectOption('v:' + village);
        assert.equal(await count(), items.filter(x => x.villages.includes(village)).length);
        await page.locator('#reset-map-filters').click();
        assert.equal(await count(), items.length);
        assert(await page.locator('.leaflet-container').isVisible());
      });
      await check(`local resources and JS exceptions ${width}px`, async () => {
        assert.deepEqual(errors, []); assert.deepEqual(localFailures, []);
      });
    }
    await context.close();
  }
  const nojs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await nojs.newPage();
  await page.goto(base + 'political-donation.html');
  await check('no JavaScript: navigation, FAQ, bank information', async () => {
    assert(await page.locator('#navigation a[href="index.html"]').isVisible());
    await page.locator('summary').first().click();
    assert.equal(await page.locator('details').first().getAttribute('open'), '');
    assert(await page.getByText('752200636579', { exact: true }).isVisible());
    assert.equal(await page.locator('form,input,iframe').count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
  await nojs.close();
} catch (e) { report.failures.push(String(e)); }
finally {
  if (browser) await browser.close();
  server.kill();
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
