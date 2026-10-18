/** Controlled, reversible diagnostics for the known 390px / 200% news-heading overflow case. */

const COMPUTED_PROPERTIES = [
  'display', 'white-space', 'word-break', 'overflow-wrap', 'line-break', 'text-wrap',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
  'font-feature-settings', 'font-kerning', 'letter-spacing', 'word-spacing', 'line-height',
  'width', 'max-width', 'min-width', 'inline-size', 'max-inline-size', 'min-inline-size',
  'box-sizing', 'text-indent', 'text-transform', 'direction', 'unicode-bidi', 'writing-mode',
  'hyphens', 'overflow-x', 'text-overflow'
];

const PROBE_OVERRIDES = [
  { property: 'overflow-wrap', value: 'anywhere' },
  { property: 'word-break', value: 'break-all' },
  { property: 'line-break', value: 'anywhere' },
  { property: 'text-wrap', value: 'wrap' }
];

const MAX_TEXT_NODES = 80;
const MAX_CODE_POINTS = 2000;
const MAX_RANGE_FRAGMENTS = 24;
const MAX_RULE_CANDIDATES = 160;
const GEOMETRY_EPSILON = 0.5;

/** Return Unicode codepoint offsets alongside the UTF-16 offsets required by DOM Range. */
export function codePointOffsets(value, maxCodePoints = Number.POSITIVE_INFINITY) {
  const result = [];
  let utf16Offset = 0;
  let codePointOffset = 0;
  for (const character of String(value)) {
    if (result.length >= maxCodePoints) break;
    const utf16Start = utf16Offset;
    utf16Offset += character.length;
    const codePoint = character.codePointAt(0);
    result.push({
      codePointOffset,
      utf16Start,
      utf16End: utf16Offset,
      codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
      character
    });
    codePointOffset += 1;
  }
  return result;
}

/** Classify a Range rectangle against both the viewport and its heading frame. */
export function classifyOverflowRect(rect, { viewportWidth, headingLeft, headingRight }, epsilon = GEOMETRY_EPSILON) {
  return {
    outsideViewportLeft: rect.left < -epsilon,
    outsideViewportRight: rect.right > viewportWidth + epsilon,
    outsideHeadingLeft: rect.left < headingLeft - epsilon,
    outsideHeadingRight: rect.right > headingRight + epsilon
  };
}

/** Require both document overflow and evidence that the selected heading itself overflows. */
export function isActualOverflowingHeading({
  documentScrollWidth,
  documentClientWidth,
  headingScrollWidth,
  headingClientWidth,
  rangeOverflowCount = 0
}) {
  const documentOverflows = documentScrollWidth > documentClientWidth + 1;
  const headingOverflows = headingScrollWidth > headingClientWidth + 1 || rangeOverflowCount > 0;
  return { documentOverflows, headingOverflows, eligible: documentOverflows && headingOverflows };
}

/** Snapshot and restore the full style attribute without leaving a diagnostic declaration behind. */
export function captureInlineStyleAttribute(element) {
  return element.getAttribute('style');
}

export function restoreInlineStyleAttribute(element, originalAttribute) {
  if (originalAttribute === null) element.removeAttribute('style');
  else element.setAttribute('style', originalAttribute);
}

export function inlineStyleAttributeMatches(element, originalAttribute) {
  return element.getAttribute('style') === originalAttribute;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function rectSnapshot(rect) {
  return {
    left: round(rect.left), right: round(rect.right), top: round(rect.top), bottom: round(rect.bottom),
    width: round(rect.width), height: round(rect.height)
  };
}

function selectorLabel(element) {
  const tag = element.localName || element.tagName?.toLowerCase() || 'element';
  const id = element.id ? `#${String(element.id).slice(0, 80)}` : '';
  const classes = [...(element.classList || [])].slice(0, 4).map(name => `.${String(name).slice(0, 60)}`).join('');
  const sameTagSiblings = element.parentElement
    ? [...element.parentElement.children].filter(sibling => sibling.localName === element.localName)
    : [];
  const index = sameTagSiblings.length > 1 ? `:nth-of-type(${sameTagSiblings.indexOf(element) + 1})` : '';
  return `${tag}${id}${classes}${index}`;
}

function computedSnapshot(element) {
  const style = getComputedStyle(element);
  const values = {};
  for (const property of COMPUTED_PROPERTIES) values[property] = style.getPropertyValue(property);
  return values;
}

function diagnosticElements(heading) {
  const elements = [{ element: heading, role: 'heading' }];
  for (const child of heading.children) {
    if (getComputedStyle(child).display.startsWith('inline')) elements.push({ element: child, role: 'direct-inline-child' });
  }
  return elements.map(({ element, role }) => ({ element, role, selector: selectorLabel(element) }));
}

function captureState(heading, headingSelector) {
  const root = document.documentElement;
  const body = document.body;
  const rect = heading.getBoundingClientRect();
  const elements = diagnosticElements(heading);
  return {
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    rootFontSize: getComputedStyle(root).fontSize,
    document: {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      bodyScrollWidth: body?.scrollWidth ?? null,
      bodyClientWidth: body?.clientWidth ?? null
    },
    heading: {
      selector: headingSelector,
      rect: rectSnapshot(rect),
      scrollWidth: heading.scrollWidth,
      clientWidth: heading.clientWidth,
      computed: elements.map(({ element, role, selector }) => ({ role, selector, values: computedSnapshot(element) }))
    }
  };
}

function deltaState(before, after) {
  const rectDelta = {};
  for (const key of ['left', 'right', 'top', 'bottom', 'width', 'height']) {
    rectDelta[key] = round(after.heading.rect[key] - before.heading.rect[key]);
  }
  return {
    documentScrollWidth: after.document.scrollWidth - before.document.scrollWidth,
    documentClientWidth: after.document.clientWidth - before.document.clientWidth,
    bodyScrollWidth: after.document.bodyScrollWidth === null || before.document.bodyScrollWidth === null
      ? null : after.document.bodyScrollWidth - before.document.bodyScrollWidth,
    bodyClientWidth: after.document.bodyClientWidth === null || before.document.bodyClientWidth === null
      ? null : after.document.bodyClientWidth - before.document.bodyClientWidth,
    headingScrollWidth: after.heading.scrollWidth - before.heading.scrollWidth,
    headingClientWidth: after.heading.clientWidth - before.heading.clientWidth,
    headingRect: rectDelta
  };
}

function textSnippet(points, codePointOffset, radius = 10) {
  return points.slice(Math.max(0, codePointOffset - radius), Math.min(points.length, codePointOffset + radius + 1))
    .map(point => point.character).join('').replace(/\s+/g, ' ');
}

function scanHeadingRanges(heading, headingRect) {
  const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
  const fragments = [];
  let textNodeCount = 0;
  let codePointCount = 0;
  let truncated = false;
  let textNode = walker.nextNode();
  while (textNode) {
    if (textNodeCount >= MAX_TEXT_NODES || codePointCount >= MAX_CODE_POINTS) {
      truncated = true;
      break;
    }
    const nodeIndex = textNodeCount;
    textNodeCount += 1;
    const value = textNode.nodeValue || '';
    const remainingCodePoints = MAX_CODE_POINTS - codePointCount;
    const offsets = codePointOffsets(value, remainingCodePoints);
    if ((offsets.at(-1)?.utf16End ?? 0) < value.length) truncated = true;
    const headingCodePointBase = codePointCount;
    const nodeFragments = [];
    for (const point of offsets) {
      codePointCount += 1;
      const range = document.createRange();
      range.setStart(textNode, point.utf16Start);
      range.setEnd(textNode, point.utf16End);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 || rect.height > 0);
      const classifiedRects = rects.map(rect => ({
        rect: rectSnapshot(rect),
        flags: classifyOverflowRect(rect, {
          viewportWidth: innerWidth,
          headingLeft: headingRect.left,
          headingRight: headingRect.right
        })
      })).filter(item => Object.values(item.flags).some(Boolean));
      if (!classifiedRects.length) continue;
      nodeFragments.push({
        nodeIndex,
        codePointStart: point.codePointOffset,
        codePointEnd: point.codePointOffset + 1,
        headingCodePointStart: headingCodePointBase + point.codePointOffset,
        headingCodePointEnd: headingCodePointBase + point.codePointOffset + 1,
        utf16Start: point.utf16Start,
        utf16End: point.utf16End,
        textFragment: point.character,
        context: textSnippet(offsets, point.codePointOffset),
        codePoints: [point.codePoint],
        rects: classifiedRects
      });
    }
    fragments.push(...nodeFragments);
    textNode = walker.nextNode();
  }

  const groups = [];
  for (const fragment of fragments) {
    const previous = groups.at(-1);
    const previousRect = previous?.rects.at(-1)?.rect;
    const currentRect = fragment.rects[0]?.rect;
    const sameLine = previousRect && currentRect && Math.abs(previousRect.top - currentRect.top) <= 2;
    if (previous && previous.nodeIndex === fragment.nodeIndex && previous.codePointEnd === fragment.codePointStart && sameLine) {
      previous.codePointEnd = fragment.codePointEnd;
      previous.utf16End = fragment.utf16End;
      previous.textFragment += fragment.textFragment;
      previous.codePoints.push(...fragment.codePoints);
      previous.rects.push(...fragment.rects);
      previous.context = fragment.context;
    } else {
      groups.push({ ...fragment });
    }
  }

  return {
    textNodeCount,
    codePointCount,
    truncated,
    inspectedCodepointOffsetUnit: 'Unicode code points; utf16Start/End are supplied for DOM Range.',
    fragments: groups.slice(0, MAX_RANGE_FRAGMENTS),
    fragmentsTruncated: groups.length > MAX_RANGE_FRAGMENTS
  };
}

function stylesheetMediaState(mediaText, disabled = false) {
  const condition = String(mediaText || '').trim() || 'all';
  let matches = null;
  try {
    matches = matchMedia(condition).matches;
  } catch {
    // Keep unsupported or malformed media states explicit rather than guessing.
  }
  if (disabled) matches = false;
  return { condition, matches, disabled };
}

function conditionState(rule) {
  const type = rule.constructor?.name || `CSSRule(${rule.type})`;
  const condition = String(rule.conditionText || '').trim() || null;
  let active = null;
  let evaluation = 'unknown';
  if (type === 'CSSMediaRule' && condition) {
    try { active = matchMedia(condition).matches; evaluation = 'matchMedia'; } catch { /* keep unknown */ }
  } else if (type === 'CSSSupportsRule' && condition && typeof globalThis.CSS?.supports === 'function') {
    try { active = globalThis.CSS.supports(condition); evaluation = 'CSS.supports'; } catch { /* keep unknown */ }
  }
  return { type, condition, active, evaluation };
}

function sheetSource(sheet, sheetIndex, importIndex = null) {
  const href = sheet.href;
  if (href) {
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;
      return { url: `${url.origin}${url.pathname}`, kind: 'same-origin-stylesheet', sheetIndex, importIndex };
    } catch {
      return null;
    }
  }
  const owner = sheet.ownerNode;
  if (owner?.localName === 'style') {
    return { url: `${location.origin}${location.pathname}#style-sheet-${sheetIndex}`, kind: 'same-origin-inline-stylesheet', sheetIndex, importIndex };
  }
  if (!owner) {
    return { url: `${location.origin}${location.pathname}#constructed-style-sheet-${sheetIndex}`, kind: 'same-origin-constructed-stylesheet', sheetIndex, importIndex };
  }
  return null;
}

function relevantDeclarations(style) {
  const declarations = {};
  for (const property of COMPUTED_PROPERTIES) {
    const value = style.getPropertyValue(property);
    if (value) declarations[property] = { value, priority: style.getPropertyPriority(property) || '' };
  }
  return declarations;
}

function collectAuthorRuleCandidates(elements) {
  const candidates = [];
  const inaccessible = [];
  let truncated = false;
  const append = candidate => {
    if (candidates.length >= MAX_RULE_CANDIDATES) {
      truncated = true;
      return;
    }
    candidates.push(candidate);
  };

  for (const entry of elements) {
    const declarations = relevantDeclarations(entry.element.style);
    if (Object.keys(declarations).length) {
      append({
        candidateOnly: true,
        sourceKind: 'inline-style-attribute',
        sourceUrl: `${location.origin}${location.pathname}`,
        selector: '[style attribute]',
        matchedElement: entry.selector,
        order: { kind: 'inline declaration order', sheetIndex: null, ruleOrder: null, declarationNames: Object.keys(declarations) },
        mediaState: { condition: 'element inline style', matches: true },
        declarations
      });
    }
  }

  function walkRules(rules, source, sheetMedia, conditions, path, orderCounter) {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      const rulePath = [...path, index];
      if (typeof rule.selectorText === 'string' && rule.style) {
        orderCounter.value += 1;
        const declarations = relevantDeclarations(rule.style);
        if (!Object.keys(declarations).length) continue;
        for (const entry of elements) {
          let matches = false;
          try { matches = entry.element.matches(rule.selectorText); } catch { /* invalid or unsupported selector */ }
          if (!matches) continue;
          append({
            candidateOnly: true,
            sourceKind: source.kind,
            sourceUrl: source.url,
            selector: String(rule.selectorText).slice(0, 500),
            matchedElement: entry.selector,
            order: {
              stylesheetIndex: source.sheetIndex,
              ruleOrder: orderCounter.value,
              nestedRulePath: rulePath,
              importIndex: source.importIndex
            },
            mediaState: { stylesheet: sheetMedia, conditions },
            declarations
          });
        }
        continue;
      }

      if (rule.styleSheet) {
        const importedSource = sheetSource(rule.styleSheet, source.sheetIndex, index);
        if (!importedSource) continue;
        try {
          const importedMedia = stylesheetMediaState(rule.styleSheet.media?.mediaText, rule.styleSheet.disabled);
          walkRules(rule.styleSheet.cssRules, importedSource, importedMedia, conditions, [], { value: 0 });
        } catch (error) {
          inaccessible.push({ sourceUrl: importedSource.url, reason: String(error).slice(0, 240) });
        }
        continue;
      }

      if (rule.cssRules) {
        const nestedCondition = conditionState(rule);
        try { walkRules(rule.cssRules, source, sheetMedia, [...conditions, nestedCondition], rulePath, orderCounter); }
        catch (error) { inaccessible.push({ sourceUrl: source.url, nestedRulePath: rulePath, reason: String(error).slice(0, 240) }); }
      }
    }
  }

  for (let sheetIndex = 0; sheetIndex < document.styleSheets.length; sheetIndex += 1) {
    const sheet = document.styleSheets[sheetIndex];
    const source = sheetSource(sheet, sheetIndex);
    if (!source) continue;
    try {
      const media = stylesheetMediaState(sheet.media?.mediaText, sheet.disabled);
      walkRules(sheet.cssRules, source, media, [], [], { value: 0 });
    } catch (error) {
      inaccessible.push({ sourceUrl: source.url, reason: String(error).slice(0, 240) });
    }
  }

  return {
    cascadeWinnerResolved: false,
    explanation: 'These are matching author-rule candidates in observed source order. Specificity, layers, inheritance, importance, and all cascade interactions are not resolved here.',
    count: candidates.length,
    truncated,
    candidates,
    inaccessible
  };
}

function runNewsArticleOverflowProbe() {
  const heading = document.querySelector('main#main .page-head h1');
  if (!heading) return { schema: 'news-article-overflow-probe/v1', eligible: false, reason: 'news-page-heading-not-found' };

  const headingSelector = selectorLabel(heading);
  const headingRect = heading.getBoundingClientRect();
  const rangeScan = scanHeadingRanges(heading, headingRect);
  const rangeOverflowCount = rangeScan.fragments.reduce((count, fragment) => count + fragment.codePoints.length, 0);
  const baseline = captureState(heading, headingSelector);
  const eligibility = isActualOverflowingHeading({
    documentScrollWidth: baseline.document.scrollWidth,
    documentClientWidth: baseline.document.clientWidth,
    headingScrollWidth: baseline.heading.scrollWidth,
    headingClientWidth: baseline.heading.clientWidth,
    rangeOverflowCount
  });

  const base = {
    schema: 'news-article-overflow-probe/v1',
    scope: 'news article h1 at the existing 390px viewport and 200% root text-size case',
    eligibility: { ...eligibility, viewportWidth: baseline.viewport.width, rootFontSize: baseline.rootFontSize },
    baseline: {
      ...baseline,
      rangeScan: eligibility.eligible ? rangeScan : { inspected: false, reason: 'Only report text fragments for an actually overflowing news h1.' }
    },
    overrideProbes: [],
    exploratoryOnly: true,
    changesOriginalOverflowCriterion: false,
    claimsFix: false
  };
  if (!eligibility.eligible) {
    return {
      ...base,
      sourceCandidates: { inspected: false },
      restoration: { required: false, reason: 'No document overflow attributable to the news h1; no style override was applied.' }
    };
  }

  const elements = diagnosticElements(heading);
  base.sourceCandidates = collectAuthorRuleCandidates(elements);
  const originalStyleAttribute = captureInlineStyleAttribute(heading);
  const originalState = captureState(heading, headingSelector);
  const perProbeRestoration = [];

  try {
    for (const candidate of PROBE_OVERRIDES) {
      const result = {
        ...candidate,
        priority: 'important',
        supported: typeof globalThis.CSS?.supports === 'function'
          ? globalThis.CSS.supports(candidate.property, candidate.value) : null,
        before: null,
        after: null,
        delta: null,
        inlineValueAfterSet: null,
        inlinePriorityAfterSet: null,
        computedValueAfter: null,
        error: null
      };
      try {
        restoreInlineStyleAttribute(heading, originalStyleAttribute);
        result.before = captureState(heading, headingSelector);
        heading.style.setProperty(candidate.property, candidate.value, 'important');
        result.inlineValueAfterSet = heading.style.getPropertyValue(candidate.property);
        result.inlinePriorityAfterSet = heading.style.getPropertyPriority(candidate.property);
        result.after = captureState(heading, headingSelector);
        result.computedValueAfter = getComputedStyle(heading).getPropertyValue(candidate.property);
        result.delta = deltaState(result.before, result.after);
      } catch (error) {
        result.error = String(error).slice(0, 400);
      } finally {
        restoreInlineStyleAttribute(heading, originalStyleAttribute);
        const restored = captureState(heading, headingSelector);
        perProbeRestoration.push({
          property: candidate.property,
          styleAttributeRestoredExactly: inlineStyleAttributeMatches(heading, originalStyleAttribute),
          geometryAndComputedRestoredExactly: JSON.stringify(restored) === JSON.stringify(originalState)
        });
      }
      base.overrideProbes.push(result);
    }
  } finally {
    restoreInlineStyleAttribute(heading, originalStyleAttribute);
  }

  const finalState = captureState(heading, headingSelector);
  base.restoration = {
    required: true,
    originalStyleAttributePresent: originalStyleAttribute !== null,
    originalStyleAttributeLength: originalStyleAttribute?.length ?? 0,
    styleAttributeRestoredExactly: inlineStyleAttributeMatches(heading, originalStyleAttribute),
    geometryAndComputedRestoredExactly: JSON.stringify(finalState) === JSON.stringify(originalState),
    allPerProbeRestorationsExact: perProbeRestoration.length === PROBE_OVERRIDES.length &&
      perProbeRestoration.every(item => item.styleAttributeRestoredExactly && item.geometryAndComputedRestoredExactly),
    perProbe: perProbeRestoration,
    finalState
  };
  return base;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__g04NewsArticleOverflowProbe', {
    configurable: true,
    value: Object.freeze({ run: runNewsArticleOverflowProbe })
  });
}
