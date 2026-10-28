// 不靠 3D 的清單：進站先出現，3D 載入中就能讀；3D 載不起來時，整頁改用這份清單。
// 只用 island-data.json，不碰 Three.js。點島時把 ?island= 寫進網址，3D 起來後會直接開那座島。

import { resolveItemIndex, safeURL } from "./dot-code-2/island-data-adapter.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const shortText = (t, n = 46) => {
  const s = String(t || "").split(/(?<=。)/)[0].trim();
  if (s.length <= n) return s;
  const cut = Math.max(...["、", "；", "，", "："].map((m) => s.lastIndexOf(m, n)));
  return (cut > n * 0.5 ? s.slice(0, cut) : s.slice(0, n)) + "…";
};
const AXIS_COLOR = { A1: "#4f9fc4", A2: "#e4994a", A3: "#e48f9e", A4: "#8f84cf", AX: "#6fae6a", AQ: "#075548" };
const badge = (isl) => (isl.kind === "pledge" ? isl.id.slice(1).replace(/^0/, "") : isl.kind === "interpellation" ? "質" : "績");

export function createListFallback(body) {
  let data = null, view = { name: "home", island: null, item: -1, query: "" }, active = true;
  const byIsland = new Map();

  const item = (it) => `<article class="item"><h4><button type="button" class="item-title" data-fb="item" data-id="${esc(it.id)}">${esc(it.t)}</button></h4>${(it.h || []).length ? `<ul class="mini-tl">${it.h.slice(-3).map(([d, t]) => `<li><time>${esc(d)}</time>${esc(t)}</li>`).join("")}</ul>` : ""}</article>`;

  function home() {
    const counts = (id) => (byIsland.get(id) || []).length;
    let html = `<p class="p-kicker">做得到的承諾，看得見的改變。</p><h2 class="p-title">一座島，一個承諾</h2><p class="axis">全庫 ${data.items.length} 筆</p>
      <input class="search" type="search" placeholder="搜尋政績、地名、里名…" value="${esc(view.query)}" data-fb="search" aria-label="搜尋">`;
    if (view.query.trim()) {
      const q = view.query.trim();
      const hits = data.items.filter((it) => it.t.includes(q) || (it.s || "").includes(q) || (it.v || []).some((v) => v.includes(q)));
      html += `<p class="axis">找到 ${hits.length} 筆</p>${hits.slice(0, 60).map(item).join("") || `<p class="empty">沒有符合的項目。</p>`}`;
      return html;
    }
    for (const axis of data.axes) {
      const list = (axis.islands || []).map((id) => data.islands.find((i) => i.id === id)).filter(Boolean);
      if (!list.length) continue;
      html += `<p class="axis">${esc(axis.name)}</p>`;
      for (const isl of list) {
        html += `<button type="button" class="isl-row" data-fb="island" data-id="${isl.id}"><span class="dot" style="background:${AXIS_COLOR[isl.axis] || "#6fae6a"}">${badge(isl)}</span>
          <span class="name">${esc(isl.name)}<small>${esc(isl.pledge || isl.note || "")}${counts(isl.id) ? `・${counts(isl.id)} 筆` : ""}</small></span></button>`;
      }
    }
    return html;
  }

  function island() {
    const isl = data.islands.find((i) => i.id === view.island);
    if (!isl) return home();
    const items = byIsland.get(isl.id) || [];
    const flags = (isl.flagships || []).slice(0, 3).map((n) => data.items[n]?.t).filter(Boolean);
    const pols = (data.laiPolicies || []).filter((p) => p.islands.includes(isl.id));
    const acts = (data.laiAchievements || []).filter((a) => a.islands.includes(isl.id));
    const lai = pols.length || acts.length ? `<section class="lai-block"><h4>賴瑞隆在這座島的政見與政績</h4><ul>${[
      ...pols.map((p) => `<li><b>${esc(p.title)}</b><small>市長政見</small><span>${esc(shortText(p.summary))}${p.sourceURL ? ` <a href="${esc(p.sourceURL)}" target="_blank" rel="noopener">來源</a>` : ""}</span></li>`),
      ...acts.map((a) => `<li><b>${esc(a.title)}</b><small>立委政績</small><span>${esc(shortText(a.detail))}</span></li>`),
    ].join("")}</ul></section>` : "";
    return `<button type="button" class="back" data-fb="home">← 全部島嶼</button>
      <h2 class="p-title">${esc(isl.name)}</h2>
      ${isl.pledge ? `<div class="pledge"><small>2026 政見</small><p>${esc(isl.pledge)}</p></div>` : isl.note ? `<div class="pledge"><small>長期推動政見</small><p>${esc(isl.note)}</p></div>` : ""}
      ${flags.length ? `<div class="hw-sum"><b>慧文做了什麼</b><p>${flags.map(esc).join("、")}。</p></div>` : ""}
      ${lai}
      ${items.slice(0, 80).map((n) => item(data.items[n])).join("")}${items.length > 80 ? `<p class="empty">另有 ${items.length - 80} 筆，請用搜尋查。</p>` : ""}`;
  }

  function itemDetail() {
    const back = `<button type="button" class="back" data-fb="home">← 返回全庫</button>`;
    const it = data.items[view.item];
    if (!it) return `${back}<p class="empty">找不到這筆工作紀錄，請返回全庫搜尋。</p>`;
    const source = safeURL(it.url || it.sourceURL || it.sourceUrl);
    const sourceLabel = it.url ? "查看完整專題" : "查看資料來源";
    return `${back}<article class="item"><h2 class="p-title">${esc(it.t)}</h2>
      ${it.s ? `<p class="card-sum">${esc(it.s)}</p>` : ""}
      ${(it.h || []).length ? `<ol class="card-tl">${it.h.map(([d, t]) => `<li><time>${esc(d)}</time>${esc(t)}</li>`).join("")}</ol>` : ""}
      ${source ? `<p><a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${sourceLabel}</a></p>` : ""}</article>`;
  }

  function render() {
    if (!active || !data) return;
    body.innerHTML = view.name === "item" ? itemDetail() : view.name === "island" ? island() : home();
    bindSearch();
  }

  function bindSearch() {
    const input = body.querySelector("[data-fb=search]");
    if (input) input.addEventListener("input", (e) => { view.query = e.target.value; const pos = e.target.selectionStart; render(); const again = body.querySelector("[data-fb=search]"); again?.focus(); again?.setSelectionRange(pos, pos); });
  }

  body.addEventListener("click", (e) => {
    if (!active) return;
    const el = e.target.closest("[data-fb]");
    if (!el) return;
    if (el.dataset.fb === "item") { view = { ...view, name: "item", item: resolveItemIndex(data, el.dataset.id) }; try { history.replaceState(null, "", `?item=${encodeURIComponent(el.dataset.id)}`); } catch {} }
    else if (el.dataset.fb === "island") { view = { ...view, name: "island", island: el.dataset.id }; try { history.replaceState(null, "", `?island=${el.dataset.id}`); } catch {} }
    else if (el.dataset.fb === "home") { view = { ...view, name: "home", island: null }; try { history.replaceState(null, "", location.pathname); } catch {} }
    else return;
    render();
    body.scrollTop = 0;
  });

  const ready = fetch("./island-data.json").then((r) => r.json()).then((d) => {
    data = d;
    d.items.forEach((it, n) => { if (!byIsland.has(it.i)) byIsland.set(it.i, []); byIsland.get(it.i).push(n); });
    const params = new URLSearchParams(location.search), start = params.get("island");
    if (params.has("item")) view = { ...view, name: "item", item: resolveItemIndex(d, params.get("item")) };
    else if (start && d.islands.some((i) => i.id === start)) view = { ...view, name: "island", island: start };
    // 首頁清單已經預先寫在 index.html（字型契約：首屏只能出現靜態 HTML 裡的字），不用重畫
    if (view.name !== "home" || !body.hasAttribute("data-static-list")) render();
    else {
      view.query = body.querySelector("[data-fb=search]")?.value || "";
      if (view.query.trim()) render();
      else bindSearch();
    }
  });

  // 3D 起來後交棒：清單停止接管，面板交給 app.js
  return { ready, handOff() { active = false; } };
}
