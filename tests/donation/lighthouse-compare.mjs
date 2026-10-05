/** Side-by-side comparison of two readiness-performance.mjs result folders.
 * Usage: node lighthouse-compare.mjs <dir-A> <dir-B> [out-dir] [--expect-pages=a.html,b.html]
 * Each dir is a `<label>-lighthouse` folder (summary.json, content-manifest.json, raw per-run LHR JSON).
 * The comparison is only meaningful when both runs measured byte-identical site content with the
 * same Chromium and Lighthouse. It fails (exit 1, `comparable: false`) when:
 *  - either side lacks content evidence (summary `content` or content-manifest.json), the manifest
 *    does not match its recorded digest, or the tree was not proven unchanged during that run
 *    (`digestAfterRun` missing, or different from `digest`, or `unchangedDuringRun` not true);
 *  - a run is incomplete: no final `acceptance` block (the run did not finish), a page with fewer or
 *    more runs than `conditions.runs`, or a page named by --expect-pages that is missing;
 *  - any measured run lacks server-side proof: `pageRequests` missing or empty, a request row without
 *    a valid `serverIdentitySha256`, a served path that is not in the manifest, served bytes that differ
 *    from the manifest, or no verified row for the measured page itself. Missing evidence is never read
 *    as "nothing wrong": it makes the comparison insufficient;
 *  - the two content digests differ (the differing paths are listed), or a path both runs served
 *    has different bytes in the two runs;
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
 if (typeof content.digestAfterRun !== 'string' || !content.digestAfterRun) problems.push(`${name}: digestAfterRun is missing, so the tree was not re-hashed after the run`);
 else if (content.digest && content.digestAfterRun !== content.digest) problems.push(`${name}: digestAfterRun ${content.digestAfterRun} differs from the digest taken before the run${content.unchangedDuringRun === true ? ' (contradicts unchangedDuringRun=true)' : ''}`);
 if (content.unchangedDuringRun !== true) problems.push(`${name}: the measured tree was not proven unchanged during the run (unchangedDuringRun=${content.unchangedDuringRun}, digestAfterRun=${content.digestAfterRun})`);
 return problems;
}

/** A finished run: final acceptance block, and every page measured exactly `conditions.runs` times (runs 1..N).
 * `expectPages` names pages that must be present on this side. Scores are not judged here: a reference run's
 * performance is recorded only; thresholds are enforced by the gate run itself. */
export function completenessProblems(side, name, expectPages = []) {
 const { summary } = side;
 const results = Array.isArray(summary.results) ? summary.results : [];
 const problems = [];
 if (!Array.isArray(summary.acceptance) || !summary.acceptance.length) problems.push(`${name}: summary.json has no final acceptance block, so the run did not finish`);
 const expectedRuns = summary.conditions?.runs;
 if (!Number.isInteger(expectedRuns) || expectedRuns < 1) problems.push(`${name}: summary.json does not record conditions.runs`);
 const byPage = new Map();
 for (const result of results) byPage.set(result.page, [...(byPage.get(result.page) || []), result.run]);
 for (const page of expectPages) if (!byPage.has(page)) problems.push(`${name}: expected page ${page} was not measured`);
 if (Number.isInteger(expectedRuns)) for (const [page, runs] of byPage) {
  const wanted = Array.from({ length: expectedRuns }, (_, index) => index + 1).join(',');
  if ([...runs].sort((a, b) => a - b).join(',') !== wanted) problems.push(`${name}: ${page} has runs [${runs.join(',')}], expected [${wanted}]`);
 }
 if (Array.isArray(summary.acceptance)) for (const row of summary.acceptance) if (!byPage.has(row.page)) problems.push(`${name}: acceptance lists ${row.page} but it has no measured run`);
 return problems;
}

const SHA256 = /^[0-9a-f]{64}$/;
const manifestPath = path => (path === '/' ? 'index.html' : path.replace(/^\//, '').replace(/\/$/, '/index.html'));
const MAX_LISTED = 10;

/** Server-side proof per measured run: every request row must be backed by the SHA-256 of the bytes the server
 * actually sent, and that file must exist in the manifest with the same bytes. Returns problems (empty = proven). */
export function servedEvidenceProblems(side, name) {
 const results = side.summary.results;
 if (!Array.isArray(results) || !results.length) return [`${name}: summary.json has no results`];
 const index = new Map((side.manifest?.files || []).map(file => [file.path, file.sha256]));
 const found = new Set();
 for (const result of results) {
  const label = `${result.page} run ${result.run}`;
  if (!Array.isArray(result.pageRequests)) { found.add(`${label}: pageRequests is missing`); continue; }
  if (!result.pageRequests.length) { found.add(`${label}: pageRequests is empty`); continue; }
  let ownDocument = false;
  for (const row of result.pageRequests) {
   const path = typeof row?.path === 'string' ? row.path.split('?')[0] : null;
   if (!path) { found.add(`${label}: a request row has no path`); continue; }
   if (!SHA256.test(row.serverIdentitySha256 ?? '')) { found.add(`${label}: ${path} has no server-side SHA-256 (serverIdentitySha256 missing or malformed)`); continue; }
   const expected = index.get(manifestPath(path));
   if (!expected) found.add(`${label}: ${path} was served but is not in content-manifest.json (unknown served path)`);
   else if (expected !== row.serverIdentitySha256) found.add(`${path} was served with bytes that differ from content-manifest.json`);
   if (path === '/' + result.page) ownDocument = true;
  }
  if (!ownDocument) found.add(`${label}: the measured page itself has no verified request row`);
 }
 const list = [...found];
 return [...list.slice(0, MAX_LISTED), ...(list.length > MAX_LISTED ? [`… and ${list.length - MAX_LISTED} more request-evidence problem(s)`] : [])].map(item => `${name}: ${item}`);
}

const servedHashes = side => {
 const served = new Map();
 for (const result of Array.isArray(side.summary.results) ? side.summary.results : []) for (const row of Array.isArray(result.pageRequests) ? result.pageRequests : []) {
  if (typeof row?.path !== 'string' || !SHA256.test(row.serverIdentitySha256 ?? '')) continue;
  const path = row.path.split('?')[0];
  if (!served.has(path)) served.set(path, new Set());
  served.get(path).add(row.serverIdentitySha256);
 }
 return served;
};

export function compareRuns(A, B, { expectPages = [] } = {}) {
 const problems = [];
 const same = (name, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${name} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); };
 same('browserVersion', A.summary.conditions?.browserVersion, B.summary.conditions?.browserVersion);
 same('lighthouseVersion', A.summary.results?.[0]?.lighthouseVersion, B.summary.results?.[0]?.lighthouseVersion);
 same('thresholds', A.summary.conditions?.thresholds, B.summary.conditions?.thresholds);
 problems.push(...contentEvidenceProblems(A, 'A'), ...contentEvidenceProblems(B, 'B'), ...servedEvidenceProblems(A, 'A'), ...servedEvidenceProblems(B, 'B'), ...completenessProblems(A, 'A', expectPages), ...completenessProblems(B, 'B', expectPages));
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
  // Paths both runs served must carry the same bytes (per-run proof against each manifest is in servedEvidenceProblems).
  const servedA = servedHashes(A), servedB = servedHashes(B);
  for (const [path, hashes] of servedA) {
   const other = servedB.get(path);
   if (other && ([...hashes].length !== 1 || [...other].length !== 1 || [...hashes][0] !== [...other][0])) problems.push(`${path} was served with different bytes in A and B`);
  }
 }
 if (A.summary.conditions?.compression === B.summary.conditions?.compression) problems.push('both runs used the same compression mode; nothing to compare');
 const resultsOf = side => (Array.isArray(side.summary.results) ? side.summary.results : []);
 const pages = [...new Set(resultsOf(A).map(result => result.page))].filter(page => resultsOf(B).some(result => result.page === page));
 if (!pages.length) problems.push('the two runs have no page in common');
 const rows = pages.map(page => {
  const stat = side => {
   const runs = resultsOf(side).filter(result => result.page === page);
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
  vary: side.summary.conditions?.vary, browserVersion: side.summary.conditions?.browserVersion, lighthouseVersion: side.summary.results?.[0]?.lighthouseVersion, node: side.summary.node, ci: side.summary.conditions?.ci, runsPerPage: side.summary.conditions?.runs,
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
 const flags = process.argv.slice(2).filter(arg => arg.startsWith('--'));
 const [dirA, dirB, outArg] = process.argv.slice(2).filter(arg => !arg.startsWith('--')).map(arg => resolve(arg));
 if (!dirA || !dirB) { console.error('Usage: node lighthouse-compare.mjs <dir-A> <dir-B> [out-dir] [--expect-pages=a.html,b.html]'); process.exit(2); }
 const expectFlag = flags.find(flag => flag.startsWith('--expect-pages='));
 const unknown = flags.filter(flag => flag !== expectFlag);
 if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}`); process.exit(2); }
 const expectPages = expectFlag ? expectFlag.slice('--expect-pages='.length).split(',').filter(Boolean) : [];
 const out = outArg || resolve(dirB, '..');
 const [A, B] = [await loadRun(dirA), await loadRun(dirB)];
 const comparison = compareRuns(A, B, { expectPages });
 const md = renderMarkdown(comparison, A, B);
 await mkdir(out, { recursive: true });
 const stem = `comparison-${basename(dirA).replace(/-lighthouse$/, '')}-vs-${basename(dirB).replace(/-lighthouse$/, '')}`;
 await writeFile(resolve(out, stem + '.json'), JSON.stringify(comparison, null, 2));
 await writeFile(resolve(out, stem + '.md'), md);
 console.log(md);
 if (!comparison.comparable) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
