import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
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
const retryablePageFailure = "網站剛有其他更新；本輪不建立發布請求，下一輪會以最新版本重新檢查。";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
let jwksFetches = 0; // the Worker must cache the Access JWKS across requests, not refetch it per request
const keys = createServer((q, r) => {
  jwksFetches++;
  r.setHeader("Content-Type", "application/json");
  r.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((resolve) => keys.listen(issuerPort, "127.0.0.1", resolve));
const realFetch = globalThis.fetch;
let accessRequests = 0; // requests that carry the Access JWT, i.e. that make the Worker verify a token
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(origin) && init?.headers && new Headers(init.headers).has("Cf-Access-Jwt-Assertion")) accessRequests++;
  return realFetch(input, init);
};
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
      "--command", "INSERT INTO published_pages VALUES('index.html','首頁','data/civic-home.json','composite','partial','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-09-27T00:00:00Z'),('service-guides.html','市民服務指南','data/service-guides.json','generated','partial','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-09-27T00:00:00Z')"],
    { cwd: root, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [...wrangler, "d1", "execute", "huiwen-cms", "--local", "--persist-to", dir,
      "--command", `INSERT INTO page_edits(path,payload,base_commit,version,publication_status,updated_at,actor) VALUES('service-guides.html','{"fields":{}}','${"a".repeat(40)}',1,'published','2026-09-27T00:00:00Z','github:126787497'); INSERT INTO page_publications(id,path,version,payload,base_commit,operation,status,created_at,updated_at,actor,lease,lease_until,attempts,pr_number,message,commit_sha) VALUES('stale-release','service-guides.html',1,'{"fields":{}}','${"a".repeat(40)}','publish','failed','2026-09-27T00:00:00Z','2026-09-27T00:01:00Z','github:126787497',NULL,NULL,1,NULL,'${retryablePageFailure}',NULL);`],
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
  assert.equal((await fetch(origin + "/api/page-preview?path=index.html")).status, 401,
    "the published-page preview must require the authenticated owner");
  assert.equal((await fetch(origin + "/api/page-draft/retry", { method: "POST" })).status, 401,
    "failed page publication retry must require the authenticated owner");
  const pageCatalog = await fetch(origin + "/api/pages", { headers }).then((r) => r.json());
  assert.equal(pageCatalog.pages.length, 2);
  assert.equal(pageCatalog.pages[0].source_path, "data/civic-home.json");
  assert.equal((await fetch(origin + "/api/page-preview?path=" + encodeURIComponent("../index.html"), { headers })).status, 400,
    "the preview route must reject traversal paths");
  assert.equal((await fetch(origin + "/api/page-preview?path=missing.html", { headers })).status, 404,
    "the preview route must reject paths outside the published catalogue");
  if (process.env.CMS_LIVE_PREVIEW === "1") {
    const livePreview = await fetch(origin + "/api/page-preview?path=service-guides.html", { headers });
    const liveHTML = await livePreview.text();
    assert.equal(livePreview.status, 200, liveHTML);
    assert.match(livePreview.headers.get("content-type") || "", /text\/html/);
    assert.equal(livePreview.headers.get("cache-control"), "no-store");
    assert.equal(livePreview.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(livePreview.headers.get("content-security-policy") || "", new RegExp(`frame-ancestors ${origin.replaceAll(".", "\\.")}`));
    assert.match(liveHTML, /data-cms-page-path="service-guides\.html"/);
    assert.match(liveHTML, /data-cms-admin-origin="http:\/\/127\.0\.0\.1:18794"/);
    assert.match(liveHTML, /<main\b/);
    assert.doesNotMatch(liveHTML, /rocket-loader(?:\.min)?\.js|data-cf-settings=/i,
      "the sandboxed preview must not execute Cloudflare's Rocket Loader wrapper");
    assert.doesNotMatch(liveHTML, /type="[a-f0-9]{8,}-text\/javascript"/i,
      "Rocket Loader's deferred script type must be restored in the preview");
    assert.match(liveHTML, /data-cfasync="false"\s+src=/i,
      "preview scripts must retain their source execution order at Cloudflare's edge");
  }
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
  const retryReceipt = await mutate("/api/page-draft/retry", "POST", {id:"stale-release",version:1});
  assert.equal(retryReceipt.status,202,await retryReceipt.clone().text());
  const retriedRelease = await retryReceipt.json();
  assert.equal(retriedRelease.version,2);
  assert.equal(retriedRelease.status,"queued");
  assert.notEqual(retriedRelease.id,"stale-release");
  const duplicateRetry = await mutate("/api/page-draft/retry", "POST", {id:"stale-release",version:1}).then(r=>r.json());
  assert.equal(duplicateRetry.id,retriedRelease.id,"duplicate retry clicks return the same new release instead of creating another attempt");
  const retryDraft = await fetch(origin + "/api/page-draft?path=service-guides.html",{headers}).then(r=>r.json());
  assert.equal(retryDraft.draft.version,2);
  assert.equal(retryDraft.draft.base_commit,"a".repeat(40),"retry must preserve the source baseline for publisher conflict checks");
  assert.deepEqual(JSON.parse(retryDraft.draft.payload),{fields:{}},"retry must preserve the exact original draft payload");
  const retryRecords = await fetch(origin + "/api/publications",{headers}).then(r=>r.json());
  const pageRetryRecords = retryRecords.publications.filter(row=>row.path==="service-guides.html");
  assert.deepEqual(pageRetryRecords.map(row=>row.status).sort(),["failed","queued"],"old failed record and new queued retry both remain auditable");
  assert.equal((await mutate("/api/page-draft/retry", "POST", {id:pageRetryRecords.find(row=>row.status==="queued").id,version:2})).status,409,
    "only the specific retryable stale-checkout failure can be retried");
  const createdPage = await mutate("/api/page-create", "POST", {section:"news",slug:"local-test",title:"本機新聞專頁"});
  assert.equal(createdPage.status,201);
  const createdPath = "page-news-local-test.html";
  const newDraft = await fetch(origin + `/api/page-draft?path=${createdPath}`,{headers}).then(r=>r.json());
  assert.equal(newDraft.draft.version,1);
  assert((await fetch(origin + "/api/pages",{headers}).then(r=>r.json())).pages.some(row=>row.path===createdPath));
  if (process.env.CMS_LIVE_PREVIEW === "1") {
    const preview = await fetch(origin + `/api/page-preview?path=${createdPath}`,{headers});
    const markup = await preview.text();
    assert.equal(preview.status,200,markup);
    assert.match(markup,/data-cms-page-path="page-news-local-test\.html"/);
    assert.match(markup,/<article class="wrap section editorial-body"><\/article>/);
  }
  const content = JSON.parse(newDraft.draft.payload).editorial;
  content.summary = "本機測試摘要"; content.seo.description = "本機測試搜尋說明";
  content.blocks[0].text = "本機測試內容";
  const savedEditorial = await mutate("/api/page-draft","PUT",{path:createdPath,version:1,baseCommit:"a".repeat(40),fields:[],editorial:content,editorialBase:null});
  assert.equal(savedEditorial.status,200);
  assert.equal((await mutate("/api/page-create","POST",{section:"news",slug:"local-test",title:"重複"})).status,409);
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
  assert.equal((await fetch(origin + path + "/published")).status,401,"published baseline remains owner-only");
  assert.deepEqual(await fetch(origin + path + "/published",{headers}).then(r=>r.json()),{source:null},
    "new drafts have no published baseline and must not invent a comparison");
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
  assert.equal(pending.publications.length, 7);
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
  console.log(`JWKS fetches: ${jwksFetches} for ${accessRequests} requests with an Access JWT`);
  assert.ok(accessRequests >= 30, `expected many verified requests, saw ${accessRequests}`);
  assert.ok(jwksFetches >= 1 && jwksFetches <= 2, `Access JWKS fetched ${jwksFetches} times for ${accessRequests} requests; it must be cached`);
  if (process.env.CMS_BROWSER === '1') {
    const {chromium} = await import(process.env.CMS_PLAYWRIGHT_PATH || '../../tests/donation/node_modules/playwright/index.mjs');
    console.log('CMS_BROWSER: launching Chromium');
    const browser = await chromium.launch({headless:true});
    console.log('CMS_BROWSER: Chromium ready');
    try {
      const context=await browser.newContext({extraHTTPHeaders:headers});
      const page=await context.newPage();
      page.on('pageerror',error=>console.error(`CMS_BROWSER pageerror: ${error.message}`));
      page.on('console',message=>{if(message.type()==='error')console.error(`CMS_BROWSER console: ${message.text()}`);});
      page.on('requestfailed',request=>console.error(`CMS_BROWSER requestfailed: ${request.url()} · ${request.failure()?.errorText||'unknown'}`));
      let editorRuntimeRequests=0, editorManifestRequests=0;
      const manifestPath = "/cms-editor-manifests/index.html.a1b2c3d4e5f6.json";
      const editorFixture = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><base href="https://www.huiwen.tw/index.html"><title>Test page</title><style>body{font:20px sans-serif;padding:24px;color:#173e35}main{max-width:720px;margin:auto}</style><script data-cfasync="false" data-cms-editor-loader data-cms-editor-enabled="true" data-cms-page-path="index.html" data-cms-admin-origin="${origin}" data-cms-manifest="https://www.huiwen.tw${manifestPath}">if(window.self!==window.top&&document.currentScript?.dataset.cmsEditorEnabled==='true')document.write('<scr'+'ipt defer src="/cms-page-editor.0123456789ab.js"></scr'+'ipt>');</script></head><body><main><h1>測試正式頁面</h1></main></body></html>`;
      const editorManifest = JSON.stringify({schemaVersion:1,path:"index.html",fields:[{id:"main>h1:nth-of-type(1)",sourceHash:"a".repeat(64),valueHash:"a".repeat(64)}]});
      const editorRuntime = readFileSync(root + "../cms-page-editor.js", "utf8");
      const axeScript = readFileSync(root + "../tests/donation/node_modules/axe-core/axe.min.js", "utf8");
      await page.route(`${origin}/axe.min.js`, route=>route.fulfill({status:200,contentType:"application/javascript",body:axeScript}));
      await page.route(`${origin}/api/home`, route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
        home:{featured:"a",reading:["b"],summaries:{a:"首頁主題",b:"延伸閱讀"}},
        cases:[{id:"a",title:"專題 A",summary:"首頁主題",status:"持續追蹤",categories:["地方專題"],updated:"2026-09-27",images:[]},
          {id:"b",title:"專題 B",summary:"延伸閱讀",status:"持續追蹤",categories:["地方專題"],updated:"2026-09-27",images:[]}]
      })}));
      page.on('request',request=>{const path=new URL(request.url()).pathname;if(/^\/cms-page-editor\.[a-f0-9]{12}\.js$/.test(path))editorRuntimeRequests++;if(path===manifestPath)editorManifestRequests++;});
      await page.route("https://www.huiwen.tw/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (/^\/cms-page-editor\.[a-f0-9]{12}\.js$/.test(path)) return route.fulfill({status:200,contentType:"application/javascript",body:editorRuntime});
        if (path === manifestPath) return route.fulfill({status:200,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:editorManifest});
        return route.fulfill({status:200,contentType:"text/html; charset=utf-8",body:editorFixture});
      });
      await page.route(`${origin}/api/page-preview**`, route => route.fulfill({
        status:200,
        headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-frame-options":"SAMEORIGIN","content-security-policy":`default-src 'none'; base-uri https://www.huiwen.tw; script-src https://www.huiwen.tw 'unsafe-inline'; style-src https://www.huiwen.tw 'unsafe-inline'; connect-src https://www.huiwen.tw; frame-ancestors ${origin}`},
        body:editorFixture,
      }));
      const publicVisitor=await context.newPage();
      await publicVisitor.goto('https://www.huiwen.tw/');
      assert.equal(editorRuntimeRequests,0,'ordinary public visits must not download the CMS editor runtime');
      assert.equal(editorManifestRequests,0,'ordinary public visits must not download editor manifests');
      assert.equal(await publicVisitor.locator('[data-cms-edit-id]').count(),0,'public HTML must not carry editor selectors');
      await publicVisitor.close();
      const screenshotDir=process.env.CMS_SCREENSHOTS;
      if(screenshotDir)mkdirSync(screenshotDir,{recursive:true});
      const capture=async name=>{if(screenshotDir)await page.screenshot({path:`${screenshotDir}/${name}.png`,fullPage:!name.startsWith('mobile-')});};
      for(const [width,height] of [[390,844],[430,932],[768,1024],[1440,900]]) {
        await page.setViewportSize({width,height});
        await page.goto(origin);
        console.log(`CMS_BROWSER: dashboard loaded at ${width}px`);
        assert(await page.getByRole('heading',{name:'今天要更新什麼？'}).isVisible());
        if(width===390 || width===1440){
          await page.addScriptTag({url:`${origin}/axe.min.js`});
          const report=await page.evaluate(()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}));
          console.log(`CMS_AXE dashboard ${width}px: ${report.violations.map(item=>item.id+':'+item.nodes.length).join(',')||'0 violations'}`);
        }
        if(width===1440)await capture('desktop-dashboard');
        await page.locator('.primary-nav [data-workspace-target="content"]').click();
        assert(await page.getByRole('heading',{name:'內容',exact:true}).isVisible());
        if(width===1440){
          await page.locator('#open-command').click();
          await page.locator('#command-query').fill('service');
          assert(await page.locator('#command-results button').count()>0,'command search finds pages by path');
          await page.keyboard.press('Escape');
          await page.locator('#command-dialog').waitFor({state:'hidden'});
          assert.equal(await page.evaluate(()=>document.activeElement?.id),'open-command','dialog restores focus');
        }
        if(width<=860){
          await page.locator('#open-page-drawer').click();
          assert(await page.locator('#page-explorer').isVisible());
          if(width===390)await capture('mobile-page-drawer-390');
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('#page-explorer').isVisible(),false,'Escape closes page drawer');
          assert.equal(await page.evaluate(()=>document.activeElement?.id),'open-page-drawer','drawer restores focus');
          await page.locator('#open-page-drawer').click();
        }
        await page.locator('#page-filter').fill('首頁');
        await page.waitForFunction(()=>document.querySelector('#page-list-status')?.textContent?.startsWith('顯示 1 /'));
        const priorRuntimeRequests=editorRuntimeRequests;
        await page.locator('#page-tree .tree-page').first().click();
        console.log('CMS_BROWSER: page selected');
        assert(await page.getByRole('heading',{name:'首頁',exact:true}).isVisible());
        if(width<=860) assert.equal(await page.locator('#page-explorer').isVisible(),false,'compact drawer closes after selecting a page');
        await page.waitForFunction(()=>!document.querySelector('#page-draft-status')?.textContent?.includes('正在讀取'));
        await page.locator('#tab-seo').click();
        assert.equal(await page.locator('#tab-seo').getAttribute('aria-selected'),'true');
        if(width===1440)await capture('desktop-seo');
        await page.locator('#tab-versions').click();
        await page.locator('#tab-content').click();
        await page.waitForFunction(()=>document.querySelector('#page-frame')?.getAttribute('src')?.startsWith('/api/page-preview?'));
        assert.equal(new URL(await page.locator('#page-frame').getAttribute('src'),origin).pathname,'/api/page-preview');
        assert.equal((await page.locator('#page-frame').getAttribute('sandbox')).includes('allow-same-origin'),false,
          'published page scripts must not share the authenticated admin origin');
        const frame=page.frameLocator('#page-frame');
        await frame.locator('h1[contenteditable="true"]').waitFor();
        if(width===390)await capture('mobile-content-390');
        if(width===1440)await capture('desktop-content');
        if(width===390 || width===1440){
          const report=await page.evaluate(()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}));
          console.log(`CMS_AXE content ${width}px: ${report.violations.map(item=>item.id+':'+item.nodes.length).join(',')||'0 violations'}`);
        }
        await page.evaluate(()=>window.scrollTo(0,800));
        await page.waitForTimeout(50);
        const toolbarBox=await page.locator('.visual-toolbar').boundingBox();
        if(width<=430)assert(toolbarBox.y>=-2 && toolbarBox.y<=4,`selected-page toolbar must remain sticky at ${width}px: ${toolbarBox.y}`);
        await page.evaluate(()=>window.scrollTo(0,0));
        assert.equal(editorRuntimeRequests,priorRuntimeRequests+1,'admin iframe must load the editor runtime');
        assert.equal(editorManifestRequests,editorRuntimeRequests,'admin iframe must load its page-specific editor manifest');
        await frame.locator('h1[contenteditable="true"]').fill('測試已修改');
        await page.getByText('頁面文字有變更 · 儲存後才會進入發布流程',{exact:true}).waitFor();
        assert.equal(await page.locator('#page-save').isEnabled(),true,'editing the rendered page enables draft save');
        if(width===390)await capture('mobile-editor-390');
        await page.locator('.primary-nav [data-workspace-target="services"]').click();
        console.log('CMS_BROWSER: structured editor opened');
        await page.getByRole('button',{name:/本機測試草稿/}).click();
        assert(await page.getByLabel('活動名稱',{exact:true}).isVisible());
        if(width===1440)await capture('desktop-activity');
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'editor must fit viewport');
        await page.getByRole('button',{name:'預覽發布內容',exact:true}).click();
        await page.locator('#preview-dialog').waitFor({state:'visible'});
        assert(await page.getByRole('button',{name:/確認發布/}).isVisible());
        await page.getByRole('button',{name:'關閉',exact:true}).click();
        await page.locator('.primary-nav [data-workspace-target="publishing"]').click();
        assert(await page.getByRole('heading',{name:'從草稿到上線'}).isVisible());
        assert.match(await page.locator('#publications').textContent(),/HTTP 驗證.*Snapshot 驗證.*Native 驗證/s);
        assert.match(await page.locator('#publications').textContent(),/NOT CHECKED/);
        await page.locator('[data-release-filter="queued"]').click();
        assert.equal(await page.locator('#publications .publication:not([hidden]):not([data-status="queued"])').count(),0);
        await page.locator('[data-release-filter="all"]').click();
        if(width===1440)await capture('desktop-publishing');
        await page.locator('.primary-nav [data-workspace-target="system"]').click();
        assert(await page.getByRole('heading',{name:'目前權限'}).isVisible());
        await page.evaluate(()=>window.scrollTo(0,0));
        if(screenshotDir)await capture(`viewport-${width}`);
      }
      const indexCards = Array.from({length: 11}, (_, index) =>
        `<article data-news-categories="public"><h2>項目 ${index + 1}</h2></article>`).join("");
      for (const [script, section, grid] of [["news.js", 'id="news-reports"', "data-news-grid"], ["press.js", "data-press-index", "data-press-grid"]]) {
        const runtime = readFileSync(root + "../" + script, "utf8");
        for (const editing of [false, true]) {
          const indexPage = await context.newPage();
          await indexPage.setContent(`<!doctype html><html><head>${editing ? '<script data-cms-editor-loader data-cms-editor-enabled="true"></script>' : ''}</head><body><main><section ${section}><div ${grid}>${indexCards}</div></section></main></body></html>`);
          await indexPage.addScriptTag({content: runtime});
          assert.equal(await indexPage.locator(`[${grid}] article`).count(), editing ? 11 : 10,
            editing ? `${script} CMS preview must preserve every source-order card for manifest selectors` : `${script} public pagination must keep working`);
          await indexPage.close();
        }
      }
      await context.close();
    } finally { await browser.close(); }
    console.log('PASS: mobile and desktop live editor runtime, copy editing and publication preview browser flow');
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
