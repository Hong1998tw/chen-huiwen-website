const PUBLIC_SITE_ORIGIN = "https://www.huiwen.tw";
const PAGE_PATH = /^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/;

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function normalizedOrigin(value: string) {
  const origin = new URL(value);
  if (origin.origin !== value || !["https:", "http:"].includes(origin.protocol)) {
    throw new Error("CMS preview origin is invalid");
  }
  return origin.origin;
}

/** Prepare the deployed HTML for an opaque-origin CMS iframe without changing its design. */
export function preparePagePreviewDocument(
  source: string,
  path: string,
  adminOrigin: string,
  enableEditor: boolean,
) {
  if (!PAGE_PATH.test(path)) throw new Error("CMS preview path is invalid");
  const safeAdminOrigin = normalizedOrigin(adminOrigin);
  if (!/<html\b/i.test(source) || !/<head\b[^>]*>/i.test(source) || !/<body\b[^>]*>/i.test(source)) {
    throw new Error("CMS preview document is invalid");
  }

  const base = `<base href="${PUBLIC_SITE_ORIGIN}/${escapeAttribute(path)}">`;
  let document = source.replace(/<base\b[^>]*>/gi, "");
  document = document.replace(/<head\b[^>]*>/i, (head) => `${head}${base}`);

  if (enableEditor) {
    const loaders = [...document.matchAll(/<script\b(?=[^>]*\bdata-cms-editor-loader\b)[^>]*>/gi)];
    if (loaders.length !== 1) throw new Error("CMS preview editor loader is missing or ambiguous");
    const loader = loaders[0][0];
    const attributes = [
      ["data-cms-editor-enabled", "true"],
      ["data-cms-page-path", path],
      ["data-cms-admin-origin", safeAdminOrigin],
    ].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
    document = document.replace(loader, loader.slice(0, -1) + attributes + ">");
  }
  return document;
}

export function pagePreviewContentSecurityPolicy(adminOrigin: string) {
  const safeAdminOrigin = normalizedOrigin(adminOrigin);
  return [
    "default-src 'none'",
    `base-uri ${PUBLIC_SITE_ORIGIN}`,
    `script-src ${PUBLIC_SITE_ORIGIN} 'unsafe-inline'`,
    `style-src ${PUBLIC_SITE_ORIGIN} 'unsafe-inline'`,
    `img-src ${PUBLIC_SITE_ORIGIN} https://tile.openstreetmap.org https://www.facebook.com https://www.canva.com data: blob:`,
    `font-src ${PUBLIC_SITE_ORIGIN} data:`,
    `connect-src ${PUBLIC_SITE_ORIGIN} https://tile.openstreetmap.org`,
    `frame-src ${PUBLIC_SITE_ORIGIN} https://www.youtube.com https://www.youtube-nocookie.com https://www.facebook.com https://www.canva.com`,
    `media-src ${PUBLIC_SITE_ORIGIN} https://www.youtube.com https://www.youtube-nocookie.com data: blob:`,
    "object-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${safeAdminOrigin}`,
  ].join("; ");
}
