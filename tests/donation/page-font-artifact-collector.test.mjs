import assert from 'node:assert/strict';
import test from 'node:test';
import { collectVisibleFontDiagnostics } from './page-font-artifact-collector.mjs';
import {
  buildExpectedPageFonts,
  validateVisibleCodepointCoverage,
} from './page-font-artifact-visual.mjs';

const commonPath = 'assets/fonts/page-common-fixture.woff2';
const deltaPath = 'assets/fonts/page-delta-fixture.woff2';
const routeRow = {
  commonFont: commonPath,
  deltaFont: deltaPath,
  preloads: [commonPath, deltaPath],
  jpFallbackCodepoints: [0x65e5],
};
const fontManifest = {
  fonts: {
    [commonPath]: {
      family: 'Fixture Page Common',
      wght: { min: 250, default: 400, max: 900 },
      bytes: 2048,
      sha256: 'c'.repeat(64),
      codepoints: [0x4e2d, 0x6587],
    },
    [deltaPath]: {
      family: 'Fixture Page Delta',
      wght: { min: 250, default: 700, max: 900 },
      bytes: 3072,
      sha256: 'd'.repeat(64),
      codepoints: [0x6587, 0x65b0],
    },
  },
};
const browserDiagnostics = {
  route: 'news/example.html',
  artifactRoute: 'news/example.html',
  visibleCodepoints: [0x4e2d, 0x65e5, 0x2304],
  visibleCodepointsTruncated: false,
  rawTcUnsupportedGlyphOwners: [{
    selector: 'p',
    fontFamily: 'Huiwen Sans JP Support',
    fontWeight: '400',
    fontStyle: 'normal',
    codepoints: [0x65e5],
    sample: '日',
  }, {
    selector: 'summary::after',
    codepoints: [0x2304],
    sample: '⌄⌄',
  }],
};

test('collector sends producer-shaped route fonts through one role-complete JSON boundary', async () => {
  assert.equal(Object.hasOwn(routeRow, 'role'), false,
    'producer route rows must not be pre-adapted with test-only role metadata');
  const expectedFromVisualCaller = buildExpectedPageFonts(routeRow, fontManifest);
  let serializedArguments;
  const page = {
    async evaluate(callback, arguments_) {
      assert.equal(typeof callback, 'function');
      serializedArguments = JSON.parse(JSON.stringify(arguments_));
      return browserDiagnostics;
    },
  };

  const result = await collectVisibleFontDiagnostics(page, 'news/example.html', routeRow, fontManifest);

  assert.deepEqual(serializedArguments.expectedFonts, expectedFromVisualCaller,
    'collector evaluate arguments must use the same producer-row factory as the visual caller');
  assert.deepEqual(serializedArguments.expectedFonts.map(({ role, path, weight, weightAxis, bytes, sha256, codepoints }) => ({
    role, path, weight, weightAxis, bytes, sha256, codepoints,
  })), [
    {
      role: 'common', path: commonPath, weight: '250 900',
      weightAxis: { min: 250, default: 400, max: 900 }, bytes: 2048,
      sha256: 'c'.repeat(64), codepoints: [0x4e2d, 0x6587],
    },
    {
      role: 'delta', path: deltaPath, weight: '250 900',
      weightAxis: { min: 250, default: 700, max: 900 }, bytes: 3072,
      sha256: 'd'.repeat(64), codepoints: [0x6587, 0x65b0],
    },
  ]);
  assert.deepEqual(serializedArguments.expectedPreloads, [`/${commonPath}`, `/${deltaPath}`]);
  assert.deepEqual(result.rawTcUnsupportedCodepoints, [0x2304, 0x65e5]);
  assert.deepEqual(result.fallbackCodepoints.jp, [0x65e5]);
  assert.deepEqual(result.fallbackCodepoints.system, [0x2304, 0x2630, 0x2733]);
  assert.equal(result.unexpectedGlyphCount, 0);
  assert.deepEqual(result.rawTcUnsupportedGlyphOwners.map(({ selector, codepoints }) => ({ selector, codepoints })), [
    { selector: 'p', codepoints: [0x65e5] },
    { selector: 'summary::after', codepoints: [0x2304] },
  ]);

  assert.throws(() => validateVisibleCodepointCoverage({
    route: 'news/example.html',
    routeCodepoints: [0x4e2d, 0x6587],
    expectedFonts: expectedFromVisualCaller,
    visibleCodepoints: [...browserDiagnostics.visibleCodepoints, 0x1f600],
    routeFallbacks: { jp: routeRow.jpFallbackCodepoints },
  }), /visible character U\+1F600 is outside the page manifest and explicit JP\/system fallback contracts/);
});
