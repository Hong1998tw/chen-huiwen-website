"use strict";
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("cmsEdit") !== "1" || window.parent === window) return;
  const ADMIN_ORIGIN = "https://admin.huiwen.tw";
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
  function enable() {
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
      enable();
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
