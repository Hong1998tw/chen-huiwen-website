"use strict";
// 布告欄審核：一則一列（時間、暱稱、內容、狀態）＋確認／封存／刪除三個按鈕。
(() => {
  const $ = (s) => document.querySelector(s);
  const list = $("#board-notes");
  const statusNames = { pending: "待確認", published: "已刊登", archived: "已封存" };
  const doneNames = { publish: "已確認刊登", archive: "已封存", delete: "已永久刪除" };
  let session = null;

  function notice(text, kind = "info") {
    const target = $("#notice");
    target.textContent = text;
    target.classList.toggle("notice-error", kind === "error" && Boolean(text));
    target.setAttribute("role", kind === "error" ? "alert" : "status");
    target.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  }

  async function api(path, method = "GET") {
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json", ...(session ? { "X-CSRF-Token": session.csrf } : {}) },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
    } catch {
      throw new Error("連線未完成，請確認網路後重試。");
    }
    let body = {};
    try { body = await response.json(); } catch { /* 非 JSON 錯誤頁 */ }
    if (!response.ok) throw new Error(body.error || "登入驗證或連線未完成，請重新載入頁面。");
    return body;
  }

  const time = (value) => new Date(value).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const excerpt = (text) => (Array.from(text).length > 14 ? Array.from(text).slice(0, 14).join("") + "…" : text);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, aria, handler) {
    const b = el("button", className, label);
    b.type = "button";
    b.setAttribute("aria-label", aria);
    b.addEventListener("click", handler);
    return b;
  }

  function paintRow(row, note) {
    row.dataset.status = note.status;
    row.querySelector(".board-status").textContent = statusNames[note.status] || note.status;
    row.querySelector(".board-publish").disabled = note.status === "published";
    row.querySelector(".board-archive").disabled = note.status === "archived";
    row.querySelector(".board-delete").disabled = false;
  }

  function renderRow(note) {
    const row = el("li", "board-row");
    row.dataset.id = note.id;
    const when = el("time", "board-time", time(note.created_at));
    when.dateTime = note.created_at;
    const short = excerpt(note.body);
    const actions = el("div", "board-actions");
    actions.append(
      button("確認", "board-publish", `確認刊登：${short}`, () => act(row, note, "publish")),
      button("封存", "secondary board-archive", `封存：${short}`, () => act(row, note, "archive")),
      button("刪除", "board-delete", `永久刪除：${short}`, () => act(row, note, "delete")),
    );
    row.append(when, el("span", "board-nickname", note.nickname), el("p", "board-body", note.body), el("span", "badge board-status"), actions);
    paintRow(row, note);
    return row;
  }

  function showEmpty() {
    if (!list.querySelector(".board-row")) list.replaceChildren(el("li", "board-empty", "目前沒有留言。"));
  }

  async function act(row, note, action) {
    if (action === "delete" && !window.confirm(`確定要永久刪除這則留言？\n\n「${note.body}」\n\n刪除後無法復原；若只是不想顯示，請改用「封存」。`)) return;
    const buttons = [...row.querySelectorAll("button")];
    const previous = buttons.map((b) => b.disabled);
    buttons.forEach((b) => { b.disabled = true; });
    try {
      if (action === "delete") {
        await api(`/api/board-notes/${encodeURIComponent(note.id)}`, "DELETE");
        const next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        showEmpty();
        const focusTarget = next?.querySelector("button:not(:disabled)");
        if (focusTarget) focusTarget.focus(); else $("#main").focus();
      } else {
        const saved = await api(`/api/board-notes/${encodeURIComponent(note.id)}/${action}`, "POST");
        Object.assign(note, saved);
        paintRow(row, note);
        const focusTarget = row.querySelector("button:not(:disabled)");
        if (focusTarget) focusTarget.focus();
      }
      notice(`${doneNames[action]}：「${excerpt(note.body)}」`);
    } catch (error) {
      buttons.forEach((b, i) => { b.disabled = previous[i]; });
      notice(error.message, "error");
    }
  }

  async function load() {
    try {
      session = await api("/api/session");
      $("#identity").textContent = `${session.login} · 擁有者`;
      const { notes } = await api("/api/board-notes");
      list.replaceChildren(...notes.map(renderRow));
      showEmpty();
      const pending = notes.filter((n) => n.status === "pending").length;
      notice(pending ? `有 ${pending} 則留言待確認。` : "");
    } catch (error) {
      list.replaceChildren(el("li", "board-empty", "留言清單讀取失敗。"));
      notice(error.message, "error");
    } finally {
      list.setAttribute("aria-busy", "false");
    }
  }

  load();
})();
