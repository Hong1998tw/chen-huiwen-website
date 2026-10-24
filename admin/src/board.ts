// 布告欄審核（先審後刊）。只在 owner() 驗證、帳號角色與 CSRF 檢查之後被呼叫。
// 動作只有三個：確認（刊登）、封存（保留紀錄但不顯示）、刪除（永久）。
import { HttpError } from "./security.ts";

/** 與 board/src/rules.js 相同（board/test/rules.test.mjs 會檢查）：2026-12-28 00:00 台北時間。 */
export const BOARD_PURGE_AT = "2026-12-27T16:00:00.000Z";
export const BOARD_DEFAULT_NICKNAME = "鳳山鄉親";
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUTE = /^\/api\/board-notes(?:\/([^/]+)(?:\/(publish|archive))?)?$/;

type BoardNote = {
  id: string;
  nickname: string;
  body: string;
  status: "pending" | "published" | "archived";
  created_at: string;
  reviewed_at: string | null;
};

export const boardPurged = (now = Date.now()) => now >= Date.parse(BOARD_PURGE_AT);

/** 處理 /api/board-notes 底下的路由；其他路徑回傳 null 交回主路由。 */
export async function boardAdmin(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  const [, id, action] = match;
  if (!id) {
    if (request.method !== "GET") throw new HttpError(405, "不支援的方法");
    if (boardPurged()) {
      // 查詢防線：保存期限已到，即使排程沒有執行也先刪除再回傳空清單。
      await env.DB.prepare("DELETE FROM board_notes").run();
      return Response.json({ notes: [], purgeAt: BOARD_PURGE_AT });
    }
    const { results } = await env.DB.prepare(
      "SELECT id,nickname,body,status,created_at,reviewed_at FROM board_notes ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 500",
    ).all<BoardNote>();
    return Response.json({
      notes: results.map((n) => ({ ...n, nickname: n.nickname || BOARD_DEFAULT_NICKNAME })),
      purgeAt: BOARD_PURGE_AT,
    });
  }
  if (!NOTE_ID.test(id)) throw new HttpError(404, "找不到這則留言");
  const now = new Date().toISOString();
  if (action && request.method === "POST") {
    const status = action === "publish" ? "published" : "archived";
    const row = await env.DB.prepare(
      "UPDATE board_notes SET status=?,reviewed_at=? WHERE id=? RETURNING id,status,reviewed_at",
    ).bind(status, now, id).first<{ id: string; status: string; reviewed_at: string }>();
    if (!row) throw new HttpError(404, "找不到這則留言，可能已被刪除");
    return Response.json(row);
  }
  if (!action && request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM board_notes WHERE id=?").bind(id).run();
    if (result.meta.changes < 1) throw new HttpError(404, "找不到這則留言，可能已被刪除");
    return Response.json({ id, deleted: true });
  }
  throw new HttpError(405, "不支援的方法");
}
