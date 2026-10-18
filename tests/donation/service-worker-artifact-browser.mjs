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
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + message);
}

async function listenFixture({workerBytes, failingOffline = false} = {}) {
  const state = {
    workerBytes,
    failingOffline,
    workerResponses: [],
    offlineRequests: 0,
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
  const context = await browser.newContext({serviceWorkers: 'allow'});
  context.setDefaultTimeout(12000);
  context.setDefaultNavigationTimeout(15000);
  const page = await context.newPage();
  const serverWorkerBytes = Buffer.from(await readFile(join(ARTIFACT, 'sw.js')));
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
  const cacheName = emittedWorker.match(/const CACHE='([^']+)';/)?.[1];
  assert(cacheName, 'emitted worker must define its derived cache name');
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

  const shell = JSON.parse(emittedWorker.match(/const SHELL=(\[[^;]*\]);/)?.[1] || 'null');
  const queryEntry = shell.find(value => /\.(?:css|js)\?/.test(value));
  assert(queryEntry, 'artifact SHELL must contain a versioned CSS or JavaScript URL');
  const absoluteShellUrl = new URL(queryEntry, new URL('/', BASE_URL)).href;
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

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
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
      const response = await fetch(url.replace(/\?.*$/, '?c11-different-query=1'), {cache: 'no-store'});
      return {ok: response.ok, status: response.status};
    } catch (error) {
      return {ok: false, error: error.name};
    }
  }, absoluteShellUrl);
  assert.equal(changedQuery.ok, false, 'a changed query must not reuse the cached response while offline');

  await page.goto(new URL('/index.html', BASE_URL).href, {waitUntil: 'domcontentloaded'});
  await page.locator('[data-offline-cache]').waitFor({state: 'attached', timeout: 8000});
  const banner = await page.locator('[data-offline-cache]').innerText();
  assert.match(banner, /儲存時間：.+（台灣時間）/);
  const offlineFallback = await page.goto(new URL('/c11-never-cached-route.html', BASE_URL).href,
    {waitUntil: 'domcontentloaded'});
  assert(offlineFallback && offlineFallback.ok(), 'uncached offline navigation must receive the cached fallback');
  assert.match(await page.locator('body').innerText(), /目前離線/);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await context.close();
  return {
    checks: ['controller and emitted cache identity', 'old cache cleanup', 'unrelated cache preservation',
      'query-preserving exact cache hit', 'offline query mismatch', 'offline fallback and Taiwan-time banner'],
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
  await page.goto(fixture.baseUrl + '/', {waitUntil: 'domcontentloaded'});
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'});
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {timeout: 12000});
  const oldState = await page.evaluate(async () => {
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
    try { await registration.update(); } catch { /* Failed installation is asserted through the active controller below. */ }
  });
  await waitFor(() => fixture.state.workerResponses.length >= 2, 'the browser to request the emitted update worker');
  await waitFor(() => fixture.state.offlineRequests > beforeOfflineRequests,
    'the emitted worker to fail its required offline fallback install');
  await page.waitForTimeout(800);
  const afterState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return {
      sameController: navigator.serviceWorker.controller === window.__oldController,
      sameActiveWorker: registration.active === window.__oldActiveWorker,
      controllerState: navigator.serviceWorker.controller?.state,
      activeState: registration.active?.state,
      installingState: registration.installing?.state || null,
      caches: await caches.keys(),
    };
  });
  assert(fixture.state.workerResponses.includes(sha256(emittedWorker)),
    'the failed update fixture must serve the exact emitted Service Worker bytes');
  assert.equal(afterState.sameController, true, 'failed install must not replace the old working controller');
  assert.equal(afterState.sameActiveWorker, true, 'failed install must keep the original active worker');
  assert.equal(afterState.controllerState, 'activated');
  assert.equal(afterState.activeState, 'activated');
  assert(afterState.caches.includes('huiwen-digital-v11-c11-working-controller'),
    'the prior working cache must remain after the required offline fallback returns 503');
  assert.equal(oldState.controllerScript, oldState.activeScript);
  await context.close();
  await fixture.close();
  return {checks: ['emitted-worker update failure', 'old active controller retained', 'old working cache retained']};
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
