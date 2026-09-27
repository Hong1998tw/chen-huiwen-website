import test from "node:test";
import assert from "node:assert/strict";
import { pagePreviewContentSecurityPolicy, preparePagePreviewDocument } from "../src/page-preview.ts";

const fixture = `<!doctype html><html><head><meta charset="utf-8"><base href="https://old.example/"><script defer src="/site.js" type="0c04716efef0c9e83cef9679-text/javascript" data-cf-settings="deferred"></script><script type="application/ld+json">{"@type":"WebPage"}</script><script data-cms-editor-loader data-cms-manifest="/cms-editor-manifests/index.html.0123456789ab.json" type="0c04716efef0c9e83cef9679-text/javascript">loader</script><script defer src="/cdn-cgi/scripts/7d0fa10a/cloudflare-static/rocket-loader.min.js" data-cf-settings="loader"></script></head><body><main><h1>正式頁面</h1></main></body></html>`;

test("page preview preserves the public document and adds only isolated editor metadata", () => {
  const html = preparePagePreviewDocument(fixture, "guides/service-guides.html", "https://admin.huiwen.tw", true);
  assert.match(html, /<head><base href="https:\/\/www\.huiwen\.tw\/guides\/service-guides\.html">/);
  assert.doesNotMatch(html, /old\.example/);
  assert.match(html, /data-cms-editor-enabled="true"/);
  assert.match(html, /data-cms-page-path="guides\/service-guides\.html"/);
  assert.match(html, /data-cms-admin-origin="https:\/\/admin\.huiwen\.tw"/);
  assert.match(html, /data-cfasync="false"\s+src="\/site\.js"/);
  assert.match(html, /type="text\/javascript"/);
  assert.match(html, /data-cms-editor-loader[^>]*data-cfasync="false"/);
  assert.doesNotMatch(html, /data-cf-settings=|rocket-loader(?:\.min)?\.js/);
  assert.match(html, /<script type="application\/ld\+json">/);
  assert.doesNotMatch(html, /application\/ld\+json[^>]*data-cfasync/);
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
