// 慧文政績島・鄉親布告欄（前端模組，搭配同目錄的樣式表 board.css）。
// 整合方式（由整合者接線，不改 app.js / index.html）：從本模組取用 createBoard 與 drawBoardCanvas，
//   const board = createBoard({ apiBase: "https://board.huiwen.tw", adminUrl: "https://admin.huiwen.tw/board",
//                               siteKey: "<Turnstile site key>", container: document.body,
//                               onNotes: (notes) => { texture.image = drawBoardCanvas(notes); texture.needsUpdate = true; } });
//   someButton.addEventListener("click", () => board.open(someButton));
// 規則：先審後刊。送出的留言只在本機顯示「待確認」，服務團隊在後台按「確認」後才公開。
// （注意：這段說明刻意不寫成 import 敘述，避免公開站的資產指紋工具把註解當成自我引用。）

const BODY_MAX = 80;
const NICKNAME_MAX = 10;
const DEFAULT_NICKNAME = "鳳山鄉親";
const PURGE_LABEL = "2026 年 12 月 28 日";
const MINE_KEY = "huiwen-board-mine-v1";
const MINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MINE_STALE_MS = 2 * 24 * 60 * 60 * 1000;
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const NOTE_COLORS = ["#fff3a8", "#d9f2e6", "#ffe0e6", "#dcecff", "#ffe7c2"];
const FONT = '"Huiwen Sans TC", "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';

const cleanText = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
const count = (v) => Array.from(cleanText(v)).length;
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0; };
const colorFor = (id) => NOTE_COLORS[hash(id) % NOTE_COLORS.length];
const tiltFor = (id) => ((hash(`${id}~`) % 50) / 10 - 2.5).toFixed(1);
const shortDate = (iso) => {
  try { return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" }).format(new Date(iso)); }
  catch { return ""; }
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  node.append(...children.filter(Boolean));
  return node;
}

function svgLock() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const body = document.createElementNS(ns, "rect");
  Object.entries({ x: 5, y: 11, width: 14, height: 10, rx: 2 }).forEach(([k, v]) => body.setAttribute(k, v));
  const shackle = document.createElementNS(ns, "path");
  shackle.setAttribute("d", "M8 11V8a4 4 0 0 1 8 0v3");
  svg.append(body, shackle);
  return svg;
}

// ── 本機「待確認」回聲：只存在這台裝置，不會送到別處 ──
function readMine() {
  try {
    const list = JSON.parse(localStorage.getItem(MINE_KEY) || "[]");
    const now = Date.now();
    return Array.isArray(list) ? list.filter((n) => n && typeof n.id === "string" && typeof n.body === "string" && now - Date.parse(n.created_at) < MINE_TTL_MS) : [];
  } catch { return []; }
}
function writeMine(list) {
  try { localStorage.setItem(MINE_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* 無痕模式等情況：略過 */ }
}

// ── Turnstile：只在打開表單時才載入 challenges.cloudflare.com 的程式 ──
let turnstileLoading = null;
function loadTurnstile() {
  if (window.turnstile?.render) return Promise.resolve(window.turnstile);
  if (turnstileLoading) return turnstileLoading;
  turnstileLoading = new Promise((resolve, reject) => {
    const callback = `__huiwenBoardTurnstile${hash(String(Math.random()))}`;
    const timer = setTimeout(() => fail(), 15000);
    function fail() { clearTimeout(timer); delete window[callback]; turnstileLoading = null; reject(new Error("turnstile")); }
    window[callback] = () => { clearTimeout(timer); delete window[callback]; resolve(window.turnstile); };
    const script = document.createElement("script");
    script.src = `${TURNSTILE_SRC}&onload=${callback}`;
    script.async = true;
    script.onerror = fail;
    document.head.append(script);
  });
  return turnstileLoading;
}

/**
 * 建立布告欄對話框。
 * @param {{apiBase?: string, adminUrl?: string, siteKey?: string, container?: HTMLElement, onNotes?: (notes: Array<object>) => void}} options
 */
export function createBoard({
  apiBase = "https://board.huiwen.tw",
  adminUrl = "https://admin.huiwen.tw/board",
  siteKey = "",
  container = document.body,
  onNotes = null,
} = {}) {
  const endpoint = `${String(apiBase).replace(/\/+$/, "")}/api/board`;
  const uid = `hwb-${hash(String(Math.random())).toString(36)}`;
  const id = (name) => `${uid}-${name}`;
  const siteKeyReady = typeof siteKey === "string" && siteKey.length > 10 && !/REPLACE/i.test(siteKey);

  let published = [];
  let mine = readMine();
  let loaded = false;
  let loading = null;
  let closed = false;
  let opener = null;
  let token = "";
  let widgetId = null;
  let sending = false;

  // ── 結構 ──
  const title = el("h2", { id: id("title"), className: "hwb-title", tabindex: "-1", text: "鄉親布告欄" });
  const desc = el("p", { id: id("desc"), className: "hwb-desc" },
    "想對慧文說的話，寫成一張便利貼。留言經服務團隊確認後才會貼上；請勿留下電話、地址或證號。",
    el("span", { className: "hwb-purge", text: `所有留言將於 ${PURGE_LABEL} 刪除。` }));
  const admin = el("a", { className: "hwb-admin", href: adminUrl, target: "_blank", rel: "noopener noreferrer", title: "服務團隊登入後審核留言" },
    svgLock(), el("span", { text: "管理" }));
  const closeButton = el("button", { type: "button", className: "hwb-close", "aria-label": "關閉布告欄" }, el("span", { "aria-hidden": "true", text: "×" }));
  const notesList = el("ul", { className: "hwb-notes", "aria-label": "布告欄上的留言", "aria-busy": "true" });
  const listStatus = el("p", { className: "hwb-list-status", role: "status", "aria-live": "polite" });
  const retry = el("button", { type: "button", className: "hwb-ghost", hidden: true, text: "重新整理" });
  const writeButton = el("button", { type: "button", className: "hwb-primary hwb-write", "aria-expanded": "false", "aria-controls": id("form"), text: "寫一張便利貼" });

  const nickname = el("input", { id: id("nickname"), name: "nickname", type: "text", autocomplete: "off", enterkeyhint: "next", placeholder: DEFAULT_NICKNAME, "aria-describedby": id("nickname-hint") });
  const nicknameHint = el("span", { id: id("nickname-hint"), className: "hwb-hint", text: `選填，最多 ${NICKNAME_MAX} 字；不填會顯示「${DEFAULT_NICKNAME}」` });
  const body = el("textarea", { id: id("body"), name: "body", rows: "3", required: true, autocomplete: "off", "aria-describedby": `${id("counter")} ${id("body-hint")}` });
  const counter = el("span", { id: id("counter"), className: "hwb-counter", text: `0 / ${BODY_MAX} 字` });
  const counterLive = el("span", { className: "hwb-sr", "aria-live": "polite" });
  const bodyHint = el("span", { id: id("body-hint"), className: "hwb-hint", text: "不能包含網址、電話、門牌、身分證字號、電子郵件或不雅字詞。" });
  const turnstileBox = el("div", { className: "hwb-turnstile" });
  const turnstileNote = el("p", { className: "hwb-hint hwb-turnstile-note", text: "正在載入人機驗證…" });
  const formMessage = el("p", { className: "hwb-message", role: "status", "aria-live": "polite" });
  const submit = el("button", { type: "submit", className: "hwb-primary", text: "送出，等候確認" });
  const cancel = el("button", { type: "button", className: "hwb-ghost", text: "取消" });
  const form = el("form", { id: id("form"), className: "hwb-form", hidden: true, novalidate: true, "aria-labelledby": id("form-title") },
    el("h3", { id: id("form-title"), className: "hwb-form-title", text: "寫一張便利貼" }),
    el("div", { className: "hwb-field" }, el("label", { for: id("nickname"), text: "暱稱" }), nickname, nicknameHint),
    el("div", { className: "hwb-field" },
      el("div", { className: "hwb-label-row" }, el("label", { for: id("body"), text: "想說的話" }), counter),
      body, bodyHint, counterLive),
    turnstileBox, turnstileNote, formMessage,
    el("div", { className: "hwb-actions" }, cancel, submit));

  const dialog = el("dialog", { className: "hwb-dialog", "aria-labelledby": id("title"), "aria-describedby": id("desc") },
    el("div", { className: "hwb-sheet" },
      el("div", { className: "hwb-grip", "aria-hidden": "true" }),
      el("header", { className: "hwb-head" },
        el("div", { className: "hwb-head-text" }, el("p", { className: "hwb-kicker", text: "隆洋慧聚｜陳慧文議員 政績島" }), title),
        el("div", { className: "hwb-head-tools" }, admin, closeButton)),
      desc,
      el("div", { className: "hwb-scroll", role: "region", tabindex: "0", "aria-label": "布告欄留言（可捲動）" }, listStatus, notesList, retry),
      el("div", { className: "hwb-compose" }, writeButton, form)));
  container.append(dialog);

  // ── 便利貼 ──
  function noteItem(note, pending) {
    const li = el("li", { className: `hwb-note${pending ? " hwb-note--pending" : ""}` });
    li.style.setProperty("--hwb-note", colorFor(note.id));
    li.style.setProperty("--hwb-tilt", `${tiltFor(note.id)}deg`);
    const text = el("p", { className: "hwb-note-body", text: note.body });
    const by = el("p", { className: "hwb-note-by" },
      el("span", { className: "hwb-note-name", text: note.nickname || DEFAULT_NICKNAME }),
      el("time", { datetime: note.created_at, text: shortDate(note.created_at) }));
    if (pending) {
      // 超過 2 天仍未刊登：可能還在排隊，也可能未獲刊登（封存或刪除不會通知送出者）。
      const stale = Date.now() - Date.parse(note.created_at) > MINE_STALE_MS;
      li.append(
        el("span", { className: "hwb-badge", text: stale ? "仍在等候確認或未獲刊登" : "待確認" }),
        el("span", { className: "hwb-sr", text: stale ? "（你送出的留言已超過兩天仍未公開，可能還在等候確認或未獲刊登）" : "（你剛送出的留言，服務團隊確認後才會公開）" }));
    }
    li.append(text, by);
    return li;
  }

  function combinedNotes() {
    const ids = new Set(published.map((n) => n.id));
    const stillPending = mine.filter((n) => !ids.has(n.id));
    if (stillPending.length !== mine.length) { mine = stillPending; writeMine(mine); }
    return [...stillPending.map((n) => ({ ...n, pending: true })), ...published.map((n) => ({ ...n, pending: false }))];
  }

  function render() {
    const notes = combinedNotes();
    notesList.replaceChildren(...notes.map((n) => noteItem(n, n.pending)));
    notesList.setAttribute("aria-busy", "false");
    if (closed) listStatus.textContent = "布告欄已結束收件，所有留言已依公告刪除。";
    else if (!notes.length && loaded) listStatus.textContent = "還沒有留言，來寫第一張吧！";
    else if (loaded) listStatus.textContent = `共 ${published.length} 張已貼上${notes.length > published.length ? `、${notes.length - published.length} 張待確認` : ""}。`;
    writeButton.hidden = closed;
    if (closed) form.hidden = true;
    if (typeof onNotes === "function") { try { onNotes(notes); } catch (error) { console.error("布告欄貼圖更新失敗", error); } }
    return notes;
  }

  async function refresh() {
    if (loading) return loading;
    listStatus.textContent = "正在讀取留言…";
    notesList.setAttribute("aria-busy", "true");
    retry.hidden = true;
    loading = (async () => {
      try {
        const response = await fetch(endpoint, { mode: "cors", credentials: "omit", headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json();
        published = Array.isArray(data.notes) ? data.notes.filter((n) => n && typeof n.id === "string" && typeof n.body === "string") : [];
        closed = data.closed === true;
        // 保存期限已到：本機暫存的待確認留言也一併清掉，不再顯示（含 3D 布告欄貼圖）。
        if (closed && mine.length) { mine = []; writeMine(mine); }
        loaded = true;
        return render();
      } catch {
        loaded = true;
        const notes = render();
        listStatus.textContent = "布告欄暫時讀不到，請稍後再試。";
        retry.hidden = false;
        return notes;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  // ── 表單 ──
  function updateCounter() {
    const n = count(body.value);
    counter.textContent = `${n} / ${BODY_MAX} 字`;
    counter.classList.toggle("hwb-over", n > BODY_MAX);
    const left = BODY_MAX - n;
    counterLive.textContent = left < 0 ? `超過 ${-left} 字` : left <= 10 ? `還可以寫 ${left} 字` : "";
  }

  function setMessage(text, kind = "info") {
    formMessage.textContent = text;
    formMessage.classList.toggle("hwb-error", kind === "error");
    formMessage.setAttribute("role", kind === "error" ? "alert" : "status");
  }

  function markInvalid(field) {
    for (const input of [nickname, body]) input.removeAttribute("aria-invalid");
    const target = field === "nickname" ? nickname : field === "body" ? body : null;
    if (target) { target.setAttribute("aria-invalid", "true"); target.focus(); }
  }

  async function mountTurnstile() {
    if (!siteKeyReady) {
      turnstileNote.textContent = "留言功能準備中，暫時無法送出。";
      submit.disabled = true;
      return;
    }
    if (widgetId !== null) return;
    turnstileNote.textContent = "正在載入人機驗證…";
    try {
      const turnstile = await loadTurnstile();
      if (widgetId !== null || form.hidden) return;
      widgetId = turnstile.render(turnstileBox, {
        sitekey: siteKey,
        action: "board_note",
        language: "zh-tw",
        theme: "light",
        size: "flexible",
        callback: (t) => { token = t; turnstileNote.textContent = "人機驗證完成。"; },
        "expired-callback": () => { token = ""; turnstileNote.textContent = "人機驗證已過期，請再驗證一次。"; },
        "error-callback": () => { token = ""; turnstileNote.textContent = "人機驗證失敗，請重新整理後再試。"; },
      });
      turnstileNote.textContent = "請完成上方的人機驗證。";
    } catch {
      turnstileNote.textContent = "人機驗證載入失敗，請檢查網路後重新打開表單。";
    }
  }

  function resetTurnstile() {
    token = "";
    if (widgetId !== null && window.turnstile?.reset) {
      turnstileNote.textContent = "每次送出都要重新驗證，請稍候…";
      try { window.turnstile.reset(widgetId); } catch { /* ignore */ }
    }
  }

  function openForm() {
    form.hidden = false;
    writeButton.setAttribute("aria-expanded", "true");
    writeButton.hidden = true;
    setMessage("");
    updateCounter();
    body.focus();
    mountTurnstile();
  }

  function closeForm({ focusWrite = true } = {}) {
    form.hidden = true;
    writeButton.hidden = closed;
    writeButton.setAttribute("aria-expanded", "false");
    if (focusWrite && !closed) writeButton.focus();
  }

  async function send(event) {
    event.preventDefault();
    if (sending) return;
    const nick = cleanText(nickname.value);
    const text = cleanText(body.value);
    markInvalid(null);
    if (!text) { setMessage("請寫下想說的話（1 到 80 個字）。", "error"); markInvalid("body"); return; }
    if (count(text) > BODY_MAX) { setMessage(`留言最多 ${BODY_MAX} 個字，請精簡後再送出。`, "error"); markInvalid("body"); return; }
    if (count(nick) > NICKNAME_MAX) { setMessage(`暱稱最多 ${NICKNAME_MAX} 個字。`, "error"); markInvalid("nickname"); return; }
    if (!siteKeyReady) { setMessage("留言功能準備中，暫時無法送出。", "error"); return; }
    if (!token) { setMessage("請先完成人機驗證再送出。", "error"); return; }
    sending = true;
    submit.disabled = true;
    submit.textContent = "送出中…";
    setMessage("");
    try {
      let response, data = {};
      try {
        response = await fetch(endpoint, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ nickname: nick, body: text, turnstileToken: token }),
        });
        data = await response.json().catch(() => ({}));
      } catch {
        throw new Error("網路連線不穩，留言沒有送出，請稍後再試。");
      }
      if (!response.ok) throw Object.assign(new Error(data.error || "留言沒有送出，請稍後再試。"), { field: data.field });
      const mineNote = { id: data.id, nickname: data.nickname && data.nickname !== DEFAULT_NICKNAME ? data.nickname : nick, body: data.body || text, created_at: data.created_at || new Date().toISOString() };
      mine = [mineNote, ...mine.filter((n) => n.id !== mineNote.id)];
      writeMine(mine);
      body.value = "";
      nickname.value = "";
      updateCounter();
      closeForm({ focusWrite: false });
      render();
      listStatus.textContent = "已送出！服務團隊確認後就會貼上布告欄；在那之前只有你看得到「待確認」的便利貼。";
      notesList.querySelector(".hwb-note--pending")?.scrollIntoView({ block: "nearest" });
      writeButton.focus();
    } catch (error) {
      setMessage(error.message, "error");
      markInvalid(error.field);
    } finally {
      resetTurnstile();
      sending = false;
      submit.disabled = !siteKeyReady;
      submit.textContent = "送出，等候確認";
    }
  }

  // ── 對話框 ──
  function open(trigger) {
    opener = trigger || document.activeElement;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    document.documentElement.classList.add("hwb-locked");
    title.focus();
    if (!loaded) refresh(); else render();
  }
  function close() {
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }
  dialog.addEventListener("close", () => {
    document.documentElement.classList.remove("hwb-locked");
    if (!form.hidden) closeForm({ focusWrite: false });
    if (opener && typeof opener.focus === "function" && opener.isConnected) opener.focus();
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  closeButton.addEventListener("click", close);
  retry.addEventListener("click", () => refresh());
  writeButton.addEventListener("click", openForm);
  cancel.addEventListener("click", () => { markInvalid(null); setMessage(""); closeForm(); });
  body.addEventListener("input", updateCounter);
  form.addEventListener("submit", send);

  function destroy() {
    close();
    if (widgetId !== null && window.turnstile?.remove) { try { window.turnstile.remove(widgetId); } catch { /* ignore */ } }
    dialog.remove();
  }

  return {
    open,
    close,
    refresh,
    destroy,
    get notes() { return combinedNotes(); },
    get element() { return dialog; },
  };
}

/**
 * 畫一張軟木布告欄（給 3D 看板當貼圖用，例如 new THREE.CanvasTexture(drawBoardCanvas(notes))）。
 * @param {Array<{id: string, nickname?: string, body: string, created_at?: string, pending?: boolean}>} notes
 * @param {{width?: number, height?: number, title?: string, max?: number}} [options]
 * @returns {HTMLCanvasElement}
 */
export function drawBoardCanvas(notes = [], { width = 1024, height = 640, title = "鄉親布告欄", max = 8 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const s = width / 1024;

  // 木框與軟木
  ctx.fillStyle = "#7a4b25";
  ctx.fillRect(0, 0, width, height);
  const frame = 26 * s;
  ctx.fillStyle = "#c99a62";
  ctx.fillRect(frame, frame, width - frame * 2, height - frame * 2);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = rnd() > 0.5 ? "rgba(120, 78, 38, .22)" : "rgba(255, 230, 190, .25)";
    ctx.fillRect(frame + rnd() * (width - frame * 2), frame + rnd() * (height - frame * 2), (1 + rnd() * 2.5) * s, (1 + rnd() * 2.5) * s);
  }

  // 標題
  const bannerH = 64 * s;
  ctx.fillStyle = "#075548";
  roundRect(ctx, width / 2 - 190 * s, frame + 14 * s, 380 * s, bannerH, 12 * s);
  ctx.fill();
  ctx.fillStyle = "#fffdf7";
  ctx.font = `900 ${34 * s}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, width / 2, frame + 14 * s + bannerH / 2);

  const list = (notes.length ? notes : [{ id: "invite", nickname: "慧文", body: "寫下想對慧文說的話，貼上鳳山的布告欄！" }]).slice(0, max);
  const cols = Math.min(4, Math.max(1, list.length <= 2 ? list.length : Math.ceil(list.length / 2)));
  const rows = Math.ceil(list.length / cols);
  const top = frame + bannerH + 36 * s;
  const areaW = width - frame * 2 - 40 * s;
  const areaH = height - top - frame - 22 * s;
  const cellW = areaW / cols;
  const cellH = areaH / rows;
  const noteW = Math.min(cellW - 26 * s, 220 * s);
  const noteH = Math.min(cellH - 22 * s, 210 * s);

  list.forEach((note, i) => {
    const cx = frame + 20 * s + cellW * (i % cols) + cellW / 2;
    const cy = top + cellH * Math.floor(i / cols) + cellH / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((Number(tiltFor(note.id)) * Math.PI) / 180);
    ctx.shadowColor = "rgba(40, 24, 8, .35)";
    ctx.shadowBlur = 10 * s;
    ctx.shadowOffsetY = 5 * s;
    ctx.fillStyle = colorFor(note.id);
    ctx.fillRect(-noteW / 2, -noteH / 2, noteW, noteH);
    ctx.shadowColor = "transparent";
    if (note.pending) {
      ctx.setLineDash([8 * s, 6 * s]);
      ctx.strokeStyle = "#9b651a";
      ctx.lineWidth = 3 * s;
      ctx.strokeRect(-noteW / 2 + 4 * s, -noteH / 2 + 4 * s, noteW - 8 * s, noteH - 8 * s);
      ctx.setLineDash([]);
    }
    // 圖釘
    ctx.fillStyle = "#d9463b";
    ctx.beginPath();
    ctx.arc(0, -noteH / 2 + 12 * s, 8 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.6)";
    ctx.beginPath();
    ctx.arc(-2.5 * s, -noteH / 2 + 9.5 * s, 2.5 * s, 0, Math.PI * 2);
    ctx.fill();
    // 內文
    const pad = 16 * s;
    const fontSize = Math.max(16, Math.round(22 * s * Math.min(1, noteW / (210 * s))));
    ctx.fillStyle = "#1b302b";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `700 ${fontSize}px ${FONT}`;
    const lineH = fontSize * 1.35;
    const maxLines = Math.max(1, Math.floor((noteH - pad * 2 - 30 * s - (note.pending ? 24 * s : 0)) / lineH));
    let y = -noteH / 2 + pad + 14 * s;
    if (note.pending) {
      ctx.fillStyle = "#9b651a";
      ctx.font = `800 ${Math.round(fontSize * 0.75)}px ${FONT}`;
      ctx.fillText("待確認", -noteW / 2 + pad, y);
      y += 24 * s;
      ctx.fillStyle = "#1b302b";
      ctx.font = `700 ${fontSize}px ${FONT}`;
    }
    for (const line of wrap(ctx, note.body, noteW - pad * 2, maxLines)) {
      ctx.fillText(line, -noteW / 2 + pad, y);
      y += lineH;
    }
    ctx.fillStyle = "#586a64";
    ctx.font = `600 ${Math.round(fontSize * 0.72)}px ${FONT}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(`— ${note.nickname || DEFAULT_NICKNAME}`, noteW / 2 - pad, noteH / 2 - pad * 0.7);
    ctx.restore();
  });
  return canvas;
}

function wrap(ctx, text, maxWidth, maxLines) {
  const chars = Array.from(cleanText(text));
  const lines = [];
  let line = "";
  let i = 0;
  for (; i < chars.length && lines.length < maxLines; i++) {
    const ch = chars[i];
    if (line && ctx.measureText(line + ch).width > maxWidth) {
      lines.push(line);
      line = ch === " " ? "" : ch;
    } else line += ch;
  }
  if (lines.length < maxLines && line) { lines.push(line); line = ""; }
  const truncated = i < chars.length || line !== "";
  if (truncated && lines.length) {
    let last = Array.from(lines[lines.length - 1]);
    while (last.length && ctx.measureText(`${last.join("")}…`).width > maxWidth) last.pop();
    lines[lines.length - 1] = `${last.join("")}…`;
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
