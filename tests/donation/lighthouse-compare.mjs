/** Side-by-side comparison of two readiness-performance.mjs result folders.
 * Usage: node lighthouse-compare.mjs <dir-A> <dir-B> [out-dir]
 * Each dir is a `<label>-lighthouse` folder (summary.json, content-manifest.json, raw per-run LHR JSON).
 * The comparison is only meaningful when both runs measured byte-identical site content with the
 * same Chromium and Lighthouse. It fails (exit 1, `comparable: false`) when:
 *  - either side lacks content evidence (summary `content` or content-manifest.json), the manifest
 *    does not match its recorded digest, or the tree changed while that run was measured;
 *  - the two content digests differ (the differing paths are listed), or a path both runs served
 *    has different bytes in the two server logs, or served bytes differ from the manifest;
 *  - browser, Lighthouse or thresholds differ, or both runs used the same compression mode.
 * A same-path-different-content pair therefore never produces a "comparable" result. Raw reports are
 * listed with the SHA-256 of the report files; the content digest is the hash of the measured site files.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diffManifests, manifestDigestMatchesFiles } from './content-manifest.mjs';

const median = values => { const a = [...values].filter(v => v !== undefined && v !== null).sort((x, y) => x - y); if (!a.length) return null; return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

export async function loadRun(dir) {
 const summary = await readJson(resolve(dir, 'summary.json'));
 if (!summary) throw new Error(`${dir}: summary.json is missing or unreadable`);
 const manifest = await readJson(resolve(dir, summary.content?.manifestFile || 'content-manifest.json'));
 const raw = [];
 for (const name of (await readdir(dir)).filter(name => /^.+\.html-\d+\.json$/.test(name)).sort()) {
  const bytes = await readFile(resolve(dir, name));
  raw.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
 }
 return { dir, label: summary.label, summary, manifest, raw };
}

/** Evidence checks for one run: returns a list of problems (empty = the run proves what it measured). */
export function contentEvidenceProblems(side, name) {
 const { summary, manifest } = side;
 const content = summary.content;
 const problems = [];
 if (!content || content.external) return [`${name}: no content evidence in summary.json (external BASE_URL or a run from before content digests existed)`];
 if (!content.digest) problems.push(`${name}: summary.json records no content digest`);
 if (!manifest) problems.push(`${name}: content-manifest.json is missing or unreadable`);
 else {
  if (!manifestDigestMatchesFiles(manifest)) problems.push(`${name}: content-manifest.json does not match its own digest (edited or corrupt)`);
  if (content.digest && manifest.digest !== content.digest) problems.push(`${name}: summary digest ${content.digest} differs from content-manifest.json digest ${manifest.digest}`);
 }
 if (content.unchangedDuringRun !== true) problems.push(`${name}: the measured tree was not proven unchanged during the run (unchangedDuringRun=${content.unchangedDuringRun}, digestAfterRun=${content.digestAfterRun})`);
 return problems;
}

const servedHashes = side => {
 const served = new Map();
 for (const result of side.summary.results) for (const row of result.pageRequests || []) {
  if (!row.serverIdentitySha256) continue;
  const path = row.path.split('?')[0];
  if (!served.has(path)) served.set(path, new Set());
  served.get(path).add(row.serverIdentitySha256);
 }
 return served;
};
const manifestHash = (manifest, path) => manifest?.files.find(file => file.path === (path === '/' ? 'index.html' : path.replace(/^\//, '').replace(/\/$/, '/index.html')))?.sha256;

export function compareRuns(A, B) {
 const problems = [];
 const same = (name, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${name} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); };
 same('browserVersion', A.summary.conditions?.browserVersion, B.summary.conditions?.browserVersion);
 same('lighthouseVersion', A.summary.results[0]?.lighthouseVersion, B.summary.results[0]?.lighthouseVersion);
 same('thresholds', A.summary.conditions?.thresholds, B.summary.conditions?.thresholds);
 problems.push(...contentEvidenceProblems(A, 'A'), ...contentEvidenceProblems(B, 'B'));
 let contentDiff = null;
 if (A.manifest && B.manifest) {
  if (A.manifest.digest !== B.manifest.digest) {
   contentDiff = diffManifests(A.manifest, B.manifest);
   const list = items => items.slice(0, 10).join(', ') + (items.length > 10 ? ` … (+${items.length - 10})` : '');
   problems.push(`measured content differs: digest ${A.manifest.digest} vs ${B.manifest.digest}`
    + (contentDiff.changed.length ? `; ${contentDiff.changed.length} path(s) with different bytes: ${list(contentDiff.changed)}` : '')
    + (contentDiff.onlyA.length ? `; only in A: ${list(contentDiff.onlyA)}` : '')
    + (contentDiff.onlyB.length ? `; only in B: ${list(contentDiff.onlyB)}` : ''));
  }
  // What the servers actually handed out must match the manifests, and each other.
  const servedA = servedHashes(A), servedB = servedHashes(B);
  for (const [name, side, served] of [['A', A, servedA], ['B', B, servedB]]) {
   for (const [path, hashes] of served) {
    const expected = manifestHash(side.manifest, path);
    if (expected && [...hashes].some(hash => hash !== expected)) problems.push(`${name}: ${path} was served with bytes that differ from content-manifest.json`);
   }
  }
  for (const [path, hashes] of servedA) {
   const other = servedB.get(path);
   if (other && ([...hashes].length !== 1 || [...other].length !== 1 || [...hashes][0] !== [...other][0])) problems.push(`${path} was served with different bytes in A and B`);
  }
 }
 if (A.summary.conditions?.compression === B.summary.conditions?.compression) problems.push('both runs used the same compression mode; nothing to compare');
 const pages = [...new Set(A.summary.results.map(result => result.page))].filter(page => B.summary.results.some(result => result.page === page));
 if (!pages.length) problems.push('the two runs have no page in common');
 const rows = pages.map(page => {
  const stat = side => {
   const runs = side.summary.results.filter(result => result.page === page);
   const encodings = [...new Set(runs.flatMap(run => run.pageRequests || []).filter(row => /^text\/(html|css|javascript)$/.test((row.mimeType || '').split(';')[0])).map(row => row.contentEncoding || 'identity'))].sort();
   return {
    runs: runs.length,
    performance: runs.map(run => run.scores.performance),
    performanceMedian: median(runs.map(run => run.scores.performance)),
    fcpMs: median(runs.map(run => run.metrics['first-contentful-paint'])),
    lcpMs: median(runs.map(run => run.metrics['largest-contentful-paint'])),
    speedIndexMs: median(runs.map(run => run.metrics['speed-index'])),
    tbtMs: median(runs.map(run => run.metrics['total-blocking-time'])),
    transferBytes: median(runs.map(run => run.network?.transferSize)),
    resourceBytes: median(runs.map(run => run.network?.resourceSize)),
    serverBodyBytes: median(runs.map(run => run.network?.serverBodyBytes)),
    textEncodings: encodings,
    vary: [...new Set(runs.flatMap(run => run.pageRequests || []).map(row => row.vary ?? null))]
   };
  };
  const a = stat(A), b = stat(B);
  return { page, A: a, B: b, delta: { performance: b.performanceMedian - a.performanceMedian, fcpMs: b.fcpMs - a.fcpMs, lcpMs: b.lcpMs - a.lcpMs, transferBytes: b.transferBytes - a.transferBytes } };
 });
 const conditions = side => ({ label: side.label, compression: side.summary.conditions?.compression, brotliQuality: side.summary.conditions?.brotliQuality, gzipLevel: side.summary.conditions?.gzipLevel,
  vary: side.summary.conditions?.vary, browserVersion: side.summary.conditions?.browserVersion, lighthouseVersion: side.summary.results[0]?.lighthouseVersion, node: side.summary.node, ci: side.summary.conditions?.ci, runsPerPage: side.summary.conditions?.runs,
  root: side.summary.content?.root ?? side.summary.root, contentDigest: side.summary.content?.digest ?? null, contentFiles: side.summary.content?.fileCount ?? null });
 return { comparable: problems.length === 0, problems, A: conditions(A), B: conditions(B), content: { sameDigest: Boolean(A.manifest && B.manifest && A.manifest.digest === B.manifest.digest), differing: contentDiff }, pages: rows, rawReports: { A: A.raw, B: B.raw } };
}

export function renderMarkdown(comparison, A, B) {
 const f = (value, digits = 0) => value === null || value === undefined ? '–' : Number(value).toFixed(digits);
 const kb = value => value === null || value === undefined ? '–' : (value / 1024).toFixed(1) + ' KiB';
 return [`# Lighthouse A/B: ${A.label} (A) vs ${B.label} (B)`, '',
  comparison.comparable ? '同一份受測內容（內容 digest 相同且量測期間未變）、同一 Chromium／Lighthouse，僅傳輸壓縮條件不同。' : '**不可比較／證據不足：**\n\n' + comparison.problems.map(item => `- ${item}`).join('\n'), '',
  '| 條件 | A | B |', '|---|---|---|',
  ...['compression', 'brotliQuality', 'gzipLevel', 'vary', 'browserVersion', 'lighthouseVersion', 'runsPerPage', 'ci', 'contentDigest', 'contentFiles', 'root'].map(key => `| ${key} | ${comparison.A[key] ?? '–'} | ${comparison.B[key] ?? '–'} |`), '',
  '| 頁面 | Perf A（逐次） | Perf B（逐次） | 中位數 A→B | FCP A→B (ms) | LCP A→B (ms) | 傳輸 A→B | 文字資源編碼 A / B |', '|---|---|---|---|---|---|---|---|',
  ...comparison.pages.map(row => `| ${row.page} | ${row.A.performance.join(', ')} | ${row.B.performance.join(', ')} | ${f(row.A.performanceMedian)}→${f(row.B.performanceMedian)} | ${f(row.A.fcpMs)}→${f(row.B.fcpMs)} | ${f(row.A.lcpMs)}→${f(row.B.lcpMs)} | ${kb(row.A.transferBytes)}→${kb(row.B.transferBytes)} | ${row.A.textEncodings.join('+') || '–'} / ${row.B.textEncodings.join('+') || '–'} |`), '',
  '內容 digest 是受測站台檔案（路徑、大小、SHA-256）的雜湊，逐檔清單在各資料夾的 content-manifest.json；原始報告檔 SHA-256 見 comparison.json；傳輸量為 Chrome 觀察到的 transferSize（含回應標頭），伺服器端本文位元組另見各 summary.json 的 network.serverBodyBytes。', ''].join('\n');
}

async function main() {
 const [dirA, dirB, outArg] = process.argv.slice(2).map(arg => resolve(arg));
 if (!dirA || !dirB) { console.error('Usage: node lighthouse-compare.mjs <dir-A> <dir-B> [out-dir]'); process.exit(2); }
 const out = outArg || resolve(dirB, '..');
 const [A, B] = [await loadRun(dirA), await loadRun(dirB)];
 const comparison = compareRuns(A, B);
 const md = renderMarkdown(comparison, A, B);
 await mkdir(out, { recursive: true });
 const stem = `comparison-${basename(dirA).replace(/-lighthouse$/, '')}-vs-${basename(dirB).replace(/-lighthouse$/, '')}`;
 await writeFile(resolve(out, stem + '.json'), JSON.stringify(comparison, null, 2));
 await writeFile(resolve(out, stem + '.md'), md);
 console.log(md);
 if (!comparison.comparable) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
