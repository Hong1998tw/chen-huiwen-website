import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = mkdtempSync(`${tmpdir()}/huiwen-cms-test-`);
const port = 18794,
  issuerPort = 18795,
  origin = `http://127.0.0.1:${port}`,
  issuer = `http://127.0.0.1:${issuerPort}`;
const email = "cms-test@example.com",
  emailHash = createHash("sha256").update(email).digest("hex");
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
const keys = createServer((q, r) => {
  r.setHeader("Content-Type", "application/json");
  r.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((resolve) => keys.listen(issuerPort, "127.0.0.1", resolve));
const token = await new SignJWT({ type: "app", email })
  .setProtectedHeader({ alg: "RS256", kid: "fixture" })
  .setIssuer(issuer)
  .setAudience("fixture")
  .setSubject("fixture-owner")
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(privateKey);
const config = JSON.parse(readFileSync(root + "wrangler.jsonc", "utf8"));
delete config.routes;
delete config.$schema;
config.main = root + "src/index.ts";
config.assets.directory = root + "public";
config.d1_databases[0].migrations_dir = root + "migrations";
Object.assign(config.vars, {
  ADMIN_ORIGIN: origin,
  ACCESS_ISSUER: issuer,
  ACCESS_AUD: "fixture",
  OWNER_EMAIL_SHA256: emailHash,
});
writeFileSync(dir + "/wrangler.json", JSON.stringify(config));
const wrangler = [
  "node_modules/wrangler/bin/wrangler.js",
  "--config",
  dir + "/wrangler.json",
];
let server;
let log = "";
try {
  execFileSync(
    process.execPath,
    [
      ...wrangler,
      "d1",
      "migrations",
      "apply",
      "huiwen-cms",
      "--local",
      "--persist-to",
      dir,
    ],
    { cwd: root, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [...wrangler, "d1", "execute", "huiwen-cms", "--local", "--persist-to", dir,
      "--command", "INSERT INTO published_pages VALUES('index.html','首頁','data/civic-home.json','composite','partial','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-09-27T00:00:00Z')"],
    { cwd: root, stdio: "pipe" },
  );
  server = spawn(
    process.execPath,
    [
      ...wrangler,
      "dev",
      "--port",
      String(port),
      "--persist-to",
      dir,
      "--var",
      `ADMIN_ORIGIN:${origin}`,
      "--var",
      `ACCESS_ISSUER:${issuer}`,
      "--var",
      "ACCESS_AUD:fixture",
      "--var",
      `OWNER_EMAIL_SHA256:${emailHash}`,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (v) => (log += v));
  server.stderr.on("data", (v) => (log += v));
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin)).status === 401) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready, log);
  const headers = { "Cf-Access-Jwt-Assertion": token };
  const session = await fetch(origin + "/api/session", { headers }).then((r) =>
    r.json(),
  );
  assert.equal(session.role, "owner");
  assert.equal((await fetch(origin + "/api/documents")).status, 401);
  assert.equal((await fetch(origin + "/api/pages")).status, 401);
  const pageCatalog = await fetch(origin + "/api/pages", { headers }).then((r) => r.json());
  assert.equal(pageCatalog.pages.length, 1);
  assert.equal(pageCatalog.pages[0].source_path, "data/civic-home.json");
  assert.equal(
    (await fetch(origin + "/style.css")).status,
    401,
    "static assets also require authentication",
  );
  const mutate = (path, method, body, extra = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        ...headers,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(origin + "/api/page-draft?path=index.html", { headers })).status, 200);
  const pageField = { id: "main>p:nth-of-type(1)", sourceHash: "a".repeat(64), value: "首頁草稿第一版" };
  assert.equal((await mutate("/api/page-draft", "PUT", { path: "index.html", version: 0, baseCommit: "a".repeat(40), fields: [pageField] })).status, 200);
  assert.equal((await mutate("/api/page-draft", "PUT", { path: "index.html", version: 0, baseCommit: "a".repeat(40), fields: [{ ...pageField, value: "首頁草稿過時寫入" }] })).status, 409);
  const savedPage = await fetch(origin + "/api/page-draft?path=index.html", { headers }).then((r) => r.json());
  assert.equal(savedPage.draft.version, 1);
  let pageHistory = await fetch(origin + "/api/page-draft/history?path=index.html", { headers }).then((r) => r.json());
  assert.equal(pageHistory.versions.length, 1);
  const restoredPage = await mutate("/api/page-draft/restore", "POST", { path: "index.html", version: 1, restoreVersion: 1 }).then((r) => r.json());
  assert.equal(restoredPage.version, 2);
  pageHistory = await fetch(origin + "/api/page-draft/history?path=index.html", { headers }).then((r) => r.json());
  assert.equal(pageHistory.versions.length, 2);
  const pagePublish = await mutate("/api/page-draft/publish", "POST", { path: "index.html", version: 2, operation: "publish" }).then((r) => r.json());
  const duplicatePagePublish = await mutate("/api/page-draft/publish", "POST", { path: "index.html", version: 2, operation: "publish" }).then((r) => r.json());
  assert.equal(pagePublish.id, duplicatePagePublish.id, "page publication requests are idempotent");
  for (const operation of ["unpublish", "delete", "restore"]) {
    const receipt = await mutate("/api/page-draft/publish", "POST", { path: "index.html", version: 2, operation });
    assert.equal(receipt.status, 202);
  }
  const event = {
    name: "本機測試草稿",
    start: "2026-10-01T10:00:00+08:00",
    end: "2026-10-01T12:00:00+08:00",
    content: "只存在本機測試資料庫",
    registration: "無需報名",
    sourceUrl: "https://www.kcc.gov.tw/",
    verifiedAt: "2026-09-27",
    updatedAt: "2026-09-27",
    reviewDueAt: "2026-09-30",
    status: "scheduled",
    changeNote: null,
  };
  assert.equal(
    (
      await mutate(
        "/api/documents",
        "POST",
        { domain: "events", payload: event },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const created = await mutate("/api/documents", "POST", {
    domain: "events",
    payload: event,
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const path = `/api/documents/${id}`;
  assert.equal(
    (
      await mutate(path, "PUT", {
        version: 1,
        payload: { ...event, name: "第二版" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await mutate(path, "PUT", {
        version: 1,
        payload: { ...event, name: "過時覆蓋" },
      })
    ).status,
    409,
  );
  let history = await fetch(origin + path + "/history", { headers }).then((r) =>
    r.json(),
  );
  assert.equal(history.versions.length, 2);
  assert.equal(JSON.parse(history.versions[0].payload).name, "第二版");
  const first = await mutate(path + "/publish", "POST", { version: 2 }).then(
    (r) => r.json(),
  );
  const again = await mutate(path + "/publish", "POST", { version: 2 }).then(
    (r) => r.json(),
  );
  assert.equal(first.id, again.id, "duplicate click is idempotent");
  assert.equal(
    (await mutate(path + "/restore", "POST", { version: 2, restoreVersion: 1 }))
      .status,
    200,
  );
  history = await fetch(origin + path + "/history", { headers }).then((r) =>
    r.json(),
  );
  assert.equal(history.versions.length, 3);
  assert.equal(JSON.parse(history.versions[0].payload).name, event.name);
  assert.equal(
    (await mutate(path + "/publish", "POST", { version: 99 })).status,
    409,
  );
  const pending = await fetch(origin + "/api/publications", { headers }).then(
    (r) => r.json(),
  );
  assert.equal(pending.publications.length, 5);
  assert.equal(pending.publications.filter((row) => row.path === "index.html").length, 4);
  assert.equal(
    (await fetch(origin + "/internal/claim", { headers })).status,
    404,
    "admin identity cannot access runner route",
  );
  const html = await fetch(origin, { headers });
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("Cache-Control"), "no-store");
  assert.match(await html.text(), /內容管理/);
  if (process.env.CMS_BROWSER === '1') {
    const {chromium} = await import(process.env.CMS_PLAYWRIGHT_PATH || '../../tests/donation/node_modules/playwright/index.mjs');
    console.log('CMS_BROWSER: launching Chromium');
    const browser = await chromium.launch({headless:true});
    console.log('CMS_BROWSER: Chromium ready');
    try {
      const context=await browser.newContext({extraHTTPHeaders:headers});
      const page=await context.newPage();
      let editorRuntimeRequests=0;
      const editorFixture = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>Test page</title><style>body{font:20px sans-serif;padding:24px;color:#173e35}main{max-width:720px;margin:auto}</style><script data-cms-editor-loader>if(window.self!==window.top&&new URLSearchParams(location.search).get('cmsEdit')==='1')document.write('<scr'+'ipt defer src="/cms-page-editor.js"></scr'+'ipt>');</script></head><body><main><h1 data-cms-edit-id="main&gt;h1:nth-of-type(1)" data-cms-source-hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" data-cms-value-hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">測試正式頁面</h1></main></body></html>`;
      const editorRuntime = `(()=>{const node=document.querySelector('[data-cms-edit-id]');let nonce=null,targetOrigin=null;const send=(type,payload={})=>parent.postMessage({type,nonce,path:location.pathname,...payload},targetOrigin);addEventListener('message',event=>{if(event.source!==parent)return;if(event.data?.type==='huiwen-cms-init'){nonce=event.data.nonce;targetOrigin=event.origin;node.contentEditable='true';node.addEventListener('input',()=>send('huiwen-cms-change',{field:{id:node.dataset.cmsEditId,sourceHash:node.dataset.cmsSourceHash,value:node.textContent}}));send('huiwen-cms-ready',{blocks:[{id:node.dataset.cmsEditId,sourceHash:node.dataset.cmsSourceHash,value:node.textContent}]});}else if(event.data?.type==='huiwen-cms-apply'&&nonce)send('huiwen-cms-ready',{blocks:[{id:node.dataset.cmsEditId,sourceHash:node.dataset.cmsSourceHash,value:node.textContent}]});});})();`;
      page.on('request',request=>{if(new URL(request.url()).pathname==='/cms-page-editor.js')editorRuntimeRequests++;});
      await page.route("https://www.huiwen.tw/**", route => new URL(route.request().url()).pathname==="/cms-page-editor.js"
        ? route.fulfill({status:200,contentType:"application/javascript",body:editorRuntime})
        : route.fulfill({status:200,contentType:"text/html; charset=utf-8",body:editorFixture}));
      const publicVisitor=await context.newPage();
      await publicVisitor.goto('https://www.huiwen.tw/');
      assert.equal(editorRuntimeRequests,0,'ordinary public visits must not download the CMS editor runtime');
      await publicVisitor.close();
      for(const width of [390,1440]) {
        await page.setViewportSize({width,height:960});
        await page.goto(origin);
        console.log(`CMS_BROWSER: dashboard loaded at ${width}px`);
        const priorRuntimeRequests=editorRuntimeRequests;
        await page.getByRole('button',{name:/首頁/}).click();
        console.log('CMS_BROWSER: page selected');
        assert(await page.getByRole('heading',{name:'首頁',exact:true}).isVisible());
        const frame=page.frameLocator('#page-frame');
        await frame.locator('h1[contenteditable="true"]').waitFor();
        assert.equal(editorRuntimeRequests,priorRuntimeRequests+1,'admin iframe must load the editor runtime');
        await frame.locator('h1[contenteditable="true"]').fill('測試已修改');
        await page.getByText('頁面文字有變更 · 儲存後才會進入發布流程',{exact:true}).waitFor();
        assert.equal(await page.locator('#page-save').isEnabled(),true,'editing the rendered page enables draft save');
        await page.locator('#structured-records > summary').click();
        console.log('CMS_BROWSER: structured editor opened');
        await page.getByRole('button',{name:/本機測試草稿/}).click();
        assert(await page.getByLabel('活動名稱',{exact:true}).isVisible());
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'editor must fit viewport');
        await page.getByRole('button',{name:'預覽發布內容',exact:true}).click();
        assert(await page.getByRole('dialog').isVisible());
        assert(await page.getByRole('button',{name:'確認並送出發布'}).isVisible());
        await page.getByRole('button',{name:'關閉',exact:true}).click();
        await page.evaluate(()=>window.scrollTo(0,0));
        if(process.env.CMS_SCREENSHOTS)await page.screenshot({path:process.env.CMS_SCREENSHOTS+'/'+width+'.png',fullPage:true});
      }
      await context.close();
    } finally { await browser.close(); }
    console.log('PASS: mobile and desktop editor and publication preview browser flow');
  }
  console.log(
    "PASS: real local Worker + D1 auth, CSRF, CRUD, optimistic concurrency, restore, immutable publish snapshot, duplicate clicks and protected assets",
  );
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => server.once("exit", r)),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }
  keys.close();
  rmSync(dir, { recursive: true, force: true });
}
