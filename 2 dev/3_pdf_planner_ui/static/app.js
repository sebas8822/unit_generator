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
  llm: { 
      host: "http://localhost:11434", 
      model: "qwen3:8b", 
      provider: "ollama", 
      apiKey: "" 
  },
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

function renderGeneratedPlanPreview() {
  const wrap = el("generatedPlanWrap");
  const hint = el("generatedPlanHint");
  const dlBtn = el("downloadGeneratedLlmBtn");

  if (!wrap) return;

  // Toggle buttons (Base / LLM)
  const mode = state.generatedView || "base";
  const baseBtn = el("generatedViewBaseBtn");
  const llmBtn = el("generatedViewLlmBtn");
  if (baseBtn) baseBtn.classList.toggle("primary", mode !== "llm");
  if (llmBtn) llmBtn.classList.toggle("primary", mode === "llm");

  // Enable download button only when we have an LLM plan
  if (dlBtn) dlBtn.disabled = !state.generatedLLM;

  const wkKey = String(state.selectedWeek);
  const wkBase = state.generated?.weeks?.[wkKey] || null;
  const wkLLM  = state.generatedLLM?.weeks?.[wkKey] || null;

  // Nothing to show
  if (!wkBase && !wkLLM) {
    wrap.innerHTML = "";
    if (hint) hint.style.display = "block";
    return;
  }
  if (hint) hint.style.display = "none";

  // Choose what to display (fallback if selected mode isn't available)
  const wk = (mode === "llm") ? (wkLLM || wkBase) : (wkBase || wkLLM);
  const activeLabel =
    (mode === "llm")
      ? (wkLLM ? "LLM" : "Base (fallback)")
      : (wkBase ? "Base" : "LLM (fallback)");

  const num = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  };

  const slidesFromBreakdown = (deck) => {
    const t = deck?.slide_count_breakdown?.total_slides;
    if (t !== undefined && t !== null) return num(t);
    return 0;
  };

  const countNodeContentSlides = (node) => {
    // LLM generation writes node.slides = [{ seq_id, llm_generated_content }]
    if (Array.isArray(node?.slides) && node.slides.length) return node.slides.length;
    // Base generation uses direct_slides_content
    return num(node?.direct_slides_content || 0);
  };

  const countNodeInteractiveSlides = (node) => {
    if (!node?.interactive_activity) return 0;
    // Some plans store slide_count in the interactive object
    return num(node.interactive_activity.slide_count || 0);
  };

  const countNodeTotalSlides = (node) => {
    let total = countNodeContentSlides(node) + countNodeInteractiveSlides(node);
    const kids = Array.isArray(node?.children) ? node.children : [];
    for (const ch of kids) total += countNodeTotalSlides(ch);
    return total;
  };

  const makeBtn = (label, onClick) => {
    const b = document.createElement("button");
    b.className = "btn smallBtn";
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  const makeRow = () => {
    const row = document.createElement("div");
    row.className = "row";
    row.style.justifyContent = "space-between";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    return row;
  };

  const renderSlideList = (node, depth) => {
    if (!Array.isArray(node?.slides) || !node.slides.length) return null;

    const det = document.createElement("details");
    det.style.marginTop = "6px";

    const sum = document.createElement("summary");
    sum.style.cursor = "pointer";
    sum.textContent = `Slides (${node.slides.length})`;
    det.appendChild(sum);

    const body = document.createElement("div");
    body.style.marginTop = "6px";
    body.style.marginLeft = `${depth * 14}px`;

    node.slides.forEach((s, idx) => {
      const row = makeRow();

      const left = document.createElement("div");
      left.style.flex = "1";
      const slideJson = s?.llm_generated_content || s || {};
      const subtitle = slideJson?.subtitle || slideJson?.title || `Slide ${idx + 1}`;
      left.innerHTML = `<span>${escapeHtml(String(subtitle))}</span> <span class="muted small">(${idx + 1}/${node.slides.length})</span>`;
      row.appendChild(left);

      const right = document.createElement("div");
      right.className = "row";
      right.appendChild(
        makeBtn("View slide", () => openTextModal(`Week ${state.selectedWeek} • Slide ${idx + 1}`, JSON.stringify(slideJson, null, 2)))
      );
      row.appendChild(right);

      body.appendChild(row);
    });

    det.appendChild(body);
    return det;
  };

  const renderInteractive = (node, depth) => {
    if (!node?.interactive_activity) return null;

    const det = document.createElement("details");
    det.style.marginTop = "6px";

    const sum = document.createElement("summary");
    sum.style.cursor = "pointer";
    const sc = num(node.interactive_activity.slide_count || 0);
    const t = node.interactive_activity.activity_type || node.interactive_activity.type || "interactive";
    sum.textContent = `Interactive (${t}${sc ? ` • ${sc} slide(s)` : ""})`;
    det.appendChild(sum);

    const body = document.createElement("div");
    body.style.marginTop = "6px";
    body.style.marginLeft = `${depth * 14}px`;

    const row = makeRow();
    const left = document.createElement("div");
    left.style.flex = "1";
    left.className = "muted small";
    left.textContent = "Interactive activity config";
    row.appendChild(left);

    const right = document.createElement("div");
    right.className = "row";
    right.appendChild(makeBtn("View JSON", () => openTextModal(`Week ${state.selectedWeek} • Interactive`, JSON.stringify(node.interactive_activity, null, 2))));
    if (node.interactive_activity.llm_generated_content) {
      right.appendChild(makeBtn("View LLM", () => openTextModal(`Week ${state.selectedWeek} • Interactive (LLM)`, JSON.stringify(node.interactive_activity.llm_generated_content, null, 2))));
    }
    row.appendChild(right);

    body.appendChild(row);

    det.appendChild(body);
    return det;
  };

  const renderNode = (node, depth = 0) => {
    const det = document.createElement("details");
    det.open = depth < 1; // open top-level; collapse deeper levels by default
    det.style.marginTop = "6px";
    det.style.marginLeft = `${depth * 14}px`;

    const title = (node?.title || node?.topic || "Untitled").toString();
    const contentSlides = countNodeContentSlides(node);
    const interSlides = countNodeInteractiveSlides(node);
    const childCount = Array.isArray(node?.children) ? node.children.length : 0;
    const total = countNodeTotalSlides(node);

    const sum = document.createElement("summary");
    sum.style.cursor = "pointer";
    sum.innerHTML = `<b>${escapeHtml(title)}</b> <span class="muted small">(total ${total}${contentSlides ? ` • content ${contentSlides}` : ""}${interSlides ? ` • interactive ${interSlides}` : ""}${childCount ? ` • children ${childCount}` : ""})</span>`;
    det.appendChild(sum);

    const body = document.createElement("div");
    body.style.marginTop = "6px";

    // Buttons row
    const row = makeRow();
    const left = document.createElement("div");
    left.style.flex = "1";
    left.className = "muted small";
    if (node?.source_id && (node?.toc_id !== undefined && node?.toc_id !== null)) {
      left.textContent = `Source: ${node.source_id} • ToC ${node.toc_id}`;
    } else {
      left.textContent = " ";
    }
    row.appendChild(left);

    const right = document.createElement("div");
    right.className = "row";
    right.appendChild(makeBtn("View JSON", () => openTextModal(`Week ${state.selectedWeek} • Block`, JSON.stringify(node, null, 2))));

    if (node?.source_id && (node?.toc_id !== undefined && node?.toc_id !== null)) {
      right.appendChild(makeBtn("Source", async () => { await openPreview(String(node.source_id), String(node.toc_id)); }));
    }

    // LLM JSON exists at slide level and summary/interactive sections; show quick access if available
    if (Array.isArray(node?.slides) && node.slides.length) {
      right.appendChild(makeBtn("Slides JSON", () => openTextModal(`Week ${state.selectedWeek} • Slides array`, JSON.stringify(node.slides, null, 2))));
    }
    if (node?.interactive_activity?.llm_generated_content) {
      right.appendChild(makeBtn("Interactive LLM", () => openTextModal(`Week ${state.selectedWeek} • Interactive (LLM)`, JSON.stringify(node.interactive_activity.llm_generated_content, null, 2))));
    }

    row.appendChild(right);
    body.appendChild(row);

    // Slides (LLM)
    const slideDet = renderSlideList(node, depth + 1);
    if (slideDet) body.appendChild(slideDet);

    // Interactive (Base + LLM)
    const intDet = renderInteractive(node, depth + 1);
    if (intDet) body.appendChild(intDet);

    // Children
    const kids = Array.isArray(node?.children) ? node.children : [];
    if (kids.length) {
      const kidsWrap = document.createElement("div");
      kidsWrap.style.marginTop = "6px";
      kidsWrap.className = "muted small";
      kidsWrap.textContent = "Children:";
      body.appendChild(kidsWrap);

      kids.forEach(ch => body.appendChild(renderNode(ch, depth + 1)));
    }

    det.appendChild(body);
    return det;
  };

  // --- Render ---
  wrap.innerHTML = "";

  // Header
  const header = document.createElement("div");
  header.className = "muted small";
  header.style.marginBottom = "8px";

  const wkNum = wk?.week ?? state.selectedWeek;
  const topic = (wk?.overall_topic || "").toString().trim();
  header.innerHTML = `<b>Week ${escapeHtml(String(wkNum))}</b>${topic ? " • " + escapeHtml(topic) : ""} <span class="pill" style="margin-left:6px;">${escapeHtml(activeLabel)}</span>`;
  wrap.appendChild(header);

  // Mode availability note
  const note = document.createElement("div");
  note.className = "muted small";
  note.style.marginBottom = "10px";
  if (mode === "llm" && !wkLLM && wkBase) {
    note.innerHTML = `LLM content is not available for this week yet — showing Base output.`;
  } else if (mode !== "llm" && !wkBase && wkLLM) {
    note.innerHTML = `Base output is not available for this week — showing LLM output.`;
  } else {
    note.textContent = "";
  }
  if (note.textContent || note.innerHTML) wrap.appendChild(note);

  const topRow = makeRow();
  const leftMeta = document.createElement("div");
  leftMeta.style.flex = "1";
  const decks = Array.isArray(wk?.deck_plans) ? wk.deck_plans : [];
  const totalSlides = decks.reduce((s, d) => s + (slidesFromBreakdown(d) || 0), 0);
  leftMeta.className = "muted small";
  leftMeta.textContent = `${decks.length} deck(s)${totalSlides ? ` • ~${totalSlides} slide(s)` : ""}`;
  topRow.appendChild(leftMeta);

  const rightMeta = document.createElement("div");
  rightMeta.className = "row";
  rightMeta.appendChild(makeBtn("View week JSON", () => openTextModal(`Week ${state.selectedWeek} • ${activeLabel} (JSON)`, JSON.stringify(wk, null, 2))));
  topRow.appendChild(rightMeta);

  wrap.appendChild(topRow);

  if (!decks.length) {
    const empty = document.createElement("div");
    empty.className = "muted small";
    empty.style.marginTop = "8px";
    empty.textContent = "No decks in this week.";
    wrap.appendChild(empty);
    return;
  }

  // Decks
  decks.forEach((deck) => {
    const deckDet = document.createElement("details");
    deckDet.open = true;
    deckDet.style.marginTop = "10px";

    const deckSum = document.createElement("summary");
    deckSum.style.cursor = "pointer";

    const dn = deck?.deck_number ?? "";
    const dt = (deck?.deck_title || deck?.title || "").toString().trim();
    const breakdown = deck?.slide_count_breakdown ? JSON.stringify(deck.slide_count_breakdown) : "";
    deckSum.innerHTML = `<b>Deck ${escapeHtml(String(dn))}</b>${dt ? " • " + escapeHtml(dt) : ""}${breakdown ? ` <span class="muted small">(${escapeHtml(breakdown)})</span>` : ""}`;
    deckDet.appendChild(deckSum);

    const deckBody = document.createElement("div");
    deckBody.style.marginTop = "8px";

    // Sections
    const sections = Array.isArray(deck?.sections) ? deck.sections : [];

    // Non-content sections (Framework, Summary, etc.)
    sections
      .filter(sec => sec?.section_type && sec.section_type !== "Content")
      .forEach(sec => {
        const row = makeRow();

        const left = document.createElement("div");
        left.style.flex = "1";
        const st = sec.section_type || "Section";
        const title = sec?.content?.title || "";
        left.innerHTML = `<span class="pill">${escapeHtml(String(st))}</span> <span class="muted small">${escapeHtml(String(title))}</span>`;
        row.appendChild(left);

        const right = document.createElement("div");
        right.className = "row";
        right.appendChild(makeBtn("View JSON", () => openTextModal(`Week ${state.selectedWeek} • ${st}`, JSON.stringify(sec, null, 2))));
        if (sec?.llm_generated_content) {
          right.appendChild(makeBtn("View LLM", () => openTextModal(`Week ${state.selectedWeek} • ${st} (LLM)`, JSON.stringify(sec.llm_generated_content, null, 2))));
        }
        row.appendChild(right);

        deckBody.appendChild(row);
      });

    // Content section(s)
    const contentSections = sections.filter(sec => sec?.section_type === "Content");
    contentSections.forEach((sec, idx) => {
      const secDet = document.createElement("details");
      secDet.open = true;
      secDet.style.marginTop = "8px";

      const secSum = document.createElement("summary");
      secSum.style.cursor = "pointer";

      const blocks = Array.isArray(sec?.content_blocks) ? sec.content_blocks : [];
      secSum.textContent = `Content (${blocks.length} block(s))`;
      secDet.appendChild(secSum);

      const secBody = document.createElement("div");
      secBody.style.marginTop = "8px";

      if (!blocks.length) {
        const empty = document.createElement("div");
        empty.className = "muted small";
        empty.textContent = "No content blocks.";
        secBody.appendChild(empty);
      } else {
        blocks.forEach(b => secBody.appendChild(renderNode(b, 0)));
      }

      secDet.appendChild(secBody);
      deckBody.appendChild(secDet);
    });

    deckDet.appendChild(deckBody);
    wrap.appendChild(deckDet);
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

function closePreview() { 
    const modal = el("previewModal"); 
    if (modal) modal.classList.add("hidden"); 
}
// --- LLM Logic ---
function fillLLMUI() {
  const host = el("ollamaHostInput");
  const model = el("ollamaModelInput");
  if (host) host.value = state.llm.host || "";
  if (model) model.value = state.llm.model || "";
}

function readLLMFromUI() {
  const provSel = el("llmProviderSelect");
  state.llm.provider = provSel ? provSel.value : "ollama";

  // Use the Host ID defined in index.html (llmHostInput), not ollamaHostInput
  const hostIn = el("llmHostInput");
  state.llm.host = (hostIn?.value || "").trim() || "http://localhost:11434";

  const apiKeyIn = el("llmApiKeyInput");
  state.llm.apiKey = (apiKeyIn?.value || "").trim();

  // Use the Dropdown ID (llmModelSelect), not ollamaModelInput
  const modSel = el("llmModelSelect");
  if (modSel && modSel.value) {
       state.llm.model = modSel.value;
  } else {
       // Only fallback if the select is totally empty or unselected
       state.llm.model = "qwen3:8b";
  }
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

async function handlePdfUpload(file) {
  try {
    requireProject();
    const res = await uploadFileTo(apiUrl("/upload_pdf"), file);
    state.sources[res.source_id] = {
      filename: res.source_file,
      toc_tree: res.toc_tree,
      toc_entries_count: res.toc_entries_count,
    };
    state.activeSourceId = res.source_id;
    renderAll();
  } catch (err) {
    console.error(err);
    alert("Upload failed: " + err.message);
  }
}

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

  // 4. Generate Base Plan
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
          
          calculateCost(); 
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

  // ---------------------------------------------------------
  // 5. LLM Controls
  // ---------------------------------------------------------
  
  function updateLLMFieldsUI() {
      const prov = el("llmProviderSelect").value;
      const hostRow = el("llmHostRow");
      const keyRow = el("llmApiKeyRow");
      const costDisplay = el("llmCostDisplay");

      if(costDisplay) costDisplay.style.display = "inline-block";

      if (prov === "google") {
          hostRow.style.display = "none";
          keyRow.style.display = "block";
      } else {
          hostRow.style.display = "block";
          keyRow.style.display = "none";
      }
      
      const sel = el("llmModelSelect");
      // Only reset the dropdown if we haven't loaded models yet
      if (!state.llmOk) {
          sel.innerHTML = `<option disabled selected>Click "Fetch Models" first...</option>`;
          el("llmGenerateBtn").disabled = true;
          el("llmGenerateAllBtn").disabled = true;
      }
  }

  async function calculateCost() {
      if(!state.generated) return;
      try {
          readLLMFromUI();
          const res = await apiPost(apiUrl("/llm_calculate_cost"), {
               generated_plan: state.generated,
               llm_provider: state.llm.provider,
               llm_model: state.llm.model,
               llm_api_key: state.llm.apiKey
          });
          
          if(res.ok && res.estimate) {
               const cost = res.estimate.cost_usd || 0;
               const slides = res.estimate.total_slides || 0;
               const tier = res.estimate.pricing_tier || "";
               const display = el("llmCostDisplay");
               
               if (state.llm.provider === "google") {
                    if (slides === 0) {
                        display.textContent = `Est: $${cost.toFixed(4)} (0 slides - Generate Plan First)`;
                        display.style.background = "#fee";
                        display.style.color = "#a00";
                    } else {
                        display.textContent = `Est: $${cost.toFixed(4)} (${slides} slides)`;
                        display.style.background = "#eef";
                        display.style.color = "#338";
                        display.title = `Tier: ${tier}\nClick to regenerate estimate`;
                    }
               } else {
                    display.textContent = `${slides} slides (Local)`;
                    display.style.background = "#efe";
                    display.style.color = "#252";
                    display.title = "Local generation costs $0.00";
               }
               
               if (res.estimate.breakdown && res.estimate.breakdown.length > 0) {
                   const lines = res.estimate.breakdown.map(b => {
                       const cStr = state.llm.provider === "google" ? `$${b.cost.toFixed(4)}` : "Local";
                       return `Week ${b.week}: ${cStr} (${b.slides} slides)`;
                   });
                   display.title += "\n\nBreakdown per week:\n" + lines.join("\n");
               }
          }
      } catch(e) { console.warn("Stats calc error:", e); }
  }

  const provSel = el("llmProviderSelect");
  if(provSel) provSel.onchange = updateLLMFieldsUI;
  updateLLMFieldsUI();

  const hostIn = el("llmHostInput"); if(hostIn) hostIn.addEventListener("input", () => state.llm.host = hostIn.value);
  const keyIn = el("llmApiKeyInput"); if(keyIn) keyIn.addEventListener("input", () => state.llm.apiKey = keyIn.value);
  
  const modSel = el("llmModelSelect");
  if(modSel) modSel.onchange = () => {
      state.llm.model = modSel.value;
      calculateCost();
  };

  updateViewToggles();

  bindClick("llmCheckBtn", async () => {
      try {
          requireProject();
          state.llm.provider = el("llmProviderSelect").value;
          state.llm.host = el("llmHostInput").value;
          state.llm.apiKey = el("llmApiKeyInput").value;

          const stat = el("llmStatus");
          if(stat) stat.textContent = "Fetching models...";
          
          const q = `host=${encodeURIComponent(state.llm.host)}` +
                    `&provider=${encodeURIComponent(state.llm.provider)}` +
                    `&api_key=${encodeURIComponent(state.llm.apiKey)}`;

          const res = await apiGet(apiUrl(`/llm_health?${q}`));
          
          if (res.ok) {
              if(stat) stat.textContent = "✔ Models Loaded";
              state.llmOk = true;
              
              const sel = el("llmModelSelect");
              sel.innerHTML = "";
              (res.models || []).forEach(m => {
                  const opt = document.createElement("option");
                  opt.value = m;
                  opt.textContent = m;
                  sel.appendChild(opt);
              });
              
              if (res.models && res.models.length > 0) {
                  // If current state model is in list, keep it, else pick first
                  if (state.llm.model && res.models.includes(state.llm.model)) {
                      sel.value = state.llm.model;
                  } else {
                      sel.value = res.models[0];
                      state.llm.model = res.models[0];
                  }
              }

              el("llmGenerateBtn").disabled = false;
              el("llmGenerateAllBtn").disabled = false;
              
              calculateCost();

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
          if (!state.generated) { alert("Generate base plan first"); return; }
          const stat = el("llmStatus");
          if(stat) stat.textContent = `Generating Week ${state.selectedWeek}...`;
          
          const res = await apiPost(apiUrl("/llm_generate_week"), {
              week_number: state.selectedWeek,
              generated_plan: state.generated,
              ollama_host: state.llm.host,
              ollama_model: state.llm.model,
              llm_provider: state.llm.provider,
              llm_api_key: state.llm.apiKey
          });
          
          state.generatedLLM = res.plan;
          if(stat) stat.textContent = "Week Generated ✔";
          updateViewToggles();
          el("downloadLLMBtn").disabled = false;
          state.generatedView = "llm";
          renderGeneratedPlanPreview();
      } catch(e) { 
          const stat = el("llmStatus"); if(stat) stat.textContent = e.message; 
      }
  });

  bindClick("llmGenerateAllBtn", async () => {
      if(!confirm("Generate content for ALL weeks? This may take time (and cost money if using Google).")) return;
      try {
          requireProject();
          readLLMFromUI();
          if (!state.generated) { alert("Generate base plan first"); return; }
          const stat = el("llmStatus");
          if(stat) stat.textContent = `Batch generating ALL weeks... please wait...`;
          
          const res = await apiPost(apiUrl("/llm_generate_all"), {
              generated_plan: state.generated,
              ollama_host: state.llm.host,
              ollama_model: state.llm.model,
              llm_provider: state.llm.provider,
              llm_api_key: state.llm.apiKey
          });
          
          state.generatedLLM = res.plan;
          if(stat) stat.textContent = "Batch Generation Complete ✔";
          updateViewToggles();
          el("downloadLLMBtn").disabled = false;
          state.generatedView = "llm";
          renderGeneratedPlanPreview(); 
      } catch(e) { 
          const stat = el("llmStatus"); if(stat) stat.textContent = e.message; 
      }
  });

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
  
  // --- FIXED: Modal Closing Logic (Direct .onclick) ---
  const closeBtn = el("closePreviewBtn");
  if (closeBtn) {
      closeBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          console.log("Close button clicked"); // Debugging
          closePreview();
      };
  }
  
  // Backdrop click
  const mod = el("previewModal");
  if (mod) {
      mod.onclick = (e) => { 
          if(e.target.id === "previewModal") closePreview(); 
      };
  }

  // Start
  await refreshProjectsList();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => { boot(); });
} else {
  boot();
}
