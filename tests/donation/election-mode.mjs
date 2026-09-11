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
      try {
        if ((await fetch(base)).ok) { ready = true; break; }
      } catch {}
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
  assert.equal(await page.locator('.campaign-quick-grid').count(), 0);
  const countdownColor = await page.locator('.campaign-entry-compact .campaign-kicker').evaluate(el => getComputedStyle(el).color);
  assert.match(countdownColor, /255/);
  const account = await page.locator('.home-account').boundingBox();
  const contact = await page.locator('.home-contact').boundingBox();
  assert(account && contact && account.y < contact.y, 'political donation must appear before contact');

  await page.goto(base + 'election.html');
  assert(await page.getByRole('heading', { name: '2026 鳳山選戰', exact: true }).isVisible());
  assert.equal(await page.locator('.campaign-nav-grid').count(), 0);
  assert.equal(await page.locator('#campaign-platforms,#campaign-tracking,#campaign-events').count(), 0);
  assert.equal(await page.locator('.campaign-page-links').count(), 0);
  assert(await page.getByRole('link', { name: /高雄市選舉委員會選務時程/ }).isVisible());

  await page.goto(base + 'activities.html');
  assert(await page.getByRole('heading', { name: '公開行程與活動', exact: true }).isVisible());
  console.log('Election compact public mode QA passed');
} finally {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
}
