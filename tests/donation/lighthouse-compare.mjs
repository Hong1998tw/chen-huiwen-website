/** Side-by-side comparison of two readiness-performance.mjs result folders.
 * Usage: node lighthouse-compare.mjs <dir-A> <dir-B> [out-dir]
 * Each dir is a `<label>-lighthouse` folder (summary.json + raw per-run LHR JSON).
 * The comparison is only meaningful when both runs measured the same build with the
 * same Chromium and Lighthouse; otherwise it exits 1 and says why. Raw reports are
 * listed with SHA-256 so the numbers can be traced back to the retained files.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const [dirA, dirB, outArg] = process.argv.slice(2).map(arg => resolve(arg));
if (!dirA || !dirB) { console.error('Usage: node lighthouse-compare.mjs <dir-A> <dir-B> [out-dir]'); process.exit(2); }
const out = outArg || resolve(dirB, '..');
const median = values => { const a = [...values].filter(v => v !== undefined && v !== null).sort((x, y) => x - y); if (!a.length) return null; return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
const load = async dir => {
 const summary = JSON.parse(await readFile(resolve(dir, 'summary.json'), 'utf8'));
 const raw = [];
 for (const name of (await readdir(dir)).filter(name => /^.+\.html-\d+\.json$/.test(name)).sort()) {
  const bytes = await readFile(resolve(dir, name));
  raw.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
 }
 return { dir, label: summary.label, summary, raw };
};
const [A, B] = [await load(dirA), await load(dirB)];
const problems = [];
const same = (name, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${name} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); };
same('browserVersion', A.summary.conditions?.browserVersion, B.summary.conditions?.browserVersion);
same('lighthouseVersion', A.summary.results[0]?.lighthouseVersion, B.summary.results[0]?.lighthouseVersion);
same('thresholds', A.summary.conditions?.thresholds, B.summary.conditions?.thresholds);
same('root (same build content required)', A.summary.root, B.summary.root);
if (A.summary.conditions?.compression === B.summary.conditions?.compression) problems.push('both runs used the same compression mode; nothing to compare');
const pages = [...new Set(A.summary.results.map(result => result.page))].filter(page => B.summary.results.some(result => result.page === page));
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
 vary: side.summary.conditions?.vary, browserVersion: side.summary.conditions?.browserVersion, lighthouseVersion: side.summary.results[0]?.lighthouseVersion, node: side.summary.node, ci: side.summary.conditions?.ci, runsPerPage: side.summary.conditions?.runs });
const comparison = { comparable: problems.length === 0, problems, A: conditions(A), B: conditions(B), pages: rows, rawReports: { A: A.raw, B: B.raw } };
const f = (value, digits = 0) => value === null || value === undefined ? '–' : Number(value).toFixed(digits);
const kb = value => value === null || value === undefined ? '–' : (value / 1024).toFixed(1) + ' KiB';
const md = [`# Lighthouse A/B: ${A.label} (A) vs ${B.label} (B)`, '',
 comparison.comparable ? '同一份建置內容、同一 Chromium／Lighthouse，僅傳輸壓縮條件不同。' : '**不可直接比較：** ' + problems.join('；'), '',
 '| 條件 | A | B |', '|---|---|---|',
 ...['compression', 'brotliQuality', 'gzipLevel', 'vary', 'browserVersion', 'lighthouseVersion', 'runsPerPage', 'ci'].map(key => `| ${key} | ${comparison.A[key] ?? '–'} | ${comparison.B[key] ?? '–'} |`), '',
 '| 頁面 | Perf A（逐次） | Perf B（逐次） | 中位數 A→B | FCP A→B (ms) | LCP A→B (ms) | 傳輸 A→B | 文字資源編碼 A / B |', '|---|---|---|---|---|---|---|---|',
 ...rows.map(row => `| ${row.page} | ${row.A.performance.join(', ')} | ${row.B.performance.join(', ')} | ${f(row.A.performanceMedian)}→${f(row.B.performanceMedian)} | ${f(row.A.fcpMs)}→${f(row.B.fcpMs)} | ${f(row.A.lcpMs)}→${f(row.B.lcpMs)} | ${kb(row.A.transferBytes)}→${kb(row.B.transferBytes)} | ${row.A.textEncodings.join('+') || '–'} / ${row.B.textEncodings.join('+') || '–'} |`), '',
 '原始報告（SHA-256）見 comparison.json；傳輸量為 Chrome 觀察到的 transferSize（含回應標頭），伺服器端本文位元組另見各 summary.json 的 network.serverBodyBytes。', ''].join('\n');
await mkdir(out, { recursive: true });
const stem = `comparison-${basename(dirA).replace(/-lighthouse$/, '')}-vs-${basename(dirB).replace(/-lighthouse$/, '')}`;
await writeFile(resolve(out, stem + '.json'), JSON.stringify(comparison, null, 2));
await writeFile(resolve(out, stem + '.md'), md);
console.log(md);
if (!comparison.comparable) process.exitCode = 1;
