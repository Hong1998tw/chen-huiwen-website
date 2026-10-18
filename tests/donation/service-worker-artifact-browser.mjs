import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ARTIFACT = join(ROOT, '_site');
const REPORT_DIR = join(ROOT, 'tests/donation/results/cloudflare-assets');
const REPORT_PATH = join(REPORT_DIR, 'service-worker-browser.json');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8789';
const OLD_WORKER = `self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));`;
const report = {checks: [], failures: [], baseUrl: BASE_URL, startedAt: new Date().toISOString()};
const fixtures = [];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function check(name, fn) {
  return fn().then(result => {
    report.checks.push({name, status: 'PASS', ...(result || {})});
    console.log('PASS ' + name);
  }).catch(error => {
    report.failures.push({name, error: error?.stack || String(error)});
    console.error('FAIL ' + name + ': ' + (error?.stack || error));
    throw error;
  });
}

async function waitFor(predicate, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + message);
}

async function captureOfflineConnectivity(context, page, label, contextOffline) {
  const state = {label, contextOffline, pageOnline: null, serviceWorkers: []};
  try {
    state.pageOnline = await page.evaluate(() => navigator.onLine);
  } catch (error) {
    state.pageError = error?.message || String(error);
  }
  try {
    state.serviceWorkers = await Promise.all(context.serviceWorkers().map(async worker => {
      try {
        return {url: worker.url(), ...(await worker.evaluate(() => ({
          online: navigator.onLine,
          scope: self.registration.scope,
        })))};
      } catch (error) {
        return {url: worker.url(), error: error?.message || String(error)};
      }
    }));
  } catch (error) {
    state.serviceWorkersError = error?.message || String(error);
  }
  return state;
}

async function captureServiceWorkerCacheKeys(page, cacheName, keyUrls) {
  const snapshot = {cacheName, keyUrls: {...keyUrls}, cacheNames: [], entries: {}};
  if (!cacheName) {
    snapshot.error = 'derived Service Worker cache name is not available';
    return snapshot;
  }
  try {
    const result = await page.evaluate(async ({name, urls}) => {
      const cacheNames = await caches.keys();
      const cache = cacheNames.includes(name) ? await caches.open(name) : null;
      const entries = {};
      for (const [key, url] of Object.entries(urls)) {
        entries[key] = {url, match: Boolean(cache && await cache.match(url))};
      }
      return {cacheNames, entries};
    }, {name: cacheName, urls: keyUrls});
    snapshot.cacheNames = result.cacheNames;
    snapshot.entries = result.entries;
  } catch (error) {
    snapshot.error = error?.message || String(error);
  }
  return snapshot;
}

async function captureDetailedServiceWorkerCacheState(page, cacheName, keyUrls) {
  try {
    return await page.evaluate(async ({name, urls}) => {
      const cacheNames = await caches.keys();
      const cache = cacheNames.includes(name) ? await caches.open(name) : null;
      const cacheKeyRequests = cache ? await cache.keys() : [];
      const cacheKeys = cacheKeyRequests.map(request => request.url);
      const entries = {};
      for (const [key, url] of Object.entries(urls)) {
        entries[key] = {url, match: Boolean(cache && await cache.match(url))};
      }
      const offlineUrl = new URL('/offline.html', location.origin).href;
      const offlineRequest = cacheKeyRequests.find(request => request.method === 'GET' && request.url === offlineUrl) || null;
      const offlineResponse = offlineRequest ? await cache.match(offlineRequest) : null;
      let offlineKey = {
        url: offlineRequest?.url || null,
        requestUrl: offlineUrl,
        cacheKeyUrl: offlineRequest?.url || null,
        match: Boolean(offlineRequest && offlineResponse),
      };
      if (offlineResponse) {
        offlineKey = {
          url: offlineRequest.url,
          requestUrl: offlineUrl,
          cacheKeyUrl: offlineRequest.url,
          requestMethod: offlineRequest.method,
          requestMode: offlineRequest.mode,
          requestDestination: offlineRequest.destination,
          match: true,
          responseUrl: offlineResponse.url,
          status: offlineResponse.status,
          responseType: offlineResponse.type,
          responseRedirected: offlineResponse.redirected,
          headers: Object.fromEntries(offlineResponse.headers.entries()),
          bodyBytes: Array.from(new Uint8Array(await offlineResponse.arrayBuffer())),
        };
      }
      return {
        controller: navigator.serviceWorker.controller?.scriptURL || null,
        cacheNames,
        cacheKeys,
        entries,
        offlineKey,
      };
    }, {name: cacheName, urls: keyUrls});
  } catch (error) {
    return {error: error?.stack || String(error)};
  }
}

function summarizeDetailedCacheState(snapshot) {
  if (!snapshot || snapshot.error) return snapshot;
  const {bodyBytes, ...offlineKey} = snapshot.offlineKey || {};
  return {
    ...snapshot,
    offlineKey: bodyBytes ? {
      ...offlineKey,
      bodyByteLength: bodyBytes.length,
      bodySha256: sha256(Buffer.from(bodyBytes)),
    } : offlineKey,
  };
}

async function listenFixture({workerBytes, failingOffline = false} = {}) {
  const state = {
    workerBytes,
    failingOffline,
    workerResponses: [],
    offlineRequests: 0,
    offlineResponses: [],
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/sw.js') {
      const bytes = Buffer.from(state.workerBytes);
      state.workerResponses.push(sha256(bytes));
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Content-Length': bytes.length,
      });
      response.end(bytes);
      return;
    }
    if (url.pathname === '/offline.html') {
      state.offlineRequests += 1;
      if (state.failingOffline) {
        response.writeHead(503, {'Content-Type': 'text/plain', 'Cache-Control': 'no-store'});
        state.offlineResponses.push({status: response.statusCode, path: url.pathname});
        response.end('fixture: required offline fallback unavailable');
        return;
      }
    }
    const sensitivePath = /(?:^|\/)(?:admin|api|cms|runtime)(?:\/|$)/i.test(url.pathname)
      || /^cms[-_.]/i.test(url.pathname.split('/').at(-1) || '')
      || ['/sw.js', '/data/achievements.json', '/deployment.json', '/publication-manifest.json'].includes(url.pathname);
    const sensitiveQuery = [...url.searchParams.keys()].some(key =>
      /^(?:cms[a-z0-9_-]*|draft|private|preview[a-z0-9_-]*|[a-z0-9_-]*(?:token|session)[a-z0-9_-]*)$/i.test(key));
    const cacheControl = request.headers.authorization || sensitivePath || sensitiveQuery
      ? 'private, no-store'
      : url.searchParams.get('v') === 'no-store' ? 'no-store'
        : url.searchParams.get('v') === 'private-response' ? 'private' : 'public, max-age=0';
    const body = url.pathname === '/' || url.pathname.endsWith('.html')
      ? '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>C11 browser fixture</title></head><body><main>fixture page</main></body></html>'
      : 'fixture resource: ' + url.pathname;
    response.writeHead(200, {
      'Content-Type': url.pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': cacheControl,
    });
    response.end(url.pathname.endsWith('.json') ? '{"fixture":true}' : body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  let closed = false;
  const fixture = {
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function runArtifactChecks(browser, emittedWorker, manifest, deployment) {
  const experimentalNetworkFlag = 'PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS';
  const previousExperimentalNetworkFlag = process.env[experimentalNetworkFlag];
  const state = {context: null, page: null, offline: false, cacheName: null, cacheKeyUrls: {}};
  const offlineDiagnostics = {
    controlApi: 'BrowserContext.setOffline',
    initialContextOffline: false,
    serviceWorkerNetworkEvents: {
      flag: experimentalNetworkFlag,
      enabledForArtifactCheck: true,
      previousValue: previousExperimentalNetworkFlag ?? null,
    },
    httpCache: {
      contextSetting: 'native default; Network.setCacheDisabled is not called',
      probeRequestMode: 'fetch uses cache: no-store; separate from Cache Storage',
    },
    transitions: [],
    connectivity: [],
    probes: {},
  };
  // Playwright 1.55.1 gates its Service Worker network manager behind this flag.
  process.env[experimentalNetworkFlag] = '1';
  try {
    return await runArtifactChecksBody(browser, emittedWorker, manifest, deployment, state, offlineDiagnostics);
  } finally {
    if (state.context) {
      if (state.page) {
        offlineDiagnostics.finallyBeforeRestore = await captureOfflineConnectivity(
          state.context, state.page, 'finally-before-restore', state.offline);
        offlineDiagnostics.finallyCacheKeys = await captureServiceWorkerCacheKeys(
          state.page, state.cacheName, state.cacheKeyUrls);
      }
      if (state.offline) {
        try {
          await state.context.setOffline(false);
          state.offline = false;
          offlineDiagnostics.transitions.push({
            api: 'BrowserContext.setOffline', offline: false, status: 'restored-in-finally',
          });
        } catch (error) {
          offlineDiagnostics.restoreError = error?.stack || String(error);
        }
      }
      if (state.page) {
        offlineDiagnostics.finallyAfterRestore = await captureOfflineConnectivity(
          state.context, state.page, 'finally-after-restore', state.offline);
      }
      try {
        await state.context.close();
      } catch (error) {
        offlineDiagnostics.contextCloseError = error?.stack || String(error);
      }
    }
    if (previousExperimentalNetworkFlag === undefined) delete process.env[experimentalNetworkFlag];
    else process.env[experimentalNetworkFlag] = previousExperimentalNetworkFlag;
    report.offlineDiagnostics = offlineDiagnostics;
  }
}

async function runArtifactChecksBody(browser, emittedWorker, manifest, deployment, state, offlineDiagnostics) {
  const context = await browser.newContext({serviceWorkers: 'allow'});
  state.context = context;
  context.setDefaultTimeout(12000);
  context.setDefaultNavigationTimeout(15000);
  const page = await context.newPage();
  state.page = page;
  const workerNetworkEvents = {requests: [], responses: [], failures: []};
  const describeWorkerRequest = request => {
    const worker = request.serviceWorker();
    return worker ? {
      url: request.url(),
      workerScriptUrl: worker.url(),
      method: request.method(),
      resourceType: request.resourceType(),
    } : null;
  };
  const workerEventsFor = url => ({
    requests: workerNetworkEvents.requests.filter(event => event.url === url),
    responses: workerNetworkEvents.responses.filter(event => event.url === url),
    failures: workerNetworkEvents.failures.filter(event => event.url === url),
  });
  context.on('request', request => {
    const event = describeWorkerRequest(request);
    if (event) workerNetworkEvents.requests.push(event);
  });
  context.on('response', response => {
    const request = response.request();
    const event = describeWorkerRequest(request);
    if (event) workerNetworkEvents.responses.push({
      ...event,
      status: response.status(),
      fromServiceWorker: response.fromServiceWorker(),
    });
  });
  context.on('requestfailed', request => {
    const event = describeWorkerRequest(request);
    if (event) workerNetworkEvents.failures.push({
      ...event,
      failure: request.failure()?.errorText || null,
    });
  });
  const serverWorkerBytes = Buffer.from(await readFile(join(ARTIFACT, 'sw.js')));
  const emittedWorkerText = emittedWorker.toString('utf8');
  const expectedWorkerHash = sha256(serverWorkerBytes);
  assert.equal(manifest.files?.['sw.js'], expectedWorkerHash, 'publication manifest must hash the emitted Service Worker');

  await page.addInitScript(() => {
    const container = navigator.serviceWorker;
    const original = container.register.bind(container);
    Object.defineProperty(window, '__nativeServiceWorkerRegister', {value: original});
    Object.defineProperty(container, 'register', {
      configurable: true,
      value: () => Promise.resolve({catch: () => Promise.resolve()}),
    });
  });
  await page.goto(BASE_URL + '/', {waitUntil: 'domcontentloaded'});
  await page.evaluate(async () => {
    await caches.open('huiwen-digital-v15-c11-browser-stale');
    await caches.open('c11-unrelated-cache');
    Object.defineProperty(navigator.serviceWorker, 'register', {
      configurable: true,
      value: window.__nativeServiceWorkerRegister,
    });
    await window.__nativeServiceWorkerRegister('/sw.js', {scope: '/', updateViaCache: 'none'});
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {timeout: 12000});
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return Boolean(registration?.active?.state === 'activated');
  }, null, {timeout: 12000});

  const activeState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const names = await caches.keys();
    const scriptResponse = await fetch(registration.active.scriptURL, {cache: 'no-store'});
    const scriptText = await scriptResponse.text();
    const manifestResponse = await fetch('/publication-manifest.json', {cache: 'no-store'});
    const deploymentResponse = await fetch('/deployment.json', {cache: 'no-store'});
    return {
      controller: navigator.serviceWorker.controller?.scriptURL,
      activeScript: registration.active.scriptURL,
      controllerIsActive: navigator.serviceWorker.controller === registration.active,
      cacheNames: names,
      scriptStatus: scriptResponse.status,
      scriptText,
      manifestStatus: manifestResponse.status,
      servedManifest: await manifestResponse.text(),
      deploymentStatus: deploymentResponse.status,
      servedDeployment: await deploymentResponse.text(),
    };
  });
  assert.equal(activeState.scriptStatus, 200, 'browser must load the actual artifact Service Worker');
  assert.equal(activeState.manifestStatus, 200, 'browser must load the actual publication manifest');
  assert.equal(activeState.deploymentStatus, 200, 'browser must load the artifact deployment receipt');
  assert.equal(sha256(Buffer.from(activeState.scriptText)), expectedWorkerHash,
    'Wrangler-served active worker bytes must match the manifest digest');
  assert.deepEqual(JSON.parse(activeState.servedManifest), manifest);
  assert.deepEqual(JSON.parse(activeState.servedDeployment), deployment);
  assert.equal(sha256(Buffer.from(activeState.servedManifest)), deployment.publicArtifactDigest,
    'the deployment receipt must identify the served publication manifest');
  const cacheName = emittedWorkerText.match(/const CACHE='([^']+)';/)?.[1];
  assert(cacheName, 'emitted worker must define its derived cache name');
  state.cacheName = cacheName;
  assert.equal(new URL(activeState.activeScript).pathname, '/sw.js');
  assert.equal(activeState.controller, activeState.activeScript, 'active controller and registration must use the emitted worker');
  assert.equal(activeState.controllerIsActive, true, 'the controlling worker must be the active registration worker');
  assert(activeState.cacheNames.includes(cacheName), 'the derived worker cache must be active');
  assert(!activeState.cacheNames.includes('huiwen-digital-v15-c11-browser-stale'), 'activation must remove the prior Huiwen cache');
  assert(activeState.cacheNames.includes('c11-unrelated-cache'), 'activation must preserve unrelated caches');
  report.artifact = {
    workerSha256: expectedWorkerHash,
    workerCacheName: cacheName,
    sourceCommit: deployment.sourceCommit,
    publicArtifactDigest: deployment.publicArtifactDigest,
  };

  const shell = JSON.parse(emittedWorkerText.match(/const SHELL=(\[[^;]*\]);/)?.[1] || 'null');
  const queryEntry = shell.find(value => /\.(?:css|js)\?/.test(value));
  assert(queryEntry, 'artifact SHELL must contain a versioned CSS or JavaScript URL');
  const absoluteShellUrl = new URL(queryEntry, new URL('/', BASE_URL)).href;
  const changedQueryUrl = absoluteShellUrl.replace(/\?.*$/, '?c11-different-query=1');
  const onlineProbe = new URL('/offline.html', BASE_URL);
  onlineProbe.searchParams.set('c11-context-offline-probe', 'online');
  const offlineProbe = new URL('/offline.html', BASE_URL);
  offlineProbe.searchParams.set('c11-context-offline-probe', 'offline');
  Object.assign(state.cacheKeyUrls, {
    exactShell: absoluteShellUrl,
    changedShellQuery: changedQueryUrl,
    onlineWorkerProbe: onlineProbe.href,
    offlineWorkerProbe: offlineProbe.href,
  });
  const cacheHit = await page.evaluate(async url => {
    const response = await fetch(url, {cache: 'no-store'});
    return {status: response.status, body: await response.text()};
  }, absoluteShellUrl);
  assert.equal(cacheHit.status, 200, 'a query-bearing SHELL asset must be served');
  const shellCacheState = await page.evaluate(async url => {
    const cache = await caches.open((await caches.keys()).find(key => key.startsWith('huiwen-digital-v16-')));
    return {
      exactHit: Boolean(await cache.match(url)),
      alteredHit: Boolean(await cache.match(url.replace(/\?.*$/, '?c11-different-query=1'))),
    };
  }, absoluteShellUrl);
  assert.equal(shellCacheState.exactHit, true, 'the complete public query must be present in Cache Storage');
  assert.equal(shellCacheState.alteredHit, false, 'a changed query must not match the cached key');

  const initialProbeKeys = await captureServiceWorkerCacheKeys(page, cacheName, state.cacheKeyUrls);
  offlineDiagnostics.initialProbeCacheKeys = initialProbeKeys;
  assert.equal(initialProbeKeys.entries.onlineWorkerProbe?.match, false,
    'the online Service Worker probe URL must start as a Cache Storage miss');
  const onlineWorkerProbe = await page.evaluate(async url => {
    try {
      const response = await fetch(url, {cache: 'no-store'});
      return {ok: response.ok, status: response.status, bodyPrefix: (await response.text()).slice(0, 80)};
    } catch (error) {
      return {ok: false, error: error.name};
    }
  }, onlineProbe.href);
  offlineDiagnostics.probes.onlineWorkerNetwork = {url: onlineProbe.href, ...onlineWorkerProbe};
  assert.equal(onlineWorkerProbe.ok, true, 'the uncached public offline.html query must reach the network online');
  assert.equal(onlineWorkerProbe.status, 200, 'the online Service Worker network probe must receive HTTP 200');
  await waitFor(async () => page.evaluate(async ({name, url}) => {
    const cache = await caches.open(name);
    return Boolean(await cache.match(url));
  }, {name: cacheName, url: onlineProbe.href}), 'the online Service Worker probe cache key');
  const beforeOfflineKeys = await captureServiceWorkerCacheKeys(page, cacheName, state.cacheKeyUrls);
  offlineDiagnostics.beforeOfflineCacheKeys = beforeOfflineKeys;
  assert.equal(beforeOfflineKeys.entries.offlineWorkerProbe?.match, false,
    'the offline Service Worker probe URL must start with an empty Cache Storage key');

  const onlineState = await captureOfflineConnectivity(context, page, 'before-context-offline', state.offline);
  offlineDiagnostics.connectivity.push(onlineState);
  assert.equal(onlineState.pageOnline, true, 'the browser page must be online before context offline emulation');
  await context.setOffline(true);
  state.offline = true;
  offlineDiagnostics.transitions.push({api: 'BrowserContext.setOffline', offline: true, status: 'accepted'});
  const offlineState = await captureOfflineConnectivity(context, page, 'after-context-offline', state.offline);
  offlineDiagnostics.connectivity.push(offlineState);
  assert.equal(offlineState.pageOnline, false, 'the context page must report offline after setOffline(true)');

  const offlineCacheHit = await page.evaluate(async url => {
    try {
      const response = await fetch(url, {cache: 'no-store'});
      return {ok: response.ok, status: response.status, body: await response.text()};
    } catch (error) {
      return {ok: false, error: error.name};
    }
  }, absoluteShellUrl);
  assert.equal(offlineCacheHit.ok, true, 'the exact SHELL URL must be a real offline browser cache hit');
  const changedQuery = await page.evaluate(async url => {
    try {
      const response = await fetch(url, {cache: 'no-store'});
      return {ok: response.ok, status: response.status};
    } catch (error) {
      return {ok: false, error: error.name};
    }
  }, changedQueryUrl);
  offlineDiagnostics.probes.changedShellQuery = {url: changedQueryUrl, ...changedQuery};
  assert.equal(changedQuery.ok, false, 'a changed query must not reuse the cached response while offline');

  const offlineWorkerProbe = await page.evaluate(async url => {
    try {
      const response = await fetch(url, {cache: 'no-store'});
      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        bodyPrefix: (await response.clone().text()).slice(0, 160),
      };
    } catch (error) {
      return {ok: false, error: error?.stack || String(error)};
    }
  }, offlineProbe.href);
  const offlineWorkerProbeEvents = workerEventsFor(offlineProbe.href);
  const offlineProbeCacheable = offlineWorkerProbe.ok
    && !/\b(?:private|no-store)\b/i.test(offlineWorkerProbe.headers?.['cache-control'] || '');
  if (offlineProbeCacheable) {
    await waitFor(async () => page.evaluate(async ({name, url}) => {
      const cache = await caches.open(name);
      return Boolean(await cache.match(url));
    }, {name: cacheName, url: offlineProbe.href}), 'the native offline worker probe cache key');
  }
  offlineDiagnostics.probes.offlineWorkerNetwork = {
    url: offlineProbe.href,
    ...offlineWorkerProbe,
    workerNetworkEvents: offlineWorkerProbeEvents,
  };
  const offlineProbeKeys = await captureServiceWorkerCacheKeys(page, cacheName, state.cacheKeyUrls);
  offlineDiagnostics.offlineProbeCacheKeys = offlineProbeKeys;
  assert.equal(offlineProbeKeys.entries.offlineWorkerProbe?.match, offlineProbeCacheable,
    offlineWorkerProbe.ok
      ? 'a successful public worker fetch while the context reports offline must be cached unless its response forbids storage'
      : 'a failed same-origin worker fetch while the context reports offline must not create a Cache Storage entry');
  offlineDiagnostics.contextOfflineEffect = {
    pageReportedOffline: offlineState.pageOnline === false,
    workerProbeSucceeded: offlineWorkerProbe.ok,
    workerProbeFailureEvents: offlineWorkerProbeEvents.failures,
    workerProbeResponseEvents: offlineWorkerProbeEvents.responses,
    interpretation: offlineWorkerProbe.ok
      ? 'BrowserContext.setOffline did not prevent this Service Worker-owned same-origin request.'
      : offlineWorkerProbeEvents.failures.length
        ? 'The uncached Service Worker-owned probe failed under BrowserContext.setOffline.'
        : 'The page fetch failed, but no matching Service Worker-owned transport failure was observed.',
  };

  await page.goto(new URL('/index.html', BASE_URL).href, {waitUntil: 'domcontentloaded'});
  await page.locator('[data-offline-cache]').waitFor({state: 'attached', timeout: 8000});
  const banner = await page.locator('[data-offline-cache]').innerText();
  assert.match(banner, /儲存時間：.+（台灣時間）/);

  const aboutUrl = new URL('/about.html', BASE_URL).href;
  const nativeAboutProbeUrl = new URL(aboutUrl);
  nativeAboutProbeUrl.searchParams.set('c11-context-offline-navigation-probe', 'native');
  const unknownUrl = new URL('/c11-never-cached-route.html', BASE_URL).href;
  const offlineUrl = new URL('/offline.html', BASE_URL).href;
  const shellPaths = new Set(shell.map(value => new URL(value, BASE_URL).pathname));
  const aboutInManifest = Object.prototype.hasOwnProperty.call(manifest.files || {}, 'about.html');
  const aboutNotInShell = !shellPaths.has('/about.html');
  Object.assign(state.cacheKeyUrls, {
    manifestAbout: aboutUrl,
    manifestAboutNativeProbe: nativeAboutProbeUrl.href,
    unknownNavigation: unknownUrl,
    offlineFallback: offlineUrl,
  });

  assert(aboutInManifest, 'the positive offline route must exist in the publication manifest');
  assert(aboutNotInShell, 'the positive offline route must not be in the install SHELL');
  const initialAboutCache = await captureServiceWorkerCacheKeys(page, cacheName, state.cacheKeyUrls);
  const initialAboutDetailed = await captureDetailedServiceWorkerCacheState(page, cacheName, state.cacheKeyUrls);
  offlineDiagnostics.probes.manifestAboutInitialCache = summarizeDetailedCacheState(initialAboutDetailed);
  const expectedOffline = initialAboutDetailed.offlineKey || {};
  const expectedOfflineSha256 = expectedOffline.bodyBytes
    ? sha256(Buffer.from(expectedOffline.bodyBytes)) : null;
  assert.equal(initialAboutCache.entries.manifestAbout?.match, false,
    'manifest-backed about.html must be a real Cache Storage miss before its offline probe');
  assert.equal(initialAboutCache.entries.manifestAboutNativeProbe?.match, false,
    'the manifest-backed native network probe must start as a real Cache Storage miss');

  let nativeAboutProbeResponse = null;
  let nativeAboutProbeNavigationError = null;
  try {
    nativeAboutProbeResponse = await page.goto(nativeAboutProbeUrl.href, {waitUntil: 'domcontentloaded'});
  } catch (error) {
    nativeAboutProbeNavigationError = error?.stack || String(error);
  }
  const nativeAboutProbeBody = nativeAboutProbeResponse
    ? await nativeAboutProbeResponse.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
  const nativeAboutProbeWorkerEvents = workerEventsFor(nativeAboutProbeUrl.href);
  const nativeAboutProbeFromServiceWorker = nativeAboutProbeResponse?.fromServiceWorker() ?? false;
  const nativeAboutProbeSameOrigin = nativeAboutProbeResponse
    ? new URL(nativeAboutProbeResponse.url()).origin === new URL(nativeAboutProbeUrl.href).origin : false;
  const nativeAboutProbeIsOfflineFallback = Boolean(nativeAboutProbeFromServiceWorker
    && nativeAboutProbeSameOrigin
    && nativeAboutProbeResponse?.status() === expectedOffline.status
    && nativeAboutProbeBody.equals(Buffer.from(expectedOffline.bodyBytes || [])));
  offlineDiagnostics.probes.manifestAboutNativeNetwork = {
    url: nativeAboutProbeUrl.href,
    navigationError: nativeAboutProbeNavigationError,
    status: nativeAboutProbeResponse?.status() ?? null,
    responseUrl: nativeAboutProbeResponse?.url() ?? null,
    fromServiceWorker: nativeAboutProbeFromServiceWorker,
    sameOriginAsRequest: nativeAboutProbeResponse ? nativeAboutProbeSameOrigin : null,
    bodyByteLength: nativeAboutProbeBody.length,
    bodySha256: sha256(nativeAboutProbeBody),
    fallbackAssetBodySha256: expectedOfflineSha256,
    matchesExactCachedOfflineFallback: nativeAboutProbeIsOfflineFallback,
    workerNetworkEvents: nativeAboutProbeWorkerEvents,
  };

  const workerNetworkDenials = [];
  const nativeWorkerFetchWasNotBlocked = offlineWorkerProbe.ok
    || !offlineWorkerProbeEvents.failures.some(event => event.workerScriptUrl === activeState.activeScript);
  const needsWorkerRouteDenial = nativeWorkerFetchWasNotBlocked || !nativeAboutProbeIsOfflineFallback;
  if (needsWorkerRouteDenial) {
    const baseOrigin = new URL(BASE_URL).origin;
    await context.route('**/*', async route => {
      const request = route.request();
      const worker = request.serviceWorker();
      const requestUrl = new URL(request.url());
      if (worker && worker.url() === activeState.activeScript && requestUrl.origin === baseOrigin) {
        workerNetworkDenials.push({
          url: request.url(),
          workerScriptUrl: worker.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          action: 'abort',
        });
        await route.abort();
        return;
      }
      await route.continue();
    });
    offlineDiagnostics.serviceWorkerNetworkEvents.controlledRoute = {
      method: 'BrowserContext.route',
      sameOrigin: baseOrigin,
      activeWorkerUrl: activeState.activeScript,
      reason: offlineWorkerProbe.ok
        ? 'The native setOffline probe completed successfully for an uncached worker request.'
        : 'The native worker probe did not provide a matching active-worker transport failure, or the manifest-route navigation was not the exact cached fallback.',
      aborts: workerNetworkDenials,
    };

    const controlledProbeUrl = new URL('/offline.html', BASE_URL);
    controlledProbeUrl.searchParams.set('c11-context-offline-probe', 'worker-route-denied');
    state.cacheKeyUrls.offlineWorkerRouteProbe = controlledProbeUrl.href;
    const controlledProbeBefore = await captureServiceWorkerCacheKeys(page, cacheName, state.cacheKeyUrls);
    assert.equal(controlledProbeBefore.entries.offlineWorkerRouteProbe?.match, false,
      'the controlled worker-route probe must start as a Cache Storage miss');
    const controlledProbe = await page.evaluate(async url => {
      try {
        const response = await fetch(url, {cache: 'no-store'});
        return {ok: response.ok, status: response.status, url: response.url};
      } catch (error) {
        return {ok: false, error: error?.stack || String(error)};
      }
    }, controlledProbeUrl.href);
    const controlledProbeAbort = await waitFor(
      () => workerNetworkDenials.find(event => event.url === controlledProbeUrl.href),
      'the emitted Service Worker-owned same-origin probe request to be aborted');
    const controlledProbeFailure = await waitFor(
      () => workerEventsFor(controlledProbeUrl.href).failures.find(
        event => event.workerScriptUrl === activeState.activeScript && event.failure),
      'the emitted Service Worker-owned probe request failure after route.abort');
    assert.equal(controlledProbe.ok, false,
      'a new uncached worker request must fail after the same-origin Service Worker transport route aborts it');
    assert.equal(controlledProbeAbort.workerScriptUrl, activeState.activeScript,
      'the aborted request must belong to the exact active emitted Service Worker');
    assert(controlledProbeFailure.failure, 'the route-aborted worker request must emit requestfailed evidence');
    const controlledProbeAfter = await captureServiceWorkerCacheKeys(page, cacheName, state.cacheKeyUrls);
    assert.equal(controlledProbeAfter.entries.offlineWorkerRouteProbe?.match, false,
      'the route-aborted worker probe must remain absent from Cache Storage');
    offlineDiagnostics.probes.controlledWorkerNetworkDenial = {
      url: controlledProbeUrl.href,
      fetch: controlledProbe,
      cacheBefore: controlledProbeBefore.entries.offlineWorkerRouteProbe,
      cacheAfter: controlledProbeAfter.entries.offlineWorkerRouteProbe,
      routeAbort: controlledProbeAbort,
      requestFailed: controlledProbeFailure,
    };
  } else {
    offlineDiagnostics.serviceWorkerNetworkEvents.controlledRoute = {
      method: null,
      installed: false,
      reason: 'BrowserContext.setOffline produced a worker-owned transport failure and the manifest navigation returned the exact cached fallback.',
    };
  }

  const aboutBefore = await captureServiceWorkerCacheKeys(page, cacheName, state.cacheKeyUrls);
  const aboutBeforeDetailed = await captureDetailedServiceWorkerCacheState(page, cacheName, state.cacheKeyUrls);
  offlineDiagnostics.probes.manifestAboutBeforeNavigation = summarizeDetailedCacheState(aboutBeforeDetailed);
  offlineDiagnostics.probes.manifestAboutNativeNetwork.cacheAfterProbe = aboutBefore.entries.manifestAboutNativeProbe;
  assert.equal(aboutBefore.entries.manifestAbout?.match, false,
    'manifest-backed about.html must remain a real Cache Storage miss before its offline navigation');

  let aboutResponse = null;
  let aboutNavigationError = null;
  try {
    aboutResponse = await page.goto(aboutUrl, {waitUntil: 'domcontentloaded'});
  } catch (error) {
    aboutNavigationError = error?.stack || String(error);
  }
  const aboutResponseBody = aboutResponse ? await aboutResponse.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
  const aboutBodyText = await page.locator('body').innerText().catch(() => '');
  const aboutAfter = await captureDetailedServiceWorkerCacheState(page, cacheName, state.cacheKeyUrls);
  const aboutResponseHeaders = aboutResponse?.headers() ?? {};
  const aboutResponseAllHeaders = aboutResponse ? await aboutResponse.allHeaders() : {};
  const aboutResponseHeadersArray = aboutResponse ? await aboutResponse.headersArray() : [];
  const aboutResponseHeaderNames = ['content-type', 'cache-control', 'x-huiwen-cached-at'];
  const aboutResponseDiagnosticHeaderNames = new Set([
    ...aboutResponseHeaderNames,
    'access-control-allow-credentials',
    'access-control-allow-origin',
    'access-control-expose-headers',
    'content-encoding',
    'content-length',
    'transfer-encoding',
  ]);
  const aboutResponseHeaderValues = aboutResponse
    ? Object.fromEntries(await Promise.all(aboutResponseHeaderNames.map(async name =>
      [name, await aboutResponse.headerValue(name)])))
    : {};
  const aboutCachedAtHeaderValueCanonical = aboutResponse
    ? await aboutResponse.headerValue('X-Huiwen-Cached-At') : null;
  const normalizedAboutResponseAllHeaders = Object.fromEntries(Object.entries(aboutResponseAllHeaders)
    .map(([name, value]) => [name.toLowerCase(), value]));
  const aboutResponseHeaderDiagnostics = Object.fromEntries([...aboutResponseDiagnosticHeaderNames]
    .map(name => [name, aboutResponseHeaders[name] ?? null]));
  const normalizedAboutResponseAllHeaderDiagnostics = Object.fromEntries([...aboutResponseDiagnosticHeaderNames]
    .map(name => [name, normalizedAboutResponseAllHeaders[name] ?? null]));
  const aboutResponseHeadersArrayDiagnostics = aboutResponseHeadersArray
    .filter(({name}) => aboutResponseDiagnosticHeaderNames.has(name.toLowerCase()));
  offlineDiagnostics.probes.manifestAboutNavigation = {
    url: aboutUrl,
    manifestContainsRoute: aboutInManifest,
    routeIsOutsideShell: aboutNotInShell,
    cacheBeforeNavigation: aboutBefore,
    navigationError: aboutNavigationError,
    status: aboutResponse?.status() ?? null,
    responseUrl: aboutResponse?.url() ?? null,
    workerNetworkEvents: workerEventsFor(aboutUrl),
    workerRouteDenials: workerNetworkDenials.filter(event => event.url === aboutUrl),
    playwrightResponse: aboutResponse ? {
      api: 'page.goto navigation Response',
      fromServiceWorker: aboutResponse.fromServiceWorker(),
      request: {
        isNavigationRequest: aboutResponse.request().isNavigationRequest(),
        resourceType: aboutResponse.request().resourceType(),
      },
      sameOriginAsRequest: new URL(aboutResponse.url()).origin === new URL(aboutUrl).origin,
      headers: aboutResponseHeaderDiagnostics,
      allHeaders: normalizedAboutResponseAllHeaderDiagnostics,
      headersArray: aboutResponseHeadersArrayDiagnostics,
      headerValues: aboutResponseHeaderValues,
      cachedAtHeaderValueCanonical: aboutCachedAtHeaderValueCanonical,
      accessControlExposeHeaders: normalizedAboutResponseAllHeaders['access-control-expose-headers'] ?? null,
    } : null,
    bodyByteLength: aboutResponseBody.length,
    bodySha256: sha256(aboutResponseBody),
    bodyPrefix: aboutBodyText.slice(0, 240),
    cacheAfterNavigation: summarizeDetailedCacheState(aboutAfter),
    fallbackAssetUrl: expectedOffline.url || null,
    fallbackAssetStatus: expectedOffline.status ?? null,
    fallbackAssetHeaders: expectedOffline.headers || {},
    fallbackAssetBodyByteLength: expectedOffline.bodyBytes?.length ?? null,
    fallbackAssetBodySha256: expectedOfflineSha256,
    fallbackAssetManifestSha256: manifest.files?.['offline.html'] || null,
  };

  // Keep the original synthetic route as a diagnostic probe even when the
  // manifest-backed positive route fails. Its raw response and cache state
  // help distinguish a service worker miss from a server-side 404.
  const unknownBefore = await captureDetailedServiceWorkerCacheState(page, cacheName, state.cacheKeyUrls);
  let unknownResponse = null;
  let unknownNavigationError = null;
  try {
    unknownResponse = await page.goto(unknownUrl, {waitUntil: 'domcontentloaded'});
  } catch (error) {
    unknownNavigationError = error?.stack || String(error);
  }
  const unknownResponseBody = unknownResponse
    ? await unknownResponse.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
  const unknownBodyText = await page.locator('body').innerText().catch(() => '');
  const unknownAfter = await captureDetailedServiceWorkerCacheState(page, cacheName, state.cacheKeyUrls);
  offlineDiagnostics.probes.unknownNavigation = {
    url: unknownUrl,
    navigationError: unknownNavigationError,
    status: unknownResponse?.status() ?? null,
    responseUrl: unknownResponse?.url() ?? null,
    headers: unknownResponse?.headers() ?? {},
    bodyByteLength: unknownResponseBody.length,
    bodySha256: sha256(unknownResponseBody),
    bodyPrefix: unknownBodyText.slice(0, 240),
    workerNetworkEvents: workerEventsFor(unknownUrl),
    workerRouteDenials: workerNetworkDenials.filter(event => event.url === unknownUrl),
    controller: unknownBefore.controller || null,
    cacheBeforeNavigation: summarizeDetailedCacheState(unknownBefore),
    cacheAfterNavigation: summarizeDetailedCacheState(unknownAfter),
    offlineWorkerProbe: offlineDiagnostics.probes.offlineWorkerNetwork,
    offlineFallbackCacheKey: summarizeDetailedCacheState(unknownBefore).offlineKey || null,
  };

  assert(aboutInManifest, 'the positive offline route must exist in the publication manifest');
  assert(aboutNotInShell, 'the positive offline route must not be in the install SHELL');
  assert.equal(aboutBefore.entries.manifestAbout?.match, false,
    'manifest-backed about.html must be a real Cache Storage miss before its offline navigation');
  assert.equal(expectedOffline.match, true, 'the exact offline fallback must exist in Cache Storage');
  assert.equal(expectedOffline.cacheKeyUrl, offlineUrl,
    'the exact GET /offline.html Cache Storage request key must identify the cached fallback');
  assert.equal(expectedOffline.url, offlineUrl, 'the cached fallback must identify the actual /offline.html resource');
  assert.equal(expectedOffline.status, 200, 'the cached offline fallback must retain its successful artifact status');
  assert.match(expectedOffline.headers?.['content-type'] || '', /^text\/html\b/i,
    'the cached offline fallback must retain its HTML content type');
  assert(expectedOffline.headers?.['x-huiwen-cached-at'], 'the cached fallback timestamp header must be present');
  assert(!/\b(?:private|no-store)\b/i.test(expectedOffline.headers?.['cache-control'] || ''),
    'the required cached offline fallback must not carry a private or no-store cache directive');
  assert.equal(expectedOfflineSha256, manifest.files?.['offline.html'],
    'the exact cached offline body must match the publication manifest SHA-256');
  assert(aboutResponse, 'manifest-backed offline navigation must return a Service Worker fallback response');
  assert.equal(aboutResponse.fromServiceWorker(), true,
    'manifest-backed offline navigation must be handled by the actual emitted Service Worker');
  assert.equal(new URL(aboutResponse.url()).origin, new URL(aboutUrl).origin,
    'manifest-backed offline navigation must remain same-origin');
  assert.equal(aboutResponse.status(), expectedOffline.status,
    'manifest-backed navigation fallback must preserve the cached fallback status');
  assert.equal(aboutAfter.entries.manifestAbout?.match, false,
    'the network-failed manifest route must remain absent from Cache Storage');
  if (needsWorkerRouteDenial) {
    const aboutRouteAbort = workerNetworkDenials.find(event => event.url === aboutUrl);
    const aboutWorkerFailure = workerEventsFor(aboutUrl).failures.find(
      event => event.workerScriptUrl === activeState.activeScript && event.failure);
    assert(aboutRouteAbort, 'the actual manifest route request must be aborted at the Service Worker-owned network layer');
    assert.equal(aboutRouteAbort.workerScriptUrl, activeState.activeScript,
      'the manifest route abort must belong to the exact active emitted Service Worker');
    assert(aboutWorkerFailure?.failure,
      'the manifest route abort must emit a Service Worker-owned requestfailed event');
  }
  for (const header of ['content-type', 'cache-control', 'x-huiwen-cached-at']) {
    assert.equal(normalizedAboutResponseAllHeaders[header], expectedOffline.headers?.[header],
      `manifest-backed navigation allHeaders must preserve the cached offline ${header} header`);
    assert.equal(aboutResponseHeaderValues[header], expectedOffline.headers?.[header],
      `manifest-backed navigation headerValue must preserve the cached offline ${header} header`);
  }
  assert.equal(aboutCachedAtHeaderValueCanonical, expectedOffline.headers?.['x-huiwen-cached-at'],
    'manifest-backed navigation headerValue must match the cached timestamp with canonical header casing');
  for (const header of ['content-type', 'cache-control']) {
    assert.equal(aboutResponseHeaders[header], expectedOffline.headers?.[header],
      `manifest-backed navigation must preserve the cached offline ${header} header`);
  }
  assert.deepEqual(aboutResponseBody, Buffer.from(expectedOffline.bodyBytes || []),
    'manifest-backed navigation must return the exact cached offline fallback body bytes');
  assert.equal(sha256(aboutResponseBody), manifest.files?.['offline.html'],
    'manifest-backed offline navigation bytes must match the publication manifest SHA-256');
  assert.match(aboutBodyText, /目前離線/);

  const unknownExpected = unknownBefore.offlineKey || {};
  assert.equal(unknownBefore.entries.unknownNavigation?.match, false,
    'the original synthetic unknown route must also begin as a Cache Storage miss');
  assert(unknownResponse, 'the original synthetic unknown route must produce a response or recorded navigation error');
  assert.equal(unknownResponse.fromServiceWorker(), true,
    'unknown navigation fallback must be handled by the actual emitted Service Worker');
  assert.equal(new URL(unknownResponse.url()).origin, new URL(unknownUrl).origin,
    'unknown navigation fallback must remain same-origin');
  assert.equal(unknownResponse.status(), unknownExpected.status,
    'unknown navigation must be checked against the cached offline response, not a live 404');
  assert.equal(unknownAfter.entries.unknownNavigation?.match, false,
    'the uncached unknown route must remain absent from Cache Storage');
  if (needsWorkerRouteDenial) {
    const unknownRouteAbort = workerNetworkDenials.find(event => event.url === unknownUrl);
    const unknownWorkerFailure = workerEventsFor(unknownUrl).failures.find(
      event => event.workerScriptUrl === activeState.activeScript && event.failure);
    assert(unknownRouteAbort, 'the unknown navigation request must be aborted at the Service Worker-owned network layer');
    assert.equal(unknownRouteAbort.workerScriptUrl, activeState.activeScript,
      'the unknown navigation abort must belong to the exact active emitted Service Worker');
    assert(unknownWorkerFailure?.failure,
      'the unknown navigation abort must emit a Service Worker-owned requestfailed event');
  }
  assert.deepEqual(unknownResponseBody, Buffer.from(unknownExpected.bodyBytes || []),
    'unknown navigation must return the cached offline response bytes');
  assert.match(unknownBodyText, /目前離線/);

  await context.setOffline(false);
  state.offline = false;
  offlineDiagnostics.transitions.push({api: 'BrowserContext.setOffline', offline: false, status: 'accepted'});
  const restoredState = await captureOfflineConnectivity(context, page, 'after-context-online-restore', state.offline);
  offlineDiagnostics.connectivity.push(restoredState);
  assert.equal(restoredState.pageOnline, true, 'the context page must report online after setOffline(false)');
  return {
    checks: ['controller and emitted cache identity', 'old cache cleanup', 'unrelated cache preservation',
      'query-preserving exact cache hit', 'context and Service Worker offline network failure',
      'offline fallback and Taiwan-time banner'],
    shellEntry: queryEntry,
    activeScript: activeState.activeScript,
    cacheName,
  };
}

async function runSensitiveRequestChecks(browser, emittedWorker) {
  const fixture = await listenFixture({workerBytes: emittedWorker});
  const context = await browser.newContext({serviceWorkers: 'allow'});
  context.setDefaultTimeout(12000);
  context.setDefaultNavigationTimeout(15000);
  const page = await context.newPage();
  await page.goto(fixture.baseUrl + '/', {waitUntil: 'domcontentloaded'});
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'});
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {timeout: 12000});
  const activeName = (await page.evaluate(() => caches.keys())).find(key => key.startsWith('huiwen-digital-v16-'));
  assert(activeName, 'fixture must install the exact emitted worker bytes');

  const requests = [
    '/index.html?cmsEdit=1',
    '/api/private.json?token=fixture',
    '/cms-page-editor.deadbeef.js',
    '/cms-editor-manifests/draft.json',
    '/index.html?preview=1',
    '/index.html?session=fixture',
    '/data/achievements.json',
    '/sw.js',
    '/deployment.json',
    '/publication-manifest.json',
  ];
  for (const path of requests) {
    const response = await page.evaluate(async url => {
      const result = await fetch(url, {cache: 'no-store'});
      return {status: result.status, body: await result.text()};
    }, path);
    assert.equal(response.status, 200, path + ' fixture must return a fake success response');
  }
  const authorizationResponse = await page.evaluate(async () => {
    const response = await fetch('/styles.css?v=authorization-fixture', {
      cache: 'no-store', headers: {Authorization: 'Bearer c11-fixture'},
    });
    return response.status;
  });
  assert.equal(authorizationResponse, 200);
  for (const path of requests.concat('/styles.css?v=authorization-fixture')) {
    const cached = await page.evaluate(async url => {
      const cache = await caches.open((await caches.keys()).find(key => key.startsWith('huiwen-digital-v16-')));
      return Boolean(await cache.match(new URL(url, location.origin).href));
    }, path);
    assert.equal(cached, false, 'sensitive or credential-bearing response must not be cached: ' + path);
  }

  for (const path of [
    '/public-response.json?v=no-store',
    '/public-response.json?v=private-response',
    '/public-response.css?v=no-store',
  ]) {
    const response = await page.evaluate(async url => {
      const result = await fetch(url, {cache: 'no-store'});
      return result.status;
    }, path);
    assert.equal(response, 200, path + ' fixture must return a fake success response');
  }
  const privateKeys = await page.evaluate(async name => {
    const cache = await caches.open(name);
    return (await cache.keys()).map(request => new URL(request.url).pathname + new URL(request.url).search);
  }, activeName);
  assert(!privateKeys.some(key => key.includes('no-store') || key.includes('private-response')),
    'Cache-Control private/no-store must block cache writes on otherwise public paths');

  assert(fixture.state.workerResponses.includes(sha256(emittedWorker)),
    'the isolated fixture must serve the exact emitted Service Worker bytes');
  await context.close();
  await fixture.close();
  return {checks: ['fake-200 sensitive paths', 'authorization header bypass', 'private/no-store response bypass']};
}

async function runFailedInstallUpdateCheck(browser, emittedWorker) {
  const fixture = await listenFixture({workerBytes: Buffer.from(OLD_WORKER)});
  const context = await browser.newContext({serviceWorkers: 'allow'});
  context.setDefaultTimeout(12000);
  context.setDefaultNavigationTimeout(15000);
  const page = await context.newPage();
  let oldState = null;
  let terminalState = null;
  let afterState = null;
  try {
    await page.goto(fixture.baseUrl + '/', {waitUntil: 'domcontentloaded'});
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'});
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {timeout: 12000});
    oldState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      await caches.open('huiwen-digital-v11-c11-working-controller').then(cache =>
        cache.put(new Request(location.origin + '/working-controller-marker'), new Response('old controller remains active')));
      window.__oldController = navigator.serviceWorker.controller;
      window.__oldActiveWorker = registration.active;
      return {controllerScript: window.__oldController.scriptURL, activeScript: registration.active.scriptURL};
    });
    const beforeOfflineRequests = fixture.state.offlineRequests;
    fixture.state.workerBytes = Buffer.from(emittedWorker);
    fixture.state.failingOffline = true;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      window.__failedUpdateWorker = null;
      const captureInstallingWorker = () => {
        if (registration.installing) window.__failedUpdateWorker = registration.installing;
      };
      registration.addEventListener('updatefound', captureInstallingWorker);
      try { await registration.update(); } catch { /* Failed installation is asserted through the active controller below. */ }
      captureInstallingWorker();
    });
    await waitFor(() => fixture.state.workerResponses.includes(sha256(emittedWorker)),
      'the browser to request the exact emitted update worker');
    await waitFor(() => fixture.state.offlineRequests > beforeOfflineRequests
        && fixture.state.offlineResponses.some(result => result.status === 503),
      'the emitted worker to receive HTTP 503 for its required offline fallback install');
    terminalState = await waitFor(async () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const failedWorker = window.__failedUpdateWorker;
      if (failedWorker?.state !== 'redundant' || registration.installing || registration.waiting) return null;
      return {
        failedWorkerState: failedWorker.state,
        installingState: registration.installing?.state || null,
        waitingState: registration.waiting?.state || null,
      };
    }), 'the failed worker to become redundant and registration slots to clear');
    afterState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const markerCache = await caches.open('huiwen-digital-v11-c11-working-controller');
      const marker = await markerCache.match(new Request(location.origin + '/working-controller-marker'));
      return {
        sameController: navigator.serviceWorker.controller === window.__oldController,
        sameActiveWorker: registration.active === window.__oldActiveWorker,
        controllerState: navigator.serviceWorker.controller?.state,
        activeState: registration.active?.state,
        failedWorkerState: window.__failedUpdateWorker?.state || null,
        installingState: registration.installing?.state || null,
        waitingState: registration.waiting?.state || null,
        caches: await caches.keys(),
        priorCacheMarker: marker ? await marker.text() : null,
      };
    });
    assert.equal(fixture.state.workerResponses.at(-1), sha256(emittedWorker),
      'the failed update fixture must serve the exact emitted Service Worker bytes');
    assert(fixture.state.offlineResponses.some(result => result.status === 503 && result.path === '/offline.html'),
      'the emitted worker must receive HTTP 503 for the required offline fallback');
    assert.equal(terminalState.failedWorkerState, 'redundant');
    assert.equal(terminalState.installingState, null);
    assert.equal(terminalState.waitingState, null);
    assert.equal(afterState.failedWorkerState, 'redundant');
    assert.equal(afterState.installingState, null);
    assert.equal(afterState.waitingState, null);
    assert.equal(afterState.sameController, true, 'failed install must not replace the old working controller');
    assert.equal(afterState.sameActiveWorker, true, 'failed install must keep the original active worker');
    assert.equal(afterState.controllerState, 'activated');
    assert.equal(afterState.activeState, 'activated');
    assert(afterState.caches.includes('huiwen-digital-v11-c11-working-controller'),
      'the prior working cache must remain after the required offline fallback returns 503');
    assert.equal(afterState.priorCacheMarker, 'old controller remains active',
      'the old worker cache entry must remain unchanged after the failed update');
    assert.equal(oldState.controllerScript, oldState.activeScript);
    return {checks: ['exact emitted-worker update failure', 'HTTP 503 required fallback',
      'redundant terminal state and cleared registration slots', 'old active controller and cache retained']};
  } finally {
    let finallyState = null;
    let finallyStateError = null;
    try {
      finallyState = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const cacheName = 'huiwen-digital-v11-c11-working-controller';
        const names = await caches.keys();
        const cache = names.includes(cacheName) ? await caches.open(cacheName) : null;
        const marker = cache && await cache.match(new Request(location.origin + '/working-controller-marker'));
        return {
          failedWorkerState: window.__failedUpdateWorker?.state || null,
          installingState: registration?.installing?.state || null,
          waitingState: registration?.waiting?.state || null,
          sameController: navigator.serviceWorker.controller === window.__oldController,
          sameActiveWorker: registration?.active === window.__oldActiveWorker,
          controllerState: navigator.serviceWorker.controller?.state || null,
          activeState: registration?.active?.state || null,
          oldCachePresent: names.includes(cacheName),
          priorCacheMarker: marker ? await marker.text() : null,
        };
      });
    } catch (error) {
      finallyStateError = error?.stack || String(error);
    }
    report.failedInstallUpdate = {
      expectedWorkerSha256: sha256(emittedWorker),
      workerResponseHashes: fixture.state.workerResponses,
      offlineRequests: fixture.state.offlineRequests,
      offlineResponses: fixture.state.offlineResponses,
      oldState,
      terminalState,
      afterState,
      finallyState,
      finallyStateError,
    };
    try { await context.close(); } catch (error) {
      report.failedInstallUpdate.contextCloseError = error?.stack || String(error);
    }
    try { await fixture.close(); } catch (error) {
      report.failedInstallUpdate.fixtureCloseError = error?.stack || String(error);
    }
  }
}

async function main() {
  await mkdir(REPORT_DIR, {recursive: true});
  const emittedWorker = Buffer.from(await readFile(join(ARTIFACT, 'sw.js')));
  const manifestBytes = Buffer.from(await readFile(join(ARTIFACT, 'publication-manifest.json')));
  const manifest = JSON.parse(await readFile(join(ARTIFACT, 'publication-manifest.json'), 'utf8'));
  const deployment = JSON.parse(await readFile(join(ARTIFACT, 'deployment.json'), 'utf8'));
  report.artifact = {
    workerSha256: sha256(emittedWorker),
    publicationManifestSha256: sha256(manifestBytes),
    sourceCommit: deployment.sourceCommit,
    publicArtifactDigest: deployment.publicArtifactDigest,
  };
  const browser = await chromium.launch({headless: true});
  try {
    await check('Wrangler-served public artifact lifecycle, cache hit, and offline behavior',
      () => runArtifactChecks(browser, emittedWorker, manifest, deployment));
    await check('fake-200 sensitive requests and response cache directives',
      () => runSensitiveRequestChecks(browser, emittedWorker));
    await check('failed required-offline update retains the prior controller',
      () => runFailedInstallUpdateCheck(browser, emittedWorker));
  } finally {
    await browser.close();
    await Promise.allSettled(fixtures.map(fixture => fixture.close()));
    report.finishedAt = new Date().toISOString();
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  }
  if (report.failures.length) process.exitCode = 1;
  else console.log('Service Worker artifact browser checks passed');
}

main().catch(error => {
  report.fatal = error?.stack || String(error);
  report.finishedAt = new Date().toISOString();
  return mkdir(REPORT_DIR, {recursive: true})
    .then(() => writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n'))
    .finally(() => { process.exitCode = 1; });
});
