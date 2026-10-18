const sorted = (values) => [...values].sort();

function exactPaths(actual, expected) {
  return actual.length === expected.length && actual.every((path, index) => path === expected[index]);
}

export function verifyPageFontPreloadEvidence({
  route,
  expected,
  declared,
  observed,
  cdpRequests,
  fixedClock = false,
}) {
  const expectedPaths = sorted(expected);
  const declaredPaths = sorted(declared.map((item) => item.path));
  const observedPaths = sorted(observed);
  const cdpObserved = sorted(cdpRequests
    .filter((item) => item.requestType === 'Font' && item.isMainFrame && item.phase === 'initial')
    .map((item) => item.path));
  const domMatchesExpected = exactPaths(declaredPaths, expectedPaths);
  const resourceTimingMatchesExpected = exactPaths(observedPaths, expectedPaths);
  const cdpMatchesExpected = exactPaths(cdpObserved, expectedPaths);
  const resourceTimingClearedByFixedClock = route === 'service.html'
    && fixedClock && observed.length === 0;
  const serviceRouteNeedsCdp = route === 'service.html';
  const valid = domMatchesExpected
    && (resourceTimingMatchesExpected
      || (resourceTimingClearedByFixedClock && cdpMatchesExpected))
    && (!serviceRouteNeedsCdp || cdpMatchesExpected);

  let verification = 'invalid';
  if (valid && resourceTimingClearedByFixedClock) verification = 'cdp-font-events';
  else if (valid && serviceRouteNeedsCdp) verification = 'resource-timing-and-cdp-font-events';
  else if (valid) verification = 'resource-timing';

  return {
    valid,
    verification,
    domMatchesExpected,
    resourceTimingMatchesExpected,
    cdpMatchesExpected,
    resourceTimingClearedByFixedClock,
    cdpObserved,
  };
}
