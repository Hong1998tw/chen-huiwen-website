/** Contract test for lighthouse-compare.mjs (no browser needed).
 * Builds synthetic result folders from real fixture trees and checks that a comparison is only
 * "comparable" when both runs prove they measured identical content, including the case that used
 * to pass: the same root path holding different bytes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContentManifest } from './content-manifest.mjs';
import { compareRuns, loadRun } from './lighthouse-compare.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'lh-compare-'));
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log('ok -', name); };

const tree = async (name, files) => {
 const dir = join(work, name);
 await mkdir(dir, { recursive: true });
 for (const [path, text] of Object.entries(files)) { await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), text); }
 return dir;
};
const base = { 'index.html': '<h1>home</h1>', 'styles.css': 'body{margin:0}', 'data/search-index.json': '[1,2,3]' };

/** Writes a result folder like readiness-performance.mjs would. */
const makeRun = async (name, root, { compression, browser = '140.0.7339.186', unchanged = true, withManifest = true, withContent = true, tamper, servedOverride, withQuery = false } = {}) => {
 const manifest = await buildContentManifest(root);
 const dir = join(work, name, 'candidate-lighthouse');
 await mkdir(dir, { recursive: true });
 const served = (path, file) => ({ path, serverIdentitySha256: servedOverride?.[path] ?? manifest.files.find(f => f.path === file).sha256, contentEncoding: compression === 'none' ? null : 'br', mimeType: 'text/html', vary: null });
 const results = [1, 2, 3].map(run => ({ page: 'index.html', run, lighthouseVersion: '13.4.1', browserVersion: browser, scores: { performance: compression === 'none' ? 90 : 98 },
  metrics: { 'first-contentful-paint': 1000, 'largest-contentful-paint': 2000, 'speed-index': 1500, 'total-blocking-time': 0 }, network: { transferSize: 1000, resourceSize: 2000, serverBodyBytes: 900 },
  pageRequests: [served('/index.html', 'index.html'), served(withQuery ? '/styles.css?v=abc123' : '/styles.css', 'styles.css')] }));
 const summary = { label: name, node: 'v22', root, conditions: { compression, browserVersion: browser, thresholds: { performance: 90 }, runs: 3, ci: true },
  results, ...(withContent ? { content: { root, digest: manifest.digest, fileCount: manifest.fileCount, manifestFile: 'content-manifest.json', digestAfterRun: manifest.digest, unchangedDuringRun: unchanged } } : {}) };
 if (tamper) tamper(summary, manifest);
 await writeFile(join(dir, 'summary.json'), JSON.stringify(summary));
 if (withManifest) await writeFile(join(dir, 'content-manifest.json'), JSON.stringify(manifest));
 for (const run of [1, 2, 3]) await writeFile(join(dir, `index.html-${run}.json`), '{}');
 return dir;
};
const compare = async (a, b) => compareRuns(await loadRun(a), await loadRun(b));
const mention = (comparison, pattern) => assert.ok(comparison.problems.some(problem => pattern.test(problem)), `expected a problem matching ${pattern}; got: ${JSON.stringify(comparison.problems)}`);

try {
 const rootA = await tree('root-a', base);
 const rootSame = await tree('root-same-content-other-path', base);
 const rootChanged = await tree('root-changed', { ...base, 'styles.css': 'body{margin:1px}' });
 const rootExtra = await tree('root-extra', { ...base, 'extra.js': 'x' });
 const runNone = await makeRun('none', rootA, { compression: 'none' });
 const runNoneDigest = (await buildContentManifest(rootA)).digest;

 await check('identical content in two different directories is comparable (the root path string is not evidence)', async () => {
  const auto = await makeRun('auto-same', rootSame, { compression: 'auto' });
  const comparison = await compare(runNone, auto);
  assert.deepEqual(comparison.problems, []);
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.content.sameDigest, true);
  assert.equal(comparison.A.contentDigest, comparison.B.contentDigest);
  assert.notEqual(comparison.A.root, comparison.B.root);
 });
 await check('same root path, different bytes: not comparable, the changed path is named', async () => {
  // Two runs that report the very same root string but measured different bytes.
  const changed = await makeRun('auto-changed', rootChanged, { compression: 'auto', tamper: summary => { summary.root = rootA; summary.content.root = rootA; } });
  const comparison = await compare(runNone, changed);
  assert.equal(comparison.comparable, false);
  mention(comparison, /measured content differs/); mention(comparison, /styles\.css/);
  assert.deepEqual(comparison.content.differing.changed, ['styles.css']);
 });
 await check('files added or removed between the runs are reported', async () => {
  const comparison = await compare(runNone, await makeRun('auto-extra', rootExtra, { compression: 'auto' }));
  assert.equal(comparison.comparable, false);
  assert.deepEqual(comparison.content.differing.onlyB, ['extra.js']);
  mention(comparison, /only in B: extra\.js/);
 });
 await check('missing evidence fails explicitly: no manifest, no content block, external runs', async () => {
  const noManifest = await compare(runNone, await makeRun('auto-nomanifest', rootA, { compression: 'auto', withManifest: false }));
  assert.equal(noManifest.comparable, false); mention(noManifest, /content-manifest\.json is missing/);
  const noContent = await compare(runNone, await makeRun('auto-nocontent', rootA, { compression: 'auto', withContent: false, withManifest: false }));
  assert.equal(noContent.comparable, false); mention(noContent, /no content evidence/);
  const external = await compare(runNone, await makeRun('auto-external', rootA, { compression: 'auto', withManifest: false, tamper: summary => { summary.content = { external: true, digest: null, unchangedDuringRun: null }; } }));
  assert.equal(external.comparable, false); mention(external, /no content evidence/);
  const reversed = await compare(await makeRun('auto-nocontent-a', rootA, { compression: 'auto', withContent: false, withManifest: false }), runNone);
  assert.equal(reversed.comparable, false); mention(reversed, /^A: no content evidence/);
 });
 await check('a tree that changed during the run, or an unproven run, is rejected', async () => {
  const changedDuring = await compare(runNone, await makeRun('auto-unstable', rootA, { compression: 'auto', unchanged: false }));
  assert.equal(changedDuring.comparable, false); mention(changedDuring, /not proven unchanged/);
  const unknown = await compare(runNone, await makeRun('auto-unknown', rootA, { compression: 'auto', unchanged: null }));
  assert.equal(unknown.comparable, false); mention(unknown, /not proven unchanged/);
 });
 await check('a hand-edited summary or manifest cannot fake identical content', async () => {
  const faked = await compare(runNone, await makeRun('auto-fakedigest', rootChanged, { compression: 'auto', tamper: (summary, manifest) => { summary.content.digest = manifest.digest = runNoneDigest; } }));
  assert.equal(faked.comparable, false); mention(faked, /does not match its own digest/);
  const summaryOnly = await compare(runNone, await makeRun('auto-summarydigest', rootChanged, { compression: 'auto', tamper: summary => { summary.content.digest = runNoneDigest; } }));
  assert.equal(summaryOnly.comparable, false); mention(summaryOnly, /summary digest .* differs from content-manifest\.json digest/);
 });
 await check('served bytes must match the manifest and each other', async () => {
  const wrong = 'f'.repeat(64);
  const mismatch = await compare(runNone, await makeRun('auto-servedwrong', rootA, { compression: 'auto', servedOverride: { '/styles.css': wrong } }));
  assert.equal(mismatch.comparable, false); mention(mismatch, /B: \/styles\.css was served with bytes that differ from content-manifest\.json/); mention(mismatch, /\/styles\.css was served with different bytes in A and B/);
 });

 // ---- Evidence holes found in review of 566b35d: each must read as "insufficient", never as "nothing wrong". ----
 // Builds a comparison where only one side carries the defect, on either side, against a clean counterpart.
 const withHole = async (side, tamperSummary) => {
  const hole = await makeRun(`hole-${side}-${Math.random().toString(36).slice(2, 7)}`, rootA, { compression: side === 'A' ? 'none' : 'auto', tamper: tamperSummary });
  const clean = side === 'A' ? await makeRun(`clean-b-${Math.random().toString(36).slice(2, 7)}`, rootA, { compression: 'auto' }) : runNone;
  return side === 'A' ? compare(hole, clean) : compare(clean, hole);
 };
 const everyRun = (summary, fn) => summary.results.forEach(fn);
 const holes = [
  ['a request row has no serverIdentitySha256', summary => { delete summary.results[1].pageRequests[1].serverIdentitySha256; }, /styles\.css has no server-side SHA-256/],
  ['serverIdentitySha256 is null, empty or malformed', summary => { summary.results[0].pageRequests[1].serverIdentitySha256 = null; summary.results[1].pageRequests[1].serverIdentitySha256 = ''; summary.results[2].pageRequests[1].serverIdentitySha256 = 'abc123'; }, /styles\.css has no server-side SHA-256/],
  ['a served path is not in the manifest', summary => { summary.results[2].pageRequests.push({ path: '/injected.js', serverIdentitySha256: 'a'.repeat(64), mimeType: 'text/javascript', contentEncoding: null, vary: null }); }, /\/injected\.js was served but is not in content-manifest\.json \(unknown served path\)/],
  ['an unknown served path with a query string', summary => { summary.results[0].pageRequests.push({ path: '/ghost.css?v=1', serverIdentitySha256: 'b'.repeat(64) }); }, /\/ghost\.css was served but is not in content-manifest\.json/],
  ['digestAfterRun is missing', summary => { delete summary.content.digestAfterRun; }, /digestAfterRun is missing/],
  ['digestAfterRun is null', summary => { summary.content.digestAfterRun = null; }, /digestAfterRun is missing/],
  ['digestAfterRun contradicts unchangedDuringRun=true', summary => { summary.content.digestAfterRun = 'c'.repeat(64); summary.content.unchangedDuringRun = true; }, /digestAfterRun .* differs from the digest taken before the run \(contradicts unchangedDuringRun=true\)/],
  ['pageRequests is missing', summary => { delete summary.results[1].pageRequests; }, /index\.html run 2: pageRequests is missing/],
  ['pageRequests is empty', summary => { summary.results[0].pageRequests = []; }, /index\.html run 1: pageRequests is empty/],
  ['pageRequests is not an array', summary => { summary.results[2].pageRequests = { path: '/index.html' }; }, /pageRequests is missing/],
  ['no run has pageRequests at all', summary => everyRun(summary, result => { delete result.pageRequests; }), /pageRequests is missing/],
  ['the measured page itself has no verified row', summary => { summary.results[0].pageRequests = summary.results[0].pageRequests.filter(row => row.path !== '/index.html'); }, /the measured page itself has no verified request row/],
  ['a request row has no path', summary => { delete summary.results[0].pageRequests[0].path; }, /a request row has no path/],
  ['summary has no results', summary => { summary.results = []; }, /summary\.json has no results|no page in common/]
 ];
 await check('insufficient evidence on either side is never comparable: missing sha, unknown served path, bad digestAfterRun, missing pageRequests', async () => {
  for (const [label, tamperSummary, expected] of holes) {
   for (const side of ['A', 'B']) {
    const comparison = await withHole(side, tamperSummary);
    assert.equal(comparison.comparable, false, `${label} (${side}) must not be comparable: ${JSON.stringify(comparison.problems)}`);
    mention(comparison, new RegExp(`^${side}: .*`, 's'));
    assert.ok(comparison.problems.some(problem => expected.test(problem)), `${label} (${side}): expected ${expected}, got ${JSON.stringify(comparison.problems)}`);
   }
  }
 });
 await check('positive control: the same shapes with complete evidence are comparable, including query strings and a clean counterpart', async () => {
  const clean = await compare(runNone, await makeRun('control-auto', rootSame, { compression: 'auto' }));
  assert.deepEqual(clean.problems, []); assert.equal(clean.comparable, true);
  const query = await compare(await makeRun('control-none-query', rootA, { compression: 'none', withQuery: true }), await makeRun('control-auto-query', rootSame, { compression: 'auto', withQuery: true }));
  assert.deepEqual(query.problems, []); assert.equal(query.comparable, true);
  // A holey run never counts as the "clean" side of a later comparison: the verdict follows the evidence, not the order.
  const reversed = await compare(await makeRun('hole-first', rootA, { compression: 'auto', tamper: summary => { delete summary.results[0].pageRequests; } }), runNone);
  assert.equal(reversed.comparable, false);
 });
 await check('problem lists stay bounded when evidence is badly broken', async () => {
  const broken = await withHole('B', summary => everyRun(summary, result => { result.pageRequests = result.pageRequests.map(row => ({ path: row.path })); }));
  assert.equal(broken.comparable, false);
  assert.ok(broken.problems.length <= 20, `got ${broken.problems.length} problems`);
 });
 await check('CLI exits 1 and names the hole for each evidence defect; the clean pair still exits 0', async () => {
  const script = join(here, 'lighthouse-compare.mjs');
  const out = join(work, 'cli-holes');
  for (const [label, tamperSummary, expected] of holes.filter((_, i) => [0, 2, 4, 6, 7, 8].includes(i))) {
   const hole = await makeRun(`cli-hole-${label.replace(/\W+/g, '-')}`, rootA, { compression: 'auto', tamper: tamperSummary });
   const result = spawnSync('node', [script, runNone, hole, out], { encoding: 'utf8' });
   assert.equal(result.status, 1, `${label}: ${result.stderr}`);
   assert.match(result.stdout, /不可比較／證據不足/, label);
   assert.match(result.stdout, expected, label);
   assert.doesNotMatch(result.stdout, /同一份受測內容/, label);
  }
  const ok = spawnSync('node', [script, runNone, await makeRun('cli-clean', rootSame, { compression: 'auto' }), out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
 });
 await check('browser, Lighthouse, threshold and compression mismatches still fail', async () => {
  const browser = await compare(runNone, await makeRun('auto-browser', rootA, { compression: 'auto', browser: '141.0.0.0' }));
  assert.equal(browser.comparable, false); mention(browser, /browserVersion differs/);
  const sameMode = await compare(runNone, await makeRun('none-again', rootA, { compression: 'none' }));
  assert.equal(sameMode.comparable, false); mention(sameMode, /same compression mode/);
  const lighthouse = await compare(runNone, await makeRun('auto-lh', rootA, { compression: 'auto', tamper: summary => { summary.results.forEach(result => { result.lighthouseVersion = '13.5.0'; }); } }));
  mention(lighthouse, /lighthouseVersion differs/);
  const thresholds = await compare(runNone, await makeRun('auto-thr', rootA, { compression: 'auto', tamper: summary => { summary.conditions.thresholds = { performance: 80 }; } }));
  mention(thresholds, /thresholds differs/);
 });
 await check('CLI exits 0 for comparable runs and 1 with a written report for non-comparable runs', async () => {
  const script = join(here, 'lighthouse-compare.mjs');
  const good = await makeRun('cli-good', rootSame, { compression: 'auto' });
  const bad = await makeRun('cli-bad', rootChanged, { compression: 'auto' });
  const out = join(work, 'cli-out');
  const ok = spawnSync('node', [script, runNone, good, out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /同一份受測內容/);
  const fail = spawnSync('node', [script, runNone, bad, out], { encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /不可比較／證據不足/); assert.match(fail.stdout, /styles\.css/);
  const missing = spawnSync('node', [script, runNone, join(work, 'no-such-dir'), out], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
 });
 console.log(`lighthouse-compare-check: ${checks.length} checks passed`);
} finally {
 await rm(work, { recursive: true, force: true });
}
