/** Pure Node VM regression for the public top-level service-worker registration gate. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../digital.js', import.meta.url), 'utf8');
const cmsAdminSource = await readFile(new URL('../../admin/public/index.html', import.meta.url), 'utf8');
assert.match(cmsAdminSource, /<iframe[^>]+id="page-frame"[^>]+sandbox="allow-scripts allow-forms"/,
  'the CMS editor preview must keep its existing sandbox permissions');
assert.doesNotMatch(cmsAdminSource, /<iframe[^>]+id="page-frame"[^>]+sandbox="[^"]*\ballow-same-origin\b/,
  'the CMS editor preview must not gain same-origin access');

function extractFunction(sourceText, name) {
  const declaration = `function ${name}() {`;
  const start = sourceText.indexOf(declaration);
  assert.notEqual(start, -1, `digital.js must define ${name}`);
  const open = sourceText.indexOf('{', start);
  let depth = 0;
  let state = 'code';
  let escaped = false;
  for (let index = open; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    const next = sourceText[index + 1];
    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') { state = 'code'; index += 1; }
      continue;
    }
    if (state !== 'code') {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if ((state === 'single' && char === "'") || (state === 'double' && char === '"') ||
          (state === 'template' && char === '`')) state = 'code';
      continue;
    }
    if (char === '/' && next === '/') { state = 'line-comment'; index += 1; continue; }
    if (char === '/' && next === '*') { state = 'block-comment'; index += 1; continue; }
    if (char === "'") { state = 'single'; continue; }
    if (char === '"') { state = 'double'; continue; }
    if (char === '`') { state = 'template'; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  assert.fail(`Could not find the end of ${name}`);
}

const workerVersion = source.match(/const SERVICE_WORKER_VERSION = '([^']+)';/)?.[1];
assert(workerVersion, 'digital.js must define its current service-worker version');
const registerServiceWorker = extractFunction(source, 'registerServiceWorker');
assert.match(source, /\bregisterServiceWorker\(\);/, 'digital.js must invoke the tested registration function');

function createPage({topLevel = true, secure = true, hostname = 'www.huiwen.tw', serviceWorker = 'available'} = {}) {
  const loadListeners = [];
  const registrations = [];
  let serviceWorkerReads = 0;
  const navigator = {};
  if (serviceWorker === 'available') {
    Object.defineProperty(navigator, 'serviceWorker', {
      get() {
        serviceWorkerReads += 1;
        return {register(url) {
          registrations.push(url);
          return Promise.reject(new Error('registration rejection fixture'));
        }};
      },
    });
  } else if (serviceWorker === 'throwing-getter') {
    Object.defineProperty(navigator, 'serviceWorker', {
      get() {
        serviceWorkerReads += 1;
        const error = new Error('Blocked service worker getter in sandboxed frame');
        error.name = 'SecurityError';
        throw error;
      },
    });
  }
  const window = {
    isSecureContext: secure,
    addEventListener(type, callback, options) { loadListeners.push({type, callback, options}); },
  };
  window.self = window;
  window.top = topLevel ? window : {};
  const context = {
    window,
    navigator,
    location: {hostname},
    assetBase: new URL('https://www.huiwen.tw/digital.js'),
    SERVICE_WORKER_VERSION: workerVersion,
    URL,
  };
  vm.runInNewContext(`${registerServiceWorker}\nregisterServiceWorker();`, context, {timeout: 1000});
  return {loadListeners, registrations, get serviceWorkerReads() { return serviceWorkerReads; }};
}

// Sandboxed CMS iframes have an opaque origin. The getter must never be touched.
{
  const page = createPage({topLevel: false, serviceWorker: 'throwing-getter'});
  assert.equal(page.serviceWorkerReads, 0);
  assert.equal(page.loadListeners.length, 0);
  assert.deepEqual(page.registrations, []);
}

// A normal secure public top-level page registers the unchanged version after load.
{
  const page = createPage();
  assert.equal(page.serviceWorkerReads, 0, 'registration remains deferred until load');
  assert.equal(page.loadListeners.length, 1);
  assert.equal(page.loadListeners[0].type, 'load');
  assert.equal(page.loadListeners[0].options.once, true);
  page.loadListeners[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.serviceWorkerReads, 1);
  assert.deepEqual(page.registrations, [`https://www.huiwen.tw/sw.js?v=${workerVersion}`]);
}

// Insecure, local, and unsupported contexts keep their existing no-op behavior.
for (const options of [
  {secure: false, serviceWorker: 'throwing-getter'},
  {hostname: 'localhost', serviceWorker: 'throwing-getter'},
  {hostname: '127.0.0.1', serviceWorker: 'throwing-getter'},
  {serviceWorker: 'missing'},
]) {
  const page = createPage(options);
  assert.equal(page.serviceWorkerReads, 0, JSON.stringify(options));
  assert.equal(page.loadListeners.length, 0, JSON.stringify(options));
  assert.deepEqual(page.registrations, [], JSON.stringify(options));
}

console.log('PASS: CMS iframe guard, public registration, rejection handling, and no-op contexts');
