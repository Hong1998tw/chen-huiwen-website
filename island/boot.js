// 進站順序：先出清單（不等 3D），再載 3D。
// 3D 建不起來（沒有 WebGL、模型或程式出錯）時，改成只有清單的閱讀模式，內容照樣能讀、能搜尋。
import { createListFallback } from "./list-fallback.js";

const list = createListFallback(document.getElementById("panel-body"));
window.__listFallback = list;

const hasWebGL = (() => {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
})();

function listOnly() {
  document.body.classList.add("no3d");
  document.getElementById("loading")?.remove();
  const note = document.getElementById("no3d-note");  // 提示文字預先寫在 index.html
  if (note) { note.hidden = false; document.getElementById("no3d-retry")?.addEventListener("click", () => location.reload()); }
}

if (!hasWebGL) listOnly();
else import("./app.js").catch((err) => { console.error("3D 地圖載入失敗", err); listOnly(); });
