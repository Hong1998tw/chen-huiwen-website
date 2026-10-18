export function observePendingResult(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', error }),
  );
}

export function preservePrimaryError(primaryError, nextError) {
  if (!primaryError) return { primaryError: nextError, secondaryError: null };
  return { primaryError, secondaryError: primaryError === nextError ? null : nextError };
}

export function requireObservedValue(outcome) {
  if (outcome.status === 'rejected') throw outcome.error;
  return outcome.value;
}
