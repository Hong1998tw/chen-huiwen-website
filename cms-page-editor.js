"use strict";
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("cmsEdit") !== "1" || window.parent === window) return;
  const ADMIN_ORIGIN = "https://admin.huiwen.tw";
  const EDITABLE_TAGS = new Set(["h1", "h2", "h3", "h4", "p", "li", "blockquote", "figcaption", "dt", "dd"]);
  let nonce = null;
  const text = (node) => node.textContent || "";
  function send(type, payload = {}) {
    if (!nonce) return;
    window.parent.postMessage({ type, nonce, path: location.pathname, ...payload }, ADMIN_ORIGIN);
  }
  function collect() {
    return [...document.querySelectorAll("main [data-cms-edit-id]")].map((node) => ({
      id: node.dataset.cmsEditId,
      sourceHash: node.dataset.cmsSourceHash,
      value: text(node),
    }));
  }
  function pageRoute() {
    const path = location.pathname;
    if (!path.startsWith("/") || path.includes("..")) throw new Error("invalid page path");
    return path === "/" ? "index.html" : path.endsWith("/") ? `${path.slice(1)}index.html` : path.slice(1);
  }
  async function enable() {
    try {
      const route = pageRoute();
      const response = await fetch(`/cms-editor-manifests/${route}.json`, { cache: "no-store" });
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
      nonce = data.nonce;
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
  });
})();
