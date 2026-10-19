import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {parseServiceWorkerShell, verifyVersionedShellAssets} from './service-worker-shell-contract.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFor = (shell, required = ['./offline.html']) =>
  `const SHELL=${JSON.stringify(shell)};\nconst REQUIRED_SHELL=${JSON.stringify(required)};`;

test('parses the emitted JSON SHELL and REQUIRED_SHELL declarations', () => {
  const parsed = parseServiceWorkerShell(sourceFor(
    ['./styles.css?x=a;b', './offline.html'], ['./offline-font.woff2'],
  ));
  assert.deepEqual(parsed, {
    shell: ['./styles.css?x=a;b', './offline.html'],
    requiredShell: ['./offline-font.woff2'],
  });
  assert.throws(() => parseServiceWorkerShell('const REQUIRED_SHELL=[];'), /exactly one SHELL array/);
  assert.throws(() => parseServiceWorkerShell('const SHELL=[]; const SHELL=[]; const REQUIRED_SHELL=[];'), /exactly one SHELL array/);
  assert.throws(() => parseServiceWorkerShell('const SHELL=[not-json]; const REQUIRED_SHELL=[];'), /not valid JSON/);
});

test('accepts a full content SHA-256 filename owned by the publication manifest', async () => {
  const bytes = Buffer.from('owned fingerprinted CSS');
  const sha256 = digest(bytes);
  const path = `assets/styles.${sha256}.css`;
  const assets = await verifyVersionedShellAssets([`./${path}`], {[path]: sha256}, async requested => {
    assert.equal(requested, path);
    return bytes;
  });
  assert.deepEqual(assets, [{
    url: `./${path}`,
    path,
    extension: 'css',
    sha256,
    versioning: 'sha256-filename',
  }]);
});

test('accepts the legacy 12 digit and full SHA-256 v query only when they match the owned body', async () => {
  const bytes = Buffer.from('legacy query version JavaScript');
  const sha256 = digest(bytes);
  const path = 'digital.js';
  const files = {
    [path]: sha256,
  };
  for (const version of [sha256.slice(0, 12), sha256]) {
    const assets = await verifyVersionedShellAssets([`./${path}?v=${version}`], files, async () => bytes);
    assert.equal(assets[0].versioning, 'sha256-v-query');
    assert.equal(assets[0].sha256, sha256);
  }
});

test('accepts the owned public webmanifest date version alongside hash-verified CSS', async () => {
  const manifestBytes = Buffer.from('{"name":"public fixture"}');
  const cssBytes = Buffer.from('public fingerprinted CSS');
  const manifestPath = 'manifest.webmanifest';
  const cssPath = `styles.${digest(cssBytes)}.css`;
  const readPaths = [];
  const assets = await verifyVersionedShellAssets([
    `./${manifestPath}?v=20260912-1`, `./${cssPath}`,
  ], {
    [manifestPath]: digest(manifestBytes),
    [cssPath]: digest(cssBytes),
  }, async requested => {
    readPaths.push(requested);
    return requested === manifestPath ? manifestBytes : cssBytes;
  });

  assert.deepEqual(readPaths, [manifestPath, cssPath]);
  assert.deepEqual(assets, [{
    url: `./${cssPath}`,
    path: cssPath,
    extension: 'css',
    sha256: digest(cssBytes),
    versioning: 'sha256-filename',
  }]);
});

test('rejects unversioned, falsely fingerprinted, unowned, or byte-mismatched shell assets', async () => {
  const bytes = Buffer.from('actual CSS body');
  const sha256 = digest(bytes);
  const wrongSha = '0'.repeat(64);
  const cases = [
    {
      name: 'raw unversioned alias', shell: ['./styles.css'], files: {'styles.css': sha256}, body: bytes,
      message: /needs a full SHA-256 filename or one matching v query/,
    },
    {
      name: 'false fullhash', shell: [`./styles.${wrongSha}.css`], files: {[`styles.${wrongSha}.css`]: sha256}, body: bytes,
      message: /filename hash differs/,
    },
    {
      name: 'unowned URL', shell: [`./styles.${sha256}.css`], files: {}, body: bytes,
      message: /not owned by publication manifest/,
    },
    {
      name: 'body differs from manifest', shell: [`./styles.${sha256}.css`], files: {[`styles.${sha256}.css`]: sha256}, body: Buffer.from('different'),
      message: /bytes differ from publication manifest/,
    },
    {
      name: 'fake v query', shell: ['./styles.css?v=111111111111'], files: {'styles.css': sha256}, body: bytes,
      message: /v query does not match/,
    },
    {
      name: 'ambiguous v queries',
      shell: [`./styles.${sha256}.css?v=${sha256.slice(0, 12)}&v=${sha256.slice(0, 12)}`],
      files: {[`styles.${sha256}.css`]: sha256}, body: bytes,
      message: /ambiguous v query/,
    },
  ];
  for (const item of cases) {
    await assert.rejects(
      verifyVersionedShellAssets(item.shell, item.files, async () => item.body),
      item.message,
      item.name,
    );
  }
});

test('rejects private paths, private query keys, and cross-origin shell URLs', async () => {
  const bytes = Buffer.from('review-only fixture');
  const sha256 = digest(bytes);
  const privatePath = `private/app.${sha256}.js`;
  const cmsPath = `cms-page-editor.${sha256.slice(0, 12)}.js`;
  const secretQueryPath = `app.${sha256}.js`;
  for (const item of [
    {
      url: `./${privatePath}`, path: privatePath, message: /private or excluded/,
    },
    {
      url: `./${cmsPath}?v=${sha256.slice(0, 12)}`, path: cmsPath, message: /private or excluded/,
    },
    {
      url: `./${secretQueryPath}?secret=fixture`, path: secretQueryPath, message: /private or excluded/,
    },
    {
      url: `./${secretQueryPath}?token=fixture`, path: secretQueryPath, message: /private or excluded/,
    },
  ]) {
    await assert.rejects(verifyVersionedShellAssets([item.url], {[item.path]: sha256}, async () => bytes), item.message);
  }
  await assert.rejects(verifyVersionedShellAssets([`https://assets.example/app.${sha256}.js`], {
    [`app.${sha256}.js`]: sha256,
  }, async () => bytes), /same-origin public artifact/);
});

test('rejects encoded private paths, raw and receipt paths, and every query except one exact v version', async () => {
  const bytes = Buffer.from('review-only fixture');
  const sha256 = digest(bytes);
  const path = `app.${sha256}.js`;
  const files = {[path]: sha256};
  const queryCases = [
    {url: `./${path}?debug=1`, message: /query must contain only one exact v version/},
    {url: `./${path}?v=${sha256.slice(0, 12)}&v=${sha256.slice(0, 12)}`, message: /ambiguous v query/},
    {url: `./${path}?V=${sha256.slice(0, 12)}`, message: /query must contain only one exact v version/},
    {url: `./${path}?%76=${sha256.slice(0, 12)}`, message: /query must contain only one exact v version/},
    {url: `./${path}?v=${sha256.slice(0, 12)}&debug=1`, message: /query must contain only one exact v version/},
    {url: `./${path}?`, message: /query must contain only one exact v version/},
  ];
  for (const item of queryCases) {
    await assert.rejects(verifyVersionedShellAssets([item.url], files, async () => bytes), item.message, item.url);
  }

  await assert.rejects(verifyVersionedShellAssets([`./%70rivate/app.${sha256}.js`], {
    [`private/app.${sha256}.js`]: sha256,
  }, async () => bytes), /private or excluded/);

  for (const privatePath of [
    'sw.js',
    'data/achievements.json',
    'deployment.json',
    'publication-manifest.json',
  ]) {
    await assert.rejects(
      verifyVersionedShellAssets([`./${privatePath}`], {}, async () => bytes),
      /private or excluded/,
      privatePath,
    );
  }
});

test('rejects private, unknown, duplicate, unowned, and mismatched non-CSS/JS versions', async () => {
  const bytes = Buffer.from('{"name":"public fixture"}');
  const sha256 = digest(bytes);
  const path = 'manifest.webmanifest';
  const files = {[path]: sha256};
  const queryCases = [
    {url: `./${path}?secret=fixture`, message: /private or excluded/},
    {url: `./${path}?debug=1`, message: /query must contain only one exact v version/},
    {url: `./${path}?V=20260912-1`, message: /query must contain only one exact v version/},
    {url: `./${path}?%76=20260912-1`, message: /query must contain only one exact v version/},
    {url: `./${path}?v=20260912-1&v=20260912-1`, message: /ambiguous v query/},
    {url: `./${path}?debug=1&debug=2`, message: /duplicate query keys/},
    {url: `./${path}?v=2026-1`, message: /query must contain only one exact v version/},
    {url: `./${path}?v=20260230-1`, message: /query must contain only one exact v version/},
  ];
  for (const item of queryCases) {
    await assert.rejects(verifyVersionedShellAssets([item.url], files, async () => bytes), item.message, item.url);
  }

  await assert.rejects(
    verifyVersionedShellAssets([`./${path}?v=20260912-1`], {}, async () => bytes),
    /not owned by publication manifest/,
    'release-versioned non-CSS/JS assets must be manifest-owned',
  );
  await assert.rejects(
    verifyVersionedShellAssets([`./${path}?v=20260912-1`], {[path]: '0'.repeat(64)}, async () => bytes),
    /bytes differ from publication manifest/,
    'release-versioned non-CSS/JS bytes must match their manifest digest',
  );
});
