import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  compareMetrics,
  comparePngBuffers,
  readApprovedBaseline,
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
  const captures = Array.from({ length: 30 }, (_, index) => ({
    id: `capture-${index}`,
    metrics: { sameOriginTransferSizeBytes: 1200, domElementCount: 120 }
  }));
  return {
    schemaVersion: 1,
    status: 'APPROVED',
    sourceSHA: 'a'.repeat(40),
    approval: { reviewedBy: 'independent-controller', reviewedAt: '2026-10-18T00:00:00+08:00', note: 'Independently inspected baseline.' },
    comparisonPolicy: { pixelThreshold: 0.1, maxDiffRatio: 0.005 },
    exceptions: [],
    captures,
    ...overrides
  };
}

test('missing baseline stays PENDING and never reports a comparison pass', async () => {
  const missing = await readApprovedBaseline({ manifestPath: null, expectedSha256: null, expectedSourceSha: null });
  assert.deepEqual(missing, { status: 'PENDING', reason: 'BASELINE_MISSING' });
  const directory = await mkdtemp(join(tmpdir(), 'a05-missing-baseline-'));
  try {
    const absentFile = await readApprovedBaseline({
      manifestPath: join(directory, 'missing.json'),
      expectedSha256: '0'.repeat(64),
      expectedSourceSha: 'a'.repeat(40)
    });
    assert.equal(absentFile.status, 'PENDING');
    assert.equal(absentFile.reason, 'BASELINE_MISSING');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
