import { owner, runner, csrf, boundedJSON, HttpError } from "./security.ts";
import { validate } from "./validation.ts";
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
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Robots-Tag": "noindex, nofollow",
  }))
    r.headers.set(k, v);
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
      const publicPath = /^(?:[a-z0-9-]+\/)?[a-z0-9-]+\.html$/;
      const sourcePath = /^(?:data\/[a-z0-9-]+\.json|(?:[a-z0-9-]+\/)?[a-z0-9-]+\.html)$/;
      for (const p of b.pages) {
        if (
          !p || typeof p !== "object" ||
          Object.keys(p).some((k) => !["path", "title", "source", "kind", "editorScope"].includes(k)) ||
          typeof p.path !== "string" || !publicPath.test(p.path) || seen.has(p.path) ||
          typeof p.title !== "string" || !p.title.trim() || p.title.length > 250 || /[\u0000-\u001f<>]/.test(p.title) ||
          typeof p.source !== "string" || !sourcePath.test(p.source) ||
          !["generated", "composite", "static", "system", "legacy-redirect", "excluded-intake"].includes(p.kind) ||
          !["none", "partial"].includes(p.editorScope)
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
  if (path === "/internal/pending")
    return json({
      publications: (
        await env.DB.prepare(
          "SELECT * FROM publications WHERE status IN ('pr_created','merged','deployed') ORDER BY created_at LIMIT 50",
        ).all()
      ).results,
    });
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
        "SELECT path,title,source_path,source_kind,editor_scope,commit_sha,observed_at FROM published_pages ORDER BY path",
      ).all()).results,
    });
  if (u.pathname === "/api/publications" && request.method === "GET")
    return json({
      publications: (
        await env.DB.prepare(
          "SELECT id,document_id,version,status,created_at,updated_at,pr_number,message,commit_sha FROM publications ORDER BY created_at DESC LIMIT 100",
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
