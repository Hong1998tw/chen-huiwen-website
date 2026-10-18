/** Pure Node VM checks for install/activate/fetch invariants; no browser or network. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const workerPath = process.argv[2];
assert(workerPath, 'Pass the built public sw.js path');
const source = await readFile(workerPath, 'utf8');
const cacheName = source.match(/const CACHE='([^']+)';/)?.[1];
assert(cacheName, 'Built worker must have a derived CACHE name');
const shellLiteral = source.match(/const SHELL=(\[[^;]*\]);/)?.[1];
assert(shellLiteral, 'Worker must define SHELL');
const shell = vm.runInNewContext('(' + shellLiteral + ')', {});
assert(Array.isArray(shell), 'Built worker must have a derived SHELL');
const requiredShellLiteral = source.match(/const REQUIRED_SHELL=(\[[^;]*\]);/)?.[1];
assert(requiredShellLiteral, 'Worker must define REQUIRED_SHELL');
const requiredShell = vm.runInNewContext('(' + requiredShellLiteral + ')', {});
assert(Array.isArray(requiredShell), 'Built worker must have a derived REQUIRED_SHELL');

const origin = 'https://www.huiwen.tw';
const resolve = value => new URL(typeof value === 'string' ? value : value.url, origin + '/sw.js').href;
const keyOf = value => resolve(value);

class TestCache {
  constructor() { this.entries = new Map(); }
  async put(request, response) {
    const key = keyOf(request);
    const storedRequest = typeof request === 'string' ? new Request(key) : request.clone();
    this.entries.set(key, {request: storedRequest, response: response.clone()});
  }
  async match(request) { return this.entries.get(keyOf(request))?.response.clone(); }
  async delete(request) { return this.entries.delete(keyOf(request)); }
  async keys() { return [...this.entries.values()].map(entry => entry.request.clone()); }
}

function makeWorker({failOffline = false, failRequiredPath = null, requiredFontCacheControl = null,
  failOptionalPath = null, networkOffline = false} = {}) {
  const handlers = {};
  const stores = new Map();
  const calls = [];
  let skipWaitingCount = 0;
  let claimCount = 0;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new TestCache());
      return stores.get(name);
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) {
      for (const cache of stores.values()) {
        const response = await cache.match(request);
        if (response) return response;
      }
      return undefined;
    },
  };
  const self = {
    addEventListener(name, callback) { handlers[name] = callback; },
    registration: {scope: origin + '/'},
    async skipWaiting() { skipWaitingCount += 1; },
    clients: {async claim() { claimCount += 1; }},
  };
  const fetch = async input => {
    const url = resolve(input);
    calls.push(url);
    const path = new URL(url).pathname;
    if (failOffline && path === '/offline.html') return new Response('offline unavailable', {status: 503});
    if (failRequiredPath && path === new URL(resolve(failRequiredPath)).pathname) {
      return new Response('required offline font unavailable', {status: 503});
    }
    if (failOptionalPath && path === failOptionalPath) return new Response('optional unavailable', {status: 503});
    if (networkOffline) throw new Error('fixture offline');
    const headers = {'Content-Type': 'text/plain'};
    if (new URL(url).searchParams.get('v') === 'no-store') headers['Cache-Control'] = 'no-store';
    if (new URL(url).searchParams.get('v') === 'private-response') headers['Cache-Control'] = 'private';
    if (path.endsWith('.woff2') && requiredFontCacheControl) headers['Cache-Control'] = requiredFontCacheControl;
    return new Response('fixture:' + url, {status: 200, headers});
  };
  const context = {
    self, caches, fetch, location: {origin}, URL, Request, Response, Headers,
    AbortController, Intl, Date, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, context, {filename: workerPath});
  return {
    handlers, caches, stores, calls,
    get skipWaitingCount() { return skipWaitingCount; },
    get claimCount() { return claimCount; },
    setNetworkOffline(value) { context.fetch = async input => {
      const url = resolve(input);
      calls.push(url);
      if (value) throw new Error('fixture offline');
      return new Response('fixture:' + url, {status: 200});
    }; },
  };
}

const priorName = 'huiwen-digital-v11-fixture';
const priorURL = origin + '/index.html';

// Schema-2 offline common/delta fonts are required and fail closed on 503/private/no-store.
if (requiredShell.length) {
  assert.equal(requiredShell.length, 2, 'only the exact offline common/delta font pair is required');
  for (const fontUrl of requiredShell) {
    const env = makeWorker({failRequiredPath: fontUrl});
    const prior = await env.caches.open(priorName);
    await prior.put(priorURL, new Response('previous usable cache'));
    let installation;
    env.handlers.install({waitUntil(promise) { installation = promise; }});
    await assert.rejects(installation, /Required offline shell asset unavailable/);
    assert.equal(env.skipWaitingCount, 0, fontUrl + ' failure must not skipWaiting');
    assert((await env.caches.keys()).includes(priorName), 'prior active cache must remain after ' + fontUrl + ' failure');
    assert.equal(await (await prior.match(priorURL)).text(), 'previous usable cache');
    assert(env.calls.includes(resolve(fontUrl)), 'worker must request the exact required font URL');
  }

  for (const directive of ['private', 'no-store']) {
    const env = makeWorker({requiredFontCacheControl: directive});
    const prior = await env.caches.open(priorName);
    await prior.put(priorURL, new Response('previous usable cache'));
    let installation;
    env.handlers.install({waitUntil(promise) { installation = promise; }});
    await assert.rejects(installation, /Required offline shell asset unavailable/);
    assert.equal(env.skipWaitingCount, 0, directive + ' required-font response must not skipWaiting');
    assert((await env.caches.keys()).includes(priorName));
    assert.equal(await (await prior.match(priorURL)).text(), 'previous usable cache');
  }
}

// A missing required offline document rejects install before skipWaiting or cleanup.
{
  const env = makeWorker({failOffline: true});
  const prior = await env.caches.open(priorName);
  await prior.put(priorURL, new Response('previous usable cache'));
  let installation;
  env.handlers.install({waitUntil(promise) { installation = promise; }});
  await assert.rejects(installation, /Offline fallback unavailable/);
  assert.equal(env.skipWaitingCount, 0);
  assert((await env.caches.keys()).includes(priorName));
  assert.equal(await (await prior.match(priorURL)).text(), 'previous usable cache');
}

// Optional shell failures do not block install; activation then removes old caches and raw source.
{
  const env = makeWorker({failOptionalPath: '/styles.css'});
  await env.caches.open(priorName);
  const oldUnrelated = await env.caches.open('unrelated-cache');
  await oldUnrelated.put(priorURL, new Response('unrelated cache stays'));
  let installation;
  env.handlers.install({waitUntil(promise) { installation = promise; }});
  await installation;
  assert.equal(env.skipWaitingCount, 1);
  assert.equal(env.calls.filter(url => url.endsWith('/offline.html')).length, 1,
    'offline is fetched once as a required resource, even though it is listed in SHELL');
  const active = await env.caches.open(cacheName);
  for (const fontUrl of requiredShell) {
    const exactUrl = resolve(fontUrl);
    assert(await active.match(exactUrl), 'exact required offline font must be cached: ' + fontUrl);
    const changedUrl = new URL(exactUrl);
    changedUrl.searchParams.set('c11-query-mutation', '1');
    assert.equal(await active.match(changedUrl.href), undefined,
      'a mutated query must not match the exact offline font cache key: ' + fontUrl);
  }
  const staleEntries = [
    new Request(origin + '/index.html?cmsEdit=1'),
    new Request(origin + '/api/private.json?token=fixture'),
    new Request(origin + '/cms-page-editor.deadbeef.js'),
    new Request(origin + '/cms-editor-manifests/draft.json'),
    new Request(origin + '/runtime/config.json'),
    new Request(origin + '/sw.js'),
    new Request(origin + '/data/achievements.json'),
    new Request(origin + '/styles.css?v=old-auth', {headers: {Authorization: 'Bearer fixture'}}),
    new Request(origin + '/styles.css?v=old-cookie', {headers: {Cookie: 'session=fixture'}}),
    new Request(origin + '/deployment.json'),
    new Request(origin + '/publication-manifest.json'),
    new Request(origin + '/index.html?session=fixture'),
    new Request(origin + '/index.html?private-response=1'),
    new Request(origin + '/styles.css?v=no-store'),
  ];
  for (const request of staleEntries) {
    const headers = request.url.includes('private-response') ? {'Cache-Control': 'private'}
      : request.url.includes('no-store') ? {'Cache-Control': 'no-store'} : {};
    await active.put(request, new Response('stale private fixture', {headers}));
  }
  const exactPublicQuery = new Request(origin + '/styles.css?v=public-hash');
  await active.put(exactPublicQuery, new Response('public exact query'));
  let activation;
  env.handlers.activate({waitUntil(promise) { activation = promise; }});
  await activation;
  assert.deepEqual((await env.caches.keys()).sort(), [cacheName, 'unrelated-cache'].sort());
  assert.equal(env.claimCount, 1);
  for (const request of staleEntries) assert.equal(await active.match(request), undefined, request.url);
  assert.equal(await active.match(exactPublicQuery).then(response => response.text()), 'public exact query');
  assert((await active.match(origin + '/offline.html')));
  const failedShellUrl = env.calls.find(url => new URL(url).pathname === '/styles.css');
  assert(failedShellUrl, 'fixture exercised an optional shell request failure');

  // Sensitive requests are left to the browser's network path, even for fake 200 responses.
  const bypassRequests = [
    new Request(origin + '/index.html?cmsEdit=1'),
    new Request(origin + '/api/private.json?token=fixture'),
    new Request(origin + '/cms-page-editor.deadbeef.js'),
    new Request(origin + '/index.html?preview=1'),
    new Request(origin + '/index.html?session=fixture'),
    new Request(origin + '/data/achievements.json'),
    new Request(origin + '/sw.js'),
    new Request(origin + '/deployment.json'),
    new Request(origin + '/styles.css?v=auth', {headers: {Authorization: 'Bearer fixture'}}),
    new Request(origin + '/styles.css?v=cookie', {headers: {Cookie: 'session=fixture'}}),
  ];
  for (const request of bypassRequests) {
    let intercepted = false;
    env.handlers.fetch({request, respondWith() { intercepted = true; }, waitUntil() {}});
    assert.equal(intercepted, false, request.url + ' must bypass the worker');
    assert.equal(await active.match(request), undefined, request.url + ' must not enter Cache Storage');
  }

  // A public-looking request still must not cache a fake 200 carrying private/no-store headers.
  for (const query of ['no-store', 'private-response']) {
    const request = new Request(origin + '/public-data.json?v=' + query);
    let responsePromise;
    env.handlers.fetch({request, respondWith(promise) { responsePromise = promise; }, waitUntil() {}});
    assert.equal((await responsePromise).status, 200);
    assert.equal(await active.match(request), undefined, query + ' response must not be stored');
  }
  const publicJson = new Request(origin + '/data/legal-schedule.json?v=public-hash');
  let publicJsonResponse;
  env.handlers.fetch({request: publicJson, respondWith(promise) { publicJsonResponse = promise; }, waitUntil() {}});
  assert.equal((await publicJsonResponse).status, 200);
  assert((await active.match(publicJson)), 'public JSON must retain network-first caching');

  const exact = shell.find(url => url.startsWith('./home.js?'))
    || shell.find(url => /\.(?:css|js)(?:\?|$)/.test(url));
  assert(exact, 'worker SHELL must include a CSS or JavaScript resource for exact cache-key checks');
  const exactURL = resolve(exact);
  const exactRequest = new Request(exactURL);
  env.setNetworkOffline(true);
  let exactResponse;
  const pending = [];
  env.handlers.fetch({request: exactRequest, respondWith(promise) { exactResponse = promise; }, waitUntil(promise) { pending.push(promise); }});
  assert.equal(await (await exactResponse).text(), 'fixture:' + exactURL);
  await Promise.all(pending);

  const otherQuery = new Request(new URL('?different=1', exactURL).href);
  let otherResponse;
  const noCachePending = [];
  env.handlers.fetch({request: otherQuery, respondWith(promise) { otherResponse = promise; }, waitUntil(promise) { noCachePending.push(promise); }});
  assert.equal((await otherResponse).type, 'error', 'a different query must not match the cached exact URL');
  await Promise.all(noCachePending);
}

console.log('Service Worker VM checks passed');
