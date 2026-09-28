import { HttpError } from "./security.ts";

const idPattern = /^[a-z0-9-]{1,100}$/;

export function validateHomeDraft(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "首頁專題排序格式不正確");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "featured,reading,summaries" ||
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
  return { featured: row.featured, reading: row.reading, summaries: Object.fromEntries(Object.entries(summaries).map(([id, text]) => [id, (text as string).trim()])) };
}
