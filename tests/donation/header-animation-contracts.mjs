import assert from 'node:assert/strict';

export const MENU_ANCHOR_TOLERANCE_PX = 0.75;

export function evaluateMenuAnchor(headerBottom, menuTop) {
  const expectedMenuTop = Math.ceil(headerBottom + 12);
  const anchorDelta = menuTop - expectedMenuTop;
  return {
    expectedMenuTop,
    anchorDelta,
    withinTolerance: Math.abs(anchorDelta) <= MENU_ANCHOR_TOLERANCE_PX,
  };
}

export function evaluateRequiredCheckGate(checks) {
  const requiredChecks = checks.filter(check => check.required === true);
  const pendingChecks = requiredChecks.filter(check => check.status === 'Pending').map(check => check.name);
  const nonPassingChecks = requiredChecks.filter(check => check.status !== 'Passed').map(check => check.name);
  const failedChecks = requiredChecks.filter(check => check.status !== 'Passed' && check.status !== 'Pending');
  return {
    status: failedChecks.length ? 'Failed' : pendingChecks.length ? 'Pending' : 'Passed',
    pendingChecks,
    nonPassingChecks,
    shouldExitNonZero: nonPassingChecks.length > 0,
  };
}

export function assertHeaderAnimationContractFixtures() {
  const requiredPending = evaluateRequiredCheckGate([
    { name: 'early header observation', required: true, status: 'Pending' },
  ]);
  assert.equal(requiredPending.status, 'Pending');
  assert.deepEqual(requiredPending.pendingChecks, ['early header observation']);
  assert.equal(requiredPending.shouldExitNonZero, true);

  const capturePending = evaluateRequiredCheckGate([
    { name: 'WCAG 2.2 AA target-size baseline', status: 'Pending' },
  ]);
  assert.equal(capturePending.status, 'Passed');
  assert.deepEqual(capturePending.pendingChecks, []);
  assert.equal(capturePending.shouldExitNonZero, false);

  const anchoredEndpoint = evaluateMenuAnchor(52.1, 65);
  assert.equal(anchoredEndpoint.expectedMenuTop, 65);
  assert.equal(anchoredEndpoint.anchorDelta, 0);
  assert.equal(anchoredEndpoint.withinTolerance, true);

  assert.equal(evaluateMenuAnchor(52.1, 65.75).withinTolerance, true);
  assert.equal(evaluateMenuAnchor(52.1, 65.751).withinTolerance, false);
}
