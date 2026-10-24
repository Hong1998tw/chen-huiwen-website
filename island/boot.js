// 進站順序：先出清單（不等 3D），再載 3D。
// 3D 建不起來（沒有 WebGL、模型或程式出錯）時，改成只有清單的閱讀模式，內容照樣能讀、能搜尋。
import { createListFallback } from "./list-fallback.js";

const list = createListFallback(document.getElementById("panel-body"));
window.__listFallback = list;

const hasWebGL = (() => {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
})();

function listOnly(reason) {
  document.body.classList.add("no3d");
  document.getElementById("loading")?.remove();
  const note = document.createElement("div");
  note.className = "no3d-note";
  note.setAttribute("role", "status");
  note.innerHTML = `<p><b>${reason}</b>，先用清單瀏覽；所有政績、搜尋與來源都在這裡。</p><button type="button">再試一次</button>`;
  note.querySelector("button").addEventListener("click", () => location.reload());
  document.getElementById("panel")?.prepend(note);
}

if (!hasWebGL) listOnly("這台裝置的瀏覽器無法顯示 3D 地圖");
else import("./app.js").catch((err) => { console.error("3D 地圖載入失敗", err); listOnly("3D 地圖這次沒有載入成功"); });
