/** Pure Node VM checks for install/activate/fetch invariants; no browser or network. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const workerPath = process.argv[2];
assert(workerPath, 'Pass the built public sw.js path');
const source = await readFile(workerPath, 'utf8');
const cacheName = source.match(/const CACHE='([^']+)';/)?.[1];
assert(cacheName, 'Built worker must have a derived CACHE name');
const shell = JSON.parse(source.match(/const SHELL=(\[[^;]*\]);/)?.[1] || 'null');
assert(Array.isArray(shell), 'Built worker must have a derived SHELL');

const origin = 'https://www.huiwen.tw';
const resolve = value => new URL(typeof value === 'string' ? value : value.url, origin + '/sw.js').href;
const keyOf = value => resolve(value);

class TestCache {
  constructor() { this.entries = new Map(); }
  async put(request, response) { this.entries.set(keyOf(request), response.clone()); }
  async match(request) { return this.entries.get(keyOf(request))?.clone(); }
  async delete(request) { return this.entries.delete(keyOf(request)); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
}

function makeWorker({failOffline = false, failOptionalPath = null, networkOffline = false} = {}) {
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
    async skipWaiting() { skipWaitingCount += 1; },
    clients: {async claim() { claimCount += 1; }},
  };
  const fetch = async input => {
    const url = resolve(input);
    calls.push(url);
    const path = new URL(url).pathname;
    if (failOffline && path === '/offline.html') return new Response('offline unavailable', {status: 503});
    if (failOptionalPath && path === failOptionalPath) return new Response('optional unavailable', {status: 503});
    if (networkOffline) throw new Error('fixture offline');
    return new Response('fixture:' + url, {status: 200, headers: {'Content-Type': 'text/plain'}});
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
  const raw = new Request(origin + '/data/achievements.json');
  await active.put(raw, new Response('[{"id":"raw-source"}]'));
  let activation;
  env.handlers.activate({waitUntil(promise) { activation = promise; }});
  await activation;
  assert.deepEqual((await env.caches.keys()).sort(), [cacheName, 'unrelated-cache'].sort());
  assert.equal(env.claimCount, 1);
  assert.equal(await active.match(raw), undefined);
  assert((await active.match(origin + '/offline.html')));
  const failedShellUrl = env.calls.find(url => new URL(url).pathname === '/styles.css');
  assert(failedShellUrl, 'fixture exercised an optional shell request failure');

  // A network-first raw source response remains uncached even after a successful fetch.
  const rawRequest = new Request(origin + '/data/achievements.json');
  let rawResponse;
  env.handlers.fetch({request: rawRequest, respondWith(promise) { rawResponse = promise; }, waitUntil() {}});
  assert.equal((await rawResponse).status, 200);
  assert.equal(await active.match(rawRequest), undefined);

  const exact = shell.find(url => url.startsWith('./home.js?'));
  assert(exact, 'homepage JavaScript URL must preserve its query string');
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
