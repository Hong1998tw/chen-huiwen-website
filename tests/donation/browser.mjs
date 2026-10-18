import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AXE_CORE_VERSION,
  AXE_PLAYWRIGHT_VERSION,
  collectTargetSizeDiagnostics,
  evaluateTargetSizeGate,
  FULL_SITE_TARGET_SIZE_SCOPE,
  nonTargetAxeViolations,
  readTargetSizeBaseline,
  resolveTargetSizeMode,
  targetSizeGateMessage,
} from './wcag22aa.mjs';
import { assertWithHomeDiagnostics } from './homepage-diagnostics.mjs';
import { assertNoHorizontalOverflow, captureLayoutDiagnostics, findVisibleClickPoint } from './layout-diagnostics.mjs';
import { openCaseFilterDialog, closeCaseFilterDialog } from './achievement-filter-dialog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('./results/', import.meta.url);
const targetSizeMode = resolveTargetSizeMode(process.env.WCAG22AA_TARGET_SIZE_MODE);
await mkdir(output, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const base = 'http://127.0.0.1:8765/';
const report = { scope: 'Full-site candidate QA', checks: [], failures: [], diagnostics: [], interactions: [], externalResources: 'Blocked deliberately; third-party live availability is a separate manual check.' };
const targetSizeBaseline = await readTargetSizeBaseline();
const targetSizeEntries = [];
let browser;
let diagnosticPage;

async function check(name, fn) {
  try {
    const value = await fn();
    if (value?.__checkStatus === 'Pending') {
      report.checks.push({ name, status: 'Pending', value: value.value });
      return;
    }
    report.checks.push({ name, status: 'Passed', ...(value === undefined ? {} : { value }) });
  } catch (error) {
    report.checks.push({ name, status: 'Failed', error: String(error) });
    report.failures.push(name);
    if (diagnosticPage && /horizontal overflow|navigation, layout|G06 mobile header|mobile menu|no JavaScript|CLS/i.test(name) && !String(error).includes('horizontal overflow')) {
      try {
        const evidence = await captureLayoutDiagnostics(diagnosticPage,{directory:new URL('./results/diagnostics/',import.meta.url),label:name,error});
        report.diagnostics.push(evidence.files);
      } catch (diagnosticError) {
        report.diagnostics.push({label:name,error:String(diagnosticError)});
      }
    }
  }
}

async function assertWithinHalfPixel(page, label, actual, expected) {
  if (Math.abs(actual - expected) > 0.5) {
    await captureLayoutDiagnostics(page,{directory:new URL('./results/diagnostics/',import.meta.url),label,error:`${label}: ${actual}px differs from ${expected}px`});
  }
  assert(Math.abs(actual - expected) <= 0.5, `${label}: ${actual}px differs from ${expected}px by more than 0.5px`);
}

async function captureOpenMenuHeaderTransition(page, { label, targetScrollY, compact }) {
  const evidence = await page.evaluate(async ({ label, targetScrollY, compact }) => {
    const header = document.querySelector('.site-header');
    const navigation = document.querySelector('#navigation');
    const toggle = document.querySelector('.menu-toggle');
    const round = value => Math.round(value * 10) / 10;
    const activeElement = () => {
      const element = document.activeElement;
      return element ? {
        tagName: element.tagName,
        id: element.id || null,
        className: typeof element.className === 'string' ? element.className : null,
        href: element.getAttribute?.('href') ?? null,
        text: (element.textContent || '').trim().slice(0, 64),
      } : null;
    };
    if (!header || !navigation || !toggle) {
      return { label, supported: false, unsupportedReason: 'Required header, navigation, or menu toggle selector is missing.' };
    }

    const media = {
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      noPreference: matchMedia('(prefers-reduced-motion: no-preference)').matches,
    };
    const initialStyle = getComputedStyle(header);
    const properties = initialStyle.transitionProperty.split(',').map(value => value.trim());
    const durations = initialStyle.transitionDuration.split(',').map(value => value.trim());
    const delays = initialStyle.transitionDelay.split(',').map(value => value.trim());
    const parseTime = value => {
      const number = Number.parseFloat(value);
      if (!Number.isFinite(number)) return 0;
      return value.endsWith('ms') ? number : number * 1000;
    };
    const transitionIndex = properties.findIndex(value => value === 'min-height' || value === 'all');
    const minHeightTransitionMs = transitionIndex < 0 ? 0 : parseTime(durations[transitionIndex % durations.length] || '0s');
    const minHeightDelayMs = transitionIndex < 0 ? 0 : parseTime(delays[transitionIndex % delays.length] || '0s');
    const targetHeight = compact ? 52 : 64;
    const startedAt = performance.now();
    const samples = [];
    const transitionEvents = [];
    let transitionRunAt = null;
    let transitionEndAt = null;
    let transitionCancelAt = null;
    let pendingFrameId = 0;

    const sample = frame => {
      const headerRect = header.getBoundingClientRect();
      const navigationRect = navigation.getBoundingClientRect();
      return {
        frame,
        elapsedMs: round(performance.now() - startedAt),
        scrollY: round(window.scrollY),
        headerHeight: round(headerRect.height),
        headerBottom: round(headerRect.bottom),
        menuTop: round(navigationRect.top),
        menuLeft: round(navigationRect.left),
        menuRight: round(navigationRect.right),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        compact: header.classList.contains('is-compact'),
        ariaExpanded: toggle.getAttribute('aria-expanded'),
        activeElement: activeElement(),
        focusInsideMenu: navigation.contains(document.activeElement),
        menuVisible: getComputedStyle(navigation).display !== 'none',
      };
    };
    const onTransition = event => {
      if (event.target !== header || event.propertyName !== 'min-height') return;
      const atMs = round(performance.now() - startedAt);
      transitionEvents.push({ type: event.type, atMs, propertyName: event.propertyName });
      if (event.type === 'transitionrun' && transitionRunAt === null) transitionRunAt = atMs;
      if (event.type === 'transitionend' && transitionEndAt === null) transitionEndAt = atMs;
      if (event.type === 'transitioncancel' && transitionCancelAt === null) transitionCancelAt = atMs;
    };
    header.addEventListener('transitionrun', onTransition);
    header.addEventListener('transitionstart', onTransition);
    header.addEventListener('transitionend', onTransition);
    header.addEventListener('transitioncancel', onTransition);

    const initial = sample('before-trigger');
    samples.push(initial);
    window.scrollTo({ top: targetScrollY, behavior: 'instant' });
    const timeoutMs = Math.min(1500, Math.max(600, minHeightTransitionMs + minHeightDelayMs + 500));
    const deadline = startedAt + timeoutMs;
    let timeoutId;
    const timeoutPromise = new Promise(resolve => { timeoutId = window.setTimeout(() => resolve(false), timeoutMs); });
    let terminalReachedAt = null;
    let terminalFramesWithoutRun = 0;
    let timedOut = false;
    try {
      while (performance.now() < deadline) {
        const hasFrame = await Promise.race([
          new Promise(resolve => { pendingFrameId = requestAnimationFrame(() => { pendingFrameId = 0; resolve(true); }); }),
          timeoutPromise,
        ]);
        if (!hasFrame) {
          timedOut = true;
          break;
        }
        const current = sample(samples.length);
        samples.push(current);
        const expectedCompact = current.compact === compact;
        const atEndpoint = Math.abs(current.headerHeight - targetHeight) <= 0.75;
        if (expectedCompact && atEndpoint && terminalReachedAt === null) terminalReachedAt = current.elapsedMs;
        if (expectedCompact && atEndpoint && transitionRunAt !== null &&
            current.elapsedMs - transitionRunAt >= minHeightTransitionMs + minHeightDelayMs) break;
        if (expectedCompact && atEndpoint && transitionRunAt === null) {
          terminalFramesWithoutRun++;
          if (terminalFramesWithoutRun >= 3) break;
        }
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (pendingFrameId) cancelAnimationFrame(pendingFrameId);
      header.removeEventListener('transitionrun', onTransition);
      header.removeEventListener('transitionstart', onTransition);
      header.removeEventListener('transitionend', onTransition);
      header.removeEventListener('transitioncancel', onTransition);
    }

    const final = samples.at(-1);
    const low = Math.min(initial.headerHeight, targetHeight);
    const high = Math.max(initial.headerHeight, targetHeight);
    const intermediateSamples = samples.filter(item => item.headerHeight > low + 0.75 && item.headerHeight < high - 0.75);
    const overlappingSamples = samples.filter(item => item.menuTop < item.headerBottom - 0.5);
    const rightOverflowSamples = samples.filter(item => item.menuLeft < -0.5 || item.menuRight > item.viewportWidth + 0.5);
    const expectedScrollReached = targetScrollY > 8 ? final.scrollY > 8 : final.scrollY <= 8;
    const terminalReached = final.compact === compact && Math.abs(final.headerHeight - targetHeight) <= 0.75;
    const transitionEndpoint = transitionEndAt !== null ? 'transitionend' : terminalReached ? 'raf-endpoint-fallback' : 'timeout';
    const unsupportedReasons = [];
    if (!media.noPreference || media.reducedMotion) unsupportedReasons.push('The browser does not report prefers-reduced-motion: no-preference.');
    if (!properties.some(value => value === 'min-height' || value === 'all') || minHeightTransitionMs <= 0) unsupportedReasons.push('Computed CSS has no positive min-height transition duration.');
    if (!expectedScrollReached) unsupportedReasons.push(`Programmatic scroll did not reach the requested ${targetScrollY}px transition trigger; final scrollY=${final.scrollY}px.`);
    if (transitionRunAt === null) unsupportedReasons.push('No native min-height transitionrun event was observed.');
    if (transitionCancelAt !== null) unsupportedReasons.push('The native min-height transition was canceled.');
    if (!terminalReached) unsupportedReasons.push(`The ${compact ? 'compact' : 'expanded'} terminal height was not observed before the bounded ${timeoutMs}ms wait ended.`);
    if (intermediateSamples.length === 0) unsupportedReasons.push('No intermediate requestAnimationFrame sample fell between the start and terminal heights.');
    if (samples.length < 4) unsupportedReasons.push(`Only ${samples.length} requestAnimationFrame samples were captured; at least 4 are required.`);
    if (overlappingSamples.length) unsupportedReasons.push(`${overlappingSamples.length} sampled frame(s) placed the menu over the header.`);
    if (rightOverflowSamples.length) unsupportedReasons.push(`${rightOverflowSamples.length} sampled frame(s) placed the menu outside the viewport width.`);
    if (samples.some(item => item.ariaExpanded !== 'true' || !item.menuVisible || !item.focusInsideMenu)) unsupportedReasons.push('The open menu lost visible/ARIA/focus state during the transition.');

    return {
      label,
      supported: unsupportedReasons.length === 0,
      unsupportedReasons,
      viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio },
      motion: { requested: 'no-preference', ...media },
      css: {
        transitionProperty: properties,
        transitionDuration: durations,
        transitionDelay: delays,
        minHeightTransitionMs: round(minHeightTransitionMs),
        minHeightDelayMs: round(minHeightDelayMs),
      },
      target: { scrollY: targetScrollY, compact, height: targetHeight },
      terminalWait: { timeoutMs, timedOut, endpoint: transitionEndpoint, terminalReachedAtMs: terminalReachedAt },
      transition: {
        runAtMs: transitionRunAt,
        endAtMs: transitionEndAt,
        cancelAtMs: transitionCancelAt,
        actualDurationMs: transitionRunAt !== null && transitionEndAt !== null ? round(transitionEndAt - transitionRunAt) : null,
        observedDurationMs: transitionRunAt !== null && terminalReachedAt !== null ? round(terminalReachedAt - transitionRunAt) : null,
        events: transitionEvents,
      },
      sampleCount: samples.length,
      intermediateSampleCount: intermediateSamples.length,
      overlappingFrameCount: overlappingSamples.length,
      rightOverflowFrameCount: rightOverflowSamples.length,
      initial,
      final,
      samples,
    };
  }, { label, targetScrollY, compact });

  report.interactions.push({ name: `live header transition: ${label}`, ...evidence });
  assert(evidence.supported, `${label} did not demonstrate a valid native header transition: ${JSON.stringify(evidence.unsupportedReasons)}`);
  assert(evidence.terminalWait.endpoint === 'transitionend' || evidence.terminalWait.endpoint === 'raf-endpoint-fallback', `${label} did not reach an observed animation endpoint`);
  return evidence;
}

function largestCls(shifts) {
  const ordered = [...shifts].sort((a, b) => a.startTime - b.startTime);
  let max = 0, current = 0, windowStart = 0, last = 0;
  for (const entry of ordered) {
    if (current > 0 && entry.startTime - last < 1000 && entry.startTime - windowStart <= 5000) current += entry.value;
    else { current = entry.value; windowStart = entry.startTime; }
    last = entry.startTime;
    max = Math.max(max, current);
  }
  return max;
}

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  await context.addInitScript(() => {
    window.layoutShifts = [];
    new PerformanceObserver(list => window.layoutShifts.push(...list.getEntries().filter(x => !x.hadRecentInput))).observe({ type: 'layout-shift', buffered: true });
  });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage();
  diagnosticPage = page;
  const pages = (await readdir(root)).filter(name => name.endsWith('.html')).sort();
  const items = JSON.parse(await readFile(new URL('../../data/achievements.json', import.meta.url))).filter(item => item.status !== '待核驗');
  const mapRecords = JSON.parse(await readFile(new URL('../../data/achievement-map.json', import.meta.url)));

  for (const width of [1440, 1100, 1024, 780, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await page.goto(base + 'political-donation.html');

    await check(`donation ${width}px: account first, nav contract and no portrait`, async () => {
      assert.equal(await page.locator('.donation-portrait,picture').count(), 0);
      const account = await page.locator('.donation-account-number').boundingBox();
      assert(account && account.y + account.height < 844);
      assert.equal(await page.locator('#navigation .nav-group').count(), 5);
      assert.equal(await page.locator('#navigation a').first().getAttribute('href'), 'achievements.html');
      assert.equal(await page.locator('#navigation a[href="service.html"]').count(), 1);
      assert.equal(await page.locator('#navigation a').nth(1).getAttribute('href'), 'explore.html');
      assert.equal(await page.locator('#navigation a[href="service.html#monthly-heading"]').count(), 1);
    });

    await check(`donation ${width}px: no horizontal overflow`, async () => {
      await assertNoHorizontalOverflow(page,{directory:new URL('./results/diagnostics/',import.meta.url),label:`donation-${width}-horizontal-overflow`});
    });

    await check(`donation ${width}px: keyboard FAQ and focus`, async () => {
      const summary = page.locator('main summary').first();
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('main details').first().getAttribute('open'), '');
      assert(await summary.evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
      await page.keyboard.press('Enter');
    });

    if (width === 1440 || width === 390) await check(`G07 ${width}px: topline semantics, single banner, axe region and keyboard`, async () => {
      await page.goto(base + 'political-donation.html');
      const topline = page.locator('section.topline');
      assert.equal(await topline.count(), 1);
      assert.equal(await topline.getAttribute('aria-label'), '議員與服務資訊');
      if (width === 1440) {
        assert.equal(await topline.evaluate(el => getComputedStyle(el).display), 'block');
        assert.equal(await topline.evaluate(el => getComputedStyle(el).position), 'static');
        assert.equal(await page.locator('.site-header').evaluate(el => getComputedStyle(el).position), 'sticky');
        assert.equal(await page.getByRole('region', { name: '議員與服務資訊', exact: true }).count(), 1);
      } else {
        assert.equal(await topline.evaluate(el => getComputedStyle(el).display), 'none');
        assert.equal(await topline.evaluate(el => getComputedStyle(el).position), 'static');
      }
      assert.equal(await page.getByRole('banner').count(), 1);
      await page.screenshot({ path: fileURLToPath(new URL(`political-donation-g07-${width}.png`, output)), fullPage: true });

      const axe = await new AxeBuilder({ page }).withRules(['region']).analyze();
      await writeFile(new URL(`axe-g07-region-${width}.json`, output), JSON.stringify(axe.violations, null, 2));
      assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);

      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
      await page.keyboard.press('Tab');
      assert(await page.locator('a.skip-link').evaluate(el => el === document.activeElement));
      if (width === 1440) {
        await page.keyboard.press('Tab');
        assert(await page.locator('.topline a[href^="tel:"]').evaluate(el => el === document.activeElement));
      }
    });

    if (width === 390) await check('G06 mobile header: first-screen position, identity, service phone and keyboard order', async () => {
      await page.goto(base + 'service.html');
      const header = page.locator('.site-header');
      const topline = page.locator('section.topline');
      const phone = page.locator('.site-header a.header-phone');
      const brand = page.locator('.site-header a.brand');
      const toggle = page.locator('.menu-toggle');
      const canonicalPhone = page.locator('#contact .contact-card a.big-phone');
      const expectedHref = await canonicalPhone.getAttribute('href');
      const expectedNumber = await canonicalPhone.locator('.phone-number').innerText();
      const firstScreen = await page.evaluate(() => ({
        mainTop: document.querySelector('main').getBoundingClientRect().top,
        headerHeight: document.querySelector('.site-header').getBoundingClientRect().height,
        headerPosition: getComputedStyle(document.querySelector('.site-header')).position,
        toplineDisplay: getComputedStyle(document.querySelector('.topline')).display,
      }));
      assert.equal(firstScreen.toplineDisplay, 'none');
      assert.equal(firstScreen.headerPosition, 'sticky');
      assert(firstScreen.mainTop < 70, `main starts at ${firstScreen.mainTop}px`);
      await assertWithinHalfPixel(page,'mobile header height',firstScreen.headerHeight,64);
      assert.equal(await topline.count(), 1);
      assert.equal(await topline.getAttribute('aria-label'), '議員與服務資訊');
      assert.equal(await phone.getAttribute('href'), expectedHref);
      assert.equal(await phone.getAttribute('aria-label'), `撥打陳慧文服務處電話 ${expectedNumber}`);
      assert.equal(await phone.locator('svg').count(), 1);
      assert.equal((await phone.boundingBox()).width, 44);
      assert.equal((await phone.boundingBox()).height, 44);
      assert((await page.locator('.brand-role').innerText()).includes('高雄市議員'));
      assert((await page.locator('.brand-role').innerText()).includes('鳳山區'));
      assert(await page.locator('.brand-role').isVisible());
      assert(parseFloat(await page.locator('.brand-role').evaluate(el => getComputedStyle(el).fontSize)) >= 12);
      assert(await page.getByRole('banner').count() === 1);

      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.keyboard.press('Tab');
      assert(await page.locator('a.skip-link').evaluate(el => el === document.activeElement));
      await page.keyboard.press('Tab');
      assert(await brand.evaluate(el => el === document.activeElement));
      await page.keyboard.press('Tab');
      assert(await phone.evaluate(el => el === document.activeElement));
      await page.keyboard.press('Tab');
      assert(await toggle.evaluate(el => el === document.activeElement));
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.screenshot({ path: fileURLToPath(new URL('header-390-initial.png', output)), fullPage: false });
    });

    if (width === 390) await check('G06 mobile header: down 52px, up restore 64px, reduced motion and stable flow', async () => {
      await page.goto(base + 'service.html');
      await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
      await page.waitForFunction(() => document.querySelector('.site-header').classList.contains('is-compact'));
      await page.waitForFunction(() => Math.abs(document.querySelector('.site-header').getBoundingClientRect().height - 52) <= 0.5);
      const down = await page.evaluate(() => {
        const header = document.querySelector('.site-header');
        return {
          height: header.getBoundingClientRect().height,
          flowFootprint: header.getBoundingClientRect().height + parseFloat(getComputedStyle(header).marginBottom),
          top: header.getBoundingClientRect().top,
        };
      });
      await assertWithinHalfPixel(page,'compact mobile header height',down.height,52);
      await assertWithinHalfPixel(page,'compact mobile header flow footprint',down.flowFootprint,64);
      await assertWithinHalfPixel(page,'compact mobile header top',down.top,0);
      await page.screenshot({ path: fileURLToPath(new URL('header-390-scrolled-down.png', output)), fullPage: false });

      await page.evaluate(() => window.scrollTo({ top: 660, behavior: 'instant' }));
      await page.waitForTimeout(50);
      await page.evaluate(() => window.scrollTo({ top: 620, behavior: 'instant' }));
      await page.waitForFunction(() => !document.querySelector('.site-header').classList.contains('is-compact'));
      await page.waitForFunction(() => Math.abs(document.querySelector('.site-header').getBoundingClientRect().height - 64) <= 0.5);
      const up = await page.evaluate(() => {
        const header = document.querySelector('.site-header');
        return {
          height: header.getBoundingClientRect().height,
          flowFootprint: header.getBoundingClientRect().height + parseFloat(getComputedStyle(header).marginBottom),
          top: header.getBoundingClientRect().top,
        };
      });
      await assertWithinHalfPixel(page,'restored mobile header height',up.height,64);
      await assertWithinHalfPixel(page,'restored mobile header flow footprint',up.flowFootprint,64);
      await assertWithinHalfPixel(page,'restored mobile header top',up.top,0);
      await page.screenshot({ path: fileURLToPath(new URL('header-390-scrolled-up.png', output)), fullPage: false });

      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reduced = await page.evaluate(() => ({
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        transitionDuration: getComputedStyle(document.querySelector('.site-header')).transitionDuration,
      }));
      assert.equal(reduced.scrollBehavior, 'auto');
      assert.equal(reduced.transitionDuration, '0s');
      const axe = await new AxeBuilder({ page }).withRules(['region']).analyze();
      assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(base + 'political-donation.html');
    });

    if (width === 390) {
      const animationPage = await context.newPage();
      await animationPage.setViewportSize({ width: 390, height: 844 });
      diagnosticPage = animationPage;
      try {
        await check('G06 mobile header animation: live compact and expand frames while menu is open', async () => {
          await animationPage.emulateMedia({ reducedMotion: 'no-preference' });
          await animationPage.goto(base + 'service.html');
          const initial = await animationPage.evaluate(() => ({
            scrollY: window.scrollY,
            compact: document.querySelector('.site-header').classList.contains('is-compact'),
            height: document.querySelector('.site-header').getBoundingClientRect().height,
            reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            noPreference: matchMedia('(prefers-reduced-motion: no-preference)').matches,
          }));
          assert.equal(initial.scrollY, 0, JSON.stringify(initial));
          assert.equal(initial.compact, false, JSON.stringify(initial));
          assert(Math.abs(initial.height - 64) <= 0.75, JSON.stringify(initial));
          assert.equal(initial.reducedMotion, false, JSON.stringify(initial));
          assert.equal(initial.noPreference, true, JSON.stringify(initial));

          const toggle = animationPage.locator('.menu-toggle');
          await toggle.focus();
          await animationPage.keyboard.press('Enter');
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          assert(await animationPage.locator('#navigation').evaluate(el => el.classList.contains('is-open')));
          assert(await animationPage.locator('#navigation').evaluate(el => el.contains(document.activeElement)));

          await captureOpenMenuHeaderTransition(animationPage, { label: 'menu-open compact 64px to 52px', targetScrollY: 600, compact: true });
          await captureOpenMenuHeaderTransition(animationPage, { label: 'menu-open expand 52px to 64px', targetScrollY: 0, compact: false });
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          assert(await animationPage.locator('#navigation').evaluate(el => el.classList.contains('is-open')));
          assert(await animationPage.locator('#navigation').evaluate(el => el.contains(document.activeElement)));

          await animationPage.keyboard.press('Escape');
          assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
          assert(await toggle.evaluate(el => el === document.activeElement));
        });

        await check('G06 mobile header animation: restored nonzero scroll and programmatic menu before first controller RAF', async () => {
          await animationPage.addInitScript(() => {
            const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
            const probe = {
              controllerRafQueued: false,
              controllerRafQueuedAt: null,
              queuedWhileDocumentLoading: false,
              domContentLoadedAt: null,
              releasedAt: null,
              firstSampleStartedAt: null,
              firstSampleScrollY: null,
              firstSampleState: null,
              inputSource: 'programmatic focus() and HTMLElement.click() in DOMContentLoaded listener; not human input',
              programmaticFocusInvoked: false,
              programmaticClickInvoked: false,
              clickIsTrusted: null,
              unsupportedReason: null,
            };
            let heldControllerCallback = null;
            window.__earlyHeaderAnimationProbe = probe;
            window.requestAnimationFrame = callback => {
              const currentScript = document.currentScript;
              const fromHeaderController = document.readyState === 'loading' && currentScript?.src &&
                new URL(currentScript.src).pathname.endsWith('/site.js') && !probe.controllerRafQueued;
              if (fromHeaderController) {
                probe.controllerRafQueued = true;
                probe.controllerRafQueuedAt = performance.now();
                probe.queuedWhileDocumentLoading = true;
                heldControllerCallback = callback;
                return nativeRequestAnimationFrame(() => {});
              }
              return nativeRequestAnimationFrame(callback);
            };
            document.addEventListener('DOMContentLoaded', () => {
              probe.domContentLoadedAt = performance.now();
              if (!heldControllerCallback) {
                probe.unsupportedReason = 'The deferred site.js header controller did not expose a queued first RAF before DOMContentLoaded.';
                return;
              }
              const toggle = document.querySelector('.menu-toggle');
              const navigation = document.querySelector('#navigation');
              const header = document.querySelector('.site-header');
              if (!toggle || !navigation || !header) {
                probe.unsupportedReason = 'The existing header, menu toggle, or navigation selector was missing at DOMContentLoaded.';
                return;
              }

              window.scrollTo({ top: 600, behavior: 'instant' });
              probe.scrollYBeforeControllerSample = window.scrollY;
              toggle.addEventListener('click', event => { probe.clickIsTrusted = event.isTrusted; }, { once: true });
              toggle.focus({ preventScroll: true });
              probe.programmaticFocusInvoked = document.activeElement === toggle;
              toggle.click();
              probe.programmaticClickInvoked = true;
              probe.ariaExpandedBeforeControllerSample = toggle.getAttribute('aria-expanded');
              probe.menuOpenBeforeControllerSample = navigation.classList.contains('is-open');

              const controllerCallback = heldControllerCallback;
              heldControllerCallback = null;
              probe.releasedAt = performance.now();
              nativeRequestAnimationFrame(timestamp => {
                probe.firstSampleStartedAt = performance.now();
                probe.firstSampleScrollY = window.scrollY;
                controllerCallback(timestamp);
                const headerRect = header.getBoundingClientRect();
                const navigationRect = navigation.getBoundingClientRect();
                probe.firstSampleState = {
                  compact: header.classList.contains('is-compact'),
                  headerHeight: headerRect.height,
                  headerBottom: headerRect.bottom,
                  menuTop: navigationRect.top,
                  menuLeft: navigationRect.left,
                  menuRight: navigationRect.right,
                  viewportWidth: window.innerWidth,
                  ariaExpanded: toggle.getAttribute('aria-expanded'),
                  activeElementInsideMenu: navigation.contains(document.activeElement),
                  activeElement: document.activeElement ? {
                    tagName: document.activeElement.tagName,
                    id: document.activeElement.id || null,
                    className: typeof document.activeElement.className === 'string' ? document.activeElement.className : null,
                    href: document.activeElement.getAttribute?.('href') ?? null,
                  } : null,
                };
              });
            }, { once: true });
          });

          await animationPage.goto(base + 'service.html');
          await animationPage.waitForFunction(() => {
            const probe = window.__earlyHeaderAnimationProbe;
            return Boolean(probe && (probe.unsupportedReason || probe.firstSampleStartedAt !== null));
          }, null, { timeout: 1500 }).catch(() => {});
          const probe = await animationPage.evaluate(() => window.__earlyHeaderAnimationProbe);
          if (!probe?.controllerRafQueued || !probe?.queuedWhileDocumentLoading || !probe?.domContentLoadedAt || !probe?.firstSampleStartedAt) {
            const pending = {
              name: 'early restored-scroll header/menu sample',
              status: 'not-verified',
              reason: probe?.unsupportedReason || 'The test hook could not verify that the controller first sample ran after DOMContentLoaded.',
              evidence: probe ?? null,
              inputSource: probe?.inputSource ?? 'programmatic focus()/click(); not human input',
              nodeVmEvidence: 'The previously recorded site-header-controller VM covers the early menu case; it is not browser animation evidence.',
            };
            report.interactions.push(pending);
            return { __checkStatus: 'Pending', value: pending };
          }

          const evidence = {
            controllerRafQueued: probe.controllerRafQueued,
            queuedWhileDocumentLoading: probe.queuedWhileDocumentLoading,
            controllerRafQueuedAtMs: probe.controllerRafQueuedAt,
            domContentLoadedAtMs: probe.domContentLoadedAt,
            releasedAtMs: probe.releasedAt,
            firstSampleStartedAtMs: probe.firstSampleStartedAt,
            firstSampleObservedAfterDOMContentLoaded: probe.firstSampleStartedAt > probe.domContentLoadedAt,
            humanInput: false,
            inputSource: probe.inputSource,
            programmaticFocusInvoked: probe.programmaticFocusInvoked,
            programmaticClickInvoked: probe.programmaticClickInvoked,
            clickIsTrusted: probe.clickIsTrusted,
            scrollYBeforeControllerSample: probe.scrollYBeforeControllerSample,
            firstSampleScrollY: probe.firstSampleScrollY,
            ariaExpandedBeforeControllerSample: probe.ariaExpandedBeforeControllerSample,
            menuOpenBeforeControllerSample: probe.menuOpenBeforeControllerSample,
            firstSampleState: probe.firstSampleState,
          };
          report.interactions.push({ name: 'early restored-scroll header/menu sample', status: 'observed', ...evidence });
          assert(evidence.firstSampleObservedAfterDOMContentLoaded, JSON.stringify(evidence));
          assert.equal(evidence.programmaticFocusInvoked, true, JSON.stringify(evidence));
          assert.equal(evidence.programmaticClickInvoked, true, JSON.stringify(evidence));
          assert.equal(evidence.clickIsTrusted, false, JSON.stringify(evidence));
          assert(evidence.scrollYBeforeControllerSample >= 500, JSON.stringify(evidence));
          assert(evidence.firstSampleScrollY >= 500, JSON.stringify(evidence));
          assert.equal(evidence.ariaExpandedBeforeControllerSample, 'true', JSON.stringify(evidence));
          assert.equal(evidence.menuOpenBeforeControllerSample, true, JSON.stringify(evidence));
          assert.equal(evidence.firstSampleState.compact, true, JSON.stringify(evidence));
          assert.equal(evidence.firstSampleState.ariaExpanded, 'true', JSON.stringify(evidence));
          assert.equal(evidence.firstSampleState.activeElementInsideMenu, true, JSON.stringify(evidence));
          assert(evidence.firstSampleState.menuTop >= evidence.firstSampleState.headerBottom - 0.5, JSON.stringify(evidence));
          assert(evidence.firstSampleState.menuRight <= evidence.firstSampleState.viewportWidth + 0.5, JSON.stringify(evidence));
        });
      } finally {
        await animationPage.close();
        diagnosticPage = page;
      }
    }

    if (width === 390) await check('mobile menu: Enter, Escape, focus return and election link', async () => {
      const toggle = page.locator('.menu-toggle');
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await toggle.getAttribute('aria-label'), '關閉主要選單');
      assert(await page.locator('main').evaluate(el => el.inert));
      assert(await page.locator('.header-phone').evaluate(el => el.inert));
      assert(await page.locator('.brand').evaluate(el => el.inert));
      assert.equal(await page.locator('#navigation .nav-group[open]').count(), 0);
      await page.locator('#navigation .nav-group').filter({has:page.locator('a[href="political-donation.html"]')}).locator('summary').click();
      assert(await page.locator('#navigation a[href="political-donation.html"]').isVisible());
      await page.locator('#navigation .nav-group').filter({has:page.locator('a[href="election.html"]')}).locator('summary').click();
      await page.waitForFunction(() => document.querySelectorAll('#navigation .nav-group[open]').length === 1);
      assert(await page.locator('#navigation a[href="election.html"]').isVisible());
      assert.equal(await page.locator('#navigation a[href="political-donation.html"]').isVisible(), false);
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await toggle.getAttribute('aria-label'), '開啟主要選單');
      assert.equal(await page.locator('main').evaluate(el => el.inert), false);
      assert.equal(await page.locator('.header-phone').evaluate(el => el.inert), false);
      assert.equal(await page.locator('.brand').evaluate(el => el.inert), false);
      assert(await toggle.evaluate(el => el === document.activeElement));
      await toggle.click();
      assert.equal(await page.locator('#navigation').evaluate(el => getComputedStyle(el).position), 'fixed');
      assert.equal(await page.locator('#navigation').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
      const backdropPoint = await findVisibleClickPoint(page,'.menu-backdrop');
      report.interactions.push({name:'menu backdrop closes through an unobscured real pointer point',targetRect:backdropPoint.rect,selected:backdropPoint.selected,samples:backdropPoint.samples});
      if (!backdropPoint.selected) {
        await captureLayoutDiagnostics(page,{directory:new URL('./results/diagnostics/',import.meta.url),label:'menu-backdrop-no-visible-hit-point',error:'No point in the visible backdrop receives the real pointer hit test',extra:{backdropPoint}});
      }
      assert(backdropPoint.selected,JSON.stringify(backdropPoint));
      await page.mouse.click(backdropPoint.selected.x,backdropPoint.selected.y);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    });

    await check(`donation ${width}px: axe WCAG 2.0/2.1/2.2 A/AA`, async () => {
      for (const summary of await page.locator('main summary').all()) await summary.click();
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      await writeFile(new URL(`axe-donation-${width}.json`, output), JSON.stringify(axe.violations, null, 2));
      targetSizeEntries.push(...await collectTargetSizeDiagnostics(page, 'political-donation.html', width, axe.violations, 'donation-details-expanded'));
      // target-size has its own fail-closed baseline gate below; all other axe findings remain strict here.
      assert.deepEqual(nonTargetAxeViolations(axe.violations).map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
    });
  }

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });

    await check(`all pages ${width}px: navigation, layout and core accessibility`, async () => {
      for (const file of pages) {
        const pageErrors = [];
        const localFailures = [];
        const onError = error => pageErrors.push(String(error));
        const onFailed = request => { if (new URL(request.url()).hostname === '127.0.0.1') localFailures.push(request.url()); };
        page.on('pageerror', onError);
        page.on('requestfailed', onFailed);
        await page.goto(base + file);
        await assertNoHorizontalOverflow(page,{directory:new URL('./results/diagnostics/',import.meta.url),label:`all-pages-${width}-${file}-horizontal-overflow`});
        if (file !== 'offline.html') {
        assert.equal(await page.locator('#navigation a[href$="political-donation.html"]').count(), 1, `${file}: donation nav`);
        assert.equal(await page.locator('#navigation a[href$="election.html"]').count(), 1, `${file}: election nav`);
        assert.equal(await page.locator('#navigation a[href$="press.html"]').count(), 1, `${file}: press nav`);
        assert.equal(await page.locator('#navigation .nav-group').count(),5,`${file}: grouped navigation`);
        assert.equal((await page.locator('#navigation a').first().getAttribute('href')).replace(/^\//,''), 'achievements.html', `${file}: local issues first`);
        assert.equal((await page.locator('#navigation a').nth(1).getAttribute('href')).replace(/^\//,''), 'explore.html', `${file}: related exploration second`);
        const serviceGroup = page.locator('#navigation .nav-group').filter({has:page.locator('a[href$="service.html"]')});
        assert.equal((await serviceGroup.locator('a').first().getAttribute('href')).replace(/^\//,''), 'service.html', `${file}: service contact first in service group`);
        assert.equal((await serviceGroup.locator('a').nth(1).getAttribute('href')).replace(/^\//,''), 'service.html#monthly-heading', `${file}: lawyer order preserved in service group`);
        assert.equal(await page.locator('#navigation a[href$="gallery.html"]').count(), 0, `${file}: gallery nav`);
        assert.equal(await page.locator('#navigation a[href$="activities.html"]').textContent(), '公開行程與活動', `${file}: activities nav`);
        for (const href of ['tel:+88678212536','./','https://line.me/R/ti/p/@yve2766q','https://www.facebook.com/hwcfs/','https://www.instagram.com/huiwen.ifs/','https://www.youtube.com/channel/UCJPIvufDGcdD8PgYUi_YyDQ','https://www.threads.com/@huiwen.ifs?igshid=NTc4MTIwNjQ2YQ==']) {
          assert(await page.locator('footer a').evaluateAll((els, target) => els.some(a => a.href === new URL(target,document.baseURI).href), href), `${file}: footer ${href}`);
        }
        } else {
          assert.equal(await page.locator('meta[name=robots]').getAttribute('content'),'noindex');
          assert.match(await page.locator('h1').innerText(),/目前離線/);
          assert.equal(await page.locator('a[href="tel:+88678212536"]').count(),1);
        }
        if (file.startsWith('achievement-')) {
          const text = await page.locator('main').innerText();
          assert(!/紀錄補充|資料與追蹤|並非已完成證明|尚未取得足以|本頁保留議題索引|待核驗|資料核驗狀態|資料查核|來源邊界|不混為完成|正式選舉公報尚未取得/.test(text), `${file}: public copy`);
        }
        const core = ['index.html','about.html','achievements.html','vision.html','news.html','press.html','activities.html','gallery.html','service.html','petition.html','political-donation.html','election.html','404.html','offline.html','achievement-wende-school-center.html'];
        if (core.includes(file)) {
          const axe = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
          targetSizeEntries.push(...await collectTargetSizeDiagnostics(page, file, width, axe.violations, 'core-page-default'));
          const serious = nonTargetAxeViolations(axe.violations, ['serious', 'critical']);
          await writeFile(new URL(`axe-${file}-${width}.json`, output), JSON.stringify(axe.violations, null, 2));
          // The dedicated baseline check handles target-size; other serious/critical axe findings remain zero-tolerance.
          assert.deepEqual(serious.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `${file}: axe`);
        }
        assert.deepEqual(pageErrors, [], `${file}: page errors`);
        assert.deepEqual(localFailures, [], `${file}: local request failures`);
        page.off('pageerror', onError);
        page.off('requestfailed', onFailed);
      }
    });

    await check(`homepage ${width}px: portrait first, local query entry and CLS`, async () => {
      await page.goto(base + 'index.html');
      const img = page.locator('.hero-portrait img');
      await img.evaluate(el => el.decode());
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await img.getAttribute('src'),'assets/legal/portrait.webp');
      assert.equal(await img.getAttribute('loading'),'eager');
      const frame = await page.locator('.portrait-frame').boundingBox();
      const heading = await page.locator('.hero-copy h1').boundingBox();
      await assertWithHomeDiagnostics(page,fileURLToPath(output),width,'portrait-ratio',async()=>{
        assert.equal(await page.locator('h1').count(),1);
        assert(await page.locator('.home-village-form #home-village').isVisible());
        assert(await page.locator('main > section').first().evaluate(el=>el.classList.contains('hero')));
        assert((await page.locator('.hero').boundingBox()).y < (await page.locator('.home-recent').boundingBox()).y);
        assert(frame && heading);
        assert(Math.abs(frame.width / frame.height - 1.04) < 0.02);
        assert(frame.x >= 0 && frame.x + frame.width <= width);
      });
      assert.equal(await page.locator('main a[href="service.html#monthly-heading"]').count(),1);
      assert.equal(await page.locator('.hero-actions a.primary').getAttribute('href'),'tel:+88678212536');
      assert.equal(await page.locator('.hero-actions a.primary').innerText(),'撥打服務處');
      assert.equal(await page.locator('.hero-actions a.outline').getAttribute('href'),'https://line.me/R/ti/p/@yve2766q');
      assert.doesNotMatch(await page.locator('main').innerText(),/首頁設計預覽|設計試作|待核驗/);
      await page.evaluate(() => document.fonts.ready);
      const cls = await page.evaluate(largest => largest(window.layoutShifts), largestCls.toString()).catch(async () => page.evaluate(() => {
        const shifts = [...window.layoutShifts].sort((a,b)=>a.startTime-b.startTime); let max=0,current=0,start=0,last=0;
        for(const e of shifts){ if(current>0&&e.startTime-last<1000&&e.startTime-start<=5000) current+=e.value; else {current=e.value;start=e.startTime;} last=e.startTime;max=Math.max(max,current); } return max;
      }));
      if (cls >= 0.1) await captureLayoutDiagnostics(page,{directory:new URL('./results/diagnostics/',import.meta.url),label:`homepage-${width}-cls`,error:`homepage CLS ${cls}`,extra:{cls,layoutShifts:await page.evaluate(()=>window.layoutShifts.map(({value,startTime,hadRecentInput,sources})=>({value,startTime,hadRecentInput,sources:sources?.map(source=>({previousRect:source.previousRect,currentRect:source.currentRect}))})))}});
      assert(cls < 0.1, `homepage CLS ${cls}`);
      await page.screenshot({ path: fileURLToPath(new URL(`index-${width}.png`, output)), fullPage: true });
    });

    await check(`achievement search filters and pagination ${width}px`, async () => {
      await page.goto(base + 'achievements.html');
  await page.getByRole('button',{name:'地圖與列表',exact:true}).click();
      await page.waitForFunction(()=>!!window.HuiwenCases);
      const visible = () => page.locator('[data-case]:visible').count();
      assert.equal(await visible(), Math.min(10, items.length));
      await page.locator('#case-search').fill('文龍');
      assert((await visible()) > 0);
      await openCaseFilterDialog(page);
      await page.locator('#reset-map-filters').click();
      const village = items.find(item => item.villages.length).villages[0];
      await page.locator('#village-filter').selectOption('v:' + village);
      assert.equal(await visible(), Math.min(10, items.filter(item => item.villages.includes(village)).length));
      await page.locator('#reset-map-filters').click();
      if (await page.locator('.advanced-filters').getAttribute('open') === null) await page.locator('.advanced-filters > summary').click();
      await page.locator('#subcategory-filter').selectOption({ label: '寵物' });
      assert((await visible()) > 0);
      await page.locator('#reset-map-filters').click();
      if (await page.locator('.advanced-filters').getAttribute('open') !== null) await page.locator('.advanced-filters > summary').click();
      await closeCaseFilterDialog(page);
      if (items.length > 10) {
        await page.getByRole('button', { name: '第 2 頁' }).click();
        assert.equal(await page.locator('.case-page-button[aria-current="page"]').innerText(), '2');
      }
      await page.getByRole('button',{name:'地圖與列表',exact:true}).click();
      await page.locator('#achievement-map').scrollIntoViewIfNeeded();
      await page.locator('.leaflet-container').waitFor({state:'visible'});
      assert(await page.locator('.leaflet-container').isVisible());
      if (width === 390) {
        const controls = await page.locator('.map-controls').boundingBox();
        const map = await page.locator('#achievement-map').boundingBox();
        assert(controls && controls.height < 350, `mobile map filters too tall: ${controls?.height}`);
        assert(map && Math.abs(map.height - 0.45 * 844) < 2, `mobile map should be 45vh: ${map?.height}`);
      }
    });

    await check(`news media controls ${width}px`, async () => {
      await page.goto(base + 'news.html');
      await page.locator('#news-search').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.news-media-grid > *').count(), 10);
      assert.equal(await page.locator('#news-sort option').allTextContents().then(x => x.join('|')), '重要優先|日期優先（新到舊）');
      assert((await page.locator('.news-media-grid .news-tag').count()) > 0);
      const firstReport = page.locator('.news-report-card').first();
      const reportDetails = firstReport.locator('.news-card-details');
      assert.equal(await reportDetails.getAttribute('open'), null);
      assert(await firstReport.locator('.news-card-lead').isVisible());
      assert.match(await firstReport.locator('.news-card-lead').innerText(), /尚非調薪完成/);
      const sourceURLs = await firstReport.locator('a[href]').evaluateAll(links => links.map(link => link.getAttribute('href')));
      assert.deepEqual(sourceURLs, ['https://www.taisounds.com/news/content/71/288751','https://youngnews3631.com/news_detail.php?NewsID=18015']);
      const disclosure = reportDetails.locator('summary');
      await disclosure.focus();
      await page.keyboard.press('Enter');
      assert(await firstReport.locator('.news-source-links a').first().isVisible());
      assert.doesNotMatch(await reportDetails.innerText(), /漾新聞｜漾新聞｜/);
      await firstReport.screenshot({path:fileURLToPath(new URL(`news-expanded-${width}.png`, output))});
      await page.keyboard.press('Enter');
      assert.equal(await reportDetails.getAttribute('open'), null);
      assert(await disclosure.evaluate(element => element === document.activeElement));

      await page.locator('[data-filter-menu="topic"] summary').click();
      await page.locator('[data-filter-menu="topic"] input[value="education"]').check();
      await page.locator('[data-filter-menu="topic"] input[value="transport"]').check();
      assert.match(await page.locator('[data-news-count]').innerText(), /主題 2/);
      await page.locator('[data-filter-menu="tag"] summary').click();
      await page.locator('[data-filter-menu="tag"] input[value="鳳山車站"]').check();
      await page.locator('[data-filter-menu="tag"] input[value="特教"]').check();
      assert.match(await page.locator('[data-news-count]').innerText(), /# 2/);
      assert((await page.locator('.news-media-grid > *').count()) > 0);
      await page.locator('[data-filter-clear]').click();
      await page.locator('#news-search').fill('鳳山');
      assert((await page.locator('.news-media-grid > *').count()) > 0);
      assert.equal(await page.locator('.news-press-card').count(), 0);
    });

    await check(`press release controls ${width}px`, async () => {
      await page.goto(base + 'press.html');
      await page.locator('#press-search').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.news-press-grid > *').count(), 10);
      assert.equal(await page.locator('#press-sort option').allTextContents().then(x => x.join('|')), '重要優先|日期優先（新到舊）');
      assert((await page.locator('.news-press-grid .news-tag').count()) > 0);
      await page.locator('[data-filter-menu="topic"] summary').click();
      await page.locator('[data-filter-menu="topic"] input[value="education"]').check();
      await page.locator('[data-filter-menu="topic"] input[value="livelihood"]').check();
      await page.locator('[data-filter-menu="tag"] summary').click();
      await page.locator('[data-filter-menu="tag"] input[value="特教"]').check();
      await page.locator('[data-filter-menu="tag"] input[value="毛動力"]').check();
      assert((await page.locator('.news-press-grid > *').count()) > 0);
      assert((await page.locator('.news-press-grid > *').count()) <= 10);
      assert.match(await page.locator('[data-press-count]').innerText(), /主題 2.*# 2/);
      await page.locator('[data-filter-clear]').click();
      await page.locator('#press-search').fill('特教');
      assert((await page.locator('.news-press-grid > *').count()) > 0);
    });

    await check(`service/about/activities regressions ${width}px`, async () => {
      await page.goto(base + 'service.html');
      const legal = await page.locator('.legal-section').boundingBox();
      const monthly = await page.locator('.schedule-text').boundingBox();
      assert(legal && monthly && monthly.y < legal.y);
      assert.equal(await page.locator('.monthly-schedule a[href*="canva.com"]').count(), 0);
      assert.equal(await page.locator('.schedule-original,.schedule-archive,.schedule-auto-embed,iframe[src*="canva.com"]').count(), 0, 'retired schedule displays are absent');
      await page.locator('[data-legal-calendar]').waitFor({state:'visible'});
      assert(await page.getByRole('button', {name:'下載本月圖卡 PNG',exact:true}).isVisible());
      assert((await page.locator('.schedule-phone-cta').boundingBox()).height >= 44);
      await page.goto(base + 'about.html');
      for (const href of ['https://www.facebook.com/hwcfs/','https://www.threads.com/@huiwen.ifs','https://www.kcc.gov.tw/MemberInfo_New.aspx?msn=2215&n=39&sms=9028']) assert.equal(await page.locator(`.social-grid a[href="${href}"]`).count(), 1);
      assert.equal(await page.locator('.social-grid a').count(), 3);
      await page.goto(base + 'activities.html');
      assert(await page.getByRole('heading', { name: '公開行程與活動', exact: true }).isVisible());
      assert.equal(await page.locator('.event-empty a').count(), 0);
    });

    await check(`petition privacy boundary ${width}px`, async () => {
      await page.goto(base + 'petition.html');
      assert.equal(await page.locator('form,input,iframe').count(), 0);
      assert.equal(await page.locator('a[href*="notion"]').count(), 1);
    });
  }

  await check('map initial page is bounded while record data is pending', async () => {
    const pending = await browser.newContext({viewport:{width:390,height:844}});
    await pending.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const p = await pending.newPage();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let startRequest;
    const requestStarted = new Promise(resolve => { startRequest = resolve; });
    await p.route('**/data/achievement-map.json*', async route => { startRequest(); await held; await route.continue(); });
    try {
      await p.goto(base + 'achievements.html', {waitUntil:'domcontentloaded'});
      assert.equal(await p.locator('#case-list [data-case]').count(), items.length);
      assert.equal(await p.locator('#case-list [data-case]:visible').count(), 10);
      assert.equal(await p.evaluate(() => Boolean(window.HuiwenCases)), true);
      assert.equal(await p.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('achievement-map.json'))), false);
      await p.getByRole('button',{name:'地圖與列表',exact:true}).click();
      await requestStarted;
      assert.equal(await p.locator('#case-list [data-case]:visible').count(), 10, 'list remains interactive while map data is pending');
      release();
      await p.waitForFunction(() => window.HuiwenCases.getState().data.some(record => Object.hasOwn(record,'searchText')));
      assert.equal(await p.locator('#case-list [data-case]:visible').count(), 10);
      assert.equal(await p.evaluate(() => window.HuiwenCases.getState().visible.length), items.length);
    } finally { release(); await pending.close(); }
  });

  await check('record-data failure preserves the server-rendered list and basic filters', async () => {
    const fallback = await browser.newContext({viewport:{width:390,height:844}});
    await fallback.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const p = await fallback.newPage();
    await p.route('**/data/achievement-map.json*', route => route.abort());
    try {
      await p.goto(base + 'achievements.html');
      await p.getByRole('button',{name:'地圖與列表',exact:true}).click();
      await p.getByText('地圖資料暫時無法載入；列表篩選仍可使用。', {exact:true}).waitFor();
      assert.equal(await p.locator('#case-list [data-case]').count(), items.length);
      assert.equal(await p.locator('#case-list [data-case]:visible').count(), 10);
      assert.equal(await p.evaluate(() => Boolean(window.HuiwenCases)), true);
      assert.equal(await p.locator('#case-search').isEnabled(), true);
      await p.locator('#case-search').fill('文德');
      await p.waitForFunction(() => window.HuiwenCases.getState().visible.length > 0);
      await p.unroute('**/data/achievement-map.json*');
      await p.getByRole('button',{name:'地圖與列表',exact:true}).click();
      await p.waitForFunction(() => window.HuiwenCases.getState().data.some(record => Object.hasOwn(record,'searchText')));
      await p.locator('.leaflet-control-attribution').waitFor();
      assert.doesNotMatch(await p.locator('#map-message').textContent(),/地圖資料暫時無法載入/);
    } finally { await fallback.close(); }
  });

  await check('delayed first keyword loads the full index and retains the latest query', async () => {
    const pending = await browser.newContext({viewport:{width:390,height:844}});
    await pending.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const p = await pending.newPage();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let startRequest;
    const requestStarted = new Promise(resolve => { startRequest = resolve; });
    await p.route('**/data/achievement-map.json*', async route => { startRequest(); await held; await route.continue(); });
    try {
      await p.goto(base + 'achievements.html?q=' + encodeURIComponent('票卡 車牌'), {waitUntil:'domcontentloaded'});
      await requestStarted;
      assert.equal(await p.evaluate(() => Boolean(window.HuiwenCases)), true);
      assert.equal(await p.evaluate(() => window.HuiwenCases.getState().data.some(record => Object.hasOwn(record,'searchText'))), false);
      release();
      await p.waitForFunction(() => window.HuiwenCases.getState().data.some(record => Object.hasOwn(record,'searchText')));
      const tokens = ['票卡','車牌'];
      const expected = mapRecords.filter(record => tokens.every(token => record.searchText.normalize('NFKC').toLocaleLowerCase('zh-Hant-TW').replace(/臺/g,'台').includes(token))).map(record => record.id);
      assert.deepEqual(await p.evaluate(() => window.HuiwenCases.getState().visible.map(record => record.id)), expected);
    } finally { release(); await pending.close(); }
  });

  await check('rapid query clearing and village changes survive a delayed data response', async () => {
    const pending = await browser.newContext({viewport:{width:390,height:844}});
    await pending.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const p = await pending.newPage();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let startRequest;
    const requestStarted = new Promise(resolve => { startRequest = resolve; });
    await p.route('**/data/achievement-map.json*', async route => { startRequest(); await held; await route.continue(); });
    try {
      await p.goto(base + 'achievements.html', {waitUntil:'domcontentloaded'});
      await p.locator('#case-search').fill('票卡 車牌');
      await requestStarted;
      await p.locator('#case-search').fill('文德國小');
      await p.locator('#case-search').fill('');
      await openCaseFilterDialog(p);
      await p.locator('#village-filter').selectOption('v:曹公里');
      release();
      await p.waitForFunction(() => window.HuiwenCases.getState().data.some(record => Object.hasOwn(record,'searchText')) && window.HuiwenCases.getState().filters.village === 'v:曹公里');
      const expected = mapRecords.filter(record => record.villages.includes('曹公里')).map(record => record.id);
      assert.equal(await p.evaluate(() => window.HuiwenCases.getState().filters.q), '');
      assert.deepEqual(await p.evaluate(() => window.HuiwenCases.getState().visible.map(record => record.id)), expected);
      assert.deepEqual(expected.slice(0,3), ['xiehe-lane3-community-road-repair','metro-green-line','station-parking']);
    } finally { release(); await pending.close(); }
  });

  for (const viewport of [{width:1180,height:757},{width:390,height:844}]) {
    await check(`news first-screen complete lead ${viewport.width}px`, async () => {
      await page.setViewportSize(viewport);
      await page.goto(base + 'news.html');
      await page.locator('.news-card-lead').first().waitFor({state:'visible'});
      const lead = await page.locator('.news-card-lead').first().boundingBox();
      await page.screenshot({path:fileURLToPath(new URL(`news-reading-${viewport.width}.png`, output))});
      assert(lead && lead.y >= 0 && lead.y + lead.height <= viewport.height, JSON.stringify({viewport,lead}));
      await assertNoHorizontalOverflow(page,{directory:new URL('./results/diagnostics/',import.meta.url),label:`news-first-screen-${viewport.width}-layout`});
    });
  }


  for (const viewport of [{width:1180,height:757},{width:390,height:844}]) {
    await check(`case overview and latest record precede utilities ${viewport.width}px`, async () => {
      await page.setViewportSize(viewport);
      await page.goto(base + 'achievement-metro-green-line.html');
      const overview = await page.locator('.case-overview-summary').boundingBox();
      const latest = await page.locator('.case-latest').boundingBox();
      const navigation = await page.locator('.civic-article-nav').boundingBox();
      assert(overview && latest && navigation && overview.y < latest.y && latest.y < navigation.y);
      const meta = await page.locator('.case-overview-meta').innerText();
      for (const detail of ['地區：曹公里','紀錄階段：持續追蹤','最新紀錄：2026-05-14']) assert(meta.includes(detail), detail);
      const leadLocator = page.locator('.case-latest > p:not([class])');
      await leadLocator.scrollIntoViewIfNeeded();
      const lead = await leadLocator.boundingBox();
      assert(lead && lead.y >= 0 && lead.y + lead.height <= viewport.height, JSON.stringify({viewport,lead}));
      assert.equal(await page.locator('.case-latest .record-boundary').count(), 0);
      assert.match(await page.locator('.case-latest').innerText(), /市府將串聯鳳山火車站納入可行性評估/);
      await page.screenshot({path:fileURLToPath(new URL(`case-reading-${viewport.width}.png`, output))});
      const sources = page.locator('#case-sources');
      assert.match(await sources.locator('a[href*="Frame_Councilor.aspx"]').first().innerText(), /議員查詢入口/);
      await sources.screenshot({path:fileURLToPath(new URL(`case-sources-${viewport.width}.png`, output))});
      await page.goto(base + 'index.html');
      const recent = page.locator('.home-recent-list');
      assert.equal(await recent.locator('> li').count(),3);
      assert.equal(await page.locator('.home-recent-local').count(),1);
      assert.equal(await page.locator('[data-home-local-record="bade-detention"]').count(),0);
      assert.equal(await page.locator('.civic-story-grid, .civic-reading-row, .place').count(),0);
      await recent.screenshot({path:fileURLToPath(new URL(`home-recent-${viewport.width}.png`, output))});
      await page.locator('.home-local-progress').screenshot({path:fileURLToPath(new URL(`home-local-progress-${viewport.width}.png`, output))});

    });
  }

  await context.close();

  const nojs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const nojsPage = await nojs.newPage();
  diagnosticPage = nojsPage;
  await check('no JavaScript: mobile native navigation flows, expands and leaves the page reachable', async () => {
    await nojsPage.setViewportSize({ width: 320, height: 740 });
    try {
      await nojsPage.goto(base + 'service.html');
      const header = nojsPage.locator('.site-header');
      const navigation = nojsPage.locator('#navigation');
      const role = nojsPage.locator('.brand-role');
      const phone = nojsPage.locator('.site-header a.header-phone');
      const canonicalPhone = nojsPage.locator('#contact .contact-card a.big-phone');
      assert.equal(await nojsPage.locator('html.menu-ready').count(), 0);
      assert.equal(await nojsPage.locator('.menu-toggle').isVisible(), false);
      assert(await role.isVisible());
      assert(parseFloat(await role.evaluate(el => getComputedStyle(el).fontSize)) >= 12);
      assert((await role.innerText()).includes('高雄市議員'));
      assert((await role.innerText()).includes('鳳山區'));
      assert.equal(await phone.getAttribute('href'), await canonicalPhone.getAttribute('href'));
      assert.equal((await phone.boundingBox()).width, 44);
      assert.equal((await phone.boundingBox()).height, 44);
      await assertNoHorizontalOverflow(nojsPage,{directory:new URL('./results/diagnostics/',import.meta.url),label:'nojs-service-320-layout'});

      const group = navigation.locator('.nav-group').first();
      await group.locator('summary').click();
      assert.equal(await group.getAttribute('open'), '');
      assert(await group.locator('a[href="achievements.html"]').isVisible());
      const flow = await nojsPage.evaluate(() => {
        const headerRect = document.querySelector('.site-header').getBoundingClientRect();
        const navRect = document.querySelector('#navigation').getBoundingClientRect();
        const mainRect = document.querySelector('main').getBoundingClientRect();
        const headingRect = document.querySelector('main h1').getBoundingClientRect();
        return { headerBottom: headerRect.bottom, navBottom: navRect.bottom, mainTop: mainRect.top, headingTop: headingRect.top };
      });
      assert(flow.navBottom <= flow.headerBottom + 1, JSON.stringify(flow));
      assert(flow.mainTop >= flow.headerBottom - 1, JSON.stringify(flow));
      assert(flow.headingTop >= flow.mainTop - 1, JSON.stringify(flow));

      const heading = nojsPage.locator('main h1').first();
      await heading.scrollIntoViewIfNeeded();
      const headingPosition = await heading.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
      });
      assert(headingPosition.top >= 0 && headingPosition.top < headingPosition.viewportHeight, JSON.stringify(headingPosition));
    } finally {
      await nojsPage.setViewportSize({ width: 390, height: 844 });
    }
  });
  await check('no JavaScript: political donation remains readable', async () => {
    await nojsPage.goto(base + 'political-donation.html');
    assert(await nojsPage.locator('.brand[href="./"]').isVisible());
    await nojsPage.locator('main summary').first().click();
    assert.equal(await nojsPage.locator('main details').first().getAttribute('open'), '');
    assert(await nojsPage.getByText('752200636579', { exact: true }).isVisible());
    assert.equal(await nojsPage.locator('form,input,iframe').count(), 0);
    await assertNoHorizontalOverflow(nojsPage,{directory:new URL('./results/diagnostics/',import.meta.url),label:'nojs-political-donation-layout'});
  });

  for (const file of ['vision.html','achievements.html','election.html','news.html','press.html']) {
    await check(`no JavaScript: ${file}`, async () => {
      await nojsPage.goto(base + file);
      assert(await nojsPage.locator('h1').isVisible());
      if (file === 'vision.html') assert(await nojsPage.locator('#platform-2005').first().isVisible());
      if (file === 'achievements.html') {
        assert(await nojsPage.locator('[data-case]').first().isVisible());
        assert.equal(await nojsPage.locator('#case-list [data-case]:visible').count(), items.length);
      }
      if (file === 'election.html') assert.match(await nojsPage.locator('main').innerText(), /2026\/10\/23|候選人姓名號次抽籤/);
      if (file === 'news.html') assert((await nojsPage.locator('.news-report-card').count()) >= 20);
      if (file === 'press.html') assert.equal(await nojsPage.locator('.news-press-card').count(), 17);
    });
  }
  await nojs.close();
} catch (error) {
  report.failures.push(String(error));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  const targetSizeGate = evaluateTargetSizeGate(
    targetSizeMode,
    targetSizeBaseline,
    targetSizeEntries,
    FULL_SITE_TARGET_SIZE_SCOPE,
  );
  report.wcag22aaTargetSize = {
    mode: targetSizeMode,
    scope: FULL_SITE_TARGET_SIZE_SCOPE,
    axePlaywrightVersion: AXE_PLAYWRIGHT_VERSION,
    axeCoreVersion: AXE_CORE_VERSION,
    baselineStatus: targetSizeBaseline.status,
    baselineScope: targetSizeBaseline.scope ?? null,
    baselineKnownViolationCount: targetSizeGate.knownBaselineCount,
    baselineBaseHeadSha: targetSizeBaseline.baseHeadSha,
    sourceHeadSha: process.env.GITHUB_SHA ?? null,
    gate: targetSizeGate,
  };
  if (targetSizeMode === 'capture-pending') {
    report.checks.push({ name: 'WCAG 2.2 AA target-size baseline', status: 'Pending', value: targetSizeGate });
  } else if (!targetSizeGate.pass) {
    report.checks.push({ name: 'WCAG 2.2 AA target-size baseline', status: 'Failed', error: targetSizeGateMessage(targetSizeGate) });
    report.failures.push('WCAG 2.2 AA target-size baseline');
  } else {
    report.checks.push({ name: 'WCAG 2.2 AA target-size baseline', status: 'Passed', value: targetSizeGate });
  }
  report.status = report.failures.length ? 'Failed' : report.checks.some(item => item.status === 'Pending') ? 'Pending' : 'Passed';
  await writeFile(new URL('wcag22aa-target-size.json', output), JSON.stringify({
    schema: 'wcag22aa-target-size-report/v1',
    source: { headSha: process.env.GITHUB_SHA ?? null },
    mode: targetSizeMode,
    scope: FULL_SITE_TARGET_SIZE_SCOPE,
    axePlaywrightVersion: AXE_PLAYWRIGHT_VERSION,
    axeCoreVersion: AXE_CORE_VERSION,
    baseline: targetSizeBaseline,
    gate: targetSizeGate,
    violations: targetSizeEntries,
  }, null, 2));
  await writeFile(new URL('browser-report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
