// app.js (Repaired: Persistent State & Step 6 Linkage)

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
  tocSearch: "",
  tocAssignedOnly: false,
  tocAutoOnly: false,
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
      model: "", 
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
// LocalStorage Persistence (New Feature)
// ---------------------------------------------------------------------------
function saveLLMState() {
    try {
        const data = {
            provider: state.llm.provider,
            host: state.llm.host,
            apiKey: state.llm.apiKey,
            model: state.llm.model // Try to remember model too
        };
        localStorage.setItem("pdf_week_planner_llm", JSON.stringify(data));
    } catch(e) { console.warn("Could not save LLM state", e); }
}

function loadLLMState() {
    try {
        const raw = localStorage.getItem("pdf_week_planner_llm");
        if (!raw) return;
        const data = JSON.parse(raw);
        
        if (data.provider) state.llm.provider = data.provider;
        if (data.host) state.llm.host = data.host;
        if (data.apiKey) state.llm.apiKey = data.apiKey;
        // We restore model tentatively; validation happens when we fetch models
        if (data.model) state.llm.model = data.model; 

        // Update UI inputs to match restored state
        const provSel = el("llmProviderSelect");
        if(provSel) provSel.value = state.llm.provider;
        
        const hostIn = el("llmHostInput");
        if(hostIn) hostIn.value = state.llm.host;
        
        const keyIn = el("llmApiKeyInput");
        if(keyIn) keyIn.value = state.llm.apiKey;
        
        updateLLMFieldsUI();
    } catch(e) { console.warn("Could not load LLM state", e); }
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
    
    // CASE 1: No projects exist
    if (projects.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No projects";
      sel.appendChild(opt);
      sel.disabled = true;
      
      // FIX: Wipe the UI clean so old data doesn't persist
      clearProjectUI();
      return;
    }

    // CASE 2: Projects exist
    sel.disabled = false;
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.course_id;
      opt.textContent = p.unit_name ? `${p.course_id} — ${p.unit_name}` : p.course_id;
      sel.appendChild(opt);
    }

    // Determine which project to load
    // If the deleted project ID was passed (or null), pick the first available one.
    // If a specific ID is requested (e.g. newly created), pick that.
    let chosen = selectCourseId;
    
    // If chosen is invalid or not in list, fallback to first
    if (!chosen || !projects.find(p => p.course_id === chosen)) {
        chosen = projects[0].course_id;
    }

    sel.value = chosen;
    console.log("Auto-loading project:", chosen);
    await loadProject(chosen);
    
  } catch (e) {
    console.warn("Could not load projects:", e);
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
    
    // --- FIX START: Normalize Sources on Load ---
    // This ensures that if we have 'augmented_tree' (deep structure) saved on the server,
    // we use it instead of the basic 'toc_tree' when the page refreshes.
    const rawSources = boot.sources || {};
    for (const srcId in rawSources) {
        const src = rawSources[srcId];
        if (src.augmented_tree && src.augmented_tree.length > 0) {
            src.toc_tree = src.augmented_tree;
            src.toc_entries_count = src.augmented_entries_count || src.toc_entries_count;
        }
    }
    state.sources = rawSources;
    // --- FIX END ---

    state.activeSourceId = Object.keys(state.sources)[0] || null;

    if (state.plan?.meta?.plan_content) {
      const pc = state.plan.meta.plan_content;
      state.planContent = { ...state.planContent, ...pc };
    }

    state.generated = boot.generated_plan || null;
    state.generatedLLM = boot.generated_llm_plan || null;

    state.generatedView = state.generatedLLM ? "llm" : "base";

    const planWeeks = state.plan?.meta?.weeks_count;
    const outlineWeeks = Array.isArray(state.outline?.weeklySchedule) ? state.outline.weeklySchedule.length : 0;
    const initialWeeks = planWeeks ?? (outlineWeeks > 0 ? outlineWeeks : 12);
    
    setWeeksCount(initialWeeks);
    fillPlanContentUI();
    
    updateViewToggles();
    renderAll();
    
    renderSlideGenerationCard();

    const dlLlmBtn = el("downloadLLMBtn");
    if (dlLlmBtn) dlLlmBtn.disabled = !state.generatedLLM;

  } catch (e) {
    console.error("Load failed:", e);
    alert("Failed to load project: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Logic & Helpers (Generic)
// ---------------------------------------------------------------------------

function tocKey(sourceId, tocId) { return `${sourceId}::${String(tocId)}`; }

function clearProjectUI() {
    // Reset all data states
    state.project = { course_id: null, unit_name: "" };
    state.outline = { weeklySchedule: [] };
    state.sources = {};
    state.activeSourceId = null;
    state.plan = { meta: { weeks_count: 12 }, weeks: {} };
    state.generated = null;
    state.generatedLLM = null;
    
    // Clear UI Elements
    setProjectLabel();
    setWeeksCount(12);
    
    // Clear specific inputs
    if(el("projectSelect")) el("projectSelect").value = "";
    
    // Render empty states
    renderAll();
    renderSlideGenerationCard();
    
    // Disable action buttons
    if(el("downloadGeneratedBtn")) el("downloadGeneratedBtn").disabled = true;
    if(el("downloadLLMBtn")) el("downloadLLMBtn").disabled = true;
    if(el("openSlidesFolderBtn")) el("openSlidesFolderBtn").disabled = true;
}

function walkTocNodes(nodes, visit, depth = 0, path = []) {
  (nodes || []).forEach((n) => {
    const title = (n && n.title) ? String(n.title) : "(untitled)";
    const myPath = (Array.isArray(n.titles_path) && n.titles_path.length) ? n.titles_path : [...path, title];
    visit(n, depth, myPath);
    if (Array.isArray(n.children) && n.children.length) {
      walkTocNodes(n.children, visit, depth + 1, myPath);
    }
  });
}

function setTocCollapsedForActiveSource({ depthOpen = 2, expandAll = false, collapseAll = false } = {}) {
  if (!state.activeSourceId) return;
  const src = state.sources?.[state.activeSourceId];
  if (!src || !Array.isArray(src.toc_tree)) return;

  walkTocNodes(src.toc_tree, (n, depth) => {
    const hasKids = Array.isArray(n.children) && n.children.length;
    if (!hasKids) return;
    const key = tocKey(state.activeSourceId, n.toc_id);
    if (expandAll) state.tocCollapsed[key] = false;
    else if (collapseAll) state.tocCollapsed[key] = true;
    else state.tocCollapsed[key] = depth >= depthOpen;
  });
}

function clampInt(n, minV, maxV) { const x = parseInt(n, 10); return isNaN(x) ? minV : Math.max(minV, Math.min(maxV, x)); }
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
  if (deep) { deep.disabled = !on; if (!on) deep.checked = false; }
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
function flattenSubtree(node) {
  const out = [];
  (function walk(n) { if (!n) return; out.push(n); if (Array.isArray(n.children)) { for (const ch of n.children) walk(ch); } })(node);
  return out;
}
function assignSubtreeToWeek(sourceId, node, weekStr, { includeParent = true } = {}) {
  const nodes = flattenSubtree(node);
  const picked = includeParent ? nodes : nodes.slice(1);
  if (!picked.length) return;
  const ids = new Set(picked.map(n => n.toc_id));
  for (const w of Object.values(state.plan.weeks)) { w.items = (w.items || []).filter(it => !(it.source_id === sourceId && ids.has(it.toc_id))); }
  if (!state.plan.weeks[weekStr]) state.plan.weeks[weekStr] = { topic: "", items: [] };
  const dest = state.plan.weeks[weekStr];
  for (const n of picked) { dest.items.push({ source_id: sourceId, toc_id: n.toc_id, title: n.title, titles_path: n.titles_path || [n.title] }); }
}
function unassignNode(sourceId, tocId) {
  for (const w of Object.values(state.plan.weeks)) { w.items = w.items.filter(x => !(x.source_id === sourceId && x.toc_id === tocId)); }
}
function subtreeCount(node) { return flattenSubtree(node).length; }
function assignNodeToWeek(sourceId, node, weekStr) {
  for (const w of Object.values(state.plan.weeks)) { w.items = w.items.filter(x => !(x.source_id === sourceId && x.toc_id === node.toc_id)); }
  state.plan.weeks[weekStr].items.push({ source_id: sourceId, toc_id: node.toc_id, title: node.title, titles_path: node.titles_path || [node.title] });
}
function findAssignedWeek(sourceId, tocId) {
  for (const [wk, wobj] of Object.entries(state.plan.weeks)) { if (wobj.items.find(x => x.source_id === sourceId && x.toc_id === tocId)) return wk; }
  return null;
}
function setActiveSource(sourceId) { state.activeSourceId = sourceId; renderAll(); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c])); }


// Add this helper function in app.js (e.g., inside Logic & Helpers section)

function updateSlideEstimation() {
    // 1. Gather Inputs
    const weeks = parseInt(state.weeksCount || 12, 10);
    const sessionsPerWeek = parseInt(el("sessionsPerWeekInput")?.value || 1, 10);
    const hoursPerSession = parseFloat(el("sessionHoursInput")?.value || 2.0);
    
    // Time Allocations (Minutes)
    const timeContent = parseInt(el("timePerContentInput")?.value || 3, 10);
    const timeFramework = parseInt(el("timeFrameworkInput")?.value || 6, 10);
    
    // Hardcoded in backend: Title, Agenda, Summary, End = 4 slides
    const FRAMEWORK_SLIDES_COUNT = 4; 

    // 2. Calculate per Session
    const sessionTotalMin = hoursPerSession * 60;
    
    // Available time for main content (subtracting framework time like Agenda/Summary)
    const availableForContentMin = Math.max(0, sessionTotalMin - timeFramework);
    
    // Capacity for content slides
    const contentCapacity = Math.floor(availableForContentMin / Math.max(1, timeContent));
    
    // Total slides per session (Framework + Content Capacity)
    // Note: If interactive slides are used, they usually consume MORE time than content,
    // so this number represents the "Max Capacity" (Upper Bound).
    const totalSlidesPerSession = FRAMEWORK_SLIDES_COUNT + contentCapacity;

    // 3. Totals
    const totalSessions = weeks * sessionsPerWeek;
    const grandTotalSlides = totalSessions * totalSlidesPerSession;
    const totalHours = totalSessions * hoursPerSession;

    // 4. Update UI
    const elTotal = el("estTotalSlides");
    const elSess = el("estSessionSlides");
    const elHours = el("estTotalHours");

    if (elTotal) elTotal.textContent = `~${grandTotalSlides.toLocaleString()} slides`;
    if (elSess) elSess.textContent = `${totalSlidesPerSession} (4 Fixed + ${contentCapacity} Content)`;
    if (elHours) elHours.textContent = `${totalHours}h (${totalSessions} sessions)`;
}


// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderAll() {
  renderPdfList();
  renderToc();
  renderWeekSummary();
  renderGeneratedPlanPreview();
  renderSlideGenerationCard(); // Link Step 6
}





function renderPdfList() {
  const list = document.getElementById("pdfList");
  if (!list) return;
  list.innerHTML = "";
  
  const entries = Object.entries(state.sources);
  if (entries.length === 0) { 
      list.innerHTML = `<div class="muted small">No documents uploaded yet.</div>`; 
      return; 
  }
  
  for (const [sourceId, src] of entries) {
    const item = document.createElement("div");
    item.className = "listItem";
    
    // Layout
    item.style.display = "flex";
    item.style.flexDirection = "column";
    item.style.gap = "8px";
    item.style.padding = "12px";
    
    // Label logic
    let labelClass = "publication";
    let labelText = "PUB";
    const kind = (src.doc_kind || "").toLowerCase();
    if (kind.includes("text_file")) {
        labelClass = "note";
        labelText = "NOTE";
    } else if (kind.includes("book")) {
        labelClass = "book";
        labelText = "BOOK";
    }
    
    // Title Row (Max 3 lines)
    const titleText = document.createElement("div");
    titleText.textContent = src.filename;
    titleText.style.fontWeight = "700";
    titleText.style.fontSize = "14px";
    titleText.style.lineHeight = "1.4";
    titleText.style.wordBreak = "break-word";
    titleText.title = src.filename;
    
    // --- CHANGED: Limit to 2 lines (cuts off if it overflows to the 3rd) ---
    titleText.style.display = "-webkit-box";
    titleText.style.webkitLineClamp = "2"; // <--- Set to 2
    titleText.style.webkitBoxOrient = "vertical";
    titleText.style.overflow = "hidden";
    
    // Bottom Row: Info + Actions
    const bottomRow = document.createElement("div");
    bottomRow.style.display = "flex";
    bottomRow.style.justifyContent = "space-between";
    bottomRow.style.alignItems = "center";
    bottomRow.style.width = "100%";
    
    // Left: Metadata
    const metaText = document.createElement("div");
    metaText.className = "muted small";
    metaText.textContent = `${src.toc_entries_count} nodes • ${sourceId.substring(0,6)}`;
    
    // Right: Actions
    const actionGroup = document.createElement("div");
    actionGroup.style.display = "flex";
    actionGroup.style.alignItems = "center";
    actionGroup.style.gap = "8px";
    
    const badge = document.createElement("span");
    badge.className = `docLabel ${labelClass}`;
    badge.style.marginLeft = "0";
    badge.textContent = labelText;
    
    const btn = document.createElement("button");
    btn.className = "btn small";
    if (state.activeSourceId === sourceId) {
        btn.classList.add("primary");
        btn.textContent = "Active";
    } else {
        btn.textContent = "Open";
    }
    btn.onclick = () => setActiveSource(sourceId);
    
    const delBtn = document.createElement("button");
    delBtn.className = "btnIcon";
    delBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
    delBtn.title = "Delete permanently";
    delBtn.onclick = async (e) => {
        e.stopPropagation(); 
        if(!confirm(`Permanently delete "${src.filename}"?`)) return;
        try {
            await apiDeleteSource(sourceId);
            delete state.sources[sourceId];
            if (state.activeSourceId === sourceId) {
                state.activeSourceId = Object.keys(state.sources)[0] || null;
            }
            renderAll();
        } catch(err) {
            alert("Delete failed: " + err.message);
        }
    };

    actionGroup.appendChild(badge);
    actionGroup.appendChild(btn);
    actionGroup.appendChild(delBtn);
    
    bottomRow.appendChild(metaText);
    bottomRow.appendChild(actionGroup);

    item.appendChild(titleText);
    item.appendChild(bottomRow);
    
    list.appendChild(item);
  }
}

// Helper for API Call
async function apiDeleteSource(sourceId) {
    requireProject();
    const r = await fetch(`/api/project/${encodeURIComponent(state.project.course_id)}/source/${sourceId}`, {
        method: "DELETE"
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
}

function renderToc() {
  const meta = el("tocMeta");
  const container = el("tocTree");
  if (!container) return;
  container.innerHTML = "";

  // Sync ToC controls (if present)
  const searchIn = el("tocSearchInput");
  if (searchIn && searchIn.value !== (state.tocSearch || "")) searchIn.value = state.tocSearch || "";
  const assignedChk = el("tocAssignedOnlyChk");
  if (assignedChk) assignedChk.checked = !!state.tocAssignedOnly;
  const autoChk = el("tocAutoOnlyChk");
  if (autoChk) autoChk.checked = !!state.tocAutoOnly;

  if (!state.activeSourceId) {
    if (meta) meta.textContent = "Upload a PDF and click Open to view its ToC.";
    return;
  }
  const src = state.sources[state.activeSourceId];
  if (!src) {
    if (meta) meta.textContent = "No active source.";
    return;
  }

  const query = (state.tocSearch || "").trim().toLowerCase();
  const filtersActive = !!query || !!state.tocAssignedOnly || !!state.tocAutoOnly;

  // Fast lookup: toc_id -> week
  const assignedWeekByTocId = new Map();
  for (const [wk, wobj] of Object.entries(state.plan?.weeks || {})) {
    for (const it of (wobj?.items || [])) {
      if (String(it.source_id) === String(state.activeSourceId)) {
        assignedWeekByTocId.set(String(it.toc_id), String(wk));
      }
    }
  }

  const isAuto = (n) => !!(n && (n.synthetic || (n.synthetic_source && String(n.synthetic_source).trim())));
  const nodeTitle = (n) => String(n?.title || "");
  const nodePath = (n) => Array.isArray(n?.titles_path) ? n.titles_path.join(" / ") : nodeTitle(n);

  const matchesQuery = (n) => {
    if (!query) return true;
    const t = nodeTitle(n).toLowerCase();
    const p = nodePath(n).toLowerCase();
    return t.includes(query) || p.includes(query);
  };

  const matchesFilters = (n) => {
    if (state.tocAssignedOnly && !assignedWeekByTocId.has(String(n.toc_id))) return false;
    if (state.tocAutoOnly && !isAuto(n)) return false;
    return true;
  };

  // Build a lightweight "visible tree" while keeping references to original nodes
  const buildVis = (nodes) => {
    const out = [];
    (nodes || []).forEach((n) => {
      const kids = buildVis(n.children || []);
      const keepSelf = matchesQuery(n) && matchesFilters(n);
      if (keepSelf || kids.length) out.push({ node: n, kids });
    });
    return out;
  };

  const vis = buildVis(src.toc_tree || []);

  const countVis = (arr) => arr.reduce((s, v) => s + 1 + countVis(v.kids), 0);
  const visibleCount = countVis(vis);
  const totalCount = (src.toc_entries_count ?? visibleCount);

  if (meta) {
    const parts = [];
    if (query) parts.push(`search="${(state.tocSearch || "").trim()}"`);
    if (state.tocAssignedOnly) parts.push("assigned");
    if (state.tocAutoOnly) parts.push("auto");
    const filt = parts.length ? ` • filters: ${parts.join(", ")}` : "";
    meta.textContent = `Viewing: ${src.filename} • showing: ${visibleCount}/${totalCount} nodes${filt}`;
  }

  const ensureTitlesPathRecursive = (n, parentPath = []) => {
    const title = (n && n.title) ? String(n.title) : "(untitled)";
    const myPath = (Array.isArray(n.titles_path) && n.titles_path.length) ? n.titles_path : [...parentPath, title];
    if (!Array.isArray(n.titles_path) || !n.titles_path.length) n.titles_path = myPath;
    if (Array.isArray(n.children) && n.children.length) {
      n.children.forEach((ch) => ensureTitlesPathRecursive(ch, myPath));
    }
  };

  const autoBadgeText = (n) => {
    if (!isAuto(n)) return "";
    const src = String(n.synthetic_source || "auto").toLowerCase();
    if (src.includes("style")) return "AUTO:STYLE";
    if (src.includes("numbered")) return "AUTO:NUM";
    return "AUTO";
  };

  const makeBtn = (label, cls, onClick) => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(e);
    };
    return b;
  };

  const renderNode = (v, depth = 0, parentPath = []) => {
    const node = v.node;
    const kidsVis = v.kids || [];

    // Ensure titles_path exists for better week-tree grouping
    ensureTitlesPathRecursive(node, parentPath);

    const wrap = document.createElement("div");
    wrap.className = "tocNode";

    const head = document.createElement("div");
    head.className = "tocHead";

    const left = document.createElement("div");
    const right = document.createElement("div");
    right.className = "row";

    const hasKidsVisible = kidsVis.length > 0;

    // Collapse rules:
    // - if user hasn't toggled this node yet, open first 2 levels by default
    // - if filters/search are active, expand everything (to show matches)
    const key = tocKey(state.activeSourceId, node.toc_id);
    const storedState = state.tocCollapsed[key];
    let collapsed = (storedState === undefined) ? (depth >= 2) : storedState;
    if (filtersActive) collapsed = false;

    const titleRow = document.createElement("div");
    titleRow.className = "tocTitleRow";

    if (hasKidsVisible) {
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "tocToggleBtn";
      toggleBtn.textContent = collapsed ? "▶" : "▼";
      toggleBtn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        state.tocCollapsed[key] = !collapsed;
        renderToc();
      };
      titleRow.appendChild(toggleBtn);
    } else {
      const spacer = document.createElement("span");
      spacer.style.width = "28px";
      titleRow.appendChild(spacer);
    }

    const titleDiv = document.createElement("div");
    titleDiv.className = "tocTitle";
    titleDiv.textContent = nodeTitle(node) || "(untitled)";
    titleRow.appendChild(titleDiv);

    // Synthetic badge
    const badgeText = autoBadgeText(node);
    if (badgeText) {
      const b = document.createElement("span");
      b.className = "badge";
      b.style.marginLeft = "8px";
      b.textContent = badgeText;
      titleRow.appendChild(b);
    }

    left.appendChild(titleRow);

    const metaDiv = document.createElement("div");
    metaDiv.className = "tocMeta";
    const subtreeStr = (Array.isArray(node.children) && node.children.length) ? ` • Subtree: ${subtreeCount(node)} nodes` : "";
    const lvlStr = (node.level !== undefined && node.level !== null) ? ` • L${node.level}` : "";
    metaDiv.textContent = `ID: ${node.toc_id ?? "-"} • Page: ${node.page_1based ?? "-"}${lvlStr}${subtreeStr}`;
    left.appendChild(metaDiv);

    // Assigned badge
    const assignedWeek = assignedWeekByTocId.get(String(node.toc_id)) || null;
    if (assignedWeek) {
      const tag = document.createElement("div");
      tag.className = "tagWeek";
      tag.textContent = `Week ${assignedWeek}`;
      const hue = (parseInt(assignedWeek) * 45) % 360;
      tag.style.setProperty("--hue", hue);
      right.appendChild(tag);
    }

    // Quick view (helps with many subheadings)
    right.appendChild(
      makeBtn("View", "btn", () => openPreview(state.activeSourceId, String(node.toc_id)))
    );

    // Assign buttons
    right.appendChild(
      makeBtn("Assign", "btn primary", (ev) => {
        const wk = String(state.selectedWeek);
        ensureTitlesPathRecursive(node, parentPath);
        const hasKids = Array.isArray(node.children) && node.children.length;
        if (ev && ev.shiftKey && hasKids) assignSubtreeToWeek(state.activeSourceId, node, wk);
        else assignNodeToWeek(state.activeSourceId, node, wk);
        renderAll();
      })
    );
    if (Array.isArray(node.children) && node.children.length) {
      right.appendChild(
        makeBtn("Assign+", "btn", () => {
          const wk = String(state.selectedWeek);
          ensureTitlesPathRecursive(node, parentPath);
          assignSubtreeToWeek(state.activeSourceId, node, wk);
          renderAll();
        })
      );
    }

    // Unassign
    right.appendChild(
      makeBtn("X", "btn", () => {
        unassignNode(state.activeSourceId, node.toc_id);
        renderAll();
      })
    );

    head.appendChild(left);
    head.appendChild(right);
    wrap.appendChild(head);

    if (hasKidsVisible && !collapsed) {
      const kidsWrap = document.createElement("div");
      kidsWrap.className = "tocChildren";
      kidsVis.forEach((ch) => kidsWrap.appendChild(renderNode(ch, depth + 1, node.titles_path || [...parentPath, nodeTitle(node)])));
      wrap.appendChild(kidsWrap);
    }

    return wrap;
  };

  if (!vis.length) {
    container.innerHTML = `<div class="muted small">No ToC nodes match the current filters.</div>`;
    return;
  }

  vis.forEach((v) => container.appendChild(renderNode(v, 0, [])));
}


// --- Week Summary (Tree) ---
function buildWeekTree(items) {
  // Initialize root with minOrderIndex
  const root = { label: "__root__", children: {}, selected: [], sourceId: null, minTocId: Infinity, count: 0, minOrderIndex: Infinity };
  
  // Use forEach to capture the index (idx) which represents assignation order
  (items || []).forEach((it, idx) => {
    const sourceId = it.source_id;
    const sourceLabel = (state.sources[sourceId]?.filename) || sourceId;
    const titles = (Array.isArray(it.titles_path) && it.titles_path.length) ? it.titles_path : [it.title || `ToC ${it.toc_id}`];
    const path = [sourceLabel, ...titles];
    
    let cur = root;
    for (let i = 0; i < path.length; i++) {
      const seg = (path[i] || "(untitled)");
      if (!cur.children[seg]) {
        // Initialize children with minOrderIndex: Infinity
        cur.children[seg] = { 
            label: seg, 
            children: {}, 
            selected: [], 
            sourceId: (i === 0) ? sourceId : cur.sourceId, 
            minTocId: Infinity, 
            count: 0,
            minOrderIndex: Infinity 
        };
      }
      cur = cur.children[seg];
      if (i === 0) cur.sourceId = sourceId;
    }
    // Store the item along with its original index so we can sort by it later
    cur.selected.push({ ...it, _orderIdx: idx });
  });
  
  finalizeWeekTree(root);
  return root;
}

function finalizeWeekTree(node) {
  let count = (node.selected || []).length;
  let minT = Infinity;
  let minO = Infinity; // Track the minimum order index for this node

  // 1. Check direct items assigned to this node
  for (const sel of (node.selected || [])) {
    const t = Number.parseInt(sel.toc_id, 10);
    if (!Number.isNaN(t)) minT = Math.min(minT, t);
    
    // Capture the order index we saved in buildWeekTree
    if (sel._orderIdx !== undefined) minO = Math.min(minO, sel._orderIdx);
  }

  // 2. Aggregate from children
  for (const ch of Object.values(node.children || {})) {
    finalizeWeekTree(ch);
    count += ch.count || 0;
    minT = Math.min(minT, ch.minTocId ?? Infinity);
    minO = Math.min(minO, ch.minOrderIndex ?? Infinity);
  }

  node.count = count;
  node.minTocId = minT;
  node.minOrderIndex = minO; // Assign the calculated minimum index
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
    
    // Sort selected items by their assignation order (_orderIdx)
    const sortedSelected = (node.selected || []).sort((a, b) => (a._orderIdx - b._orderIdx));

    if (sortedSelected.length) {
       const actions = document.createElement("div");
       actions.className = "wkActions";
       
       // Just take the first one for the button actions to avoid clutter, 
       // or loop if you want buttons for every single item at this exact level.
       // Usually leaf nodes have 1 item.
       const sel = sortedSelected[0]; 
       
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
    
    // CHANGED: Sort children by minOrderIndex (assignation order) instead of minTocId/Label
    const children = Object.values(node.children).sort((a, b) => (a.minOrderIndex - b.minOrderIndex));
    
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
        
        // CHANGED: Sort sources by minOrderIndex (assignation order) instead of label
        const sources = Object.values(tree.children).sort((a, b) => a.minOrderIndex - b.minOrderIndex);
        
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
      onClick(e);
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
// Step 6: Slide generation card (Fixed Linkage)
// ---------------------------------------------------------------------------
function renderSlideGenerationCard() {
  const sourceLabel = el("slidesSourceLabel");
  const status = el("slidesStatus");
  const btnWeek = el("genSlidesWeekBtn");
  const btnAll = el("genSlidesAllBtn");
  const btnOpen = el("openSlidesFolderBtn"); 

  // STRICT REQUIREMENT: We only generate slides from the LLM Plan (Step 5)
  const hasLLMPlan = !!(state.generatedLLM && state.generatedLLM.weeks);
  const hasModel = !!state.llm.model;

  if (sourceLabel) {
      if (!hasModel) {
          sourceLabel.innerHTML = `<span style="color:#d00; font-weight:bold;">⚠️ Select Model in Step 5</span> <span class="muted small">(required for folder path)</span>`;
          if (btnWeek) btnWeek.disabled = true;
          if (btnAll) btnAll.disabled = true;
      } else {
          // Construct folder path based on model
          const prov = state.llm.provider || "ollama";
          const mod = state.llm.model;
          
          const folder = (prov + "__" + mod)
              .replace(/[\/\\]/g, "_")
              .replace(/[^A-Za-z0-9_.-]+/g, "_")
              .replace(/_+/g, "_")
              .replace(/^[._-]+|[._-]+$/g, "")
              .slice(0, 80) || "llm_output";

          sourceLabel.innerHTML = `Output Folder: <code>final_presentations/${folder}/</code>`;
          sourceLabel.style.color = "#338";
          
          // Only enable if we have the plan AND the model
          if (btnWeek) btnWeek.disabled = !hasLLMPlan;
          if (btnAll) btnAll.disabled = !hasLLMPlan;
      }
  }

  if (btnOpen) btnOpen.disabled = !state.project?.course_id;
  
  if (status) {
    if (!hasLLMPlan) {
        status.textContent = "Waiting for Step 5 (LLM Plan)...";
        status.style.color = "#888";
    } else if (!hasModel) {
        status.textContent = "Select a model above.";
        status.style.color = "#d00";
    } else {
        status.textContent = "Ready to generate slides.";
        status.style.color = "#008000";
    }
  }
}

// ---------------------------------------------------------------------------
// LLM Logic
// ---------------------------------------------------------------------------

function readLLMFromUI() {
  const provSel = el("llmProviderSelect");
  state.llm.provider = provSel ? provSel.value : "ollama";
  
  const hostIn = el("llmHostInput");
  state.llm.host = (hostIn?.value || "").trim() || "http://localhost:11434";
  
  const apiKeyIn = el("llmApiKeyInput");
  state.llm.apiKey = (apiKeyIn?.value || "").trim();

  const modSel = el("llmModelSelect");
  
  // FIX: Only update model from UI if the UI is actually populated with real models.
  // If the dropdown is empty or just has the "Fetch" placeholder, PRESERVE existing state.llm.model
  // instead of wiping it out.
  if (modSel && modSel.options.length > 0 && !modSel.selectedOptions[0]?.disabled) {
       state.llm.model = modSel.value;
  } 
  
  saveLLMState(); // Persist changes
}

function updateLLMFieldsUI() {
      const prov = el("llmProviderSelect")?.value;
      const hostRow = el("llmHostRow");
      const keyRow = el("llmApiKeyRow");
      const costDisplay = el("llmCostDisplay");

      if(costDisplay) costDisplay.style.display = "inline-block";

      if (prov === "google") {
          if(hostRow) hostRow.style.display = "none";
          if(keyRow) keyRow.style.display = "block";
      } else {
          if(hostRow) hostRow.style.display = "block";
          if(keyRow) keyRow.style.display = "none";
      }
      
      const sel = el("llmModelSelect");
      
      // FIX: If we have a stored model but the dropdown is empty (or just has the placeholder),
      // inject the stored model as a temporary option so Step 6 is satisfied.
      if (sel && state.llm.model && (sel.options.length === 0 || sel.options[0].disabled)) {
          sel.innerHTML = ""; // Remove "Fetch models" placeholder
          const opt = document.createElement("option");
          opt.value = state.llm.model;
          opt.textContent = state.llm.model;
          sel.appendChild(opt);
          sel.value = state.llm.model;
      } else if (!state.llmOk && (!state.llm.model || (sel && sel.options.length === 0))) {
          // Only show placeholder if we genuinely have no model state
          if (sel) sel.innerHTML = `<option disabled selected>Click "Fetch Models" first...</option>`;
      }

      // Update Button States
      const hasModel = !!state.llm.model;
      if(el("llmGenerateBtn")) el("llmGenerateBtn").disabled = !hasModel;
      if(el("llmGenerateAllBtn")) el("llmGenerateAllBtn").disabled = !hasModel;
  }

function handleProviderChange() {
    state.llmOk = false;
    state.llm.model = ""; // Clear model on provider switch
    updateLLMFieldsUI();
    
    // Reset dropdown
    const sel = el("llmModelSelect");
    if(sel) sel.innerHTML = `<option disabled selected>Click "Fetch Models" first...</option>`;
    
    readLLMFromUI();
    renderSlideGenerationCard(); // Update Step 6
}

function updateViewToggles() {
    bindClick("generatedViewBaseBtn", () => { state.generatedView = "base"; renderGeneratedPlanPreview(); renderSlideGenerationCard(); });
    bindClick("generatedViewLlmBtn", () => { state.generatedView = "llm"; renderGeneratedPlanPreview(); renderSlideGenerationCard(); });
    
    const base = el("generatedViewBaseBtn");
    const llm = el("generatedViewLlmBtn");
    if(base) base.classList.toggle("primary", state.generatedView !== "llm");
    if(llm) llm.classList.toggle("primary", state.generatedView === "llm");
}

// ---------------------------------------------------------------------------
// Slide Generation Logic (Backend Calls)
// ---------------------------------------------------------------------------

async function handleGenerateSlidesCurrentWeek() {
  try {
    requireProject();
    
    // Strict Validation
    if (!state.generatedLLM) { alert("You must complete Step 5 (Generate LLM Plan) first."); return; }
    if (!state.llm.model) { alert("Please select a Model in Step 5."); return; }

    const status = el("slidesStatus");
    if (status) status.textContent = "Generating slides (LLM Mode)...";

    const res = await apiPost(apiUrl("/slides_generate_week"), {
      week_number: state.selectedWeek,
      plan_mode: "llm", // FORCED MODE
      generated_plan: state.generatedLLM,
      llm_provider: state.llm.provider,
      llm_model: state.llm.model
    });

    if (status) status.textContent = `Done. Output: /${res.relative_output_dir}`;
  } catch (e) {
    alert("Slide generation failed: " + e.message);
    if(el("slidesStatus")) el("slidesStatus").textContent = "Error.";
  }
}

async function handleGenerateSlidesAllWeeks() {
  try {
    requireProject();

    // Strict Validation
    if (!state.generatedLLM) { alert("You must complete Step 5 (Generate LLM Plan) first."); return; }
    if (!state.llm.model) { alert("Please select a Model in Step 5."); return; }
    
    if(!confirm("Generate slides for ALL weeks using the LLM plan?")) return;

    const status = el("slidesStatus");
    if (status) status.textContent = "Generating slides for ALL weeks...";

    const res = await apiPost(apiUrl("/slides_generate_all"), {
      plan_mode: "llm", // FORCED MODE
      generated_plan: state.generatedLLM,
      llm_provider: state.llm.provider,
      llm_model: state.llm.model
    });

    if (status) status.textContent = `Done. Output: /${res.relative_output_dir}`;
  } catch (e) {
    alert("Slide generation failed: " + e.message);
    if(el("slidesStatus")) el("slidesStatus").textContent = "Error.";
  }
}

async function handleOpenSlidesFolder() {
  try {
    requireProject();
    // We infer folder from current model state
    const res = await apiPost(apiUrl("/open_presentation_folder"), {
        plan_mode: "llm",
        llm_provider: state.llm.provider,
        llm_model: state.llm.model
    });
    if (!res.ok) alert("Could not open folder: " + res.message);
  } catch (e) { alert("Failed to open folder: " + e.message); }
}

async function deleteCurrentProject() {
    if (!state.project.course_id) return;
    const cid = state.project.course_id;

    if (!confirm(`Permanently delete project "${cid}"?\n\nThis cannot be undone.`)) return;

    try {
        await fetch(`/api/project/${encodeURIComponent(cid)}`, { method: "DELETE" });
        alert(`Project "${cid}" deleted.`);
        
        state.project = { course_id: null, unit_name: "" };
        
        // This will now correctly pick the next project OR clear the screen if none left
        await refreshProjectsList(); 
        
    } catch (e) {
        alert("Delete failed: " + e.message);
    }
}

// ---------------------------------------------------------------------------
// Modals & Boot
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

// --- BOOT ---
async function handlePdfUpload(file) {
  const statusEl = document.getElementById("dropZoneStatus");
  
  try {
    requireProject();

    // 1. Show Spinner
    if (statusEl) statusEl.classList.remove("hidden");

    // 2. Perform Upload
    const res = await uploadFileTo(apiUrl("/upload_pdf"), file);
    
    // 3. Update State
    const useAugmented = (res.augmented_tree && res.augmented_tree.length > 0);
    state.sources[res.source_id] = { 
        filename: res.source_file, 
        toc_tree: useAugmented ? res.augmented_tree : res.toc_tree, 
        toc_entries_count: useAugmented ? res.augmented_entries_count : res.toc_entries_count 
    };
    
    state.activeSourceId = res.source_id;
    renderAll();

  } catch (err) { 
    alert("Upload failed: " + err.message); 
  } finally {
    // 4. Hide Spinner (runs on both success and error)
    if (statusEl) statusEl.classList.add("hidden");
  }
}

async function boot() {
  console.log("App booting...");
  
  // 1. Load LocalStorage State first
  loadLLMState();

  try { initWeeks(); } catch(e) {}
  try { setProjectLabel(); } catch(e) {}

  bindClick("newProjectBtn", createNewProject);
  const selProj = el("projectSelect");
  if (selProj) selProj.onchange = () => loadProject(selProj.value);

  const dz = el("dropZone");
  const fi = el("fileInput");
  if(dz && fi) {
      dz.onclick = () => fi.click();
      fi.onchange = async (e) => { const f = e.target.files[0]; if(f) await handlePdfUpload(f); fi.value = ""; };
      dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
      dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
      dz.addEventListener("drop", async (e) => { e.preventDefault(); dz.classList.remove("drag"); const f = e.dataTransfer.files?.[0]; if(f) await handlePdfUpload(f); });
  }

  const outIn = el("outlineInput");
  if(outIn) outIn.onchange = async (e) => {
      const f = e.target.files[0];
      if(f) {
          try { requireProject(); await uploadFileTo(apiUrl("/upload_outline"), f); state.outline = await apiGet(apiUrl("/outline")); setWeeksCount(state.outline.weeklySchedule?.length || 12); alert("Outline uploaded"); } catch(e) { alert(e.message); }
      }
      outIn.value = "";
  };

  bindClick("savePlanBtn", async () => { try { requireProject(); state.plan.meta.weeks_count = state.weeksCount; await apiPost(apiUrl("/plan"), state.plan); alert("Saved"); } catch(e) { alert(e.message); } });
  bindClick("loadPlanBtn", async () => { try { requireProject(); state.plan = await apiGet(apiUrl("/plan")); if (state.plan?.meta?.weeks_count) setWeeksCount(state.plan.meta.weeks_count); renderAll(); alert("Loaded"); } catch(e) { alert(e.message); } });

  // Toggle Right Panel Expansion
  bindClick("toggleViewBtn", () => {
      const main = document.querySelector(".layout");
      const btn = el("toggleViewBtn");
      
      // Toggle the CSS class
      main.classList.toggle("expand-right");
      
      // Update button text based on state
      if (main.classList.contains("expand-right")) {
          btn.textContent = "⤡ Reset";
          btn.classList.add("primary"); // Optional: highlight button when active
      } else {
          btn.textContent = "⤢ Expand";
          btn.classList.remove("primary");
      }
  });

  // Inside boot() function in app.js

// --- Paste Text Feature ---

// 1. Open Modal
bindClick("openPasteModalBtn", (e) => {
    e.stopPropagation(); // Prevent triggering the drop zone click
    const titleIn = document.getElementById("pasteTitleInput");
    const contentIn = document.getElementById("pasteContentInput");
    
    // Reset fields
    if(titleIn) titleIn.value = "";
    if(contentIn) contentIn.value = "";
    
    document.getElementById("pasteModal").classList.remove("hidden");
    if(titleIn) titleIn.focus();
});

// 2. Close Modal Handlers
function closePasteModal() {
    document.getElementById("pasteModal").classList.add("hidden");
}
bindClick("closePasteBtn", closePasteModal);
bindClick("cancelPasteBtn", closePasteModal);

// 3. Import Action
bindClick("importPasteBtn", async () => {
    const titleVal = document.getElementById("pasteTitleInput").value.trim() || "Untitled_Pasted_Text";
    const contentVal = document.getElementById("pasteContentInput").value;

    if (!contentVal) {
        alert("Please paste some content first.");
        return;
    }

    // Ensure filename ends in .txt (or .pdf if your backend requires it, though txt is safer for raw text)
    const filename = titleVal.endsWith(".txt") ? titleVal : titleVal + ".txt";

    // Create a File object from the text
    const blob = new Blob([contentVal], { type: "text/plain" });
    const file = new File([blob], filename, { type: "text/plain" });

    // Close modal immediately
    closePasteModal();

    // Reuse your existing upload handler!
    // Note: Your backend must be able to handle .txt files or perform conversion.
    await handlePdfUpload(file);
});

  bindClick("generatePlanBtn", async () => {
      try {
          requireProject();
          readPlanContentFromUI();
          const st = el("genStatus"); if(st) st.textContent = "Generating...";
          const res = await apiPost(apiUrl("/generate_plan"), { plan: state.plan, config: state.planContent });
          state.generated = res.plan;
          if(st) st.textContent = "Done";
          renderGeneratedPlanPreview();
          if(el("downloadGeneratedBtn")) el("downloadGeneratedBtn").disabled = false;
          calculateCost(); 
      } catch(e) { if(el("genStatus")) el("genStatus").textContent = e.message; }
  });
  
  bindClick("downloadGeneratedBtn", () => {
      if(!state.generated) return;
      const blob = new Blob([JSON.stringify(state.generated, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "generated_plan.json"; a.click();
  });

  // LLM Handlers
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
      // 1. Update State
      state.llm.model = modSel.value;
      
      // 2. Recalculate Cost (Step 5 UI)
      calculateCost();
      
      // 3. REFRESH STEP 6 CARD IMMEDIATELY
      renderSlideGenerationCard(); 
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

  bindClick("genSlidesWeekBtn", handleGenerateSlidesCurrentWeek);
  bindClick("genSlidesAllBtn", handleGenerateSlidesAllWeeks);
  bindClick("openSlidesFolderBtn", handleOpenSlidesFolder);

  // 6. UI Toggles
  bindClick("applyWeeksBtn", () => {
    setWeeksCount(el("weeksCountInput").value);
    updateSlideEstimation(); 
});
  
  const intIn = el("interactiveInput");
  if(intIn) intIn.addEventListener("change", () => { updatePlanContentUIEnabled(); readPlanContentFromUI(); });

  // Attach Calculator to ALL relevant inputs
  [
      "slidesPerHourInput", 
      "timePerContentInput", 
      "timePerInteractiveInput", 
      "timeFrameworkInput", 
      "sessionsPerWeekInput", 
      "sessionHoursInput",
      "weeksCountInput" // Ensure weeks input also triggers it
  ].forEach(id => {
      const e = el(id); 
      if(e) {
          e.addEventListener("input", () => {
              readPlanContentFromUI();
              updateSlideEstimation(); // <--- Add this
          });
      }
  });
  updateSlideEstimation();
  
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
  // 7. ToC controls (search + quick expand/collapse)
  const tocSearch = el("tocSearchInput");
  if (tocSearch) {
    tocSearch.addEventListener("input", () => {
      state.tocSearch = tocSearch.value || "";
      renderToc();
    });
  }
  bindClick("tocClearBtn", () => {
    state.tocSearch = "";
    const s = el("tocSearchInput");
    if (s) s.value = "";
    renderToc();
  });

  document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
          const modal = el("previewModal");
          if (modal && !modal.classList.contains("hidden")) {
              e.preventDefault();
              closePreview();
          }
      }
  });

  const assignedOnly = el("tocAssignedOnlyChk");
  if (assignedOnly) {
    assignedOnly.addEventListener("change", () => {
      state.tocAssignedOnly = !!assignedOnly.checked;
      renderToc();
    });
  }
  const autoOnly = el("tocAutoOnlyChk");
  if (autoOnly) {
    autoOnly.addEventListener("change", () => {
      state.tocAutoOnly = !!autoOnly.checked;
      renderToc();
    });
  }
  bindClick("tocExpand2Btn", () => { setTocCollapsedForActiveSource({ depthOpen: 2 }); renderToc(); });
  bindClick("tocExpandAllBtn", () => { setTocCollapsedForActiveSource({ expandAll: true }); renderToc(); });
  bindClick("tocCollapseAllBtn", () => { setTocCollapsedForActiveSource({ collapseAll: true }); renderToc(); });
  bindClick("deleteProjectBtn", deleteCurrentProject);


  // Start
  await refreshProjectsList();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => { boot(); });
} else {
  boot();
}
