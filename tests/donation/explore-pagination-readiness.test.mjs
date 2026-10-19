import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasStableExplorePaginationGeometry,
  isExplorePaginationPageReady,
  isExplorePaginationTargetReady,
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

test('bounded readiness returns a sanitized last snapshot when geometry never settles', async () => {
  let scrollY = 0;
  await assert.rejects(
    waitForStableExplorePaginationSnapshot(
      async () => snapshot({ scrollY: scrollY++ }),
      state => isExplorePaginationTargetReady(state, 6),
      { timeoutMs: 50, maxSamples: 6, stableSamples: 3, label: 'page 6 target' },
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
