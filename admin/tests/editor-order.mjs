import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "../../tests/donation/node_modules/playwright/index.mjs";

const root = new URL("../public/", import.meta.url);
const [html, script, style, dateTimeScript] = await Promise.all([
  readFile(new URL("index.html", root)),
  readFile(new URL("app.js", root)),
  readFile(new URL("style.css", root)),
  readFile(new URL("date-time.js", root)),
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
let savedDocument = null;
const documents = [
  { id: 1, domain: "events", version: 1, updated_at: "2026-09-27T00:00:00Z", payload: JSON.stringify({
    name: "日期測試活動", start: "2026-10-01T19:30:00+08:00", end: "2026-10-01T21:00:00+08:00",
    content: "活動說明", registration: "免報名", sourceUrl: "https://example.com/event",
    verifiedAt: "2026-09-27", updatedAt: "2026-09-27", reviewDueAt: "2026-09-30", status: "scheduled", changeNote: null,
  }) },
  { id: 2, domain: "legal-schedule", version: 1, updated_at: "2026-09-27T00:00:00Z", payload: JSON.stringify({
    month: "2026-10", observedAt: "2026-09-27", sourceUrl: "https://example.com/legal",
    sourceTitle: "月表", nextReviewAt: "2026-10-15", sessions: [{ date: "2026-10-01", start: "19:30", end: "21:00" }],
  }) },
];
const send = (res, data, type = "application/json") => {
  res.writeHead(200, { "content-type": type });
  res.end(data);
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path === "/") return send(res, html, "text/html; charset=utf-8");
  if (path === "/app.js") return send(res, script, "application/javascript");
  if (path === "/date-time.js") return send(res, dateTimeScript, "application/javascript");
  if (path === "/style.css") return send(res, style, "text/css");
  if (path === "/api/page-preview") return send(res, "<!doctype html><html><head></head><body><main><article class='case-body'></article><div class='case-latest-wrap'></div></main></body></html>", "text/html; charset=utf-8");
  if (path === "/api/session") return send(res, JSON.stringify({ login: "owner@example.test", csrf: "test" }));
  if (path === "/api/documents") return send(res, JSON.stringify({ documents }));
  if (/^\/api\/documents\/\d+$/.test(path) && req.method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const id = Number(path.split("/").pop());
    savedDocument = { id, ...JSON.parse(body) };
    const document = documents.find(item => item.id === id);
    document.payload = JSON.stringify(savedDocument.payload);
    document.version++;
    return send(res, JSON.stringify({ id }));
  }
  if (/^\/api\/documents\/\d+\/history$/.test(path)) return send(res, JSON.stringify({ versions: [] }));
  if (path === "/api/pages") return send(res, JSON.stringify({ pages }));
  if (path === "/api/page-blocks") return send(res, JSON.stringify({ blocks: [] }));
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
  await page.locator('#case-editor-fields > .field:nth-child(3) input').fill('20230927');
  await page.locator('[data-case-list="history"][data-case-index="0"] input').first().fill('20230621');
  await page.locator('[data-case-list="sources"][data-case-index="0"] input').first().fill('202306');
  await page.locator('[data-case-list="sources"][data-case-index="0"] input').first().blur();
  assert.equal(await page.locator('[data-case-list="history"][data-case-index="0"] input').first().inputValue(), '2023-06-21');
  assert.equal(await page.locator('[data-case-list="sources"][data-case-index="0"] input').first().inputValue(), '2023-06');
  console.log("CMS order test: reordered");
  await page.locator("#page-save").click();
  console.log("CMS order test: save clicked");
  await page.getByText("草稿 v1 已儲存；正式頁面尚未變更。", { exact: true }).waitFor();
  assert.deepEqual(saved.case.paragraphs, ["第二段", "第一段"]);
  assert.deepEqual(saved.case.sources.map(item => item.title), ["來源二", "來源一"]);
  assert.deepEqual(saved.case.media.map(item => item.alt), ["影片二", "照片一"]);
  assert.deepEqual(saved.case.images, ["second.jpg", "first.jpg"]);
  assert.deepEqual(saved.case.sectionOrder, ["overview", "media", "sources", "history"]);
  assert.equal(saved.case.updated, '2023-09-27');
  assert.equal(saved.case.history[0].date, '2023-06-21');
  assert.equal(saved.case.sources[0].sourceDate, '2023-06');
  assert.deepEqual(saved.caseBase.images, ["first.jpg", "second.jpg"]);
  await page.locator('#structured-records > summary').click();
  await page.locator('#documents button.document').first().click();
  await page.locator('#field-start').fill('202610011930');
  await page.locator('#field-end').fill('202610012100');
  await page.locator('#field-verifiedAt').fill('20260927');
  await page.locator('#field-updatedAt').fill('20260927');
  await page.locator('#field-reviewDueAt').fill('20260930');
  await page.locator('#field-reviewDueAt').blur();
  assert.equal(await page.locator('#field-start').inputValue(), '2026-10-01T19:30');
  assert.equal(await page.locator('#field-verifiedAt').inputValue(), '2026-09-27');
  await page.locator('#save').click();
  await page.getByText('草稿已儲存，官網尚未變更。', { exact: true }).waitFor();
  assert.equal(savedDocument.payload.start, '2026-10-01T19:30:00+08:00');
  assert.equal(savedDocument.payload.end, '2026-10-01T21:00:00+08:00');
  assert.equal(savedDocument.payload.verifiedAt, '2026-09-27');
  await page.locator('#documents button.document').last().click();
  await page.locator('#field-month').fill('202610');
  await page.locator('#field-observedAt').fill('20260927');
  await page.locator('#field-nextReviewAt').fill('20261015');
  await page.locator('#field-sessions').fill('20261001 1930 2100');
  await page.locator('#field-sessions').blur();
  assert.equal(await page.locator('#field-sessions').inputValue(), '2026-10-01 19:30 21:00');
  await page.locator('#save').click();
  await page.getByText('草稿已儲存，官網尚未變更。', { exact: true }).waitFor();
  assert.equal(savedDocument.payload.month, '2026-10');
  assert.equal(savedDocument.payload.nextReviewAt, '2026-10-15');
  assert.deepEqual(savedDocument.payload.sessions, [{ date: '2026-10-01', start: '19:30', end: '21:00' }]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.close();
  console.log("PASS: mobile CMS ordering and compact date/time entry in case, event, and legal schedule editors");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
