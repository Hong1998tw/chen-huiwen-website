-- 慧文政績島布告欄（先審後刊）。
-- 公開 API（board/ Worker）只會新增 pending 留言與讀取 published 留言；
-- 審核（確認／封存／刪除）只在 CMS 後台、經 Cloudflare Access 與擁有者帳號驗證後進行。
-- 不收集任何聯絡資料：ip_hash 是以 IP_SALT 做 HMAC-SHA256 後的雜湊，只用於 10 分鐘限流，
-- 滿 1 天後由排程清空；全部資料於 2026-12-28 00:00（台北時間）由排程與查詢防線一併刪除。
CREATE TABLE board_notes (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL DEFAULT '' CHECK(length(nickname) <= 10),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','archived')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  ip_hash TEXT CHECK(ip_hash IS NULL OR length(ip_hash) = 64)
);
-- 公開清單：WHERE status='published' ORDER BY created_at DESC LIMIT 60
CREATE INDEX board_notes_status_created ON board_notes(status, created_at DESC);
-- 限流：同一雜湊 IP 最近 10 分鐘是否已送出
CREATE INDEX board_notes_ip_created ON board_notes(ip_hash, created_at) WHERE ip_hash IS NOT NULL;
-- 保存期限清除與後台時間排序
CREATE INDEX board_notes_created ON board_notes(created_at);
