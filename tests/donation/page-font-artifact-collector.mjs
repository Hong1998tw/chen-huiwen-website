import { withTimeout } from './page-font-artifact-lifecycle.mjs';
import { INITIAL_RENDER_TIMEOUT_MS } from './page-font-artifact-network-gate.mjs';
import {
  buildExpectedPageFonts,
  classifyVisibleGlyphDiagnostics,
  SYSTEM_FALLBACK_CODEPOINTS,
} from './page-font-artifact-visual.mjs';

export async function collectVisibleFontDiagnostics(page, route, row, fontManifest) {
  const expectedFonts = buildExpectedPageFonts(row, fontManifest);
  const diagnostics = await withTimeout(page.evaluate(({ routeName, expectedPreloads, expectedFonts }) => {
    const covered = new Set(expectedFonts.flatMap((font) => font.codepoints));
    const codepoints = new Set();
    const owners = new Map();
    const rawTcUnsupportedGlyphOwners = new Map();
    let visibleTextCharacterCount = 0;
    let visibleTextSample = '';
    const selectorFor = (element) => {
      const id = element.id ? `#${element.id.slice(0, 80)}` : '';
      const classes = [...element.classList].slice(0, 3).map((name) => `.${name.slice(0, 60)}`).join('');
      return `${element.tagName.toLowerCase()}${id}${classes}`.slice(0, 180);
    };
    const visible = (element) => {
      if (!element || !element.getClientRects().length) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const cssContentText = (value) => {
      if (!value || value === 'none' || value === 'normal' || value.length < 2) return '';
      const quote = value[0];
      if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) return '';
      return value.slice(1, -1).replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/gu, (_match, hex, character) => {
        if (hex) {
          const codepoint = Number.parseInt(hex, 16);
          return codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : '\uFFFD';
        }
        return character || '';
      });
    };
    const addVisibleText = (value, element, style, source) => {
      const text = value.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const chars = [...text];
      visibleTextCharacterCount += chars.length;
      if (visibleTextSample.length < 800) visibleTextSample += `${text} `.slice(0, 800 - visibleTextSample.length);
      const cps = [...new Set(chars.map((char) => char.codePointAt(0)))];
      cps.forEach((cp) => codepoints.add(cp));
      const selector = `${selectorFor(element)}${source}`;
      const key = `${selector}|${style.fontFamily}|${style.fontWeight}|${style.fontStyle}`;
      const owner = owners.get(key) || { selector, fontFamily: style.fontFamily,
        fontWeight: style.fontWeight, fontStyle: style.fontStyle, textNodes: 0, sample: '' };
      owner.textNodes += 1;
      if (owner.sample.length < 120) owner.sample += `${text} `.slice(0, 120 - owner.sample.length);
      owners.set(key, owner);
      const rawUnsupported = cps.filter((cp) => !covered.has(cp));
      if (rawUnsupported.length) {
        const unsupportedOwner = rawTcUnsupportedGlyphOwners.get(key) || { selector, fontFamily: style.fontFamily,
          fontWeight: style.fontWeight, fontStyle: style.fontStyle, codepoints: new Set(), sample: '' };
        rawUnsupported.forEach((cp) => unsupportedOwner.codepoints.add(cp));
        if (unsupportedOwner.sample.length < 120)
          unsupportedOwner.sample += `${text} `.slice(0, 120 - unsupportedOwner.sample.length);
        rawTcUnsupportedGlyphOwners.set(key, unsupportedOwner);
      }
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement;
      if (!element || ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(element.tagName)) continue;
      if (!visible(element)) continue;
      addVisibleText(node.nodeValue || '', element, getComputedStyle(element), '');
    }
    for (const element of document.querySelectorAll('body *')) {
      if (!visible(element)) continue;
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const text = cssContentText(style.content);
        if (text) addVisibleText(text, element, style, pseudo);
      }
    }
    const declaredPreloads = [...document.querySelectorAll('link[rel~="preload"][as="font"]')].map((link) => ({
      path: new URL(link.href).pathname,
      role: link.getAttribute('data-huiwen-font-page-preload'),
    }));
    const observedPreloads = performance.getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => path.startsWith('/assets/fonts/huiwen-site-sans/page-'))
      .sort();
    const fontFaces = [...document.fonts].map((face) => ({ family: face.family, weight: face.weight,
      style: face.style, status: face.status, unicodeRange: face.unicodeRange }))
      .filter((face) => /Huiwen Sans TC Page (Common|Delta)|Huiwen Sans TC/.test(face.family)).slice(0, 24);
    return {
      route: routeName,
      artifactRoute: document.documentElement.dataset.huiwenFontArtifactRoute || null,
      legacyFontPage: document.documentElement.dataset.huiwenFontPage || null,
      rootFontFamily: getComputedStyle(document.documentElement).getPropertyValue('--huiwen-font-family').trim(),
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      bodyFontWeight: getComputedStyle(document.body).fontWeight,
      visibleTextCharacterCount,
      visibleTextSample: visibleTextSample.trim(),
      visibleCodepoints: [...codepoints].sort((a, b) => a - b),
      visibleCodepointsTruncated: codepoints.size > 4096,
      rawTcUnsupportedGlyphOwners: [...rawTcUnsupportedGlyphOwners.values()].slice(0, 32).map((owner) => ({
        selector: owner.selector, fontFamily: owner.fontFamily, fontWeight: owner.fontWeight,
        fontStyle: owner.fontStyle,
        codepoints: [...owner.codepoints].sort((a, b) => a - b).slice(0, 32), sample: owner.sample.trim(),
      })),
      computedFontOwners: [...owners.values()].slice(0, 24),
      expectedFonts: expectedFonts.map(({ path, family, weight, weightAxis, sha256, codepoints }) => ({
        path, family, weight, weightAxis, sha256, codepointCount: codepoints.length,
      })),
      fontFaces,
      expectedPreloads,
      declaredPreloads,
      observedPreloads,
    };
  }, {
    routeName: route,
    expectedPreloads: row.preloads.map((path) => `/${path}`).sort(),
    expectedFonts,
  }), INITIAL_RENDER_TIMEOUT_MS, `${route}: visible font diagnostics`);
  return {
    ...diagnostics,
    ...classifyVisibleGlyphDiagnostics({
      expectedFonts,
      visibleCodepoints: diagnostics.visibleCodepoints,
      routeFallbacks: { jp: row.jpFallbackCodepoints || [], system: SYSTEM_FALLBACK_CODEPOINTS },
      rawTcUnsupportedGlyphOwners: diagnostics.rawTcUnsupportedGlyphOwners,
    }),
  };
}
