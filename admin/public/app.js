"use strict";
let session,
  documents = [],
  pages = [],
  selected = null,
  dirty = false,
  previewVersion = null,
  selectedPage = null,
  pageDraft = null,
  pageFields = new Map(),
  pageNonce = null,
  pageReady = false,
  pageDraftApplied = false,
  pageDirty = false;
const $ = (s) => document.querySelector(s);
const statusNames = {
  queued: "等待發布",
  processing: "正在建置與檢查",
  pr_created: "等待 GitHub 檢查",
  failed: "發布未完成",
  no_change: "與網站相同",
  closed: "發布已取消",
  merged: "已合併，等待部署",
  deployed: "已部署，等待外部驗證",
  verified: "已上線並完成驗證",
};
const labels = {
  name: "活動名稱",
  start: "開始時間",
  end: "結束時間",
  content: "活動說明",
  registration: "參與／報名方式",
  sourceUrl: "公開來源網址",
  verifiedAt: "來源核對日",
  status: "活動狀態",
  changeNote: "異動原因",
  updatedAt: "來源更新日",
  reviewDueAt: "下次複查日",
  month: "月表月份",
  observedAt: "核對日",
  sourceTitle: "來源圖卡標題",
  nextReviewAt: "下次核對日",
  sessions: "諮詢時段",
};
const eventKeys = [
  "name",
  "start",
  "end",
  "content",
  "registration",
  "sourceUrl",
  "verifiedAt",
  "status",
  "changeNote",
  "updatedAt",
  "reviewDueAt",
];
const legalKeys = [
  "month",
  "sourceTitle",
  "sourceUrl",
  "observedAt",
  "nextReviewAt",
  "sessions",
];
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function notice(text) {
  $("#notice").textContent = text;
}
async function api(path, method = "GET", body) {
  const r = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { "X-CSRF-Token": session.csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) {
    let error;
    try {
      error = (await r.json()).error;
    } catch {}
    throw new Error(
      error || "連線中斷或登入已失效，請重新載入；未儲存內容仍保留在表單。",
    );
  }
  return r.json();
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  }
}
function displayDate(value) {
  return new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}
async function load() {
  documents = (await api("/api/documents")).documents;
  const list = $("#documents");
  list.replaceChildren();
  if (!documents.length)
    list.append(el("p", "正在等待首次同步網站內容，請稍後更新狀態。"));
  for (const d of documents) {
    const p = JSON.parse(d.payload),
      b = el(
        "button",
        d.domain === "events" ? p.name : `${p.month} 律師時間表`,
        "document",
      );
    b.type = "button";
    b.setAttribute("aria-current", String(selected?.id === d.id));
    b.append(el("small", `草稿 v${d.version} · ${displayDate(d.updated_at)}`));
    b.onclick = () => action(() => select(d));
    list.append(b);
  }
  await publications();
}
function renderPages() {
  const list = $("#page-tree");
  const query = $("#page-filter").value.trim().toLocaleLowerCase();
  list.replaceChildren();
  const matching = pages.filter((p) =>
    [p.title, p.path, p.source_path].some((s) => String(s || "").toLocaleLowerCase().includes(query)),
  );
  $("#page-count").textContent = `${pages.length} 頁`;
  if (!matching.length) {
    list.append(el("p", "沒有符合的頁面。", "tree-empty"));
    return;
  }
  const groups = new Map();
  const groupFor = (p) => {
    const path = p.path;
    if (path === "index.html") return "首頁";
    if (path.startsWith("achievement-") || ["achievements.html", "explore.html", "vision.html"].includes(path)) return "建設與政策";
    if (path.startsWith("news-") || ["news.html", "press.html", "gallery.html", "council-records.html"].includes(path)) return "新聞、媒體與議會";
    if (path.startsWith("activity-") || path.startsWith("history-") || path.includes("/index.html")) return "活動與主題專頁";
    if (["service.html", "service-guides.html", "service-print.html", "activities.html", "political-donation.html"].includes(path)) return "民眾服務";
    return "官網資訊與其他頁面";
  };
  for (const p of matching) {
    const group = groupFor(p);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(p);
  }
  const order = ["首頁", "建設與政策", "民眾服務", "新聞、媒體與議會", "活動與主題專頁", "官網資訊與其他頁面"];
  for (const name of order.filter((key) => groups.has(key))) {
    const details = el("details", undefined, "tree-group");
    details.open = !query || name === "首頁";
    const summary = el("summary");
    summary.append(el("span", name), el("small", `${groups.get(name).length} 頁`));
    const children = el("div", undefined, "tree-children");
    for (const p of groups.get(name).sort((a, b) => a.path.localeCompare(b.path))) {
      const button = el("button", undefined, "tree-page");
      button.type = "button";
      button.dataset.status = p.publication_status || "published";
      button.setAttribute("aria-current", String(selectedPage?.path === p.path ? "page" : "false"));
      const title = el("span", p.title || p.path);
      const sub = p.path === "index.html" ? "/" : `/${p.path}`;
      const state = p.publication_status === "deleted" ? "垃圾桶" : p.publication_status === "unpublished" ? "已下架" : p.draft_version ? `草稿 v${p.draft_version}` : p.editor_scope === "partial" ? "可編輯" : "僅檢視";
      button.append(title, el("small", `${sub} · ${state}`));
      button.onclick = () => action(() => selectPage(p));
      children.append(button);
    }
    details.append(summary, children);
    list.append(details);
  }
}
async function loadPages() {
  pages = (await api("/api/pages")).pages;
  if (selectedPage) selectedPage = pages.find((p) => p.path === selectedPage.path) || selectedPage;
  renderPages();
  if (selectedPage) pageControls();
}
const readOnlyKinds = new Set(["system", "legacy-redirect", "excluded-intake"]);
const pageUrl = (path) => path === "index.html" ? "/" : path.endsWith("/index.html") ? `/${path.slice(0, -10)}` : `/${path}`;
const pageRoute = (pathname) => pathname === "/" ? "index.html" : pathname.endsWith("/") ? `${pathname.slice(1)}index.html` : pathname.slice(1);
const isPageEditable = (page) => Boolean(page && page.editor_scope === "partial" && !readOnlyKinds.has(page.source_kind));
function pageStatusLabel(page) {
  const status = page?.publication_status || "published";
  return status === "deleted" ? "在垃圾桶，可還原" : status === "unpublished" ? "已下架，可還原" : "正式頁面";
}
function pageControls() {
  const editable = isPageEditable(selectedPage);
  const live = editable && (selectedPage?.publication_status || "published") === "published";
  const removed = editable && ["deleted", "unpublished"].includes(selectedPage?.publication_status);
  const pending = pages.some((p) => p.path === selectedPage?.path && p.pending_operation);
  $("#page-save").disabled = !editable || (!pageDirty && Boolean(pageDraft));
  $("#page-publish").disabled = !editable || !live || !pageDraft?.version || pageDirty || pending;
  $("#page-unpublish").disabled = !editable || !live || !pageDraft?.version || pageDirty || pending;
  $("#page-delete").disabled = !editable || !live || !pageDraft?.version || pageDirty || pending;
  $("#page-restore").hidden = !removed;
  $("#page-restore").disabled = !removed || !pageDraft?.version || pageDirty || pending;
  $("#page-open-live").href = `https://www.huiwen.tw${pageUrl(selectedPage?.path || "index.html")}`;
  $("#page-open-live").hidden = !selectedPage;
}
function setPageStatus(message) {
  $("#page-draft-status").textContent = message;
}
function applyDraftToFrame() {
  if (!pageReady || !selectedPage || !pageNonce) return;
  const fields = [...pageFields.entries()].map(([id, value]) => ({ id, ...value }));
  const frame = $("#page-frame");
  frame.contentWindow?.postMessage({ type: "huiwen-cms-apply", nonce: pageNonce, fields }, "*");
}
function applyCurrentPageEdits() {
  const path = selectedPage?.path;
  if (!path || !isPageEditable(selectedPage) || selectedPage.publication_status !== "published") {
    $("#page-frame").hidden = true;
    $("#page-editor-empty").hidden = false;
    $("#page-editor-empty p").textContent = selectedPage
      ? selectedPage.publication_status === "deleted" ? "此頁已在垃圾桶。可按「還原並重新發布」後再編輯。" : selectedPage.publication_status === "unpublished" ? "此頁已下架。可按「還原並重新發布」後再編輯。" : "此頁僅供檢視，原始來源不開放後台修改。"
      : "選擇左側頁面，正式網站的版面會在這裡載入。";
    return;
  }
  const frame = $("#page-frame");
  frame.hidden = false;
  $("#page-editor-empty").hidden = true;
  pageNonce = crypto.randomUUID();
  pageReady = false;
  pageDraftApplied = false;
  frame.onload = () => {
    frame.contentWindow?.postMessage({ type: "huiwen-cms-init", nonce: pageNonce }, "*");
  };
  frame.src = `/api/page-preview?path=${encodeURIComponent(path)}&session=${encodeURIComponent(pageNonce)}`;
}
async function selectPage(page) {
  if (pageDirty && !confirm("這一頁有尚未儲存的文字，確定切換頁面？")) return;
  selectedPage = page;
  pageDirty = false;
  pageDraft = null;
  pageFields = new Map();
  $("#page-editor-title").textContent = page.title || page.path;
  $("#page-path").textContent = `/${page.path} · 來源：${page.source_path}`;
  $("#page-status").textContent = pageStatusLabel(page);
  setPageStatus(isPageEditable(page) ? "正在讀取此頁草稿…" : "此頁僅供檢視，無法從這裡修改來源。");
  if (isPageEditable(page)) {
    const result = await api(`/api/page-draft?path=${encodeURIComponent(page.path)}`);
    pageDraft = result.draft;
    if (pageDraft?.payload) {
      const saved = JSON.parse(pageDraft.payload);
      pageFields = new Map(Object.entries(saved.fields || {}));
    }
    const history = await api(`/api/page-draft/history?path=${encodeURIComponent(page.path)}`);
    renderPageHistory(history.versions || []);
    $("#page-history-panel").hidden = !history.versions?.length;
    setPageStatus(pageDraft?.version ? `草稿 v${pageDraft.version} · ${pageDraft.publication_status === "unpublished" ? "已下架" : pageDraft.publication_status === "deleted" ? "垃圾桶" : "已儲存"}` : "尚無草稿；直接點選右側正式頁面文字開始編輯。");
  } else {
    $("#page-history-panel").hidden = true;
  }
  pageControls();
  renderPages();
  applyCurrentPageEdits();
}
function renderPageHistory(versions) {
  const target = $("#page-history");
  target.replaceChildren();
  for (const version of versions) {
    const row = el("div", undefined, "history-entry");
    row.append(el("span", `v${version.version} · ${displayDate(version.created_at)} · ${version.publication_status}`));
    if (version.version !== pageDraft?.version) {
      const restore = el("button", "還原此版本", "secondary");
      restore.type = "button";
      restore.onclick = () => action(async () => {
        if (!confirm(`將 v${version.version} 的文字還原成新草稿？目前版本會保留。`)) return;
        await api("/api/page-draft/restore", "POST", { path: selectedPage.path, version: pageDraft?.version || 0, restoreVersion: version.version });
        await selectPage(selectedPage);
        setPageStatus(`已還原為新草稿；需發布後才會更新正式頁面。`);
      });
      row.append(restore);
    }
    target.append(row);
  }
}
async function savePageDraft() {
  if (!selectedPage || !isPageEditable(selectedPage)) return;
  const result = await api("/api/page-draft", "PUT", {
    path: selectedPage.path,
    version: pageDraft?.version || 0,
    baseCommit: selectedPage.commit_sha,
    fields: [...pageFields.entries()].map(([id, value]) => ({ id, ...value })),
  });
  pageDirty = false;
  const updated = await api(`/api/page-draft?path=${encodeURIComponent(selectedPage.path)}`);
  pageDraft = updated.draft;
  selectedPage.draft_version = result.version;
  pageControls();
  await loadPages();
  const history = await api(`/api/page-draft/history?path=${encodeURIComponent(selectedPage.path)}`);
  renderPageHistory(history.versions || []);
  $("#page-history-panel").hidden = !history.versions?.length;
  setPageStatus(`草稿 v${result.version} 已儲存；正式頁面尚未變更。`);
}
async function submitPageOperation(operation) {
  if (!selectedPage || !isPageEditable(selectedPage)) return;
  if (pageDirty) {
    if (!confirm("目前有未儲存的文字，先儲存草稿再繼續？")) return;
    await savePageDraft();
  }
  if (!pageDraft?.version) await savePageDraft();
  const prompts = {
    publish: "送出這個頁面的草稿？通過必要檢查後會更新正式官網。",
    unpublish: "將此頁從正式官網下架？原始頁面與版本紀錄保留，可再還原。",
    delete: "將此頁移至可還原的垃圾桶？它會從正式官網下架，原始來源不會被刪除。",
    restore: "還原此頁並重新發布？必要檢查通過後會重新出現在正式官網。",
  };
  if (!confirm(prompts[operation])) return;
  const receipt = await api("/api/page-draft/publish", "POST", { path: selectedPage.path, version: pageDraft.version, operation });
  setPageStatus(`已送出${operation === "publish" ? "發布" : operation === "unpublish" ? "下架" : operation === "delete" ? "移入垃圾桶" : "還原發布"}要求 · ${statusNames[receipt.status] || receipt.status}`);
  await Promise.all([publications(), loadPages()]);
  pageControls();
}
window.addEventListener("message", (event) => {
  if (event.origin !== "null" || event.source !== $("#page-frame").contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== "object" || typeof data.path !== "string" || data.path.length > 300 || !selectedPage || pageRoute(data.path) !== selectedPage.path) return;
  if (data.type === "huiwen-cms-hello") {
    if (pageNonce) event.source.postMessage({ type: "huiwen-cms-init", nonce: pageNonce }, "*");
    return;
  }
  if (data.nonce !== pageNonce) return;
  if (data.type === "huiwen-cms-ready" && Array.isArray(data.blocks)) {
    pageReady = true;
    if (!pageDraftApplied) {
      pageDraftApplied = true;
      applyDraftToFrame();
    }
    return;
  }
  if (data.type === "huiwen-cms-error" && typeof data.message === "string") {
    pageReady = false;
    setPageStatus(data.message);
    return;
  }
  if (data.type === "huiwen-cms-change" && data.field && typeof data.field.id === "string") {
    pageFields.set(data.field.id, { sourceHash: data.field.sourceHash, value: data.field.value });
    pageDirty = true;
    setPageStatus("頁面文字有變更 · 儲存後才會進入發布流程");
    pageControls();
  }
});
async function select(d) {
  if (dirty && !confirm("尚有未儲存內容，確定離開這筆草稿？")) return;
  selected = d;
  dirty = false;
  render();
  await history();
}
function render() {
  const p = JSON.parse(selected.payload),
    container = $("#fields");
  container.replaceChildren();
  $("#editor-title").textContent =
    selected.domain === "events" ? "活動內容" : "公益律師月表";
  $("#record-type").textContent =
    selected.domain === "events" ? "公開行程與活動" : "市民服務";
  $("#version").textContent = selected.id
    ? `草稿 v${selected.version}`
    : "新活動";
  $("#conflict").hidden =
    !selected.published_hash || selected.base_hash === selected.published_hash;
  $("#editor-form").hidden = false;
  $("#history-panel").hidden = !selected.id;
  $("#refresh").disabled = !selected.id;
  for (const key of selected.domain === "events" ? eventKeys : legalKeys) {
    const label = el("label", labels[key], "field");
    let input;
    if (key === "status") {
      input = el("select");
      for (const [v, t] of [
        ["scheduled", "排定"],
        ["rescheduled", "改期"],
        ["cancelled", "取消"],
      ]) {
        const o = el("option", t);
        o.value = v;
        input.append(o);
      }
    } else if (["content", "sessions"].includes(key)) {
      input = el("textarea");
      input.rows = key === "sessions" ? 8 : 6;
    } else {
      input = el("input");
      input.type =
        key === "month"
          ? "month"
          : key === "sourceUrl"
            ? "url"
            : /At$/.test(key)
              ? "date"
              : ["start", "end"].includes(key)
                ? "datetime-local"
                : "text";
    }
    input.name = key;
    input.id = `field-${key}`;
    input.required = key !== "changeNote";
    input.value =
      key === "sessions"
        ? (p.sessions || [])
            .map((s) => `${s.date} ${s.start} ${s.end}`)
            .join("\n")
        : ["start", "end"].includes(key)
          ? String(p[key] || "").slice(0, 16)
          : (p[key] ?? "");
    if (["name", "content", "registration", "sourceUrl", "changeNote", "sourceTitle", "sessions"].includes(key)) label.classList.add("wide");
    label.append(input);
    if (key === "sessions")
      label.append(
        el("small", "每行一個時段：2026-10-01 19:30 21:00。每個日期只填一次。"),
      );
    container.append(label);
  }
  $("#preview").disabled = !selected.id;
  $("#editor-form").oninput = () => {
    dirty = true;
    $("#preview").disabled = true;
  };
}
function read() {
  const out = {};
  for (const [key, value] of new FormData($("#editor-form"))) {
    out[key] =
      key === "sessions"
        ? value
            .trim()
            .split("\n")
            .map((line) => {
              const [date, start, end, ...extra] = line.trim().split(/\s+/);
              if (extra.length)
                throw new Error("每行時段只需填日期、開始、結束。");
              return { date, start, end };
            })
        : ["start", "end"].includes(key)
          ? `${value}:00+08:00`
          : value || null;
  }
  return out;
}
async function save() {
  const payload = read();
  const result = selected.id
    ? await api(`/api/documents/${selected.id}`, "PUT", {
        version: selected.version,
        payload,
      })
    : await api("/api/documents", "POST", { domain: "events", payload });
  dirty = false;
  await load();
  selected = documents.find((d) => d.id === result.id);
  render();
  await history();
  notice("草稿已儲存，官網尚未變更。");
}
async function history() {
  const target = $("#history");
  target.replaceChildren();
  if (!selected.id) return;
  const data = await api(`/api/documents/${selected.id}/history`);
  for (const v of data.versions) {
    const row = el(
      "div",
      `v${v.version} · ${displayDate(v.created_at)} `,
      "history-row",
    );
    if (v.version !== selected.version) {
      const b = el("button", "還原為新草稿", "secondary");
      b.type = "button";
      b.onclick = () =>
        action(async () => {
          if (!confirm(`將 v${v.version} 還原為新草稿？既有歷史版本會保留。`))
            return;
          await api(`/api/documents/${selected.id}/restore`, "POST", {
            version: selected.version,
            restoreVersion: v.version,
          });
          dirty = false;
          const id = selected.id;
          await load();
          await select(documents.find((d) => d.id === id));
          notice("已還原為新草稿，尚未發布。");
        });
      row.append(b);
    }
    target.append(row);
  }
}
async function publications() {
  const result = await api("/api/publications");
  const target = $("#publications");
  target.replaceChildren();
  if (!result.publications.length)
    target.append(el("p", "尚未送出發布要求。", "hint"));
  for (const p of result.publications) {
    const row = el("article", undefined, "publication");
    row.append(
      el("strong", statusNames[p.status] || p.status),
      el("span", `v${p.version} · ${displayDate(p.updated_at)}`, "badge"),
      ...(p.path ? [el("p", `${p.path} · ${({ publish: "發布更新", unpublish: "下架", delete: "移至垃圾桶", restore: "還原發布" }[p.operation] || p.operation)}`)] : []),
      el("p", p.message || "已保存發布要求，等待處理。"),
    );
    if (p.pr_number) {
      const a = el("a", `檢視發布 #${p.pr_number} ↗`);
      a.href = `https://github.com/Hong1998tw/chen-huiwen-website/pull/${p.pr_number}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      row.append(a);
    }
    target.append(row);
  }
}
$("#editor-form").onsubmit = (e) => {
  e.preventDefault();
  action(save);
};
$("#preview").onclick = () => {
  if (dirty || !selected?.id) return;
  previewVersion = selected.version;
  const target = $("#preview-content");
  target.replaceChildren();
  const p = JSON.parse(selected.payload);
  for (const key of selected.domain === "events" ? eventKeys : legalKeys) {
    const dl = el("dl", undefined, "preview-item");
    dl.append(
      el("dt", labels[key]),
      el(
        "dd",
        key === "sessions"
          ? p.sessions.map((s) => `${s.date} ${s.start}–${s.end}`).join("\n")
          : p[key] || "—",
      ),
    );
    target.append(dl);
  }
  $("#preview-dialog").showModal();
};
$("#close-preview").onclick = () => $("#preview-dialog").close();
$("#publish").onclick = () =>
  action(async () => {
    const b = $("#publish");
    b.disabled = true;
    try {
      await api(`/api/documents/${selected.id}/publish`, "POST", {
        version: previewVersion,
      });
      $("#preview-dialog").close();
      notice("發布要求已保存。請在下方查看檢查與部署進度。");
      await publications();
    } finally {
      b.disabled = false;
    }
  });
$("#refresh").onclick = () =>
  action(async () => {
    if (
      !confirm(
        "載入目前網站內容作為新草稿？現有草稿會保留在版本紀錄。未儲存的表單內容會被取代。",
      )
    )
      return;
    const id = selected.id;
    await api(`/api/documents/${id}/refresh`, "POST", {
      version: selected.version,
    });
    dirty = false;
    await load();
    await select(documents.find((d) => d.id === id));
    notice("已載入網站版本，可以繼續編輯。");
  });
$("#new-event").onclick = () =>
  action(() =>
    select({
      domain: "events",
      version: 0,
      payload: JSON.stringify({ status: "scheduled" }),
    }),
  );
$("#reload").onclick = () =>
  action(async () => {
    await Promise.all([load(), loadPages()]);
    notice("清單與發布狀態已更新；正在編輯的表單保持不變。");
  });
window.addEventListener("beforeunload", (e) => {
  if (dirty || pageDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
$("#page-filter").oninput = renderPages;
$("#page-save").onclick = () => action(savePageDraft);
$("#page-publish").onclick = () => action(() => submitPageOperation("publish"));
$("#page-unpublish").onclick = () => action(() => submitPageOperation("unpublish"));
$("#page-delete").onclick = () => action(() => submitPageOperation("delete"));
$("#page-restore").onclick = () => action(() => submitPageOperation("restore"));
action(async () => {
  session = await api("/api/session");
  $("#identity").textContent = `${session.login} · 擁有者`;
  await Promise.all([load(), loadPages()]);
});
