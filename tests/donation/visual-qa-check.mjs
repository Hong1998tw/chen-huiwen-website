import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  compareMetrics,
  compareCaptureConditions,
  comparePngBuffers,
  cloudflareEncodingEvidence,
  deploymentEvidence,
  evaluateCaptureQuality,
  readApprovedBaseline,
  readGitBaselineSelection,
  sha256,
  validateBaselineExceptions
} from './visual-qa-lib.mjs';

function png(width, height, color) {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = color[0];
    image.data[index + 1] = color[1];
    image.data[index + 2] = color[2];
    image.data[index + 3] = color[3] ?? 255;
  }
  return PNG.sync.write(image);
}

function approvedManifest(overrides = {}) {
  const sourceSHA = 'a'.repeat(40);
  const captures = Array.from({ length: 30 }, (_, index) => ({
    id: `capture-${index}`,
    sourceSHA,
    checkoutSHA: sourceSHA,
    screenshotPath: `capture-${index}.png`,
    metadataPath: `capture-${index}.json`,
    screenshotSha256: 'b'.repeat(64),
    metadataSha256: 'c'.repeat(64),
    environmentLabel: 'local-http-identity',
    measurementScope: 'initial-navigation-through-visible-image-decode; same-origin-resource-transfer-size; viewport-screenshot',
    metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 120, sameOriginTransferSizeSource: 'PerformanceResourceTiming.transferSize including navigation' }
  }));
  return {
    schemaVersion: 2,
    status: 'APPROVED',
    sourceSHA,
    checkoutSHA: sourceSHA,
    approval: { reviewedBy: 'independent-controller', reviewedAt: '2026-10-18T00:00:00+08:00', note: 'Independently inspected baseline.' },
    comparisonPolicy: { pixelThreshold: 0.1, maxDiffRatio: 0.005 },
    exceptions: [],
    captures,
    ...overrides
  };
}

async function writeGitBaseline(repositoryRoot, sourceSHA = 'd'.repeat(40)) {
  const baselineRoot = join(repositoryRoot, 'tests', 'baselines', 'visual-qa');
  const releaseDirectory = join(baselineRoot, sourceSHA);
  await mkdir(releaseDirectory, { recursive: true });
  const captures = [];
  const measurementScope = 'initial-navigation-through-visible-image-decode; same-origin-resource-transfer-size; viewport-screenshot';
  for (let index = 0; index < 30; index++) {
    const id = `capture-${index}`;
    const screenshotPath = `${id}.png`;
    const metadataPath = `${id}.json`;
    const screenshotBytes = png(4, 4, [30 + index, 50, 80]);
    const screenshotSha256 = sha256(screenshotBytes);
    const capture = {
      id,
      sourceSHA,
      checkoutSHA: sourceSHA,
      screenshotPath,
      metadataPath,
      screenshotSha256,
      metadataSha256: null,
      environmentLabel: 'local-http-uncompressed',
      measurementScope,
      metrics: {
        sameOriginTransferSizeBytes: 1200,
        domElementCount: 120,
        sameOriginTransferSizeSource: 'PerformanceResourceTiming.transferSize including navigation'
      }
    };
    const metadata = {
      id,
      checkoutSHA: sourceSHA,
      sourceSHA,
      metrics: capture.metrics,
      environmentLabel: capture.environmentLabel,
      measurementScope,
      screenshotSha256
    };
    const metadataBytes = Buffer.from(JSON.stringify(metadata));
    capture.metadataSha256 = sha256(metadataBytes);
    await writeFile(join(releaseDirectory, screenshotPath), screenshotBytes);
    await writeFile(join(releaseDirectory, metadataPath), metadataBytes);
    captures.push(capture);
  }

  const manifest = {
    schemaVersion: 2,
    status: 'APPROVED',
    sourceSHA,
    checkoutSHA: sourceSHA,
    environment: 'local-http-uncompressed',
    approval: { reviewedBy: 'independent-controller', reviewedAt: '2026-10-18T00:00:00+08:00', note: 'Inspected all 30 captures.' },
    comparisonPolicy: { pixelThreshold: 0.1, maxDiffRatio: 0.005 },
    exceptions: [],
    captures
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const manifestPath = join(releaseDirectory, 'manifest.json');
  await writeFile(manifestPath, manifestBytes);
  const selection = {
    schemaVersion: 1,
    manifestPath: `${sourceSHA}/manifest.json`,
    manifestSha256: sha256(manifestBytes),
    sourceSHA
  };
  await writeFile(join(baselineRoot, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`);
  return { baselineRoot, releaseDirectory, manifestPath, manifest, selection };
}

test('missing baseline stays PENDING and never reports a comparison pass', async () => {
  const missing = await readApprovedBaseline({ manifestPath: null, expectedSha256: null, expectedSourceSha: null });
  assert.deepEqual(missing, { status: 'PENDING', reason: 'BASELINE_MISSING' });
});

test('compare CLI writes PENDING and exits successfully when the baseline has not been approved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-compare-pending-'));
  try {
    const candidatePath = join(directory, 'candidate.json');
    const comparisonPath = join(directory, 'comparison.json');
    await writeFile(candidatePath, JSON.stringify({ sourceSHA: 'c'.repeat(40) }));
    const script = fileURLToPath(new URL('./visual-qa.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      'compare',
      '--candidate-manifest', candidatePath,
      '--output', comparisonPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(comparisonPath, 'utf8'));
    assert.equal(report.status, 'PENDING');
    assert.equal(report.comparisonPerformed, false);
    assert.match(report.message, /not a visual regression pass/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the fixed Git selection is PENDING when it has not been created', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-selection-pending-'));
  try {
    const result = await readGitBaselineSelection({ repositoryRoot });
    assert.deepEqual(result, {
      status: 'PENDING',
      reason: 'BASELINE_SELECTION_MISSING',
      selectionPath: 'tests/baselines/visual-qa/selection.json'
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('the Git selection accepts a complete approved, hash-matched 30-capture bundle', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-selection-valid-'));
  try {
    const bundle = await writeGitBaseline(repositoryRoot);
    const selected = await readGitBaselineSelection({ repositoryRoot });
    assert.equal(selected.status, 'APPROVED');
    assert.equal(selected.sourceType, 'git-selection');
    assert.equal(selected.selectionPath, 'tests/baselines/visual-qa/selection.json');
    assert.equal(selected.manifestPath, await realpath(bundle.manifestPath));
    assert.equal(selected.actualSha256, bundle.selection.manifestSha256);
    assert.equal(selected.manifest.captures.length, 30);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('the Git selection rejects missing baselines, wrong hashes, missing provenance and paths outside its release directory', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-selection-negative-'));
  try {
    const bundle = await writeGitBaseline(repositoryRoot);
    const selectionPath = join(bundle.baselineRoot, 'selection.json');
    const valid = bundle.selection;

    await writeFile(selectionPath, JSON.stringify({ ...valid, manifestPath: '../outside/manifest.json' }));
    assert.equal((await readGitBaselineSelection({ repositoryRoot })).reason, 'BASELINE_SELECTION_PATH_INVALID');

    const { sourceSHA: ignoredSourceSHA, ...missingProvenance } = valid;
    await writeFile(selectionPath, JSON.stringify(missingProvenance));
    assert.equal((await readGitBaselineSelection({ repositoryRoot })).reason, 'BASELINE_SELECTION_PROVENANCE_INVALID');

    await writeFile(selectionPath, JSON.stringify({ ...valid, manifestSha256: '0'.repeat(64) }));
    assert.equal((await readGitBaselineSelection({ repositoryRoot })).reason, 'BASELINE_SHA256_MISMATCH');

    await writeFile(selectionPath, JSON.stringify({ ...valid, sourceSHA: 'e'.repeat(40), manifestPath: `${'e'.repeat(40)}/manifest.json` }));
    assert.equal((await readGitBaselineSelection({ repositoryRoot })).reason, 'CONFIGURED_BASELINE_MISSING');

    await writeFile(selectionPath, JSON.stringify(valid));
    await unlink(join(bundle.releaseDirectory, bundle.manifest.captures[7].screenshotPath));
    const missingCapture = await readGitBaselineSelection({ repositoryRoot });
    assert.equal(missingCapture.status, 'REJECTED');
    assert.equal(missingCapture.reason, 'BASELINE_CAPTURE_FILE_MISSING');
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('a symlinked Git selection directory is rejected as an unsafe path', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-selection-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'a05-git-selection-outside-'));
  try {
    await mkdir(join(repositoryRoot, 'tests', 'baselines'), { recursive: true });
    await symlink(outside, join(repositoryRoot, 'tests', 'baselines', 'visual-qa'));
    const result = await readGitBaselineSelection({ repositoryRoot });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.reason, 'BASELINE_SELECTION_PATH_UNSAFE');
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a selected capture file cannot escape its Git baseline directory through a symlink', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'a05-git-capture-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'a05-git-capture-outside-'));
  try {
    const bundle = await writeGitBaseline(repositoryRoot);
    const screenshot = join(bundle.releaseDirectory, bundle.manifest.captures[0].screenshotPath);
    const outsideFile = join(outside, 'outside.png');
    const bytes = await readFile(screenshot);
    await writeFile(outsideFile, bytes);
    await unlink(screenshot);
    await symlink(outsideFile, screenshot);
    const selected = await readGitBaselineSelection({ repositoryRoot });
    assert.equal(selected.status, 'REJECTED');
    assert.equal(selected.reason, 'BASELINE_CAPTURE_PATH_UNSAFE');
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('compare CLI fails closed when Git and explicit baseline selectors are supplied together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-baseline-selector-conflict-'));
  try {
    const candidatePath = join(directory, 'candidate.json');
    const comparisonPath = join(directory, 'comparison.json');
    await writeFile(candidatePath, JSON.stringify({ sourceSHA: 'c'.repeat(40) }));
    const script = fileURLToPath(new URL('./visual-qa.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      'compare',
      '--candidate-manifest', candidatePath,
      '--baseline-selection',
      '--baseline-manifest', join(directory, 'artifact-manifest.json'),
      '--baseline-sha256', '0'.repeat(64),
      '--baseline-source-sha', 'a'.repeat(40),
      '--output', comparisonPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(comparisonPath, 'utf8'));
    assert.equal(report.status, 'REJECTED');
    assert.equal(report.reason, 'BASELINE_SOURCE_CONFLICT');
    assert.equal(report.comparisonPerformed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a configured but missing baseline fails and never falls back to PENDING', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-configured-missing-baseline-'));
  try {
    const candidatePath = join(directory, 'candidate.json');
    const missingPath = join(directory, 'configured-baseline', 'manifest.json');
    const comparisonPath = join(directory, 'comparison.json');
    await writeFile(candidatePath, JSON.stringify({ sourceSHA: 'c'.repeat(40) }));
    const script = fileURLToPath(new URL('./visual-qa.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      'compare',
      '--candidate-manifest', candidatePath,
      '--baseline-manifest', missingPath,
      '--baseline-sha256', '0'.repeat(64),
      '--baseline-source-sha', 'a'.repeat(40),
      '--output', comparisonPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(comparisonPath, 'utf8'));
    assert.equal(report.status, 'REJECTED');
    assert.equal(report.reason, 'CONFIGURED_BASELINE_MISSING');
    assert.equal(report.comparisonPerformed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('live deployment evidence stays separate from checkout SHA and detects a mid-capture change', () => {
  const checkoutSHA = 'c'.repeat(40);
  const first = { schemaVersion: 1, provider: 'cloudflare-static-assets', sourceCommit: 'a'.repeat(40), publicArtifactDigest: '1'.repeat(64) };
  const stable = deploymentEvidence(checkoutSHA, first, { ...first });
  assert.equal(stable.checkoutSHA, checkoutSHA);
  assert.equal(stable.liveDeployment.sourceCommitAtStart, first.sourceCommit);
  assert.equal(stable.verification.status, 'VERIFIED');
  assert.notEqual(stable.checkoutSHA, stable.liveDeployment.sourceCommitAtStart);

  const changed = deploymentEvidence(checkoutSHA, first, { ...first, sourceCommit: 'b'.repeat(40), publicArtifactDigest: '2'.repeat(64) });
  assert.equal(changed.verification.status, 'MIXED_DEPLOYMENT');
  assert.equal(changed.verification.stable, false);
});

test('identity and gzip Cloudflare negotiation are valid evidence and never mislabeled as Brotli', () => {
  for (const [encoding, label] of [['identity', 'cloudflare-production-identity'], ['gzip', 'cloudflare-production-gzip'], ['br', 'cloudflare-production-br']]) {
    const evidence = cloudflareEncodingEvidence(encoding, true);
    assert.equal(evidence.verified, true);
    assert.equal(evidence.environmentLabel, label);
    assert.equal(evidence.contentEncoding, encoding);
  }
  const gzip = cloudflareEncodingEvidence('gzip', true);
  assert.notEqual(gzip.environmentLabel, 'cloudflare-production-br');
  assert.equal(cloudflareEncodingEvidence('gzip', false).verified, false);
  assert.equal(cloudflareEncodingEvidence(' GZip ', true).contentEncoding, 'GZip');
  assert.deepEqual(compareCaptureConditions({
    environmentLabel: gzip.environmentLabel,
    measurementScope: 'same-scope',
    metrics: { sameOriginTransferSizeSource: 'PerformanceResourceTiming.transferSize including navigation' }
  }, {
    environmentLabel: 'cloudflare-production-identity',
    measurementScope: 'same-scope',
    metrics: { sameOriginTransferSizeSource: 'PerformanceResourceTiming.transferSize including navigation' }
  }), { comparable: false, reason: 'CAPTURE_ENVIRONMENT_LABEL_MISMATCH' });
});

test('403, first-party JavaScript errors and missing visible first-party images invalidate capture; third-party auth remains classified', () => {
  const good = {
    httpStatus: 200,
    conditions: { fontsReady: true },
    pageErrors: [],
    imageState: { firstPartyFailedImageCount: 0 },
    network: [{ originClass: 'same-origin', status: 200, failed: null }],
    screenshotSha256: 'a'.repeat(64)
  };
  assert.equal(evaluateCaptureQuality(good).status, 'COMPLETE');

  const forbidden = evaluateCaptureQuality({ ...good, httpStatus: 403 });
  assert.equal(forbidden.status, 'INCOMPLETE');
  assert(forbidden.failureReasons.includes('HTTP_STATUS_UNEXPECTED'));

  const jsError = evaluateCaptureQuality({ ...good, pageErrors: ['uncaught first-party error'] });
  assert(jsError.failureReasons.includes('FIRST_PARTY_PAGE_ERROR'));

  const missingImage = evaluateCaptureQuality({ ...good, imageState: { firstPartyFailedImageCount: 1 } });
  assert(missingImage.failureReasons.includes('FIRST_PARTY_VISIBLE_IMAGE_FAILED'));

  const externalAuth = evaluateCaptureQuality({ ...good, network: [...good.network, { originClass: 'third-party', status: 403, failed: null }] });
  assert.equal(externalAuth.status, 'COMPLETE');
  assert.equal(externalAuth.thirdPartyFailureCount, 1);

  const externalPageError = evaluateCaptureQuality({ ...good, pageErrors: [{ message: 'blocked vendor error', originClass: 'third-party', sourceUrls: [] }] });
  assert.equal(externalPageError.status, 'COMPLETE');
  assert.equal(externalPageError.thirdPartyPageErrorCount, 1);
});

test('tampered manifest bytes and an unapproved manifest are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-tampered-baseline-'));
  const path = join(directory, 'baseline.json');
  try {
    const manifest = approvedManifest();
    const original = Buffer.from(JSON.stringify(manifest));
    await writeFile(path, original);
    await writeFile(path, Buffer.from(`${original.toString()} `));
    const tampered = await readApprovedBaseline({
      manifestPath: path,
      expectedSha256: sha256(original),
      expectedSourceSha: manifest.sourceSHA
    });
    assert.equal(tampered.status, 'REJECTED');
    assert.equal(tampered.reason, 'BASELINE_SHA256_MISMATCH');

    const unapproved = Buffer.from(JSON.stringify({ ...manifest, status: 'CAPTURE_ONLY' }));
    await writeFile(path, unapproved);
    const rejected = await readApprovedBaseline({
      manifestPath: path,
      expectedSha256: sha256(unapproved),
      expectedSourceSha: manifest.sourceSHA
    });
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.reason, 'BASELINE_NOT_APPROVED_OR_UNSUPPORTED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PNG comparison passes identical pixels and reports actual pixel and dimension changes', () => {
  const policy = { pixelThreshold: 0.1, maxDiffRatio: 0.005 };
  const base = png(20, 20, [10, 20, 30]);
  const same = comparePngBuffers(base, png(20, 20, [10, 20, 30]), policy);
  assert.equal(same.status, 'PASS');
  assert.equal(same.changedPixels, 0);

  const changed = PNG.sync.read(base);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const index = (y * changed.width + x) * 4;
      changed.data[index] = 250;
      changed.data[index + 1] = 240;
      changed.data[index + 2] = 230;
    }
  }
  const pixelChange = comparePngBuffers(base, PNG.sync.write(changed), policy);
  assert.equal(pixelChange.status, 'FAIL');
  assert.equal(pixelChange.reason, 'PIXEL_DIFF_THRESHOLD_EXCEEDED');
  assert(pixelChange.changedPixels > 0);
  assert(PNG.sync.read(pixelChange.diffPng));

  const sizeChange = comparePngBuffers(base, png(21, 20, [10, 20, 30]), policy);
  assert.equal(sizeChange.status, 'FAIL');
  assert.equal(sizeChange.reason, 'DIMENSION_MISMATCH');
  assert.notEqual(sizeChange.changedPixels, 0);
  assert.equal(PNG.sync.read(sizeChange.diffPng).width, 21);
});

test('metric comparison catches a new regression against an approved baseline', () => {
  const baseline = { id: 'home-390', metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 120 } };
  const candidate = { id: 'home-390', metrics: { sameOriginTransferSizeBytes: 1300, domElementCount: 110 } };
  const result = compareMetrics(candidate, baseline);
  assert.equal(result.status, 'FAIL');
  assert(result.metrics.some(item => item.reason === 'NEW_REGRESSION' && item.metric === 'sameOriginTransferSizeBytes'));
});

test('a resolved exception makes its old approved baseline stale and requires re-approval', () => {
  const baseline = { id: 'gallery-390', metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 1800 } };
  const candidate = { id: 'gallery-390', metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 1400 } };
  const exceptions = [{ captureId: 'gallery-390', metric: 'domElementCount', limit: 1500, observedValue: 1800 }];
  const result = compareMetrics(candidate, baseline, exceptions);
  assert.equal(result.status, 'STALE_BASELINE');
  assert.equal(result.staleExceptions[0].currentValue, 1400);
});

test('an over-budget baseline exception must match captured measurement and include evidence/task', () => {
  const captures = Array.from({ length: 30 }, (_, index) => ({
    id: `capture-${index}`,
    metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 120 }
  }));
  captures[4] = {
    id: 'gallery-390',
    metadataPath: 'gallery-390.json',
    metadataSha256: 'a'.repeat(64),
    metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 1800 }
  };
  const exception = {
    captureId: 'gallery-390',
    metric: 'domElementCount',
    limit: 1500,
    observedValue: 1800,
    reason: 'Measured gallery nodes retained for the active gallery view.',
    resolutionTask: 'Review the measured gallery DOM and reduce initial nodes without removing the browse flow.',
    evidencePath: 'gallery-390.json'
  };
  assert.deepEqual(validateBaselineExceptions({ captures, exceptions: [exception] }), { valid: true });
  assert.equal(validateBaselineExceptions({ captures, exceptions: [{ ...exception, observedValue: 6380 }] }).reason, 'BASELINE_EXCEPTION_MEASUREMENT_MISMATCH');
  assert.equal(validateBaselineExceptions({ captures, exceptions: [{ ...exception, resolutionTask: '' }] }).reason, 'BASELINE_EXCEPTION_EVIDENCE_INCOMPLETE');
});

test('approved baseline source SHA is checked independently from its content hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-source-sha-'));
  const path = join(directory, 'baseline.json');
  try {
    const manifest = approvedManifest();
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path, bytes);
    const result = await readApprovedBaseline({
      manifestPath: path,
      expectedSha256: sha256(bytes),
      expectedSourceSha: 'b'.repeat(40)
    });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.reason, 'BASELINE_SOURCE_SHA_MISMATCH');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a correctly hashed, fully approved baseline is accepted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a05-approved-baseline-'));
  const path = join(directory, 'baseline.json');
  try {
    const manifest = approvedManifest();
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path, bytes);
    const result = await readApprovedBaseline({
      manifestPath: path,
      expectedSha256: sha256(bytes),
      expectedSourceSha: manifest.sourceSHA
    });
    assert.equal(result.status, 'APPROVED');
    assert.equal(result.actualSha256, sha256(bytes));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
