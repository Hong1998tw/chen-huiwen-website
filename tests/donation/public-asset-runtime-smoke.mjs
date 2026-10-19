import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleFingerprintInventory,
  assembleMutableAliasResource,
  assemblePublishedResource,
  bindProductionPublicArtifactProvenance,
  bindPublicArtifactProvenance,
  fingerprintAlias,
  LOCAL_CI_MODE,
  normalizeBaseUrl,
  parseHeaderRules,
  PLAYWRIGHT_VERSION,
  PRODUCTION_LIVE_MODE,
  selectSharedCommonFont,
  sha256,
  sha256 as digestBytes,
  validateArtifactResponse,
  validateColdWarmCacheProof,
  validateMutableAliasObservation,
} from './public-asset-runtime-proof.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifactRoot = resolve(root, '_site');
const outputDir = resolve(root, 'tests/donation/results/public-asset-runtime');
const reportPath = resolve(outputDir, 'report.json');
const failurePath = resolve(outputDir, 'failure.json');
const NAVIGATION_TIMEOUT_MS = 20000;
const RESOURCE_TIMEOUT_MS = 12000;
const report = {
  schemaVersion: 1,
  status: 'RUNNING',
  scope: 'Bounded native browser proof of public fingerprint caching and the published map runtime',
  startedAt: new Date().toISOString(),
  mode: process.env.PUBLIC_ASSET_RUNTIME_MODE || LOCAL_CI_MODE,
  baseUrl: null,
  proofConstraints: {
    serviceWorkers: 'block',
    requestRouting: false,
    snapshotNormalization: false,
    tlsVerification: 'runtime defaults; no bypass',
    liveReceiptSource: process.env.PUBLIC_ASSET_RUNTIME_MODE === PRODUCTION_LIVE_MODE ? 'HTTP GET /deployment.json' : null,
  },
  sourceCi: {
    eventName: process.env.GITHUB_EVENT_NAME || null,
    mergeSha: process.env.GITHUB_SHA || null,
    pullRequestHeadSha: process.env.PR_HEAD_SHA || null,
    githubSha: process.env.GITHUB_SHA || null,
    githubRef: process.env.GITHUB_REF || null,
    nativeEventPath: process.env.GITHUB_EVENT_PATH || null,
    checkoutSha: null,
    checkoutShaContract: null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  },
  publicArtifact: null,
  runtime: null,
  provenance: null,
  cacheProof: { status: 'NOT_RUN', assets: [], mutableAliases: [], interaction: null },
  mapProof: { status: 'NOT_RUN', assets: [], runtime: null, mapData: null },
  diagnostics: { pages: [] },
  failures: [],
  primaryError: null,
  cleanupErrors: [],
};
const allJournals = [];

function errorRecord(error) {
  const message = String(error?.message || error).split(/\r?\nCall log:/, 1)[0];
  return { name: String(error?.name || 'Error').slice(0, 100), message: message.slice(0, 1200) };
}

function safeRelativePath(relative) {
  assert.ok(typeof relative === 'string' && relative.length > 0, 'artifact path is missing');
  assert.ok(!relative.startsWith('/') && !relative.includes('\\') && !relative.split('/').includes('..'),
    `unsafe artifact path: ${relative}`);
}

async function readArtifact(relative) {
  safeRelativePath(relative);
  let target = artifactRoot;
  const rootStat = await lstat(artifactRoot);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), '_site is missing or unsafe');
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    target = resolve(target, parts[index]);
    const stat = await lstat(target);
    assert.ok(!stat.isSymbolicLink(), `artifact path contains a symlink: ${relative}`);
    if (index < parts.length - 1) assert.ok(stat.isDirectory(), `artifact parent is not a directory: ${relative}`);
    else assert.ok(stat.isFile(), `artifact file is missing: ${relative}`);
  }
  return readFile(target);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadArtifactInputs() {
  const [publicationManifestBytes, deploymentBytes, headerBytes, fontManifestBytes] = await Promise.all([
    readArtifact('publication-manifest.json'), readArtifact('deployment.json'), readArtifact('_headers'),
    readArtifact('page-font-manifest.json'),
  ]);
  const publication = JSON.parse(publicationManifestBytes.toString('utf8'));
  const deployment = JSON.parse(deploymentBytes.toString('utf8'));
  const fontManifest = JSON.parse(fontManifestBytes.toString('utf8'));
  assert.equal(publication.version, 1, 'public artifact manifest version is unexpected');
  assert.equal(publication.files?.['page-font-manifest.json'], sha256(fontManifestBytes),
    'page-font manifest is not bound by the public publication manifest');
  const headerRules = parseHeaderRules(headerBytes.toString('utf8'));
  const fingerprintPaths = Object.keys(publication.files).filter((path) => fingerprintAlias(path));
  const sharedFontPath = selectSharedCommonFont(fontManifest, 'service.html', 'service-guides.html');
  assert.equal(fontManifest.fonts[sharedFontPath]?.sha256, publication.files[sharedFontPath],
    'common font page-font digest differs from publication ownership');
  const wantedPaths = new Set([
    ...fingerprintPaths,
    sharedFontPath,
    'styles.css', 'site.js', 'map.css', 'map.js',
    'assets/vendor/leaflet.css', 'assets/vendor/leaflet.js',
  ]);
  const byteMap = new Map();
  await Promise.all([...wantedPaths].map(async (path) => byteMap.set(path, await readArtifact(path))));
  const fingerprintInventory = assembleFingerprintInventory({ publication, byteMap, headerRules });
  const cacheAssets = ['styles.css', 'site.js'].map((alias) => {
    const asset = fingerprintInventory.byAlias.get(alias);
    assert.ok(asset, `required shared fingerprint asset is not owned: ${alias}`);
    return asset;
  });
  const mapAssets = ['map.css', 'map.js', 'assets/vendor/leaflet.css', 'assets/vendor/leaflet.js'].map((alias) => {
    const asset = fingerprintInventory.byAlias.get(alias);
    assert.ok(asset, `required map fingerprint asset is not owned: ${alias}`);
    return asset;
  });
  const commonFont = assemblePublishedResource({
    relativePath: sharedFontPath,
    publication,
    byteMap,
    headerRules,
    expectedHeaderPattern: `/${dirname(sharedFontPath).replaceAll('\\', '/') }/*`,
  });
  const mutableAliases = ['styles.css', 'site.js'].map((alias) =>
    assembleMutableAliasResource({ alias, publication, byteMap, headerRules }));
  return {
    publication,
    publicationManifestBytes,
    deployment,
    deploymentBytes,
    fontManifest,
    headerRules,
    byteMap,
    fingerprintInventory,
    cacheAssets: [...cacheAssets, commonFont],
    mapAssets,
    mutableAliases,
  };
}

function readCheckoutSha() {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.match(sha, /^[a-f0-9]{40}$/, 'checked out Git HEAD is missing or invalid');
  return sha;
}

async function observeLiveDeploymentReceipt(base) {
  const requestedUrl = new URL('deployment.json', base).href;
  const response = await fetch(requestedUrl, {
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(12000),
  });
  return {
    url: response.url,
    requestedUrl,
    status: response.status,
    headers: safeHeaders(Object.fromEntries(response.headers.entries())),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function pathFromUrl(value) {
  try {
    const url = new URL(value);
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return { origin: null, pathname: null };
  }
}

function safeHeaders(headers = {}) {
  const allow = ['cache-control', 'content-type', 'content-length', 'etag', 'age', 'cf-cache-status'];
  const normalized = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
  return Object.fromEntries(allow.filter((name) => normalized[name] !== undefined).map((name) => [name, normalized[name]]));
}

function attachJournal(page, cdp, trackedPaths) {
  const network = new Map();
  const responses = [];
  const pageErrors = [];
  const requestFailures = [];
  const getNetworkRecord = (requestId) => {
    if (!network.has(requestId)) network.set(requestId, { requestId, url: null, response: null, terminal: null });
    return network.get(requestId);
  };
  cdp.on('Network.requestWillBeSent', (event) => {
    const record = getNetworkRecord(event.requestId);
    record.url = event.request.url;
    record.method = event.request.method;
    record.requestType = event.type || null;
  });
  cdp.on('Network.responseReceived', (event) => {
    const record = getNetworkRecord(event.requestId);
    record.url = event.response.url || record.url;
    record.response = event.response;
    record.requestType = event.type || record.requestType;
  });
  cdp.on('Network.requestServedFromCache', (event) => {
    getNetworkRecord(event.requestId).requestServedFromCache = true;
  });
  cdp.on('Network.loadingFinished', (event) => {
    const record = getNetworkRecord(event.requestId);
    record.terminal = 'finished';
    record.encodedDataLength = event.encodedDataLength;
  });
  cdp.on('Network.loadingFailed', (event) => {
    const record = getNetworkRecord(event.requestId);
    record.terminal = 'failed';
    record.failure = event.errorText || 'request failed';
  });
  page.on('response', (response) => {
    const parsed = pathFromUrl(response.url());
    if (!trackedPaths.has(parsed.pathname)) return;
    const entry = {
      url: response.url(),
      path: parsed.pathname,
      browserStatus: response.status(),
      browserHeaders: safeHeaders(response.headers()),
      resourceType: response.request().resourceType(),
      method: response.request().method(),
      bodyPromise: response.body().then((body) => ({
        bodyBytes: body.byteLength,
        bodySha256: sha256(body),
      })).catch((error) => ({ bodyError: errorRecord(error) })),
    };
    responses.push(entry);
  });
  page.on('pageerror', (error) => pageErrors.push(errorRecord(error)));
  page.on('requestfailed', (request) => {
    const parsed = pathFromUrl(request.url());
    requestFailures.push({
      origin: parsed.origin,
      pathname: parsed.pathname,
      resourceType: request.resourceType(),
      method: request.method(),
      error: String(request.failure()?.errorText || 'request failed').slice(0, 300),
    });
  });
  const journal = { network, responses, pageErrors, requestFailures, route: null };
  allJournals.push(journal);
  return journal;
}

async function createInstrumentedPage(browser, { viewport, cacheEnabled = false, trackedPaths }) {
  // Playwright's native BrowserContext option is 'block'; this leaves service workers unable to intercept requests.
  const context = await browser.newContext({ viewport, locale: 'zh-TW', serviceWorkers: 'block' });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: !cacheEnabled });
  const journal = attachJournal(page, cdp, trackedPaths);
  return { context, page, cdp, journal };
}

async function assertNoServiceWorkerController(page, route) {
  const worker = await page.evaluate(() => ({
    supported: Boolean(navigator.serviceWorker),
    controller: navigator.serviceWorker?.controller?.scriptURL || null,
  }));
  assert.equal(worker.controller, null, `${route}: page is controlled by a service worker`);
  return worker;
}

async function waitForRouteAndFonts(page, route, base, expectedPaths) {
  const response = await page.goto(new URL(route, base).href, {
    waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS,
  });
  assert.equal(response?.status(), 200, `${route}: navigation did not return HTTP 200`);
  await page.locator('html.menu-ready').waitFor({ timeout: 10000 });
  await withTimeout(page.evaluate(() => document.fonts.ready.then(() => true)), 10000, `${route}: document.fonts.ready`);
  await page.waitForFunction((paths) => paths.every((path) => performance.getEntriesByType('resource')
    .some((entry) => {
      try { return new URL(entry.name).pathname === path; } catch { return false; }
    })), expectedPaths, { timeout: RESOURCE_TIMEOUT_MS });
  const worker = await assertNoServiceWorkerController(page, route);
  return { status: response.status(), url: response.url(), worker };
}

async function observeResource(page, journal, asset, base) {
  const expectedUrl = new URL(asset.path, base).href;
  await page.waitForFunction((path) => performance.getEntriesByType('resource').some((entry) => {
    try { return new URL(entry.name).pathname === path; } catch { return false; }
  }), asset.path, { timeout: RESOURCE_TIMEOUT_MS });
  const responseEntries = journal.responses.filter((entry) => entry.path === asset.path);
  assert.ok(responseEntries.length > 0, `${asset.path}: browser produced no response event`);
  const browserEntry = responseEntries.at(-1);
  assert.equal(browserEntry.url, expectedUrl, `${asset.path}: response URL differs`);
  assert.equal(browserEntry.method, 'GET', `${asset.path}: method differs`);
  const body = await withTimeout(browserEntry.bodyPromise, RESOURCE_TIMEOUT_MS, `${asset.path}: response body`);
  assert.ok(!body.bodyError, `${asset.path}: response body read failed`);
  const networkEntries = [...journal.network.values()].filter((entry) => pathFromUrl(entry.url).pathname === asset.path);
  const cdpEntry = networkEntries.at(-1) || null;
  const cdpResponse = cdpEntry?.response || {};
  const timing = await page.evaluate((path) => {
    const entries = performance.getEntriesByType('resource').filter((entry) => {
      try { return new URL(entry.name).pathname === path; } catch { return false; }
    });
    const entry = entries.at(-1);
    return entry ? {
      name: entry.name,
      transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
      encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
      decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
    } : null;
  }, asset.path);
  assert.ok(timing, `${asset.path}: Resource Timing entry is missing`);
  const mergedHeaders = { ...browserEntry.browserHeaders, ...safeHeaders(cdpResponse.headers || {}) };
  return {
    url: cdpResponse.url || browserEntry.url,
    status: Number.isFinite(cdpResponse.status) ? cdpResponse.status : browserEntry.browserStatus,
    browserStatus: browserEntry.browserStatus,
    resourceType: browserEntry.resourceType,
    headers: mergedHeaders,
    fromDiskCache: cdpResponse.fromDiskCache === true,
    fromServiceWorker: cdpResponse.fromServiceWorker === true,
    requestServedFromCache: networkEntries.some((entry) => entry.requestServedFromCache === true),
    encodedDataLength: cdpEntry?.encodedDataLength ?? null,
    terminal: cdpEntry?.terminal ?? null,
    protocolStatus: Number.isFinite(cdpResponse.status) ? cdpResponse.status : null,
    transferSize: timing.transferSize,
    resourceTiming: timing,
    bodyBytes: body.bodyBytes,
    bodySha256: body.bodySha256,
  };
}

async function probeMutableAliases(page, aliases, base) {
  const input = aliases.map((asset) => ({ alias: asset.alias, url: new URL(asset.path, base).href }));
  const observations = await page.evaluate(async (items) => Promise.all(items.map(async (item) => {
    const response = await fetch(item.url, { cache: 'no-store' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
    return {
      alias: item.alias,
      url: response.url,
      status: response.status,
      headers: {
        'cache-control': response.headers.get('cache-control'),
        'content-type': response.headers.get('content-type'),
      },
      bodyBytes: bytes.byteLength,
      bodySha256: hash,
      requestCacheMode: 'no-store',
    };
  })), input);
  return observations.map((observation) => {
    const asset = aliases.find((candidate) => candidate.alias === observation.alias);
    const proof = validateMutableAliasObservation({
      alias: observation.alias,
      asset,
      observation,
      expectedUrl: new URL(asset.path, base).href,
      expectedOrigin: base.origin,
    });
    return { ...proof, requestCacheMode: observation.requestCacheMode };
  });
}

async function runCacheProof(browser, base, inputs) {
  const assets = inputs.cacheAssets;
  const paths = new Set(assets.map((asset) => asset.path));
  const expectedPaths = assets.map((asset) => asset.path);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, locale: 'zh-TW', serviceWorkers: 'block',
  });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  report.cacheProof = {
    status: 'RUNNING',
    context: { fresh: true, serviceWorkers: 'block', cacheDisabled: false, routingEnabled: false },
    pages: [], coldResponses: [], warmResponses: [], assets: [], mutableAliases: [], interaction: null,
  };
  const contexts = [{ context, label: 'fresh-shared-cache-context' }];
  try {
    const coldPage = await context.newPage();
    const coldCdp = await context.newCDPSession(coldPage);
    await coldCdp.send('Network.enable');
    await coldCdp.send('Network.setCacheDisabled', { cacheDisabled: false });
    const coldJournal = attachJournal(coldPage, coldCdp, paths);
    coldJournal.route = 'service.html';
    const coldNavigation = await waitForRouteAndFonts(coldPage, 'service.html', base, expectedPaths);
    report.cacheProof.pages.push(coldNavigation);
    const cold = new Map();
    for (const asset of assets) {
      const observation = await observeResource(coldPage, coldJournal, asset, base);
      cold.set(asset.path, observation);
      report.cacheProof.coldResponses.push({ path: asset.path, ...observation });
    }

    const warmPage = await context.newPage();
    const warmCdp = await context.newCDPSession(warmPage);
    await warmCdp.send('Network.enable');
    await warmCdp.send('Network.setCacheDisabled', { cacheDisabled: false });
    const warmJournal = attachJournal(warmPage, warmCdp, paths);
    warmJournal.route = 'service-guides.html';
    const warmNavigation = await waitForRouteAndFonts(warmPage, 'service-guides.html', base, expectedPaths);
    report.cacheProof.pages.push(warmNavigation);
    const warm = new Map();
    for (const asset of assets) {
      const observation = await observeResource(warmPage, warmJournal, asset, base);
      warm.set(asset.path, observation);
      report.cacheProof.warmResponses.push({ path: asset.path, ...observation });
    }
    const cacheProofs = assets.map((asset) => validateColdWarmCacheProof({
      asset,
      cold: cold.get(asset.path),
      warm: warm.get(asset.path),
      expectedUrl: new URL(asset.path, base).href,
      expectedOrigin: base.origin,
    }));

    const menu = warmPage.locator('.menu-toggle');
    assert.equal(await menu.count(), 1, 'second page menu toggle is missing or ambiguous');
    await menu.evaluate((element) => element.addEventListener('click', (event) => {
      window.__g01MenuClickTrusted = event.isTrusted;
    }, { once: true, capture: true }));
    await menu.click();
    const menuClickTrusted = await warmPage.evaluate(() => window.__g01MenuClickTrusted === true);
    assert.equal(menuClickTrusted, true, 'menu interaction was not a trusted browser click');
    assert.equal(await menu.getAttribute('aria-expanded'), 'true', 'menu click did not open the navigation');
    await warmPage.keyboard.press('Escape');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false', 'Escape did not close the navigation');
    const interaction = {
      page: 'service-guides.html',
      selector: '.menu-toggle',
      trustedClick: menuClickTrusted,
      opened: true,
      escapeClosed: true,
      navigationClassAfterEscape: await warmPage.locator('#navigation').getAttribute('class'),
    };
    const cssApplied = await warmPage.evaluate((stylePath) => ({
      linked: [...document.styleSheets].some((sheet) => {
        try { return new URL(sheet.href).pathname === stylePath; } catch { return false; }
      }),
      menuDisplay: getComputedStyle(document.querySelector('.menu-toggle')).display,
    }), assets.find((asset) => asset.alias === 'styles.css').path);
    assert.equal(cssApplied.linked, true, 'fingerprinted shared stylesheet is not attached to the second page');
    assert.notEqual(cssApplied.menuDisplay, 'none', 'menu control is not styled as an available interaction');
    interaction.cssApplied = cssApplied;
    const mutableAliases = await probeMutableAliases(warmPage, inputs.mutableAliases, base);
    report.cacheProof = {
      ...report.cacheProof,
      status: 'PASS',
      assets: cacheProofs,
      mutableAliases,
      interaction,
    };
    assert.deepEqual(coldJournal.pageErrors, [], 'cold page has an uncaught browser error');
    assert.deepEqual(warmJournal.pageErrors, [], 'warm page has an uncaught browser error');
    return { contexts, diagnostics: [coldJournal, warmJournal] };
  } catch (error) {
    report.cacheProof.status = 'FAIL';
    report.cacheProof.openPages = contexts.map(({ context: current, label }) => ({ route: label, count: current.pages().length }));
    throw error;
  }
}

async function runMapProof(browser, base, inputs) {
  const assets = inputs.mapAssets;
  const trackedPaths = new Set(assets.map((asset) => asset.path));
  const { context, page, journal } = await createInstrumentedPage(browser, {
    viewport: { width: 1280, height: 900 }, cacheEnabled: true, trackedPaths,
  });
  journal.route = 'achievements.html';
  report.mapProof.status = 'RUNNING';
  try {
    const response = await page.goto(new URL('achievements.html', base).href, {
      waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS,
    });
    assert.equal(response?.status(), 200, 'public achievements artifact did not return HTTP 200');
    await page.locator('html.menu-ready').waitFor({ timeout: 10000 });
    const mapWorker = await assertNoServiceWorkerController(page, 'achievements.html');
    const mapDataResponsePromise = page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return url.origin === base.origin && url.pathname === '/data/achievement-map.json';
    }, { timeout: 18000 }).then((response) => ({ response }), (error) => ({ error }));
    const mapButton = page.getByRole('button', { name: '地圖與列表', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-view]')]
      .some((button) => button.textContent.trim() === '地圖與列表' && !button.disabled), null, { timeout: 10000 });
    await mapButton.evaluate((element) => element.addEventListener('click', (event) => {
      window.__g01MapClickTrusted = event.isTrusted;
    }, { once: true, capture: true }));
    await mapButton.click();
    const mapClickTrusted = await page.evaluate(() => window.__g01MapClickTrusted === true);
    assert.equal(mapClickTrusted, true, 'map UI was not opened by a trusted browser click');
    await page.locator('.map-panel').waitFor({ state: 'visible', timeout: 10000 });
    const mapDataOutcome = await withTimeout(mapDataResponsePromise, 18000, 'public achievement map data response');
    if (mapDataOutcome.error) throw mapDataOutcome.error;
    const mapDataResponse = mapDataOutcome.response;
    assert.equal(mapDataResponse.status(), 200, 'public achievement map data did not return HTTP 200');
    const mapRows = await withTimeout(mapDataResponse.json(), 5000, 'public achievement map data JSON');
    assert.ok(Array.isArray(mapRows) && mapRows.length > 0, 'public artifact map data is empty');
    assert.ok(mapRows.some((row) => Array.isArray(row.coordinates) && row.coordinates.length === 2),
      'public artifact map data has no located record');
    report.mapProof.mapData = {
      url: mapDataResponse.url(),
      status: mapDataResponse.status(),
      rows: mapRows.length,
      locatedRows: mapRows.filter((row) => Array.isArray(row.coordinates) && row.coordinates.length === 2).length,
    };

    await page.waitForFunction(() => window.L?.version
      && document.querySelector('#achievement-map .leaflet-map-pane')
      && document.querySelector('#achievement-map .case-marker'), null, { timeout: 18000 });
    const mapRuntime = {
      ...(await page.evaluate(() => ({
      leafletVersion: window.L?.version || null,
      mapPanePresent: Boolean(document.querySelector('#achievement-map .leaflet-map-pane')),
      markerCount: document.querySelectorAll('#achievement-map .case-marker').length,
      mapPanelVisible: !document.querySelector('.map-panel')?.hidden,
      selectedView: document.querySelector('[data-view="both"]')?.getAttribute('aria-pressed'),
      route: location.pathname,
      }))),
      serviceWorker: mapWorker,
    };
    assert.ok(mapRuntime.leafletVersion, 'published Leaflet runtime did not create window.L');
    assert.ok(mapRuntime.mapPanePresent && mapRuntime.markerCount > 0,
      'public map runtime did not render a map pane with at least one marker');
    assert.equal(mapRuntime.mapPanelVisible, true);
    report.mapProof.runtime = mapRuntime;

    await page.waitForTimeout(750);
    const proofs = [];
    for (const asset of assets) {
      const observation = await observeResource(page, journal, asset, base);
      proofs.push(validateArtifactResponse({
        asset,
        observation,
        expectedUrl: new URL(asset.path, base).href,
        expectedOrigin: base.origin,
      }));
    }
    assert.deepEqual(journal.pageErrors, [], 'published map page has an uncaught browser error');
    report.mapProof = {
      ...report.mapProof,
      status: 'PASS',
      context: { fresh: true, serviceWorkers: 'block', cacheDisabled: false, routingEnabled: false },
      uiAction: { selector: '[data-view="both"]', buttonName: '地圖與列表', clicked: true, trustedClick: mapClickTrusted },
      assets: proofs,
      runtime: mapRuntime,
    };
    return { context, journal };
  } catch (error) {
    report.mapProof.status = 'FAIL';
    throw error;
  }
}

let browser = null;
const openedContexts = [];
let cacheRun;
let mapRun;
try {
  await mkdir(outputDir, { recursive: true });
  const mode = process.env.PUBLIC_ASSET_RUNTIME_MODE || LOCAL_CI_MODE;
  report.mode = mode;
  report.proofConstraints = {
    ...report.proofConstraints,
    baseUrlPolicy: mode === PRODUCTION_LIVE_MODE
      ? 'exactly https://www.huiwen.tw/; no credentials, query, hash, redirects, or alternate host'
      : mode === LOCAL_CI_MODE
        ? 'existing loopback Wrangler origin; HTTP or HTTPS; no credentials, query, or hash'
        : 'unsupported mode; execution will fail without a fallback',
    liveReceiptSource: mode === PRODUCTION_LIVE_MODE ? 'HTTP GET https://www.huiwen.tw/deployment.json' : null,
  };
  const base = normalizeBaseUrl(process.env.BASE_URL, mode);
  report.baseUrl = base.href;
  const inputs = await loadArtifactInputs();
  const eventPath = process.env.GITHUB_EVENT_PATH;
  assert.ok(eventPath, 'GITHUB_EVENT_PATH is required to bind this proof to the native GitHub event');
  const eventPayload = JSON.parse(await readFile(eventPath, 'utf8'));
  report.sourceCi.pullRequestNumber = Number.isInteger(eventPayload.number) ? eventPayload.number : null;
  report.sourceCi.eventHeadSha = eventPayload.pull_request?.head?.sha || null;
  report.sourceCi.workflowRunHeadSha = eventPayload.workflow_run?.head_sha || null;
  report.sourceCi.dispatchRef = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? eventPayload.ref || null : null;
  report.sourceCi.checkoutShaContract = process.env.GITHUB_EVENT_NAME === 'workflow_run'
    ? 'github.event.workflow_run.head_sha'
    : process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
      ? 'GITHUB_SHA for the native workflow_dispatch ref'
      : null;
  report.publicArtifact = {
    provider: inputs.deployment.provider || null,
    artifactSourceCommit: inputs.deployment.sourceCommit || null,
    deploymentManifestDigest: inputs.deployment.publicArtifactDigest || null,
    localDeploymentReceiptSha256: digestBytes(inputs.deploymentBytes),
    localDeploymentReceiptBytes: inputs.deploymentBytes.byteLength,
    publicationManifestSha256: digestBytes(inputs.publicationManifestBytes),
    publicationManifestBytes: inputs.publicationManifestBytes.byteLength,
    publicationFileCount: Object.keys(inputs.publication.files).length,
    publicRecordCount: inputs.publication.publicRecordCount ?? null,
    liveDeploymentObservation: null,
  };
  let checkoutSha = null;
  let liveDeploymentResponse = null;
  if (mode === PRODUCTION_LIVE_MODE) {
    try {
      checkoutSha = readCheckoutSha();
      report.sourceCi.checkoutSha = checkoutSha;
    } catch (error) {
      report.failures.push({ name: 'CheckoutHeadFailure', error: errorRecord(error) });
    }
    try {
      liveDeploymentResponse = await observeLiveDeploymentReceipt(base);
      let liveReceipt = null;
      try { liveReceipt = JSON.parse(liveDeploymentResponse.body.toString('utf8')); } catch { /* recorded as invalid below */ }
      report.publicArtifact.liveDeploymentObservation = {
        url: liveDeploymentResponse.url,
        requestedUrl: liveDeploymentResponse.requestedUrl,
        status: liveDeploymentResponse.status,
        headers: liveDeploymentResponse.headers,
        bodyBytes: liveDeploymentResponse.body.byteLength,
        bodySha256: digestBytes(liveDeploymentResponse.body),
        provider: liveReceipt?.provider || null,
        sourceCommit: liveReceipt?.sourceCommit || null,
        publicArtifactDigest: liveReceipt?.publicArtifactDigest || null,
      };
    } catch (error) {
      report.publicArtifact.liveDeploymentObservation = {
        requestedUrl: new URL('deployment.json', base).href,
        status: 'UNAVAILABLE',
        error: errorRecord(error),
      };
      report.failures.push({ name: 'LiveDeploymentHttpFailure', error: errorRecord(error) });
    }
  }
  const playwrightPackage = JSON.parse(await readFile(new URL('./node_modules/playwright/package.json', import.meta.url), 'utf8'));
  assert.equal(playwrightPackage.version, PLAYWRIGHT_VERSION, 'tests/donation Playwright package version changed');
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  report.runtime = {
    browser: 'Chromium',
    chromiumVersion: browser.version(),
    playwrightVersion: playwrightPackage.version,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    runnerOs: process.env.RUNNER_OS || null,
  };
  if (mode === PRODUCTION_LIVE_MODE) {
    try {
      report.provenance = bindProductionPublicArtifactProvenance({
        eventName: process.env.GITHUB_EVENT_NAME,
        eventPayload,
        githubSha: process.env.GITHUB_SHA,
        githubRef: process.env.GITHUB_REF,
        checkoutSha,
        deployment: inputs.deployment,
        deploymentBytes: inputs.deploymentBytes,
        liveDeploymentResponse,
        publication: inputs.publication,
        publicationManifestBytes: inputs.publicationManifestBytes,
        runtime: report.runtime,
        runId: process.env.GITHUB_RUN_ID || null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      });
    } catch (error) {
      report.failures.push({ name: 'ProductionProvenanceFailure', error: errorRecord(error) });
    }
  } else {
    report.provenance = bindPublicArtifactProvenance({
      eventName: process.env.GITHUB_EVENT_NAME,
      sourceCiMergeSha: process.env.GITHUB_SHA,
      pullRequestHeadSha: process.env.PR_HEAD_SHA,
      eventPayload,
      deployment: inputs.deployment,
      publication: inputs.publication,
      publicationManifestBytes: inputs.publicationManifestBytes,
      runtime: report.runtime,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    });
  }
  cacheRun = await runCacheProof(browser, base, inputs);
  openedContexts.push(...cacheRun.contexts.map((item) => item.context));
  mapRun = await runMapProof(browser, base, inputs);
  openedContexts.push(mapRun.context);
} catch (error) {
  report.primaryError = errorRecord(error);
  report.failures.push(report.primaryError);
} finally {
  for (const context of [...new Set(openedContexts)].reverse()) {
    try { await context.close(); } catch (error) { report.cleanupErrors.push(errorRecord(error)); }
  }
  if (browser) {
    try { await browser.close(); } catch (error) { report.cleanupErrors.push(errorRecord(error)); }
  }
  report.finishedAt = new Date().toISOString();
  report.diagnostics.pages = allJournals.map((journal) => ({
    route: journal.route,
    pageErrors: journal.pageErrors,
    requestFailures: journal.requestFailures,
    externalRequestFailures: journal.route === 'achievements.html'
      ? journal.requestFailures.filter((failure) => failure.origin !== new URL(report.baseUrl || 'http://127.0.0.1').origin)
      : [],
  }));
  report.status = report.primaryError || report.failures.length ? 'FAIL'
    : report.cacheProof.status === 'PASS' && report.mapProof.status === 'PASS' ? 'PASS' : 'FAIL';
  if (report.status === 'FAIL' && !report.primaryError && !report.failures.length) {
    report.failures.push({ name: 'IncompleteProof', message: 'one or more required native browser gates did not complete' });
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'FAIL') {
    await writeFile(failurePath, `${JSON.stringify({
      status: report.status,
      primaryError: report.primaryError,
      failures: report.failures,
      cacheProof: report.cacheProof,
      mapProof: report.mapProof,
      diagnostics: report.diagnostics,
      sourceCi: report.sourceCi,
      publicArtifact: report.publicArtifact,
      runtime: report.runtime,
      provenance: report.provenance,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

console.log(JSON.stringify({
  status: report.status,
  baseUrl: report.baseUrl,
  provenance: report.provenance,
  report: reportPath,
  failureArtifact: report.status === 'FAIL' ? failurePath : null,
  cacheAssets: report.cacheProof.assets.length,
  mapAssets: report.mapProof.assets.length,
}, null, 2));
