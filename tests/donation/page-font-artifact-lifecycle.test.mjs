import assert from 'node:assert/strict';
import test from 'node:test';
import {
  gotoObservedWithTimeout,
  observePendingResult,
  preservePrimaryError,
  requireObservedValue,
  withTimeout,
} from './page-font-artifact-lifecycle.mjs';

test('a pending response rejection during cleanup does not replace the primary failure', async () => {
  let rejectResponseWait;
  const pendingResponse = new Promise((resolve, reject) => {
    rejectResponseWait = reject;
  });
  const responseOutcome = observePendingResult(pendingResponse);
  const primaryError = new Error('primary CMS assertion failed');
  const unhandledRejections = [];
  const onUnhandledRejection = (error) => unhandledRejections.push(error);
  process.on('unhandledRejection', onUnhandledRejection);

  let runError;
  let reportWriteCount = 0;
  let reportedResponseOutcome;
  let secondaryError;
  try {
    try {
      throw primaryError;
    } catch (error) {
      runError = error;
    } finally {
      rejectResponseWait(new Error('Target page, context or browser has been closed'));
      reportedResponseOutcome = await responseOutcome;
      const merged = preservePrimaryError(runError, reportedResponseOutcome.error);
      runError = merged.primaryError;
      secondaryError = merged.secondaryError;
      reportWriteCount += 1;
    }

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(runError, primaryError);
    assert.equal(reportWriteCount, 1);
    assert.equal(reportedResponseOutcome.status, 'rejected');
    assert.match(reportedResponseOutcome.error.message, /page, context or browser has been closed/);
    assert.strictEqual(secondaryError, reportedResponseOutcome.error);
    assert.throws(() => requireObservedValue(reportedResponseOutcome), /page, context or browser has been closed/);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('a missing response remains a rejected check instead of becoming a skipped pass', async () => {
  const timeout = new Error('page.waitForResponse: Timeout 30000ms exceeded');
  const outcome = await observePendingResult(Promise.reject(timeout));
  assert.equal(outcome.status, 'rejected');
  assert.throws(() => requireObservedValue(outcome), /Timeout 30000ms exceeded/);
});

test('a successful response remains available to the existing byte assertions', async () => {
  const response = { status: 200, body: async () => Buffer.from('font bytes') };
  const outcome = await observePendingResult(Promise.resolve(response));
  assert.strictEqual(requireObservedValue(outcome), response);
});

test('negative host navigation passes an explicit finite timeout to page.goto', async () => {
  let observed;
  const page = { goto: async (url, options) => {
    observed = { url, options };
    return { status: () => 200 };
  } };
  const response = await gotoObservedWithTimeout(page, 'https://admin.huiwen.tw/__g02/cms', {
    waitUntil: 'domcontentloaded', timeout: 15000,
  });
  assert.equal(response.status(), 200);
  assert.deepEqual(observed, {
    url: 'https://admin.huiwen.tw/__g02/cms',
    options: { timeout: 15000, waitUntil: 'domcontentloaded' },
  });
  await assert.rejects(gotoObservedWithTimeout(page, 'https://admin.huiwen.tw/slow', { timeout: 15001 }),
    /no greater than 15000ms/);
});

test('bounded page operations time out and later rejections stay observed', async () => {
  const lateRejection = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late rejection')), 10));
  await assert.rejects(withTimeout(lateRejection, 1, 'bounded fixture'), /exceeded 1ms/);
  await new Promise((resolve) => setTimeout(resolve, 15));
});
