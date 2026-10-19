export const CMS_FIXTURE_HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

export function buildCmsFixtureHtml(bodyMarkup) {
  if (typeof bodyMarkup !== 'string') throw new TypeError('CMS fixture body markup must be a string');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"></head><body>${bodyMarkup}</body></html>`;
}

export function buildCmsFixtureHtmlFulfill(bodyMarkup, { status = 200, headers = {} } = {}) {
  const html = buildCmsFixtureHtml(bodyMarkup);
  return {
    status,
    headers: { 'content-type': CMS_FIXTURE_HTML_CONTENT_TYPE, ...headers },
    body: Buffer.from(html, 'utf8'),
  };
}

export function buildCmsPreviewDraft(draftGlyph) {
  if (typeof draftGlyph !== 'string' || [...draftGlyph].length !== 1)
    throw new TypeError('CMS draft glyph must be one Unicode code point');
  return {
    title: `CI草稿${draftGlyph}`,
    updated: '2026-10-19',
    paragraphs: [`CI草稿新增字：${draftGlyph}`],
    history: [],
    media: [],
  };
}

export function serializeCmsFixtureScriptValue(value) {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}
