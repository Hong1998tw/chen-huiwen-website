import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspaceOut = '/workspace/header-runtime-local.json';
const pages = [
  'index.html',
  'about.html',
  'political-donation.html',
  'election.html',
  'achievements.html',
  'vision.html',
  'news.html',
  'service.html',
  'petition.html',
  'achievement-bade-detention.html',
];
const TOLERANCE = 2;
const PORT = 8777;
const base = `http://127.0.0.1:${PORT}/`;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: root,
  stdio: 'ignore',
});

function approx(a, b, label, failures) {
  if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) {
    failures.push(`${label}: missing metric (${a} vs ${b})`);
    return;
  }
  if (Math.abs(a - b) > TOLERANCE) {
    failures.push(`${label}: ${a} vs ${b} (tol ${TOLERANCE})`);
  }
}

async function measure(page) {
  await page.waitForFunction(() => {
    const header = document.querySelector('.site-header');
    const search = document.querySelector('.global-search-trigger');
    const nav = document.querySelector('#navigation');
    return header && search && nav;
  }, { timeout: 10000 });
  return page.evaluate(() => {
    const header = document.querySelector('.site-header');
    const search = document.querySelector('.global-search-trigger');
    const nav = document.querySelector('#navigation');
    const brand = document.querySelector('.site-header .brand');
    const hb = header.getBoundingClientRect();
    const sb = search.getBoundingClientRect();
    const nb = nav.getBoundingClientRect();
    const bb = brand.getBoundingClientRect();
    return {
      headerHeight: Math.round(hb.height * 100) / 100,
      headerTop: Math.round(hb.top * 100) / 100,
      searchX: Math.round(sb.x * 100) / 100,
      searchY: Math.round(sb.y * 100) / 100,
      navY: Math.round(nb.y * 100) / 100,
      brandBottom: Math.round(bb.bottom * 100) / 100,
      topToNavGap: Math.round((nb.top - bb.bottom) * 100) / 100,
      navCount: nav.querySelectorAll(':scope > a').length,
      searchParent: search.parentElement?.className || search.parentElement?.id || null,
    };
  });
}

const report = {
  scope: 'Header runtime consistency',
  viewport: { width: 1440, height: 960 },
  tolerancePx: TOLERANCE,
  pages: {},
  comparisons: [],
  failures: [],
  ok: false,
};

let browser;
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
  });
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === '127.0.0.1' ? route.continue() : route.abort();
  });

  const page = await context.newPage();
  for (const name of pages) {
    await page.goto(base + name, { waitUntil: 'networkidle' });
    const metrics = await measure(page);
    report.pages[name] = metrics;
    if (metrics.navCount !== 11) {
      report.failures.push(`${name}: expected 11 nav links, got ${metrics.navCount}`);
    }
    if (metrics.headerHeight < 70 || metrics.headerHeight > 120) {
      report.failures.push(`${name}: headerHeight ${metrics.headerHeight} outside 70–120 design band`);
    }
  }

  const baseline = report.pages['index.html'];
  for (const name of pages) {
    if (name === 'index.html') continue;
    const m = report.pages[name];
    const local = [];
    approx(m.headerHeight, baseline.headerHeight, `${name} headerHeight`, local);
    approx(m.searchX, baseline.searchX, `${name} searchX`, local);
    approx(m.searchY, baseline.searchY, `${name} searchY`, local);
    approx(m.navY, baseline.navY, `${name} navY`, local);
    report.comparisons.push({ page: name, vs: 'index.html', failures: local });
    report.failures.push(...local);
  }

  // Mid-width band that previously fought styles.css wrap rules
  await page.setViewportSize({ width: 960, height: 900 });
  const mid = {};
  for (const name of ['index.html', 'about.html', 'political-donation.html']) {
    await page.goto(base + name, { waitUntil: 'networkidle' });
    mid[name] = await measure(page);
  }
  report.midWidth = { viewport: { width: 960, height: 900 }, pages: mid };
  approx(mid['about.html'].headerHeight, mid['index.html'].headerHeight, '960px about headerHeight', report.failures);
  approx(mid['political-donation.html'].headerHeight, mid['index.html'].headerHeight, '960px donation headerHeight', report.failures);
  approx(mid['about.html'].searchY, mid['index.html'].searchY, '960px about searchY', report.failures);
  approx(mid['about.html'].navY, mid['index.html'].navY, '960px about navY', report.failures);

  report.ok = report.failures.length === 0;
  assert.equal(report.failures.length, 0, report.failures.join('\n'));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await writeFile(workspaceOut, JSON.stringify(report, null, 2));
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'header-consistency-last.json'), JSON.stringify(report, null, 2));
}

console.log(JSON.stringify({ ok: report.ok, failures: report.failures.length, out: workspaceOut }, null, 2));
if (!report.ok) process.exit(1);
