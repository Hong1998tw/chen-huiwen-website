import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishTargetSizeRun } from './target-size-lifecycle.mjs';

test('cleanup failures are recorded independently and the finished report is still written', async () => {
  const out = await mkdtemp(join(tmpdir(), 'target-size-lifecycle-'));
  try {
    const report = {
      cases: [],
      failures: [{ label: 'runner', details: 'primary failure' }]
    };
    let browserClosed = false;
    let serverClosed = false;
    const result = await finishTargetSizeRun({
      report,
      out,
      browser: { async close() { browserClosed = true; throw new Error('browser close failed'); } },
      server: { async close() { serverClosed = true; throw new Error('server close failed'); } }
    });

    assert.equal(browserClosed, true);
    assert.equal(serverClosed, true);
    assert.deepEqual(result, { written: true });
    assert.equal(report.status, 'failed');
    assert.ok(report.finished);
    assert.deepEqual(report.failures.map(item => item.label), ['runner', 'cleanup:browser', 'cleanup:server']);
    assert.deepEqual(report.diagnostics.map(item => item.label), ['cleanup:browser', 'cleanup:server']);
    const written = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.equal(written.status, 'failed');
    assert.deepEqual(written.failures, report.failures);
    assert.deepEqual(written.diagnostics, report.diagnostics);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('report persistence failure is captured without rejecting finalization', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'target-size-lifecycle-write-failure-'));
  const out = join(temp, 'not-a-directory');
  try {
    await writeFile(out, 'file blocks report directory');
    const report = { cases: [], failures: [] };
    const result = await finishTargetSizeRun({ report, out });

    assert.deepEqual(result, { written: false });
    assert.equal(report.status, 'failed');
    assert.ok(report.finished);
    assert.equal(report.failures.at(-1).label, 'report-write');
    assert.equal(report.diagnostics.at(-1).kind, 'report-write');
    assert.match(report.diagnostics.at(-1).details, /ENOTDIR|not a directory/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
