import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { verifyPageFontPreloadEvidence } from './page-font-preload-contract.mjs';
import { observePendingResult, preservePrimaryError, requireObservedValue } from './page-font-artifact-lifecycle.mjs';
import { errorRecord, runPageFontArtifactPreflight, writePageFontArtifactReport } from './page-font-artifact-preflight.mjs';
import {
  VISUAL_CAPTURE_COUNT,
  VISUAL_CAPTURE_SEED,
  buildVisualCaptureRecord,
  selectVisualRoutes,
  validateArtifactIdentity,
  visualPngMatchesHash,
  visualPngPath,
} from './page-font-artifact-visual.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const artifact = resolve(root, '_site');
const base = process.env.BASE_URL || 'http://127.0.0.1:8789/';
const fontRoot = 'assets/fonts/huiwen-site-sans/';
const fullTcPath = `${fontRoot}huiwen-site-sans-tc-20261007.woff2`;
const output = resolve(root, 'tests/donation/results/page-font-artifact');
const reportPath = resolve(output, 'report.json');
const visualOutput = resolve(output, 'visual');
let publication;
let fontManifest;
let fullTcSha;
let artifactIdentity;

function urlPath(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.pathname : null;
  } catch {
    return null;
  }
}

function safeUrlSummary(value) {
  try {
    const url = new URL(value);
    const summary = { origin: url.origin === 'null' ? null : url.origin, host: url.host || null, pathname: url.pathname };
    const route = url.searchParams.get('path');
    if (route !== null) summary.query = { path: /^[A-Za-z0-9_./-]{1,256}$/.test(route) ? route : '[invalid]' };
    const cmsEdit = url.searchParams.get('cmsEdit');
    if (cmsEdit === '0' || cmsEdit === '1') summary.query = { ...summary.query, cmsEdit };
    return summary;
  } catch {
    return { origin: null, host: null, pathname: null };
  }
}

function browserMessageCategory(message) {
  const text = String(message || '').toLowerCase();
  if (/content security policy|frame-ancestors|refused to frame/.test(text)) return 'csp-frame-policy';
  if (/x-frame-options/.test(text)) return 'x-frame-options';
  if (/err_blocked_by_response|blocked by response/.test(text)) return 'response-blocked';
  if (/err_blocked_by_client|blocked by client/.test(text)) return 'client-blocked';
  if (/net::err_|networkerror|failed to load resource/.test(text)) return 'network-error';
  if (/\b(401|403|404)\b/.test(text)) return 'http-denied';
  return 'other-browser-error';
}

function waitForCmsPreviewNavigation(page, timeout = 15000) {
  return page.waitForEvent('framenavigated', {
    predicate: (frame) => {
      if (frame === page.mainFrame() || frame.parentFrame() !== page.mainFrame()) return false;
      try {
        const url = new URL(frame.url());
        return url.origin === 'https://admin.huiwen.tw' && url.pathname === '/api/page-preview';
      } catch {
        return false;
      }
    },
    timeout,
  }).then((frame) => ({ frame }), (error) => ({ error }));
}

function cmsFailureSnapshot({ page, hostNavigationStatus, proxyRequests, proxyResponses, blockedReasons, messages }) {
  return {
    frameURLs: page.frames().map((frame) => ({
      ...safeUrlSummary(frame.url()),
      mainFrame: frame === page.mainFrame(),
      parent: frame.parentFrame() ? safeUrlSummary(frame.parentFrame().url()) : null,
    })),
    hostUrl: safeUrlSummary(page.url()),
    hostNavigationStatus,
    proxyRequests: proxyRequests.slice(0, 20),
    proxyResponses: proxyResponses.slice(0, 20),
    blockedReasons: [...new Set(blockedReasons)].slice(0, 20),
    messages: messages.slice(0, 20),
  };
}

function requestInitiator(initiator) {
  const frames = [];
  let stack = initiator?.stack;
  while (stack && frames.length < 3) {
    for (const frame of stack.callFrames || []) {
      if (frames.length >= 3) break;
      frames.push({ url: urlPath(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber });
    }
    stack = stack.parent;
  }
  return {
    type: initiator?.type || 'unknown',
    url: urlPath(initiator?.url),
    lineNumber: initiator?.lineNumber ?? null,
    frames,
  };
}

async function collectVisibleFontDiagnostics(page, route, row) {
  const expectedFonts = [row.commonFont, row.deltaFont].map((path) => {
    const face = fontManifest.fonts[path];
    return { path, family: face.family, weight: face.wght, sha256: face.sha256,
      codepoints: face.codepoints };
  });
  return page.evaluate(({ routeName, expectedPreloads, expectedFonts }) => {
    const covered = new Set(expectedFonts.flatMap((font) => font.codepoints));
    const codepoints = new Set();
    const owners = new Map();
    const uncovered = new Map();
    let visibleTextCharacterCount = 0;
    let visibleTextSample = '';
    const selectorFor = (element) => {
      const id = element.id ? `#${element.id.slice(0, 80)}` : '';
      const classes = [...element.classList].slice(0, 3).map((name) => `.${name.slice(0, 60)}`).join('');
      return `${element.tagName.toLowerCase()}${id}${classes}`.slice(0, 180);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement;
      if (!element || ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(element.tagName)) continue;
      const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length) continue;
      const chars = [...text];
      visibleTextCharacterCount += chars.length;
      if (visibleTextSample.length < 800) visibleTextSample += `${text} `.slice(0, 800 - visibleTextSample.length);
      const cps = [...new Set(chars.map((char) => char.codePointAt(0)))];
      cps.forEach((cp) => codepoints.add(cp));
      const selector = selectorFor(element);
      const key = `${selector}|${style.fontFamily}|${style.fontWeight}|${style.fontStyle}`;
      const owner = owners.get(key) || { selector, fontFamily: style.fontFamily,
        fontWeight: style.fontWeight, fontStyle: style.fontStyle, textNodes: 0, sample: '' };
      owner.textNodes += 1;
      if (owner.sample.length < 120) owner.sample += `${text} `.slice(0, 120 - owner.sample.length);
      owners.set(key, owner);
      const missing = cps.filter((cp) => !covered.has(cp));
      if (missing.length) {
        const gap = uncovered.get(key) || { selector, fontFamily: style.fontFamily,
          fontWeight: style.fontWeight, fontStyle: style.fontStyle, codepoints: new Set(), sample: '' };
        missing.forEach((cp) => gap.codepoints.add(cp));
        if (gap.sample.length < 120) gap.sample += `${text} `.slice(0, 120 - gap.sample.length);
        uncovered.set(key, gap);
      }
    }
    const declaredPreloads = [...document.querySelectorAll('link[rel~="preload"][as="font"]')].map((link) => ({
      path: new URL(link.href).pathname,
      role: link.getAttribute('data-huiwen-font-page-preload'),
    }));
    const observedPreloads = performance.getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => path.startsWith('/assets/fonts/huiwen-site-sans/page-'))
      .sort();
    const fontFaces = [...document.fonts].map((face) => ({ family: face.family, weight: face.weight,
      style: face.style, status: face.status, unicodeRange: face.unicodeRange }))
      .filter((face) => /Huiwen Sans TC Page (Common|Delta)|Huiwen Sans TC/.test(face.family)).slice(0, 24);
    return {
      route: routeName,
      artifactRoute: document.documentElement.dataset.huiwenFontArtifactRoute || null,
      legacyFontPage: document.documentElement.dataset.huiwenFontPage || null,
      rootFontFamily: getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family').trim(),
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      bodyFontWeight: getComputedStyle(document.body).fontWeight,
      visibleTextCharacterCount,
      visibleTextSample: visibleTextSample.trim(),
      visibleCodepoints: [...codepoints].sort((a, b) => a - b).slice(0, 768),
      visibleCodepointsTruncated: codepoints.size > 768,
      uncoveredVisibleGlyphs: [...uncovered.values()].slice(0, 32).map((owner) => ({
        selector: owner.selector, fontFamily: owner.fontFamily, fontWeight: owner.fontWeight,
        fontStyle: owner.fontStyle,
        codepoints: [...owner.codepoints].sort((a, b) => a - b).slice(0, 32), sample: owner.sample.trim(),
      })),
      computedFontOwners: [...owners.values()].slice(0, 24),
      expectedFonts: expectedFonts.map(({ path, family, weight, sha256, codepoints }) => ({
        path, family, weight, sha256, codepointCount: codepoints.length,
      })),
      fontFaces,
      expectedPreloads,
      declaredPreloads,
      observedPreloads,
    };
  }, {
    routeName: route,
    expectedPreloads: row.preloads.map((path) => `/${path}`).sort(),
    expectedFonts,
  });
}

const samples = [
  'news-20251125-school-review.html',
  'achievement-wujia-public-parking.html',
  'achievement-metro-green-line.html',
];
const legacyRoutes = [
  ['index.html', 'index'], ['about.html', 'about'], ['achievements.html', 'achievements'],
  ['vision.html', 'vision'], ['news.html', 'news'],
  ['news-20260915-special-education-nurse.html', 'news-detail'],
  ['political-donation.html', 'political-donation'], ['election.html', 'election'],
  ['explore.html', 'explore'],
];
const schemaRoutes = ['offline.html', 'renwu-anju-social-housing/index.html'];
const results = {
  ci: { githubSha: process.env.GITHUB_SHA || null, githubRef: process.env.GITHUB_REF || null,
    nodeVersion: process.version },
  source: { script: 'tests/donation/page-font-artifact.mjs', artifactRoot: artifact },
  artifactIdentity: null,
  head: { commit: process.env.GITHUB_SHA || null,
    githubRef: process.env.GITHUB_REF || null },
  runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch,
    chromiumVersion: null },
  preflight: { status: 'not-run' },
  samples: [], schemaRoutes: [], initialFontNetwork: { status: 'not-run', verification: 'not-evaluated',
    expectedRoutes: 464, routesChecked: 0,
    routes: [], fullTcInitialViolations: [], preloadViolations: [], navigationErrors: [],
    criticalRequestFailures: [], runtimeErrors: [], observationErrors: [] },
  serviceInitial: { status: 'not-run', errors: [] }, legacyRoutes: [], cmsPreview: { status: 'not-run' }, negativeGuards: {},
  visualCaptures: { status: 'not-run', seed: VISUAL_CAPTURE_SEED, expected: VISUAL_CAPTURE_COUNT,
    viewport: { width: 390, height: 844 }, selectedRoutes: [], records: [], errors: [] },
  execution: {
    status: 'running', currentPhase: null, primaryError: null, secondaryErrors: [],
    phases: {
      preflight: { status: 'not-run' },
      representativeSamples: { status: 'not-run', expected: samples.length, completed: 0 },
      schemaRoutes: { status: 'not-run', expected: schemaRoutes.length, completed: 0 },
      initialFontNetwork: { status: 'not-run', verification: 'not-evaluated', expected: 464, completed: 0 },
      crossMonth: { status: 'not-run' },
      dynamicSearch: { status: 'not-run' },
      legacyRoutes: { status: 'not-run', expected: legacyRoutes.length, completed: 0, currentRoute: null },
      cmsPreview: { status: 'not-run' },
      cmsNegativeGuards: { status: 'not-run', expected: 4, completed: 0, currentMode: null },
      topLevelCmsGuard: { status: 'not-run' },
      finalAssertions: { status: 'not-run' },
    },
  },
};
let browser;
let runError;
let cmsFullFontResponseWait;

function startPhase(name) {
  results.execution.currentPhase = name;
  results.execution.phases[name].status = 'running';
}

function completePhase(name) {
  results.execution.phases[name].status = 'completed';
  if (results.execution.currentPhase === name) results.execution.currentPhase = null;
}

function captureRunFailure(error, source = null) {
  const merged = preservePrimaryError(runError, error);
  runError = merged.primaryError;
  if (merged.secondaryError) results.execution.secondaryErrors.push({
    ...(source ? { source } : {}), ...errorRecord(merged.secondaryError),
  });
  if (!results.execution.primaryError) {
    results.fatalError = errorRecord(runError);
    results.execution.primaryError = errorRecord(runError);
    if (source) results.execution.primarySource = source;
  }
  results.execution.status = 'failed';
  const phaseName = results.execution.currentPhase;
  if (phaseName) {
    const phase = results.execution.phases[phaseName];
    if (phase.status === 'running') {
      phase.status = 'failed';
      phase.error = errorRecord(runError);
    }
  }
}

try {
  const preflight = await runPageFontArtifactPreflight({
    artifactRoot: artifact,
    fullTcPath,
    expectedBytes: 783820,
    reportPath,
    results,
  });
  publication = preflight.publication;
  fontManifest = preflight.fontManifest;
  fullTcSha = preflight.fullTcSha;
  const [publicationBytes, deploymentBytes] = await Promise.all([
    readFile(resolve(artifact, 'publication-manifest.json')),
    readFile(resolve(artifact, 'deployment.json')),
  ]);
  artifactIdentity = validateArtifactIdentity({
    deployment: JSON.parse(deploymentBytes.toString('utf8')),
    publicationBytes,
    expectedSourceCommit: process.env.GITHUB_SHA || null,
  });
  results.artifactIdentity = artifactIdentity;
  const legalRoutes = Object.keys(fontManifest.routes);
  assert.equal(legalRoutes.length, 464, 'visual selection requires the complete schema-2 route inventory');
  const visualRoutes = selectVisualRoutes(legalRoutes, {
    seed: VISUAL_CAPTURE_SEED,
    count: VISUAL_CAPTURE_COUNT,
  });
  const visualRouteSet = new Set(visualRoutes);
  results.visualCaptures.selectedRoutes = visualRoutes;
  results.visualCaptures.status = 'running';
  await mkdir(visualOutput, { recursive: true });

  browser = await chromium.launch({ headless: true });
  results.ci.chromiumVersion = await browser.version();
  results.runtime.chromiumVersion = results.ci.chromiumVersion;
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 } });
  const page = await context.newPage();
  const observedFullTc = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === `/${fullTcPath}`) observedFullTc.push(response.url());
  });

  startPhase('representativeSamples');
  for (const route of samples) {
    const routeRow = fontManifest.routes[route];
    assert.ok(routeRow, `missing manifest route: ${route}`);
    const commonCodepoint = fontManifest.fonts[routeRow.commonFont].codepoints.find((cp) => routeRow.codepoints.includes(cp));
    const deltaCodepoint = fontManifest.fonts[routeRow.deltaFont].codepoints.find((cp) => routeRow.codepoints.includes(cp));
    assert.ok(Number.isInteger(commonCodepoint) && Number.isInteger(deltaCodepoint), `${route}: no common/delta glyph sample`);
    const response = await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, route);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const expected = routeRow.preloads.map((path) => `/${path}`).sort();
    const state = await page.evaluate(async ({ common, delta, commonCodepoint, deltaCodepoint }) => {
      const core = await document.fonts.load('16px "Huiwen Sans TC Page Common"', String.fromCodePoint(commonCodepoint));
      const pageDelta = await document.fonts.load('16px "Huiwen Sans TC Page Delta"', String.fromCodePoint(deltaCodepoint));
      const footer = document.querySelector('footer');
      const heading = document.querySelector('main h1');
      return {
        preloads: performance.getEntriesByType('resource')
          .map((entry) => new URL(entry.name).pathname)
          .filter((path) => path.startsWith('/assets/fonts/huiwen-site-sans/page-'))
          .sort(),
        family: getComputedStyle(heading).fontFamily,
        rootFamily: getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family'),
        coreLoaded: core.some((font) => font.family === 'Huiwen Sans TC Page Common'),
        deltaLoaded: pageDelta.some((font) => font.family === 'Huiwen Sans TC Page Delta'),
        headingBox: heading.getBoundingClientRect().toJSON(),
        footerText: footer?.innerText || '',
        artifactRoute: document.documentElement.dataset.huiwenFontArtifactRoute || null,
      };
    }, {
      common: routeRow.commonFont,
      delta: routeRow.deltaFont,
      commonCodepoint,
      deltaCodepoint,
    });
    assert.deepEqual(state.preloads, expected, `${route}: first-view font preload closure`);
    assert.match(state.family, /Huiwen Sans TC Page Delta/);
    assert.match(state.rootFamily, /Huiwen Sans TC Page Common/);
    assert.equal(state.coreLoaded, true, `${route}: common font did not shape its glyph`);
    assert.equal(state.deltaLoaded, true, `${route}: delta font did not shape its glyph`);
    assert.ok(state.headingBox.width > 0 && state.headingBox.height > 0, `${route}: heading has no shape`);
    assert.equal(state.artifactRoute, route);

    const routeCodepoints = new Set(routeRow.codepoints);
    const footerCodepoints = [...state.footerText]
      .filter((char) => /[\p{L}\p{M}\p{N}]/u.test(char))
      .map((char) => char.codePointAt(0));
    assert.ok(footerCodepoints.length > 0, `${route}: footer has no readable text`);
    assert.ok(footerCodepoints.every((cp) => routeCodepoints.has(cp)), `${route}: footer glyph missing from subset`);

    await page.setViewportSize({ width: 640, height: 950 });
    await page.locator('html').evaluate((html) => { html.style.fontSize = '200%'; });
    const zoom = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headingWidth: document.querySelector('main h1').getBoundingClientRect().width,
      footerWidth: document.querySelector('footer').getBoundingClientRect().width,
      replacementGlyphs: (document.querySelector('main').innerText.match(/[\uFFFD\u25A1]/g) || []).length,
    }));
    assert.ok(zoom.headingWidth > 0 && zoom.footerWidth > 0, `${route}: 200% text has no shape`);
    assert.ok(zoom.scrollWidth <= zoom.width + 4, `${route}: 200% text causes horizontal page overflow`);
    assert.equal(zoom.replacementGlyphs, 0, `${route}: 200% text contains replacement glyphs`);
    await page.locator('html').evaluate((html) => { html.style.removeProperty('font-size'); });
    await page.setViewportSize({ width: 1365, height: 950 });
    results.samples.push({ route, preloads: state.preloads, footerGlyphs: footerCodepoints.length, zoom });
    results.execution.phases.representativeSamples.completed += 1;
  }
  completePhase('representativeSamples');

  startPhase('schemaRoutes');
  for (const route of schemaRoutes) {
    const routeRow = fontManifest.routes[route];
    assert.ok(routeRow, `missing schema-2 route: ${route}`);
    const response = await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, route);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const state = await page.evaluate(() => {
      const heading = document.querySelector('main h1');
      return {
        preloads: performance.getEntriesByType('resource')
          .map((entry) => new URL(entry.name).pathname)
          .filter((path) => path.startsWith('/assets/fonts/huiwen-site-sans/page-'))
          .sort(),
        rootFamily: getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family'),
        bodyFamily: getComputedStyle(document.body).fontFamily,
        headingFamily: heading ? getComputedStyle(heading).fontFamily : '',
        headingPresent: Boolean(heading),
        artifactRoute: document.documentElement.dataset.huiwenFontArtifactRoute || null,
      };
    });
    const expected = routeRow.preloads.map((path) => `/${path}`).sort();
    assert.deepEqual(state.preloads, expected, `${route}: schema-2 first-view preload closure`);
    assert.equal(state.artifactRoute, route);
    assert.ok(state.headingPresent, `${route}: missing page heading`);
    assert.match(state.rootFamily, /Huiwen Sans TC Page Common/);
    assert.match(state.headingFamily, /Huiwen Sans TC Page Delta/);
    if (route === 'offline.html') {
      assert.match(state.bodyFamily, /Huiwen Sans TC Page Delta/,
        'offline direct Huiwen Sans TC body family was not overridden by the artifact faces');
      assert.match(state.bodyFamily, /Huiwen Sans TC Page Common/,
        'offline body family did not retain the common fallback face');
    }
    results.schemaRoutes.push({ route, preloads: state.preloads, rootFamily: state.rootFamily,
      bodyFamily: state.bodyFamily, headingFamily: state.headingFamily });
    results.execution.phases.schemaRoutes.completed += 1;
  }
  completePhase('schemaRoutes');
  const fontOnlyRoutes = Object.keys(fontManifest.routes).sort();
  const fullTcInitialViolations = results.initialFontNetwork.fullTcInitialViolations;
  const fontOnlyStarted = performance.now();
  startPhase('initialFontNetwork');
  results.initialFontNetwork.status = 'running';
  for (const route of fontOnlyRoutes) {
    const routeRow = fontManifest.routes[route];
    const routeRecord = { route, navigation: { status: null }, fullTcRequests: [],
      preloads: { expected: routeRow.preloads.map((path) => `/${path}`).sort(),
        declared: [], observed: [], requests: [] }, visibleFontDiagnostics: null,
      navigationErrors: [], criticalRequestFailures: [], runtimeErrors: [], observationErrors: [] };
    let routeContext;
    let routePage;
    let cdpSession;
    let fixedClock = false;
    const routeNetwork = { phase: 'initial', fullTcRequests: [], pageFontRequests: [],
      navigationRequests: [], criticalRequestFailures: [], tracked: new Map(), mainFrameId: null };
    const fullTcResponses = [];
    try {
      routeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      routePage = await routeContext.newPage();
      if (route === 'service.html') {
        await routePage.clock.setFixedTime(new Date('2026-10-19T08:00:00+08:00'));
        fixedClock = true;
      }
      routePage.on('pageerror', (error) => routeRecord.runtimeErrors.push(errorRecord(error)));
      routePage.on('response', (response) => {
        if (urlPath(response.url()) === `/${fullTcPath}`)
          fullTcResponses.push({ phase: routeNetwork.phase, response });
      });
      cdpSession = await routeContext.newCDPSession(routePage);
      await cdpSession.send('Network.enable');
      await cdpSession.send('Page.enable');
      routeNetwork.mainFrameId = (await cdpSession.send('Page.getFrameTree')).frameTree.frame.id;
      cdpSession.on('Network.requestWillBeSent', (event) => {
        const path = urlPath(event.request.url);
        const type = event.type || 'unknown';
        const record = { path, requestType: type, phase: routeNetwork.phase,
          isMainFrame: event.frameId === routeNetwork.mainFrameId,
          initiator: requestInitiator(event.initiator) };
        if (path === `/${fullTcPath}`) routeNetwork.fullTcRequests.push(record);
        if (record.isMainFrame && type === 'Font' && path?.startsWith('/assets/fonts/huiwen-site-sans/page-'))
          routeNetwork.pageFontRequests.push(record);
        if (record.isMainFrame && type === 'Document') routeNetwork.navigationRequests.push(record);
        if (record.isMainFrame && ['Document', 'Font', 'Stylesheet', 'Script'].includes(type))
          routeNetwork.tracked.set(event.requestId, record);
      });
      cdpSession.on('Network.responseReceived', (event) => {
        const record = routeNetwork.tracked.get(event.requestId);
        if (!record) return;
        record.response = { status: event.response.status, mimeType: event.response.mimeType,
          fromDiskCache: Boolean(event.response.fromDiskCache),
          fromServiceWorker: Boolean(event.response.fromServiceWorker) };
        if (event.response.status >= 400) {
          const failure = { ...record, kind: 'http-status' };
          routeNetwork.criticalRequestFailures.push(failure);
        }
      });
      cdpSession.on('Network.loadingFailed', (event) => {
        const record = routeNetwork.tracked.get(event.requestId);
        if (!record) return;
        record.failure = { errorText: event.errorText, canceled: Boolean(event.canceled),
          blockedReason: event.blockedReason || null };
        routeNetwork.criticalRequestFailures.push({ ...record, kind: 'request-failed' });
      });

      let response;
      try {
        response = await routePage.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
        routeRecord.navigation.status = response?.status() ?? null;
        if (!response || response.status() !== 200) {
          routeRecord.navigationErrors.push({ kind: 'document-status', status: response?.status() ?? null });
        }
      } catch (error) {
        routeRecord.navigationErrors.push({ kind: 'navigation-exception', ...errorRecord(error) });
      }

      if (response) {
        try {
          await routePage.waitForFunction(() => {
            const header = document.querySelector('.site-header .nav-wrap');
            return !header || Boolean(header.querySelector('.global-search-trigger'));
          }, null, { timeout: 15000 });
        } catch (error) {
          routeRecord.observationErrors.push({ kind: 'dynamic-header-state', ...errorRecord(error) });
        }
        if (route === 'service.html') {
          try {
            await routePage.waitForFunction(() =>
              document.querySelector('.schedule-text table caption')?.textContent.includes('僅顯示尚未結束的場次'),
              null, { timeout: 15000 });
          } catch (error) {
            routeRecord.observationErrors.push({ kind: 'service-initial-state', ...errorRecord(error) });
          }
        }
        try {
          await routePage.evaluate(() => document.fonts.ready.then(() => true));
          routeRecord.visibleFontDiagnostics = await collectVisibleFontDiagnostics(routePage, route, routeRow);
          routeRecord.preloads.declared = routeRecord.visibleFontDiagnostics.declaredPreloads;
          routeRecord.preloads.observed = routeRecord.visibleFontDiagnostics.observedPreloads;
          const evidence = verifyPageFontPreloadEvidence({
            route,
            expected: routeRecord.preloads.expected,
            declared: routeRecord.preloads.declared,
            observed: routeRecord.preloads.observed,
            cdpRequests: routeNetwork.pageFontRequests,
            fixedClock,
          });
          routeRecord.preloads.verification = evidence.verification;
          routeRecord.preloads.cdpObserved = evidence.cdpObserved;
          routeRecord.preloads.domMatchesExpected = evidence.domMatchesExpected;
          routeRecord.preloads.cdpMatchesExpected = evidence.cdpMatchesExpected;
          if (!evidence.valid) results.initialFontNetwork.preloadViolations.push({
            route,
            expected: routeRecord.preloads.expected,
            declared: routeRecord.preloads.declared,
            observed: routeRecord.preloads.observed,
            cdpObserved: evidence.cdpObserved,
            verification: evidence.verification,
          });
        } catch (error) {
          routeRecord.observationErrors.push({ kind: 'font-dom-diagnostic', ...errorRecord(error) });
        }
      }

      if (visualRouteSet.has(route)) {
        routeRecord.visualCapture = { status: 'running' };
        routeNetwork.phase = 'visual-capture';
        try {
          assert.ok(response && response.status() === 200,
            `${route}: selected visual route did not return a successful page`);
          await routePage.evaluate(() => document.fonts.ready.then(() => true));
          const fontState = await routePage.evaluate(({ commonFamily, deltaFamily }) => {
            const heading = document.querySelector('main h1') || document.querySelector('h1') || document.body;
            const headingText = (heading?.textContent || '').trim();
            const relevantFaces = [...document.fonts]
              .filter((face) => [commonFamily, deltaFamily].includes(face.family))
              .map((face) => ({ family: face.family, weight: face.weight, style: face.style, status: face.status }));
            return {
              documentFontsStatus: document.fonts.status,
              bodyFontFamily: getComputedStyle(document.body).fontFamily,
              headingFontFamily: getComputedStyle(heading).fontFamily,
              fontFaces: relevantFaces,
              fontLoaded: {
                common: document.fonts.check(`16px "${commonFamily}"`, headingText),
                delta: document.fonts.check(`16px "${deltaFamily}"`, headingText),
              },
            };
          }, {
            commonFamily: fontManifest.fonts[routeRow.commonFont].family,
            deltaFamily: fontManifest.fonts[routeRow.deltaFont].family,
          });
          const viewport = routePage.viewportSize();
          assert.deepEqual(viewport, results.visualCaptures.viewport,
            `${route}: visual capture viewport changed during the font-only route sweep`);
          const pngBytes = await routePage.screenshot({ type: 'png', fullPage: false, caret: 'hide' });
          await routePage.evaluate(() => document.fonts.ready.then(() => true));
          await routePage.evaluate(() => new Promise((resolveFrame) =>
            requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
          const file = visualPngPath(visualOutput, route);
          await writeFile(file.path, pngBytes);
          const storedPng = await readFile(file.path);
          const captureNetwork = {
            phase: 'visual-capture',
            postCaptureFontLoadState: await routePage.evaluate(() => ({
              status: document.fonts.status,
              faces: [...document.fonts]
                .filter((face) => /Huiwen Sans TC Page (Common|Delta)/.test(face.family))
                .map((face) => ({ family: face.family, weight: face.weight, status: face.status })),
            })),
            initialFullTcRequestsBeforeCapture: routeNetwork.fullTcRequests
              .filter((item) => item.phase === 'initial').length,
            fullTcRequests: routeNetwork.fullTcRequests
              .filter((item) => item.phase === 'visual-capture')
              .map(({ path, requestType, initiator, response: fontResponse, failure }) => ({
                path, requestType, initiator, status: fontResponse?.status ?? null,
                failure: failure ? { category: browserMessageCategory(failure.errorText),
                  blockedReason: failure.blockedReason || null } : null,
              })),
            pageFontRequests: routeNetwork.pageFontRequests
              .filter((item) => item.phase === 'visual-capture')
              .map(({ path, requestType, initiator, response: fontResponse, failure }) => ({
                path, requestType, initiator, status: fontResponse?.status ?? null,
                failure: failure ? { category: browserMessageCategory(failure.errorText),
                  blockedReason: failure.blockedReason || null } : null,
              })),
          };
          const record = buildVisualCaptureRecord({
            route,
            pngBytes,
            artifactIdentity,
            viewport,
            typography: fontState,
            preloads: {
              expected: routeRecord.preloads.expected,
              declared: routeRecord.preloads.declared,
              observed: routeRecord.preloads.observed,
            },
            captureNetwork,
          });
          record.file = `visual/${file.fileName}`;
          assert.ok(visualPngMatchesHash(storedPng, record.png.sha256),
            `${route}: stored screenshot bytes do not match their recorded SHA-256`);
          results.visualCaptures.records.push(record);
          routeRecord.visualCapture = {
            status: 'captured', file: record.file, pngSha256: record.png.sha256,
            capturePhase: captureNetwork.phase,
            fullTcRequestsDuringCapture: captureNetwork.fullTcRequests.length,
            pageFontRequestsDuringCapture: captureNetwork.pageFontRequests.length,
          };
        } catch (error) {
          const failure = { route, ...errorRecord(error) };
          results.visualCaptures.errors.push(failure);
          routeRecord.visualCapture = { status: 'failed', error: errorRecord(error) };
          throw error;
        }
      }

      if (route === 'service.html' && response) {
        const initialFullTcRequests = routeNetwork.fullTcRequests.filter((item) => item.phase === 'initial').length;
        const card = { status: 'running', route, viewport: '390x844', fixedTaipeiDate: '2026-10-19',
          initialFullTcRequests, cardFullTcRequests: 0, totalFullTcRequests: 0,
          cardFullTcBytes: null, cardFullTcSha256: null, responsePhase: null,
          cardCanvasVisible: false, errors: [] };
        let cardFontResponse;
        const responseTimeout = initialFullTcRequests ? 3500 : 20000;
        const cardFontResponsePromise = routePage.waitForResponse((item) =>
          urlPath(item.url()) === `/${fullTcPath}` && item.status() === 200,
        { timeout: responseTimeout }).catch(() => null);
        routeNetwork.phase = 'service-card';
        try {
          await routePage.locator('[data-legal-view="card"]').click({ timeout: 15000 });
          cardFontResponse = await cardFontResponsePromise;
          if (!cardFontResponse) {
            cardFontResponse = fullTcResponses.find((item) => item.phase === 'initial' &&
              item.response.status() === 200)?.response;
            if (!cardFontResponse) card.errors.push({ kind: 'missing-font-response', message: 'service card produced no successful full-TC response' });
          }
          if (cardFontResponse) {
            const responsePhase = fullTcResponses.find((item) => item.response === cardFontResponse)?.phase || 'service-card';
            const cardFontBytes = await cardFontResponse.body();
            const observedSha = createHash('sha256').update(cardFontBytes).digest('hex');
            card.responsePhase = responsePhase;
            card.cardFullTcBytes = cardFontBytes.byteLength;
            card.cardFullTcSha256 = observedSha;
            if (cardFontResponse.status() !== 200) card.errors.push({ kind: 'font-http-status', status: cardFontResponse.status() });
            if (cardFontBytes.byteLength !== 783820) card.errors.push({ kind: 'font-byte-length', expected: 783820, observed: cardFontBytes.byteLength });
            if (observedSha !== fullTcSha) card.errors.push({ kind: 'font-sha256', expected: fullTcSha, observed: observedSha });
          }
          await routePage.locator('.legal-card-preview canvas').waitFor({ timeout: 15000 });
          card.cardCanvasVisible = true;
        } catch (error) {
          card.errors.push({ kind: 'card-activation', ...errorRecord(error) });
        }
        card.cardFullTcRequests = routeNetwork.fullTcRequests.filter((item) => item.phase === 'service-card').length;
        card.totalFullTcRequests = routeNetwork.fullTcRequests.length;
        if (initialFullTcRequests === 0 && card.cardFullTcRequests === 0)
          card.errors.push({ kind: 'missing-on-demand-request', message: 'legal-card activation did not request the full TC font' });
        card.status = card.errors.length === 0 ? 'passed' : 'failed';
        routeRecord.serviceCard = card;
        results.serviceInitial = card;
      } else if (route === 'service.html') {
        results.serviceInitial = { status: 'failed', errors: [{ kind: 'missing-service-response',
          message: 'service route did not return a document, so the legal-card check did not run' }] };
      }
    } catch (error) {
      routeRecord.observationErrors.push({ kind: 'route-sweep-exception', ...errorRecord(error) });
    } finally {
      routeRecord.fullTcRequests = routeNetwork.fullTcRequests;
      routeRecord.preloads.requests = routeNetwork.pageFontRequests;
      routeRecord.navigationErrors.push(...routeNetwork.navigationRequests
        .filter((item) => item.response && item.response.status !== 200)
        .map((item) => ({ kind: 'document-response', ...item })));
      routeRecord.criticalRequestFailures = routeNetwork.criticalRequestFailures;
      const initialRequests = routeNetwork.fullTcRequests.filter((item) => item.phase === 'initial');
      if (initialRequests.length) fullTcInitialViolations.push({ route, requests: initialRequests });
      if (cdpSession) {
        try { await cdpSession.detach(); } catch (error) {
          routeRecord.observationErrors.push({ kind: 'cdp-detach', ...errorRecord(error) });
        }
      }
      if (routeContext) {
        try { await routeContext.close(); } catch (error) {
          const record = { kind: 'context-close', ...errorRecord(error) };
          routeRecord.observationErrors.push(record);
          results.initialFontNetwork.observationErrors.push({ route, ...record });
        }
      }
      routeRecord.navigationErrors.forEach((error) =>
        results.initialFontNetwork.navigationErrors.push({ route, ...error }));
      routeRecord.criticalRequestFailures.forEach((error) =>
        results.initialFontNetwork.criticalRequestFailures.push({ route, ...error }));
      routeRecord.runtimeErrors.forEach((error) => results.initialFontNetwork.runtimeErrors.push({ route, ...error }));
      routeRecord.observationErrors.forEach((error) => results.initialFontNetwork.observationErrors.push({ route, ...error }));
      if (route === 'service.html' && results.serviceInitial.status === 'not-run') {
        results.serviceInitial = { status: 'failed', errors: [{ kind: 'service-card-check-incomplete',
          routeErrors: routeRecord.observationErrors }] };
      }
      results.initialFontNetwork.routes.push(routeRecord);
      results.initialFontNetwork.routesChecked = results.initialFontNetwork.routes.length;
      results.execution.phases.initialFontNetwork.completed = results.initialFontNetwork.routesChecked;
    }
  }
  results.initialFontNetwork.durationSeconds = Number(((performance.now() - fontOnlyStarted) / 1000).toFixed(2));
  results.initialFontNetwork.status = 'observed';
  completePhase('initialFontNetwork');
  results.visualCaptures.status = results.visualCaptures.records.length === VISUAL_CAPTURE_COUNT
    && results.visualCaptures.errors.length === 0 ? 'captured' : 'failed';
  results.visualCaptures.visualReview = 'not-performed';
  try {
    assert.equal(results.initialFontNetwork.routesChecked, 464, 'initial font-only sweep missed schema-2 routes');
    assert.deepEqual(fullTcInitialViolations, [], 'at least one of the 464 initial route visits requested full TC');
    assert.deepEqual(results.initialFontNetwork.preloadViolations, [], 'at least one route had a different first-view font preload closure');
    assert.deepEqual(results.initialFontNetwork.navigationErrors, [], 'at least one route had a navigation error');
    assert.deepEqual(results.initialFontNetwork.criticalRequestFailures, [], 'at least one route had a critical request failure');
    assert.deepEqual(results.initialFontNetwork.runtimeErrors, [], 'at least one route raised an uncaught page error');
    assert.deepEqual(results.initialFontNetwork.observationErrors, [], 'at least one route could not be fully diagnosed');
    results.initialFontNetwork.verification = 'passed';
    results.execution.phases.initialFontNetwork.verification = 'passed';
    results.initialFontNetwork.verificationEvaluation = { status: 'passed', assertions: 7 };
  } catch (error) {
    results.initialFontNetwork.verification = 'failed';
    results.execution.phases.initialFontNetwork.verification = 'failed';
    results.initialFontNetwork.verificationEvaluation = {
      status: 'failed', assertions: 7, error: errorRecord(error),
    };
  }

  startPhase('crossMonth');
  const crossMonthContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const crossMonthPage = await crossMonthContext.newPage();
    await crossMonthPage.clock.setFixedTime(new Date('2026-11-01T08:00:00+08:00'));
    const crossMonthFullTcRequests = [];
    crossMonthPage.on('request', (request) => {
      if (new URL(request.url()).pathname === `/${fullTcPath}`) crossMonthFullTcRequests.push(request.url());
    });
    await crossMonthPage.goto(new URL('service.html', base).href, { waitUntil: 'domcontentloaded' });
    await crossMonthPage.waitForFunction(() =>
      document.querySelector('[data-legal-month-state]')?.textContent.includes('此為2026年10月時間表'));
    await crossMonthPage.evaluate(() => document.fonts.ready.then(() => true));
    assert.deepEqual(crossMonthFullTcRequests, [],
      'the cross-month legal-calendar state requested the 783,820-byte full TC font');
    results.serviceCrossMonth = { route: 'service.html', viewport: '390x844', fixedTaipeiDate: '2026-11-01',
      initialFullTcRequests: crossMonthFullTcRequests.length };
  } finally {
    await crossMonthContext.close();
  }
  completePhase('crossMonth');
  assert.deepEqual(observedFullTc, [], 'initial representative page visits downloaded the 783,820-byte full TC font');

  startPhase('dynamicSearch');
  const searchPage = await context.newPage();
  await searchPage.setViewportSize({ width: 390, height: 844 });
  const searchFullTcResponses = [];
  searchPage.on('response', (response) => {
    if (new URL(response.url()).pathname === `/${fullTcPath}`) searchFullTcResponses.push(response);
  });
  await searchPage.goto(new URL('index.html', base).href, { waitUntil: 'domcontentloaded' });
  await searchPage.evaluate(() => document.fonts.ready);
  assert.deepEqual(searchFullTcResponses, [], 'full TC font loaded before dynamic search was opened');
  await searchPage.locator('.menu-toggle').click();
  await searchPage.waitForFunction(() => document.querySelector('.menu-toggle')?.getAttribute('aria-expanded') === 'true');
  await searchPage.locator('.global-search-trigger').click();
  await searchPage.locator('#global-search-dialog').waitFor({ state: 'visible' });
  await searchPage.locator('#global-search-dialog input[type="search"]').fill('文德國小');
  await searchPage.locator('.global-search-result').first().waitFor();
  await searchPage.evaluate(() => document.fonts.ready);
  const searchFontResponse = searchFullTcResponses.find((response) => response.status() === 200);
  assert.ok(searchFontResponse, 'dynamic search did not request the full TC font after activation');
  const searchFontBytes = await searchFontResponse.body();
  assert.equal(createHash('sha256').update(searchFontBytes).digest('hex'), fullTcSha,
    'dynamic search downloaded bytes that differ from the published full TC font');
  results.dynamicSearch = { triggered: true, fullTcBytes: searchFontBytes.byteLength,
    fullTcSha256: fullTcSha, firstResult: await searchPage.locator('.global-search-result').first().innerText() };
  await searchPage.close();
  completePhase('dynamicSearch');

  startPhase('legacyRoutes');
  for (const [route, expectedPage] of legacyRoutes) {
    results.execution.phases.legacyRoutes.currentRoute = route;
    const response = await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, route);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const pageData = await page.locator('html').getAttribute('data-huiwen-font-page');
    assert.equal(pageData, expectedPage, `${route}: existing nine-route font marker changed`);
    assert.equal(await page.locator('html').getAttribute('data-huiwen-font-artifact-route'), null, route);
    results.legacyRoutes.push({ route, fontPage: pageData });
    results.execution.phases.legacyRoutes.completed += 1;
  }
  results.execution.phases.legacyRoutes.currentRoute = null;
  completePhase('legacyRoutes');

  startPhase('cmsPreview');
  results.cmsPreview = { status: 'running' };
  const cmsRoute = 'achievement-wujia-public-parking.html';
  const cmsRow = fontManifest.routes[cmsRoute];
  const draftChar = '黑';
  assert.ok(!cmsRow.codepoints.includes(draftChar.codePointAt(0)), 'draft test glyph already exists in original route subset');
  const editorAsset = Object.keys(publication.files).find((path) => /^cms-page-editor\.[a-f0-9]{12}\.js$/.test(path));
  assert.ok(editorAsset, 'published CMS editor runtime missing');
  const session = 'g02-ci-page-preview-nonce';
  const accessAssertion = 'g02-ci-fixture-verified-owner-access-assertion';
  const nonce = 'g02-ci-preview-nonce';
  async function fetchPublishedPreview() {
    const upstream = await fetch(new URL(cmsRoute, base), {
      headers: { Accept: 'text/html', 'Cache-Control': 'no-cache, no-store' },
    });
    assert.equal(upstream.status, 200, 'authenticated preview proxy could not fetch the published artifact route');
    assert.match(upstream.headers.get('content-type') || '', /text\/html/, 'artifact service did not return HTML');
    const source = await upstream.text();
    return source
      .replace(/<head\b[^>]*>/i, (head) => `${head}<base href="https://www.huiwen.tw/${cmsRoute}">`)
      .replace(/<script\b(?=[^>]*\bdata-cms-editor-loader\b)[^>]*>/i, (tag) =>
        `${tag.slice(0, -1)} data-cms-editor-enabled="true" data-cms-page-path="${cmsRoute}" data-cms-admin-origin="https://admin.huiwen.tw">`);
  }
  const previewCsp = [
    "default-src 'none'", 'base-uri https://www.huiwen.tw',
    "script-src https://www.huiwen.tw 'unsafe-inline'", "style-src https://www.huiwen.tw 'unsafe-inline'",
    'img-src https://www.huiwen.tw https: data: blob:', 'font-src https://www.huiwen.tw data:',
    'connect-src https://www.huiwen.tw https://tile.openstreetmap.org',
    'frame-src https://www.huiwen.tw https://www.youtube.com https://www.youtube-nocookie.com https://www.facebook.com https://drive.google.com https://www.canva.com',
    'media-src https://www.huiwen.tw https: data: blob:', "object-src 'none'", "form-action 'none'",
    'frame-ancestors https://admin.huiwen.tw',
  ].join('; ');

  const cmsContext = await browser.newContext({ viewport: { width: 1365, height: 950 } });
  await cmsContext.route('https://www.huiwen.tw/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const localUrl = new URL(requestUrl.pathname.slice(1) + requestUrl.search, base).href;
    const upstream = await fetch(localUrl, { headers: { 'Accept-Encoding': 'identity' } });
    await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers), body: Buffer.from(await upstream.arrayBuffer()) });
  });
  await cmsContext.route('https://evil.test/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><script>let n=0;const t=setInterval(()=>{parent.frames[0].postMessage({type:'huiwen-cms-init',nonce:'forged'},'*');if(++n>30)clearInterval(t)},100)</script>`,
  }));

  async function installAdminRoutes(adminPage, mode) {
    await cmsContext.route('https://admin.huiwen.tw/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__g02/cms') {
        const cmsEdit = mode === 'wrong-cms-edit' ? '0' : '1';
        const previewPath = mode === 'wrong-path' ? 'index.html' : cmsRoute;
        const evilFrame = mode === 'unauthorized-message' ? '<iframe title="untrusted sender" src="https://evil.test/send"></iframe>' : '';
        const handshake = ['valid', 'wrong-cms-edit'].includes(mode)
          ? `const sendInit=()=>frame.contentWindow.postMessage({type:'huiwen-cms-init',nonce:'${nonce}'},'*');frame.onload=sendInit;window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!=='null')return;if(event.data?.type==='huiwen-cms-hello')sendInit();if(event.data?.type==='huiwen-cms-ready'&&event.data?.nonce==='${nonce}'&&!window.__draftSent){window.__draftSent=true;frame.contentWindow.postMessage({type:'huiwen-cms-case-preview',nonce:'${nonce}',case:{title:'CI草稿',updated:'2026-10-19',paragraphs:['CI草稿新增字：${draftChar}'],history:[],media:[]}},'*');}});`
          : '';
        return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><body>
          <iframe id="preview" title="CMS preview" sandbox="allow-scripts" src="/api/page-preview?path=${encodeURIComponent(previewPath)}&session=${session}&cmsEdit=${cmsEdit}"></iframe>
          ${evilFrame}<script>const frame=document.querySelector('#preview');${handshake}</script></body></html>` });
      }
      if (url.pathname === '/api/page-preview') {
        // Cloudflare Access injects this verified assertion at the edge before
        // the Worker calls security.owner(); the fixture models that boundary.
        const accessEdgeHeaders = mode === 'unauthenticated' ? {} : { 'cf-access-jwt-assertion': accessAssertion };
        const authorizedOwner = accessEdgeHeaders['cf-access-jwt-assertion'] === accessAssertion;
        const correctRoute = url.searchParams.get('path') === cmsRoute;
        const correctSession = url.searchParams.get('session') === session;
        const correctCapability = url.searchParams.get('cmsEdit') === '1';
        if (!authorizedOwner || !correctRoute || !correctSession || !correctCapability || !publication.files[cmsRoute])
          return route.fulfill({ status: 401, body: 'unauthorized preview' });
        return route.fulfill({
          status: 200, body: await fetchPublishedPreview(),
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'x-frame-options': 'SAMEORIGIN', 'content-security-policy': previewCsp },
        });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    });
  }

  const cmsPage = await cmsContext.newPage();
  const isCmsProxyUrl = (value) => {
    try {
      const url = new URL(value);
      return url.origin === 'https://admin.huiwen.tw' && url.pathname === '/api/page-preview';
    } catch {
      return false;
    }
  };
  const cmsProxyRequests = [];
  const cmsProxyResponses = [];
  const cmsProxyBlockedReasons = [];
  const cmsBrowserMessages = [];
  cmsPage.on('request', (request) => {
    if (isCmsProxyUrl(request.url())) cmsProxyRequests.push({ method: request.method(), ...safeUrlSummary(request.url()) });
  });
  cmsPage.on('response', (response) => {
    if (isCmsProxyUrl(response.url())) cmsProxyResponses.push({ status: response.status(), ...safeUrlSummary(response.url()) });
  });
  cmsPage.on('requestfailed', (request) => {
    if (!isCmsProxyUrl(request.url())) return;
    const category = browserMessageCategory(request.failure()?.errorText);
    cmsProxyBlockedReasons.push(category);
  });
  cmsPage.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return;
    cmsBrowserMessages.push({ type: message.type(), category: browserMessageCategory(message.text()) });
  });
  cmsPage.on('pageerror', (error) => {
    cmsBrowserMessages.push({ type: 'pageerror', name: error?.name || 'Error',
      category: browserMessageCategory(error?.message) });
  });
  cmsFullFontResponseWait = observePendingResult(cmsPage.waitForResponse((response) =>
    new URL(response.url()).pathname === `/${fullTcPath}` && response.status() === 200));
  await installAdminRoutes(cmsPage, 'valid');
  const cmsProxyNavigation = waitForCmsPreviewNavigation(cmsPage);
  let cmsHostResponse;
  let cmsProxyFrame;
  try {
    cmsHostResponse = await cmsPage.goto('https://admin.huiwen.tw/__g02/cms', { waitUntil: 'domcontentloaded' });
    assert.equal(cmsHostResponse?.status(), 200, 'CMS fixture host route did not return HTTP 200');
    const navigation = await cmsProxyNavigation;
    if (navigation.error) throw navigation.error;
    cmsProxyFrame = navigation.frame;
    await cmsPage.frameLocator('#preview').locator('html').waitFor({ state: 'attached', timeout: 15000 });
    await cmsProxyFrame.waitForLoadState('domcontentloaded', { timeout: 15000 });
    const proxyUrl = new URL(cmsProxyFrame.url());
    assert.equal(proxyUrl.origin, 'https://admin.huiwen.tw', 'CMS proxy frame navigated on an unexpected host');
    assert.equal(proxyUrl.pathname, '/api/page-preview', 'CMS proxy frame navigated to an unexpected path');
    assert.equal(proxyUrl.searchParams.get('path'), cmsRoute, 'CMS proxy frame requested an unexpected public route');
    assert.equal(proxyUrl.searchParams.get('cmsEdit'), '1', 'CMS proxy request did not carry its edit capability');
    if (proxyUrl.searchParams.get('session') !== session)
      throw new Error('CMS proxy request did not carry the fixture session');
    const proxyResponse = cmsProxyResponses.at(-1);
    assert.ok(proxyResponse, 'CMS proxy frame navigation produced no response');
    assert.equal(proxyResponse.status, 200, 'authenticated CMS proxy route was denied or failed');
    await cmsProxyFrame.waitForFunction(() => document.documentElement.dataset.huiwenFontArtifactPreview === '1', null, { timeout: 15000 });
    await cmsProxyFrame.waitForFunction((text) => document.querySelector('.case-background')?.innerText.includes(text), draftChar, { timeout: 15000 });
  } catch (error) {
    results.cmsPreview.failureSnapshot = cmsFailureSnapshot({
      page: cmsPage,
      hostNavigationStatus: cmsHostResponse?.status() ?? null,
      proxyRequests: cmsProxyRequests,
      proxyResponses: cmsProxyResponses,
      blockedReasons: cmsProxyBlockedReasons,
      messages: cmsBrowserMessages,
    });
    throw error;
  }
  const frame = cmsProxyFrame;
  results.cmsPreview.proxyNavigation = {
    hostUrl: safeUrlSummary(cmsPage.url()),
    hostStatus: cmsHostResponse.status(),
    frameUrl: safeUrlSummary(frame.url()),
    proxyStatus: cmsProxyResponses.at(-1)?.status ?? null,
  };
  const fullFontResponseOutcome = await cmsFullFontResponseWait;
  results.cmsPreview.fullFontResponseWait = { status: fullFontResponseOutcome.status,
    error: fullFontResponseOutcome.status === 'rejected' ? errorRecord(fullFontResponseOutcome.error) : null };
  const loadedFullFont = requireObservedValue(fullFontResponseOutcome);
  const loadedBytes = await loadedFullFont.body();
  assert.equal(createHash('sha256').update(loadedBytes).digest('hex'), fullTcSha, 'CMS proxy did not download the published full TC font bytes');
  const cmsState = await frame.evaluate((text) => {
    const main = document.querySelector('.case-background');
    const family = getComputedStyle(main.querySelector('p')).fontFamily;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `16px ${family}`;
    return {
      marker: document.documentElement.dataset.huiwenFontArtifactPreview,
      text: main.innerText,
      family,
      fontLoaded: document.fonts.check('16px "Huiwen Sans TC"', text),
      glyphWidth: context.measureText(text).width,
      tofu: /[\uFFFD\u25A1]/.test(main.innerText),
    };
  }, draftChar);
  assert.equal(cmsState.marker, '1');
  assert.ok(cmsState.text.includes(draftChar), 'CMS draft-only TC glyph was dropped');
  assert.match(cmsState.family, /Huiwen Sans TC/);
  assert.equal(cmsState.fontLoaded, true);
  assert.ok(cmsState.glyphWidth > 0);
  assert.equal(cmsState.tofu, false);
  results.cmsPreview = { ...results.cmsPreview, route: cmsRoute, access: 'verified owner assertion fixture', draftChar,
    fontBytes: loadedBytes.byteLength, fontSha256: fullTcSha, ...cmsState };
  await cmsContext.close();
  results.cmsPreview.status = 'passed';
  completePhase('cmsPreview');

  startPhase('cmsNegativeGuards');
  for (const mode of ['unauthenticated', 'wrong-path', 'wrong-cms-edit', 'unauthorized-message']) {
    results.execution.phases.cmsNegativeGuards.currentMode = mode;
    const negativeContext = await browser.newContext();
    await negativeContext.route('https://www.huiwen.tw/**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const upstream = await fetch(new URL(requestUrl.pathname.slice(1) + requestUrl.search, base));
      await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers), body: Buffer.from(await upstream.arrayBuffer()) });
    });
    await negativeContext.route('https://evil.test/**', (route) => route.fulfill({
      status: 200, contentType: 'text/html',
      body: `<!doctype html><script>let n=0;const t=setInterval(()=>{parent.frames[0].postMessage({type:'huiwen-cms-init',nonce:'${nonce}'},'*');parent.frames[0].postMessage({type:'huiwen-cms-case-preview',nonce:'${nonce}',case:{title:'UNAUTHORIZED DRAFT',paragraphs:['${draftChar}'],history:[],media:[]}},'*');if(++n>30)clearInterval(t)},100)</script>`,
    }));
    await negativeContext.route('https://admin.huiwen.tw/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__g02/cms') {
        const cmsEdit = mode === 'wrong-cms-edit' ? '0' : '1';
        const previewPath = mode === 'wrong-path' ? 'index.html' : cmsRoute;
        const sender = mode === 'unauthorized-message' ? '<iframe title="untrusted sender" src="https://evil.test/send"></iframe>' : '';
        return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><body>
          <iframe id="preview" title="CMS preview" sandbox="allow-scripts" src="/api/page-preview?path=${encodeURIComponent(previewPath)}&session=${session}&cmsEdit=${cmsEdit}"></iframe>${sender}</body>` });
      }
      if (url.pathname === '/api/page-preview') {
        // This negative route models Access denying the request before the Worker.
        if (mode === 'unauthenticated') return route.fulfill({ status: 401, body: 'unauthorized preview' });
        if (url.searchParams.get('path') !== cmsRoute
          || url.searchParams.get('session') !== session
          || url.searchParams.get('cmsEdit') !== '1')
          return route.fulfill({ status: 401, body: 'unauthorized preview' });
        return route.fulfill({ status: 200, body: await fetchPublishedPreview(),
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'x-frame-options': 'SAMEORIGIN', 'content-security-policy': previewCsp },
        });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    });
    const negativePage = await negativeContext.newPage();
    const negativeProxyNavigation = waitForCmsPreviewNavigation(negativePage);
    await negativePage.goto('https://admin.huiwen.tw/__g02/cms', { waitUntil: 'domcontentloaded' });
    const negativeNavigation = await negativeProxyNavigation;
    if (negativeNavigation.error) throw negativeNavigation.error;
    const negativeFrame = negativeNavigation.frame;
    await negativePage.frameLocator('#preview').locator('html').waitFor({ state: 'attached', timeout: 15000 });
    await negativeFrame.waitForLoadState('domcontentloaded');
    if (mode === 'unauthorized-message') {
      await negativeFrame.waitForFunction(() => Boolean(document.querySelector('script[data-cms-editor-runtime]')),
        null, { timeout: 15000 });
    }
    await negativePage.waitForTimeout(700);
    const state = await negativeFrame.evaluate(() => ({
      marker: document.documentElement.dataset.huiwenFontArtifactPreview || null,
      unauthorizedDraft: document.body.innerText.includes('UNAUTHORIZED DRAFT'),
      editorRuntime: Boolean(document.querySelector('script[data-cms-editor-runtime]')),
    }));
    if (mode === 'unauthenticated') {
      assert.equal(state.marker, null, 'an unauthenticated request unexpectedly enabled preview font mode');
      assert.equal(state.editorRuntime, false, 'an unauthenticated request loaded the CMS runtime');
    } else if (mode === 'wrong-path') {
      assert.equal(state.marker, null, 'an unexpected route path enabled preview font mode');
      assert.equal(state.editorRuntime, false, 'an unexpected route path loaded the CMS runtime');
    } else if (mode === 'wrong-cms-edit') {
      assert.equal(state.marker, null, 'cmsEdit=0 unexpectedly enabled preview font mode');
      assert.equal(state.editorRuntime, false, 'cmsEdit=0 loaded the CMS runtime');
    } else {
      assert.equal(state.unauthorizedDraft, false, 'untrusted postMessage changed the CMS preview');
      assert.equal(state.marker, '1', 'cmsEdit=1 in the authenticated iframe did not set the preview marker');
      assert.equal(state.editorRuntime, true, 'the iframe did not load its guarded CMS runtime');
    }
    results.negativeGuards[mode] = state;
    if (mode === 'wrong-path') {
      const unknownRouteResponse = await negativePage.goto('https://admin.huiwen.tw/__g02/unrecognized');
      assert.equal(unknownRouteResponse?.status(), 404, 'unrecognized CMS handler path did not fail closed');
      assert.equal((await negativePage.locator('body').innerText()).trim(), 'not found',
        'unrecognized CMS handler path returned unexpected content');
      results.negativeGuards.handlerFailClosed = { status: unknownRouteResponse.status(), body: 'not found' };
    }
    await negativeContext.close();
    results.execution.phases.cmsNegativeGuards.completed += 1;
  }
  results.execution.phases.cmsNegativeGuards.currentMode = null;
  completePhase('cmsNegativeGuards');

  startPhase('topLevelCmsGuard');
  const topLevelPage = await context.newPage();
  const topLevelRequests = [];
  topLevelPage.on('request', (request) => topLevelRequests.push(request.url()));
  await topLevelPage.goto(new URL(`${cmsRoute}?cmsEdit=1`, base).href, { waitUntil: 'domcontentloaded' });
  await topLevelPage.waitForTimeout(300);
  assert.equal(await topLevelPage.locator('html').getAttribute('data-huiwen-font-artifact-preview'), null,
    'top-level cmsEdit=1 unexpectedly enabled CMS preview');
  assert.equal(topLevelRequests.some((url) => new URL(url).pathname === `/${editorAsset}`), false,
    'top-level cmsEdit=1 downloaded the CMS runtime');
  results.negativeGuards.topLevel = { marker: null, editorRuntimeRequested: false };
  completePhase('topLevelCmsGuard');

  startPhase('finalAssertions');
  try {
    assert.equal(results.visualCaptures.status, 'captured', 'the 20-route visual capture set did not complete');
    assert.equal(results.visualCaptures.records.length, VISUAL_CAPTURE_COUNT,
      'the visual capture set does not contain exactly 20 real page screenshots');
    assert.equal(new Set(results.visualCaptures.records.map((record) => record.route)).size, VISUAL_CAPTURE_COUNT,
      'the visual capture set contains duplicate routes');
    assert.deepEqual(results.visualCaptures.errors, [], 'at least one selected visual page could not be captured');
    assert.equal(results.initialFontNetwork.routesChecked, 464, 'initial font-only sweep missed schema-2 routes');
    assert.deepEqual(fullTcInitialViolations, [], 'at least one of the 464 initial route visits requested full TC');
    assert.deepEqual(results.initialFontNetwork.preloadViolations, [], 'at least one route had a different first-view font preload closure');
    assert.deepEqual(results.initialFontNetwork.navigationErrors, [], 'at least one route had a navigation error');
    assert.deepEqual(results.initialFontNetwork.criticalRequestFailures, [], 'at least one route had a critical request failure');
    assert.deepEqual(results.initialFontNetwork.runtimeErrors, [], 'at least one route raised an uncaught page error');
    assert.deepEqual(results.initialFontNetwork.observationErrors, [], 'at least one route could not be fully diagnosed');
    results.initialFontNetwork.verification = 'passed';
    results.execution.phases.initialFontNetwork.verification = 'passed';
  } catch (error) {
    results.initialFontNetwork.verification = 'failed';
    results.execution.phases.initialFontNetwork.verification = 'failed';
    throw error;
  }
  assert.equal(results.serviceInitial.status, 'passed', 'service-card check did not complete successfully');
  assert.deepEqual(results.serviceInitial.errors, [], 'service-card font bytes or on-demand behavior failed');

  await context.close();
  completePhase('finalAssertions');
} catch (error) {
  captureRunFailure(error);
} finally {
  if (browser) {
    try { await browser.close(); } catch (error) {
      results.browserCloseError = errorRecord(error);
      captureRunFailure(error, 'browser-close');
    }
  }
  if (cmsFullFontResponseWait) {
    const outcome = await cmsFullFontResponseWait;
    results.cmsPreview.fullFontResponseWait = { status: outcome.status,
      error: outcome.status === 'rejected' ? errorRecord(outcome.error) : null };
    if (outcome.status === 'rejected') captureRunFailure(outcome.error, 'cms-full-font-response-wait');
  }
  if (results.cmsPreview.status === 'running') {
    results.cmsPreview.status = runError ? 'failed' : 'incomplete';
    if (runError) results.cmsPreview.error = errorRecord(runError);
  }
  if (results.initialFontNetwork.status === 'running') {
    results.initialFontNetwork.status = runError ? 'failed' : 'incomplete';
  }
  for (const phase of Object.values(results.execution.phases)) {
    if (phase.status === 'running') {
      phase.status = runError ? 'failed' : 'incomplete';
      if (runError) phase.error ||= errorRecord(runError);
    }
  }
  results.execution.currentPhase = results.execution.currentPhase || null;
  results.execution.status = runError ? 'failed' : 'passed';
  if (runError && !results.execution.primaryError) results.execution.primaryError = errorRecord(runError);
  try {
    await writePageFontArtifactReport(reportPath, results);
  } catch (error) {
    results.reportWriteError = errorRecord(error);
    if (!runError) runError = error;
  }
}
if (runError) throw runError;
console.log(JSON.stringify({ samples: results.samples.length, schemaRoutes: results.schemaRoutes.length,
  allRouteFontChecks: results.initialFontNetwork.routesChecked,
  allRouteFontSeconds: results.initialFontNetwork.durationSeconds,
  visualCaptures: results.visualCaptures.records.length,
  serviceInitialFullTcRequests: results.serviceInitial.initialFullTcRequests,
  serviceCardFullTcBytes: results.serviceInitial.cardFullTcBytes,
  serviceCrossMonthFullTcRequests: results.serviceCrossMonth.initialFullTcRequests,
  legacyRoutes: results.legacyRoutes.length,
  cmsFontBytes: results.cmsPreview.fontBytes, negativeGuards: Object.keys(results.negativeGuards) }));
