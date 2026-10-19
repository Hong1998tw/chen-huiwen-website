const GEOMETRY_EPSILON = 0.25;
const SNAPSHOT_POLL_INTERVAL_MS = 30;
const DEFAULT_ACTION_SAMPLE_TIMES_MS = [0, 100, 250, 500, 1000, 2000];
const MAX_ACTION_SAMPLES = 8;

function diagnosticError(error) {
  const name = String(error?.name || 'Error').slice(0, 80);
  const message = String(error?.message || error || 'unknown error').slice(0, 240)
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => url.replace(/[?#].*$/, ''))
    .replace(/\b(token|session|cookie|authorization|csrf|state|code|key)\s*[:=]\s*[^\s,;&]+/gi, '$1=[redacted]')
    .replace(/([?&](?:token|session|cookie|authorization|csrf|state|code|key)=)[^&#\s]*/gi, '$1[redacted]');
  return `${name}: ${message}`;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function sameNumber(left, right) {
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= GEOMETRY_EPSILON;
}

function sameRect(left, right) {
  return Boolean(left && right)
    && ['left', 'top', 'right', 'bottom', 'width', 'height']
      .every(key => sameNumber(left[key], right[key]));
}

export function isExplorePaginationTargetReady(snapshot, pageNumber) {
  const target = snapshot?.target;
  const box = target?.box;
  const viewport = snapshot?.viewport;
  return snapshot?.fonts?.status === 'loaded'
    && target?.page === pageNumber
    && target.found === true
    && target.disabled === false
    && target.visible === true
    && box?.width >= 44
    && box?.height >= 44
    && box.left >= 0
    && box.top >= 0
    && box.right <= viewport?.width
    && box.bottom <= viewport?.height;
}

export function isExplorePaginationPageReady(snapshot, pageNumber, expectedCount) {
  return snapshot?.fonts?.status === 'loaded'
    && snapshot?.url?.page === pageNumber
    && snapshot?.currentPage === pageNumber
    && snapshot?.results?.count === expectedCount
    && snapshot?.heading?.focused === true
    && snapshot.heading.withinViewport === true;
}

export function hasStableExplorePaginationGeometry(previous, current) {
  return Boolean(previous && current)
    && previous.viewport?.width === current.viewport?.width
    && previous.viewport?.height === current.viewport?.height
    && sameNumber(previous.scroll?.x, current.scroll?.x)
    && sameNumber(previous.scroll?.y, current.scroll?.y)
    && sameRect(previous.target?.box, current.target?.box)
    && sameRect(previous.heading?.box, current.heading?.box)
    && sameRect(previous.header?.box, current.header?.box)
    && previous.fonts?.status === current.fonts?.status
    && previous.results?.count === current.results?.count;
}

export async function observeExplorePaginationAction(action, readSnapshot, {
  sampleTimesMs = DEFAULT_ACTION_SAMPLE_TIMES_MS,
  snapshotTimeoutMs = 750,
} = {}) {
  const offsets = [...sampleTimesMs]
    .filter(value => Number.isFinite(value) && value >= 0)
    .slice(0, MAX_ACTION_SAMPLES);
  const startedAt = Date.now();
  let actionSettled = false;
  const actionPromise = Promise.resolve().then(action).then(
    value => {
      actionSettled = true;
      return { status: 'fulfilled', value };
    },
    error => {
      actionSettled = true;
      return { status: 'rejected', error };
    },
  );
  const samples = [];

  for (const offsetMs of offsets) {
    if (actionSettled) break;
    const waitMs = Math.max(0, startedAt + offsetMs - Date.now());
    if (waitMs > 0) await delay(waitMs);
    if (actionSettled) break;

    let timer;
    const snapshotAttempt = Promise.resolve().then(readSnapshot).then(
      snapshot => ({ type: 'snapshot', snapshot }),
      error => ({ type: 'snapshot-error', error }),
    );
    const outcome = await Promise.race([
      snapshotAttempt,
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ type: 'snapshot-timeout' }), snapshotTimeoutMs);
      }),
      actionPromise.then(result => ({ type: 'action-settled', result })),
    ]);
    clearTimeout(timer);

    if (outcome.type === 'action-settled') break;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    if (outcome.type === 'snapshot') {
      samples.push({ elapsedMs, snapshot: outcome.snapshot });
    } else {
      const message = outcome.type === 'snapshot-timeout'
        ? `snapshot exceeded ${snapshotTimeoutMs}ms`
        : diagnosticError(outcome.error);
      samples.push({ elapsedMs, snapshotError: message });
    }
  }

  const settled = await actionPromise;
  const observation = {
    outcome: settled.status,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    samples,
  };
  if (settled.status === 'rejected') {
    const error = settled.error instanceof Error ? settled.error : new Error(diagnosticError(settled.error));
    error.explorePaginationObservation = observation;
    throw error;
  }
  return { value: settled.value, observation };
}

export async function waitForStableExplorePaginationSnapshot(readSnapshot, isReady, {
  label = 'Explore pagination',
  timeoutMs = 2500,
  stableSamples = 3,
  maxSamples = 180,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let latest = null;
  let readySamples = 0;
  let sampleCount = 0;

  while (sampleCount < maxSamples && Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    let timer;
    try {
      latest = await Promise.race([
        Promise.resolve().then(readSnapshot),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}: snapshot timed out`)), remainingMs);
        }),
      ]);
    } catch (error) {
      error.lastSnapshot = latest;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    sampleCount += 1;

    if (isReady(latest)) {
      readySamples = previous && hasStableExplorePaginationGeometry(previous, latest)
        ? readySamples + 1
        : 1;
      if (readySamples >= stableSamples) return latest;
    } else {
      readySamples = 0;
    }
    previous = latest;

    if (sampleCount < maxSamples && Date.now() < deadline) {
      const remainingMs = Math.max(0, deadline - Date.now());
      await new Promise(resolve => setTimeout(resolve, Math.min(SNAPSHOT_POLL_INTERVAL_MS, remainingMs)));
    }
  }

  const reason = Date.now() >= deadline ? `exceeded ${timeoutMs}ms` : `exceeded ${maxSamples} samples`;
  const error = new Error(`${label}: UI did not become ready and geometrically stable (${reason}); last snapshot=${JSON.stringify(latest)}`);
  error.lastSnapshot = latest;
  throw error;
}
