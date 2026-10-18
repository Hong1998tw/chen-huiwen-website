(() => {
  const loader = document.currentScript;
  const params = new URLSearchParams(window.location.search);
  if (!loader || window.self === window.top || params.get("cmsEdit") !== "1") return;

  const source = loader.dataset.cmsEditorSrc;
  if (!source || document.querySelector("script[data-cms-editor-runtime]")) return;

  const loadEditor = () => {
    if (document.querySelector("script[data-cms-editor-runtime]")) return;
    const script = document.createElement("script");
    script.src = source;
    // Dynamic classic scripts do not honor defer; disable async execution instead.
    script.async = false;
    script.dataset.cmsEditorRuntime = "true";
    (document.head || document.documentElement).append(script);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadEditor, { once: true });
  } else {
    loadEditor();
  }
})();
