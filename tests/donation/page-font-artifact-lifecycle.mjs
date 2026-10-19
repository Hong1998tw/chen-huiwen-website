import assert from 'node:assert/strict';

export function observePendingResult(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', error }),
  );
}

export function withTimeout(promise, timeoutMs, label = 'operation') {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, `${label}: timeout must be finite and positive`);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

export async function gotoObservedWithTimeout(page, url, {
  timeout = 15000,
  waitUntil = 'domcontentloaded',
} = {}) {
  assert.ok(Number.isFinite(timeout) && timeout > 0 && timeout <= 15000,
    'navigation timeout must be finite and no greater than 15000ms');
  const outcome = observePendingResult(page.goto(url, { timeout, waitUntil }));
  return requireObservedValue(await withTimeout(outcome, timeout, `page.goto ${url}`));
}

export function preservePrimaryError(primaryError, nextError) {
  if (!primaryError) return { primaryError: nextError, secondaryError: null };
  return { primaryError, secondaryError: primaryError === nextError ? null : nextError };
}

export function requireObservedValue(outcome) {
  if (outcome.status === 'rejected') throw outcome.error;
  return outcome.value;
}
