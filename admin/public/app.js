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
  pageDirty = false,
  caseDraft = null,
  caseBase = null,
  homeDraft = null,
  homeBase = null,
  homeCases = new Map(),
  seoDraft = null,
  seoBase = null,
  editorialDraft = null,
  editorialBase = null,
  extraBlocks = null,
  extraBlocksBase = null,
  publicationRecords = [],
  documentFilter = "all";
let pageSelectionRequest = 0, pageLoading = false, pageLoadFailed = false;
let pageEditRevision = 0, pageSaveBusy = false, documentEditRevision = 0, documentSaveBusy = false;
let previewDocument = null, documentPreviewRequest = 0, documentReplaceBusy = false;
const defaultCaseSectionOrder = ["overview", "media", "history", "sources"];
const dateTime = window.HuiwenDateTime;
const pageCollator = new Intl.Collator("zh-Hant-TW", { numeric: true, sensitivity: "base" });
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
const retryablePublicationMessage = "網站剛有其他更新；本輪不建立發布請求，下一輪會以最新版本重新檢查。";
const labels = {
  name: "活動名稱",
  start: "開始時間（台灣時間）",
  end: "結束時間（台灣時間）",
  content: "活動說明（選填）",
  registration: "參與／報名方式（選填）",
  sourceUrl: "公開來源網址",
  verifiedAt: "來源核對日",
  status: "活動狀態",
  changeNote: "異動原因（改期／取消必填）",
  updatedAt: "來源更新日（排定時選填）",
  reviewDueAt: "下次複查日（選填）",
  month: "月表月份",
  observedAt: "核對日",
  sourceTitle: "來源圖卡標題（選填）",
  nextReviewAt: "下次核對日（選填）",
  sessions: "諮詢時段",
  closedDates: "無／停辦日期",
  unconfirmedDates: "待填日期",
  weekdayTimes: "每週諮詢時間",
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
  "closedDates",
  "unconfirmedDates",
  "weekdayTimes",
];
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function makeField(label, options = {}) {
  const field = el(options.group ? "div" : "label", undefined, "field"), caption = el(options.group ? "div" : "span", undefined, "field-label");
  caption.append(document.createTextNode(label));
  if (options.required) {
    const marker = el("span", "＊", "required-marker");
    marker.setAttribute("aria-hidden", "true");
    caption.append(marker);
    field.dataset.required = "true";
  }
  field.append(caption);
  if (options.path) {
    field.dataset.validationPath = options.path;
    const error = el("span", undefined, "field-error");
    error.id = `field-error-${options.path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    error.hidden = true;
    error.setAttribute("role", "alert");
    field.append(error);
  }
  return field;
}
function connectField(field, control, required = false) {
  const caption = field.querySelector(".field-label");
  if (caption) control.setAttribute("aria-label", caption.textContent.replace(/＊$/, "").trim());
  if (required) {
    control.required = true;
    control.setAttribute("aria-required", "true");
  }
  const error = field.querySelector(".field-error");
  if (error) control.setAttribute("aria-describedby", error.id);
  field.append(control);
  if (error) field.append(error);
  return field;
}
function setFieldRequired(field, control, required) {
  if (!field || !control) return;
  const caption = field.querySelector(".field-label");
  let marker = caption?.querySelector(".required-marker");
  if (required && caption && !marker) {
    marker = el("span", "＊", "required-marker");
    marker.setAttribute("aria-hidden", "true");
    caption.append(marker);
  } else if (!required && marker) marker.remove();
  control.required = required;
  if (required) control.setAttribute("aria-required", "true");
  else control.removeAttribute("aria-required");
}
function syncOptionalRowRequired(row) {
  if (!row || row.dataset.optionalEmptyRow !== "true") return;
  const active = Boolean(row.dataset.forceValidate) ||
    [...row.querySelectorAll("input:not([type=checkbox]):not([data-case-action]),textarea")]
      .some(control => String(control.value || "").trim()) ||
    [...row.querySelectorAll('input[type="checkbox"]')].some(control => control.checked);
  for (const field of row.querySelectorAll('[data-required="true"]')) {
    const control = field.querySelector(".date-period-controls input") || field.querySelector("input,textarea,select");
    setFieldRequired(field, control, active);
  }
}
function clearFieldError(control) {
  const field = control.closest("[data-validation-path]");
  if (!field) return;
  const error = field.querySelector(".field-error");
  const previousMessage = error?.textContent;
  field.classList.remove("has-error");
  for (const invalid of field.querySelectorAll("[aria-invalid=true]")) invalid.removeAttribute("aria-invalid");
  control.removeAttribute("aria-invalid");
  if (error) { error.textContent = ""; error.hidden = true; }
  if (previousMessage && $("#notice")?.textContent === previousMessage) $("#notice").textContent = "";
}
function markFieldError(field, control, message) {
  if (!field || !control) return false;
  const error = field.querySelector(".field-error");
  if (!error) return false;
  error.textContent = message;
  error.hidden = false;
  field.classList.add("has-error");
  control.setAttribute("aria-invalid", "true");
  field.scrollIntoView({ behavior: "smooth", block: "center" });
  control.focus({ preventScroll: true });
  return true;
}
function showFieldError(path, message) {
  if (typeof path !== "string") return;
  const field = [...document.querySelectorAll("[data-validation-path]")].find(item => item.dataset.validationPath === path);
  if (!field) return;
  const details = field.closest("details:not([open])");
  if (details) details.open = true;
  if (!field.matches("label")) field.tabIndex = -1;
  const body = field.closest(".case-group-body");
  if (body?.hidden) {
    body.hidden = false;
    const toggle = body.parentElement?.querySelector(".case-section-head .quiet");
    if (toggle) { toggle.textContent = "收合"; toggle.setAttribute("aria-expanded", "true"); }
  }
  const panel = field.closest('[role="tabpanel"]');
  if (panel?.hidden && typeof showEditorTab === "function") showEditorTab(panel.id.replace("panel-", ""));
  markFieldError(field, field.querySelector("input,textarea,select,button") || field, message);
}
function validateRequiredFields(root, includeHidden = false) {
  if (!root) return true;
  for (const control of root.querySelectorAll("input[required],textarea[required],select[required]")) {
    if (control.disabled || !includeHidden && control.closest("[hidden]")) continue;
    const optionalRow = control.closest('[data-optional-empty-row="true"]');
    if (optionalRow) {
      const hasText = [...optionalRow.querySelectorAll("input:not([type=checkbox]):not([data-case-action]),textarea")]
        .some(input => String(input.value || "").trim());
      const checked = [...optionalRow.querySelectorAll('input[type="checkbox"]')].some(input => input.checked);
      if (!hasText && !checked && !optionalRow.dataset.forceValidate) continue;
    }
    const empty = control.type === "checkbox" ? !control.checked : !String(control.value || "").trim();
    const invalid = empty || !control.checkValidity();
    if (!invalid) continue;
    const message = empty ? "此欄位為必填。" : control.type === "url" ? "請輸入有效的公開網址。" : "欄位格式不正確。";
    const field = control.closest("[data-validation-path]");
    if (field) {
      const panel = field.closest('[id^="panel-"]');
      if (panel?.hidden && typeof showEditorTab === "function") showEditorTab(panel.id.slice(6));
      const body = field.closest(".case-group-body");
      if (body?.hidden) {
        body.hidden = false;
        const toggle = body.parentElement?.querySelector(".case-section-head .quiet");
        if (toggle) { toggle.textContent = "收合"; toggle.setAttribute("aria-expanded", "true"); }
      }
      markFieldError(field, control, message);
    }
    else { control.reportValidity(); }
    return false;
  }
  return true;
}
function notice(text, kind = "info") {
  const target = $("#notice");
  target.textContent = text;
  target.classList.toggle("notice-error", kind === "error" && Boolean(text));
  target.setAttribute("role", kind === "error" ? "alert" : "status");
  target.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
}
async function api(path, method = "GET", body) {
  let r;
  try { r = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { "X-CSRF-Token": session.csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }); } catch {
    throw new Error("連線未完成。表單內容仍保留，請確認網路後重試；重新載入前請先保留未儲存內容。");
  }
  if (!r.ok) {
    let body = {};
    try { body = await r.json(); } catch {}
    const error = new Error(body.error || "連線或登入驗證未完成。表單內容仍保留；重新載入前請先保留未儲存內容。");
    error.field = body.field;
    throw error;
  }
  try { return await r.json(); } catch {
    throw new Error("伺服器未回傳可讀取的資料。表單內容仍保留；請稍後重試，重新載入前先保留未儲存內容。");
  }
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    notice(e.message, "error");
    showFieldError(e.field, e.message);
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
    if (documentFilter !== "all" && d.domain !== documentFilter) continue;
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
  if (documents.length && !list.children.length) list.append(el("p", "這個類別目前沒有內容，請選擇其他類別或新增活動。", "hint"));
  await publications();
}
function renderPages() {
  const list = $("#page-tree");
  const query = $("#page-filter").value.trim().toLocaleLowerCase();
  const openGroups = new Map([...list.querySelectorAll("details.tree-group")].map(group => [group.dataset.group, group.open]));
  list.replaceChildren();
  const workFilter = $("#page-work-filter").value;
  const matching = pages.filter((p) =>
    [p.title, p.path, p.source_path].some((s) => String(s || "").toLocaleLowerCase().includes(query)) &&
    (workFilter === "all" || workFilter === "draft" && Boolean(p.draft_version) ||
      workFilter === "pending" && Boolean(p.pending_operation) ||
      workFilter === "read-only" && !isPageEditable(p) ||
      workFilter === "recent" && Boolean(p.draft_updated_at)),
  );
  $("#page-count").textContent = `${pages.length} 頁`;
  $("#page-list-status").textContent = `顯示 ${matching.length} / ${pages.length} 個頁面`;
  if (!matching.length) {
    list.append(el("p", "沒有符合的頁面。", "tree-empty"));
    return;
  }
  const groups = new Map();
  const groupFor = (p) => {
    const path = p.path;
    if (path === "index.html") return "首頁";
    if (path.startsWith("page-achievement-") || path.startsWith("achievement-") || ["achievements.html", "explore.html", "vision.html"].includes(path)) return "建設與政策";
    if (path.startsWith("page-service-")) return "民眾服務";
    if (/^page-(?:news|press|council)-/.test(path)) return "新聞、媒體與議會";
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
  const pageSort = $("#page-sort").value;
  const pathCompare = (a, b) => pageCollator.compare(a.path, b.path);
  const compare = (a, b) => {
    if (pageSort === "title") return pageCollator.compare(a.title || a.path, b.title || b.path) || pathCompare(a, b);
    if (pageSort === "draft") return Number(Boolean(b.draft_version)) - Number(Boolean(a.draft_version)) || pathCompare(a, b);
    if (pageSort === "recent") return (Date.parse(b.draft_updated_at || "") || 0) - (Date.parse(a.draft_updated_at || "") || 0) || pathCompare(a, b);
    return pathCompare(a, b);
  };
  for (const name of order.filter((key) => groups.has(key))) {
    const details = el("details", undefined, "tree-group");
    details.dataset.group = name;
    details.open = Boolean(query) || (openGroups.get(name) ?? true);
    const summary = el("summary");
    summary.append(el("span", name), el("small", `${groups.get(name).length} 頁`));
    const children = el("div", undefined, "tree-children");
    for (const p of groups.get(name).sort(compare)) {
      const button = el("button", undefined, "tree-page");
      button.type = "button";
      button.dataset.status = p.publication_status || "published";
      button.setAttribute("aria-current", String(selectedPage?.path === p.path ? "page" : "false"));
      const title = el("span", p.title || p.path);
      const sub = p.path === "index.html" ? "/" : `/${p.path}`;
      const states = [p.publication_status === "deleted" ? "垃圾桶" : p.publication_status === "unpublished" ? "已下架" : p.publication_status === "draft" ? "新頁草稿" : "正式"];
      if (p.draft_version) states.push(`草稿 v${p.draft_version}`);
      if (p.pending_operation) states.push(statusNames[p.pending_status] || "等待處理");
      if (!isPageEditable(p)) states.push("僅檢視");
      button.append(title, el("small", sub), el("small", states.join(" · "), "tree-states"));
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
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}
function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}
function pagePublishConflicts() {
  const content = [], seo = [];
  const caseChanged = Boolean(caseDraft && !sameValue(caseDraft, caseBase));
  const homeChanged = Boolean(homeDraft && !sameValue(homeDraft, homeBase));
  const seoChanged = Boolean(seoDraft && !sameValue(seoDraft, seoBase));
  const blocksChanged = Boolean(extraBlocks && !sameValue(extraBlocks, extraBlocksBase));
  const add = (message, includeSeo = false) => {
    content.push(message);
    if (includeSeo) seo.push(message);
  };
  if (caseChanged && seoChanged) add("政績內容與 SEO 必須分次發布", true);
  if (caseChanged && blocksChanged) add("政績內容與延伸區塊必須分次發布");
  if (homeChanged && seoChanged) add("首頁專題與 SEO 必須分次發布", true);
  if (homeChanged && blocksChanged) add("首頁專題與延伸區塊必須分次發布");
  if (caseChanged && pageFields.size) add("政績結構化內容與版面文字必須分次發布");
  if (homeChanged && pageFields.size) add("首頁專題與版面文字必須分次發布");
  return { content: [...new Set(content)], seo: [...new Set(seo)] };
}
function renderPagePublishConflicts(conflicts = pagePublishConflicts()) {
  const instructions = "請保留草稿，先單獨發布其中一類；完成後載入最新官網版本，再發布另一類。";
  const contentError = $("#content-publish-conflict"), seoError = $("#seo-publish-conflict");
  contentError.textContent = conflicts.content.length ? `發布前檢查：${conflicts.content.join("；")}。${instructions}` : "";
  seoError.textContent = conflicts.seo.length ? `發布前檢查：${conflicts.seo.join("；")}。${instructions}` : "";
  contentError.hidden = !conflicts.content.length;
  seoError.hidden = !conflicts.seo.length;
  return conflicts;
}
function pageStatusLabel(page) {
  const status = page?.publication_status || "published";
  return status === "draft" ? "新頁面草稿" : status === "deleted" ? "在垃圾桶，可還原" : status === "unpublished" ? "已下架，可還原" : "正式頁面";
}
function pageControls() {
  const editable = isPageEditable(selectedPage) && !pageLoading && !pageLoadFailed;
  const live = editable && (selectedPage?.publication_status || "published") === "published";
  const newEditorial = editable && selectedPage?.source_kind === "editorial-draft";
  let newEditorialReady = false;
  if (newEditorial && pageDraft?.payload) {
    try {
      const data = JSON.parse(pageDraft.payload).editorial;
      newEditorialReady = Boolean(data?.summary && data?.seo?.description && data?.blocks?.some(block => block.text || block.title || block.url || block.address));
    } catch { newEditorialReady = false; }
  }
  const removed = editable && ["deleted", "unpublished"].includes(selectedPage?.publication_status);
  const pendingPage = pages.find((p) => p.path === selectedPage?.path && p.pending_operation);
  const pending = Boolean(pendingPage);
  const pendingStatus = pendingPage?.pending_status;
  const pendingAge = pendingPage?.pending_since ? Date.now() - Date.parse(pendingPage.pending_since) : 0;
  const pendingLabel = pendingStatus ? statusNames[pendingStatus] || "等待處理" : "等待處理";
  const pendingSuffix = pendingStatus === "queued" && pendingAge > 15 * 60 * 1000 ? " · 執行器尚未領取" : "";
  const unchanged = publicationRecords.some(p => p.path === selectedPage?.path && p.version === pageDraft?.version && p.status === "no_change");
  const conflicts = renderPagePublishConflicts();
  const hasPublishConflict = conflicts.content.length > 0 || conflicts.seo.length > 0;
  const publishable = editable && (live || newEditorialReady) && Boolean(pageDraft?.version) && !pageDirty && !pending && !unchanged && !hasPublishConflict;
  $("#page-status").textContent = selectedPage ? [pageStatusLabel(selectedPage),
    pageDirty ? "有未儲存變更" : pageDraft?.version ? `草稿 v${pageDraft.version} 已儲存` : "無未儲存變更",
    pending ? `${pendingLabel}${pendingSuffix}` : hasPublishConflict ? "來源需分次發布" : unchanged ? "草稿與正式版相同" : publishable ? "草稿可發布" : ""].filter(Boolean).join(" · ") : "尚未選取";
  $("#page-save").disabled = !editable || pageSaveBusy || (!pageDirty && Boolean(pageDraft));
  $("#page-save").textContent = pageSaveBusy ? "儲存中…" : "儲存草稿";
  $("#page-publish").disabled = !publishable || pageSaveBusy;
  $("#page-unpublish").disabled = !editable || !live || !pageDraft?.version || pageDirty || pending || pageSaveBusy;
  $("#page-delete").disabled = !editable || !live || !pageDraft?.version || pageDirty || pending || pageSaveBusy;
  $("#page-restore").hidden = !removed;
  $("#page-restore").disabled = !removed || !pageDraft?.version || pageDirty || pending || pageSaveBusy;
  $("#page-open-live").href = `https://www.huiwen.tw${pageUrl(selectedPage?.path || "index.html")}`;
  $("#page-open-live").hidden = !selectedPage || newEditorial;
}
function setPageStatus(message) {
  $("#page-draft-status").textContent = message;
}
function effectiveSeoValues(seo, fallback = seoBase, page = editorialDraft) {
  const keys = ["title", "description", "image", "imageAlt"];
  const defaults = page ? {
    title: `${page.title || "新頁面"}｜陳慧文`,
    description: page.summary || `${page.title || "新頁面"}｜陳慧文，高雄市議員・鳳山區公開資訊。`,
    image: "https://www.huiwen.tw/assets/site-share-20260909.png",
    imageAlt: "陳慧文・高雄市議員・鳳山區",
  } : {};
  return Object.fromEntries(keys.map(key => [key,
    typeof seo?.[key] === "string" && seo[key].trim() ? seo[key].trim() : fallback?.[key] || defaults[key] || "" ]));
}
function applyDraftToFrame() {
  if (!pageReady || !selectedPage || !pageNonce) return;
  const fields = [...pageFields.entries()].map(([id, value]) => ({ id, ...value }));
  const frame = $("#page-frame");
  frame.contentWindow?.postMessage({ type: "huiwen-cms-apply", nonce: pageNonce, fields }, "*");
  if (caseDraft) frame.contentWindow?.postMessage({ type: "huiwen-cms-case-preview", nonce: pageNonce, case: caseDraft }, "*");
  if (homeDraft) frame.contentWindow?.postMessage({ type: "huiwen-cms-home-preview", nonce: pageNonce, home: homeDraft, cases: [...homeCases.values()] }, "*");
  if (seoDraft) frame.contentWindow?.postMessage({ type: "huiwen-cms-seo-preview", nonce: pageNonce, seo: effectiveSeoValues(seoDraft, seoBase, null) }, "*");
  if (editorialDraft) frame.contentWindow?.postMessage({type:"huiwen-cms-editorial-preview",nonce:pageNonce,page:editorialDraft},"*");
  if (editorialDraft) frame.contentWindow?.postMessage({type:"huiwen-cms-seo-preview",nonce:pageNonce,seo:effectiveSeoValues(editorialDraft.seo, null, editorialDraft)},"*");
  if (extraBlocks) frame.contentWindow?.postMessage({type:"huiwen-cms-extra-preview",nonce:pageNonce,blocks:extraBlocks},"*");
}
function renderSeoEditor() {
  const panel = $("#seo-editor"), target = $("#seo-editor-fields");
  panel.hidden = !seoDraft || !isPageEditable(selectedPage);
  target.replaceChildren();
  if (panel.hidden) return;
  for (const [key, label, multiline] of [
    ["title", "搜尋與分享標題", false], ["description", "搜尋與分享說明", true],
    ["image", "分享圖片網址（本站 assets）", false], ["imageAlt", "分享圖片替代文字", false],
  ]) {
    const field = makeField(`${label}（選填）`, { path: `seo.${key}` });
    field.classList.add("wide");
    const input = document.createElement(multiline ? "textarea" : "input");
    input.name = `seo-${key}`; input.value = seoDraft[key] || "";
    if (key === "image") input.type = "url";
    if (multiline) input.rows = 3;
    const counter = ["title", "description"].includes(key) ? el("small", `${input.value.length} 字`, "character-count") : null;
    input.addEventListener("input", () => {
      seoDraft[key] = input.value;
      if (counter) counter.textContent = `${input.value.length} 字`;
      pageDirty = true;
      pageEditRevision++;
      setPageStatus("SEO 有變更 · 儲存並發布後才會更新正式頁面");
      pageControls();
      $("#page-frame").contentWindow?.postMessage({ type: "huiwen-cms-seo-preview", nonce: pageNonce, seo: effectiveSeoValues(seoDraft, seoBase, null) }, "*");
    });
    input.addEventListener("input", () => clearFieldError(input));
    connectField(field, input);
    field.append(el("small", "留白會沿用目前正式頁面的設定。"));
    if (counter) field.append(counter);
    target.append(field);
  }
  const preview = el("div", undefined, "og-preview");
  preview.append(el("small", "OPEN GRAPH 預覽"), el("strong", seoDraft.title || "尚未設定標題"), el("p", seoDraft.description || "尚未設定說明"));
  target.append(preview);
  for (const input of target.querySelectorAll("input,textarea")) input.addEventListener("input", () => {
    preview.querySelector("strong").textContent = seoDraft.title || "尚未設定標題";
    preview.querySelector("p").textContent = seoDraft.description || "尚未設定說明";
  });
}
const editorialBlankBlock = (type = "paragraph") => ({ type, title:"", text:"", date:"", url:"", alt:"", credit:"", address:"", publicAccessConfirmed:false });
function editorialChanged() {
  pageDirty = true;
  pageEditRevision++;
  setPageStatus("專頁內容、區塊或 SEO 有變更 · 儲存並發布後才會更新正式頁面");
  pageControls();
  if (pageReady) {
    $("#page-frame").contentWindow?.postMessage({type:"huiwen-cms-editorial-preview",nonce:pageNonce,page:editorialDraft},"*");
    $("#page-frame").contentWindow?.postMessage({type:"huiwen-cms-seo-preview",nonce:pageNonce,seo:effectiveSeoValues(editorialDraft.seo,null,editorialDraft)},"*");
  }
}
function extraChanged() {
  pageDirty = true;
  pageEditRevision++;
  setPageStatus("頁面延伸區塊有變更 · 儲存並發布後才會更新正式頁面");
  pageControls();
  if (pageReady) $("#page-frame").contentWindow?.postMessage({type:"huiwen-cms-extra-preview",nonce:pageNonce,blocks:extraBlocks},"*");
}
function installCompactEntry(field, picker, label, kind, commit, parent = field) {
  const details = el("details", undefined, "compact-date-entry"), summary = el("summary", "快速輸入"), text = document.createElement("input");
  const type = {day:"date",month:"month",dateTime:"datetime-local",time:"time"}[kind];
  text.type = "text";
  text.placeholder = ({day:"20260927",month:"202609",dateTime:"202609271930",time:"1930"})[kind] || "簡寫日期／時間";
  text.setAttribute("aria-label", `${label}快速輸入`);
  const error = field.querySelector(".field-error");
  if (error) text.setAttribute("aria-describedby", error.id);
  details.append(summary, text);
  if (parent === field && error) parent.insertBefore(details, error);
  else parent.append(details);
  text.addEventListener("input", () => clearFieldError(text));
  text.addEventListener("blur", () => {
    const raw = text.value.trim();
    if (!raw) {
      picker.value = "";
      clearFieldError(text);
      commit("");
      return;
    }
    const source = kind === "dateTime" ? raw.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "") : raw;
    const normalized = dateTime[kind](source), probe = document.createElement("input");
    probe.type = type;
    probe.value = normalized;
    if (!normalized || probe.value !== normalized) {
      field.classList.add("has-error");
      const message = `格式不正確，請使用日曆／時間選擇器或輸入 ${text.placeholder} 格式。`;
      if (error) { error.textContent = message; error.hidden = false; }
      text.setAttribute("aria-invalid", "true");
      return;
    }
    picker.value = normalized;
    text.value = normalized;
    clearFieldError(text);
    commit(normalized);
  });
}
function editorialInput(label, value, update, options = {}) {
  const field = makeField(label, { required: options.required, path: options.path, group: Boolean(options.dateKind && options.dateKind !== "period") });
  field.classList.add("wide");
  const input = document.createElement(options.multiline ? "textarea" : "input");
  if (options.multiline) input.rows = options.rows || 3;
  else input.type = options.type || ({day:"date",month:"month",dateTime:"datetime-local"}[options.dateKind] || "text");
  const localDateTime = String(value || "").replace(/(?:Z|[+-]\d{2}:\d{2})$/, "").slice(0, 16);
  input.value = options.dateKind === "dateTime" ? dateTime.dateTime(localDateTime) : options.dateKind && options.dateKind !== "period" ? dateTime[options.dateKind](value) : value || "";
  input.placeholder = options.placeholder || "";
  const signal = options.onChange || editorialChanged;
  const changed = () => {
    clearFieldError(input);
    const normalized = options.dateKind ? dateTime[options.dateKind](input.value) : input.value;
    update(options.dateKind === "dateTime" && normalized ? `${normalized}+08:00` : normalized);
    syncOptionalRowRequired(input.closest('[data-optional-empty-row="true"]'));
    signal();
  };
  input.addEventListener("input", changed);
  input.addEventListener("change", changed);
  connectField(field, input, options.required);
  if (options.dateKind && options.dateKind !== "period") installCompactEntry(field, input, label, options.dateKind, raw => {
    update(options.dateKind === "dateTime" && raw ? `${raw}+08:00` : raw);
    syncOptionalRowRequired(field.closest('[data-optional-empty-row="true"]'));
    signal();
  });
  return field;
}
function renderEditorialEditor() {
  const panel = $("#editorial-editor"), target = $("#editorial-editor-fields");
  const seoTarget = $("#editorial-seo-fields");
  panel.hidden = !editorialDraft;
  target.replaceChildren();
  seoTarget.replaceChildren();
  seoTarget.hidden = !editorialDraft;
  if (!editorialDraft) return;
  const p = editorialDraft;
  target.append(
    editorialInput("頁面標題", p.title, v => p.title = v, {required:true,path:"editorial.title"}),
    editorialInput("導讀摘要（選填）", p.summary, v => p.summary = v, {multiline:true,path:"editorial.summary"}),
    editorialInput("內容整理日期", p.updated, v => p.updated = v, {dateKind:"day",placeholder:"20260927 或 2026-09-27",required:true,path:"editorial.updated"}),
    editorialInput("事件開始（選填，台灣時間）", p.eventStart, v => p.eventStart = v, {dateKind:"dateTime",placeholder:"202609271930 或 2026-09-27T19:30+08:00"}),
    editorialInput("事件結束（選填，台灣時間）", p.eventEnd, v => p.eventEnd = v, {dateKind:"dateTime"}),
    el("h4", "頁面區塊與順序")
  );
  seoTarget.append(
    el("h3", "搜尋與社群分享 SEO"),
    editorialInput("SEO 標題（選填）", p.seo.title, v => p.seo.title = v, {path:"editorial.seo.title"}),
    editorialInput("SEO 描述（選填）", p.seo.description, v => p.seo.description = v, {multiline:true,path:"editorial.seo.description"}),
    editorialInput("分享圖片（選填；留白使用預設圖）", p.seo.image, v => p.seo.image = v, {type:"url",path:"editorial.seo.image"}),
    editorialInput("分享圖片替代文字（選填）", p.seo.imageAlt, v => p.seo.imageAlt = v, {path:"editorial.seo.imageAlt"}),
  );
  renderBlockEditor(target,p.blocks,editorialChanged,"editorial.blocks");
}
function renderExtraBlocksEditor() {
  const panel = $("#extra-blocks-editor"), target = $("#extra-blocks-fields");
  panel.hidden = !extraBlocks || !isPageEditable(selectedPage);
  target.replaceChildren();
  if (!panel.hidden) renderBlockEditor(target,extraBlocks,extraChanged,"blocks");
}
function renderBlockEditor(target, blocks, changed, pathPrefix) {
  const render = () => extraBlocks === blocks ? renderExtraBlocksEditor() : renderEditorialEditor();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], row = el("div", undefined, "case-editor-row");
    row.dataset.optionalEmptyRow = "true";
    row.dataset.editorialIndex = String(index);
    const labels = {heading:"段落標題",paragraph:"文字段落",timeline:"時間軸",source:"資料來源",photo:"照片",video:"影片",map:"地點與地圖"};
    row.append(el("strong", `${index+1}. ${labels[block.type] || block.type}`));
    const controls = el("div",undefined,"case-editor-actions");
    for (const [label, offset] of [["上移",-1],["下移",1]]) {
      const button = el("button",label,"secondary"); button.type="button";
      button.disabled = index + offset < 0 || index + offset >= blocks.length;
      button.onclick = () => { const [item] = blocks.splice(index,1); blocks.splice(index+offset,0,item); render(); changed(); };
      controls.append(button);
    }
    const remove = el("button","移除區塊","secondary"); remove.type="button";
    remove.onclick = () => { blocks.splice(index,1); render(); changed(); };
    controls.append(remove); row.append(controls);
    const path = `${pathPrefix}.${index}`;
    const input = (label,value,update,options={}) => editorialInput(label,value,update,{...options,onChange:changed});
    if (["heading","timeline","source"].includes(block.type)) row.append(input("標題",block.title,v=>block.title=v,{required:true,path:`${path}.title`}));
    if (block.type === "map") row.append(input("標題（選填）",block.title,v=>block.title=v,{path:`${path}.title`}));
    if (["paragraph","timeline"].includes(block.type)) row.append(input(block.type === "paragraph" ? "段落內容" : "說明／圖說（選填）",block.text,v=>block.text=v,{multiline:true,required:block.type === "paragraph",path:`${path}.text`}));
    if (["photo","video"].includes(block.type)) row.append(input("說明／圖說（選填）",block.text,v=>block.text=v,{multiline:true,path:`${path}.text`}));
    if (["timeline","source"].includes(block.type)) row.append(input("日期",block.date,v=>block.date=v,{dateKind:"day",placeholder:"20260927",required:block.type === "timeline",path:`${path}.date`}));
    if (["source","photo","video"].includes(block.type)) row.append(input("公開網址",block.url,v=>block.url=v,{type:"url",required:true,path:`${path}.url`}));
    if (["photo","video"].includes(block.type)) {
      row.append(input("替代文字",block.alt,v=>block.alt=v,{required:true,path:`${path}.alt`}), input("來源署名",block.credit,v=>block.credit=v,{required:true,path:`${path}.credit`}));
      const confirmation=makeField("我已確認此網址不需登入即可公開瀏覽",{required:true,path:`${path}.publicAccessConfirmed`}), check=document.createElement("input");
      check.type="checkbox"; check.checked=Boolean(block.publicAccessConfirmed);
      check.onchange=()=>{clearFieldError(check);block.publicAccessConfirmed=check.checked;syncOptionalRowRequired(row);changed();};
      confirmation.insertBefore(check,confirmation.firstChild); check.required=true; check.setAttribute("aria-required","true");
      confirmation.append(confirmation.querySelector(".field-error")); row.append(confirmation);
    }
    if (block.type === "map") {
      row.append(input("完整地址（以高雄市起頭）",block.address,v=>block.address=v,{placeholder:"高雄市鳳山區錦田路231號",required:true,path:`${path}.address`}));
      if (block.address.startsWith("高雄市")) {
        const link = el("a","在地圖 App 核對位置 ↗","text-link");
        link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(block.address)}`;
        link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link);
      }
    }
    target.append(row);
    syncOptionalRowRequired(row);
  }
  const addRow = el("div",undefined,"case-editor-row"), select = document.createElement("select");
  for (const [value,label] of [["heading","標題"],["paragraph","段落"],["timeline","時間軸"],["source","資料來源"],["photo","照片"],["video","影片"],["map","地圖"]]) {
    const option = el("option",label); option.value=value; select.append(option);
  }
  select.setAttribute("aria-label","新增區塊類型");
  const add = el("button","新增區塊","secondary"); add.type="button"; add.disabled = blocks.length >= 80;
  add.onclick = () => { blocks.push(editorialBlankBlock(select.value)); render(); changed(); };
  addRow.append(select,add); target.append(addRow);
}
const isCasePage = (page) => /^achievement-[a-z0-9-]+\.html$/.test(page?.path || "");
function renderHomeEditor() {
  const panel = $("#home-editor"), target = $("#home-editor-fields");
  panel.hidden = !homeDraft;
  target.replaceChildren();
  if (!homeDraft) return;
  const order = [homeDraft.featured, ...homeDraft.reading];
  for (let index = 0; index < order.length; index++) {
    const record = homeCases.get(order[index]);
    const row = el("div", undefined, "case-editor-row");
    row.dataset.homeIndex = String(index);
    row.append(el("strong", index === 0 ? "主打專題（左側）" : `右側 0${index}`),
      el("p", record?.title || order[index]));
    const actions = el("div", undefined, "case-editor-actions");
    for (const [label, offset] of [["上移", -1], ["下移", 1]]) {
      const button = el("button", label, "secondary");
      button.type = "button"; button.disabled = index + offset < 0 || index + offset >= order.length;
      button.dataset.homeAction = offset < 0 ? "up" : "down";
      button.onclick = () => moveHomeStory(index, index + offset);
      actions.append(button);
    }
    const position = el("label", "移至位置 ", "field");
    const select = document.createElement("select"); select.dataset.homeAction = "position";
    order.forEach((_, n) => select.add(new Option(n === 0 ? "主打專題" : `右側 ${String(n).padStart(2, "0")}`, String(n))));
    select.value = String(index);
    select.onchange = () => moveHomeStory(index, Number(select.value));
    position.append(select); actions.append(position); row.append(actions); target.append(row);
    const summary = makeField("首頁卡片摘要（選填；留白使用政績摘要）",{path:`home.summaries.${order[index]}`});
    const textarea = document.createElement("textarea");
    textarea.value = homeDraft.summaries[order[index]] || "";
    textarea.maxLength = 500;
    textarea.dataset.homeSummary = order[index];
    textarea.oninput = () => { clearFieldError(textarea); homeDraft.summaries[order[index]] = textarea.value; homeChanged(); };
    connectField(summary,textarea); row.append(summary);
    const remove = el("button", "從首頁移除", "secondary");
    remove.type = "button"; remove.dataset.homeAction = "remove";
    remove.disabled = order.length <= 2;
    remove.onclick = () => {
      const updated = order.filter((_, position) => position !== index);
      delete homeDraft.summaries[order[index]];
      homeDraft.featured = updated[0]; homeDraft.reading = updated.slice(1);
      renderHomeEditor(); homeChanged();
    };
    row.append(remove);
  }
  const available = [...homeCases.values()].filter(record => !order.includes(record.id))
    .sort((a, b) => pageCollator.compare(a.title || a.id, b.title || b.id));
  const addRow = el("div", undefined, "case-editor-row");
  const label = el("label", "新增公開專題", "field");
  const chooser = document.createElement("select"); chooser.id = "home-add-select";
  for (const record of available) chooser.add(new Option(`${record.title} · ${record.id}`, record.id));
  label.append(chooser); addRow.append(label);
  const add = el("button", "加入首頁", "secondary");
  add.type = "button"; add.id = "home-add";
  add.disabled = !available.length || order.length >= 13;
  add.onclick = () => {
    const record = homeCases.get(chooser.value);
    if (!record || [homeDraft.featured, ...homeDraft.reading].includes(record.id)) return;
    homeDraft.reading.push(record.id);
    homeDraft.summaries[record.id] = record.summary || record.title;
    renderHomeEditor(); homeChanged();
  };
  addRow.append(add); target.append(addRow);
}
function homeChanged() {
  pageDirty = true;
  pageEditRevision++;
  setPageStatus("首頁專題選片、摘要或順序有變更 · 儲存並發布後才會更新正式首頁");
  pageControls();
  if (pageReady) $("#page-frame").contentWindow?.postMessage({
    type: "huiwen-cms-home-preview", nonce: pageNonce, home: homeDraft, cases: [...homeCases.values()],
  }, "*");
}
function moveHomeStory(from, to) {
  if (!homeDraft || from === to || to < 0 || to >= homeDraft.reading.length + 1) return;
  const order = [homeDraft.featured, ...homeDraft.reading];
  order.splice(to, 0, ...order.splice(from, 1));
  homeDraft.featured = order[0];
  homeDraft.reading = order.slice(1);
  renderHomeEditor();
  homeChanged();
}
function periodKind(value) {
  if (/^20\d\d-\d\d-\d\d$/.test(String(value || ""))) return "day";
  if (/^20\d\d-\d\d$/.test(String(value || ""))) return "month";
  if (/^20\d\d$/.test(String(value || ""))) return "year";
  return "custom";
}
function periodValue(kind, value) {
  if (kind === "day") return dateTime.day(value);
  if (kind === "month") return dateTime.month(value);
  if (kind === "year") return String(value || "").trim();
  return dateTime.period(value);
}
function periodControlValue(kind, value) {
  const raw = String(value || "").trim();
  if (kind === "day") return /^20\d\d-\d\d$/.test(raw) ? `${raw}-01` : /^20\d\d$/.test(raw) ? `${raw}-01-01` : raw;
  if (kind === "month") return /^20\d\d-\d\d-\d\d$/.test(raw) ? raw.slice(0, 7) : /^20\d\d$/.test(raw) ? `${raw}-01` : raw;
  if (kind === "year") return raw.match(/^20\d\d/)?.[0] || "";
  return raw;
}
function casePeriodInput(label, value, update, options = {}) {
  const field = makeField(label, { required: options.required, path: options.path, group: true });
  const controls = el("div", undefined, "date-period-controls"), select = document.createElement("select");
  const error = field.querySelector(".field-error");
  error?.remove();
  select.setAttribute("aria-label", `${label}格式`);
  for (const [kind, text] of [["day", "選日期"], ["month", "選月份"], ["year", "選年份"], ["custom", "自訂期間"]]) {
    const option = el("option", text); option.value = kind; select.append(option);
  }
  let kind = periodKind(value), input;
  select.value = kind;
  const makeControl = (nextKind, currentValue) => {
    const next = document.createElement("input");
    next.type = nextKind === "day" ? "date" : nextKind === "month" ? "month" : nextKind === "year" ? "number" : "text";
    if (nextKind === "year") { next.min = "2000"; next.max = "2099"; next.step = "1"; }
    next.value = periodControlValue(nextKind, currentValue);
    next.setAttribute("aria-label", `${label}：${select.selectedOptions[0]?.textContent || "日期"}`);
    if (options.required) { next.required = true; next.setAttribute("aria-required", "true"); }
    const error = field.querySelector(".field-error");
    if (error) next.setAttribute("aria-describedby", error.id);
    next.addEventListener("input", changed);
    next.addEventListener("change", changed);
    return next;
  };
  input = makeControl(kind, value);
  function changed() {
    clearFieldError(input);
    update(periodValue(kind, input.value));
    syncOptionalRowRequired(field.closest('[data-optional-empty-row="true"]'));
    caseChanged();
  }
  select.addEventListener("change", () => {
    const previous = input.value;
    const normalizedPrevious = periodValue(kind, previous);
    kind = select.value;
    const nextValue = kind === "custom" ? normalizedPrevious : periodControlValue(kind, normalizedPrevious);
    const next = makeControl(kind, nextValue);
    input.replaceWith(next);
    input = next;
    clearFieldError(input);
    update(periodValue(kind, input.value));
    syncOptionalRowRequired(field.closest('[data-optional-empty-row="true"]'));
    caseChanged();
  });
  controls.append(select, input);
  field.append(controls);
  if (error) field.append(error);
  return field;
}
function caseInput(label, value, update, options = {}) {
  if (options.dateKind === "period") return casePeriodInput(label, value, update, options);
  const field = makeField(label,{required:options.required,path:options.path,group:Boolean(options.dateKind)});
  const input = document.createElement(options.multiline ? "textarea" : "input");
  if (!options.multiline) input.type = options.type || (options.dateKind === "day" ? "date" : "text");
  input.value = options.dateKind ? dateTime[options.dateKind](value) : value || "";
  if (options.placeholder) input.placeholder = options.placeholder;
  const changed = () => { clearFieldError(input); update(options.dateKind ? dateTime[options.dateKind](input.value) : input.value); syncOptionalRowRequired(input.closest('[data-optional-empty-row="true"]')); caseChanged(); };
  input.addEventListener("input", changed);
  input.addEventListener("change", changed);
  connectField(field,input,options.required);
  if (options.dateKind) installCompactEntry(field, input, label, options.dateKind, raw => {
    update(raw);
    syncOptionalRowRequired(field.closest('[data-optional-empty-row="true"]'));
    caseChanged();
  });
  return field;
}
function caseChanged() {
  pageDirty = true;
  pageEditRevision++;
  setPageStatus("政績內容有變更 · 儲存後才會進入發布流程");
  pageControls();
  const health = $(".source-health");
  if (health && caseDraft) health.textContent = `${caseDraft.sources.length} 筆來源 · ${caseDraft.sources.filter(item => item.url).length} 筆有公開網址。網址可達不代表主張已核實；內容核對仍須由人工確認。`;
  if (pageReady && caseDraft) $("#page-frame").contentWindow?.postMessage({
    type: "huiwen-cms-case-preview", nonce: pageNonce, case: caseDraft,
  }, "*");
}
function cleanCaseDraft() {
  if (!caseDraft) return null;
  const draft = structuredClone(caseDraft);
  draft.updated = dateTime.day(draft.updated);
  draft.history.forEach((item) => item.date = dateTime.period(item.date));
  draft.sources.forEach((item) => item.sourceDate = dateTime.period(item.sourceDate));
  draft.paragraphs = draft.paragraphs.filter((item) => item.trim());
  draft.history = draft.history.filter((item) => item.date?.trim() || item.title?.trim() || item.text?.trim());
  draft.sources = draft.sources.filter((item) => item.title?.trim() || item.url?.trim() || item.sourceDate?.trim() || item.sourceType?.trim());
  draft.media = draft.media.filter((item) => item.url?.trim() || item.alt?.trim() || item.caption?.trim() || item.credit?.trim());
  draft.imageMetadata = Object.fromEntries(Object.entries(draft.imageMetadata).filter(([filename, item]) =>
    caseBase?.imageMetadata?.[filename] || item.alt?.trim() || item.caption?.trim() || item.credit?.trim() || item.sourceUrl?.trim()));
  return draft;
}
function moveCaseItem(key, from, to, focusAction = "position") {
  if (!caseDraft || to < 0 || to >= caseDraft[key].length || from === to) return;
  const [item] = caseDraft[key].splice(from, 1);
  caseDraft[key].splice(to, 0, item);
  renderCaseEditor();
  caseChanged();
  document.querySelector('[data-case-list="' + key + '"][data-case-index="' + to + '"] [data-case-action="' + focusAction + '"]')?.focus();
}
function moveCaseSection(key, offset) {
  const from = caseDraft.sectionOrder.indexOf(key), to = from + offset;
  if (from < 0 || to < 0 || to >= caseDraft.sectionOrder.length) return;
  caseDraft.sectionOrder.splice(from, 1);
  caseDraft.sectionOrder.splice(to, 0, key);
  renderCaseEditor();
  caseChanged();
  document.querySelector('[data-case-section="' + key + '"] [data-case-section-action="' + (offset < 0 ? "up" : "down") + '"]')?.focus();
}
function caseSectionHeader(title, key) {
  const head = el("div", undefined, "case-section-head");
  const actions = el("div", undefined, "case-section-actions");
  const index = caseDraft.sectionOrder.indexOf(key);
  for (const [offset, label, action] of [[-1, "區塊上移", "up"], [1, "區塊下移", "down"]]) {
    const button = el("button", label, "secondary");
    button.type = "button";
    button.dataset.caseSectionAction = action;
    button.setAttribute("aria-label", title + label);
    button.disabled = index + offset < 0 || index + offset >= caseDraft.sectionOrder.length;
    button.onclick = () => moveCaseSection(key, offset);
    actions.append(button);
  }
  head.append(el("h4", title), actions);
  return head;
}
function caseRowActions(key, index, title, removable = true) {
  const actions = el("div", undefined, "case-row-actions");
  for (const [offset, label, action] of [[-1, "上移", "up"], [1, "下移", "down"]]) {
    const button = el("button", label, "secondary");
    button.type = "button";
    button.dataset.caseAction = action;
    button.setAttribute("aria-label", title + "第 " + (index + 1) + " 項" + label);
    button.disabled = index + offset < 0 || index + offset >= caseDraft[key].length;
    button.onclick = () => moveCaseItem(key, index, index + offset, action);
    actions.append(button);
  }
  const position = el("label", "移至", "case-row-position");
  const select = el("select");
  select.dataset.caseAction = "position";
  select.setAttribute("aria-label", title + "第 " + (index + 1) + " 項位置");
  for (let i = 0; i < caseDraft[key].length; i++) {
    const option = el("option", "第 " + (i + 1) + " 項");
    option.value = String(i);
    select.append(option);
  }
  select.value = String(index);
  select.disabled = caseDraft[key].length < 2;
  select.onchange = () => moveCaseItem(key, index, Number(select.value));
  position.append(select);
  actions.append(position);
  if (removable) {
    const remove = el("button", "移除此項", "secondary");
    remove.type = "button";
    remove.setAttribute("aria-label", title + "第 " + (index + 1) + " 項移除");
    remove.onclick = () => { caseDraft[key].splice(index, 1); renderCaseEditor(); caseChanged(); };
    actions.append(remove);
  }
  const disclosure = el("details", undefined, "case-row-menu");
  disclosure.append(el("summary", "順序與操作 ⋯"), actions);
  return disclosure;
}
function caseGroup(title, key, blank, inputs, maxCount, sectionKey = key) {
  const group = el("section", undefined, "case-editor-group");
  group.dataset.caseGroup = key;
  group.dataset.caseSection = sectionKey;
  if (key === "sources") {
    group.dataset.validationPath = "case.sources";
    const error = el("p", undefined, "field-error");
    error.id = "field-error-case-sources";
    error.hidden = true;
    error.setAttribute("role", "alert");
    group.append(error);
  }
  const heading=caseSectionHeader(title, sectionKey);
  heading.querySelector("h4").textContent=`${title}  ${caseDraft[key].length}`;
  const collapse=el("button","收合","quiet");collapse.type="button";collapse.setAttribute("aria-expanded","true");
  const body=el("div",undefined,"case-group-body");
  collapse.onclick=()=>{body.hidden=!body.hidden;collapse.setAttribute("aria-expanded",String(!body.hidden));collapse.textContent=body.hidden?"展開":"收合";};
  heading.append(collapse);
  group.append(heading);
  for (let i = 0; i < caseDraft[key].length; i++) {
    const row = el("div", undefined, "case-editor-row");
    row.dataset.caseList = key;
    row.dataset.caseIndex = String(i);
    row.dataset.optionalEmptyRow = "true";
    row.append(...inputs(caseDraft[key][i], i));
    row.append(caseRowActions(key, i, title));
    body.append(row);
    syncOptionalRowRequired(row);
  }
  const add = el("button", `＋ 新增${title}`, "secondary");
  add.type = "button";
  add.disabled = caseDraft[key].length >= maxCount;
  add.onclick = () => {
    caseDraft[key].push(structuredClone(blank));
    renderCaseEditor();
    caseChanged();
    document.querySelector('[data-case-list="' + key + '"][data-case-index="' + (caseDraft[key].length - 1) + '"] input, [data-case-list="' + key + '"][data-case-index="' + (caseDraft[key].length - 1) + '"] textarea')?.focus();
  };
  body.append(add);
  group.append(body);
  return group;
}
function renderCaseEditor() {
  const panel = $("#case-editor"), target = $("#case-editor-fields");
  panel.hidden = !caseDraft;
  target.replaceChildren();
  if (!caseDraft) return;
  target.append(
    caseInput("專頁標題", caseDraft.title, (v) => caseDraft.title = v, {required:true,path:"case.title"}),
    caseInput("摘要", caseDraft.summary, (v) => caseDraft.summary = v, { multiline: true,path:"case.summary" }),
    caseInput("內容整理日期", caseDraft.updated, (v) => caseDraft.updated = v, { dateKind: "day", placeholder: "20260924 或 2026-09-24",required:true,path:"case.updated" }),
  );
  const groups = {};
  groups.overview = caseGroup("完整背景與說明", "paragraphs", "", (_item, i) => [
    caseInput(`段落 ${i + 1}`, caseDraft.paragraphs[i], (v) => caseDraft.paragraphs[i] = v, { multiline: true,path:`case.paragraphs.${i}` }),
  ], 30, "overview");
  groups.history = caseGroup("推動歷程", "history", { date: "", title: "", text: "" }, (item,i) => [
    caseInput("日期或期間（例如 2026-09-24、2026-09、2026）", item.date, (v) => item.date = v, { dateKind: "period",required:true,path:`case.history.${i}.date` }),
    caseInput("標題", item.title, (v) => item.title = v,{required:true,path:`case.history.${i}.title`}),
    caseInput("說明（選填）", item.text, (v) => item.text = v, { multiline: true,path:`case.history.${i}.text` }),
  ], 50);
  groups.sources = caseGroup("資料來源", "sources", { title: "", url: "", sourceType: "", sourceDate: "" }, (item,i) => [
    caseInput("來源日期或期間（選填）", item.sourceDate, (v) => item.sourceDate = v, { dateKind: "period",path:`case.sources.${i}.sourceDate` }),
    caseInput("來源名稱", item.title, (v) => item.title = v,{required:true,path:`case.sources.${i}.title`}),
    caseInput("公開網址", item.url, (v) => item.url = v, { type: "url",required:true,path:`case.sources.${i}.url` }),
    caseInput("來源類型（選填）", item.sourceType, (v) => item.sourceType = v,{path:`case.sources.${i}.sourceType`}),
  ], 50);
  const sourceCount = caseDraft.sources.filter(item => item.url).length;
  groups.sources.prepend(el("p", `${caseDraft.sources.length} 筆來源 · ${sourceCount} 筆有公開網址。網址可達不代表主張已核實；內容核對仍須由人工確認。`, "source-health hint"));
  groups.media = caseGroup("照片與影片", "media", { kind: "photo", url: "", alt: "", caption: "", credit: "", publicAccessConfirmed: false }, (item,i) => {
    const path = `case.media.${i}`;
    const kind = makeField("類型",{path:`${path}.kind`}), select = document.createElement("select");
    for (const [value, label] of [["photo", "照片"], ["video", "影片"]]) { const option = el("option", label); option.value = value; select.append(option); }
    select.value = item.kind;
    select.onchange = () => { clearFieldError(select); select.closest("[data-optional-empty-row]")?.setAttribute("data-force-validate","true"); item.kind = select.value; syncOptionalRowRequired(select.closest('[data-optional-empty-row="true"]')); caseChanged(); };
    connectField(kind,select);
    const access = makeField("我已確認此網址不需登入即可公開檢視",{required:true,path:`${path}.publicAccessConfirmed`});
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = Boolean(item.publicAccessConfirmed);
    check.required=true;check.setAttribute("aria-required","true");
    check.onchange = () => { clearFieldError(check); if (check.checked) check.closest("[data-optional-empty-row]")?.setAttribute("data-force-validate","true"); item.publicAccessConfirmed = check.checked; syncOptionalRowRequired(check.closest('[data-optional-empty-row="true"]')); caseChanged(); };
    const error=access.querySelector(".field-error");
    if(error)check.setAttribute("aria-describedby",error.id);
    access.insertBefore(check,access.firstChild);
    return [kind,
      caseInput("Drive／Facebook／YouTube 或圖片、影片公開網址", item.url, (v) => item.url = v, { type: "url",required:true,path:`${path}.url` }),
      caseInput("替代文字／影片名稱", item.alt, (v) => item.alt = v,{required:true,path:`${path}.alt`}),
      caseInput("說明（選填）", item.caption, (v) => item.caption = v, { multiline: true,path:`${path}.caption` }),
      caseInput("拍攝者／刊登來源", item.credit, (v) => item.credit = v,{required:true,path:`${path}.credit`}), access];
  }, 24);
  const local = el("div", undefined, "case-local-group");
  local.append(el("h5", "既有網站照片"));
  for (const [index, filename] of caseDraft.images.entries()) {
    const item = caseDraft.imageMetadata?.[filename];
    const row = el("div", undefined, "case-editor-row");
    row.dataset.caseList = "images";
    row.dataset.caseIndex = String(index);
    row.dataset.optionalEmptyRow = caseBase?.imageMetadata?.[filename] ? "false" : "true";
    row.append(el("strong", filename));
    const thumbnail = document.createElement("img");
    thumbnail.src = `https://www.huiwen.tw/assets/${encodeURIComponent(filename)}`;
    thumbnail.alt = "原有網站照片";
    thumbnail.className = "case-local-thumbnail";
    row.append(thumbnail);
    if (!item) {
      const add = el("button", "編輯照片說明與來源", "secondary");
      add.type = "button";
      add.onclick = () => { caseDraft.imageMetadata[filename] = { alt: "", caption: "", credit: "", sourceUrl: "" }; renderCaseEditor(); caseChanged(); };
      row.append(add);
    } else {
      const field = `case.imageMetadata.${filename}`;
      row.append(
        caseInput("替代文字", item.alt, (v) => item.alt = v,{required:true,path:`${field}.alt`}),
        caseInput("照片說明（選填）", item.caption, (v) => item.caption = v,{path:`${field}.caption`}),
        caseInput("照片來源", item.credit, (v) => item.credit = v,{required:true,path:`${field}.credit`}),
        caseInput("原始刊登網址", item.sourceUrl, (v) => item.sourceUrl = v, { type: "url",required:true,path:`${field}.sourceUrl` }));
      if (!caseBase?.imageMetadata?.[filename]) {
        const cancel = el("button", "取消新增照片說明", "secondary");
        cancel.type = "button";
        cancel.onclick = () => { delete caseDraft.imageMetadata[filename]; renderCaseEditor(); caseChanged(); };
        row.append(cancel);
      }
    }
    row.append(caseRowActions("images", index, "既有網站照片", false));
    syncOptionalRowRequired(row);
    local.append(row);
  }
  if (caseDraft.images.length) groups.media.append(local);
  for (const key of caseDraft.sectionOrder) target.append(groups[key]);
}
function applyCurrentPageEdits() {
  const path = selectedPage?.path;
  if (!path || !isPageEditable(selectedPage) || selectedPage.publication_status !== "published" && selectedPage.source_kind !== "editorial-draft") {
    $("#page-frame").hidden = true;
    $("#page-editor-empty").hidden = false;
    $("#page-editor-empty p").textContent = selectedPage
      ? selectedPage.publication_status === "draft" ? "新頁面尚未發布；請在下方編輯內容、SEO 與區塊，儲存後即可送出發布。" : selectedPage.publication_status === "deleted" ? "此頁已在垃圾桶。可按「還原並重新發布」後再編輯。" : selectedPage.publication_status === "unpublished" ? "此頁已下架。可按「還原並重新發布」後再編輯。" : "此頁僅供檢視，原始來源不開放後台修改。"
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
  const request = ++pageSelectionRequest;
  pageLoading = true;
  pageLoadFailed = false;
  pageReady = false;
  pageNonce = null;
  selectedPage = page;
  pageDirty = false;
  pageDraft = null;
  pageFields = new Map();
  caseDraft = null;
  caseBase = null;
  homeDraft = null;
  homeBase = null;
  homeCases = new Map();
  seoDraft = null;
  seoBase = null;
  editorialDraft = null;
  editorialBase = null;
  extraBlocks = null;
  extraBlocksBase = null;
  let homeUnavailable = false;
  let caseBaselineRebased = false;
  $("#page-editor-title").textContent = page.title || page.path;
  $("#page-path").textContent = `/${page.path} · 來源：${page.source_path}`;
  $("#page-status").textContent = pageStatusLabel(page);
  setPageStatus(isPageEditable(page) ? "正在讀取此頁草稿…" : "此頁僅供檢視，無法從這裡修改來源。");
  $("#page-retry").hidden = true;
  $("#page-frame").hidden = true;
  $("#page-frame").removeAttribute("src");
  $("#page-editor-empty").hidden = false;
  $("#page-editor-empty p").textContent = "正在讀取頁面與草稿，請稍候…";
  for (const id of ["case-editor", "home-editor", "seo-editor", "editorial-editor", "editorial-seo-fields", "extra-blocks-editor", "page-history-panel"]) $("#" + id).hidden = true;
  $(".visual-editor").setAttribute("aria-busy", "true");
  pageControls();
  try {
    if (isPageEditable(page)) {
      const result = await api(`/api/page-draft?path=${encodeURIComponent(page.path)}`);
      if (request !== pageSelectionRequest) return false;
      pageDraft = result.draft;
      if (pageDraft?.payload) {
        const saved = JSON.parse(pageDraft.payload);
        pageFields = new Map(Object.entries(saved.fields || {}));
        if (isCasePage(page) && saved.case) { caseDraft = saved.case; caseBase = saved.caseBase || null; }
        if (page.path === "index.html" && saved.home) { homeDraft = saved.home; homeBase = saved.homeBase || null; }
        if (saved.seo) { seoDraft = saved.seo; seoBase = saved.seoBase || null; }
        if (saved.editorial) { editorialDraft = saved.editorial; editorialBase = saved.editorialBase || null; }
        if (saved.blocks) { extraBlocks = saved.blocks; extraBlocksBase = saved.blocksBase || []; }
      }
      if (isCasePage(page)) {
        const publicCase = (await api(`/api/case?path=${encodeURIComponent(page.path)}`)).case;
        if (request !== pageSelectionRequest) return false;
        const currentCase = { title: publicCase.title, summary: publicCase.summary, updated: publicCase.updated,
          paragraphs: publicCase.paragraphs || [], history: publicCase.history || [], sources: publicCase.sources || [],
          media: publicCase.media || [], imageMetadata: publicCase.imageMetadata || {},
          images: publicCase.images || [], sectionOrder: publicCase.sectionOrder || defaultCaseSectionOrder };
        if (!caseDraft) caseDraft = structuredClone(currentCase);
        else {
          caseDraft.images ??= [...currentCase.images];
          caseDraft.sectionOrder ??= [...currentCase.sectionOrder];
        }
        if (!caseBase) caseBase = structuredClone(currentCase);
        else {
          caseBase.images ??= [...currentCase.images];
          caseBase.sectionOrder ??= [...currentCase.sectionOrder];
        }
        if (caseDraft && caseBase && !sameValue(caseBase, currentCase) && sameValue(caseDraft, currentCase)) {
          caseBase = structuredClone(currentCase);
          pageDirty = true;
          pageEditRevision++;
          caseBaselineRebased = true;
        }
      }
      if (page.path === "index.html") {
        try {
          const current = await api("/api/home");
          if (request !== pageSelectionRequest) return false;
          homeCases = new Map(current.cases.map(record => [record.id, record]));
          if (!homeDraft) homeDraft = structuredClone(current.home);
          if (!homeBase) homeBase = structuredClone(current.home);
        } catch (error) {
          if (request !== pageSelectionRequest) return false;
          if (homeDraft) throw error;
          homeUnavailable = true;
        }
      }
      if (/^page-(?:news|press|service|council|achievement)-[a-z0-9-]+\.html$/.test(page.path) && page.source_kind !== "editorial-draft") {
        const current = (await api(`/api/editorial-page?path=${encodeURIComponent(page.path)}`)).page;
        if (request !== pageSelectionRequest) return false;
        if (!editorialDraft) editorialDraft = structuredClone(current);
        if (!editorialBase) editorialBase = structuredClone(current);
      }
      if (!editorialDraft && page.source_kind !== "editorial-draft" && page.path !== "index.html" && !isCasePage(page)) {
        const currentBlocks = (await api(`/api/page-blocks?path=${encodeURIComponent(page.path)}`)).blocks;
        if (request !== pageSelectionRequest) return false;
        if (!extraBlocks) extraBlocks = structuredClone(currentBlocks);
        if (!extraBlocksBase) extraBlocksBase = structuredClone(currentBlocks);
      }
      const history = await api(`/api/page-draft/history?path=${encodeURIComponent(page.path)}`);
      if (request !== pageSelectionRequest) return false;
      renderPageHistory(history.versions || []);
      $("#page-history-panel").hidden = !history.versions?.length;
      setPageStatus(caseBaselineRebased ? "正式政績內容已包含此草稿變更；基準已安全對齊，儲存草稿後即可發布其他獨立變更。" : homeUnavailable ? "首頁專題來源暫時無法載入；排序請稍後重試，其他頁面文字仍可編輯。" :
        pageDraft?.version ? `草稿 v${pageDraft.version} · ${pageDraft.publication_status === "unpublished" ? "已下架" : pageDraft.publication_status === "deleted" ? "垃圾桶" : "已儲存"}` : "尚無草稿；可點選下方正式頁面文字開始編輯。");
    } else {
      $("#page-history-panel").hidden = true;
    }
    pageLoading = false;
    pageControls();
    renderCaseEditor();
    renderHomeEditor();
    renderSeoEditor();
    renderEditorialEditor();
    renderExtraBlocksEditor();
    renderPages();
    applyCurrentPageEdits();
    return true;
  } catch (error) {
    if (request !== pageSelectionRequest) return false;
    pageLoadFailed = true;
    $("#page-editor-empty p").textContent = "此頁暫時無法載入。草稿未被修改，請重試或選擇其他頁面。";
    $("#page-retry").hidden = false;
    setPageStatus("載入未完成 · 編輯功能暫停，避免覆蓋資料");
    throw error;
  } finally {
    if (request === pageSelectionRequest) {
      pageLoading = false;
      $(".visual-editor").setAttribute("aria-busy", "false");
      pageControls();
    }
  }
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
  if (!selectedPage || !isPageEditable(selectedPage) || pageLoading || pageLoadFailed || pageSaveBusy) return false;
  for (const id of ["case-editor-fields","home-editor-fields","editorial-editor-fields","editorial-seo-fields","extra-blocks-fields","seo-editor-fields"]) {
    if (!validateRequiredFields(document.getElementById(id), true)) return false;
  }
  const savingPage = selectedPage;
  const request = pageSelectionRequest;
  const revision = pageEditRevision;
  const cleanedCase = cleanCaseDraft();
  pageSaveBusy = true;
  pageControls();
  try {
    const result = await api("/api/page-draft", "PUT", {
      path: savingPage.path,
      version: pageDraft?.version || 0,
      baseCommit: savingPage.commit_sha,
      fields: [...pageFields.entries()].map(([id, value]) => ({ id, ...value })),
      ...(cleanedCase ? { case: cleanedCase, caseBase } : {}),
      ...(homeDraft ? { home: homeDraft, homeBase } : {}),
      ...(seoDraft ? { seo: seoDraft, seoBase } : {}),
      ...(editorialDraft ? { editorial: editorialDraft, editorialBase } : {}),
      ...(extraBlocks ? { blocks: extraBlocks, blocksBase: extraBlocksBase } : {}),
    });
    if (request !== pageSelectionRequest) return false;
    pageDraft = { ...pageDraft, version: result.version };
    if (cleanedCase && revision === pageEditRevision) { caseDraft = cleanedCase; renderCaseEditor(); }
    const updated = await api(`/api/page-draft?path=${encodeURIComponent(savingPage.path)}`);
    if (request !== pageSelectionRequest) return false;
    pageDraft = updated.draft;
    pageDirty = revision !== pageEditRevision;
    selectedPage.draft_version = result.version;
    pageControls();
    await loadPages();
    if (request !== pageSelectionRequest) return false;
    const history = await api(`/api/page-draft/history?path=${encodeURIComponent(savingPage.path)}`);
    if (request !== pageSelectionRequest) return false;
    renderPageHistory(history.versions || []);
    $("#page-history-panel").hidden = !history.versions?.length;
    setPageStatus(pageDirty ? `草稿 v${result.version} 已儲存；儲存期間的新修改仍保留，請再儲存。` : `草稿 v${result.version} 已儲存；正式頁面尚未變更。`);
    return !pageDirty;
  } finally {
    pageSaveBusy = false;
    pageControls();
  }
}
async function submitPageOperation(operation, confirmed = false) {
  if (!selectedPage || !isPageEditable(selectedPage) || pageLoading || pageLoadFailed || pageSaveBusy) return;
  if (operation === "publish") {
    const conflicts = renderPagePublishConflicts();
    if (conflicts.content.length || conflicts.seo.length) {
      setPageStatus("發布前檢查未通過；請依內容與 SEO 區域的紅字分次發布。");
      pageControls();
      return;
    }
  }
  if (pageDirty) {
    if (!confirm("目前有未儲存的文字，先儲存草稿再繼續？")) return;
    if (await savePageDraft() === false) return;
  }
  if (!pageDraft?.version && await savePageDraft() === false) return;
  const prompts = {
    publish: "送出這個頁面的草稿？通過必要檢查後會更新正式官網。",
    unpublish: "將此頁從正式官網下架？原始頁面與版本紀錄保留，可再還原。",
    delete: "將此頁移至可還原的垃圾桶？它會從正式官網下架，原始來源不會被刪除。",
    restore: "還原此頁並重新發布？必要檢查通過後會重新出現在正式官網。",
  };
  if (!confirmed && !confirm(prompts[operation])) return;
  const receipt = await api("/api/page-draft/publish", "POST", { path: selectedPage.path, version: pageDraft.version, operation });
  setPageStatus(`已送出${operation === "publish" ? "發布" : operation === "unpublish" ? "下架" : operation === "delete" ? "移入垃圾桶" : "還原發布"}要求 · ${statusNames[receipt.status] || receipt.status}`);
  await Promise.all([publications(), loadPages()]);
  pageControls();
}
async function retryFailedPagePublication(publication) {
  if (!publication?.path || publication.operation !== "publish" || publication.status !== "failed" ||
      publication.message !== retryablePublicationMessage) return;
  if (!confirm(`重新建立 ${publication.path} 的發布要求？系統會將同一份 v${publication.version} 草稿保留成新版本，再以目前正式來源重新檢查；原失敗紀錄會保留。`)) return;
  const receipt = await api("/api/page-draft/retry", "POST", {id:publication.id,version:publication.version});
  notice(`已建立新的發布要求 v${receipt.version}；舊失敗紀錄保留，請查看發布中心狀態。`);
  await Promise.all([publications(),loadPages()]);
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
    if (data.seo && !seoDraft && !editorialDraft && Object.values(data.seo).every(value => typeof value === "string")) {
      seoDraft = structuredClone(data.seo);
      seoBase = structuredClone(data.seo);
      renderSeoEditor();
    }
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
  if (data.type === "huiwen-cms-case-focus" && caseDraft && typeof data.section === "string") {
    const target = data.section === "updated" ? $("#case-editor-fields > .field:nth-child(3) input") :
      $("#case-editor-fields [data-case-group='" + CSS.escape(data.section) + "'] input, #case-editor-fields [data-case-group='" + CSS.escape(data.section) + "'] textarea");
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus({ preventScroll: true });
    return;
  }
  if (data.type === "huiwen-cms-change" && data.field && typeof data.field.id === "string") {
    pageFields.set(data.field.id, { sourceHash: data.field.sourceHash, value: data.field.value });
    pageDirty = true;
    pageEditRevision++;
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
function markDocumentDirty() {
  dirty = true;
  documentEditRevision++;
  $("#version").textContent = `${selected.id ? `草稿 v${selected.version}` : "新活動"} · 有未儲存變更`;
  $("#preview").disabled = true;
}
function renderSessionField(sessionsValue, required) {
  const field = makeField(labels.sessions, { group: true, required, path: "document.sessions" });
  field.id = "field-sessions";
  field.classList.add("wide", "sessions-editor");
  const payload=JSON.parse(selected.payload);
  const editor=window.HuiwenLegalEditor.create({...payload,sessions:sessionsValue||[]},()=>{
    clearFieldError(field.querySelector("input") || field);
    markDocumentDirty();
  });
  const error=field.querySelector(".field-error");
  field.insertBefore(editor.element,error);
  field.readValue=editor.getValue;
  field.setMonth=editor.setMonth;
  return field;
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
  $("#refresh").disabled = !selected.id || documentReplaceBusy || documentSaveBusy;
  for (const key of selected.domain === "events" ? eventKeys : legalKeys) {
    if (["closedDates", "unconfirmedDates", "weekdayTimes"].includes(key)) continue;
    const required = documentFieldRequired(key, selected.domain, p.status || "scheduled");
    if (key === "sessions") {
      container.append(renderSessionField(p.sessions, required));
      continue;
    }
    const pickerKind = ["start", "end"].includes(key) ? "dateTime" : key === "month" ? "month" : /At$/.test(key) || key === "observedAt" ? "day" : null;
    const label = makeField(labels[key],{required,path:`document.${key}`,group:Boolean(pickerKind)});
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
    } else if (key === "content") {
      input = el("textarea");
      input.rows = 6;
    } else {
      input = el("input");
      input.type = key === "sourceUrl" ? "url" : pickerKind === "dateTime" ? "datetime-local" : pickerKind === "month" ? "month" : pickerKind === "day" ? "date" : "text";
      if (["start", "end"].includes(key)) input.step = "60";
    }
    input.name = key;
    input.id = `field-${key}`;
    const rawValue = p[key] ?? "";
    input.value = ["start", "end"].includes(key)
      ? dateTime.dateTime(String(rawValue).replace(/(?:Z|[+-]\d{2}:\d{2})$/, "")).slice(0, 16)
      : key === "month" ? dateTime.month(rawValue)
        : input.type === "date" ? dateTime.day(rawValue) : rawValue;
    if (["name", "content", "registration", "sourceUrl", "changeNote", "sourceTitle"].includes(key)) label.classList.add("wide");
    connectField(label,input,required);
    const monthChanged=()=> {
      if(key!=="month")return;
      $("#field-sessions")?.setMonth(input.value);
      const review=$("#field-nextReviewAt");if(review)review.value="";
      const title=$("#field-sourceTitle");if(title && /^20\\d{2}-(0[1-9]|1[0-2])$/.test(input.value)){
        const [year,month]=input.value.split("-").map(Number);
        title.value="陳慧文服務處｜"+year+"年"+month+"月公益律師諮詢時間表";
      }
    };
    if (pickerKind) installCompactEntry(label, input, labels[key], pickerKind, monthChanged);
    if (key==="month") input.addEventListener("change",monthChanged);
    if (key === "status") input.addEventListener("change", () => updateDocumentRequirements());
    input.addEventListener("input",()=>clearFieldError(input));
    container.append(label);
  }
  $("#preview").disabled = !selected.id || documentReplaceBusy || documentSaveBusy;
  $("#editor-form").oninput = markDocumentDirty;
}
function documentFieldRequired(key, domain, status) {
  if (domain === "events") {
    if (["name", "start", "end", "sourceUrl", "verifiedAt", "status"].includes(key)) return true;
    return status !== "scheduled" && ["changeNote", "updatedAt"].includes(key);
  }
  return ["month", "observedAt", "sourceUrl", "sessions"].includes(key);
}
function updateDocumentRequirements() {
  if (!selected) return;
  const status = $("#field-status")?.value || "scheduled";
  for (const key of selected.domain === "events" ? eventKeys : legalKeys) {
    const field = $(`[data-validation-path="document.${key}"]`);
    const control = key === "sessions" ? field?.querySelector("input[type=date]") : $(`#field-${key}`);
    const required = documentFieldRequired(key, selected.domain, status);
    if (!required && control?.required) clearFieldError(control);
    setFieldRequired(field, control, required);
  }
}
function read() {
  const out = {}, values = new FormData($("#editor-form"));
  for (const key of selected.domain === "events" ? eventKeys : legalKeys) {
    if (["closedDates","unconfirmedDates","weekdayTimes"].includes(key)) continue;
    if (key === "sessions") {
      Object.assign(out,$("#field-sessions").readValue());
      continue;
    }
    const value = values.get(key) ?? "";
    const kind = key === "month" ? "month" : ["start", "end"].includes(key) ? "dateTime" : /At$/.test(key) ? "day" : null;
    out[key] = ["start", "end"].includes(key)
      ? value ? `${dateTime.dateTime(value)}:00+08:00` : ""
      : kind ? dateTime[kind](value) : value || null;
  }
  return out;
}

async function save() {
  if (documentSaveBusy || documentReplaceBusy || !selected || !validateRequiredFields($("#fields"), true)) return;
  const savingDocument = selected;
  const revision = documentEditRevision;
  const payload = read();
  documentSaveBusy = true;
  $("#save").disabled = true;
  $("#save").textContent = "儲存中…";
  try {
    const result = savingDocument.id
      ? await api(`/api/documents/${savingDocument.id}`, "PUT", { version: savingDocument.version, payload })
      : await api("/api/documents", "POST", { domain: "events", payload });
    await load();
    if (selected !== savingDocument) return;
    const updated = documents.find((d) => d.id === result.id);
    if (!updated) throw new Error("草稿已送出，但清單尚未回傳此筆資料。請保留目前表單，稍後更新狀態。");
    selected = updated;
    dirty = revision !== documentEditRevision;
    if (!dirty) render();
    else {
      $("#version").textContent = `草稿 v${selected.version} · 有未儲存變更`;
      $("#preview").disabled = true;
    }
    await history();
    notice(dirty ? "草稿已儲存；儲存期間的新修改仍保留，請再儲存。" : "草稿已儲存，官網尚未變更。");
  } finally {
    documentSaveBusy = false;
    $("#save").disabled = documentReplaceBusy;
    $("#save").textContent = "儲存草稿";
    $("#refresh").disabled = !selected?.id || documentReplaceBusy;
    $("#preview").disabled = dirty || !selected?.id || documentReplaceBusy;
  }
}
async function replaceDocumentDraft(record, endpoint, body, successMessage) {
  if (!record?.id || documentSaveBusy || documentReplaceBusy) return;
  const revision = documentEditRevision;
  documentReplaceBusy = true;
  $("#refresh").disabled = true;
  $("#save").disabled = true;
  $("#preview").disabled = true;
  try {
    await api(endpoint, "POST", body);
    await load();
    if (selected !== record) {
      notice("指定草稿已更新；目前另一筆表單的編輯內容保持不變。");
      return;
    }
    const updated = documents.find(item => item.id === record.id);
    if (!updated) throw new Error("草稿已送出更新，但清單尚未回傳此筆資料。請保留目前表單，稍後更新狀態。");
    selected = updated;
    dirty = revision !== documentEditRevision;
    if (!dirty) render();
    else {
      $("#version").textContent = `草稿 v${selected.version} · 有未儲存變更`;
      $("#preview").disabled = true;
    }
    await history();
    notice(dirty ? "草稿版本已更新；等待期間的新修改仍保留，請確認後再儲存。" : successMessage);
  } finally {
    documentReplaceBusy = false;
    $("#refresh").disabled = !selected?.id;
    $("#save").disabled = documentSaveBusy;
    $("#preview").disabled = dirty || !selected?.id || documentSaveBusy;
  }
}
async function history() {
  const target = $("#history");
  target.replaceChildren();
  if (!selected.id) return;
  const record = selected;
  const data = await api(`/api/documents/${record.id}/history`);
  if (selected !== record) return;
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
          await replaceDocumentDraft(record, `/api/documents/${record.id}/restore`, {
            version: record.version, restoreVersion: v.version,
          }, "已還原為新草稿，尚未發布。");
        });
      row.append(b);
    }
    target.append(row);
  }
}
async function publications() {
  const result = await api("/api/publications");
  publicationRecords = result.publications;
  const target = $("#publications");
  target.replaceChildren();
  if (!result.publications.length)
    target.append(el("p", "尚未送出發布要求。", "hint"));
  let releaseIndex = 0;
  for (const p of result.publications) {
    const row = el("article", undefined, "publication");
    row.dataset.status = p.status;
    row.append(
      el("strong", statusNames[p.status] || p.status),
      el("span", `v${p.version} · 送出 ${displayDate(p.created_at)}`, "badge"),
      ...(p.path ? [el("p", `${p.path} · ${({ publish: "發布更新", unpublish: "下架", delete: "移至垃圾桶", restore: "還原發布" }[p.operation] || p.operation)}`)] : []),
      el("p", p.message || "已保存發布要求，等待處理。"),
    );
    const chain = el("dl", undefined, "verification-chain");
    const stages = [["PR", "已建立 PR"], ["CI", "CI 通過"], ["發布授權", "發布授權"],
      ["合併", "已合併"], ["部署", "已部署"], ["HTTP 驗證", "HTTP 驗證"],
      ["Snapshot 驗證", "Snapshot 驗證"], ["Native 驗證", "Native 驗證"]].map(([label, source]) => {
      const found = String(p.message || "").match(new RegExp(`${source}：(PASS|PENDING|FAIL|BLOCKED|UNKNOWN)`));
      const state = found?.[1] || (label === "PR" && p.pr_number ? `#${p.pr_number}` : "NOT CHECKED");
      return [label, state === "BLOCKED" && label === "Native 驗證" ? "BLOCKED · 詳細原因目前沒有由 verification backend 回傳" : state];
    });
    for (const [label, state] of stages) chain.append(el("dt", label), el("dd", state));
    const disclosure = el("details", undefined, "release-chain");
    disclosure.open = releaseIndex++ === 0;
    disclosure.append(el("summary", "查看 PR、CI、授權、部署及驗證階段"), chain);
    row.append(disclosure);
    if (p.path && p.operation === "publish" && p.status === "failed" && p.message === retryablePublicationMessage) {
      const retry = el("button", "以最新版本重新送出", "secondary");
      retry.type = "button";
      retry.onclick = () => action(() => retryFailedPagePublication(p));
      row.append(retry);
    }
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
$("#preview").onclick = () => action(async () => {
  if (dirty || !selected?.id || documentSaveBusy || documentReplaceBusy || $("#preview-dialog").open) return;
  const request = ++documentPreviewRequest;
  const reviewingDocument = selected;
  const revision = documentEditRevision;
  previewVersion = reviewingDocument.version;
  previewDocument = null;
  const target = $("#preview-content");
  target.replaceChildren();
  const p = JSON.parse(selected.payload);
  if(selected.domain==="legal-schedule" && p.unconfirmedDates?.length){
    showFieldError("document.sessions","仍有日期待填；請選律師或無／停辦後再預覽發布");return;
  }
  const published = await api(`/api/documents/${reviewingDocument.id}/published`);
  if (request !== documentPreviewRequest || selected !== reviewingDocument || dirty || revision !== documentEditRevision) return;
  previewDocument = { id: reviewingDocument.id, version: reviewingDocument.version };
  const baseline = published.source ? JSON.parse(published.source.payload) : null;
  const changed = (selected.domain === "events" ? eventKeys : legalKeys).filter(key =>
    !baseline || JSON.stringify(p[key] ?? null) !== JSON.stringify(baseline[key] ?? null));
  target.append(el("h3", `發布 ${changed.length} 項變更`));
  if (!baseline) target.append(el("p", "尚無已發布版本；以下為首次發布的資料。", "hint"));
  const renderValue = (key, value) => key === "status" ? ({scheduled:"排定",rescheduled:"改期",cancelled:"取消"}[value] || value || "—") :
    ["start", "end"].includes(key) && value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}) :
    key === "sessions" ? (value || []).map(s => `${s.date} ${s.start}–${s.end}${s.lawyer ? " "+s.lawyer+" 律師" : ""}`).join("\n") || "本月無場次" :
    key === "weekdayTimes" ? Object.entries(value||{}).map(([w,s])=>"週"+"日一二三四五六"[Number(w)]+" "+s.start+"–"+s.end).join("\n") :
    Array.isArray(value) ? value.join("、") || "—" : value || "—";
  const renderField = (key) => {
    const dl = el("dl", undefined, "preview-item");
    dl.append(el("dt", labels[key]));
    if (baseline) dl.append(el("dd", renderValue(key, baseline[key]), "previous-value"), el("dd", `→ ${renderValue(key, p[key])}`));
    else dl.append(el("dd", renderValue(key, p[key])));
    return dl;
  };
  for (const key of changed) target.append(renderField(key));
  const unchanged = (selected.domain === "events" ? eventKeys : legalKeys).filter(key => !changed.includes(key));
  if (unchanged.length) {
    const details = el("details", undefined, "review-all"), summary = el("summary", `查看完整資料（其餘 ${unchanged.length} 欄）`);
    details.append(summary, ...unchanged.map(renderField)); target.append(details);
  }
  const readiness = el("dl", undefined, "review-readiness");
  for (const [label, state] of [["必填與內容格式", "PASS · 已通過草稿儲存驗證"], ["來源事實核對", "NOT CHECKED"], ["外部連結可達性", "NOT CHECKED"], ["SEO", "NOT CHECKED"], ["正式頁面預覽", "NOT CHECKED"]]) readiness.append(el("dt", label), el("dd", state));
  target.append(el("h3", "發布前檢查"), readiness);
  $("#publish").textContent = `確認發布 ${changed.length} 項變更`;
  $("#preview-dialog").showModal();
});
$("#close-preview").onclick = () => { documentPreviewRequest++; $("#preview-dialog").close(); };
$("#preview-dialog").addEventListener("close", () => { documentPreviewRequest++; previewDocument = null; });
$("#publish").onclick = () =>
  action(async () => {
    if (!previewDocument || dirty || selected?.id !== previewDocument.id || selected.version !== previewDocument.version) {
      $("#preview-dialog").close();
      notice("內容已變更，請重新儲存並預覽後再發布。", "error");
      return;
    }
    const b = $("#publish");
    b.disabled = true;
    try {
      await api(`/api/documents/${previewDocument.id}/publish`, "POST", {
        version: previewDocument.version,
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
    const record = selected;
    await replaceDocumentDraft(record, `/api/documents/${record.id}/refresh`, {
      version: record.version,
    }, "已載入網站版本，可以繼續編輯。");
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
$("#page-sort").onchange = renderPages;
$("#page-work-filter").onchange = () => {
  if ($("#page-work-filter").value === "recent") $("#page-sort").value = "recent";
  renderPages();
};
$("#page-create-form").onsubmit = (event) => {
  event.preventDefault();
  if (!validateRequiredFields(event.currentTarget, true)) return;
  action(async () => {
    const form = new FormData(event.currentTarget);
    const result = await api("/api/page-create","POST",{
      section:String(form.get("section") || ""), slug:String(form.get("slug") || ""), title:String(form.get("title") || ""),
    });
    await loadPages();
    const page = pages.find(item => item.path === result.path);
    if (page) await selectPage(page);
    notice("已建立新頁草稿。摘要與 SEO 可留白；發布時至少需要一個完整內容區塊。");
    $("#page-create-panel").open = false;
  });
};
$("#page-create-form").addEventListener("input", event => clearFieldError(event.target));
$("#page-create-form").addEventListener("change", event => clearFieldError(event.target));
$("#page-save").onclick = () => action(savePageDraft);
$("#page-retry").onclick = () => action(() => selectedPage && selectPage(selectedPage));
$("#page-publish").onclick = () => action(() => submitPageOperation("publish"));
$("#page-unpublish").onclick = () => action(() => submitPageOperation("unpublish"));
$("#page-delete").onclick = () => action(() => submitPageOperation("delete"));
$("#page-restore").onclick = () => action(() => submitPageOperation("restore"));
action(async () => {
  session = await api("/api/session");
  $("#identity").textContent = `${session.login} · 擁有者`;
  await Promise.all([load(), loadPages()]);
});
