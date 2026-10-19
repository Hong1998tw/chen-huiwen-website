const GEOMETRY_EPSILON = 0.25;

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
  }

  const reason = Date.now() >= deadline ? `exceeded ${timeoutMs}ms` : `exceeded ${maxSamples} samples`;
  const error = new Error(`${label}: UI did not become ready and geometrically stable (${reason}); last snapshot=${JSON.stringify(latest)}`);
  error.lastSnapshot = latest;
  throw error;
}
