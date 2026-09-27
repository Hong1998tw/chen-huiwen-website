"use strict";
(() => {
  const params = new URLSearchParams(location.search);
  const loader = document.querySelector("script[data-cms-editor-loader]");
  if ((params.get("cmsEdit") !== "1" && loader?.dataset.cmsEditorEnabled !== "true") || window.parent === window) return;
  const SITE_ORIGIN = "https://www.huiwen.tw";
  const ADMIN_ORIGIN = loader?.dataset.cmsAdminOrigin || "https://admin.huiwen.tw";
  const EDITABLE_TAGS = new Set(["h1", "h2", "h3", "h4", "p", "li", "blockquote", "figcaption", "dt", "dd"]);
  let nonce = null;
  let initializationStarted = false;
  const text = (node) => node.textContent || "";
  function send(type, payload = {}) {
    if (!nonce) return;
    window.parent.postMessage({ type, nonce, path: `/${pageRoute()}`, ...payload }, ADMIN_ORIGIN);
  }
  function collect() {
    return [...document.querySelectorAll("main [data-cms-edit-id]")].map((node) => ({
      id: node.dataset.cmsEditId,
      sourceHash: node.dataset.cmsSourceHash,
      value: text(node),
    }));
  }
  function pageRoute() {
    if (loader?.dataset.cmsPagePath) {
      if (!/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/.test(loader.dataset.cmsPagePath)) throw new Error("invalid page path");
      return loader.dataset.cmsPagePath;
    }
    const path = location.pathname;
    if (!path.startsWith("/") || path.includes("..")) throw new Error("invalid page path");
    return path === "/" ? "index.html" : path.endsWith("/") ? `${path.slice(1)}index.html` : path.slice(1);
  }
  const node = (tag, value, className) => {
    const item = document.createElement(tag);
    if (value !== undefined) item.textContent = value;
    if (className) item.className = className;
    return item;
  };
  function mediaPreview(item) {
    let url;
    try { url = new URL(item.url); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.includes(".") ||
      /^(?:\d+\.)+\d+$/.test(url.hostname) || url.hostname.includes(":") ||
      url.hostname === "docs.google.com" || /(?:^|\.)notion\.(?:so|site|com)$/.test(url.hostname) ||
      /\.(?:local|internal|lan|home|corp)$/.test(url.hostname)) return null;
    const host = url.hostname.toLowerCase();
    let visual;
    if (host === "drive.google.com") {
      const match = /^\/file\/d\/([A-Za-z0-9_-]{15,})\/(?:view|preview)?\/?$/.exec(url.pathname);
      if (!match) return null;
      visual = node("iframe"); visual.src = `https://drive.google.com/file/d/${match[1]}/preview`;
    } else if (["facebook.com", "www.facebook.com", "m.facebook.com"].includes(host) && url.pathname !== "/") {
      visual = node("iframe");
      const plugin = item.kind === "video" ? "video" : "post";
      visual.src = `https://www.facebook.com/plugins/${plugin}.php?href=${encodeURIComponent("https://www.facebook.com" + url.pathname + url.search)}&show_text=false&width=640`;
    } else if (item.kind === "video" && ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
      const id = host === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v");
      if (!/^[A-Za-z0-9_-]{11}$/.test(id || "")) return null;
      visual = node("iframe"); visual.src = `https://www.youtube-nocookie.com/embed/${id}`;
    } else if (item.kind === "photo" && /\.(?:jpe?g|png|webp|avif|gif)$/i.test(url.pathname)) {
      visual = node("img"); visual.src = url.href; visual.alt = item.alt || "照片";
    } else if (item.kind === "video" && /\.(?:mp4|webm)$/i.test(url.pathname)) {
      visual = node("video"); visual.src = url.href; visual.controls = true; visual.preload = "none";
    } else return null;
    visual.loading = "lazy";
    if (visual.tagName === "IFRAME") { visual.title = item.alt || "外部媒體"; visual.referrerPolicy = "strict-origin-when-cross-origin"; }
    const figure = node("figure", undefined, "case-external-media"), caption = node("figcaption", item.caption || "");
    const credit = node("span", `來源：${item.credit || ""} · `, "case-photo-credit");
    const link = node("a", "開啟原始內容 ↗"); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    credit.append(link); caption.append(credit); figure.append(visual, caption);
    return figure;
  }
  function applyCasePreview(data) {
    if (!data || typeof data !== "object") return;
    const body = document.querySelector(".case-body"), latestWrap = document.querySelector(".case-latest-wrap");
    if (!body || !latestWrap) return;
    const title = document.querySelector(".case-head h1"); if (title) title.textContent = data.title || "";
    const breadcrumb = document.querySelector(".breadcrumb span:last-child"); if (breadcrumb) breadcrumb.textContent = data.title || "";
    const updated = document.querySelector(".civic-article-nav time"); if (updated) { updated.textContent = data.updated || ""; updated.dateTime = data.updated || ""; }
    let background = body.querySelector(".case-background"); background?.remove();
    if (Array.isArray(data.paragraphs) && data.paragraphs.some(Boolean)) {
      background = node("details", undefined, "case-background");
      const summary = node("summary", "完整背景與說明"); summary.id = "case-overview";
      background.append(summary, ...data.paragraphs.filter(Boolean).map(p => node("p", p)));
      body.prepend(background);
    }
    body.querySelector(".history-section")?.remove();
    const history = Array.isArray(data.history) ? data.history.filter(h => h.date && h.title && h.text) : [];
    latestWrap.replaceChildren(); latestWrap.removeAttribute("id");
    if (history.length) {
      const latest = [...history].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
      const section = node("section", undefined, "case-latest");
      const kicker = node("p", "收錄的最新歷程 · ", "civic-kicker"); kicker.append(node("time", latest.date));
      const heading = node("h2", latest.title); heading.id = "latest-heading";
      section.append(kicker, heading, node("p", latest.text));
      const evidence = node("a", "查看完整來源 ↓"); evidence.href = "#case-sources"; section.append(evidence);
      section.append(node("p", "此處呈現本站已收錄的紀錄，並非即時工程進度。後續辦理情形，請一併核對主管機關最新公告。", "record-boundary"));
      latestWrap.append(section);
      if (history.length === 1) latestWrap.id = "case-history";
    }
    if (history.length > 1) {
      const section = node("section", undefined, "history-section"); section.id = "case-history";
      section.append(node("p", "推動歷程", "eyebrow"), node("h2", "重要進度"));
      const list = node("ol", undefined, "case-timeline");
      for (const event of history) {
        const row = node("li"), detail = node("div");
        detail.append(node("h3", event.title), node("p", event.text)); row.append(node("time", event.date), detail); list.append(row);
      }
      section.append(list); body.append(section);
    }
    let photos = body.querySelector(".case-photos");
    photos?.querySelectorAll(".case-external-media").forEach(item => item.remove());
    const media = Array.isArray(data.media) ? data.media.map(mediaPreview).filter(Boolean) : [];
    if (media.length) {
      if (!photos) { photos = node("div", undefined, "case-photos"); photos.id = "case-media"; body.insertBefore(photos, body.querySelector(".history-section,.case-sources")); }
      photos.append(...media);
    } else if (photos && !photos.children.length) photos.remove();
    if (photos && data.imageMetadata && typeof data.imageMetadata === "object") {
      for (const anchor of photos.querySelectorAll('a[href*="/assets/"]')) {
        const filename = decodeURIComponent(new URL(anchor.href).pathname.split("/").at(-1) || "");
        const item = data.imageMetadata[filename];
        if (!item || !item.alt || !item.caption || !item.credit || !item.sourceUrl) continue;
        const image = anchor.querySelector("img"); if (image) image.alt = item.alt;
        let figure = anchor.closest("figure");
        if (!figure) { figure = node("figure"); anchor.replaceWith(figure); figure.append(anchor); }
        let caption = figure.querySelector("figcaption");
        if (!caption) { caption = node("figcaption"); figure.append(caption); }
        caption.replaceChildren(document.createTextNode(item.caption));
        const credit = node("span", `照片：${item.credit} · `, "case-photo-credit");
        const source = node("a", "刊登來源 ↗"); source.href = item.sourceUrl; source.target = "_blank"; source.rel = "noopener noreferrer";
        credit.append(source); caption.append(credit);
      }
    }
    body.querySelector(".case-sources")?.remove();
    const sources = Array.isArray(data.sources) ? data.sources.filter(s => s.title && s.url) : [];
    if (sources.length) {
      const section = node("section", undefined, "case-sources"); section.id = "case-sources";
      section.append(node("h2", "資料來源"));
      const list = node("ul", undefined, "source-links");
      for (const source of sources) {
        const row = node("li");
        if (source.sourceDate) { row.append(node("time", source.sourceDate), document.createTextNode(" · ")); }
        const link = node("a", `${source.title} ↗`); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        row.append(link); list.append(row);
      }
      section.append(list); body.append(section);
    }
    send("huiwen-cms-ready", { blocks: [] });
  }
  async function enable() {
    try {
      const route = pageRoute();
      if (/^achievement-[a-z0-9-]+\.html$/.test(route)) {
        document.addEventListener("click", (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const section = target.closest(".case-sources") ? "sources" : target.closest(".case-timeline,.case-latest-wrap") ? "history" :
            target.closest(".case-background") ? "paragraphs" : target.closest(".case-photos") ? "media" :
            target.closest(".civic-article-nav time") ? "updated" : null;
          if (section) { event.preventDefault(); send("huiwen-cms-case-focus", { section }); }
          else if (target.closest("main a")) event.preventDefault();
        }, true);
        send("huiwen-cms-ready", { blocks: [] });
        return;
      }
      const manifestUrl = new URL(loader?.dataset.cmsManifest || "", SITE_ORIGIN);
      if (manifestUrl.origin !== SITE_ORIGIN || !manifestUrl.pathname.startsWith("/cms-editor-manifests/")) throw new Error("manifest path invalid");
      const response = await fetch(manifestUrl.href, { cache: "no-store" });
      if (!response.ok) throw new Error("manifest unavailable");
      const manifest = await response.json();
      if (manifest.schemaVersion !== 1 || manifest.path !== route || !Array.isArray(manifest.fields)) throw new Error("manifest invalid");
      for (const field of manifest.fields) {
        if (!field || typeof field.id !== "string" || !/^main(?:>[a-z][a-z0-9-]*:nth-of-type\(\d+\))+$/.test(field.id)
          || !/^[a-f0-9]{64}$/.test(field.sourceHash || "") || !/^[a-f0-9]{64}$/.test(field.valueHash || "")) {
          throw new Error("field invalid");
        }
        const node = document.querySelector(field.id);
        if (!node || !document.querySelector("main")?.contains(node) || node.children.length
          || !EDITABLE_TAGS.has(node.tagName.toLowerCase())) throw new Error("target unavailable");
        node.dataset.cmsEditId = field.id;
        node.dataset.cmsSourceHash = field.sourceHash;
        node.dataset.cmsValueHash = field.valueHash;
      }
    } catch {
      send("huiwen-cms-error", { message: "無法載入此頁的編輯資料，請重新整理後再試。" });
      return;
    }
    const style = document.createElement("style");
    style.textContent = "[data-cms-edit-id][contenteditable=true]{outline:2px solid #579379;outline-offset:3px;border-radius:3px;cursor:text}[data-cms-edit-id][contenteditable=true]:focus{outline:3px solid #bd633e;background:#fff9e9}";
    document.head.append(style);
    for (const node of document.querySelectorAll("main [data-cms-edit-id]")) {
      node.setAttribute("contenteditable", "true");
      node.setAttribute("spellcheck", "true");
      node.setAttribute("aria-label", "編輯：" + text(node).slice(0, 60));
      node.addEventListener("input", () => send("huiwen-cms-change", {
        field: { id: node.dataset.cmsEditId, sourceHash: node.dataset.cmsSourceHash, value: text(node) },
      }));
    }
    document.addEventListener("click", (event) => {
      if (event.target.closest("main [data-cms-edit-id]")) return;
      if (event.target.closest("main a")) event.preventDefault();
    }, true);
    send("huiwen-cms-ready", { blocks: collect() });
  }
  addEventListener("message", (event) => {
    if (event.origin !== ADMIN_ORIGIN || event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "huiwen-cms-init" && typeof data.nonce === "string") {
      if (initializationStarted) return;
      nonce = data.nonce;
      initializationStarted = true;
      void enable();
      return;
    }
    if (data.nonce !== nonce) return;
    if (data.type === "huiwen-cms-apply" && Array.isArray(data.fields)) {
      for (const field of data.fields) {
        if (!field || typeof field.id !== "string" || typeof field.value !== "string") continue;
        const node = [...document.querySelectorAll("main [data-cms-edit-id]")]
          .find((candidate) => candidate.dataset.cmsEditId === field.id);
        if (node && node.dataset.cmsSourceHash === field.sourceHash) node.textContent = field.value;
      }
      send("huiwen-cms-ready", { blocks: collect() });
    }
    if (data.type === "huiwen-cms-case-preview" && /^achievement-[a-z0-9-]+\.html$/.test(pageRoute())) applyCasePreview(data.case);
  });
  window.parent.postMessage({ type: "huiwen-cms-hello", path: `/${pageRoute()}` }, ADMIN_ORIGIN);
})();
