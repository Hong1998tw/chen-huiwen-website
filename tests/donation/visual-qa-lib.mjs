import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { initialUiReadinessFailures } from './visual-qa-readiness.mjs';

export const VISUAL_QA_SCHEMA_VERSION = 3;
export const MAX_TRANSFER_BYTES = 300000;
export const MAX_DOM_ELEMENTS = 1500;
export const GIT_BASELINE_SELECTION_RELATIVE_PATH = 'tests/baselines/visual-qa/selection.json';
const MAX_BASELINE_EXCEPTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseZonedInstant(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetMinute > 59 || offsetHour > 14 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function exceptionExpiryProblem(exception, nowMs) {
  const expiresAtMs = parseZonedInstant(exception?.expiresAt);
  if (expiresAtMs == null) return 'BASELINE_EXCEPTION_EXPIRY_INVALID';
  if (!Number.isFinite(nowMs)) return 'BASELINE_EXCEPTION_CLOCK_INVALID';
  if (nowMs >= expiresAtMs) return 'BASELINE_EXCEPTION_EXPIRED';
  return null;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function readApprovedBaseline({ manifestPath, expectedSha256, expectedSourceSha }) {
  const configured = Boolean(manifestPath || expectedSha256 || expectedSourceSha);
  if (!configured) return { status: 'PENDING', reason: 'BASELINE_MISSING' };
  if (!manifestPath || !expectedSha256 || !expectedSourceSha) {
    return { status: 'REJECTED', reason: 'BASELINE_CONFIGURATION_INCOMPLETE' };
  }
  let bytes;
  try {
    bytes = await readFile(manifestPath);
  } catch (error) {
    return { status: 'REJECTED', reason: error.code === 'ENOENT' ? 'CONFIGURED_BASELINE_MISSING' : 'CONFIGURED_BASELINE_UNAVAILABLE' };
  }
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) return { status: 'REJECTED', reason: 'EXPECTED_BASELINE_SHA256_INVALID' };
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
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'REJECTED', reason: 'BASELINE_JSON_INVALID', actualSha256 };
  }
  if (manifest.schemaVersion !== VISUAL_QA_SCHEMA_VERSION || manifest.status !== 'APPROVED') {
    return { status: 'REJECTED', reason: 'BASELINE_NOT_APPROVED_OR_UNSUPPORTED', actualSha256 };
  }
  if (!manifest.approval?.reviewedBy || !manifest.approval?.reviewedAt || !manifest.approval?.note) {
    return { status: 'REJECTED', reason: 'APPROVAL_RECORD_INCOMPLETE', actualSha256 };
  }
  if (!/^[a-f0-9]{40}$/i.test(expectedSourceSha) || manifest.sourceSHA !== expectedSourceSha ||
      manifest.siteSourceSHA !== expectedSourceSha || manifest.checkoutSHA !== manifest.captureToolSHA ||
      !/^[a-f0-9]{40}$/i.test(manifest.captureToolSHA ?? '')) {
    return { status: 'REJECTED', reason: 'BASELINE_SOURCE_SHA_MISMATCH', actualSha256 };
  }
  if (!Array.isArray(manifest.captures) || manifest.captures.length !== 30) {
    return { status: 'REJECTED', reason: 'BASELINE_CAPTURE_SET_INVALID', actualSha256 };
  }
  const captureIds = new Set();
  for (const capture of manifest.captures) {
    if (capture?.sourceSHA !== expectedSourceSha || capture?.siteSourceSHA !== expectedSourceSha ||
        capture?.checkoutSHA !== manifest.captureToolSHA || capture?.captureToolSHA !== manifest.captureToolSHA) {
      return { status: 'REJECTED', reason: 'BASELINE_CAPTURE_SOURCE_SHA_MISMATCH', actualSha256 };
    }
    if (!capture || typeof capture.id !== 'string' || !/^[a-z0-9-]+$/.test(capture.id) || captureIds.has(capture.id) ||
        capture.screenshotPath !== `${capture.id}.png` || capture.metadataPath !== `${capture.id}.json` ||
        !/^[a-f0-9]{64}$/i.test(capture.screenshotSha256 ?? '') || !/^[a-f0-9]{64}$/i.test(capture.metadataSha256 ?? '')) {
      return { status: 'REJECTED', reason: 'BASELINE_CAPTURE_SET_INVALID', actualSha256 };
    }
    captureIds.add(capture.id);
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

export async function readGitBaselineSelection({ repositoryRoot }) {
  let root;
  try {
    root = await realpath(repositoryRoot);
  } catch {
    return { status: 'REJECTED', reason: 'BASELINE_REPOSITORY_ROOT_UNAVAILABLE' };
  }

  const baselineRoot = resolve(root, 'tests/baselines/visual-qa');
  const selectionPath = resolve(baselineRoot, 'selection.json');
  for (const directory of [resolve(root, 'tests'), resolve(root, 'tests/baselines'), baselineRoot]) {
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { status: 'PENDING', reason: 'BASELINE_SELECTION_MISSING', selectionPath: GIT_BASELINE_SELECTION_RELATIVE_PATH };
      }
      return { status: 'REJECTED', reason: 'BASELINE_SELECTION_UNAVAILABLE' };
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return { status: 'REJECTED', reason: 'BASELINE_SELECTION_PATH_UNSAFE' };
    }
  }

  let selectionInfo;
  try {
    selectionInfo = await lstat(selectionPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'PENDING', reason: 'BASELINE_SELECTION_MISSING', selectionPath: GIT_BASELINE_SELECTION_RELATIVE_PATH };
    }
    return { status: 'REJECTED', reason: 'BASELINE_SELECTION_UNAVAILABLE' };
  }
  if (selectionInfo.isSymbolicLink() || !selectionInfo.isFile()) {
    return { status: 'REJECTED', reason: 'BASELINE_SELECTION_PATH_UNSAFE' };
  }

  let selectionBytes;
  let selection;
  try {
    selectionBytes = await readFile(selectionPath);
    selection = JSON.parse(selectionBytes.toString('utf8'));
  } catch {
    return { status: 'REJECTED', reason: 'BASELINE_SELECTION_INVALID' };
  }
  const allowedSelectionKeys = new Set(['manifestPath', 'manifestSha256', 'schemaVersion', 'sourceSHA']);
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || selection.schemaVersion !== 1 ||
      Object.keys(selection).some(key => !allowedSelectionKeys.has(key))) {
    return { status: 'REJECTED', reason: 'BASELINE_SELECTION_INVALID' };
  }
  if (!/^[a-f0-9]{40}$/.test(selection.sourceSHA ?? '') ||
      !/^[a-f0-9]{64}$/.test(selection.manifestSha256 ?? '')) {
    return { status: 'REJECTED', reason: 'BASELINE_SELECTION_PROVENANCE_INVALID' };
  }
  if (typeof selection.manifestPath !== 'string' || selection.manifestPath !== `${selection.sourceSHA}/manifest.json`) {
    return { status: 'REJECTED', reason: 'BASELINE_SELECTION_PATH_INVALID' };
  }

  const releaseDirectory = join(baselineRoot, selection.sourceSHA);
  let releaseInfo;
  try {
    releaseInfo = await lstat(releaseDirectory);
  } catch (error) {
    return { status: 'REJECTED', reason: error.code === 'ENOENT' ? 'CONFIGURED_BASELINE_MISSING' : 'CONFIGURED_BASELINE_UNAVAILABLE' };
  }
  if (releaseInfo.isSymbolicLink() || !releaseInfo.isDirectory()) {
    return { status: 'REJECTED', reason: 'BASELINE_SELECTION_PATH_UNSAFE' };
  }

  const manifestPath = join(releaseDirectory, 'manifest.json');
  let manifestInfo;
  try {
    manifestInfo = await lstat(manifestPath);
  } catch (error) {
    return { status: 'REJECTED', reason: error.code === 'ENOENT' ? 'CONFIGURED_BASELINE_MISSING' : 'CONFIGURED_BASELINE_UNAVAILABLE' };
  }
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    return { status: 'REJECTED', reason: 'BASELINE_SELECTION_PATH_UNSAFE' };
  }

  const baseline = await readApprovedBaseline({
    manifestPath,
    expectedSha256: selection.manifestSha256,
    expectedSourceSha: selection.sourceSHA
  });
  if (baseline.status !== 'APPROVED') return { ...baseline, selectionPath: GIT_BASELINE_SELECTION_RELATIVE_PATH };

  for (const capture of baseline.manifest.captures) {
    for (const relativePath of [capture.screenshotPath, capture.metadataPath]) {
      const capturePath = join(releaseDirectory, relativePath);
      let captureInfo;
      try {
        captureInfo = await lstat(capturePath);
      } catch (error) {
        return {
          status: 'REJECTED',
          reason: error.code === 'ENOENT' ? 'BASELINE_CAPTURE_FILE_MISSING' : 'BASELINE_CAPTURE_FILE_UNAVAILABLE',
          captureId: capture.id
        };
      }
      if (captureInfo.isSymbolicLink() || !captureInfo.isFile()) {
        return { status: 'REJECTED', reason: 'BASELINE_CAPTURE_PATH_UNSAFE', captureId: capture.id };
      }
    }
    try {
      const screenshot = await verifyCaptureHash(manifestPath, capture);
      if (!screenshot.valid) return { status: 'REJECTED', reason: 'BASELINE_IMAGE_SHA256_MISMATCH', captureId: capture.id };
      const metadata = await verifyCaptureMetadata(manifestPath, capture);
      if (!metadata.valid) return { status: 'REJECTED', reason: 'BASELINE_METADATA_SHA256_MISMATCH', captureId: capture.id };
    } catch {
      return { status: 'REJECTED', reason: 'BASELINE_CAPTURE_CONTENT_INVALID', captureId: capture.id };
    }
  }

  return {
    ...baseline,
    manifestPath,
    selectionPath: GIT_BASELINE_SELECTION_RELATIVE_PATH,
    sourceType: 'git-selection'
  };
}

const SHA40 = /^[a-f0-9]{40}$/i;
const SHA64 = /^[a-f0-9]{64}$/i;

export function validateDeploymentReceipt(receipt) {
  return Boolean(receipt && typeof receipt === 'object' && receipt.schemaVersion === 1 &&
    receipt.provider === 'cloudflare-static-assets' && SHA40.test(receipt.sourceCommit ?? '') &&
    SHA64.test(receipt.publicArtifactDigest ?? ''));
}

export function evaluateDeploymentWindow(before, after) {
  if (!validateDeploymentReceipt(before) || !validateDeploymentReceipt(after)) {
    return { status: 'UNVERIFIED', stable: false, reason: 'DEPLOYMENT_RECEIPT_INVALID' };
  }
  const stable = before.sourceCommit === after.sourceCommit && before.publicArtifactDigest === after.publicArtifactDigest;
  return {
    status: stable ? 'VERIFIED' : 'MIXED_DEPLOYMENT',
    stable,
    before: { sourceCommit: before.sourceCommit, publicArtifactDigest: before.publicArtifactDigest },
    after: { sourceCommit: after.sourceCommit, publicArtifactDigest: after.publicArtifactDigest }
  };
}

export function deploymentEvidence(checkoutSHA, before, after) {
  const verification = evaluateDeploymentWindow(before, after);
  return {
    sourceSHA: verification.status === 'VERIFIED' ? before.sourceCommit : null,
    checkoutSHA: SHA40.test(checkoutSHA ?? '') ? checkoutSHA : null,
    liveDeployment: {
      sourceCommitAtStart: before?.sourceCommit ?? null,
      publicArtifactDigestAtStart: before?.publicArtifactDigest ?? null,
      sourceCommitAtEnd: after?.sourceCommit ?? null,
      publicArtifactDigestAtEnd: after?.publicArtifactDigest ?? null
    },
    verification
  };
}

export function cloudflareEncodingEvidence(contentEncoding, cloudflareVerified) {
  const observed = String(contentEncoding ?? '').trim() || 'identity';
  const tokens = observed.toLowerCase().split(',').map(token => token.trim());
  const valid = tokens.length > 0 && tokens.every(token => token === 'identity' || /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token));
  return {
    contentEncoding: observed,
    environmentLabel: `cloudflare-production-${tokens.join('+')}`,
    cloudflareVerified: Boolean(cloudflareVerified),
    encodingValid: valid,
    verified: Boolean(cloudflareVerified && valid)
  };
}

export function evaluateCaptureQuality(capture, { expectedHttpStatus = 200, screenshotRequired = true } = {}) {
  const failures = [];
  if (capture.httpStatus !== expectedHttpStatus) failures.push('HTTP_STATUS_UNEXPECTED');
  if (capture.navigationError) failures.push('NAVIGATION_ERROR');
  if (capture.screenshotError) failures.push('SCREENSHOT_ERROR');
  if (screenshotRequired && !capture.screenshotSha256) failures.push('SCREENSHOT_MISSING');
  if (capture.conditions?.fontsReady !== true) failures.push('FONTS_NOT_READY');
  failures.push(...initialUiReadinessFailures(capture));
  const pageErrors = capture.pageErrors ?? [];
  if (pageErrors.some(error => typeof error === 'string' || error.originClass === 'same-origin')) failures.push('FIRST_PARTY_PAGE_ERROR');
  if (pageErrors.some(error => typeof error === 'object' && error.originClass === 'unknown')) failures.push('PAGE_ERROR_SOURCE_UNCLASSIFIED');
  if ((capture.imageState?.firstPartyFailedImageCount ?? 0) > 0) failures.push('FIRST_PARTY_VISIBLE_IMAGE_FAILED');
  const firstPartyRequestFailures = (capture.network ?? []).filter(item => item.originClass === 'same-origin' &&
    (item.failed || (Number.isFinite(item.status) && item.status >= 400)));
  if (firstPartyRequestFailures.length) failures.push('FIRST_PARTY_REQUEST_FAILED');
  const thirdPartyFailures = (capture.network ?? []).filter(item => item.originClass === 'third-party' &&
    (item.failed || (Number.isFinite(item.status) && item.status >= 400)));
  return {
    status: failures.length ? 'INCOMPLETE' : 'COMPLETE',
    failureReasons: failures,
    firstPartyRequestFailureCount: firstPartyRequestFailures.length,
    thirdPartyFailureCount: thirdPartyFailures.length,
    thirdPartyPageErrorCount: pageErrors.filter(error => typeof error === 'object' && error.originClass === 'third-party').length,
    unclassifiedPageErrorCount: pageErrors.filter(error => typeof error === 'object' && error.originClass === 'unknown').length
  };
}

export function compareCaptureConditions(candidate, baseline) {
  const reasonNames = { environmentLabel: 'ENVIRONMENT_LABEL', measurementScope: 'MEASUREMENT_SCOPE' };
  for (const key of ['environmentLabel', 'measurementScope']) {
    if (!candidate[key] || candidate[key] !== baseline[key]) return { comparable: false, reason: `CAPTURE_${reasonNames[key]}_MISMATCH` };
  }
  const candidateSource = candidate.metrics?.sameOriginTransferSizeSource;
  const baselineSource = baseline.metrics?.sameOriginTransferSizeSource;
  if (!candidateSource || candidateSource !== baselineSource) return { comparable: false, reason: 'TRANSFER_MEASUREMENT_SOURCE_MISMATCH' };
  return { comparable: true, reason: null };
}

export function validateBaselineExceptions(manifest, { now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const byCapture = new Map();
  for (const exception of manifest.exceptions ?? []) {
    const key = `${exception.captureId}:${exception.metric}`;
    if (byCapture.has(key)) return { valid: false, reason: 'DUPLICATE_BASELINE_EXCEPTION' };
    const expiryProblem = exceptionExpiryProblem(exception, nowMs);
    if (expiryProblem) return { valid: false, reason: expiryProblem };
    const approvalAtMs = parseZonedInstant(manifest.approval?.reviewedAt);
    if (approvalAtMs == null || approvalAtMs > nowMs) return { valid: false, reason: 'BASELINE_EXCEPTION_APPROVAL_TIME_INVALID' };
    if (parseZonedInstant(exception.expiresAt) > approvalAtMs + MAX_BASELINE_EXCEPTION_TTL_MS) {
      return { valid: false, reason: 'BASELINE_EXCEPTION_TTL_EXCEEDS_30_DAYS' };
    }
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

export function compareMetrics(candidate, baseline, exceptions = [], { now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
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
    const expiryProblem = exception ? exceptionExpiryProblem(exception, nowMs) : null;
    if (exception && after <= limit) staleExceptions.push({ captureId: baseline.id, metric, oldObservedValue: exception.observedValue, currentValue: after });
    const newRegression = after > before;
    const overBudgetWithoutException = after > limit && !exception;
    const exceptionMeasurementChanged = exception && (exception.observedValue !== before || exception.limit !== limit);
    const passed = !expiryProblem && !newRegression && !overBudgetWithoutException && !exceptionMeasurementChanged;
    if (!passed) regression = true;
    results.push({
      metric,
      status: passed ? 'PASS' : 'FAIL',
      reason: expiryProblem ?? (newRegression ? 'NEW_REGRESSION' : overBudgetWithoutException ? 'ABSOLUTE_BUDGET_EXCEEDED' : exceptionMeasurementChanged ? 'BASELINE_EXCEPTION_MISMATCH' : null),
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
    metadata.sourceSHA === capture.sourceSHA && metadata.siteSourceSHA === capture.siteSourceSHA &&
    metadata.captureToolSHA === capture.captureToolSHA && metadata.checkoutSHA === capture.checkoutSHA &&
    metadata.metrics?.sameOriginTransferSizeBytes === capture.metrics?.sameOriginTransferSizeBytes &&
    metadata.metrics?.domElementCount === capture.metrics?.domElementCount &&
    metadata.environmentLabel === capture.environmentLabel &&
    metadata.measurementScope === capture.measurementScope &&
    metadata.screenshotSha256 === capture.screenshotSha256;
  return { valid: Boolean(valid && valuesMatch), metadataPath };
}
