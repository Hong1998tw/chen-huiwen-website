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
    route: 'index.html',
    pngBytes,
    artifactIdentity,
    viewport: { width: 390, height: 844 },
    typography: { bodyFontFamily: 'Huiwen Sans TC Page Common', headingFontFamily: 'Huiwen Sans TC Page Delta', fontFaces: [] },
    preloads: { expected: [], declared: [], observed: [] },
    captureNetwork: { phase: 'visual-capture', fullTcRequests: [], pageFontRequests: [] },
  });

  assert.equal(record.sourceCommit, sourceCommit);
  assert.equal(record.publicArtifactDigest, publicArtifactDigest);
  assert.deepEqual(pngPixelSize(pngBytes), { width: 390, height: 844 });
  assert.deepEqual(record.png.pixelSize, { width: 390, height: 844 });
  assert.equal(record.png.sha256, sha256(pngBytes));
  assert.equal(visualPngMatchesHash(pngBytes, record.png.sha256), true);
  assert.equal(visualPngMatchesHash(Buffer.concat([pngBytes, Buffer.from('changed')]), record.png.sha256), false);
  assert.throws(() => buildVisualCaptureRecord({
    route: 'index.html', pngBytes, artifactIdentity, viewport: { width: 1365, height: 950 },
    typography: { bodyFontFamily: 'Huiwen Sans TC', headingFontFamily: 'Huiwen Sans TC', fontFaces: [] },
    preloads: { expected: [], declared: [], observed: [] },
    captureNetwork: { phase: 'visual-capture', fullTcRequests: [], pageFontRequests: [] },
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
