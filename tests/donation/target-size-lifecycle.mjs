/** Finalize target-size evidence even when a resource cleanup or report write fails. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function errorDetails(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

export async function finishTargetSizeRun({ report, out, browser, server }) {
  report.diagnostics ??= [];
  const recordFailure = (label, error) => {
    const details = errorDetails(error);
    report.diagnostics.push({ kind: label === 'report-write' ? 'report-write' : 'cleanup', label, details });
    report.failures.push({ label, details });
  };

  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      recordFailure('cleanup:browser', error);
    }
  }
  if (server) {
    try {
      await server.close();
    } catch (error) {
      recordFailure('cleanup:server', error);
    }
  }

  report.finished = new Date().toISOString();
  report.status = report.failures.length ? 'failed' : 'passed';
  try {
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    return { written: true };
  } catch (error) {
    recordFailure('report-write', error);
    report.status = 'failed';
    return { written: false };
  }
}
