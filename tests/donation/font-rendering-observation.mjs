/** Capture and validate one complete, live viewport batch of visible Han text nodes. */
export function visibleHanObservationInPage(options) {
  const {
    action,
    attribute = 'data-font-render-check',
    registryKey = '__huiwenFontRenderObservation',
    markerPrefix = '',
    expectedRows = [],
  } = options;
  const pattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const rectKeys = ['left', 'top', 'right', 'bottom', 'width', 'height'];
  const viewport = { width: window.innerWidth, height: window.innerHeight };

  function directText(element) {
    return [...element.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent)
      .join(' ')
      .trim();
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect();
    return Object.fromEntries(rectKeys.map(key => [key, Number(rect[key])]));
  }

  function isVisibleHan(element, text) {
    if (!text || !pattern.test(text)) return false;
    if (element.closest('[aria-hidden="true"]')) return false;
    const closedDetails = element.closest('details:not([open])');
    if (closedDetails && !element.matches('summary')) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0
      && style.clipPath === 'none'
      && (style.clip === 'auto' || style.clip === 'none')
      && rect.width > 2
      && rect.height > 2
      && rect.bottom > 0
      && rect.top < viewport.height;
  }

  function publicRow(row) {
    return {
      index: row.index,
      marker: row.marker,
      tagName: row.tagName,
      id: row.id,
      textLength: row.directText.length,
      rect: row.rect,
      viewport: row.viewport,
    };
  }

  if (!markerPrefix) throw new Error('visible Han observation requires a unique marker prefix');

  if (action === 'capture') {
    if (window[registryKey]) {
      return { ok: false, reason: 'previous observation registry remains', rows: [], viewport };
    }
    const elements = [...document.querySelectorAll('body *')];
    const rows = [];
    window[registryKey] = { rows };
    for (const element of elements) {
      const text = directText(element);
      if (!isVisibleHan(element, text)) continue;
      const index = rows.length;
      const marker = `${markerPrefix}${index}`;
      const row = {
        element,
        index,
        marker,
        previousAttribute: element.getAttribute(attribute),
        tagName: element.tagName.toLowerCase(),
        id: element.id || '',
        directText: text,
        rect: rectOf(element),
        viewport,
      };
      element.setAttribute(attribute, marker);
      rows.push(row);
    }
    return {
      ok: true,
      candidateElementCount: elements.length,
      visibleHanCount: rows.length,
      viewport,
      rows: rows.map(publicRow),
    };
  }

  if (action === 'validate') {
    const registry = window[registryKey];
    const issues = {
      registryMissing: !registry,
      expectedRowCountMismatch: false,
      currentCoverageCountMismatch: false,
      missingRegistryIndices: [],
      disconnectedIndices: [],
      identityMismatchIndices: [],
      markerMismatchIndices: [],
      tagMismatchIndices: [],
      idMismatchIndices: [],
      textMismatchIndices: [],
      visibilityMismatchIndices: [],
      rectMismatchIndices: [],
      viewportMismatch: false,
      duplicateMarkerIndices: [],
      untrackedVisibleHanCount: 0,
    };
    const rows = registry?.rows || [];
    const elements = [...document.querySelectorAll('body *')];
    const eligible = elements.filter(element => isVisibleHan(element, directText(element)));
    const markerCounts = new Map();
    const elementsByMarker = new Map();
    for (const element of elements) {
      const marker = element.getAttribute(attribute);
      if (marker?.startsWith(markerPrefix)) {
        markerCounts.set(marker, (markerCounts.get(marker) || 0) + 1);
        const matches = elementsByMarker.get(marker) || [];
        matches.push(element);
        elementsByMarker.set(marker, matches);
      }
    }
    issues.expectedRowCountMismatch = rows.length !== expectedRows.length;
    issues.currentCoverageCountMismatch = eligible.length !== expectedRows.length;
    issues.viewportMismatch = expectedRows.some(row => row.viewport.width !== viewport.width
      || row.viewport.height !== viewport.height);
    const expectedMarkers = new Set(expectedRows.map(row => row.marker));
    issues.untrackedVisibleHanCount = eligible.filter(element =>
      !expectedMarkers.has(element.getAttribute(attribute))).length;

    for (const expected of expectedRows) {
      const saved = rows[expected.index];
      if (!saved) {
        issues.missingRegistryIndices.push(expected.index);
        continue;
      }
      const element = saved.element;
      const markerCount = markerCounts.get(expected.marker) || 0;
      if (markerCount > 1) issues.duplicateMarkerIndices.push(expected.index);
      if (!element.isConnected || element.ownerDocument !== document) {
        issues.disconnectedIndices.push(expected.index);
      }
      const currentMatches = elementsByMarker.get(expected.marker) || [];
      if (currentMatches.length !== 1 || currentMatches[0] !== element) {
        issues.identityMismatchIndices.push(expected.index);
      }
      if (element.getAttribute(attribute) !== expected.marker || saved.marker !== expected.marker) {
        issues.markerMismatchIndices.push(expected.index);
      }
      if (element.tagName.toLowerCase() !== expected.tagName || saved.tagName !== expected.tagName) {
        issues.tagMismatchIndices.push(expected.index);
      }
      if ((element.id || '') !== expected.id || saved.id !== expected.id) {
        issues.idMismatchIndices.push(expected.index);
      }
      const text = directText(element);
      if (text !== saved.directText || text.length !== expected.textLength) {
        issues.textMismatchIndices.push(expected.index);
      }
      if (!isVisibleHan(element, text)) issues.visibilityMismatchIndices.push(expected.index);
      const rect = rectOf(element);
      if (rectKeys.some(key => Math.abs(rect[key] - expected.rect[key]) > 0.5)) {
        issues.rectMismatchIndices.push(expected.index);
      }
    }

    const stable = !issues.registryMissing
      && !issues.expectedRowCountMismatch
      && !issues.currentCoverageCountMismatch
      && Object.entries(issues).every(([key, value]) => key === 'untrackedVisibleHanCount'
        ? value === 0
        : Array.isArray(value) ? value.length === 0 : value === false);
    return {
      stable,
      completeCoverage: stable,
      expectedCount: expectedRows.length,
      registeredCount: rows.length,
      currentVisibleHanCount: eligible.length,
      viewport,
      issues,
    };
  }

  if (action === 'cleanup') {
    const registry = window[registryKey];
    const rows = registry?.rows || [];
    const restoredIndices = [];
    const failedIndices = [];
    const registeredElements = new Set(rows.map(row => row.element));
    for (const row of rows) {
      try {
        if (row.element.getAttribute(attribute) === row.marker) {
          if (row.previousAttribute === null) row.element.removeAttribute(attribute);
          else row.element.setAttribute(attribute, row.previousAttribute);
        }
        restoredIndices.push(row.index);
      } catch {
        failedIndices.push(row.index);
      }
    }
    for (const element of [...document.querySelectorAll('body *')]) {
      const marker = element.getAttribute(attribute);
      if (marker?.startsWith(markerPrefix) && !registeredElements.has(element)) {
        try {
          element.removeAttribute(attribute);
        } catch {
          failedIndices.push(-1);
        }
      }
    }
    delete window[registryKey];
    const remainingMarkerCount = [...document.querySelectorAll('body *')]
      .filter(element => element.getAttribute(attribute)?.startsWith(markerPrefix)).length;
    return {
      clean: failedIndices.length === 0 && remainingMarkerCount === 0,
      restoredCount: restoredIndices.length,
      failedIndices,
      remainingMarkerCount,
      registryRemoved: !window[registryKey],
    };
  }

  throw new Error(`unknown visible Han observation action: ${String(action).slice(0, 40)}`);
}
