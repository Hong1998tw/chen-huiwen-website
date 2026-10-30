import { HttpError } from "./security.ts";

const idPattern = /^[a-z0-9-]{1,100}$/;
export const latestIdPattern = /^[a-z0-9-]{1,120}$/;
export const MAX_LATEST_PINNED = 3;

export type HomeDraft = { featured: string; reading: string[]; summaries: Record<string, string>; latestPinned?: string[] };

export function validateLatestPinned(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_LATEST_PINNED ||
      value.some(id => typeof id !== "string" || !latestIdPattern.test(id)) || new Set(value).size !== value.length)
    throw new HttpError(400, `最新資訊置頂最多 ${MAX_LATEST_PINNED} 則，且不能重複`, "home.latestPinned");
  return [...value] as string[];
}

export function validateHomeDraft(value: unknown): HomeDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "首頁專題排序格式不正確");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  if (!["featured,reading,summaries", "featured,latestPinned,reading,summaries"].includes(keys) ||
      typeof row.featured !== "string" || !idPattern.test(row.featured) ||
      !Array.isArray(row.reading) || row.reading.length < 1 || row.reading.length > 12 ||
      row.reading.some(id => typeof id !== "string" || !idPattern.test(id)) ||
      new Set([row.featured, ...row.reading]).size !== row.reading.length + 1 ||
      !row.summaries || typeof row.summaries !== "object" || Array.isArray(row.summaries))
    throw new HttpError(400, "首頁專題須有一則主打及 1–12 則不重複的閱讀專題");
  const summaries = row.summaries as Record<string, unknown>;
  if (Object.keys(summaries).sort().join(",") !== [row.featured, ...row.reading].sort().join(",") ||
      Object.entries(summaries).some(([id, text]) => {
        const invalid = typeof text !== "string" || text.length > 500 ||
          /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]|<\s*\/?[a-z!?]/i.test(text);
        if (invalid) throw new HttpError(400, "首頁專題摘要格式不正確", `home.summaries.${id}`);
        return false;
      }))
    throw new HttpError(400, "首頁專題摘要格式不正確", "home.summaries");
  const result: HomeDraft = { featured: row.featured, reading: row.reading as string[], summaries: Object.fromEntries(Object.entries(summaries).map(([id, text]) => [id, (text as string).trim()])) };
  // Absent means "keep the published pins" (older drafts); [] is an explicit clear.
  if ("latestPinned" in row) result.latestPinned = validateLatestPinned(row.latestPinned);
  return result;
}

export type LatestFeedItem = { id: string; type: string; kind: string; title: string; publishedAt: string; dateLabel: string; eventStart: string | null; naturalIndex: number; url: string };

export function validateLatestFeed(value: unknown): LatestFeedItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("latest feed");
  const feed = value as Record<string, unknown>;
  if (feed.schemaVersion !== 1 || !Array.isArray(feed.items) || feed.items.length > 2000) throw new Error("latest feed");
  const seen = new Set<string>();
  return feed.items.map((raw) => {
    const item = raw as Record<string, unknown>;
    if (!item || typeof item.id !== "string" || !latestIdPattern.test(item.id) || seen.has(item.id) ||
        !["news", "daily", "activity"].includes(String(item.type)) || typeof item.title !== "string" ||
        typeof item.publishedAt !== "string" || !Number.isSafeInteger(item.naturalIndex)) throw new Error("latest feed item");
    seen.add(item.id);
    return { id: item.id, type: String(item.type), kind: String(item.kind || ""), title: item.title.slice(0, 300),
      publishedAt: item.publishedAt, dateLabel: String(item.dateLabel || ""), eventStart: typeof item.eventStart === "string" ? item.eventStart : null,
      naturalIndex: Number(item.naturalIndex), url: String(item.url || "") };
  }).sort((a, b) => a.naturalIndex - b.naturalIndex);
}
