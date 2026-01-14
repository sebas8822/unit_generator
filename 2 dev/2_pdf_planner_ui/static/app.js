// app.js (Fixed: ID Mismatch & Toggles)

const state = {
  // --- Project State ---
  project: { course_id: null, unit_name: "" },

  // --- Data State ---
  outline: { weeklySchedule: [] },
  sources: {},
  activeSourceId: null,
  plan: { meta: { weeks_count: 12 }, weeks: {} },

  // --- UI State ---
  tocCollapsed: {}, 
  selectedWeek: 1,
  weeksCount: 12,

  // --- Config State ---
  planContent: {
    interactive: true,
    interactive_deep: false,
    parameters_slides: {
      slides_per_hour: 16,
      time_per_content_slides_min: 3,
      time_per_interactive_slide_min: 5,
      time_for_framework_slides_min: 6
    },
    sessions_per_week: 1,
    session_duration_hours: 2
  },

  // --- Generation State ---
  generated: null,
  generatedLLM: null,
  generatedView: "base", // "base" or "llm"

  // --- LLM State ---
  llm: { host: "http://localhost:11434", model: "qwen3:8b" },
  llmOk: false,
  llmBusy: false
};

// Safe element selector
const el = (id) => document.getElementById(id);

// Helper to safely bind clicks
function bindClick(id, handler) {
  const elem = el(id);
  if (elem) {
    elem.onclick = handler;
  }
}

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------

function requireProject() {
  if (!state.project.course_id) throw new Error("No project selected.");
}

function apiUrl(path) {
  requireProject();
  return `/api/project/${encodeURIComponent(state.project.course_id)}${path}`;
}

async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiPost(url, bodyObj) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function uploadFileTo(url, file) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(url, { method: "POST", body: fd });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------------------------------------------------------------------------
// Project Management UI
// ---------------------------------------------------------------------------

function setProjectLabel() {
  const lblCourse = el("projectCourse");
  const lblUnit = el("projectUnit");
  // Only update if elements exist (e.g. they might not be in your current HTML)
  if (lblCourse) lblCourse.textContent = state.project.course_id ? state.project.course_id : "No project selected";
  if (lblUnit) lblUnit.textContent = state.project.unit_name || "";
}

async function refreshProjectsList(selectCourseId = null) {
  console.log("Refreshing project list...");
  try {
    const res = await apiGet("/api/projects");
    const projects = res.projects || [];
    const sel = el("projectSelect");
    if (!sel) return;

    sel.innerHTML = "";
    if (projects.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No projects";
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }

    sel.disabled = false;
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.course_id;
      opt.textContent = p.unit_name ? `${p.course_id} — ${p.unit_name}` : p.course_id;
      sel.appendChild(opt);
    }

    const chosen = selectCourseId || projects[0].course_id;
    sel.value = chosen;
    console.log("Auto-loading project:", chosen);
    await loadProject(chosen);
  } catch (e) {
    console.warn("Could not load projects (API might be offline):", e);
  }
}

async function createNewProject() {
  const course_id = (prompt("Enter Course ID (e.g., ICT312):") || "").trim();
  if (!course_id) return;
  const unit_name = (prompt("Enter Unit Name (optional):") || "").trim();

  try {
    await apiPost("/api/projects", { course_id, unit_name });
    await refreshProjectsList(course_id);
  } catch (e) {
    alert("Error creating project: " + e.message);
  }
}

async function loadProject(courseId) {
  if (!courseId) return;
  try {
    state.tocCollapsed = {}; 
    state.activeSourceId = null;

    const boot = await apiGet(`/api/project/${encodeURIComponent(courseId)}/bootstrap`);

    state.project = boot.project || { course_id: courseId, unit_name: "" };
    setProjectLabel(); 

    state.plan = boot.plan || { meta: { weeks_count: 12 }, weeks: {} };
    state.outline = boot.outline || { weeklySchedule: [] };
    state.sources = boot.sources || {};
    state.activeSourceId = Object.keys(state.sources)[0] || null;

    if (state.plan?.meta?.plan_content) {
      const pc = state.plan.meta.plan_content;
      state.planContent = { ...state.planContent, ...pc };
      delete state.planContent.course_id;
      delete state.planContent.unit_name;
    }

    state.generated = boot.generated_plan || null;
    state.generatedLLM = boot.generated_llm_plan || null;

    const planWeeks = state.plan?.meta?.weeks_count;
    const outlineWeeks = Array.isArray(state.outline?.weeklySchedule) ? state.outline.weeklySchedule.length : 0;
    const initialWeeks = planWeeks ?? (outlineWeeks > 0 ? outlineWeeks : 12);
    
    setWeeksCount(initialWeeks);
    fillPlanContentUI();
    
    // Update view toggle buttons
    updateViewToggles();
    
    renderAll();
    
    const dlLlmBtn = el("downloadLLMBtn");
    if (dlLlmBtn) dlLlmBtn.disabled = !state.generatedLLM;

  } catch (e) {
    console.error("Load failed:", e);
    alert("Failed to load project: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Logic & Helpers
// ---------------------------------------------------------------------------

function tocKey(sourceId, tocId) { return `${sourceId}::${String(tocId)}`; }
function clampInt(n, minV, maxV) {
  const x = parseInt(n, 10);
  return isNaN(x) ? minV : Math.max(minV, Math.min(maxV, x));
}

function ensureWeeksExist(count) {
  for (let i = 1; i <= count; i++) {
    const k = String(i);
    if (!state.plan.weeks[k]) state.plan.weeks[k] = { topic: "", items: [] };
  }
}

function initWeeks() {
  const ws = el("weekSelect");
  if (!ws) return;
  ws.innerHTML = "";
  ensureWeeksExist(state.weeksCount);
  for (let i = 1; i <= state.weeksCount; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Week ${i}`;
    ws.appendChild(opt);
  }
  if (state.selectedWeek > state.weeksCount) state.selectedWeek = 1;
  ws.value = String(state.selectedWeek);
  ws.onchange = () => {
    state.selectedWeek = parseInt(ws.value, 10);
    renderAll(); 
  };
}

function setWeeksCount(n, { syncInput = true } = {}) {
  const count = clampInt(n, 1, 52);
  state.weeksCount = count;
  if (!state.plan.meta) state.plan.meta = {};
  state.plan.meta.weeks_count = count;
  if (state.selectedWeek > count) state.selectedWeek = count;
  ensureWeeksExist(count);
  if (syncInput) {
    const inp = el("weeksCountInput");
    if (inp) inp.value = String(count);
  }
  initWeeks();
  renderAll();
}

function fillPlanContentUI() {
  const chkInt = el("interactiveInput");
  const chkDeep = el("interactiveDeepInput");
  if (chkInt) chkInt.checked = !!state.planContent.interactive;
  if (chkDeep) chkDeep.checked = !!state.planContent.interactive_deep;

  const p = state.planContent.parameters_slides || {};
  if(el("slidesPerHourInput")) el("slidesPerHourInput").value = p.slides_per_hour ?? 16;
  if(el("timePerContentInput")) el("timePerContentInput").value = p.time_per_content_slides_min ?? 3;
  if(el("timePerInteractiveInput")) el("timePerInteractiveInput").value = p.time_per_interactive_slide_min ?? 5;
  if(el("timeFrameworkInput")) el("timeFrameworkInput").value = p.time_for_framework_slides_min ?? 6;

  if(el("sessionsPerWeekInput")) el("sessionsPerWeekInput").value = state.planContent.sessions_per_week ?? 1;
  if(el("sessionHoursInput")) el("sessionHoursInput").value = state.planContent.session_duration_hours ?? 2;
  updatePlanContentUIEnabled();
}

function updatePlanContentUIEnabled() {
  const on = el("interactiveInput")?.checked;
  const deep = el("interactiveDeepInput");
  if (deep) {
      deep.disabled = !on;
      if (!on) deep.checked = false;
  }
}

function readPlanContentFromUI() {
  state.planContent.interactive = !!el("interactiveInput")?.checked;
  state.planContent.interactive_deep = !!el("interactiveDeepInput")?.checked;
  state.planContent.parameters_slides = {
    slides_per_hour: parseInt(el("slidesPerHourInput")?.value, 10) || 16,
    time_per_content_slides_min: parseInt(el("timePerContentInput")?.value, 10) || 3,
    time_per_interactive_slide_min: parseInt(el("timePerInteractiveInput")?.value, 10) || 5,
    time_for_framework_slides_min: parseInt(el("timeFrameworkInput")?.value, 10) || 6
  };
  state.planContent.sessions_per_week = parseInt(el("sessionsPerWeekInput")?.value, 10) || 1;
  state.planContent.session_duration_hours = parseFloat(el("sessionHoursInput")?.value) || 2;
  if (!state.plan.meta) state.plan.meta = {};
  state.plan.meta.plan_content = state.planContent;
}

// ---------------------------------------------------------------------------
// Assignment & Tree Helpers
// ---------------------------------------------------------------------------

function flattenSubtree(node) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    out.push(n);
    if (Array.isArray(n.children)) { for (const ch of n.children) walk(ch); }
  })(node);
  return out;
}

function assignSubtreeToWeek(sourceId, node, weekStr, { includeParent = true } = {}) {
  const nodes = flattenSubtree(node);
  const picked = includeParent ? nodes : nodes.slice(1);
  if (!picked.length) return;
  const ids = new Set(picked.map(n => n.toc_id));
  
  for (const w of Object.values(state.plan.weeks)) {
    w.items = (w.items || []).filter(it => !(it.source_id === sourceId && ids.has(it.toc_id)));
  }
  if (!state.plan.weeks[weekStr]) state.plan.weeks[weekStr] = { topic: "", items: [] };
  const dest = state.plan.weeks[weekStr];
  for (const n of picked) {
    dest.items.push({ source_id: sourceId, toc_id: n.toc_id, title: n.title, titles_path: n.titles_path || [n.title] });
  }
}

function unassignSubtree(sourceId, node, { includeParent = true } = {}) {
  const nodes = flattenSubtree(node);
  const picked = includeParent ? nodes : nodes.slice(1);
  const ids = new Set(picked.map(n => n.toc_id));
  for (const w of Object.values(state.plan.weeks)) {
    w.items = (w.items || []).filter(it => !(it.source_id === sourceId && ids.has(it.toc_id)));
  }
}

function subtreeCount(node) { return flattenSubtree(node).length; }

function assignNodeToWeek(sourceId, node, weekStr) {
  for (const w of Object.values(state.plan.weeks)) {
    w.items = w.items.filter(x => !(x.source_id === sourceId && x.toc_id === node.toc_id));
  }
  state.plan.weeks[weekStr].items.push({ source_id: sourceId, toc_id: node.toc_id, title: node.title, titles_path: node.titles_path || [node.title] });
}

function unassignNode(sourceId, tocId) {
  for (const w of Object.values(state.plan.weeks)) {
    w.items = w.items.filter(x => !(x.source_id === sourceId && x.toc_id === tocId));
  }
}

function findAssignedWeek(sourceId, tocId) {
  for (const [wk, wobj] of Object.entries(state.plan.weeks)) {
    if (wobj.items.find(x => x.source_id === sourceId && x.toc_id === tocId)) return wk;
  }
  return null;
}

function setActiveSource(sourceId) {
  state.activeSourceId = sourceId;
  renderAll();
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}
function escapeAttr(s){ return escapeHtml(s).replace(/"/g, "&quot;"); }

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderAll() {
  renderPdfList();
  renderToc();
  renderWeekSummary();
  renderGeneratedPlanPreview();
}

function renderPdfList() {
  const list = el("pdfList");
  if (!list) return;
  list.innerHTML = "";
  const entries = Object.entries(state.sources);
  if (entries.length === 0) {
    list.innerHTML = `<div class="muted small">No PDFs uploaded yet.</div>`;
    return;
  }
  for (const [sourceId, src] of entries) {
    const item = document.createElement("div");
    item.className = "listItem";
    const left = document.createElement("div");
    left.innerHTML = `<div><b>${escapeHtml(src.filename)}</b></div><div class="muted small">source_id: ${escapeHtml(sourceId).substring(0,8)}...</div>`;
    
    const right = document.createElement("div");
    right.className = "row";
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = `${src.toc_entries_count} nodes`;
    
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = (state.activeSourceId === sourceId) ? "Active" : "Open";
    btn.onclick = () => setActiveSource(sourceId);
    
    right.appendChild(badge);
    right.appendChild(btn);
    item.appendChild(left);
    item.appendChild(right);
    list.appendChild(item);
  }
}

function renderToc() {
  const meta = el("tocMeta");
  const container = el("tocTree");
  if (!container) return;
  container.innerHTML = "";

  if (!state.activeSourceId) {
    if(meta) meta.textContent = "Upload a PDF and click Open to view its ToC.";
    return;
  }
  const src = state.sources[state.activeSourceId];
  if(meta) meta.textContent = `Viewing: ${src.filename} • nodes: ${src.toc_entries_count}`;

  const renderNode = (node) => {
    const wrap = document.createElement("div");
    wrap.className = "tocNode";
    const head = document.createElement("div");
    head.className = "tocHead";
    const left = document.createElement("div");
    
    const key = tocKey(state.activeSourceId, node.toc_id);
    const hasKids = !!(node.children && node.children.length);
    const collapsed = !!state.tocCollapsed[key];

    const titleRow = document.createElement("div");
    titleRow.className = "tocTitleRow";
    if (hasKids) {
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "tocToggleBtn";
      toggleBtn.textContent = collapsed ? "▸" : "▾";
      toggleBtn.onclick = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        state.tocCollapsed[key] = !state.tocCollapsed[key];
        renderToc();
      };
      titleRow.appendChild(toggleBtn);
    } else {
        const spacer = document.createElement("span");
        spacer.style.width="28px"; titleRow.appendChild(spacer);
    }
    const titleDiv = document.createElement("div");
    titleDiv.className = "tocTitle";
    titleDiv.textContent = node.title || "(untitled)";
    titleRow.appendChild(titleDiv);
    left.appendChild(titleRow);

    const metaDiv = document.createElement("div");
    metaDiv.className = "tocMeta";
    const subtreeStr = hasKids ? ` • Subtree: ${subtreeCount(node)} nodes` : "";
    metaDiv.textContent = `ID: ${node.toc_id ?? "-"} • Page: ${node.page_1based ?? "-"}${subtreeStr}`;
    left.appendChild(metaDiv);

    const right = document.createElement("div");
    right.className = "row";
    const assignedWeek = findAssignedWeek(state.activeSourceId, node.toc_id);
    if (assignedWeek) {
      const tag = document.createElement("div");
      tag.className = "tagWeek";
      tag.textContent = `Week ${assignedWeek}`;
      right.appendChild(tag);
    }
    const assignBtn = document.createElement("button");
    assignBtn.className = "btn primary";
    assignBtn.textContent = "Assign";
    assignBtn.onclick = (ev) => {
      const wk = String(state.selectedWeek);
      if (ev && ev.shiftKey && hasKids) assignSubtreeToWeek(state.activeSourceId, node, wk);
      else assignNodeToWeek(state.activeSourceId, node, wk);
      renderAll();
    };
    right.appendChild(assignBtn);

    if (hasKids) {
      const assignAllBtn = document.createElement("button");
      assignAllBtn.className = "btn";
      assignAllBtn.textContent = "Assign+";
      assignAllBtn.onclick = () => { assignSubtreeToWeek(state.activeSourceId, node, String(state.selectedWeek)); renderAll(); };
      right.appendChild(assignAllBtn);
    }
    
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn";
    removeBtn.textContent = "X";
    removeBtn.onclick = () => { unassignNode(state.activeSourceId, node.toc_id); renderAll(); };
    right.appendChild(removeBtn);

    head.appendChild(left); head.appendChild(right); wrap.appendChild(head);
    
    if (hasKids && !collapsed) {
      const kids = document.createElement("div");
      kids.className = "tocChildren";
      node.children.forEach(ch => kids.appendChild(renderNode(ch)));
      wrap.appendChild(kids);
    }
    return wrap;
  };
  src.toc_tree.forEach(n => container.appendChild(renderNode(n)));
}

// --- Week Summary (Tree) ---
function buildWeekTree(items) {
  const root = { label: "__root__", children: {}, selected: [], sourceId: null, minTocId: Infinity, count: 0 };
  for (const it of (items || [])) {
    const sourceId = it.source_id;
    const sourceLabel = (state.sources[sourceId]?.filename) || sourceId;
    const titles = (Array.isArray(it.titles_path) && it.titles_path.length) ? it.titles_path : [it.title || `ToC ${it.toc_id}`];
    const path = [sourceLabel, ...titles];
    let cur = root;
    for (let i = 0; i < path.length; i++) {
      const seg = (path[i] || "(untitled)");
      if (!cur.children[seg]) {
        cur.children[seg] = { label: seg, children: {}, selected: [], sourceId: (i === 0) ? sourceId : cur.sourceId, minTocId: Infinity, count: 0 };
      }
      cur = cur.children[seg];
      if (i === 0) cur.sourceId = sourceId;
    }
    cur.selected.push(it);
  }
  finalizeWeekTree(root);
  return root;
}

function finalizeWeekTree(node) {
  let count = (node.selected || []).length;
  let minT = Infinity;
  for (const sel of (node.selected || [])) {
    const t = Number.parseInt(sel.toc_id, 10);
    if (!Number.isNaN(t)) minT = Math.min(minT, t);
  }
  for (const ch of Object.values(node.children || {})) {
    finalizeWeekTree(ch);
    count += ch.count || 0;
    minT = Math.min(minT, ch.minTocId ?? Infinity);
  }
  node.count = count;
  node.minTocId = minT;
}

function renderWeekTreeNode(node, depth) {
  const hasKids = node.children && Object.keys(node.children).length > 0;
  const makeLine = () => {
    const line = document.createElement("div");
    line.className = "wkLine";
    line.style.marginLeft = `${depth * 14}px`;
    const label = document.createElement("div");
    label.className = "wkLabel";
    label.textContent = node.label;
    line.appendChild(label);
    const meta = document.createElement("div");
    meta.className = "wkCount";
    meta.textContent = String(node.count ?? 0);
    line.appendChild(meta);
    if (node.selected && node.selected.length) {
       const actions = document.createElement("div");
       actions.className = "wkActions";
       const sel = node.selected[0];
       const view = document.createElement("button");
       view.className = "btn smallBtn";
       view.textContent = "View";
       view.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openPreview(sel.source_id, String(sel.toc_id)); };
       actions.appendChild(view);
       const rm = document.createElement("button");
       rm.className = "btn smallBtn";
       rm.textContent = "Rm";
       rm.onclick = (e) => { e.preventDefault(); e.stopPropagation(); unassignNode(sel.source_id, sel.toc_id); renderAll(); };
       actions.appendChild(rm);
       line.appendChild(actions);
    }
    return line;
  };
  if (hasKids) {
    const det = document.createElement("details");
    det.className = "wkNode";
    det.open = depth < 2; 
    const sum = document.createElement("summary");
    sum.className = "wkSummary";
    sum.appendChild(makeLine());
    det.appendChild(sum);
    const kidsWrap = document.createElement("div");
    kidsWrap.className = "wkChildren";
    const children = Object.values(node.children).sort((a, b) => (a.minTocId - b.minTocId) || a.label.localeCompare(b.label));
    for (const ch of children) kidsWrap.appendChild(renderWeekTreeNode(ch, depth + 1));
    det.appendChild(kidsWrap);
    return det;
  }
  return makeLine();
}

function renderWeekSummary() {
  const wrap = el("weekTableWrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (let i = 1; i <= state.weeksCount; i++) {
    const wk = String(i);
    const wobj = state.plan.weeks[wk] || { topic: "", items: [] };
    const items = wobj.items || [];
    const weekDet = document.createElement("details");
    weekDet.className = "weekBlock";
    weekDet.open = (i === state.selectedWeek);
    const sum = document.createElement("summary");
    sum.className = "weekHead";
    sum.innerHTML = `<div><b>Week ${i}</b> <span class="muted small">(${items.length} items)</span></div>`;
    const clearBtn = document.createElement("button");
    clearBtn.className = "btn danger smallBtn";
    clearBtn.textContent = "Clear";
    clearBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if(state.plan.weeks[wk]) state.plan.weeks[wk].items = []; renderAll(); };
    sum.appendChild(clearBtn);
    weekDet.appendChild(sum);
    const body = document.createElement("div");
    body.className = "weekBody";
    if (!items.length) body.innerHTML = `<div class="muted small">No sections assigned.</div>`;
    else {
        const tree = buildWeekTree(items);
        const sources = Object.values(tree.children).sort((a, b) => a.label.localeCompare(b.label));
        for (const srcNode of sources) body.appendChild(renderWeekTreeNode(srcNode, 0));
    }
    weekDet.appendChild(body);
    wrap.appendChild(weekDet);
  }
}

// --- Generated Plan Render (Detailed) ---
function renderGeneratedPlanPreview() {
  const wrap = el("generatedPlanWrap"); // <--- FIXED ID HERE (was generatedPreviewWrap)
  const hint = el("generatedPlanHint");
  
  if (!wrap) return;

  // Toggles state
  const mode = state.generatedView || "base";
  const plan = (mode === "llm") ? (state.generatedLLM || state.generated) : (state.generated || state.generatedLLM);

  const baseBtn = el("generatedViewBaseBtn");
  const llmBtn = el("generatedViewLlmBtn");
  if (baseBtn) baseBtn.classList.toggle("primary", mode !== "llm");
  if (llmBtn) llmBtn.classList.toggle("primary", mode === "llm");

  if (!plan || !plan.weeks) {
    wrap.innerHTML = "";
    if (hint) hint.style.display = "block";
    return;
  }
  if (hint) hint.style.display = "none";

  const wkKey = String(state.selectedWeek);
  const wk = plan.weeks[wkKey];
  
  if (!wk || !Array.isArray(wk.deck_plans) || wk.deck_plans.length === 0) {
    wrap.innerHTML = `<div class="muted small">No generated content for Week ${state.selectedWeek}.</div>`;
    return;
  }
  
  const deckCards = wk.deck_plans.map(deck => {
    const sections = deck.sections || [];
    const items = sections.map(sec => {
        if(sec.section_type !== "Content") {
             return `<div class="genFrameworkRow"><span class="pill">${sec.section_type}</span> <span class="muted small">${escapeHtml(sec.content?.title || "")}</span></div>`;
        }
        const blocks = sec.content_blocks || [];
        const blockHtml = blocks.map(b => {
             const title = b.title || "Untitled";
             // Handle both LLM-generated and base content slides
             const slidesCount = (b.slides && b.slides.length) ? b.slides.length : (b.direct_slides_content || 0);
             return `<div class="genItem pillClick" data-source="${escapeAttr(b.source_id)}" data-toc="${escapeAttr(String(b.toc_id))}">${escapeHtml(title)} <span class="muted small">(${slidesCount} slides)</span></div>`;
        }).join("");
        return `<div class="genDeckBody"><div class="genContentTitle">Content</div>${blockHtml}</div>`;
    }).join("");
    
    return `<div class="genDeck"><div class="genDeckHead"><div><b>Deck ${deck.deck_number}</b></div><div class="muted small">${escapeHtml(JSON.stringify(deck.slide_count_breakdown || {}))}</div></div>${items}</div>`;
  }).join("");
  
  wrap.innerHTML = `<div class="muted small" style="margin-bottom:8px;">Week ${wk.week} • ${escapeHtml(wk.overall_topic || "")}</div>${deckCards || '<div class="muted small">No decks.</div>'}`;
  
  wrap.querySelectorAll(".pillClick").forEach(p => {
    p.addEventListener("click", async (e) => { await openPreview(e.currentTarget.getAttribute("data-source"), e.currentTarget.getAttribute("data-toc")); });
  });
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
async function openPreview(sourceId, tocId) {
  const modal = el("previewModal");
  if (!modal) return;
  el("previewTitle").textContent = "Loading...";
  el("previewBody").textContent = "";
  modal.classList.remove("hidden");
  try {
      const data = await apiGet(apiUrl(`/section_text/${encodeURIComponent(sourceId)}/${encodeURIComponent(tocId)}?max_chars=20000`));
      el("previewTitle").textContent = data.title_path || data.title || `ToC ${tocId}`;
      el("previewBody").textContent = data.text || "(No extracted text found for this node.)";
  } catch(e) { el("previewBody").textContent = "Error loading text."; }
}

function openTextModal(title, text) {
  const modal = el("previewModal");
  el("previewTitle").textContent = title || "Preview";
  el("previewBody").textContent = text || "";
  modal.classList.remove("hidden");
}

function closePreview() { const modal = el("previewModal"); if (modal) modal.classList.add("hidden"); }

// --- LLM Logic ---
function fillLLMUI() {
  const host = el("ollamaHostInput");
  const model = el("ollamaModelInput");
  if (host) host.value = state.llm.host || "";
  if (model) model.value = state.llm.model || "";
}

function readLLMFromUI() {
  state.llm.host = (el("ollamaHostInput")?.value || "").trim() || "http://localhost:11434";
  state.llm.model = (el("ollamaModelInput")?.value || "").trim() || "qwen3:8b";
}

function updateViewToggles() {
    bindClick("generatedViewBaseBtn", () => { state.generatedView = "base"; renderGeneratedPlanPreview(); });
    bindClick("generatedViewLlmBtn", () => { state.generatedView = "llm"; renderGeneratedPlanPreview(); });
    
    // Initial state
    const base = el("generatedViewBaseBtn");
    const llm = el("generatedViewLlmBtn");
    if(base) base.classList.toggle("primary", state.generatedView !== "llm");
    if(llm) llm.classList.toggle("primary", state.generatedView === "llm");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  console.log("App booting...");
  
  try { initWeeks(); } catch(e) { console.error("initWeeks failed:", e); }
  try { setProjectLabel(); } catch(e) { console.error("setProjectLabel failed:", e); }

  // 1. Wire Project Controls
  bindClick("newProjectBtn", createNewProject);
  const selProj = el("projectSelect");
  if (selProj) selProj.onchange = () => loadProject(selProj.value);

  // 2. Wire Uploads
  const dz = el("dropZone");
  const fi = el("fileInput");
  if(dz && fi) {
      dz.onclick = () => fi.click();
      fi.onchange = async (e) => {
          const f = e.target.files[0];
          if(f) await handlePdfUpload(f);
          fi.value = "";
      };
      dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
      dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
      dz.addEventListener("drop", async (e) => {
          e.preventDefault(); dz.classList.remove("drag");
          const f = e.dataTransfer.files?.[0];
          if(f) await handlePdfUpload(f);
      });
  }

  const outIn = el("outlineInput");
  if(outIn) outIn.onchange = async (e) => {
      const f = e.target.files[0];
      if(f) {
          try {
              requireProject();
              await uploadFileTo(apiUrl("/upload_outline"), f);
              state.outline = await apiGet(apiUrl("/outline"));
              const n = state.outline.weeklySchedule?.length || 12;
              setWeeksCount(n);
              alert("Outline uploaded");
          } catch(e) { alert(e.message); }
      }
      outIn.value = "";
  };

  // 3. Plan Actions
  bindClick("savePlanBtn", async () => {
      try {
          requireProject();
          state.plan.meta.weeks_count = state.weeksCount;
          await apiPost(apiUrl("/plan"), state.plan);
          alert("Saved");
      } catch(e) { alert(e.message); }
  });
  
  bindClick("loadPlanBtn", async () => {
      try {
          requireProject();
          state.plan = await apiGet(apiUrl("/plan"));
          const planWeeks = state.plan?.meta?.weeks_count;
          if (planWeeks) setWeeksCount(planWeeks);
          renderAll();
          alert("Loaded");
      } catch(e) { alert(e.message); }
  });

  // 4. Generate
  bindClick("generatePlanBtn", async () => {
      try {
          requireProject();
          readPlanContentFromUI();
          const st = el("genStatus"); if(st) st.textContent = "Generating...";
          const res = await apiPost(apiUrl("/generate_plan"), { plan: state.plan, config: state.planContent });
          state.generated = res.plan;
          if(st) st.textContent = "Done";
          renderGeneratedPlanPreview();
          const dl = el("downloadGeneratedBtn");
          if(dl) dl.disabled = false;
      } catch(e) { 
          const st = el("genStatus"); if(st) st.textContent = e.message; 
      }
  });
  
  bindClick("downloadGeneratedBtn", () => {
      if(!state.generated) return;
      const blob = new Blob([JSON.stringify(state.generated, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "generated_plan.json"; a.click();
  });

  // 5. LLM Controls
  const hostIn = el("llmHostInput");
  if(hostIn) hostIn.addEventListener("input", () => state.llm.host = hostIn.value);
  const modIn = el("llmModelInput");
  if(modIn) modIn.addEventListener("input", () => state.llm.model = modIn.value);

  // Wire toggles
  updateViewToggles();

  bindClick("llmCheckBtn", async () => {
      try {
          requireProject();
          readLLMFromUI();
          const stat = el("llmStatus");
          if(stat) stat.textContent = "Pinging...";
          const res = await apiGet(apiUrl(`/llm_health?host=${encodeURIComponent(state.llm.host)}&model=${encodeURIComponent(state.llm.model)}`));
          
          if (res.ok) {
              if(stat) stat.textContent = "✔ " + (res.message || "Online");
              // ENABLE THE GENERATE BUTTON HERE
              const genBtn = el("llmGenerateBtn");
              if (genBtn) genBtn.disabled = false;
          } else {
              if(stat) stat.textContent = "✖ " + (res.message || "Error");
          }
      } catch(e) { 
          const stat = el("llmStatus"); if(stat) stat.textContent = e.message; 
      }
  });

  bindClick("llmGenerateBtn", async () => {
      try {
          requireProject();
          readLLMFromUI();
          if (!state.generated) { alert("Generate plan first"); return; }
          const stat = el("llmStatus");
          if(stat) stat.textContent = `Generating week ${state.selectedWeek}...`;
          const res = await apiPost(apiUrl("/llm_generate_week"), {
              week_number: state.selectedWeek,
              generated_plan: state.generated,
              ollama_host: state.llm.host,
              ollama_model: state.llm.model
          });
          state.generatedLLM = res.plan;
          if(stat) stat.textContent = "LLM Done ✔";
          // Enable view toggle
          updateViewToggles();
          // Enable DL button
          const dl = el("downloadLLMBtn"); if(dl) dl.disabled = false;
          // Switch to LLM view automatically
          state.generatedView = "llm";
          renderGeneratedPlanPreview();
      } catch(e) { 
          const stat = el("llmStatus"); if(stat) stat.textContent = e.message; 
      }
  });
  
  // NOTE: In your HTML snippet, this button ID is sometimes referred to as downloadGeneratedLlmBtn or downloadLLMBtn.
  // I will bind both to be safe.
  const handleLLMDl = () => {
      if(!state.generatedLLM) return;
      const blob = new Blob([JSON.stringify(state.generatedLLM, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "generated_llm_plan.json"; a.click();
  };
  bindClick("downloadLLMBtn", handleLLMDl);
  bindClick("downloadGeneratedLlmBtn", handleLLMDl);

  // 6. UI Toggles
  bindClick("applyWeeksBtn", () => setWeeksCount(el("weeksCountInput").value));
  
  const intIn = el("interactiveInput");
  if(intIn) intIn.addEventListener("change", () => { updatePlanContentUIEnabled(); readPlanContentFromUI(); });
  
  ["slidesPerHourInput","timePerContentInput"].forEach(id => {
     const e = el(id); if(e) e.addEventListener("input", readPlanContentFromUI);
  });
  
  // Modal
  bindClick("closePreviewBtn", closePreview);
  const mod = el("previewModal");
  if (mod) mod.onclick = (e) => { if(e.target.id === "previewModal") closePreview(); };

  // Start
  await refreshProjectsList();
}

async function handlePdfUpload(file) {
  try {
    requireProject();
    const res = await uploadFileTo(apiUrl("/upload_pdf"), file);
    state.sources[res.source_id] = { filename: res.source_file, toc_tree: res.toc_tree, toc_entries_count: res.toc_entries_count };
    state.activeSourceId = res.source_id;
    renderAll();
  } catch (err) {
    console.error(err);
    alert("Upload failed: " + err.message);
  }
}

boot();