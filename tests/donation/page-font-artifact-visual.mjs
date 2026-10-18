import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const VISUAL_CAPTURE_SEED = 'huiwen-g02-20261018';
export const VISUAL_CAPTURE_COUNT = 20;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function assertSafePublicRoute(route) {
  assert.equal(typeof route, 'string', 'public route must be a string');
  assert.ok(route.length > 0 && route.length <= 512, 'public route length is invalid');
  assert.ok(!route.startsWith('/'), 'public route must be relative');
  assert.ok(!/[\\?#\u0000-\u001f\u007f]/u.test(route), 'public route contains a forbidden character');

  const segments = route.split('/');
  assert.ok(segments.every((segment) => segment.length > 0), 'public route contains an empty segment');
  for (const segment of segments) {
    let decoded = segment;
    for (let depth = 0; depth < 8; depth += 1) {
      assert.ok(decoded !== '.' && decoded !== '..', 'public route contains a dot segment');
      assert.ok(!/[\\/\u0000-\u001f\u007f]/u.test(decoded), 'public route decodes to a separator or control character');
      let next;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        assert.fail('public route contains malformed percent encoding');
      }
      if (next === decoded) break;
      decoded = next;
      assert.ok(depth < 7, 'public route has excessive nested percent encoding');
    }
  }

  const parsed = new URL(route, 'https://public-artifact.invalid/');
  assert.equal(parsed.origin, 'https://public-artifact.invalid', 'public route changed origin');
  assert.equal(parsed.search, '', 'public route must not contain a query');
  assert.equal(parsed.hash, '', 'public route must not contain a fragment');
  return route;
}

export function selectVisualRoutes(routeNames, { seed = VISUAL_CAPTURE_SEED, count = VISUAL_CAPTURE_COUNT } = {}) {
  assert.ok(Array.isArray(routeNames), 'public routes must be supplied as an array');
  assert.ok(typeof seed === 'string' && seed.length > 0, 'visual selection seed is required');
  assert.ok(Number.isInteger(count) && count > 0, 'visual route count must be a positive integer');
  const safeRoutes = routeNames.map(assertSafePublicRoute);
  assert.equal(new Set(safeRoutes).size, safeRoutes.length, 'public route list contains duplicates');
  assert.ok(count <= safeRoutes.length, 'visual route count exceeds the legal route count');

  return [...safeRoutes]
    .sort((left, right) => {
      const leftRank = sha256(`${seed}\0${left}`);
      const rightRank = sha256(`${seed}\0${right}`);
      if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .slice(0, count);
}

export function visualPngPath(visualRoot, route) {
  assertSafePublicRoute(route);
  const root = resolve(visualRoot);
  const fileName = `${sha256(route)}.png`;
  const path = resolve(root, fileName);
  const inside = relative(root, path);
  assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside),
    'visual PNG path escaped its output directory');
  return { path, fileName };
}

export function pngPixelSize(pngBytes) {
  assert.ok(Buffer.isBuffer(pngBytes) && pngBytes.length >= 24, 'visual capture is too short to contain a PNG header');
  assert.ok(pngBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), 'visual capture is not a PNG');
  assert.equal(pngBytes.toString('ascii', 12, 16), 'IHDR', 'visual capture has no PNG IHDR chunk');
  const width = pngBytes.readUInt32BE(16);
  const height = pngBytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0, 'visual PNG dimensions must be positive');
  return { width, height };
}

export function validateArtifactIdentity({ deployment, publicationBytes, expectedSourceCommit = null }) {
  assert.ok(deployment && typeof deployment === 'object', 'public deployment identity is missing');
  assert.equal(deployment.schemaVersion, 1, 'public deployment identity schema changed');
  assert.equal(deployment.provider, 'cloudflare-static-assets', 'public deployment provider changed');
  assert.match(deployment.sourceCommit || '', SOURCE_COMMIT, 'public source commit is invalid');
  assert.match(deployment.publicArtifactDigest || '', SHA256, 'public artifact digest is invalid');
  assert.ok(Buffer.isBuffer(publicationBytes), 'publication manifest bytes are required');
  assert.equal(sha256(publicationBytes), deployment.publicArtifactDigest,
    'deployment identity does not bind the publication manifest bytes');
  if (expectedSourceCommit !== null) {
    assert.match(expectedSourceCommit, SOURCE_COMMIT, 'expected source commit is invalid');
    assert.equal(deployment.sourceCommit, expectedSourceCommit,
      'public artifact source commit differs from the checked out commit');
  }
  return {
    sourceCommit: deployment.sourceCommit,
    publicArtifactDigest: deployment.publicArtifactDigest,
  };
}

export function buildVisualCaptureRecord({
  route,
  pngBytes,
  artifactIdentity,
  viewport,
  typography,
  preloads,
  captureNetwork,
}) {
  assertSafePublicRoute(route);
  assert.ok(Buffer.isBuffer(pngBytes) && pngBytes.length > PNG_SIGNATURE.length,
    'visual capture must contain PNG bytes');
  const pixelSize = pngPixelSize(pngBytes);
  assert.match(artifactIdentity?.sourceCommit || '', SOURCE_COMMIT, 'visual source commit is invalid');
  assert.match(artifactIdentity?.publicArtifactDigest || '', SHA256, 'visual artifact digest is invalid');
  assert.ok(Number.isInteger(viewport?.width) && viewport.width > 0
    && Number.isInteger(viewport?.height) && viewport.height > 0, 'visual viewport is invalid');
  assert.deepEqual(pixelSize, viewport, 'visual PNG pixel dimensions differ from the recorded viewport');
  assert.ok(typography && typeof typography.bodyFontFamily === 'string'
    && typeof typography.headingFontFamily === 'string', 'computed font stacks are missing');
  assert.ok(typography.fontFaces && Array.isArray(typography.fontFaces), 'font face load states are missing');
  assert.ok(preloads && Array.isArray(preloads.expected)
    && Array.isArray(preloads.declared) && Array.isArray(preloads.observed), 'preload evidence is missing');
  assert.ok(captureNetwork?.phase === 'visual-capture', 'screenshot network phase is missing');

  const { fileName } = visualPngPath('.', route);
  return {
    route,
    sourceCommit: artifactIdentity.sourceCommit,
    publicArtifactDigest: artifactIdentity.publicArtifactDigest,
    viewport,
    png: { fileName, mimeType: 'image/png', bytes: pngBytes.byteLength, pixelSize, sha256: sha256(pngBytes) },
    typography,
    preloads,
    captureNetwork,
  };
}

export function visualPngMatchesHash(pngBytes, expectedSha256) {
  if (!Buffer.isBuffer(pngBytes) || !SHA256.test(expectedSha256 || '') || sha256(pngBytes) !== expectedSha256) return false;
  try {
    pngPixelSize(pngBytes);
    return true;
  } catch {
    return false;
  }
}
