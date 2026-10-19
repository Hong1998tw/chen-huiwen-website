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

test('accepts the legacy 12 digit v query only when it matches the owned body', async () => {
  const bytes = Buffer.from('legacy query version JavaScript');
  const sha256 = digest(bytes);
  const path = 'digital.js';
  const assets = await verifyVersionedShellAssets([`./${path}?v=${sha256.slice(0, 12)}`], {
    [path]: sha256,
  }, async () => bytes);
  assert.equal(assets[0].versioning, 'sha256-v-query');
  assert.equal(assets[0].sha256, sha256);
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
  const bytes = Buffer.from('private JS body');
  const sha256 = digest(bytes);
  const privatePath = `cms-page-editor.${sha256.slice(0, 12)}.js`;
  const privateBytes = Buffer.from('private JS body');
  const privateSha = digest(privateBytes);
  await assert.rejects(verifyVersionedShellAssets([`./${privatePath}?v=${privateSha.slice(0, 12)}`], {
    [privatePath]: privateSha,
  }, async () => privateBytes), /private or excluded/);
  await assert.rejects(verifyVersionedShellAssets([`./app.${sha256}.js?token=fixture`], {
    [`app.${sha256}.js`]: sha256,
  }, async () => bytes), /private or excluded/);
  await assert.rejects(verifyVersionedShellAssets([`https://assets.example/app.${sha256}.js`], {
    [`app.${sha256}.js`]: sha256,
  }, async () => bytes), /same-origin public artifact/);
});
