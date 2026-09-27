import { HttpError } from "./security.ts";

export type PageSeo = { title: string; description: string; image: string; imageAlt: string };
export function validatePageSeo(value: unknown, fieldPrefix = "seo"): PageSeo {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== "description,image,imageAlt,title")
    throw new HttpError(400, "SEO 欄位格式不正確", fieldPrefix);
  const row = value as Record<string, unknown>;
  const limits: Record<keyof PageSeo, number> = { title: 140, description: 300, image: 500, imageAlt: 180 };
  const result = {} as PageSeo;
  for (const key of Object.keys(limits) as (keyof PageSeo)[]) {
    const text = row[key];
    if (typeof text !== "string" || !text.trim() || text.length > limits[key] ||
        /[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]/u.test(text))
      throw new HttpError(400, `SEO ${key} 不正確`, `${fieldPrefix}.${key}`);
    result[key] = text.trim();
  }
  let image: URL;
  try { image = new URL(result.image); } catch { throw new HttpError(400, "SEO 分享圖網址不正確", `${fieldPrefix}.image`); }
  if (image.origin !== "https://www.huiwen.tw" || image.search || image.hash ||
      !/^\/assets\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:png|jpe?g|webp|avif)$/i.test(image.pathname) ||
      image.pathname.split("/").includes(".."))
    throw new HttpError(400, "SEO 分享圖必須是本站 assets 圖片", `${fieldPrefix}.image`);
  return result;
}
