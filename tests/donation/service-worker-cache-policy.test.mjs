import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const workerTemplate = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
const policyBlock = workerTemplate.match(
  /\/\* BEGIN HUIWEN SW CACHE POLICY \*\/([\s\S]*?)\/\* END HUIWEN SW CACHE POLICY \*\//,
);
assert(policyBlock, 'root Service Worker must contain the canonical delimited cache policy');
const policyContext = {URL};
vm.runInNewContext(policyBlock[1] + '\nglobalThis.__policyUnderTest = cachePolicy;', policyContext);
const policy = policyContext.__policyUnderTest;
const origin = 'https://www.huiwen.tw';
const request = (path, init) => new Request(new URL(path, origin), init);

test('public paths and exact version queries remain cacheable', () => {
  for (const path of [
    '/index.html',
    '/styles.css?v=abc123',
    '/home.js?v=abc123',
    '/data/achievements-public.json?v=abc123',
    '/data/legal-schedule.json?v=abc123',
    '/manifest.webmanifest?v=abc123',
  ]) {
    assert.equal(policy.isCacheableRequest(request(path)), true, path);
  }
});

test('private routes, raw sources, receipts, and protected query names bypass caching', () => {
  for (const path of [
    '/admin/index.html',
    '/api/private.json?token=fixture',
    '/cms-page-editor.deadbeef.js',
    '/cms-editor-manifests/draft.json',
    '/runtime/config.json',
    '/runtime.deadbeef.js',
    '/sw.js',
    '/data/achievements.json',
    '/deployment.json',
    '/publication-manifest.json',
    '/index.html?cmsEdit=1',
    '/index.html?cmsPreview=1',
    '/index.html?draft=1',
    '/index.html?preview=1',
    '/index.html?previewToken=fixture',
    '/index.html?token=fixture',
    '/index.html?access_token=fixture',
    '/index.html?session=fixture',
    '/index.html?session_id=fixture',
  ]) {
    assert.equal(policy.isCacheableRequest(request(path)), false, path);
  }
  assert.equal(policy.isCacheableRequest(request('/styles.css?v=abc123', {
    headers: {Authorization: 'Bearer fixture'},
  })), false);
  assert.equal(policy.isCacheableRequest({
    url: origin + '/styles.css?v=abc123', method: 'GET',
    headers: new Headers({Cookie: 'session=fixture'}),
  }), false, 'a Cookie header is rejected when the browser exposes it to the worker');
});

test('private and no-store response directives are never cacheable', () => {
  const publicRequest = request('/index.html?v=abc123');
  assert.equal(policy.canCache(publicRequest, new Response('public')), true);
  for (const value of [
    'private',
    'private=Set-Cookie',
    'public, no-store',
    'NO-STORE, max-age=60',
  ]) {
    assert.equal(policy.canCache(publicRequest, new Response('fixture', {
      headers: {'Cache-Control': value},
    })), false, value);
  }
  assert.equal(policy.canCache(publicRequest, new Response('unavailable', {status: 503})), false);
});
