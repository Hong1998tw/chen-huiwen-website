// huiwen-board：慧文政績島布告欄的公開 API（board.huiwen.tw）。
// 只做兩件事：讀取已刊登留言、收下待審留言。審核在 CMS 後台（admin.huiwen.tw）完成。
// 這支 Worker 與 CMS 共用 D1 資料庫，但所有 SQL 只碰 board_notes（board/test 有檢查）。
import {
  ALLOWED_ORIGINS,
  BOARD_PURGE_AT,
  IP_HASH_TTL_MS,
  MAX_REQUEST_BYTES,
  PUBLIC_LIMIT,
  RATE_LIMIT_MS,
  RuleError,
  displayNickname,
  isPurged,
  rateLimitKey,
  validTurnstileToken,
  validateNote,
} from "./rules.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string,string>} [headers] @param {string} [field] */
  constructor(status, code, message, headers = {}, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.field = field;
  }
}

const SECURITY_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Resource-Policy": "same-site",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "X-Robots-Tag": "noindex, nofollow",
};

/** @param {string|null} origin */
const allowedOrigin = (origin) => (origin && ALLOWED_ORIGINS.includes(origin) ? origin : null);

function respond(body, { status = 200, origin = null, cache = "no-store", headers = {} } = {}) {
  const h = new Headers(SECURITY_HEADERS);
  h.set("Cache-Control", cache);
  h.set("Vary", "Origin");
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Expose-Headers", "Retry-After");
  }
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: h });
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** 讀取有上限的 JSON 內容（同時檢查 Content-Length 與實際串流長度）。 */
async function boundedJSON(request) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "unsupported_media_type", "請以 JSON 格式送出留言。");
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_REQUEST_BYTES) throw new HttpError(413, "too_large", "送出的內容太大。");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid", "缺少留言內容。");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "too_large", "送出的內容太大。");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) { bytes.set(c, pos); pos += c.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value;
  } catch {
    throw new HttpError(400, "invalid", "留言格式不正確，請重新整理頁面後再試。");
  }
}

/** HMAC-SHA256(IP_SALT, IP) → 64 字元十六進位；只存這個雜湊，不存 IP。 */
async function hashIp(ip, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rateLimitKey(ip)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 只有本機測試可覆寫驗證網址；其他任何值一律使用 Cloudflare 官方端點。 */
function siteverifyUrl(env) {
  const override = env.TURNSTILE_VERIFY_URL;
  if (!override) return SITEVERIFY_URL;
  try {
    const u = new URL(override);
    if (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)) return u.href;
  } catch { /* fall through */ }
  return SITEVERIFY_URL;
}

async function verifyTurnstile(token, ip, env) {
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  form.append("idempotency_key", crypto.randomUUID());
  let result;
  try {
    const r = await fetch(siteverifyUrl(env), { method: "POST", body: form, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`siteverify ${r.status}`);
    result = await r.json();
  } catch {
    throw new HttpError(503, "verify_unavailable", "人機驗證服務暫時無法連線，請稍後再試。");
  }
  if (result?.success !== true)
    throw new HttpError(403, "turnstile_failed", "人機驗證未通過或已過期，請重新驗證後再送出。");
}

/** 保存期限到期：刪除全部留言。ip_hash 滿 1 天清空。由排程與查詢防線共用。 */
export async function maintain(env, now = Date.now()) {
  if (isPurged(now)) {
    await env.DB.prepare("DELETE FROM board_notes").run();
    return { purged: true };
  }
  await env.DB.prepare("UPDATE board_notes SET ip_hash=NULL WHERE ip_hash IS NOT NULL AND created_at<?")
    .bind(iso(now - IP_HASH_TTL_MS)).run();
  return { purged: false };
}

async function listPublished(env, origin, ctx) {
  if (isPurged()) {
    ctx?.waitUntil?.(maintain(env).catch(() => {}));
    return respond({ notes: [], closed: true, purgeAt: BOARD_PURGE_AT }, { origin, cache: "public, max-age=300" });
  }
  const { results } = await env.DB.prepare(
    "SELECT id,nickname,body,created_at FROM board_notes WHERE status='published' ORDER BY created_at DESC LIMIT ?",
  ).bind(PUBLIC_LIMIT).all();
  const notes = results.map((row) => ({
    id: row.id,
    nickname: displayNickname(row.nickname),
    body: row.body,
    created_at: row.created_at,
  }));
  return respond({ notes, closed: false, purgeAt: BOARD_PURGE_AT }, { origin, cache: "public, max-age=30" });
}

async function submit(request, env, origin) {
  if (!origin) throw new HttpError(403, "origin", "請從慧文政績島頁面留言。");
  if (isPurged()) throw new HttpError(410, "closed", "布告欄已結束收件，所有留言已依公告刪除。");
  if (!env.TURNSTILE_SECRET || !env.IP_SALT || String(env.IP_SALT).length < 16)
    throw new HttpError(503, "not_configured", "留言功能尚未設定完成，請稍後再試。");
  const input = await boundedJSON(request);
  let note;
  try {
    note = validateNote(input);
  } catch (error) {
    if (error instanceof RuleError) throw new HttpError(400, error.code, error.message, {}, error.field);
    throw error;
  }
  if (!validTurnstileToken(input.turnstileToken))
    throw new HttpError(400, "turnstile_missing", "請先完成人機驗證再送出。");

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ipHash = await hashIp(ip, env.IP_SALT);
  const now = Date.now();
  const since = iso(now - RATE_LIMIT_MS);
  const recent = await env.DB.prepare(
    "SELECT created_at FROM board_notes WHERE ip_hash=? AND created_at>? ORDER BY created_at DESC LIMIT 1",
  ).bind(ipHash, since).first();
  if (recent) throw rateLimited(recent.created_at, now);

  await verifyTurnstile(input.turnstileToken, ip, env);

  // 單一敘述同時檢查限流並寫入，避免同時送出兩則時都通過檢查。
  const id = crypto.randomUUID();
  const createdAt = iso(now);
  const result = await env.DB.prepare(
    "INSERT INTO board_notes(id,nickname,body,status,created_at,reviewed_at,ip_hash) SELECT ?,?,?,'pending',?,NULL,? WHERE NOT EXISTS (SELECT 1 FROM board_notes WHERE ip_hash=? AND created_at>?)",
  ).bind(id, note.nickname, note.body, createdAt, ipHash, ipHash, since).run();
  if (!result.meta || result.meta.changes < 1) throw rateLimited(createdAt, now);
  return respond({ id, status: "pending", nickname: displayNickname(note.nickname), body: note.body, created_at: createdAt }, { status: 201, origin });
}

function rateLimited(lastCreatedAt, now) {
  const wait = Math.max(1, Math.ceil((Date.parse(lastCreatedAt) + RATE_LIMIT_MS - now) / 1000));
  const minutes = Math.max(1, Math.ceil(wait / 60));
  return new HttpError(429, "rate_limited", `每 10 分鐘只能留言一次，請約 ${minutes} 分鐘後再試。`, { "Retry-After": String(wait) });
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const requestOrigin = request.headers.get("Origin");
  const origin = allowedOrigin(requestOrigin);
  if (url.pathname !== "/api/board") throw new HttpError(404, "not_found", "找不到這個功能。");
  if (requestOrigin && !origin) throw new HttpError(403, "origin", "這個網站不能使用布告欄。");
  if (request.method === "OPTIONS") {
    if (!origin) throw new HttpError(403, "origin", "這個網站不能使用布告欄。");
    return respond(null, {
      status: 204,
      origin,
      headers: {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  if (request.method === "GET") return listPublished(env, origin, ctx);
  if (request.method === "POST") return submit(request, env, origin);
  throw new HttpError(405, "method", "不支援這個操作。", { Allow: "GET, POST, OPTIONS" });
}

export default {
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request.headers.get("Origin"));
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError)
        return respond(
          { error: error.message, code: error.code, ...(error.field ? { field: error.field } : {}) },
          { status: error.status, origin, headers: error.headers },
        );
      console.error(JSON.stringify({ event: "board_request_failed", requestId: crypto.randomUUID() }));
      return respond({ error: "暫時無法完成，請稍後再試。", code: "internal" }, { status: 500, origin });
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(maintain(env));
  },
};
