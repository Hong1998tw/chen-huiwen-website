import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "../../tests/donation/node_modules/playwright/index.mjs";

const root = new URL("../public/", import.meta.url);
const [html, script, style] = await Promise.all([
  readFile(new URL("index.html", root)),
  readFile(new URL("app.js", root)),
  readFile(new URL("style.css", root)),
]);
const published = {
  title: "A 專頁", summary: "公開紀錄", updated: "2026-09-27",
  paragraphs: ["第一段", "第二段"],
  history: [
    { date: "2026-01-01", title: "第一步", text: "第一筆紀錄" },
    { date: "2026-02-01", title: "第二步", text: "第二筆紀錄" },
  ],
  sources: [
    { title: "來源一", url: "https://www.kcg.gov.tw/one", sourceDate: "2026-01-01" },
    { title: "來源二", url: "https://www.kcg.gov.tw/two", sourceDate: "2026-02-01" },
  ],
  media: [
    { kind: "photo", url: "https://example.com/one.jpg", alt: "照片一", caption: "第一張", credit: "服務處", publicAccessConfirmed: true },
    { kind: "video", url: "https://example.com/two.mp4", alt: "影片二", caption: "第二段", credit: "服務處", publicAccessConfirmed: true },
  ],
  images: ["first.jpg", "second.jpg"], imageMetadata: {},
};
const pages = [
  { path: "achievement-a.html", title: "Z 專頁", source_path: "data/achievements.json", source_kind: "generated", editor_scope: "partial", commit_sha: "a".repeat(40), publication_status: "published", draft_version: 0 },
  { path: "achievement-z.html", title: "A 專頁", source_path: "data/achievements.json", source_kind: "generated", editor_scope: "partial", commit_sha: "a".repeat(40), publication_status: "published", draft_version: 0 },
];
let saved = null;
let draft = null;
const send = (res, data, type = "application/json") => {
  res.writeHead(200, { "content-type": type });
  res.end(data);
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path === "/") return send(res, html, "text/html; charset=utf-8");
  if (path === "/app.js") return send(res, script, "application/javascript");
  if (path === "/style.css") return send(res, style, "text/css");
  if (path === "/api/page-preview") return send(res, "<!doctype html><html><head></head><body><main><article class='case-body'></article><div class='case-latest-wrap'></div></main></body></html>", "text/html; charset=utf-8");
  if (path === "/api/session") return send(res, JSON.stringify({ login: "owner@example.test", csrf: "test" }));
  if (path === "/api/documents") return send(res, JSON.stringify({ documents: [] }));
  if (path === "/api/pages") return send(res, JSON.stringify({ pages }));
  if (path === "/api/publications") return send(res, JSON.stringify({ publications: [] }));
  if (path === "/api/case") return send(res, JSON.stringify({ case: published }));
  if (path === "/api/page-draft/history") return send(res, JSON.stringify({ versions: [] }));
  if (path === "/api/page-draft" && req.method === "GET") return send(res, JSON.stringify({ draft }));
  if (path === "/api/page-draft" && req.method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    saved = JSON.parse(body);
    draft = { version: 1, payload: JSON.stringify({ fields: {}, case: saved.case, caseBase: saved.caseBase }), publication_status: "published" };
    pages[1].draft_version = 1;
    return send(res, JSON.stringify({ version: 1 }));
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => console.error("CMS editor pageerror:", error.message));
  await page.route("https://www.huiwen.tw/assets/**", route => route.abort());
  await page.goto(origin);
  console.log("CMS order test: dashboard loaded");
  await page.locator("#page-tree .tree-page").first().waitFor();
  assert.match(await page.locator("#page-tree .tree-page").first().textContent(), /Z 專頁/);
  await page.locator("#page-sort").selectOption("title");
  assert.match(await page.locator("#page-tree .tree-page").first().textContent(), /A 專頁/);
  await page.getByRole("button", { name: /A 專頁/ }).click();
  console.log("CMS order test: page selected");
  await page.locator('[data-case-section="overview"]').waitFor();
  await page.locator('[data-case-list="paragraphs"][data-case-index="1"] [data-case-action="up"]').click();
  assert.equal(await page.locator('[data-case-list="paragraphs"][data-case-index="0"] textarea').inputValue(), "第二段");
  await page.locator('[data-case-list="sources"][data-case-index="1"] [data-case-action="position"]').selectOption("0");
  await page.locator('[data-case-list="media"][data-case-index="1"] [data-case-action="up"]').click();
  await page.locator('[data-case-list="images"][data-case-index="1"] [data-case-action="up"]').click();
  await page.locator('[data-case-section="sources"] [data-case-section-action="up"]').click();
  console.log("CMS order test: reordered");
  await page.locator("#page-save").click();
  console.log("CMS order test: save clicked");
  await page.getByText("草稿 v1 已儲存；正式頁面尚未變更。", { exact: true }).waitFor();
  assert.deepEqual(saved.case.paragraphs, ["第二段", "第一段"]);
  assert.deepEqual(saved.case.sources.map(item => item.title), ["來源二", "來源一"]);
  assert.deepEqual(saved.case.media.map(item => item.alt), ["影片二", "照片一"]);
  assert.deepEqual(saved.case.images, ["second.jpg", "first.jpg"]);
  assert.deepEqual(saved.case.sectionOrder, ["overview", "media", "sources", "history"]);
  assert.deepEqual(saved.caseBase.images, ["first.jpg", "second.jpg"]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.close();
  console.log("PASS: mobile CMS list sorting, section and item reordering, and saved draft order");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
