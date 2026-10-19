import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const PLAYWRIGHT_VERSION = '1.55.1';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const LOCAL_CI_MODE = 'local-ci';
export const PRODUCTION_LIVE_MODE = 'production-live';
export const PRODUCTION_BASE_URL = 'https://www.huiwen.tw/';
const SHA256 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const FINGERPRINTED_PATH = /^(?:(?<directory>.*\/))?(?<stem>[^/]+)\.(?<digest>[a-f0-9]{64})(?<suffix>\.(?:css|js))$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeBaseUrl(value, mode = LOCAL_CI_MODE) {
  assert.ok(mode === LOCAL_CI_MODE || mode === PRODUCTION_LIVE_MODE,
    `PUBLIC_ASSET_RUNTIME_MODE is unsupported: ${mode}`);
  assert.ok(value, mode === LOCAL_CI_MODE
    ? 'BASE_URL from the existing Wrangler local step is required'
    : 'BASE_URL from the production-live workflow step is required');
  const url = new URL(value);
  assert.ok(['http:', 'https:'].includes(url.protocol), 'BASE_URL must use HTTP or HTTPS');
  assert.ok(!url.username && !url.password && !url.search && !url.hash,
    'BASE_URL contains credentials or extra URL state');
  if (mode === PRODUCTION_LIVE_MODE) {
    assert.equal(value, PRODUCTION_BASE_URL,
      `production-live BASE_URL must be exactly ${PRODUCTION_BASE_URL}`);
    return url;
  }
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'BASE_URL must point to the existing loopback Wrangler instance');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

export function fingerprintAlias(relativePath) {
  const match = FINGERPRINTED_PATH.exec(relativePath);
  return match ? `${match.groups.directory || ''}${match.groups.stem}${match.groups.suffix}` : null;
}

export function parseHeaderRules(text) {
  const rules = [];
  const seen = new Set();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      assert.ok(pattern.startsWith('/'), `invalid _headers path rule: ${pattern}`);
      assert.ok(!seen.has(pattern), `duplicate _headers path rule: ${pattern}`);
      current = { pattern, headers: {} };
      seen.add(pattern);
      rules.push(current);
      continue;
    }
    assert.ok(current, `_headers value has no path rule: ${line.trim()}`);
    const match = line.trim().match(/^([^:]+):\s*(.*?)\s*$/);
    assert.ok(match, `invalid _headers value: ${line.trim()}`);
    const name = match[1].toLowerCase();
    assert.ok(!(name in current.headers), `duplicate _headers value: ${current.pattern} ${name}`);
    current.headers[name] = match[2];
  }
  return rules;
}

export function headerRuleForPath(pathname, rules) {
  const matches = rules.filter(({ pattern }) => {
    if (pattern === pathname) return true;
    if (!pattern.endsWith('/*')) return false;
    return pathname.startsWith(pattern.slice(0, -1));
  }).sort((left, right) => right.pattern.length - left.pattern.length);
  return matches[0] || null;
}

function bytesFor(path, byteMap) {
  const value = byteMap instanceof Map ? byteMap.get(path) : byteMap?.[path];
  assert.ok(value instanceof Uint8Array, `publication bytes are missing: ${path}`);
  return value;
}

function safePublicationPath(path) {
  assert.ok(typeof path === 'string' && path.length > 0, 'publication path is missing');
  assert.ok(!path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..'),
    `unsafe publication path: ${path}`);
}

export function assembleFingerprintInventory({ publication, byteMap, headerRules }) {
  const files = publication?.files;
  assert.ok(files && typeof files === 'object' && !Array.isArray(files), 'publication files map is missing');
  const byAlias = new Map();
  const assets = [];
  for (const relativePath of Object.keys(files).sort()) {
    safePublicationPath(relativePath);
    const alias = fingerprintAlias(relativePath);
    if (!alias) continue;
    const declared = files[relativePath];
    const digest = FINGERPRINTED_PATH.exec(relativePath).groups.digest;
    assert.match(declared || '', SHA256, `fingerprinted publication digest is invalid: ${relativePath}`);
    assert.equal(declared, digest, `fingerprinted filename differs from publication digest: ${relativePath}`);
    assert.match(files[alias] || '', SHA256, `fingerprinted asset has no published mutable owner: ${alias}`);
    const bytes = bytesFor(relativePath, byteMap);
    const actual = sha256(bytes);
    assert.equal(actual, declared, `fingerprinted publication digest differs from bytes: ${relativePath}`);
    assert.ok(bytes.byteLength > 0, `fingerprinted asset is empty: ${relativePath}`);
    const rule = headerRuleForPath(`/${relativePath}`, headerRules);
    assert.equal(rule?.pattern, `/${relativePath}`, `fingerprinted asset needs an exact immutable header: ${relativePath}`);
    assert.equal(rule.headers['cache-control'], IMMUTABLE_CACHE_CONTROL,
      `fingerprinted asset cache policy is not immutable: ${relativePath}`);
    assert.ok(!byAlias.has(alias), `duplicate fingerprinted owner: ${alias}`);
    const asset = {
      path: `/${relativePath}`,
      relativePath,
      alias,
      sha256: actual,
      bytes: bytes.byteLength,
      cacheControl: rule.headers['cache-control'],
    };
    byAlias.set(alias, asset);
    assets.push(asset);
  }
  assert.ok(assets.length > 0, 'publication contains no owned fingerprinted CSS/JS assets');
  return { assets, byAlias };
}

export function selectSharedCommonFont(fontManifest, firstRoute, secondRoute) {
  const first = fontManifest?.routes?.[firstRoute]?.commonFont;
  const second = fontManifest?.routes?.[secondRoute]?.commonFont;
  assert.ok(typeof first === 'string' && first.length > 0, `${firstRoute}: common font is missing`);
  assert.equal(second, first, `${firstRoute} and ${secondRoute} do not share the same common font`);
  assert.ok(fontManifest.fonts?.[first], `common font is not owned by the page-font manifest: ${first}`);
  assert.ok(fontManifest.routes[firstRoute].preloads?.includes(first), `${firstRoute}: common font is not preloaded`);
  assert.ok(fontManifest.routes[secondRoute].preloads?.includes(first), `${secondRoute}: common font is not preloaded`);
  return first;
}

export function assemblePublishedResource({ relativePath, publication, byteMap, headerRules, expectedHeaderPattern }) {
  safePublicationPath(relativePath);
  const declared = publication?.files?.[relativePath];
  assert.match(declared || '', SHA256, `resource is not owned by the publication manifest: ${relativePath}`);
  const bytes = bytesFor(relativePath, byteMap);
  const actual = sha256(bytes);
  assert.equal(actual, declared, `publication digest differs from bytes: ${relativePath}`);
  assert.ok(bytes.byteLength > 0, `published resource is empty: ${relativePath}`);
  const rule = headerRuleForPath(`/${relativePath}`, headerRules);
  assert.ok(rule, `published resource has no cache header rule: ${relativePath}`);
  if (expectedHeaderPattern) {
    assert.equal(rule.pattern, expectedHeaderPattern, `cache header pattern differs for ${relativePath}`);
  }
  assert.equal(rule.headers['cache-control'], IMMUTABLE_CACHE_CONTROL,
    `published resource is not immutable: ${relativePath}`);
  return {
    path: `/${relativePath}`,
    relativePath,
    sha256: actual,
    bytes: bytes.byteLength,
    cacheControl: rule.headers['cache-control'],
    cacheHeaderPattern: rule.pattern,
  };
}

export function assembleMutableAliasResource({ alias, publication, byteMap, headerRules }) {
  safePublicationPath(alias);
  const declared = publication?.files?.[alias];
  assert.match(declared || '', SHA256, `mutable alias is not owned by the publication manifest: ${alias}`);
  const bytes = bytesFor(alias, byteMap);
  const actual = sha256(bytes);
  assert.equal(actual, declared, `publication digest differs from mutable alias bytes: ${alias}`);
  assert.ok(bytes.byteLength > 0, `mutable alias is empty: ${alias}`);
  const rule = headerRuleForPath(`/${alias}`, headerRules);
  assert.doesNotMatch(rule?.headers?.['cache-control'] || '', /\bimmutable\b/i,
    `mutable alias unexpectedly has immutable cache policy: ${alias}`);
  return { path: `/${alias}`, alias, sha256: actual, bytes: bytes.byteLength, proofEligible: false };
}

export function validateArtifactResponse({ asset, observation, expectedUrl, expectedOrigin }) {
  assert.ok(observation, `${asset.path}: browser response is missing`);
  assert.equal(observation.url, expectedUrl, `${asset.path}: browser requested an unexpected URL`);
  const observedUrl = new URL(observation.url);
  assert.equal(observedUrl.pathname, asset.path, `${asset.path}: browser response path differs`);
  assert.equal(observedUrl.origin, expectedOrigin, `${asset.path}: browser response left the tested origin`);
  assert.equal(observation.status, 200, `${asset.path}: expected HTTP 200, got ${observation.status}`);
  const expectedResourceType = asset.path.endsWith('.css') ? 'stylesheet'
    : asset.path.endsWith('.js') ? 'script' : asset.path.endsWith('.woff2') ? 'font' : null;
  if (expectedResourceType) {
    assert.equal(observation.resourceType, expectedResourceType,
      `${asset.path}: resource was not successfully consumed as ${expectedResourceType}`);
  }
  assert.equal(observation.headers?.['cache-control'], IMMUTABLE_CACHE_CONTROL,
    `${asset.path}: response Cache-Control differs`);
  assert.notEqual(observation.fromServiceWorker, true, `${asset.path}: response came from a service worker`);
  assert.equal(observation.bodyBytes, asset.bytes, `${asset.path}: response byte length differs from artifact`);
  assert.equal(observation.bodySha256, asset.sha256, `${asset.path}: response SHA-256 differs from artifact`);
  return {
    path: asset.path,
    alias: asset.alias || null,
    role: asset.alias
      ? (asset.path.endsWith('.css') ? 'fingerprinted-css' : 'fingerprinted-js')
      : 'shared-common-font',
    url: observation.url,
    status: observation.status,
    resourceType: observation.resourceType,
    headers: observation.headers,
    artifactBytes: asset.bytes,
    responseBytes: observation.bodyBytes,
    artifactSha256: asset.sha256,
    responseSha256: observation.bodySha256,
    fromDiskCache: observation.fromDiskCache === true,
    fromServiceWorker: observation.fromServiceWorker === true,
    requestServedFromCache: observation.requestServedFromCache === true,
    encodedDataLength: observation.encodedDataLength ?? null,
    transferSize: observation.transferSize ?? null,
  };
}

export function validateColdWarmCacheProof({ asset, cold, warm, expectedUrl, expectedOrigin }) {
  const coldProof = validateArtifactResponse({ asset, observation: cold, expectedUrl, expectedOrigin });
  assert.ok(Number.isFinite(cold.encodedDataLength) && cold.encodedDataLength > 0,
    `${asset.path}: cold response has no positive transferred bytes`);
  assert.notEqual(cold.fromDiskCache, true, `${asset.path}: cold response came from disk cache`);
  assert.notEqual(cold.requestServedFromCache, true, `${asset.path}: cold response was served from cache`);
  const warmProof = validateArtifactResponse({ asset, observation: warm, expectedUrl, expectedOrigin });
  const cacheSignals = {
    fromDiskCache: warm.fromDiskCache === true,
    requestServedFromCache: warm.requestServedFromCache === true,
    zeroTransferSize: warm.transferSize === 0,
  };
  assert.ok(Object.values(cacheSignals).some(Boolean),
    `${asset.path}: second-page response has no disk, CDP cache, or zero-transfer evidence`);
  return { ...coldProof, cold: coldProof, warm: { ...warmProof, cacheSignals }, cacheHit: true };
}

export function validateMutableAliasObservation({ alias, asset, observation, expectedUrl, expectedOrigin }) {
  assert.equal(observation?.url, expectedUrl, `${alias}: alias probe URL differs`);
  assert.equal(new URL(observation.url).pathname, `/${alias}`, `${alias}: alias response path differs`);
  assert.equal(new URL(observation.url).origin, expectedOrigin, `${alias}: alias response left the tested origin`);
  assert.equal(observation.status, 200, `${alias}: expected HTTP 200`);
  assert.ok(observation.bodyBytes > 0, `${alias}: mutable alias returned no bytes`);
  if (asset) {
    assert.equal(observation.bodyBytes, asset.bytes, `${alias}: mutable alias byte length differs from artifact`);
    assert.equal(observation.bodySha256, asset.sha256, `${alias}: mutable alias SHA-256 differs from artifact`);
  }
  assert.doesNotMatch(observation.headers?.['cache-control'] || '', /\bimmutable\b/i,
    `${alias}: mutable alias unexpectedly has immutable cache policy`);
  return {
    path: `/${alias}`,
    url: observation.url,
    status: observation.status,
    headers: observation.headers,
    responseBytes: observation.bodyBytes,
    responseSha256: observation.bodySha256,
    proofEligible: false,
    reason: 'mutable rollback alias; excluded from fingerprint cache-hit proof',
  };
}

export function bindPublicArtifactProvenance({
  eventName,
  sourceCiMergeSha,
  pullRequestHeadSha,
  eventPayload,
  deployment,
  publication,
  publicationManifestBytes,
  runtime,
  runId = null,
  runAttempt = null,
}) {
  assert.equal(eventName, 'pull_request', 'public artifact runtime proof must run in the pull_request workflow');
  assert.match(sourceCiMergeSha || '', /^[a-f0-9]{40}$/, 'CI merge SHA is missing or invalid');
  assert.match(pullRequestHeadSha || '', /^[a-f0-9]{40}$/, 'pull request head SHA is missing or invalid');
  assert.equal(eventPayload?.pull_request?.head?.sha, pullRequestHeadSha,
    'PR head SHA differs from the native GitHub event');
  assert.equal(deployment?.provider, 'cloudflare-static-assets', 'deployment receipt provider is unexpected');
  assert.equal(deployment?.sourceCommit, sourceCiMergeSha,
    'public artifact source commit differs from the CI merge SHA');
  assert.equal(deployment?.publicArtifactDigest, sha256(publicationManifestBytes),
    'deployment receipt digest differs from the publication manifest bytes');
  assert.ok(publication?.files && typeof publication.files === 'object', 'publication files map is missing');
  assert.equal(deployment?.publicFileCount, Object.keys(publication.files).length,
    'deployment receipt file count differs from the publication manifest');
  assert.equal(deployment?.publicRecordCount, publication.publicRecordCount,
    'deployment receipt public record count differs from the publication manifest');
  assert.equal(runtime?.playwrightVersion, PLAYWRIGHT_VERSION, 'Playwright runtime version is not pinned');
  assert.ok(typeof runtime?.chromiumVersion === 'string' && runtime.chromiumVersion.length > 0,
    'Chromium runtime version is missing');
  return {
    sourceCi: {
      eventName,
      mergeSha: sourceCiMergeSha,
      pullRequestHeadSha,
      pullRequestNumber: Number.isInteger(eventPayload?.number) ? eventPayload.number : null,
      runId,
      runAttempt,
      artifactSourceCommit: deployment.sourceCommit,
    },
    publicManifest: {
      sha256: sha256(publicationManifestBytes),
      bytes: publicationManifestBytes.byteLength,
      fileCount: Object.keys(publication.files).length,
      publicRecordCount: publication.publicRecordCount,
      deploymentDigest: deployment.publicArtifactDigest,
    },
    runtime,
  };
}

export function bindProductionPublicArtifactProvenance({
  eventName,
  eventPayload,
  githubSha,
  githubRef,
  checkoutSha,
  deployment,
  deploymentBytes,
  liveDeploymentResponse,
  publication,
  publicationManifestBytes,
  runtime,
  runId = null,
  runAttempt = null,
}) {
  assert.ok(eventName === 'workflow_run' || eventName === 'workflow_dispatch',
    'production-live proof requires a native workflow_run or workflow_dispatch event');
  assert.match(checkoutSha || '', SHA40, 'checked out Git HEAD is missing or invalid');

  let expectedCheckoutSha;
  let checkoutShaContract;
  let eventRef = null;
  if (eventName === 'workflow_run') {
    expectedCheckoutSha = eventPayload?.workflow_run?.head_sha;
    assert.match(expectedCheckoutSha || '', SHA40, 'native workflow_run.head_sha is missing or invalid');
    checkoutShaContract = 'github.event.workflow_run.head_sha';
  } else {
    eventRef = eventPayload?.ref;
    assert.ok(typeof eventRef === 'string' && eventRef.length > 0,
      'native workflow_dispatch.ref is missing');
    assert.equal(eventRef, githubRef,
      'workflow_dispatch.ref differs from the native GITHUB_REF context');
    expectedCheckoutSha = githubSha;
    checkoutShaContract = 'GITHUB_SHA for the native workflow_dispatch ref';
    assert.match(expectedCheckoutSha || '', SHA40, 'workflow_dispatch GITHUB_SHA is missing or invalid');
  }
  assert.equal(checkoutSha, expectedCheckoutSha,
    `checked out Git HEAD differs from ${checkoutShaContract}`);

  assert.equal(deployment?.provider, 'cloudflare-static-assets',
    'local public artifact receipt provider is unexpected');
  assert.equal(deployment?.schemaVersion, 1, 'local public artifact receipt schema version is unexpected');
  assert.equal(deployment?.sourceCommit, checkoutSha,
    'local public artifact source commit differs from the checked out Git HEAD');
  assert.ok(deploymentBytes instanceof Uint8Array && deploymentBytes.byteLength > 0,
    'local deployment receipt bytes are missing');
  let localDeployment;
  try {
    localDeployment = JSON.parse(Buffer.from(deploymentBytes).toString('utf8'));
  } catch {
    throw new Error('_site deployment.json is not valid JSON');
  }
  assert.deepEqual(localDeployment, deployment,
    'parsed local deployment receipt differs from the _site deployment.json bytes');
  assert.ok(publicationManifestBytes instanceof Uint8Array && publicationManifestBytes.byteLength > 0,
    'local publication manifest bytes are missing');
  let localPublication;
  try {
    localPublication = JSON.parse(Buffer.from(publicationManifestBytes).toString('utf8'));
  } catch {
    throw new Error('_site publication-manifest.json is not valid JSON');
  }
  assert.deepEqual(localPublication, publication,
    'parsed publication manifest differs from the _site publication-manifest.json bytes');
  assert.equal(deployment?.publicArtifactDigest, sha256(publicationManifestBytes),
    'local deployment receipt digest differs from the _site publication manifest bytes');
  assert.ok(publication?.files && typeof publication.files === 'object' && !Array.isArray(publication.files),
    'publication files map is missing');
  assert.equal(deployment?.publicFileCount, Object.keys(publication.files).length,
    'local deployment receipt file count differs from the publication manifest');
  assert.equal(deployment?.publicRecordCount, publication.publicRecordCount,
    'local deployment receipt record count differs from the publication manifest');

  assert.ok(liveDeploymentResponse, 'live HTTP deployment receipt observation is missing');
  const expectedReceiptUrl = `${PRODUCTION_BASE_URL}deployment.json`;
  assert.equal(liveDeploymentResponse.requestedUrl, expectedReceiptUrl,
    'live HTTP deployment receipt request differs from the fixed production origin');
  assert.equal(liveDeploymentResponse.url, expectedReceiptUrl,
    'live HTTP deployment receipt URL differs from the fixed production origin');
  assert.equal(liveDeploymentResponse.status, 200,
    `live HTTP deployment receipt expected HTTP 200, got ${liveDeploymentResponse.status}`);
  const liveBytes = liveDeploymentResponse.body;
  assert.ok(liveBytes instanceof Uint8Array && liveBytes.byteLength > 0,
    'live HTTP deployment receipt body is missing');
  assert.equal(sha256(liveBytes), sha256(deploymentBytes),
    'live HTTP deployment receipt bytes differ from the checked out _site deployment.json');
  let liveDeployment;
  try {
    liveDeployment = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  } catch {
    throw new Error('live HTTP deployment receipt is not valid JSON');
  }
  assert.equal(liveDeployment?.provider, deployment.provider,
    'live HTTP deployment receipt provider differs from _site');
  assert.equal(liveDeployment?.sourceCommit, checkoutSha,
    'live HTTP deployment source commit differs from the checked out Git HEAD');
  assert.equal(liveDeployment?.publicArtifactDigest, deployment.publicArtifactDigest,
    'live HTTP deployment digest differs from the checked out _site publication manifest');
  assert.deepEqual(liveDeployment, localDeployment,
    'live HTTP deployment receipt fields differ from the checked out _site deployment.json');

  assert.equal(runtime?.playwrightVersion, PLAYWRIGHT_VERSION,
    'Playwright runtime version is not pinned');
  assert.ok(typeof runtime?.chromiumVersion === 'string' && runtime.chromiumVersion.length > 0,
    'Chromium runtime version is missing');
  return {
    mode: PRODUCTION_LIVE_MODE,
    sourceCi: {
      eventName,
      githubSha: githubSha || null,
      githubRef: githubRef || null,
      checkoutSha,
      checkoutShaContract,
      eventRef,
      workflowRunHeadSha: eventName === 'workflow_run' ? expectedCheckoutSha : null,
      runId,
      runAttempt,
      artifactSourceCommit: deployment.sourceCommit,
    },
    localDeployment: {
      sha256: sha256(deploymentBytes),
      bytes: deploymentBytes.byteLength,
      sourceCommit: deployment.sourceCommit,
      publicArtifactDigest: deployment.publicArtifactDigest,
    },
    liveDeployment: {
      url: liveDeploymentResponse.url,
      status: liveDeploymentResponse.status,
      sha256: sha256(liveBytes),
      bytes: liveBytes.byteLength,
      sourceCommit: liveDeployment.sourceCommit,
      publicArtifactDigest: liveDeployment.publicArtifactDigest,
    },
    publicManifest: {
      sha256: sha256(publicationManifestBytes),
      bytes: publicationManifestBytes.byteLength,
      fileCount: Object.keys(publication.files).length,
      publicRecordCount: publication.publicRecordCount,
      deploymentDigest: deployment.publicArtifactDigest,
    },
    runtime,
  };
}
