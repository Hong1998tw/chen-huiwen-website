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
  function seoInfo() {
    const meta = (selector) => document.head.querySelector(selector)?.content || "";
    return { title: document.title, description: meta('meta[name="description"]'),
      image: meta('meta[property="og:image"]'), imageAlt: meta('meta[property="og:image:alt"]') };
  }
  function applySeoPreview(seo) {
    if (!seo || typeof seo !== "object") return;
    const values = { title: seo.title, description: seo.description, image: seo.image, imageAlt: seo.imageAlt };
    if (Object.values(values).some(value => typeof value !== "string" || value.length > 500)) return;
    document.title = values.title;
    for (const [selector, value] of [
      ['meta[name="description"]', values.description],
      ['meta[property="og:title"]', values.title], ['meta[property="og:description"]', values.description],
      ['meta[property="og:image"]', values.image], ['meta[property="og:image:alt"]', values.imageAlt],
      ['meta[name="twitter:title"]', values.title], ['meta[name="twitter:description"]', values.description],
      ['meta[name="twitter:image"]', values.image], ['meta[name="twitter:image:alt"]', values.imageAlt],
    ]) { const tag = document.head.querySelector(selector); if (tag) tag.content = value; }
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
  function applyHomePreview(home, records) {
    const grid = document.querySelector(".civic-story-grid");
    if (!grid || !home || !Array.isArray(home.reading) || !Array.isArray(records)) return;
    const cases = new Map(records.map(record => [record.id, record]));
    const ids = [home.featured, ...home.reading];
    if (ids.length < 2 || ids.length > 13 || new Set(ids).size !== ids.length || ids.some(id => !cases.has(id))) return;
    const amountWan = value => (Number(value) / 10000).toLocaleString("en-US", { maximumFractionDigits: 2 });
    const fundingOf = record => {
      const funding = record.funding;
      if (!funding || funding.currency !== "TWD" ||
          ![funding.total, funding.centralGrant].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0) ||
          funding.total < funding.centralGrant) return null;
      return funding;
    };
    const titleFor = record => record.id === "haibang-bridge" ? "海邦橋" : record.title || record.id;
    const summaryFor = record => (home.summaries?.[record.id] || "").trim() || record.summary || "";
    const externalLink = (value, label, className) => {
      let url;
      try { url = new URL(value); } catch { return node("span", label, className); }
      if (!["https:", "http:"].includes(url.protocol)) return node("span", label, className);
      const link = node("a", label, className);
      link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
      return link;
    };
    const dated = record => {
      const small = node("small", "內容整理 ", "meta"), time = node("time", record.updated || "");
      time.dateTime = record.updated || ""; small.append(time); return small;
    };
    const photoFor = (record, className, station = false) => {
      const filename = record?.images?.[0], meta = record?.imageMetadata?.[filename];
      const dimensions = record?.imageDimensions?.[filename];
      if (!filename || !meta || !Array.isArray(dimensions) || dimensions.length !== 2) return null;
      const figure = node("figure", undefined, className);
      const image = node("img"); image.src = `assets/${filename}`; image.alt = meta.alt || "";
      image.width = dimensions[0]; image.height = dimensions[1]; image.loading = "lazy"; image.decoding = "async";
      const caption = node("figcaption", `${station ? "鳳山車站 · " : ""}${meta.caption || ""} · `);
      caption.append(externalLink(meta.sourceUrl, `${meta.credit || ""} ↗`));
      figure.append(image, caption); return figure;
    };
    const fundingFor = record => {
      const funding = fundingOf(record);
      if (!funding) return null;
      const aside = node("aside", undefined, "budget civic-feature-funding");
      aside.setAttribute("aria-label", `${record.title || record.id}核定經費`);
      aside.append(node("p", "核定計畫總經費", "kicker"));
      const amount = node("p", amountWan(funding.total), "amount"); amount.append(node("small", "萬元")); aside.append(amount);
      const list = node("dl");
      for (const [label, value] of [
        ["中央補助", `${amountWan(funding.centralGrant)}萬元`],
        ["中央補助以外差額", `${amountWan(funding.total - funding.centralGrant)}萬元`],
      ]) list.append(node("dt", label), node("dd", value));
      const approved = funding.approvedOn || "", date = node("time", approved.replaceAll("-", "."));
      date.dateTime = approved;
      const dateValue = node("dd"); dateValue.append(date);
      list.append(node("dt", "核定日期"), dateValue); aside.append(list);
      const note = node("p", funding.approvalReference || "", "note");
      note.append(node("br"), document.createTextNode("核定計畫金額，非決算或已撥款。")); aside.append(note);
      if (funding.sourceUrl) aside.append(externalLink(funding.sourceUrl, `${funding.sourceTitle || "核對經費來源"} ↗`, "source civic-funding-source"));
      return aside;
    };
    const featured = cases.get(home.featured), url = `achievement-${featured.id}.html`;
    const feature = node("article", undefined, "feature civic-feature"); feature.dataset.recordId = featured.id;
    const copy = node("div", undefined, "civic-feature-copy");
    copy.append(node("p", `${featured.categories?.[0] || "地方專題"} · ${featured.status || ""}`, "stage civic-kicker"));
    const heading = node("h3"), title = node("a", titleFor(featured)); title.href = url; heading.append(title);
    copy.append(heading, node("p", summaryFor(featured)));
    const funding = fundingOf(featured);
    if (funding?.collaboration) copy.append(node("p", funding.collaboration, "civic-collaboration"));
    const read = node("a", "閱讀歷程與資料來源 ↗", "source civic-read"); read.href = url + "#case-sources";
    copy.append(read, dated(featured)); feature.append(copy);
    const side = fundingFor(featured) || photoFor(featured, "civic-feature-photo");
    if (side) feature.append(side); else feature.classList.add("civic-feature--text-only");
    const stories = node("div", undefined, "stories"), reading = node("div", undefined, "story-list civic-reading");
    // Keep this fixed context image explicitly identified as Fengshan Station,
    // including when the editor changes which projects appear beside it.
    const station = photoFor(cases.get("metro-green-line"), "station civic-reading-photo", true);
    if (station) stories.append(station); else stories.classList.add("stories--text-only");
    home.reading.forEach(id => {
      const record = cases.get(id), article = node("article", undefined, "civic-reading-row"), row = node("div");
      article.dataset.recordId = id;
      row.append(node("p", `${record.categories?.[0] || "地方專題"} · ${record.status || ""}`, "meta civic-kicker"));
      const heading = node("h3"), title = node("a", titleFor(record)); title.href = `achievement-${id}.html`; heading.append(title);
      row.append(heading, node("p", summaryFor(record)), dated(record)); article.append(row); reading.append(article);
    });
    stories.append(reading); grid.replaceChildren(feature, stories);

    // Optional companion to the civic-home-map generated region. Filters remain
    // outside this container so their listeners and selected state survive.
    const map = document.querySelector("[data-home-map-records]");
    if (map) {
      const filter = document.querySelector('.filters [data-filter][aria-pressed="true"]')?.dataset.filter || "all";
      const rows = ids.map(id => {
        const record = cases.get(id), categories = record.categories || [], funding = fundingOf(record);
        const topic = categories.includes("教育與文化") ? "education" : categories.includes("交通與基建") ? "transport" : "other";
        const article = node("article", undefined, "place");
        article.dataset.topic = topic; article.dataset.recordId = id; article.hidden = filter !== "all" && filter !== topic;
        const title = node("a", `${titleFor(record)} ↗`); title.href = `achievement-${id}.html`;
        const status = funding ? `核定總經費${amountWan(funding.total)}萬元` : record.status || "";
        article.append(title, node("p", [...(record.villages || []), status].join("　／　"))); return article;
      });
      const status = node("p", `本頁精選${rows.filter(row => !row.hidden).length}筆，不代表全部案件或完工數。`, "meta");
      status.id = "filter-status"; status.setAttribute("aria-live", "polite");
      map.replaceChildren(...rows, status);
    }
  }
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
  function applyEditorialPreview(page, extra = false) {
    let body = document.querySelector(extra ? ".cms-extra" : ".editorial-body");
    if (extra && !body) {
      body = node("section",undefined,"wrap section editorial-body cms-extra");
      document.querySelector("main")?.append(body);
    }
    if (!body || !page || !Array.isArray(page.blocks)) return;
    if (!extra) {
      const h1 = document.querySelector(".page-head h1"); if (h1) h1.textContent = page.title || "";
      const intro = document.querySelector(".page-head h1 + p"); if (intro) intro.textContent = page.summary || "";
    }
    const nodes = [];
    if (page.eventStart) {
      const event = node("p"), start = node("time", String(page.eventStart).replace("T", " ").replace("+08:00", ""));
      start.dateTime = page.eventStart; event.append(start);
      if (page.eventEnd) { event.append(" – "); const end = node("time", String(page.eventEnd).replace("T", " ").replace("+08:00", "")); end.dateTime = page.eventEnd; event.append(end); }
      nodes.push(event);
    }
    for (const block of page.blocks.slice(0, 80)) {
      if (block.type === "heading") nodes.push(node("h2",block.title || ""));
      if (block.type === "paragraph") nodes.push(node("p",block.text || ""));
      if (block.type === "timeline") {
        const article = node("article",undefined,"content-card"), copy = node("div",undefined,"card-body"), time = node("time",block.date || "");
        time.dateTime = block.date || ""; copy.append(time,node("h2",block.title || ""),node("p",block.text || "")); article.append(copy); nodes.push(article);
      }
      if (block.type === "source") {
        const source = node("p",undefined,"source-note");
        if (block.date) { const time = node("time",block.date); time.dateTime=block.date; source.append(time," · "); }
        const link = node("a",(block.title || "資料來源") + " ↗"); link.href=block.url || "#"; link.target="_blank"; link.rel="noopener noreferrer";
        source.append(link); nodes.push(source);
      }
      if (["photo","video"].includes(block.type)) {
        const media = mediaPreview({kind:block.type,url:block.url,alt:block.alt,caption:block.text || block.title,credit:block.credit});
        if (media) nodes.push(media);
      }
      if (block.type === "map") {
        const card=node("div",undefined,"content-card"),copy=node("div",undefined,"card-body");
        copy.append(node("h2",block.title || "地點"),node("address",block.address || ""));
        if (block.address) { const a=node("a","開啟地圖 App 導航 ↗","button button-green"); a.href=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(block.address)}`; a.target="_blank"; a.rel="noopener noreferrer"; copy.append(a); }
        card.append(copy); nodes.push(card);
      }
    }
    if (!extra) {
      const updated=node("p",undefined,"source-note"),time=node("time",page.updated || ""); time.dateTime=page.updated || "";
      updated.append("內容整理 ",time); nodes.push(updated);
    }
    body.replaceChildren(...nodes);
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
    } else if (photos && !photos.children.length) { photos.remove(); photos = null; }
    if (photos && Array.isArray(data.images)) {
      const localPhotos = new Map();
      for (const child of photos.children) {
        if (child.classList.contains("case-external-media")) continue;
        const anchor = child.matches('a[href*="/assets/"]') ? child : child.querySelector('a[href*="/assets/"]');
        if (anchor) localPhotos.set(decodeURIComponent(new URL(anchor.href).pathname.split("/").at(-1) || ""), child);
      }
      photos.prepend(...data.images.map(filename => localPhotos.get(filename)).filter(Boolean));
    }
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
    const defaultOrder = ["overview", "media", "history", "sources"];
    const order = Array.isArray(data.sectionOrder) && data.sectionOrder.length === defaultOrder.length &&
      defaultOrder.every(key => data.sectionOrder.includes(key)) ? data.sectionOrder : defaultOrder;
    const sections = { overview: body.querySelector(".case-background"), media: photos,
      history: body.querySelector(".history-section"), sources: body.querySelector(".case-sources") };
    for (const key of order) if (sections[key]) body.append(sections[key]);
    const nav = document.querySelector(".civic-article-nav");
    if (nav) {
      const context = nav.querySelector('a[href="#case-context"]');
      const date = nav.querySelector("span");
      const links = { overview: ["#case-overview", "重點說明", Boolean(sections.overview)],
        media: ["#case-media", "照片與影片", Boolean(photos?.children.length)],
        history: ["#case-history", "推動歷程", Boolean(history.length)],
        sources: ["#case-sources", "資料來源", Boolean(sources.length)] };
      nav.replaceChildren();
      if (context) nav.append(context);
      for (const key of order) {
        const [href, label, visible] = links[key];
        if (visible) { const link = node("a", label + " ↓"); link.href = href; nav.append(link); }
      }
      if (date) nav.append(date);
    }
    send("huiwen-cms-ready", { blocks: [], seo: seoInfo() });
  }
  async function enable() {
    try {
      const route = pageRoute();
      if (/^page-(?:news|press|service|council|achievement)-[a-z0-9-]+\.html$/.test(route)) {
        document.addEventListener("click", (event) => { if (event.target.closest("main a")) event.preventDefault(); }, true);
        send("huiwen-cms-ready", { blocks: [], seo: seoInfo() });
        return;
      }
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
        send("huiwen-cms-ready", { blocks: [], seo: seoInfo() });
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
    send("huiwen-cms-ready", { blocks: collect(), seo: seoInfo() });
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
      send("huiwen-cms-ready", { blocks: collect(), seo: seoInfo() });
    }
    if (data.type === "huiwen-cms-case-preview" && /^achievement-[a-z0-9-]+\.html$/.test(pageRoute())) applyCasePreview(data.case);
    if (data.type === "huiwen-cms-home-preview" && pageRoute() === "index.html") applyHomePreview(data.home, data.cases);
    if (data.type === "huiwen-cms-seo-preview") applySeoPreview(data.seo);
    if (data.type === "huiwen-cms-editorial-preview" && /^page-(?:news|press|service|council|achievement)-[a-z0-9-]+\.html$/.test(pageRoute())) applyEditorialPreview(data.page);
    if (data.type === "huiwen-cms-extra-preview" && Array.isArray(data.blocks)) applyEditorialPreview({blocks:data.blocks},true);
  });
  window.parent.postMessage({ type: "huiwen-cms-hello", path: `/${pageRoute()}` }, ADMIN_ORIGIN);
})();
