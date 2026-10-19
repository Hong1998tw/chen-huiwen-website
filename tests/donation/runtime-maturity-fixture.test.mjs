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
