import { owner, runner, csrf, boundedJSON, HttpError } from "./security.ts";
import { validate, validatePageFields } from "./validation.ts";
import { pagePreviewContentSecurityPolicy, preparePagePreviewDocument } from "./page-preview.ts";
import { validateCaseDraft } from "./case-draft.ts";
import { validateHomeDraft } from "./home-draft.ts";
type Document = {
  id: string;
  domain: string;
  record_key: string;
  payload: string;
  base_hash: string;
  version: number;
  updated_at: string;
  actor: string;
};
export function canAdvancePublication(current: string, next: string): boolean {
  // Polling may observe both CI and deploy finishing between runs. Allow forward skips,
  // never regression or resurrection of a terminal publication.
  const transitions: Record<string,string[]> = {
    processing: ["pr_created", "failed", "no_change"],
    pr_created: ["pr_created", "merged", "deployed", "verified", "closed", "failed"],
    merged: ["merged", "deployed", "verified", "failed"],
    deployed: ["deployed", "verified", "failed"]
  };
  return Boolean(transitions[current]?.includes(next));
}

const json = (value: unknown, status = 200) => Response.json(value, { status });
const iso = () => new Date().toISOString();
const idOK = (id: string) => /^[a-z0-9-]{1,100}$/.test(id);
const version = (v: unknown) => {
  if (!Number.isSafeInteger(v) || Number(v) < 1)
    throw new HttpError(400, "版本不正確");
  return Number(v);
};
function protect(response: Response) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self' https://www.huiwen.tw; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Robots-Tag": "noindex, nofollow",
  })) {
    if (["X-Frame-Options", "Content-Security-Policy"].includes(k) && r.headers.has(k)) continue;
    r.headers.set(k, v);
  }
  return r;
}
async function internal(request: Request, env: Env, path: string) {
  const run = await runner(request, env);
  if (request.method !== "POST") throw new HttpError(405, "不支援的方法");
  const b = await boundedJSON(request);
  if (path === "/internal/sync") {
    if (
      !Array.isArray(b.sources) ||
      b.sources.length > 300 ||
      (b.pages !== undefined && (!Array.isArray(b.pages) || b.pages.length < 1 || b.pages.length > 200)) ||
      !/^[a-f0-9]{40}$/.test(String(b.commit))
    )
      throw new HttpError(400, "來源快照格式錯誤");
    const stmts = [];
    for (const s of b.sources) {
      if (
        !s ||
        typeof s !== "object" ||
        !idOK(s.id) ||
        !["events", "legal-schedule"].includes(s.domain) ||
        !idOK(s.record_key) ||
        !/^sha256:[a-f0-9]{64}$/.test(s.hash)
      )
        throw new HttpError(400, "來源識別格式錯誤");
      const payload = JSON.stringify(validate(s.domain, s.payload));
      stmts.push(
        env.DB.prepare(
          "INSERT INTO published_sources VALUES(?,?,?,?,?,?) ON CONFLICT(domain,record_key) DO UPDATE SET payload=excluded.payload,source_hash=excluded.source_hash,commit_sha=excluded.commit_sha,observed_at=excluded.observed_at",
        ).bind(s.domain, s.record_key, payload, s.hash, b.commit, iso()),
      );
      stmts.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO documents VALUES(?,?,?,?,?,1,?,?)",
        ).bind(
          s.id,
          s.domain,
          s.record_key,
          payload,
          s.hash,
          iso(),
          `runner:${run}`,
        ),
      );
    }
    if (b.pages !== undefined) {
      const seen = new Set<string>();
      const publicPath = /^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/;
      const sourcePath = /^(?:data\/[a-z0-9-]+\.json|(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html)$/;
      for (const p of b.pages) {
        if (
          !p || typeof p !== "object" ||
          Object.keys(p).some((k) => !["path", "title", "source", "kind", "editorScope", "publicationStatus"].includes(k)) ||
          typeof p.path !== "string" || !publicPath.test(p.path) || seen.has(p.path) ||
          typeof p.title !== "string" || !p.title.trim() || p.title.length > 250 || /[\u0000-\u001f<>]/.test(p.title) ||
          typeof p.source !== "string" || !sourcePath.test(p.source) ||
          !["generated", "composite", "static", "system", "legacy-redirect", "excluded-intake"].includes(p.kind) ||
          !["none", "partial"].includes(p.editorScope) ||
          (p.publicationStatus !== undefined && !["published", "unpublished", "deleted"].includes(p.publicationStatus))
        ) throw new HttpError(400, "公開頁面目錄格式錯誤");
        seen.add(p.path);
      }
      const catalogState = await env.DB.prepare(
        "SELECT COUNT(*) AS count,MIN(commit_sha) AS first_sha,MAX(commit_sha) AS last_sha FROM published_pages",
      ).first<{ count: number; first_sha: string | null; last_sha: string | null }>();
      if (catalogState?.count !== b.pages.length || catalogState.first_sha !== b.commit || catalogState.last_sha !== b.commit) {
        stmts.push(env.DB.prepare("DELETE FROM published_pages"));
        for (const p of b.pages)
          stmts.push(env.DB.prepare("INSERT INTO published_pages VALUES(?,?,?,?,?,?,?)")
            .bind(p.path, p.title, p.source, p.kind, p.editorScope, b.commit, iso()));
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ synced: b.sources.length, pages: b.pages?.length ?? 0 });
  }
  if (path === "/internal/claim") {
    const now = Date.now(),
      lease = crypto.randomUUID();
    const row = await env.DB.prepare(
      "UPDATE publications SET status='processing',lease=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=(SELECT id FROM publications WHERE status='queued' OR (status='processing' AND lease_until<?) ORDER BY created_at LIMIT 1) RETURNING *",
    )
      .bind(lease, now + 30 * 60000, iso(), now)
      .first();
    return json({ publication: row });
  }
  if (path === "/internal/claim-page") {
    const now = Date.now(), lease = crypto.randomUUID();
    const row = await env.DB.prepare(
      "UPDATE page_publications SET status='processing',lease=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=(SELECT id FROM page_publications WHERE status='queued' OR (status='processing' AND lease_until<?) ORDER BY created_at LIMIT 1) RETURNING *",
    ).bind(lease, now + 30 * 60000, iso(), now).first();
    return json({ publication: row });
  }
  if (path === "/internal/queue-head") {
    const now = Date.now();
    const [document, page] = await Promise.all([
      env.DB.prepare("SELECT created_at FROM publications WHERE status='queued' OR (status='processing' AND lease_until<?) ORDER BY created_at LIMIT 1")
        .bind(now).first<{created_at:string}>(),
      env.DB.prepare("SELECT created_at FROM page_publications WHERE status='queued' OR (status='processing' AND lease_until<?) ORDER BY created_at LIMIT 1")
        .bind(now).first<{created_at:string}>(),
    ]);
    return json({ next: !document ? page ? "page" : null : !page ? "document" : document.created_at <= page.created_at ? "document" : "page" });
  }
  if (path === "/internal/pending")
    return json({
      publications: (
        await env.DB.prepare(
          "SELECT * FROM publications WHERE status IN ('pr_created','merged','deployed') ORDER BY created_at LIMIT 50",
        ).all()
      ).results,
    });
  if (path === "/internal/pending-pages")
    return json({ publications: (await env.DB.prepare(
      "SELECT * FROM page_publications WHERE status IN ('pr_created','merged','deployed') ORDER BY created_at LIMIT 50",
    ).all()).results });
  if (path === "/internal/receipt") {
    const states = [
      "pr_created",
      "failed",
      "no_change",
      "closed",
      "merged",
      "deployed",
      "verified",
    ];
    if (
      !idOK(String(b.id)) ||
      !states.includes(String(b.status)) ||
      typeof b.message !== "string" ||
      b.message.length > 1500 ||
      (b.pr_number !== null &&
        b.pr_number !== undefined &&
        (!Number.isSafeInteger(b.pr_number) || Number(b.pr_number) < 1)) ||
      (b.commit_sha !== undefined &&
        b.commit_sha !== null &&
        !/^[a-f0-9]{40}$/.test(String(b.commit_sha)))
    )
      throw new HttpError(400, "回執格式不正確");
    const current = await env.DB.prepare(
      "SELECT status,lease,pr_number FROM publications WHERE id=?",
    )
      .bind(b.id)
      .first<{ status: string; lease: string; pr_number: number }>();
    if (!current) throw new HttpError(404, "找不到發布要求");
    if (
      current.status === "processing" &&
      (!b.lease || b.lease !== current.lease)
    )
      throw new HttpError(409, "發布租約已改變");
    if (!canAdvancePublication(current.status, String(b.status)))
      throw new HttpError(409, "發布狀態已改變");
    await env.DB.prepare(
      "UPDATE publications SET status=?,message=?,pr_number=COALESCE(?,pr_number),commit_sha=COALESCE(?,commit_sha),updated_at=? WHERE id=? AND status=?",
    )
      .bind(
        b.status,
        b.message,
        b.pr_number ?? null,
        b.commit_sha ?? null,
        iso(),
        b.id,
        current.status,
      )
      .run();
    return json({ saved: true });
  }
  if (path === "/internal/receipt-page") {
    const states = ["pr_created", "failed", "no_change", "closed", "merged", "deployed", "verified"];
    if (!idOK(String(b.id)) || !states.includes(String(b.status)) || typeof b.message !== "string" || b.message.length > 1500 ||
        (b.pr_number != null && (!Number.isSafeInteger(b.pr_number) || Number(b.pr_number) < 1)) ||
        (b.commit_sha != null && !/^[a-f0-9]{40}$/.test(String(b.commit_sha))))
      throw new HttpError(400, "頁面發布回執格式不正確");
    const current = await env.DB.prepare("SELECT status,lease,path,operation FROM page_publications WHERE id=?")
      .bind(b.id).first<{status:string;lease:string|null;path:string;operation:string}>();
    if (!current) throw new HttpError(404, "找不到頁面發布要求");
    if (current.status === "processing" && (!b.lease || b.lease !== current.lease)) throw new HttpError(409, "頁面發布租約已改變");
    if (!canAdvancePublication(current.status, String(b.status))) throw new HttpError(409, "頁面發布狀態已改變");
    await env.DB.batch([
      env.DB.prepare("UPDATE page_publications SET status=?,message=?,pr_number=COALESCE(?,pr_number),commit_sha=COALESCE(?,commit_sha),updated_at=? WHERE id=? AND status=?")
        .bind(b.status,b.message,b.pr_number??null,b.commit_sha??null,iso(),b.id,current.status),
      ...(b.status === "deployed" || b.status === "verified" ? [env.DB.prepare(
        "UPDATE page_edits SET publication_status=?,updated_at=? WHERE path=?",
      ).bind(current.operation === "unpublish" ? "unpublished" : current.operation === "delete" ? "deleted" : "published",iso(),current.path)] : []),
    ]);
    return json({ saved: true });
  }
  throw new HttpError(404, "找不到功能");
}
async function handle(request: Request, env: Env) {
  const u = new URL(request.url);
  if (u.origin === env.PUBLISHER_ORIGIN) {
    if (!u.pathname.startsWith("/internal/"))
      throw new HttpError(404, "找不到頁面");
    return internal(request, env, u.pathname);
  }
  if (u.origin !== env.ADMIN_ORIGIN) throw new HttpError(404, "找不到頁面");
  const actor = await owner(request, env);
  const account = await env.DB.prepare(
    "SELECT role,disabled FROM accounts WHERE id=?",
  )
    .bind(actor.id)
    .first<{ role: string; disabled: number }>();
  if (!account || account.disabled || account.role !== "owner")
    throw new HttpError(403, "帳號未開放");
  if (!["GET", "HEAD"].includes(request.method))
    csrf(request, env.ADMIN_ORIGIN, actor.csrf);
  if (u.pathname === "/api/session" && request.method === "GET")
    return json({
      login: env.OWNER_LOGIN,
      role: account.role,
      csrf: actor.csrf,
      passwordLogin: false,
    });
  if (u.pathname === "/api/documents" && request.method === "GET")
    return json({
      documents: (
        await env.DB.prepare(
          "SELECT d.*, s.source_hash AS published_hash FROM documents d LEFT JOIN published_sources s ON s.domain=d.domain AND s.record_key=d.record_key ORDER BY d.updated_at DESC LIMIT 300",
        ).all()
      ).results,
    });
  if (u.pathname === "/api/pages" && request.method === "GET")
    return json({
      pages: (await env.DB.prepare(
        "SELECT p.path,p.title,p.source_path,p.source_kind,p.editor_scope,p.commit_sha,p.observed_at,COALESCE(e.publication_status,'published') AS publication_status,COALESCE(e.version,0) AS draft_version,e.updated_at AS draft_updated_at,(SELECT q.operation FROM page_publications q WHERE q.path=p.path AND q.status IN ('queued','processing','pr_created','merged','deployed') ORDER BY q.created_at DESC LIMIT 1) AS pending_operation FROM published_pages p LEFT JOIN page_edits e ON e.path=p.path ORDER BY p.path",
      ).all()).results,
    });
  const isEditablePage = async (path: string) => {
    const row = await env.DB.prepare("SELECT source_kind,commit_sha FROM published_pages WHERE path=?").bind(path).first<{source_kind:string;commit_sha:string}>();
    if (!row || ["system", "legacy-redirect", "excluded-intake"].includes(row.source_kind))
      throw new HttpError(404, "這個頁面目前不開放內容編輯");
    return row;
  };
  if (u.pathname === "/api/case" && request.method === "GET") {
    const path = u.searchParams.get("path") || "";
    const match = /^achievement-([a-z0-9-]+)\.html$/.exec(path);
    if (!match) throw new HttpError(400, "這不是政績專頁");
    await isEditablePage(path);
    let upstream: Response;
    try {
      upstream = await fetch("https://www.huiwen.tw/data/achievements-public.json", {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" }, cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
    } catch { throw new HttpError(502, "無法讀取正式站政績資料"); }
    if (!upstream.ok || Number(upstream.headers.get("content-length") || 0) > 1_000_000)
      throw new HttpError(502, "正式站政績資料暫時無法載入");
    const body = await upstream.text();
    if (body.length > 1_000_000) throw new HttpError(502, "正式站政績資料超出大小限制");
    let rows: unknown;
    try { rows = JSON.parse(body); } catch { throw new HttpError(502, "正式站政績資料格式不正確"); }
    const row = Array.isArray(rows) ? rows.find((item) => item?.id === match[1]) : null;
    if (!row) throw new HttpError(404, "找不到這筆政績資料");
    return json({ case: row });
  }
  if (u.pathname === "/api/home" && request.method === "GET") {
    const page = await isEditablePage("index.html");
    if (!/^[a-f0-9]{40}$/.test(page.commit_sha)) throw new HttpError(502, "首頁來源版本不正確");
    const source = `https://raw.githubusercontent.com/Hong1998tw/chen-huiwen-website/${page.commit_sha}/data/civic-home.json`;
    let homeResponse: Response, casesResponse: Response;
    try {
      [homeResponse, casesResponse] = await Promise.all([
        fetch(source, { cache: "no-store", signal: AbortSignal.timeout(10000) }),
        fetch("https://www.huiwen.tw/data/achievements-public.json", { cache: "no-store", signal: AbortSignal.timeout(10000) }),
      ]);
    } catch { throw new HttpError(502, "無法讀取首頁專題來源"); }
    if (!homeResponse.ok || !casesResponse.ok ||
        Number(homeResponse.headers.get("content-length") || 0) > 20000 ||
        Number(casesResponse.headers.get("content-length") || 0) > 1000000)
      throw new HttpError(502, "首頁專題來源暫時無法載入");
    const [homeText, casesText] = await Promise.all([homeResponse.text(), casesResponse.text()]);
    if (homeText.length > 20000 || casesText.length > 1000000) throw new HttpError(502, "首頁專題來源超出大小限制");
    let home: ReturnType<typeof validateHomeDraft>, cases: unknown;
    try { home = validateHomeDraft(JSON.parse(homeText)); cases = JSON.parse(casesText); }
    catch { throw new HttpError(502, "首頁專題來源格式不正確"); }
    const ids = [home.featured, ...home.reading];
    if (!Array.isArray(cases) || ids.some(id => !cases.some(row => row?.id === id)))
      throw new HttpError(502, "首頁專題與公開資料不一致");
    return json({ home, cases });
  }
  if (u.pathname === "/api/page-preview" && request.method === "GET") {
    const path = u.searchParams.get("path") || "";
    if (!/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/.test(path))
      throw new HttpError(400, "頁面路徑格式不正確");
    const page = await env.DB.prepare(
      "SELECT p.editor_scope,p.source_kind,COALESCE(e.publication_status,'published') AS publication_status FROM published_pages p LEFT JOIN page_edits e ON e.path=p.path WHERE p.path=?",
    ).bind(path).first<{editor_scope:string;source_kind:string;publication_status:string}>();
    if (!page || page.publication_status !== "published")
      throw new HttpError(404, "此頁目前沒有正式發布版本");
    const editable = page.editor_scope === "partial" && !["system", "legacy-redirect", "excluded-intake"].includes(page.source_kind);
    if (editable) await isEditablePage(path);

    const upstreamURL = new URL(path, "https://www.huiwen.tw/");
    let upstream: Response;
    try {
      upstream = await fetch(upstreamURL, {
        headers: { Accept: "text/html", "Cache-Control": "no-cache, no-store" },
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new HttpError(502, "正式頁面暫時無法載入，請稍後重試");
    }
    if (upstream.status !== 200 || !upstream.headers.get("content-type")?.includes("text/html"))
      throw new HttpError(502, "正式頁面暫時無法載入，請稍後重試");
    const source = await upstream.text();
    if (new TextEncoder().encode(source).byteLength > 2_000_000)
      throw new HttpError(502, "此頁內容超過預覽大小限制");
    let document: string;
    try {
      document = preparePagePreviewDocument(source, path, env.ADMIN_ORIGIN, editable);
    } catch {
      throw new HttpError(502, "正式頁面缺少必要的預覽結構，請重新部署官網後再試");
    }
    return new Response(document, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": pagePreviewContentSecurityPolicy(env.ADMIN_ORIGIN),
      },
    });
  }
  if (u.pathname === "/api/page-draft" && request.method === "GET") {
    const path = u.searchParams.get("path") || "";
    await isEditablePage(path);
    return json({ draft: await env.DB.prepare("SELECT path,payload,base_commit,version,publication_status,updated_at FROM page_edits WHERE path=?")
      .bind(path).first() });
  }
  if (u.pathname === "/api/page-draft/history" && request.method === "GET") {
    const path = u.searchParams.get("path") || "";
    await isEditablePage(path);
    return json({ versions: (await env.DB.prepare(
      "SELECT version,base_commit,publication_status,created_at,actor FROM page_edit_versions WHERE path=? ORDER BY version DESC LIMIT 100",
    ).bind(path).all()).results });
  }
  if (u.pathname === "/api/page-draft" && request.method === "PUT") {
    const b = await boundedJSON(request), path = String(b.path || "");
    const page = await isEditablePage(path);
    if (!Number.isSafeInteger(b.version) || Number(b.version) < 0 || b.baseCommit !== page.commit_sha)
      throw new HttpError(409, "頁面版本已更新，請重新載入正式頁面");
    const fields = validatePageFields(b.fields);
    const isCase = /^achievement-[a-z0-9-]+\.html$/.test(path);
    if (isCase !== (b.case !== undefined) || isCase !== (b.caseBase !== undefined)) throw new HttpError(400, "此頁草稿類型不正確");
    const isHome = path === "index.html";
    if ((b.home !== undefined || b.homeBase !== undefined) && (!isHome || b.home === undefined || b.homeBase === undefined))
      throw new HttpError(400, "此頁草稿類型不正確");
    const caseDraft = isCase ? validateCaseDraft(b.case) : undefined;
    if (isCase) validateCaseDraft(b.caseBase);
    const homeDraft = b.home !== undefined ? validateHomeDraft(b.home) : undefined;
    const homeBase = b.homeBase !== undefined ? validateHomeDraft(b.homeBase) : undefined;
    const existing = await env.DB.prepare("SELECT payload,version FROM page_edits WHERE path=?").bind(path)
      .first<{payload:string;version:number}>();
    const currentVersion = existing?.version || 0;
    if (currentVersion !== Number(b.version)) throw new HttpError(409, "另一個視窗已儲存較新草稿，請重新載入");
    const old = existing ? JSON.parse(existing.payload) as Record<string,unknown> : {fields:{}};
    const merged = isCase ? fields : {...(old.fields as Record<string,unknown> || {}), ...fields};
    const payload = JSON.stringify(isCase ? {fields:merged,case:caseDraft,caseBase:b.caseBase} :
      homeDraft ? {fields:merged,home:homeDraft,homeBase} : {fields:merged});
    const now = iso();
    if (existing) {
      const result = await env.DB.prepare("UPDATE page_edits SET payload=?,base_commit=?,version=version+1,updated_at=?,actor=? WHERE path=? AND version=?")
        .bind(payload,page.commit_sha,now,actor.id,path,currentVersion).run();
      if (result.meta.changes < 1) throw new HttpError(409,"另一個視窗已儲存較新草稿，請重新載入");
    } else {
      await env.DB.prepare("INSERT INTO page_edits(path,payload,base_commit,version,publication_status,updated_at,actor) VALUES(?,?,?,1,'published',?,?)")
        .bind(path,payload,page.commit_sha,now,actor.id).run();
    }
    return json({path,version:currentVersion+1});
  }
  if (u.pathname === "/api/page-draft/restore" && request.method === "POST") {
    const b = await boundedJSON(request), path = String(b.path || "");
    await isEditablePage(path);
    const expected = Number.isSafeInteger(b.version) && Number(b.version) >= 0 ? Number(b.version) : -1;
    const restoreVersion = Number.isSafeInteger(b.restoreVersion) && Number(b.restoreVersion) >= 1 ? Number(b.restoreVersion) : -1;
    if (expected < 0 || restoreVersion < 1) throw new HttpError(400, "版本還原要求格式不正確");
    const old = await env.DB.prepare("SELECT payload,base_commit FROM page_edit_versions WHERE path=? AND version=?")
      .bind(path,restoreVersion).first<{payload:string;base_commit:string}>();
    if (!old) throw new HttpError(404,"找不到該頁歷史版本");
    const current = await env.DB.prepare("SELECT version FROM page_edits WHERE path=?").bind(path).first<{version:number}>();
    if ((current?.version || 0) !== expected) throw new HttpError(409,"草稿已有更新，請重新載入後再還原");
    if (!current) throw new HttpError(409,"目前尚無草稿版本");
    const result = await env.DB.prepare("UPDATE page_edits SET payload=?,base_commit=?,version=version+1,updated_at=?,actor=? WHERE path=? AND version=?")
      .bind(old.payload,old.base_commit,iso(),actor.id,path,expected).run();
    if (result.meta.changes < 1) throw new HttpError(409,"另一個視窗已儲存新版本");
    return json({path,version:expected+1});
  }
  const pageOperation = u.pathname === "/api/page-draft/publish" && request.method === "POST";
  if (pageOperation) {
    const b = await boundedJSON(request), path = String(b.path || ""), operation = String(b.operation || "publish");
    await isEditablePage(path);
    if (!Number.isSafeInteger(b.version) || Number(b.version)<1 || !["publish","unpublish","delete","restore"].includes(operation))
      throw new HttpError(400,"頁面發布要求格式不正確");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT OR IGNORE INTO page_publications(id,path,version,payload,base_commit,operation,status,created_at,updated_at,actor) SELECT ?,path,version,payload,base_commit,?,'queued',?,?,? FROM page_edits WHERE path=? AND version=?")
      .bind(id,operation,iso(),iso(),actor.id,path,Number(b.version)).run();
    const receipt = await env.DB.prepare("SELECT id,status FROM page_publications WHERE path=? AND version=? AND operation=?")
      .bind(path,Number(b.version),operation).first();
    if (!receipt) throw new HttpError(409,"草稿版本已更新，請重新載入後發布");
    return json(receipt,202);
  }
  if (u.pathname === "/api/publications" && request.method === "GET")
    return json({
      publications: (
        await env.DB.prepare(
          "SELECT id,document_id,version,status,created_at,updated_at,pr_number,message,commit_sha,NULL AS path,NULL AS operation FROM publications UNION ALL SELECT id,NULL AS document_id,version,status,created_at,updated_at,pr_number,message,commit_sha,path,operation FROM page_publications ORDER BY created_at DESC LIMIT 100",
        ).all()
      ).results,
    });
  if (u.pathname === "/api/documents" && request.method === "POST") {
    const b = await boundedJSON(request),
      domain = String(b.domain),
      payload = validate(domain, b.payload),
      id = crypto.randomUUID();
    // One monthly schedule slot always edits the existing document; this prevents duplicate month writers.
    if (domain !== "events")
      throw new HttpError(400, "律師時間表請編輯既有月表");
    await env.DB.prepare("INSERT INTO documents VALUES(?,?,?,?,?,1,?,?)")
      .bind(
        id,
        domain,
        `event-${id}`,
        JSON.stringify(payload),
        "absent",
        iso(),
        actor.id,
      )
      .run();
    return json({ id }, 201);
  }
  const m = u.pathname.match(
    /^\/api\/documents\/([a-z0-9-]+)(?:\/(history|restore|refresh|publish))?$/,
  );
  if (m) {
    const [, id, action] = m;
    if (!idOK(id)) throw new HttpError(404, "找不到內容");
    const d = await env.DB.prepare("SELECT * FROM documents WHERE id=?")
      .bind(id)
      .first<Document>();
    if (!d) throw new HttpError(404, "找不到內容");
    if (request.method === "GET" && action === "history")
      return json({
        versions: (
          await env.DB.prepare(
            "SELECT * FROM versions WHERE document_id=? ORDER BY version DESC LIMIT 100",
          )
            .bind(id)
            .all()
        ).results,
      });
    if (request.method === "GET" && !action) return json({ document: d });
    const b = await boundedJSON(request),
      expected = version(b.version);
    if (request.method === "POST" && action === "publish") {
      const payload = validate(d.domain, JSON.parse(d.payload));
      void payload;
      const pubId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO publications(id,document_id,version,domain,record_key,payload,base_hash,status,created_at,updated_at,actor) SELECT ?,id,version,domain,record_key,payload,base_hash,'queued',?,?,? FROM documents WHERE id=? AND version=?",
      )
        .bind(pubId, iso(), iso(), actor.id, id, expected)
        .run();
      const receipt = await env.DB.prepare(
        "SELECT id,status FROM publications WHERE document_id=? AND version=?",
      )
        .bind(id, expected)
        .first();
      if (!receipt)
        throw new HttpError(409, "內容版本已更新，請重新載入後發布");
      return json(receipt, 202);
    }
    let payload: unknown = b.payload,
      base = d.base_hash;
    if (request.method === "POST" && action === "restore") {
      const old = await env.DB.prepare(
        "SELECT payload,base_hash FROM versions WHERE document_id=? AND version=?",
      )
        .bind(id, version(b.restoreVersion))
        .first<{ payload: string; base_hash: string }>();
      if (!old) throw new HttpError(404, "找不到歷史版本");
      payload = JSON.parse(old.payload);
      base = old.base_hash;
    } else if (request.method === "POST" && action === "refresh") {
      const s = await env.DB.prepare(
        "SELECT payload,source_hash FROM published_sources WHERE domain=? AND record_key=?",
      )
        .bind(d.domain, d.record_key)
        .first<{ payload: string; source_hash: string }>();
      if (!s) throw new HttpError(404, "尚無已發布版本");
      payload = JSON.parse(s.payload);
      base = s.source_hash;
    } else if (request.method !== "PUT" || action)
      throw new HttpError(405, "不支援的方法");
    const clean = validate(d.domain, payload);
    const result = await env.DB.prepare(
      "UPDATE documents SET payload=?,base_hash=?,version=version+1,updated_at=?,actor=? WHERE id=? AND version=?",
    )
      .bind(JSON.stringify(clean), base, iso(), actor.id, id, expected)
      .run();
    if (result.meta.changes < 1)
      throw new HttpError(
        409,
        "另一個視窗已儲存新版本；你的內容仍留在表單，請先複製後重新載入",
      );
    return json({ id, version: expected + 1 });
  }
  if (u.pathname.startsWith("/api/")) throw new HttpError(404, "找不到功能");
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "不支援的方法");
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return protect(await handle(request, env));
    } catch (e) {
      if (e instanceof HttpError)
        return protect(json({ error: e.message }, e.status));
      console.error(
        JSON.stringify({
          event: "cms_request_failed",
          requestId: crypto.randomUUID(),
        }),
      );
      return protect(
        json({ error: "暫時無法完成操作，請稍後重試；原草稿不會被刪除" }, 500),
      );
    }
  },
} satisfies ExportedHandler<Env>;
