// 以 node:sqlite 模擬 D1 介面（prepare/bind/first/all/run/batch），讓 Worker 能在 node --test 內直接跑。
// 套用與正式環境相同的 admin/migrations/*.sql。
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function createFakeD1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../../admin/migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
  const statements = [];
  const prepare = (sql) => {
    statements.push(sql);
    let params = [];
    const stmt = {
      bind(...values) { params = values; return stmt; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
      async all() { return { results: db.prepare(sql).all(...params), success: true, meta: {} }; },
      async run() {
        const info = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(list) { return Promise.all(list.map((s) => s.run())); },
    raw: db,
    statements,
  };
}
