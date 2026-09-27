import { HttpError } from "./security.ts";

const allowed = new Set(["title", "summary", "updated", "paragraphs", "history", "sources", "media", "imageMetadata", "images", "sectionOrder"]);
const sectionKeys = ["overview", "media", "history", "sources"];
const forbidden = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]|<\s*\/?[a-z!?]/i;
const day = (value: unknown) => typeof value === "string" && /^20\d\d-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const period = (value: unknown) => typeof value === "string" && value.length <= 60 && !forbidden.test(value) &&
  (/^20\d\d$/.test(value) || /^20\d\d-(?:0[1-9]|1[0-2])$/.test(value) || day(value) ||
    /^20\d\d-\d\d-\d\d (?:\d\d:\d\d–\d\d:\d\d|至 \d\d-\d\d)$/.test(value) ||
    /^\d{3}學年度第[12]學期$|^第\d+屆第\d+次定期大會$/.test(value));
function string(value: unknown, label: string, limit = 500, required = true) {
  if (typeof value !== "string" || value.length > limit || forbidden.test(value) || (required && !value.trim()))
    throw new HttpError(400, `${label} 內容或長度不正確`);
  return value.normalize("NFC").trim();
}
function url(value: unknown, label: string, media = false) {
  const raw = string(value, label, 1200);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new HttpError(400, `${label} 網址不正確`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") ||
      !parsed.hostname.includes(".") || /^(?:\d+\.)+\d+$/.test(parsed.hostname) || parsed.hostname.includes(":") ||
      /\.(?:local|internal|lan|home|corp)$/.test(parsed.hostname) ||
      /(?:token|api_key|secret|password)=/i.test(parsed.search))
    throw new HttpError(400, `${label} 須使用公開 HTTPS 網址`);
  if (!media && /^(?:drive|docs)\.google\.com$|(?:^|\.)notion\.(?:so|site|com)$/.test(parsed.hostname))
    throw new HttpError(400, `${label} 不可使用私人文件網址`);
  return raw;
}
export function mediaProvider(raw: string, kind: string) {
  const u = new URL(raw), host = u.hostname.toLowerCase();
  if (host === "docs.google.com" || /(?:^|\.)notion\.(?:so|site|com)$/.test(host)) return false;
  if (host === "drive.google.com") return /^\/file\/d\/[A-Za-z0-9_-]{15,}\/+(?:view|preview)?\/?$/.test(u.pathname);
  if (["facebook.com", "www.facebook.com", "m.facebook.com"].includes(host)) return u.pathname !== "/";
  if (kind === "video" && ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host))
    return /^[A-Za-z0-9_-]{11}$/.test(host === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v") || "");
  return kind === "photo" ? /\.(?:jpe?g|png|webp|avif|gif)$/i.test(u.pathname) : /\.(?:mp4|webm)$/i.test(u.pathname);
}
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    throw new HttpError(400, `${label} 欄位格式不正確`);
  return value as Record<string, unknown>;
}
function list(value: unknown, label: string, max: number) {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, `${label} 數量超出限制`);
  return value;
}

export function validateCaseDraft(value: unknown) {
  const source = object(value, [...allowed], "政績草稿");
  if (Object.keys(source).some(k => !allowed.has(k))) throw new HttpError(400, "政績草稿欄位不正確");
  const hasImages = Object.hasOwn(source, "images"), hasSectionOrder = Object.hasOwn(source, "sectionOrder");
  if (hasImages !== hasSectionOrder) throw new HttpError(400, "照片與區塊排序欄位不完整");
  if (!day(source.updated)) throw new HttpError(400, "內容整理日期不正確");
  const images = hasImages ? list(source.images, "既有照片", 24).map((name, i) => {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp|avif)$/.test(name))
      throw new HttpError(400, `既有照片 ${i + 1} 檔名不正確`);
    return name;
  }) : undefined;
  if (images && new Set(images).size !== images.length) throw new HttpError(400, "既有照片不得重複");
  const sectionOrder = hasSectionOrder ? list(source.sectionOrder, "區塊排序", sectionKeys.length) : undefined;
  if (sectionOrder && (sectionOrder.length !== sectionKeys.length ||
      new Set(sectionOrder).size !== sectionKeys.length || sectionOrder.some(key => !sectionKeys.includes(key))))
    throw new HttpError(400, "區塊排序不正確");
  const paragraphs = list(source.paragraphs, "背景段落", 30).map((p, i) => string(p, `背景段落 ${i + 1}`, 4000));
  const history = list(source.history, "推動歷程", 50).map((row, i) => {
    const r = object(row, ["date", "title", "text"], `歷程 ${i + 1}`);
    if (!period(r.date)) throw new HttpError(400, `歷程 ${i + 1} 日期或期間不正確`);
    return { date: r.date as string, title: string(r.title, "歷程標題"), text: string(r.text, "歷程說明", 4000) };
  });
  const sources = list(source.sources, "資料來源", 50).map((row, i) => {
    const r = object(row, ["title", "url", "sourceType", "sourceDate"], `來源 ${i + 1}`);
    if (r.sourceDate && !period(r.sourceDate)) throw new HttpError(400, `來源 ${i + 1} 日期或期間不正確`);
    return { title: string(r.title, "來源標題"), url: url(r.url, "資料來源"),
      ...(r.sourceType ? { sourceType: string(r.sourceType, "來源類型") } : {}),
      ...(r.sourceDate ? { sourceDate: r.sourceDate as string } : {}) };
  });
  if (!sources.length) throw new HttpError(400, "至少需要一筆可追溯的資料來源");
  const media = list(source.media || [], "照片與影片", 24).map((row, i) => {
    const r = object(row, ["kind", "url", "alt", "caption", "credit", "publicAccessConfirmed"], `媒體 ${i + 1}`);
    if (!["photo", "video"].includes(String(r.kind))) throw new HttpError(400, "請選擇照片或影片");
    const link = url(r.url, "媒體網址", true);
    if (!mediaProvider(link, String(r.kind))) throw new HttpError(400, "媒體網址須為 Drive 檔案、Facebook 貼文、YouTube 影片或直接圖片／影片檔");
    if (r.publicAccessConfirmed !== true) throw new HttpError(400, "請先確認媒體不需登入即可公開檢視");
    return { kind: r.kind as string, url: link, alt: string(r.alt, "媒體替代文字"),
      caption: string(r.caption, "媒體說明"), credit: string(r.credit, "媒體來源"), publicAccessConfirmed: true };
  });
  if (!source.imageMetadata || typeof source.imageMetadata !== "object" || Array.isArray(source.imageMetadata))
    throw new HttpError(400, "原有照片說明格式不正確");
  const metadata = source.imageMetadata as Record<string, unknown>;
  if (Object.keys(metadata).length > 24) throw new HttpError(400, "原有照片數量超出限制");
  if (images && Object.keys(metadata).some(filename => !images.includes(filename)))
    throw new HttpError(400, "照片說明不屬於此頁");
  const imageMetadata: Record<string, unknown> = {};
  for (const [filename, raw] of Object.entries(metadata)) {
    if (!/^[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp|avif)$/.test(filename)) throw new HttpError(400, "原有照片檔名不正確");
    const item = object(raw, ["alt", "caption", "credit", "sourceUrl"], "原有照片說明");
    imageMetadata[filename] = { alt: string(item.alt, "照片替代文字"), caption: string(item.caption, "照片說明"),
      credit: string(item.credit, "照片來源"), sourceUrl: url(item.sourceUrl, "照片原始網址") };
  }
  return { title: string(source.title, "標題"), summary: string(source.summary, "摘要", 4000, false),
    updated: source.updated as string, paragraphs, history, sources, media, imageMetadata,
    ...(images && sectionOrder ? { images, sectionOrder } : {}) };
}
