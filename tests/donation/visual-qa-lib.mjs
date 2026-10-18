import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export const VISUAL_QA_SCHEMA_VERSION = 1;
export const MAX_TRANSFER_BYTES = 300000;
export const MAX_DOM_ELEMENTS = 1500;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function readApprovedBaseline({ manifestPath, expectedSha256, expectedSourceSha }) {
  if (!manifestPath) return { status: 'PENDING', reason: 'BASELINE_MISSING' };
  let bytes;
  try {
    bytes = await readFile(manifestPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'PENDING', reason: 'BASELINE_MISSING' };
    throw error;
  }
  if (!expectedSha256) return { status: 'REJECTED', reason: 'EXPECTED_BASELINE_SHA256_REQUIRED' };
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    return { status: 'REJECTED', reason: 'BASELINE_SHA256_MISMATCH', actualSha256 };
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { status: 'REJECTED', reason: 'BASELINE_JSON_INVALID', actualSha256 };
  }
  if (manifest.schemaVersion !== VISUAL_QA_SCHEMA_VERSION || manifest.status !== 'APPROVED') {
    return { status: 'REJECTED', reason: 'BASELINE_NOT_APPROVED_OR_UNSUPPORTED', actualSha256 };
  }
  if (!manifest.approval?.reviewedBy || !manifest.approval?.reviewedAt || !manifest.approval?.note) {
    return { status: 'REJECTED', reason: 'APPROVAL_RECORD_INCOMPLETE', actualSha256 };
  }
  if (!expectedSourceSha || manifest.sourceSHA !== expectedSourceSha) {
    return { status: 'REJECTED', reason: 'BASELINE_SOURCE_SHA_MISMATCH', actualSha256 };
  }
  if (!Array.isArray(manifest.captures) || manifest.captures.length !== 30) {
    return { status: 'REJECTED', reason: 'BASELINE_CAPTURE_SET_INVALID', actualSha256 };
  }
  if (!manifest.comparisonPolicy || !Number.isFinite(manifest.comparisonPolicy.pixelThreshold) ||
      !Number.isFinite(manifest.comparisonPolicy.maxDiffRatio) || manifest.comparisonPolicy.maxDiffRatio < 0 ||
      manifest.comparisonPolicy.maxDiffRatio > 1) {
    return { status: 'REJECTED', reason: 'BASELINE_COMPARISON_POLICY_INVALID', actualSha256 };
  }
  const exceptionCheck = validateBaselineExceptions(manifest);
  if (!exceptionCheck.valid) return { status: 'REJECTED', reason: exceptionCheck.reason, actualSha256 };
  return { status: 'APPROVED', manifest, actualSha256 };
}

export function validateBaselineExceptions(manifest) {
  const byCapture = new Map();
  for (const exception of manifest.exceptions ?? []) {
    const key = `${exception.captureId}:${exception.metric}`;
    if (byCapture.has(key)) return { valid: false, reason: 'DUPLICATE_BASELINE_EXCEPTION' };
    const capture = manifest.captures.find(item => item.id === exception.captureId);
    if (!capture || !["domElementCount", "sameOriginTransferSizeBytes"].includes(exception.metric)) {
      return { valid: false, reason: 'BASELINE_EXCEPTION_TARGET_INVALID' };
    }
    const limit = exception.metric === 'domElementCount' ? MAX_DOM_ELEMENTS : MAX_TRANSFER_BYTES;
    const measured = capture.metrics?.[exception.metric];
    if (exception.limit !== limit || !Number.isFinite(measured) || measured <= limit || exception.observedValue !== measured) {
      return { valid: false, reason: 'BASELINE_EXCEPTION_MEASUREMENT_MISMATCH' };
    }
    if (!String(exception.reason ?? '').trim() || !String(exception.resolutionTask ?? '').trim() ||
        !String(exception.evidencePath ?? '').trim() || exception.evidencePath !== capture.metadataPath ||
        !/^[a-f0-9]{64}$/i.test(capture.metadataSha256 ?? '')) {
      return { valid: false, reason: 'BASELINE_EXCEPTION_EVIDENCE_INCOMPLETE' };
    }
    byCapture.set(key, exception);
  }
  for (const capture of manifest.captures) {
    for (const [metric, limit] of Object.entries({
      domElementCount: MAX_DOM_ELEMENTS,
      sameOriginTransferSizeBytes: MAX_TRANSFER_BYTES
    })) {
      const measured = capture.metrics?.[metric];
      if (!Number.isFinite(measured)) return { valid: false, reason: 'BASELINE_METRIC_MISSING' };
      if (measured > limit && !byCapture.has(`${capture.id}:${metric}`)) {
        return { valid: false, reason: 'BASELINE_OVER_BUDGET_WITHOUT_EXCEPTION' };
      }
    }
  }
  return { valid: true };
}

export function compareMetrics(candidate, baseline, exceptions = []) {
  const exceptionByMetric = new Map(exceptions
    .filter(item => item.captureId === baseline.id)
    .map(item => [item.metric, item]));
  const results = [];
  const staleExceptions = [];
  let regression = false;
  for (const [metric, limit] of Object.entries({
    sameOriginTransferSizeBytes: MAX_TRANSFER_BYTES,
    domElementCount: MAX_DOM_ELEMENTS
  })) {
    const before = baseline.metrics?.[metric];
    const after = candidate.metrics?.[metric];
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      results.push({ metric, status: 'FAIL', reason: 'METRIC_MISSING', before: before ?? null, after: after ?? null });
      regression = true;
      continue;
    }
    const exception = exceptionByMetric.get(metric);
    if (exception && after <= limit) staleExceptions.push({ captureId: baseline.id, metric, oldObservedValue: exception.observedValue, currentValue: after });
    const newRegression = after > before;
    const overBudgetWithoutException = after > limit && !exception;
    const exceptionMeasurementChanged = exception && (exception.observedValue !== before || exception.limit !== limit);
    const passed = !newRegression && !overBudgetWithoutException && !exceptionMeasurementChanged;
    if (!passed) regression = true;
    results.push({
      metric,
      status: passed ? 'PASS' : 'FAIL',
      reason: newRegression ? 'NEW_REGRESSION' : overBudgetWithoutException ? 'ABSOLUTE_BUDGET_EXCEEDED' : exceptionMeasurementChanged ? 'BASELINE_EXCEPTION_MISMATCH' : null,
      before,
      after,
      limit,
      exceptionApplied: Boolean(exception)
    });
  }
  if (regression) return { status: 'FAIL', staleExceptions, metrics: results };
  if (staleExceptions.length) return { status: 'STALE_BASELINE', staleExceptions, metrics: results };
  return { status: 'PASS', staleExceptions, metrics: results };
}

function pastePng(source, target, targetWidth, targetHeight) {
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const from = (y * source.width + x) * 4;
      const to = (y * targetWidth + x) * 4;
      target.data[to] = source.data[from];
      target.data[to + 1] = source.data[from + 1];
      target.data[to + 2] = source.data[from + 2];
      target.data[to + 3] = source.data[from + 3];
    }
  }
}

export function comparePngBuffers(baselineBytes, candidateBytes, policy) {
  const baseline = PNG.sync.read(baselineBytes);
  const candidate = PNG.sync.read(candidateBytes);
  const width = Math.max(baseline.width, candidate.width);
  const height = Math.max(baseline.height, candidate.height);
  const baselineCanvas = new PNG({ width, height });
  const candidateCanvas = new PNG({ width, height });
  pastePng(baseline, baselineCanvas, width, height);
  pastePng(candidate, candidateCanvas, width, height);
  const diff = new PNG({ width, height });
  const changedPixels = pixelmatch(baselineCanvas.data, candidateCanvas.data, diff.data, width, height, {
    threshold: policy.pixelThreshold,
    includeAA: false,
    alpha: 0.5,
    diffColor: [255, 0, 255],
    aaColor: [255, 255, 0]
  });
  const comparedPixels = width * height;
  const changedRatio = comparedPixels === 0 ? 0 : changedPixels / comparedPixels;
  const dimensionsMatch = baseline.width === candidate.width && baseline.height === candidate.height;
  const ratioPasses = changedRatio <= policy.maxDiffRatio;
  return {
    status: dimensionsMatch && ratioPasses ? 'PASS' : 'FAIL',
    reason: !dimensionsMatch ? 'DIMENSION_MISMATCH' : !ratioPasses ? 'PIXEL_DIFF_THRESHOLD_EXCEEDED' : null,
    baselineDimensions: { width: baseline.width, height: baseline.height },
    candidateDimensions: { width: candidate.width, height: candidate.height },
    changedPixels,
    changedRatio,
    maxDiffRatio: policy.maxDiffRatio,
    pixelThreshold: policy.pixelThreshold,
    diffPng: PNG.sync.write(diff)
  };
}

export function resolveCapturePath(manifestPath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') || relativePath.includes('\\')) {
    throw new Error('CAPTURE_PATH_INVALID');
  }
  const base = resolve(manifestPath, '..');
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) throw new Error('CAPTURE_PATH_OUTSIDE_ARTIFACT');
  return target;
}

export async function verifyCaptureHash(manifestPath, capture) {
  const screenshotPath = resolveCapturePath(manifestPath, capture.screenshotPath);
  const bytes = await readFile(screenshotPath);
  return { valid: sha256(bytes) === capture.screenshotSha256, bytes, screenshotPath };
}

export async function verifyCaptureMetadata(manifestPath, capture) {
  const metadataPath = resolveCapturePath(manifestPath, capture.metadataPath);
  const bytes = await readFile(metadataPath);
  const valid = sha256(bytes) === capture.metadataSha256;
  const metadata = valid ? JSON.parse(bytes.toString('utf8')) : null;
  const valuesMatch = metadata && metadata.id === capture.id &&
    metadata.sourceSHA === capture.sourceSHA &&
    metadata.metrics?.sameOriginTransferSizeBytes === capture.metrics?.sameOriginTransferSizeBytes &&
    metadata.metrics?.domElementCount === capture.metrics?.domElementCount &&
    metadata.screenshotSha256 === capture.screenshotSha256;
  return { valid: Boolean(valid && valuesMatch), metadataPath };
}
