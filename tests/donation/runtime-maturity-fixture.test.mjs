import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import {resolveRuntimeMaturityFixtureResponse} from './runtime-maturity-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workerSource = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
const offlineMatch = workerSource.match(/const OFFLINE='([^']+)'/);
assert(offlineMatch, 'the service worker must declare its offline document');
const offlinePath = new URL(offlineMatch[1], 'http://127.0.0.1/').pathname;
assert.match(workerSource, /const offlineRequest=scopedRequest\(OFFLINE\),response=await boundedFetch\(offlineRequest\);/);
assert.match(workerSource, /if\(!cachePolicy\.canCache\(offlineRequest,response\)\)throw new Error\('Offline fallback unavailable'\)/);
const shellMatch = workerSource.match(/const SHELL=\[([^\]]*)\]/);
assert(shellMatch, 'the service worker must declare its optional shell');
const shellAssets = [...shellMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
const policyBlock = workerSource.match(
  /\/\* BEGIN HUIWEN SW CACHE POLICY \*\/([\s\S]*?)\/\* END HUIWEN SW CACHE POLICY \*\//,
);
assert(policyBlock, 'the fixture test must evaluate the production service worker cache policy');
const policyContext = {URL};
vm.runInNewContext(policyBlock[1] + '\nglobalThis.__policyUnderTest = cachePolicy;', policyContext);
const policy = policyContext.__policyUnderTest;
const legacyWorkerVersion = '20260922-public-service-v11';
const serviceWorkerScope = 'http://127.0.0.1/';

class FakeCache {
  constructor(name) {
    this.name = name;
    this.responses = new Map();
  }

  async put(request, response) {
    this.responses.set(request.url, response.clone());
  }

  async match(request) {
    const url = typeof request === 'string' ? new URL(request, serviceWorkerScope).href : request.url;
    return this.responses.get(url)?.clone();
  }

  async keys() {
    return [...this.responses.keys()].map(url => new Request(url));
  }

  async delete(request) {
    const url = typeof request === 'string' ? new URL(request, serviceWorkerScope).href : request.url;
    return this.responses.delete(url);
  }
}

class FakeCacheStorage {
  constructor() {
    this.stores = new Map();
  }

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache(name));
    return this.stores.get(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name) {
    return this.stores.delete(name);
  }
}

async function createProductionInstall({failOptional = false, failRequired = false, noStore = false} = {}) {
  const listeners = new Map();
  const caches = new FakeCacheStorage();
  const oldCacheName = 'huiwen-digital-v14-previous';
  const oldOfflineURL = new URL('./offline.html', serviceWorkerScope).href;
  const oldCache = await caches.open(oldCacheName);
  await oldCache.put(new Request(oldOfflineURL), new Response('previous cache sentinel'));
  const fetched = [];
  const fixtureResponses = [];
  let skipWaitingCalls = 0;
  const self = {
    registration: {scope: serviceWorkerScope},
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    async skipWaiting() {
      skipWaitingCalls += 1;
    },
    clients: {async claim() {}},
  };
  const fixtureFetch = async request => {
    const url = new URL(request.url);
    fetched.push(url.pathname);
    const fixture = await resolveRuntimeMaturityFixtureResponse({
      root,
      pathname: url.pathname,
      requestURL: request.url,
      failOptional,
      failRequired,
      noStore,
      legacyWorkerVersion,
    });
    fixtureResponses.push({pathname: url.pathname, status: fixture.status, cacheControl: fixture.headers['Cache-Control'] || null});
    return new Response(fixture.body, {status: fixture.status, headers: fixture.headers});
  };
  const context = {
    self,
    caches,
    fetch: fixtureFetch,
    URL,
    Request,
    Response,
    Headers,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  const sourceWithContractReadback = `${workerSource}\n;globalThis.__workerContract = {cacheName: CACHE, offline: OFFLINE, shell: SHELL.slice(), requiredShell: REQUIRED_SHELL.slice()};`;
  vm.runInNewContext(sourceWithContractReadback, context, {filename: 'sw.js', timeout: 1000});

  const installHandlers = listeners.get('install') || [];
  assert.equal(installHandlers.length, 1, 'the full production worker registers one install handler');
  const waitUntilPromises = [];
  installHandlers[0]({
    waitUntil(promise) {
      const tracked = Promise.resolve(promise);
      tracked.catch(() => {});
      waitUntilPromises.push(tracked);
    },
  });
  assert.equal(waitUntilPromises.length, 1, 'the production install handler must extend install with waitUntil');

  return {
    caches,
    contract: context.__workerContract,
    fetched,
    fixtureResponses,
    installPromise: waitUntilPromises[0],
    oldOfflineURL,
    oldCacheName,
    get skipWaitingCalls() { return skipWaitingCalls; },
  };
}

function isCacheableOfflineResponse(fixture) {
  const request = new Request('http://127.0.0.1/offline.html');
  const response = new Response(fixture.body, {status: fixture.status, headers: fixture.headers});
  return policy.canCache(request, response);
}

test('offline fixture response satisfies the production required install contract', async () => {
  const fixture = await resolveRuntimeMaturityFixtureResponse({
    root,
    pathname: offlinePath,
    requestURL: offlinePath,
    failOptional: true,
    legacyWorkerVersion,
  });

  assert.equal(fixture.status, 200);
  assert.equal(fixture.headers['Cache-Control'], 'public, max-age=0, must-revalidate');
  assert.equal(isCacheableOfflineResponse(fixture), true);
  assert.match(fixture.body.toString(), /這一頁尚未儲存/);
  assert.equal(policy.canCache(new Request('http://127.0.0.1/offline.html'), new Response('offline', {
    headers: {'Cache-Control': 'no-store'},
  })), false, 'the previous fixture header would fail the production install guard');
});

test('optional shell failures do not make the required offline document unavailable', async () => {
  const optionalShellFailures = shellAssets.filter(path => /\.(css|svg)$/.test(path));
  assert(optionalShellFailures.includes('./digital.css'));
  assert(optionalShellFailures.includes('./assets/favicon.svg'));
  for (const path of optionalShellFailures) {
    const pathname = new URL(path, 'http://127.0.0.1/').pathname;
    const fixture = await resolveRuntimeMaturityFixtureResponse({
      root,
      pathname,
      requestURL: pathname,
      failOptional: true,
      legacyWorkerVersion,
    });
    assert.equal(fixture.status, 503, pathname);
  }

  const offline = await resolveRuntimeMaturityFixtureResponse({
    root,
    pathname: offlinePath,
    requestURL: offlinePath,
    failOptional: true,
    legacyWorkerVersion,
  });
  assert.equal(isCacheableOfflineResponse(offline), true);
});

test('required offline failure fixture remains uncacheable and preserves its delay', async () => {
  const fixture = await resolveRuntimeMaturityFixtureResponse({
    root,
    pathname: offlinePath,
    requestURL: offlinePath,
    failRequired: true,
    legacyWorkerVersion,
  });

  assert.equal(fixture.status, 503);
  assert.equal(fixture.delayMs, 150);
  assert.equal(isCacheableOfflineResponse(fixture), false);
});

test('legacy worker route remains isolated from the current production worker source', async () => {
  const productionScript = await readFile(new URL('../../digital.js', import.meta.url), 'utf8');
  const currentWorkerVersion = productionScript.match(/const SERVICE_WORKER_VERSION = '([^']+)'/)?.[1];
  assert(currentWorkerVersion);
  const [legacyHTML, currentHTML, legacyScript, legacyWorker, currentWorker] = await Promise.all([
    resolveRuntimeMaturityFixtureResponse({root, pathname: '/worker-upgrade-legacy.html', requestURL: '/worker-upgrade-legacy.html', legacyWorkerVersion}),
    resolveRuntimeMaturityFixtureResponse({root, pathname: '/worker-upgrade-current.html', requestURL: '/worker-upgrade-current.html', legacyWorkerVersion}),
    resolveRuntimeMaturityFixtureResponse({root, pathname: '/digital.js', requestURL: `/digital.js?v=${legacyWorkerVersion}`, legacyWorkerVersion}),
    resolveRuntimeMaturityFixtureResponse({root, pathname: '/sw.js', requestURL: `/sw.js?v=${legacyWorkerVersion}`, legacyWorkerVersion}),
    resolveRuntimeMaturityFixtureResponse({root, pathname: '/sw.js', requestURL: `/sw.js?v=${currentWorkerVersion}`, legacyWorkerVersion}),
  ]);

  const hash = createHash('sha256').update(productionScript).digest('hex').slice(0, 12);
  assert.match(legacyHTML.body.toString(), new RegExp(`digital\\.js\\?v=${legacyWorkerVersion}`));
  assert.match(currentHTML.body.toString(), new RegExp(`digital\\.js\\?v=${hash}`));
  assert.equal(legacyScript.body.toString(), productionScript.replace(
    /const SERVICE_WORKER_VERSION = '[^']+'/,
    `const SERVICE_WORKER_VERSION = '${legacyWorkerVersion}'`,
  ));
  assert.equal(legacyWorker.body.toString(), "self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));");
  assert.equal(currentWorker.body.toString(), workerSource);
});

test('the full production install handler caches its required offline document', async () => {
  const runtime = await createProductionInstall();
  assert.equal(runtime.contract.offline, './offline.html');
  assert.deepEqual(Array.from(runtime.contract.requiredShell), [], 'production currently has no additional REQUIRED_SHELL assets');
  assert(runtime.contract.shell.length > 0, 'SHELL assets remain a separate optional group');
  await runtime.installPromise;

  const offlineURL = new URL(runtime.contract.offline, serviceWorkerScope).href;
  const cache = await runtime.caches.open(runtime.contract.cacheName);
  const cachedOffline = await cache.match(offlineURL);
  assert(cachedOffline, 'the real install handler must write offline.html to CacheStorage');
  assert.equal(cachedOffline.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  assert.match(await cachedOffline.text(), /這一頁尚未儲存/);
  assert.equal(runtime.skipWaitingCalls, 1);
  const preservedOldOffline = await (await runtime.caches.open(runtime.oldCacheName)).match(runtime.oldOfflineURL);
  assert.equal(await preservedOldOffline.text(), 'previous cache sentinel', 'install must leave existing cache contents intact');
});

test('the full production install handler rejects no-store offline and preserves the old cache', async () => {
  const runtime = await createProductionInstall({noStore: true});
  await assert.rejects(runtime.installPromise, /Offline fallback unavailable/);

  const offlineURL = new URL(runtime.contract.offline, serviceWorkerScope).href;
  const cache = await runtime.caches.open(runtime.contract.cacheName);
  assert.deepEqual(runtime.fixtureResponses[0], {
    pathname: '/offline.html',
    status: 200,
    cacheControl: 'no-store',
  });
  assert.equal(await cache.match(offlineURL), undefined, 'no-store required offline response must not be written');
  const preservedOldOffline = await (await runtime.caches.open(runtime.oldCacheName)).match(runtime.oldOfflineURL);
  assert.equal(await preservedOldOffline.text(), 'previous cache sentinel', 'failed install must preserve prior cached content');
  assert.equal(runtime.skipWaitingCalls, 0);
});

test('the full production install handler rejects an HTTP failure for required offline', async () => {
  const runtime = await createProductionInstall({failRequired: true});
  await assert.rejects(runtime.installPromise, /Offline fallback unavailable/);

  const offlineURL = new URL(runtime.contract.offline, serviceWorkerScope).href;
  const cache = await runtime.caches.open(runtime.contract.cacheName);
  assert.equal(runtime.fixtureResponses[0].pathname, '/offline.html');
  assert.equal(runtime.fixtureResponses[0].status, 503, 'the actual required response fixture must be HTTP 503');
  assert.equal(await cache.match(offlineURL), undefined, '503 required offline response must not be written');
  assert.equal(runtime.skipWaitingCalls, 0);
});

test('the full production install handler tolerates failed optional shell assets', async () => {
  const runtime = await createProductionInstall({failOptional: true});
  await runtime.installPromise;

  const offlineURL = new URL(runtime.contract.offline, serviceWorkerScope).href;
  const cache = await runtime.caches.open(runtime.contract.cacheName);
  assert(await cache.match(offlineURL), 'the required offline document still installs');
  for (const optionalPath of ['/digital.css', '/assets/favicon.svg']) {
    assert(runtime.fetched.includes(optionalPath), `${optionalPath} must be fetched by the production SHELL pass`);
    assert.equal(runtime.fixtureResponses.find(response => response.pathname === optionalPath)?.status, 503);
    assert.equal(await cache.match(new URL(optionalPath, serviceWorkerScope).href), undefined, `${optionalPath} 503 must not be cached`);
  }
  assert.equal(runtime.skipWaitingCalls, 1, 'optional failures must not block successful installation');
});
