import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FONT_ROLES = ['common', 'delta'];

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

function validateExpectedFonts(expectedFonts) {
  assert.ok(Array.isArray(expectedFonts) && expectedFonts.length === FONT_ROLES.length,
    'schema-2 route must provide its Common and page Delta font faces');
  const roles = new Set();
  const paths = new Set();
  const families = new Set();
  for (const font of expectedFonts) {
    assert.ok(font && FONT_ROLES.includes(font.role), 'expected page font role is invalid');
    assert.ok(!roles.has(font.role), `duplicate expected page font role: ${font.role}`);
    roles.add(font.role);
    assertSafePublicRoute(font.path);
    assert.ok(typeof font.family === 'string' && font.family.trim().length > 0,
      `${font.role}: expected font family is missing`);
    assert.ok((typeof font.weight === 'number' && Number.isFinite(font.weight))
      || (typeof font.weight === 'string' && font.weight.trim().length > 0),
    `${font.role}: expected font weight is missing`);
    assert.match(font.sha256 || '', SHA256, `${font.role}: expected font digest is invalid`);
    assert.ok(Array.isArray(font.codepoints) && font.codepoints.length > 0,
      `${font.role}: parsed font cmap is missing`);
    assert.ok(font.codepoints.every((codepoint) => Number.isInteger(codepoint)
      && codepoint >= 0 && codepoint <= 0x10ffff
      && !(codepoint >= 0xd800 && codepoint <= 0xdfff)),
    `${font.role}: parsed font cmap contains an invalid Unicode scalar`);
    assert.ok(!paths.has(font.path), 'Common and page Delta font paths must be distinct');
    assert.ok(!families.has(font.family), 'Common and page Delta font families must be distinct');
    paths.add(font.path);
    families.add(font.family);
  }
  assert.deepEqual([...roles].sort(), FONT_ROLES, 'schema-2 route must provide both Common and page Delta faces');
  return Object.fromEntries(expectedFonts.map((font) => [font.role, font]));
}

export function validateVisualTypography({ route, routeCodepoints, expectedFonts, typography, stage }) {
  assertSafePublicRoute(route);
  const expectedByRole = validateExpectedFonts(expectedFonts);
  assert.ok(Array.isArray(routeCodepoints) && routeCodepoints.length > 0,
    `${route}: schema-2 route cmap is missing`);
  assert.ok(routeCodepoints.every((codepoint) => Number.isInteger(codepoint)
    && codepoint >= 0 && codepoint <= 0x10ffff
    && !(codepoint >= 0xd800 && codepoint <= 0xdfff)),
  `${route}: schema-2 route cmap contains an invalid Unicode scalar`);
  assert.equal(new Set(routeCodepoints).size, routeCodepoints.length,
    `${route}: schema-2 route cmap contains duplicate codepoints`);
  const expectedCoverage = new Set(expectedFonts.flatMap((font) => font.codepoints));
  for (const codepoint of routeCodepoints) {
    assert.ok(expectedCoverage.has(codepoint),
      `${route}: schema-2 route cmap character U+${codepoint.toString(16).toUpperCase()} has no Common/page Delta font coverage`);
  }
  const label = stage || 'visual capture';
  assert.ok(typography && typeof typography === 'object', `${route}: ${label} font readiness evidence is missing`);
  assert.equal(typography.route, route, `${route}: ${label} evidence is bound to a different route`);
  assert.equal(typography.artifactRoute, route,
    `${route}: ${label} page artifact marker does not match the selected route`);
  assert.equal(typography.documentFontsStatus, 'loaded',
    `${route}: ${label} document.fonts status is not loaded`);
  assert.ok(typeof typography.bodyFontFamily === 'string' && typeof typography.headingFontFamily === 'string',
    `${route}: ${label} computed font stacks are missing`);
  assert.ok(typography.bodyFontFamily.includes(expectedByRole.common.family),
    `${route}: ${label} body stack omits manifest Common family ${expectedByRole.common.family}`);
  assert.ok(typography.headingFontFamily.includes(expectedByRole.delta.family),
    `${route}: ${label} heading stack omits manifest page Delta family ${expectedByRole.delta.family}`);
  assert.ok(Array.isArray(typography.visibleCodepoints),
    `${route}: ${label} visible user-text codepoints are missing`);
  const visibleCodepoints = new Set(typography.visibleCodepoints);
  assert.ok(typography.visibleCodepoints.every((codepoint) => Number.isInteger(codepoint)
    && codepoint >= 0 && codepoint <= 0x10ffff
    && !(codepoint >= 0xd800 && codepoint <= 0xdfff)),
  `${route}: ${label} visible user text contains an invalid Unicode scalar`);
  assert.ok(Array.isArray(typography.fontFaces), `${route}: ${label} FontFaceSet entries are missing`);
  assert.ok(Array.isArray(typography.fontChecks) && typography.fontChecks.length === FONT_ROLES.length,
    `${route}: ${label} document.fonts.load/check evidence is missing`);

  for (const role of FONT_ROLES) {
    const expected = expectedByRole[role];
    const face = typography.fontFaces.find((candidate) => candidate.family === expected.family
      && String(candidate.weight) === String(expected.weight) && candidate.status === 'loaded');
    assert.ok(face,
      `${route}: ${label} expected manifest face ${expected.path} (${expected.family}, ${expected.weight}) is missing or not loaded`);
    const check = typography.fontChecks.find((candidate) => candidate.role === role);
    assert.ok(check, `${route}: ${label} ${role} document.fonts check is missing`);
    assert.equal(check.family, expected.family,
      `${route}: ${label} ${role} check is bound to a different manifest family`);
    assert.ok(Number.isInteger(check.probeCodepoint)
      && visibleCodepoints.has(check.probeCodepoint)
      && expected.codepoints.includes(check.probeCodepoint),
    `${route}: ${label} ${role} probe is not a visible user character covered by the manifest cmap for ${expected.path}`);
    assert.equal(check.checkResult, true,
      `${route}: ${label} document.fonts.check failed for ${role} family ${expected.family}`);
    assert.ok(Array.isArray(check.loadedFaces),
      `${route}: ${label} ${role} document.fonts.load result is missing`);
    assert.ok(check.loadedFaces.some((loadedFace) => loadedFace.family === expected.family
      && String(loadedFace.weight) === String(expected.weight) && loadedFace.status === 'loaded'),
    `${route}: ${label} document.fonts.load did not return the loaded manifest face ${expected.path}`);
  }
  return true;
}

function validateCaptureNetwork({ route, expectedFonts, preloads, captureNetwork }) {
  assert.ok(captureNetwork && typeof captureNetwork === 'object', `${route}: capture network evidence is missing`);
  assert.equal(captureNetwork.route, route, `${route}: capture network evidence is bound to a different route`);
  assert.equal(captureNetwork.phase, 'visual-capture', 'screenshot network phase is missing');
  assert.deepEqual(captureNetwork.preOnDemandPhases, ['initial', 'visual-capture'],
    `${route}: pre-on-demand route phases are incomplete or out of order`);
  assert.ok(Array.isArray(captureNetwork.fullTcRequests)
    && Array.isArray(captureNetwork.preOnDemandFullTcRequests),
  `${route}: Full-TC network evidence is missing`);
  assert.deepEqual(captureNetwork.fullTcRequests, [],
    `${route}: visual capture triggered a Full-TC request`);
  assert.deepEqual(captureNetwork.preOnDemandFullTcRequests, [],
    `${route}: pre-on-demand route work triggered a Full-TC request`);
  assert.ok(captureNetwork.phaseCounts && typeof captureNetwork.phaseCounts === 'object',
    `${route}: per-phase network counts are missing`);
  assert.ok(Array.isArray(captureNetwork.pageFontRequests),
    `${route}: page-font CDP request evidence is missing`);
  for (const phase of captureNetwork.preOnDemandPhases) {
    const counts = captureNetwork.phaseCounts[phase];
    assert.ok(counts && Number.isInteger(counts.fullTc) && counts.fullTc >= 0
      && Number.isInteger(counts.pageFont) && counts.pageFont >= 0,
    `${route}: ${phase} network phase counts are incomplete`);
  }
  assert.equal(captureNetwork.initialFullTcRequestsBeforeCapture, captureNetwork.phaseCounts.initial.fullTc,
    `${route}: initial Full-TC request count is inconsistent`);
  assert.equal(captureNetwork.fullTcRequests.length, captureNetwork.phaseCounts['visual-capture'].fullTc,
    `${route}: visual-capture Full-TC phase count does not match its request records`);
  assert.equal(captureNetwork.preOnDemandFullTcRequests.length,
    captureNetwork.phaseCounts.initial.fullTc + captureNetwork.phaseCounts['visual-capture'].fullTc,
  `${route}: pre-on-demand Full-TC request count is inconsistent`);
  assert.equal(captureNetwork.pageFontRequests.filter((request) => request.phase === 'initial').length,
    captureNetwork.phaseCounts.initial.pageFont, `${route}: initial page-font phase count is inconsistent`);
  assert.equal(captureNetwork.pageFontRequests.filter((request) => request.phase === 'visual-capture').length,
    captureNetwork.phaseCounts['visual-capture'].pageFont,
  `${route}: visual-capture page-font phase count is inconsistent`);

  const preloadPaths = new Set(preloads.expected);
  assert.equal(preloadPaths.size, preloads.expected.length,
    `${route}: route preload contract contains duplicate page-font paths`);
  assert.equal(captureNetwork.pageFontRequests.length, preloads.expected.length,
    `${route}: CDP page-font request count differs from the route preload contract`);
  assert.ok(captureNetwork.pageFontRequests.every((request) => preloadPaths.has(request.path)),
    `${route}: CDP observed a page-font request outside the route preload contract`);
  for (const request of captureNetwork.pageFontRequests) {
    assert.equal(request.status, 200, `${route}: page-font request ${request.path} did not return HTTP 200`);
    assert.ok(Number.isFinite(request.encodedDataLength) && request.encodedDataLength > 0,
      `${route}: page-font request ${request.path} has no nonzero CDP byte count`);
    assert.equal(request.failure, null, `${route}: page-font request ${request.path} failed or was blocked`);
  }
  for (const font of expectedFonts) {
    const path = `/${font.path}`;
    assert.ok(preloadPaths.has(path), `${route}: expected manifest font ${font.path} is absent from the route preload contract`);
    const requests = captureNetwork.pageFontRequests.filter((request) => request.path === path);
    assert.equal(requests.length, 1,
      `${route}: CDP must observe exactly one page-font request for manifest face ${font.path}`);
    const request = requests[0];
    assert.equal(request.phase, 'initial',
      `${route}: ${font.path} was first requested during visual capture instead of the initial route load`);
    assert.equal(request.requestType, 'Font', `${route}: ${font.path} CDP request type is not Font`);
    assert.equal(request.isMainFrame, true, `${route}: ${font.path} CDP request is not bound to the current page`);
    assert.equal(request.path, path, `${route}: manifest face ${font.path} request path changed`);
  }
  assert.ok(captureNetwork.pageFontRequests.every((request) => request.phase === 'initial'),
    `${route}: a page-font request was triggered while waiting for or taking the screenshot`);
}

export function buildVisualCaptureRecord({
  route,
  pngBytes,
  artifactIdentity,
  viewport,
  routeCodepoints,
  expectedFonts,
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
  assert.ok(preloads && Array.isArray(preloads.expected)
    && Array.isArray(preloads.declared) && Array.isArray(preloads.observed), 'preload evidence is missing');
  assert.ok(typography && typeof typography === 'object', `${route}: before/after capture typography evidence is missing`);
  validateVisualTypography({ route, routeCodepoints, expectedFonts,
    typography: typography.beforeCapture, stage: 'before screenshot' });
  validateVisualTypography({ route, routeCodepoints, expectedFonts,
    typography: typography.afterCapture, stage: 'after screenshot' });
  validateCaptureNetwork({ route, expectedFonts, preloads, captureNetwork });

  const { fileName } = visualPngPath('.', route);
  return {
    route,
    sourceCommit: artifactIdentity.sourceCommit,
    publicArtifactDigest: artifactIdentity.publicArtifactDigest,
    viewport,
    png: { fileName, mimeType: 'image/png', bytes: pngBytes.byteLength, pixelSize, sha256: sha256(pngBytes) },
    routeCmapCodepointCount: routeCodepoints.length,
    expectedFonts: expectedFonts.map(({ role, path, family, weight, sha256: fontSha256, codepoints }) => ({
      role, path, family, weight, sha256: fontSha256,
      codepointCount: codepoints.length,
    })),
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
