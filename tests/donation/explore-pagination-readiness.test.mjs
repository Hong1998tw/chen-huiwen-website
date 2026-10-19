import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasStableExplorePaginationGeometry,
  isExplorePaginationPageReady,
  isExplorePaginationTargetReady,
  observeExplorePaginationAction,
  waitForStableExplorePaginationSnapshot,
} from './explore-pagination-readiness.mjs';

function rect(top, left = 16, width = 360, height = 44) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function snapshot({ scrollY = 520, targetTop = 120, headerTop = 0, fontStatus = 'loaded', page = 1, count = 10, headingFocused = false } = {}) {
  return {
    viewport: { width: 1440, height: 960 },
    scroll: { x: 0, y: scrollY },
    target: { page: 6, found: true, disabled: false, visible: true, box: rect(targetTop, 100, 48, 44) },
    heading: { focused: headingFocused, withinViewport: true, box: rect(16) },
    header: { box: rect(headerTop, 0, 1440, 64) },
    fonts: { status: fontStatus },
    url: { path: '/explore.html', page },
    currentPage: page,
    results: { count },
  };
}

test('pointer target readiness requires loaded fonts and the full target inside the viewport', () => {
  assert.equal(isExplorePaginationTargetReady(snapshot(), 6), true);
  assert.equal(isExplorePaginationTargetReady(snapshot({ fontStatus: 'loading' }), 6), false);
  assert.equal(isExplorePaginationTargetReady(snapshot({ targetTop: 940 }), 6), false);
  const smallTarget = snapshot();
  smallTarget.target.box = rect(120, 100, 40, 40);
  assert.equal(isExplorePaginationTargetReady(smallTarget, 6), false);
});

test('post-click readiness requires the URL page, result count, visible heading focus, and loaded fonts', () => {
  assert.equal(isExplorePaginationPageReady(snapshot({ page: 6, headingFocused: true }), 6, 10), true);
  assert.equal(isExplorePaginationPageReady(snapshot({ page: 5, headingFocused: true }), 6, 10), false);
  assert.equal(isExplorePaginationPageReady(snapshot({ page: 6, headingFocused: false }), 6, 10), false);
  assert.equal(isExplorePaginationPageReady(snapshot({ page: 6, count: 9, headingFocused: true }), 6, 10), false);
});

test('geometry stability includes scrolling, target, heading, sticky header, and fonts', () => {
  const settled = snapshot();
  assert.equal(hasStableExplorePaginationGeometry(settled, snapshot({ targetTop: 120.1 })), true);
  assert.equal(hasStableExplorePaginationGeometry(settled, snapshot({ scrollY: 519 })), false);
  assert.equal(hasStableExplorePaginationGeometry(settled, snapshot({ headerTop: 1 })), false);
  assert.equal(hasStableExplorePaginationGeometry(settled, snapshot({ fontStatus: 'loading' })), false);
});

test('bounded readiness waits through a smooth-scroll and header-layout transition', async () => {
  const samples = [
    snapshot({ scrollY: 400, targetTop: 360, headerTop: 2 }),
    snapshot({ scrollY: 470, targetTop: 290, headerTop: 1 }),
    snapshot({ scrollY: 520, targetTop: 120, headerTop: 0 }),
    snapshot({ scrollY: 520, targetTop: 120, headerTop: 0 }),
    snapshot({ scrollY: 520, targetTop: 120, headerTop: 0 }),
  ];
  let index = 0;
  const ready = await waitForStableExplorePaginationSnapshot(
    async () => samples[Math.min(index++, samples.length - 1)],
    state => isExplorePaginationTargetReady(state, 6),
    { timeoutMs: 250, stableSamples: 3 },
  );

  assert.equal(index, 5);
  assert.equal(ready.scroll.y, 520);
  assert.equal(ready.header.box.top, 0);
});

test('bounded readiness spaces synchronous snapshots on the host clock without animation frames', async () => {
  const sampleTimes = [];
  const ready = await waitForStableExplorePaginationSnapshot(
    () => {
      sampleTimes.push(process.hrtime.bigint());
      return snapshot({ page: 6, headingFocused: true });
    },
    state => isExplorePaginationPageReady(state, 6, 10),
    { timeoutMs: 250, stableSamples: 3 },
  );

  assert.equal(sampleTimes.length, 3);
  assert.equal(ready.currentPage, 6);
  for (let index = 1; index < sampleTimes.length; index += 1) {
    const elapsedMs = Number(sampleTimes[index] - sampleTimes[index - 1]) / 1e6;
    assert(elapsedMs >= 20, `host polling interval must be real, got ${elapsedMs.toFixed(2)}ms`);
  }
});

test('bounded readiness returns a sanitized last snapshot when geometry never settles', async () => {
  let scrollY = 0;
  await assert.rejects(
    waitForStableExplorePaginationSnapshot(
      async () => snapshot({ scrollY: scrollY++ }),
      state => isExplorePaginationTargetReady(state, 6),
      { timeoutMs: 250, maxSamples: 6, stableSamples: 3, label: 'page 6 target' },
    ),
    error => error.lastSnapshot?.scroll?.y === 5
      && /page 6 target: UI did not become ready and geometrically stable/.test(error.message),
  );
});

test('bounded readiness also ends when a frame snapshot never returns', async () => {
  await assert.rejects(
    waitForStableExplorePaginationSnapshot(() => new Promise(() => {}), () => false, {
      timeoutMs: 15,
      label: 'frame fixture',
    }),
    error => /frame fixture: snapshot timed out/.test(error.message),
  );
});

test('scroll action observation samples geometry while the native action is pending', async () => {
  let actionActive = false;
  const { value, observation } = await observeExplorePaginationAction(
    async () => {
      actionActive = true;
      await new Promise(resolve => setTimeout(resolve, 45));
      actionActive = false;
      return 'scrolled';
    },
    () => ({ actionActive }),
    { sampleTimesMs: [0, 10, 25, 60] },
  );

  assert.equal(value, 'scrolled');
  assert.equal(observation.outcome, 'fulfilled');
  assert(observation.elapsedMs >= 35);
  assert(observation.samples.length >= 2);
  assert(observation.samples.length <= 3);
  assert(observation.samples.every(sample => sample.snapshot.actionActive));
});

test('scroll action rejection carries its bounded time series', async () => {
  const failure = new Error('native action failed');
  await assert.rejects(
    observeExplorePaginationAction(
      async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        throw failure;
      },
      () => ({ visible: true }),
      { sampleTimesMs: [0, 5, 15, 40] },
    ),
    error => error === failure
      && error.explorePaginationObservation?.outcome === 'rejected'
      && error.explorePaginationObservation.samples.length >= 2
      && error.explorePaginationObservation.samples.length <= 3,
  );
});

test('scroll action observation caps sample count and does not add an action deadline', async () => {
  let finish;
  const action = new Promise(resolve => { finish = resolve; });
  const observed = observeExplorePaginationAction(
    () => action,
    () => ({ visible: true }),
    { sampleTimesMs: Array(12).fill(0) },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  finish('done');
  const { value, observation } = await observed;

  assert.equal(value, 'done');
  assert.equal(observation.samples.length, 8);
});

test('scroll action observation redacts failed snapshot details without replacing action success', async () => {
  const { value, observation } = await observeExplorePaginationAction(
    async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return 'done';
    },
    async () => { throw new Error('failed https://example.test/path?token=secret cookie=private'); },
    { sampleTimesMs: [0, 5, 15, 40] },
  );

  assert.equal(value, 'done');
  const errors = observation.samples.map(sample => sample.snapshotError).filter(Boolean);
  assert(errors.length >= 1);
  assert(errors.every(error => !error.includes('secret') && !error.includes('private')));
});
