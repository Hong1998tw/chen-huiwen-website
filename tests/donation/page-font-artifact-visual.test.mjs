import assert from 'node:assert/strict';
import test from 'node:test';
import { basename, relative, resolve, sep } from 'node:path';
import {
  VISUAL_CAPTURE_COUNT,
  VISUAL_CAPTURE_SEED,
  buildVisualCaptureRecord,
  pngPixelSize,
  selectVisualRoutes,
  sha256,
  validateArtifactIdentity,
  visualPngMatchesHash,
  visualPngPath,
} from './page-font-artifact-visual.mjs';

const routeInventory = Array.from({ length: 32 }, (_, index) =>
  index % 3 === 0 ? `section-${index}/page-${index}.html` : `page-${index}.html`);

function pngFixtureBytes(width, height) {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.from('fixture-png-bytes')]);
}

const visualRoute = 'news/example.html';
const expectedFonts = [
  { role: 'common', path: 'assets/fonts/page-common-fixture.woff2', family: 'Fixture Page Common',
    weight: 400, sha256: 'c'.repeat(64), codepoints: [0x4e2d, 0x6587] },
  { role: 'delta', path: 'assets/fonts/page-delta-fixture.woff2', family: 'Fixture Page Delta',
    weight: 500, sha256: 'd'.repeat(64), codepoints: [0x6587, 0x65b0] },
];
const routeCodepoints = [0x4e2d, 0x6587, 0x65b0];

function loadedTypography(route = visualRoute, overrides = {}) {
  const base = {
    route,
    artifactRoute: route,
    documentFontsStatus: 'loaded',
    bodyFontFamily: '"Fixture Page Common", sans-serif',
    headingFontFamily: '"Fixture Page Delta", "Fixture Page Common", sans-serif',
    visibleCodepoints: [0x4e2d, 0x6587, 0x65b0],
    fontFaces: expectedFonts.map((font) => ({
      family: font.family, weight: String(font.weight), style: 'normal', status: 'loaded',
    })),
    fontChecks: expectedFonts.map((font) => ({
      role: font.role,
      family: font.family,
      probeCodepoint: font.codepoints.find((codepoint) => [0x4e2d, 0x6587, 0x65b0].includes(codepoint)),
      checkResult: true,
      loadedFaces: [{ family: font.family, weight: String(font.weight), status: 'loaded' }],
    })),
  };
  return { ...base, ...overrides };
}

function validCaptureNetwork(route = visualRoute) {
  return {
    route,
    phase: 'visual-capture',
    preOnDemandPhases: ['initial', 'visual-capture'],
    phaseCounts: {
      initial: { fullTc: 0, pageFont: expectedFonts.length },
      'visual-capture': { fullTc: 0, pageFont: 0 },
    },
    initialFullTcRequestsBeforeCapture: 0,
    fullTcRequests: [],
    preOnDemandFullTcRequests: [],
    pageFontRequests: expectedFonts.map((font) => ({
      path: `/${font.path}`, phase: 'initial', requestType: 'Font', isMainFrame: true,
      initiator: { type: 'parser', frames: [] }, status: 200, encodedDataLength: 2048, failure: null,
    })),
  };
}

function validPreloads() {
  return {
    expected: expectedFonts.map((font) => `/${font.path}`),
    declared: expectedFonts.map((font) => ({ path: `/${font.path}` })),
    observed: expectedFonts.map((font) => `/${font.path}`),
  };
}

test('selects twenty unique legal routes deterministically from inventory order', () => {
  const first = selectVisualRoutes(routeInventory, { seed: VISUAL_CAPTURE_SEED, count: VISUAL_CAPTURE_COUNT });
  const second = selectVisualRoutes([...routeInventory].reverse(), { seed: VISUAL_CAPTURE_SEED, count: VISUAL_CAPTURE_COUNT });

  assert.equal(first.length, VISUAL_CAPTURE_COUNT);
  assert.equal(new Set(first).size, VISUAL_CAPTURE_COUNT);
  assert.deepEqual(first, second);
  assert.ok(first.every((route) => routeInventory.includes(route)));
});

test('rejects duplicate inventories and unsafe public route paths', () => {
  assert.throws(() => selectVisualRoutes(['page.html', 'page.html'], { count: 1 }), /duplicates/);
  for (const route of ['/absolute.html', '../outside.html', 'folder/%252e%252e/outside.html', 'a%2fb.html', 'page.html?x=1', 'page.html#part']) {
    assert.throws(() => visualPngPath('/tmp/page-font-artifact-visual', route));
  }
});

test('binds output paths to the visual directory and route hash', () => {
  const visualRoot = resolve('/tmp/page-font-artifact-visual');
  const one = visualPngPath(visualRoot, 'achievement/example.html');
  const two = visualPngPath(visualRoot, 'news/example.html');
  const relativePath = relative(visualRoot, one.path);

  assert.equal(basename(one.fileName), one.fileName);
  assert.match(one.fileName, /^[a-f0-9]{64}\.png$/);
  assert.notEqual(one.fileName, two.fileName);
  assert.ok(relativePath && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
});

test('binds visual metadata to checked source commit, artifact digest, and PNG bytes', () => {
  const sourceCommit = 'a'.repeat(40);
  const publicationBytes = Buffer.from('{"files":{"index.html":"abc"}}\n');
  const publicArtifactDigest = sha256(publicationBytes);
  const artifactIdentity = validateArtifactIdentity({
    deployment: { schemaVersion: 1, provider: 'cloudflare-static-assets', sourceCommit, publicArtifactDigest },
    publicationBytes,
    expectedSourceCommit: sourceCommit,
  });
  const pngBytes = pngFixtureBytes(390, 844);
  const record = buildVisualCaptureRecord({
    route: visualRoute,
    pngBytes,
    artifactIdentity,
    viewport: { width: 390, height: 844 },
    routeCodepoints,
    expectedFonts,
    typography: { beforeCapture: loadedTypography(), afterCapture: loadedTypography() },
    preloads: validPreloads(),
    captureNetwork: validCaptureNetwork(),
  });

  assert.equal(record.sourceCommit, sourceCommit);
  assert.equal(record.publicArtifactDigest, publicArtifactDigest);
  assert.deepEqual(pngPixelSize(pngBytes), { width: 390, height: 844 });
  assert.deepEqual(record.png.pixelSize, { width: 390, height: 844 });
  assert.equal(record.png.sha256, sha256(pngBytes));
  assert.equal(visualPngMatchesHash(pngBytes, record.png.sha256), true);
  assert.equal(visualPngMatchesHash(Buffer.concat([pngBytes, Buffer.from('changed')]), record.png.sha256), false);
  assert.throws(() => buildVisualCaptureRecord({
    route: visualRoute, pngBytes, artifactIdentity, viewport: { width: 1365, height: 950 }, routeCodepoints, expectedFonts,
    typography: { beforeCapture: loadedTypography(), afterCapture: loadedTypography() },
    preloads: validPreloads(), captureNetwork: validCaptureNetwork(),
  }), /pixel dimensions differ/);
  assert.throws(() => validateArtifactIdentity({
    deployment: { schemaVersion: 1, provider: 'cloudflare-static-assets', sourceCommit, publicArtifactDigest: '0'.repeat(64) },
    publicationBytes,
  }), /does not bind/);
  assert.throws(() => validateArtifactIdentity({
    deployment: { schemaVersion: 1, provider: 'cloudflare-static-assets', sourceCommit, publicArtifactDigest },
    publicationBytes,
    expectedSourceCommit: 'b'.repeat(40),
  }), /differs from the checked out commit/);
});

test('rejects unrendered manifest fonts, wrong route binding, and failed capture network evidence', () => {
  const sourceCommit = 'a'.repeat(40);
  const publicationBytes = Buffer.from('{"files":{"index.html":"abc"}}\n');
  const artifactIdentity = {
    sourceCommit,
    publicArtifactDigest: sha256(publicationBytes),
  };
  const pngBytes = pngFixtureBytes(390, 844);
  const build = ({ typography = { beforeCapture: loadedTypography(), afterCapture: loadedTypography() },
    captureNetwork = validCaptureNetwork() } = {}) => buildVisualCaptureRecord({
    route: visualRoute,
    pngBytes,
    artifactIdentity,
    viewport: { width: 390, height: 844 },
    routeCodepoints,
    expectedFonts,
    typography,
    preloads: validPreloads(),
    captureNetwork,
  });

  const reviewerNotLoadedFixture = loadedTypography(visualRoute, {
    fontFaces: [],
    fontLoaded: { common: false, delta: false },
    fontChecks: expectedFonts.map((font) => ({
      role: font.role, family: font.family,
      probeCodepoint: font.codepoints[0], checkResult: false, loadedFaces: [],
    })),
  });
  assert.throws(() => build({ typography: {
    beforeCapture: reviewerNotLoadedFixture,
    afterCapture: loadedTypography(),
  } }), /expected manifest face .* is missing or not loaded/);

  const notLoadedFace = loadedTypography();
  notLoadedFace.fontFaces[0].status = 'unloaded';
  notLoadedFace.fontChecks[0].checkResult = false;
  notLoadedFace.fontChecks[0].loadedFaces[0].status = 'unloaded';
  assert.throws(() => build({ typography: {
    beforeCapture: loadedTypography(),
    afterCapture: notLoadedFace,
  } }), /after screenshot expected manifest face .* is missing or not loaded/);

  assert.throws(() => build({ typography: {
    beforeCapture: loadedTypography(visualRoute, { artifactRoute: 'news/other.html' }),
    afterCapture: loadedTypography(),
  } }), /artifact marker does not match/);

  assert.throws(() => buildVisualCaptureRecord({
    route: visualRoute,
    pngBytes,
    artifactIdentity,
    viewport: { width: 390, height: 844 },
    routeCodepoints: [0x4e2d, 0x7121],
    expectedFonts,
    typography: { beforeCapture: loadedTypography(), afterCapture: loadedTypography() },
    preloads: validPreloads(),
    captureNetwork: validCaptureNetwork(),
  }), /schema-2 route cmap character U\+7121 has no Common\/page Delta font coverage/);

  const fullTcCapture = validCaptureNetwork();
  fullTcCapture.fullTcRequests = [{ path: '/assets/fonts/full-tc.woff2', phase: 'visual-capture' }];
  fullTcCapture.phaseCounts['visual-capture'].fullTc = 1;
  fullTcCapture.preOnDemandFullTcRequests = [...fullTcCapture.fullTcRequests];
  assert.throws(() => build({ captureNetwork: fullTcCapture }), /visual capture triggered a Full-TC request/);

  const initialFullTc = validCaptureNetwork();
  initialFullTc.phaseCounts.initial.fullTc = 1;
  initialFullTc.initialFullTcRequestsBeforeCapture = 1;
  initialFullTc.preOnDemandFullTcRequests = [{ path: '/assets/fonts/full-tc.woff2', phase: 'initial' }];
  assert.throws(() => build({ captureNetwork: initialFullTc }), /pre-on-demand route work triggered a Full-TC request/);

  const zeroByteFontResponse = validCaptureNetwork();
  zeroByteFontResponse.pageFontRequests[0].encodedDataLength = 0;
  assert.throws(() => build({ captureNetwork: zeroByteFontResponse }), /nonzero CDP byte count/);

  const blockedFontResponse = validCaptureNetwork();
  blockedFontResponse.pageFontRequests[0].failure = { category: 'response-blocked', blockedReason: 'inspector' };
  assert.throws(() => build({ captureNetwork: blockedFontResponse }), /failed or was blocked/);

  const deniedFontResponse = validCaptureNetwork();
  deniedFontResponse.pageFontRequests[0].status = 403;
  assert.throws(() => build({ captureNetwork: deniedFontResponse }), /did not return HTTP 200/);

  const missingCdpFontResponse = validCaptureNetwork();
  missingCdpFontResponse.pageFontRequests = missingCdpFontResponse.pageFontRequests.slice(1);
  missingCdpFontResponse.phaseCounts.initial.pageFont -= 1;
  assert.throws(() => build({ captureNetwork: missingCdpFontResponse }), /CDP page-font request count differs/);

  const latePageFontResponse = validCaptureNetwork();
  latePageFontResponse.pageFontRequests[0].phase = 'visual-capture';
  latePageFontResponse.phaseCounts.initial.pageFont -= 1;
  latePageFontResponse.phaseCounts['visual-capture'].pageFont += 1;
  assert.throws(() => build({ captureNetwork: latePageFontResponse }), /first requested during visual capture/);
});
