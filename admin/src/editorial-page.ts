import { HttpError } from "./security.ts";
import { validatePageSeo } from "./page-seo.ts";
import { mediaProvider } from "./case-draft.ts";

export const EDITORIAL_SECTIONS = ["news", "press", "service", "council", "achievement"] as const;
export const editorialPath = /^page-(news|press|service|council|achievement)-([a-z0-9]+(?:-[a-z0-9]+)*)\.html$/;
const blockTypes = new Set(["heading", "paragraph", "timeline", "source", "photo", "video", "map"]);
const keys = ["type", "title", "text", "date", "url", "alt", "credit", "address", "publicAccessConfirmed"];
const unsafe = /[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]/u;
const fullDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0,4)) >= 1 && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || unsafe.test(value) || required && !value.trim())
    throw new HttpError(400, `${label}格式不正確`);
  return value.trim();
}
function publicUrl(value: unknown) {
  const input = text(value, "公開網址", 1200, true);
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, "公開網址不正確"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !url.hostname.includes(".") || /^(?:\d+\.)+\d+$/.test(url.hostname) ||
      /(?:\.local|\.internal|\.lan|\.home|\.corp|\.notion\.so|\.notion\.site)$/.test(url.hostname) ||
      ["notion.so", "notion.site", "docs.google.com"].includes(url.hostname) ||
      /(?:token|api_key|secret|password)=/i.test(url.search)) throw new HttpError(400, "公開網址不符合安全規則");
  return input;
}
function taipei(value: unknown, label: string) {
  if (value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d\+08:00$/.test(value) ||
      !fullDay(value.slice(0, 10))) throw new HttpError(400, `${label}必須是有效台灣時間`);
  return value;
}
export function validateEditorialPage(path: string, value: unknown) {
  const match = editorialPath.exec(path);
  if (!match || !value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "新增頁面格式不正確");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join() !== "blocks,eventEnd,eventStart,section,seo,summary,title,updated" || p.section !== match[1])
    throw new HttpError(400, "頁面區塊與欄位不正確");
  const title = text(p.title, "頁面標題", 150, true), summary = text(p.summary, "頁面摘要", 500, true);
  if (typeof p.updated !== "string" || !fullDay(p.updated)) throw new HttpError(400, "內容整理日期不正確");
  const eventStart = taipei(p.eventStart, "開始時間"), eventEnd = taipei(p.eventEnd, "結束時間");
  if (eventEnd && (!eventStart || eventEnd <= eventStart)) throw new HttpError(400, "結束時間必須晚於開始時間");
  const seo = validatePageSeo(p.seo);
  const blocks = validateEditorialBlocks(p.blocks, true);
  return { section: match[1], title, summary, updated: p.updated, eventStart, eventEnd, seo, blocks };
}
export function validateEditorialBlocks(value: unknown, required = false) {
  if (!Array.isArray(value) || value.length > 80 || required && value.length < 1) throw new HttpError(400, "頁面區塊最多 80 個；新頁面至少一個");
  const blocks = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, `區塊 ${index+1} 格式不正確`);
    const b = raw as Record<string, unknown>;
    if (Object.keys(b).sort().join() !== [...keys].sort().join() || !blockTypes.has(String(b.type))) throw new HttpError(400, `區塊 ${index+1} 類型不正確`);
    const row = { type: String(b.type), title: text(b.title, "區塊標題", 200), text: text(b.text, "區塊說明", 4000),
      date: text(b.date, "區塊日期", 25), url: text(b.url, "區塊網址", 1200), alt: text(b.alt, "替代文字", 250),
      credit: text(b.credit, "來源署名", 250), address: text(b.address, "地址", 300), publicAccessConfirmed:b.publicAccessConfirmed };
    if (typeof row.publicAccessConfirmed !== "boolean") throw new HttpError(400,"媒體公開狀態格式不正確");
    if (row.type === "heading" && !row.title || row.type === "paragraph" && !row.text || row.type === "timeline" && (!row.title || !row.text || !fullDay(row.date)))
      throw new HttpError(400, `區塊 ${index+1} 內容不完整`);
    if (row.type === "source") { if (!row.title) throw new HttpError(400, "來源名稱必填"); publicUrl(row.url); if (row.date && !fullDay(row.date)) throw new HttpError(400, "來源日期不正確"); }
    if (["photo", "video"].includes(row.type)) { publicUrl(row.url); if (!mediaProvider(row.url,row.type) || !row.alt || !row.credit || !row.publicAccessConfirmed) throw new HttpError(400, "媒體需填可用的公開網址、替代文字、署名與公開存取確認"); }
    if (row.type === "map" && !/^高雄市[^\s，,]{1,12}(?:區|鄉|鎮|市)[^\s，,]{2,}(?:\d+號|[路街巷]口)$/.test(row.address)) throw new HttpError(400, "請填高雄市、行政區、道路與門牌或路口，並用地圖核對");
    return row;
  });
  return blocks;
}
