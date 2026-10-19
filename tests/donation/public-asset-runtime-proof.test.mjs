import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleFingerprintInventory,
  assembleMutableAliasResource,
  assemblePublishedResource,
  bindPublicArtifactProvenance,
  bindProductionPublicArtifactProvenance,
  fingerprintAlias,
  LOCAL_CI_MODE,
  normalizeBaseUrl,
  parseHeaderRules,
  selectSharedCommonFont,
  sha256,
  PRODUCTION_BASE_URL,
  PRODUCTION_LIVE_MODE,
  validateArtifactResponse,
  validateColdWarmCacheProof,
  validateMutableAliasObservation,
} from './public-asset-runtime-proof.mjs';

const origin = 'http://127.0.0.1:8789';
const cacheControl = 'public, max-age=31536000, immutable';
const bytesFor = (value) => Buffer.from(value);
const hashFor = (value) => sha256(bytesFor(value));

function makeFixture() {
  const css = bytesFor('body{color:#123}');
  const js = bytesFor('window.ready=true;');
  const commonFont = bytesFor('font bytes');
  const cssPath = `styles.${sha256(css)}.css`;
  const jsPath = `site.${sha256(js)}.js`;
  const commonFontPath = 'assets/fonts/huiwen-site-sans/page-core/page-common.woff2';
  const files = {
    'styles.css': hashFor('mutable css'),
    [cssPath]: sha256(css),
    'site.js': hashFor('mutable js'),
    [jsPath]: sha256(js),
    [commonFontPath]: sha256(commonFont),
    'page-font-manifest.json': hashFor('font manifest'),
  };
  const headerRules = parseHeaderRules([
    '/*',
    '  X-Content-Type-Options: nosniff',
    `/${cssPath}`,
    `  Cache-Control: ${cacheControl}`,
    `/${jsPath}`,
    `  Cache-Control: ${cacheControl}`,
    '/assets/fonts/huiwen-site-sans/page-core/*',
    `  Cache-Control: ${cacheControl}`,
  ].join('\n'));
  const byteMap = new Map([
    [cssPath, css], [jsPath, js], [commonFontPath, commonFont],
    ['styles.css', bytesFor('mutable css')], ['site.js', bytesFor('mutable js')],
  ]);
  return {
    cssPath, jsPath, commonFontPath, files, byteMap, headerRules,
    publication: { version: 1, publicRecordCount: 7, files },
  };
}

function observation(asset, overrides = {}) {
  const url = new URL(asset.path, origin).href;
  return {
    url,
    status: 200,
    resourceType: asset.path.endsWith('.css') ? 'stylesheet' : asset.path.endsWith('.js') ? 'script' : 'font',
    headers: { 'cache-control': cacheControl, 'content-type': 'text/css' },
    fromDiskCache: false,
    fromServiceWorker: false,
    requestServedFromCache: false,
    encodedDataLength: 120,
    transferSize: 120,
    bodyBytes: asset.bytes,
    bodySha256: asset.sha256,
    ...overrides,
  };
}

test('fingerprint inventory requires filename, publication owner, byte digest and exact immutable header', () => {
  const fixture = makeFixture();
  assert.equal(fingerprintAlias(fixture.cssPath), 'styles.css');
  assert.equal(fingerprintAlias('drafts/private.css'), null);
  const inventory = assembleFingerprintInventory(fixture);
  assert.deepEqual(inventory.assets.map((asset) => asset.alias), ['site.js', 'styles.css']);

  const noAlias = { ...fixture, publication: { files: { [fixture.cssPath]: fixture.files[fixture.cssPath] } } };
  assert.throws(() => assembleFingerprintInventory(noAlias), /no published mutable owner/);
  const tamperedBytes = new Map(fixture.byteMap);
  tamperedBytes.set(fixture.cssPath, bytesFor('tampered'));
  assert.throws(() => assembleFingerprintInventory({ ...fixture, byteMap: tamperedBytes }), /differs from bytes/);
  const wildcardHeader = fixture.headerRules.filter((rule) => rule.pattern !== `/${fixture.cssPath}`);
  assert.throws(() => assembleFingerprintInventory({ ...fixture, headerRules: wildcardHeader }), /exact immutable header/);
  const badDeclared = { ...fixture, publication: {
    files: { ...fixture.files, [fixture.cssPath]: 'a'.repeat(64) },
  } };
  assert.throws(() => assembleFingerprintInventory(badDeclared), /filename differs from publication digest/);
});

test('common font is selected only when both real page-font rows share and preload it', () => {
  const fixture = makeFixture();
  const fontManifest = {
    fonts: { [fixture.commonFontPath]: { sha256: fixture.files[fixture.commonFontPath] } },
    routes: {
      'service.html': { commonFont: fixture.commonFontPath, preloads: [fixture.commonFontPath, 'delta.woff2'] },
      'service-guides.html': { commonFont: fixture.commonFontPath, preloads: [fixture.commonFontPath, 'guides.woff2'] },
    },
  };
  assert.equal(selectSharedCommonFont(fontManifest, 'service.html', 'service-guides.html'), fixture.commonFontPath);
  const font = assemblePublishedResource({
    relativePath: fixture.commonFontPath,
    publication: fixture.publication,
    byteMap: fixture.byteMap,
    headerRules: fixture.headerRules,
    expectedHeaderPattern: '/assets/fonts/huiwen-site-sans/page-core/*',
  });
  assert.equal(font.bytes, 10);
  assert.throws(() => selectSharedCommonFont({
    ...fontManifest,
    routes: { ...fontManifest.routes, 'service-guides.html': { ...fontManifest.routes['service-guides.html'], commonFont: 'other.woff2' } },
  }, 'service.html', 'service-guides.html'), /do not share/);
});

test('cold positive bytes plus one real cache signal prove a successful second-page immutable response', () => {
  const fixture = makeFixture();
  const inventory = assembleFingerprintInventory(fixture);
  const asset = inventory.byAlias.get('styles.css');
  const cold = observation(asset);
  const warm = observation(asset, { requestServedFromCache: true, transferSize: 0, encodedDataLength: 0 });
  const proof = validateColdWarmCacheProof({
    asset, cold, warm, expectedUrl: cold.url, expectedOrigin: origin,
  });
  assert.equal(proof.cacheHit, true);
  assert.equal(proof.warm.cacheSignals.requestServedFromCache, true);

  for (const cacheSignal of [
    { fromDiskCache: true },
    { transferSize: 0 },
  ]) {
    const otherWarm = observation(asset, cacheSignal);
    assert.equal(validateColdWarmCacheProof({
      asset, cold, warm: otherWarm, expectedUrl: cold.url, expectedOrigin: origin,
    }).cacheHit, true);
  }
});

test('cache proof rejects empty samples, mutable aliases, 304, service worker and byte mismatches', () => {
  const fixture = makeFixture();
  const asset = assembleFingerprintInventory(fixture).byAlias.get('site.js');
  const cold = observation(asset);
  const warm = observation(asset, { requestServedFromCache: true, transferSize: 0 });
  const proof = { asset, cold, warm, expectedUrl: cold.url, expectedOrigin: origin };
  assert.throws(() => validateColdWarmCacheProof({ ...proof, warm: null }), /response is missing/);
  assert.throws(() => validateColdWarmCacheProof({ ...proof, warm: { ...warm, status: 304 } }), /expected HTTP 200/);
  assert.throws(() => validateColdWarmCacheProof({ ...proof, warm: { ...warm, fromServiceWorker: true } }), /service worker/);
  assert.throws(() => validateColdWarmCacheProof({ ...proof, warm: { ...warm, transferSize: 20, requestServedFromCache: false } }), /no disk, CDP cache, or zero-transfer evidence/);
  assert.throws(() => validateColdWarmCacheProof({ ...proof, cold: { ...cold, encodedDataLength: 0 } }), /positive transferred bytes/);
  assert.throws(() => validateColdWarmCacheProof({ ...proof, warm: { ...warm, bodySha256: '0'.repeat(64) } }), /SHA-256 differs/);
  assert.throws(() => validateArtifactResponse({
    asset, observation: { ...warm, fromServiceWorker: true }, expectedUrl: warm.url, expectedOrigin: origin,
  }), /service worker/);
});

test('mutable aliases are reported as fresh reads and never as cache-hit proof', () => {
  const fixture = makeFixture();
  const alias = 'styles.css';
  const url = `${origin}/${alias}`;
  const asset = assembleMutableAliasResource({
    alias, publication: fixture.publication, byteMap: fixture.byteMap, headerRules: fixture.headerRules,
  });
  const result = validateMutableAliasObservation({
    alias,
    asset,
    expectedUrl: url,
    expectedOrigin: origin,
    observation: {
      url, status: 200, headers: { 'cache-control': 'public, max-age=0, must-revalidate' },
      bodyBytes: asset.bytes, bodySha256: asset.sha256,
    },
  });
  assert.equal(result.proofEligible, false);
  assert.throws(() => validateMutableAliasObservation({
    alias, asset, expectedUrl: url, expectedOrigin: origin,
    observation: { url, status: 200, headers: { 'cache-control': cacheControl }, bodyBytes: asset.bytes, bodySha256: asset.sha256 },
  }), /unexpectedly has immutable/);
});

test('provenance binds the CI merge, native PR head, runtime, manifest digest and bytes', () => {
  const fixture = makeFixture();
  const publicationManifestBytes = bytesFor(JSON.stringify(fixture.publication));
  const merge = '1'.repeat(40);
  const head = '2'.repeat(40);
  const provenance = bindPublicArtifactProvenance({
    eventName: 'pull_request',
    sourceCiMergeSha: merge,
    pullRequestHeadSha: head,
    eventPayload: { number: 17, pull_request: { head: { sha: head } } },
    deployment: {
      provider: 'cloudflare-static-assets', sourceCommit: merge,
      publicArtifactDigest: sha256(publicationManifestBytes),
      publicFileCount: Object.keys(fixture.files).length,
      publicRecordCount: fixture.publication.publicRecordCount,
    },
    publication: fixture.publication,
    publicationManifestBytes,
    runtime: { playwrightVersion: '1.55.1', chromiumVersion: '140.0.0.0', nodeVersion: 'v24.0.0' },
    runId: '12345', runAttempt: '1',
  });
  assert.equal(provenance.sourceCi.mergeSha, merge);
  assert.equal(provenance.sourceCi.pullRequestHeadSha, head);
  assert.equal(provenance.publicManifest.sha256, sha256(publicationManifestBytes));
  assert.equal(provenance.publicManifest.bytes, publicationManifestBytes.byteLength);
  assert.equal(provenance.runtime.playwrightVersion, '1.55.1');

  const valid = {
    eventName: 'pull_request', sourceCiMergeSha: merge, pullRequestHeadSha: head,
    eventPayload: { pull_request: { head: { sha: head } } },
    deployment: {
      provider: 'cloudflare-static-assets', sourceCommit: merge,
      publicArtifactDigest: sha256(publicationManifestBytes), publicFileCount: Object.keys(fixture.files).length,
      publicRecordCount: fixture.publication.publicRecordCount,
    },
    publication: fixture.publication, publicationManifestBytes,
    runtime: { playwrightVersion: '1.55.1', chromiumVersion: '140.0.0.0' },
  };
  assert.throws(() => bindPublicArtifactProvenance({ ...valid, pullRequestHeadSha: '3'.repeat(40) }), /native GitHub event/);
  assert.throws(() => bindPublicArtifactProvenance({ ...valid, deployment: { ...valid.deployment, sourceCommit: head } }), /CI merge SHA/);
  assert.throws(() => bindPublicArtifactProvenance({ ...valid, publicationManifestBytes: bytesFor('tampered') }), /manifest bytes/);
  assert.throws(() => bindPublicArtifactProvenance({ ...valid, runtime: { ...valid.runtime, playwrightVersion: '1.56.0' } }), /not pinned/);
});

test('mode validation keeps loopback local behavior and limits production-live to the canonical HTTPS origin', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8789', LOCAL_CI_MODE).href, 'http://127.0.0.1:8789/');
  assert.equal(normalizeBaseUrl(PRODUCTION_BASE_URL, PRODUCTION_LIVE_MODE).href, PRODUCTION_BASE_URL);
  for (const value of [
    'https://huiwen.tw/',
    'https://other.example/',
    'http://www.huiwen.tw/',
    'https://user:secret@www.huiwen.tw/',
    'https://www.huiwen.tw/?preview=1',
    'https://www.huiwen.tw/#section',
  ]) {
    assert.throws(() => normalizeBaseUrl(value, PRODUCTION_LIVE_MODE));
  }
  assert.throws(() => normalizeBaseUrl('https://example.com/', 'unknown-mode'), /unsupported/);
});

function makeProductionProvenanceFixture() {
  const fixture = makeFixture();
  const checkoutSha = '3'.repeat(40);
  const publicationManifestBytes = bytesFor(JSON.stringify(fixture.publication));
  const deployment = {
    schemaVersion: 1,
    provider: 'cloudflare-static-assets',
    sourceCommit: checkoutSha,
    publicArtifactDigest: sha256(publicationManifestBytes),
    publicFileCount: Object.keys(fixture.publication.files).length,
    publicRecordCount: fixture.publication.publicRecordCount,
  };
  const deploymentBytes = bytesFor(`${JSON.stringify(deployment)}\n`);
  const runtime = { playwrightVersion: '1.55.1', chromiumVersion: '140.0.0.0', nodeVersion: 'v24.0.0' };
  return {
    fixture,
    publication: fixture.publication,
    publicationManifestBytes,
    deployment,
    deploymentBytes,
    runtime,
    eventName: 'workflow_run',
    eventPayload: { workflow_run: { head_sha: checkoutSha } },
    githubSha: '4'.repeat(40),
    githubRef: 'refs/heads/main',
    checkoutSha,
    liveDeploymentResponse: {
      requestedUrl: `${PRODUCTION_BASE_URL}deployment.json`,
      url: `${PRODUCTION_BASE_URL}deployment.json`,
      status: 200,
      body: deploymentBytes,
    },
  };
}

test('production provenance binds workflow event, checked out HEAD, local artifact and real HTTP receipt', () => {
  const valid = makeProductionProvenanceFixture();
  const provenance = bindProductionPublicArtifactProvenance(valid);
  assert.equal(provenance.mode, PRODUCTION_LIVE_MODE);
  assert.equal(provenance.sourceCi.checkoutSha, valid.checkoutSha);
  assert.equal(provenance.sourceCi.checkoutShaContract, 'github.event.workflow_run.head_sha');
  assert.equal(provenance.sourceCi.githubSha, valid.githubSha);
  assert.notEqual(provenance.sourceCi.githubSha, provenance.sourceCi.checkoutSha,
    'workflow_run must bind head_sha and must not blindly require GITHUB_SHA');
  assert.equal(provenance.localDeployment.publicArtifactDigest, sha256(valid.publicationManifestBytes));
  assert.equal(provenance.liveDeployment.sha256, sha256(valid.deploymentBytes));

  const dispatch = {
    ...valid,
    eventName: 'workflow_dispatch',
    githubSha: valid.checkoutSha,
    eventPayload: { ref: 'refs/heads/main', inputs: {} },
  };
  assert.equal(bindProductionPublicArtifactProvenance(dispatch).sourceCi.checkoutShaContract,
    'GITHUB_SHA for the native workflow_dispatch ref');
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...dispatch,
    eventPayload: { ref: 'refs/heads/release', inputs: {} },
  }), /differs from the native GITHUB_REF/);
});

test('production provenance rejects wrong source, digest, live receipt and pull request substitution', () => {
  const valid = makeProductionProvenanceFixture();
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...valid,
    checkoutSha: '5'.repeat(40),
  }), /differs from github\.event\.workflow_run\.head_sha/);
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...valid,
    deployment: { ...valid.deployment, sourceCommit: '5'.repeat(40) },
  }), /differs from the checked out Git HEAD/);
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...valid,
    deployment: { ...valid.deployment, publicArtifactDigest: 'a'.repeat(64) },
    deploymentBytes: bytesFor(`${JSON.stringify({ ...valid.deployment, publicArtifactDigest: 'a'.repeat(64) })}\n`),
  }), /differs from the _site publication manifest bytes/);
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...valid,
    deploymentBytes: bytesFor('different local receipt'),
  }), /_site deployment\.json is not valid JSON/);
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...valid,
    liveDeploymentResponse: { ...valid.liveDeploymentResponse, body: bytesFor('fake receipt') },
  }), /bytes differ from the checked out _site deployment\.json/);
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...valid,
    liveDeploymentResponse: { ...valid.liveDeploymentResponse, requestedUrl: 'https://other.example/deployment.json' },
  }), /request differs from the fixed production origin/);
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...valid,
    eventName: 'pull_request',
    eventPayload: { pull_request: { head: { sha: valid.checkoutSha } } },
  }), /requires a native workflow_run or workflow_dispatch/);
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...valid,
    eventPayload: {
      workflow_run: {},
      pull_request: { head: { sha: valid.checkoutSha } },
    },
  }), /workflow_run\.head_sha is missing/);
  assert.throws(() => bindProductionPublicArtifactProvenance({
    ...valid,
    liveDeploymentResponse: { ...valid.liveDeploymentResponse, status: 503 },
  }), /expected HTTP 200/);
});
