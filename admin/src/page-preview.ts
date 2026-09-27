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

function attributeValue(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : null;
}

/** Keep edge-optimized scripts from being deferred inside the opaque preview iframe. */
function normalizePreviewScripts(source: string) {
  const withoutRocketLoader = source.replace(
    /<script\b(?=[^>]*\bsrc\s*=\s*(["'])[^"']*rocket-loader(?:\.min)?\.js[^"']*\1)[^>]*>[\s\S]*?<\/script\s*>/gi,
    "",
  );
  return withoutRocketLoader.replace(/<script\b[^>]*>/gi, (original) => {
    const src = attributeValue(original, "src");
    if (src && /rocket-loader(?:\.min)?\.js/i.test(src)) return original;

    let tag = original.replace(/\s+data-cf-settings(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, "");
    const type = attributeValue(tag, "type");
    const rocketType = type && (/^[a-f0-9]{8,}-text\/javascript$/i.test(type) || type.toLowerCase() === "text/rocketscript");
    if (rocketType) {
      if (/\s+type\s*=/i.test(tag)) {
        tag = tag.replace(/\s+type\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ' type="text/javascript"');
      } else {
        tag = tag.slice(0, -1) + ' type="text/javascript">';
      }
    }

    const normalizedType = (rocketType ? "text/javascript" : type || "").toLowerCase();
    const isJavaScript = !normalizedType || [
      "module",
      "text/javascript",
      "application/javascript",
      "text/ecmascript",
      "application/ecmascript",
      "application/x-javascript",
    ].includes(normalizedType);
    if (!isJavaScript) return tag;

    if (/\s+data-cfasync(?:\s*=|\s|>)/i.test(tag)) {
      return tag.replace(/\s+data-cfasync(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i, ' data-cfasync="false"');
    }
    const srcIndex = tag.search(/\s+src\s*=/i);
    return srcIndex < 0
      ? tag.slice(0, -1) + ' data-cfasync="false">'
      : tag.slice(0, srcIndex) + ' data-cfasync="false"' + tag.slice(srcIndex);
  });
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
  let document = normalizePreviewScripts(source).replace(/<base\b[^>]*>/gi, "");
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
    `img-src ${PUBLIC_SITE_ORIGIN} https: data: blob:`,
    `font-src ${PUBLIC_SITE_ORIGIN} data:`,
    `connect-src ${PUBLIC_SITE_ORIGIN} https://tile.openstreetmap.org`,
    `frame-src ${PUBLIC_SITE_ORIGIN} https://www.youtube.com https://www.youtube-nocookie.com https://www.facebook.com https://drive.google.com https://www.canva.com`,
    `media-src ${PUBLIC_SITE_ORIGIN} https: data: blob:`,
    "object-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${safeAdminOrigin}`,
  ].join("; ");
}
