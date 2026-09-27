import test from "node:test";
import assert from "node:assert/strict";
import { pagePreviewContentSecurityPolicy, preparePagePreviewDocument } from "../src/page-preview.ts";

const fixture = `<!doctype html><html><head><meta charset="utf-8"><base href="https://old.example/"><script data-cms-editor-loader data-cms-manifest="/cms-editor-manifests/index.html.0123456789ab.json">loader</script></head><body><main><h1>正式頁面</h1></main></body></html>`;

test("page preview preserves the public document and adds only isolated editor metadata", () => {
  const html = preparePagePreviewDocument(fixture, "guides/service-guides.html", "https://admin.huiwen.tw", true);
  assert.match(html, /<head><base href="https:\/\/www\.huiwen\.tw\/guides\/service-guides\.html">/);
  assert.doesNotMatch(html, /old\.example/);
  assert.match(html, /data-cms-editor-enabled="true"/);
  assert.match(html, /data-cms-page-path="guides\/service-guides\.html"/);
  assert.match(html, /data-cms-admin-origin="https:\/\/admin\.huiwen\.tw"/);
  assert.match(html, /<main><h1>正式頁面<\/h1><\/main>/);
});

test("read-only published pages keep their source HTML without editor access", () => {
  const html = preparePagePreviewDocument(fixture, "404.html", "https://admin.huiwen.tw", false);
  assert.match(html, /<main><h1>正式頁面<\/h1><\/main>/);
  assert.doesNotMatch(html, /data-cms-editor-enabled=/);
  assert.doesNotMatch(html, /data-cms-page-path=/);
});

test("preview refuses unsafe paths, ambiguous editor loaders, and invalid parent origins", () => {
  assert.throws(() => preparePagePreviewDocument(fixture, "../secret.html", "https://admin.huiwen.tw", true));
  assert.throws(() => preparePagePreviewDocument(fixture.replace("</head>", "<script data-cms-editor-loader></script></head>"), "index.html", "https://admin.huiwen.tw", true));
  assert.throws(() => preparePagePreviewDocument(fixture, "index.html", "https://admin.huiwen.tw/", true));
});

test("preview CSP allows only the published site resources and authenticated admin parent", () => {
  const policy = pagePreviewContentSecurityPolicy("https://admin.huiwen.tw");
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src https:\/\/www\.huiwen\.tw 'unsafe-inline'/);
  assert.match(policy, /frame-ancestors https:\/\/admin\.huiwen\.tw/);
  assert.doesNotMatch(policy, /unsafe-eval|\*/);
});
