// app.js (Fixed & Robust)

const state = {
  project: { course_id: null, unit_name: "" },

  outline: { weeklySchedule: [] },
  sources: {},
  activeSourceId: null,

  plan: { meta: { weeks_count: 12 }, weeks: {} },
  selectedWeek: 1,
  weeksCount: 12,

  // Default plan content settings
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

  generated: null,
  generatedLLM: null,
  ollama: { host: "http://localhost:11434", model: "qwen3:8b" }
};

// Safe element selector that warns if ID is missing
const el = (id) => {
  const element = document.getElementById(id);
  if (!element) console.warn(`Element with ID '${id}' not found.`);
  return element;
};

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

// --------------------
// Projects UI
// --------------------
function setProjectLabel() {
  const lblCourse = el("projectCourse");
  const lblUnit = el("projectUnit");
  if (lblCourse) lblCourse.textContent = state.project.course_id ? state.project.course_id : "No project selected";
  if (lblUnit) lblUnit.textContent = state.project.unit_name || "";
}

async function refreshProjectsList(selectCourseId = null) {
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
  await loadProject(chosen);
}

async function createNewProject() {
  const course_id = (prompt("course_id (e.g., ICT312):") || "").trim();
  if (!course_id) return;
  const unit_name = (prompt("unit_name (optional):") || "").trim();

  await apiPost("/api/projects", { course_id, unit_name });
  await refreshProjectsList(course_id);
}

async function loadProject(courseId) {
  if (!courseId) return;

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
  fillLLMUI();

  renderAll();
  renderGeneratedPlanPreview();
  renderGeneratedLLMPreview();
}

// --------------------
// Weeks / plan UI
// --------------------
function clampInt(n, minV, maxV) {
  const x = Number.parseInt(n, 10);
  if (Number.isNaN(x)) return minV;
  return Math.max(minV, Math.min(maxV, x));
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
  const chkInt = el("interactiveInput");
  const chkDeep = el("interactiveDeepInput");
  if (chkInt && chkDeep) {
      const on = chkInt.checked;
      chkDeep.disabled = !on;
      if (!on) chkDeep.checked = false;
  }
}

function readPlanContentFromUI() {
  const chkInt = el("interactiveInput");
  const chkDeep = el("interactiveDeepInput");
  
  state.planContent.interactive = chkInt ? !!chkInt.checked : true;
  state.planContent.interactive_deep = chkDeep ? !!chkDeep.checked : false;

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

// --------------------
// ToC assignment
// --------------------
function setActiveSource(sourceId) {
  state.activeSourceId = sourceId;
  renderAll();
}

function findAssignedWeek(sourceId, tocId) {
  for (const [wk, wobj] of Object.entries(state.plan.weeks)) {
    const hit = (wobj.items || []).find(x => x.source_id === sourceId && String(x.toc_id) === String(tocId));
    if (hit) return wk;
  }
  return null;
}

function assignNodeToWeek(sourceId, node, weekStr) {
  for (const w of Object.values(state.plan.weeks)) {
    w.items = (w.items || []).filter(x => !(x.source_id === sourceId && String(x.toc_id) === String(node.toc_id)));
  }
  state.plan.weeks[weekStr].items.push({
    source_id: sourceId,
    toc_id: node.toc_id,
    title: node.title,
    titles_path: node.titles_path || [node.title],
  });
}

function unassignNode(sourceId, tocId) {
  for (const w of Object.values(state.plan.weeks)) {
    w.items = (w.items || []).filter(x => !(x.source_id === sourceId && String(x.toc_id) === String(tocId)));
  }
}

// --------------------
// Rendering
// --------------------
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
function escapeAttr(s){ return escapeHtml(s).replace(/"/g, "&quot;"); }

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
    left.innerHTML = `<div><b>${escapeHtml(src.filename)}</b></div><div class="muted small">source_id: ${escapeHtml(sourceId)}</div>`;
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

  const renderNode = (node, depth = 0) => {
    const wrap = document.createElement("div");
    wrap.className = "tocNode";
    const head = document.createElement("div");
    head.className = "tocHead";
    const left = document.createElement("div");
    left.innerHTML = `
      <div class="tocTitle">${escapeHtml(node.title)}</div>
      <div class="tocMeta">ToC ID: ${escapeHtml(String(node.toc_id ?? "-"))} • Page: ${escapeHtml(String(node.page_1based ?? "-"))}</div>
    `;
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
    assignBtn.onclick = () => {
      const wk = String(state.selectedWeek);
      assignNodeToWeek(state.activeSourceId, node, wk);
      renderAll();
    };
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn";
    removeBtn.textContent = "Remove";
    removeBtn.onclick = () => {
      unassignNode(state.activeSourceId, node.toc_id);
      renderAll();
    };
    right.appendChild(assignBtn);
    right.appendChild(removeBtn);
    head.appendChild(left);
    head.appendChild(right);
    wrap.appendChild(head);
    if (node.children && node.children.length) {
      const kids = document.createElement("div");
      kids.className = "tocChildren";
      node.children.forEach(ch => kids.appendChild(renderNode(ch, depth + 1)));
      wrap.appendChild(kids);
    }
    return wrap;
  };
  src.toc_tree.forEach(n => container.appendChild(renderNode(n)));
}

function renderWeekTable() {
  const wrap = el("weekTableWrap");
  if (!wrap) return;

  const rows = [];
  for (let i = 1; i <= state.weeksCount; i++) {
    const wk = String(i);
    const wobj = state.plan.weeks[wk] || { topic: "", items: [] };
    const items = wobj.items || [];
    const pills = items.slice(0, 12).map(it => 
      `<span class="pill pillClick" data-source="${escapeAttr(it.source_id)}" data-toc="${escapeAttr(String(it.toc_id))}">${escapeHtml(it.title)}</span>`
    ).join("");
    const more = items.length > 12 ? `<div class="muted small">+${items.length - 12} more…</div>` : "";
    rows.push(`<tr><td style="width:90px;"><b>Week ${i}</b></td><td>${pills}${more}</td></tr>`);
  }
  wrap.innerHTML = `<table class="table"><thead><tr><th style="width:90px;">Week</th><th>Selected sections</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  document.querySelectorAll(".pillClick").forEach(p => {
    p.addEventListener("click", async (e) => {
      await openPreview(e.currentTarget.getAttribute("data-source"), e.currentTarget.getAttribute("data-toc"));
    });
  });
}

function openTextModal(title, text) {
  const modal = el("previewModal");
  const t = el("previewTitle");
  const b = el("previewBody");
  if (t) t.textContent = title || "Preview";
  if (b) b.textContent = text || "(No content available.)";
  if (modal) modal.classList.remove("hidden");
}

async function openPreview(sourceId, tocId) {
  const modal = el("previewModal");
  if (!modal) return;
  el("previewTitle").textContent = "Loading...";
  el("previewBody").textContent = "";
  modal.classList.remove("hidden");
  const data = await apiGet(apiUrl(`/section_text/${encodeURIComponent(sourceId)}/${encodeURIComponent(tocId)}?max_chars=20000`));
  el("previewTitle").textContent = data.title_path || data.title || `ToC ${tocId}`;
  el("previewBody").textContent = data.text || "(No extracted text found for this node.)";
}

function closePreview() {
  const modal = el("previewModal");
  if (modal) modal.classList.add("hidden");
}

function renderAll() {
  renderPdfList();
  renderToc();
  renderWeekTable();
}

// --------------------
// Generated plan previews
// --------------------
function renderGeneratedPlanPreview() {
  const wrap = el("generatedPreviewWrap");
  if (!wrap) return;
  
  if (!state.generated || !state.generated.weeks) {
    wrap.innerHTML = `<div class="muted small">No generated plan yet. Click “Generate plan”.</div>`;
    return;
  }
  const wkKey = String(state.selectedWeek);
  const wk = state.generated.weeks[wkKey];
  if (!wk) {
    wrap.innerHTML = `<div class="muted small">No generated content for Week ${state.selectedWeek}.</div>`;
    return;
  }
  const deckCards = (wk.deck_plans || []).map(deck => {
    const items = (deck.sections || []).flatMap(s => s.content_blocks || []).map(it => {
        const title = it.title || "Untitled";
        return `<div class="genItem pillClick" data-source="${escapeAttr(it.source_id)}" data-toc="${escapeAttr(String(it.toc_id))}">${escapeHtml(title)}</div>`;
    }).join("");
    return `
      <div class="genDeck">
        <div class="genDeckHead">
          <div><b>Deck ${deck.deck_number}</b></div>
          <div class="muted small">${escapeHtml(JSON.stringify(deck.slide_count_breakdown || {}))}</div>
        </div>
        <div class="genItems">${items || '<div class="muted small">No items</div>'}</div>
      </div>
    `;
  }).join("");
  wrap.innerHTML = `<div class="muted small" style="margin-bottom:8px;">Week ${wk.week} • ${escapeHtml(wk.overall_topic || "")}</div>${deckCards || '<div class="muted small">No decks.</div>'}`;
  wrap.querySelectorAll(".pillClick").forEach(p => {
    p.addEventListener("click", async (e) => {
      await openPreview(e.currentTarget.getAttribute("data-source"), e.currentTarget.getAttribute("data-toc"));
    });
  });
}

function renderGeneratedLLMPreview() {
  const wrap = el("generatedLLMPreviewWrap");
  if (!wrap) return;

  if (!state.generatedLLM) {
    wrap.innerHTML = `<div class="muted small">No LLM plan yet. Generate one week using the LLM card.</div>`;
    return;
  }
  wrap.innerHTML = `
    <button class="btn" id="openLLMJsonBtn">Open LLM plan JSON</button>
    <div class="muted small" style="margin-top:8px;">Saved in project folder as generated_llm_plan.json</div>
  `;
  const btn = el("openLLMJsonBtn");
  if(btn) btn.onclick = () => openTextModal("Generated LLM plan (JSON)", JSON.stringify(state.generatedLLM, null, 2));
}

// --------------------
// Boot
// --------------------
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

function fillLLMUI() {
  const host = el("ollamaHostInput");
  const model = el("ollamaModelInput");
  if (host) host.value = state.ollama.host || "";
  if (model) model.value = state.ollama.model || "";
}

function readLLMFromUI() {
  state.ollama.host = (el("ollamaHostInput")?.value || "").trim() || "http://localhost:11434";
  state.ollama.model = (el("ollamaModelInput")?.value || "").trim() || "qwen3:8b";
}

async function boot() {
  console.log("App booting...");
  
  // Guard initialization in case elements are missing
  try { initWeeks(); } catch(e) { console.error("initWeeks failed:", e); }
  try { setProjectLabel(); } catch(e) { console.error("setProjectLabel failed:", e); }

  // --- Project Controls ---
  const btnNew = el("newProjectBtn");
  if (btnNew) {
    btnNew.onclick = async () => {
        try { await createNewProject(); } catch (e) { alert("Create project failed: " + e.message); }
    };
  } else { console.error("newProjectBtn not found in DOM"); }

  const selProj = el("projectSelect");
  if (selProj) {
    selProj.onchange = async () => {
        try { await loadProject(selProj.value); } catch (e) { alert("Load project failed: " + e.message); }
    };
  }

  // --- Drag & Drop ---
  const dz = el("dropZone");
  const fi = el("fileInput");
  if (dz && fi) {
    dz.addEventListener("click", () => fi.click());
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", async (e) => {
        e.preventDefault();
        dz.classList.remove("drag");
        const f = e.dataTransfer.files?.[0];
        if (f) await handlePdfUpload(f);
    });
    fi.addEventListener("change", async (e) => {
        const f = e.target.files?.[0];
        if (f) await handlePdfUpload(f);
        fi.value = "";
    });
  }

  // --- Outline Upload ---
  const outlineInp = el("outlineInput");
  if (outlineInp) {
    outlineInp.addEventListener("change", async (e) => {
        try {
            requireProject();
            const f = e.target.files?.[0];
            if (!f) return;
            await uploadFileTo(apiUrl("/upload_outline"), f);
            outlineInp.value = "";
            state.outline = await apiGet(apiUrl("/outline"));
            const n = Array.isArray(state.outline.weeklySchedule) ? state.outline.weeklySchedule.length : 12;
            if (n > 0) setWeeksCount(n);
            alert("Outline uploaded.");
        } catch (err) { alert("Outline upload failed: " + err.message); }
    });
  }

  // --- Plan Save/Load ---
  const btnSave = el("savePlanBtn");
  if (btnSave) btnSave.onclick = async () => {
    try {
        requireProject();
        if (!state.plan.meta) state.plan.meta = {};
        state.plan.meta.weeks_count = state.weeksCount;
        await apiPost(apiUrl("/plan"), state.plan);
        alert("Plan saved.");
    } catch (err) { alert("Save failed: " + err.message); }
  };
  
  const btnLoad = el("loadPlanBtn");
  if (btnLoad) btnLoad.onclick = async () => {
    try {
        requireProject();
        state.plan = await apiGet(apiUrl("/plan"));
        const planWeeks = state.plan?.meta?.weeks_count;
        if (planWeeks) setWeeksCount(planWeeks);
        renderAll();
        alert("Plan loaded.");
    } catch (err) { alert("Load failed: " + err.message); }
  };

  // --- Plan Content UI Listeners ---
  const chkInt = el("interactiveInput");
  if (chkInt) chkInt.addEventListener("change", () => { updatePlanContentUIEnabled(); readPlanContentFromUI(); });
  const chkDeep = el("interactiveDeepInput");
  if (chkDeep) chkDeep.addEventListener("change", readPlanContentFromUI);

  ["slidesPerHourInput","timePerContentInput","timePerInteractiveInput","timeFrameworkInput","sessionsPerWeekInput","sessionHoursInput"].forEach(id => {
      const elem = el(id);
      if (elem) elem.addEventListener("input", readPlanContentFromUI);
  });

  // --- Preview Modal ---
  const btnClose = el("closePreviewBtn");
  if (btnClose) btnClose.onclick = closePreview;
  const modal = el("previewModal");
  if (modal) modal.addEventListener("click", (e) => { if (e.target.id === "previewModal") closePreview(); });

  // --- Generate Plan ---
  const btnGen = el("generatePlanBtn");
  if (btnGen) btnGen.onclick = async () => {
    try {
        requireProject();
        readPlanContentFromUI();
        const stat = el("genStatus");
        if(stat) stat.textContent = "Generating plan...";
        const res = await apiPost(apiUrl("/generate_plan"), { plan: state.plan, config: state.planContent });
        state.generated = res.plan;
        if(stat) stat.textContent = "Plan generated ✔";
        const btnDl = el("downloadGeneratedBtn");
        if(btnDl) btnDl.disabled = false;
        renderGeneratedPlanPreview();
    } catch (err) {
        console.error(err);
        const stat = el("genStatus");
        if(stat) stat.textContent = "Generate failed: " + err.message;
    }
  };

  const btnDlGen = el("downloadGeneratedBtn");
  if (btnDlGen) btnDlGen.onclick = () => {
    if (!state.generated) return;
    const blob = new Blob([JSON.stringify(state.generated, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "generated_plan.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- LLM Controls ---
  const btnPing = el("llmPingBtn");
  if (btnPing) btnPing.onclick = async () => {
    try {
        requireProject();
        readLLMFromUI();
        const stat = el("llmStatus");
        if(stat) stat.textContent = "Pinging model...";
        const res = await apiGet(apiUrl(`/llm_health?host=${encodeURIComponent(state.ollama.host)}&model=${encodeURIComponent(state.ollama.model)}`));
        if(stat) stat.textContent = (res.ok ? "✔ " : "✖ ") + (res.message || "");
    } catch (e) {
        const stat = el("llmStatus");
        if(stat) stat.textContent = "Ping failed: " + e.message;
    }
  };

  const btnGenWeek = el("llmGenWeekBtn");
  if (btnGenWeek) btnGenWeek.onclick = async () => {
    try {
        requireProject();
        readLLMFromUI();
        if (!state.generated) { alert("Generate the simple plan first (Generate plan)."); return; }
        const stat = el("llmStatus");
        if(stat) stat.textContent = `Generating week ${state.selectedWeek} via LLM...`;
        const res = await apiPost(apiUrl("/llm_generate_week"), {
            week_number: state.selectedWeek,
            generated_plan: state.generated,
            ollama_host: state.ollama.host,
            ollama_model: state.ollama.model
        });
        state.generatedLLM = res.plan;
        if(stat) stat.textContent = "LLM generation ✔";
        const btnDl = el("downloadLLMBtn");
        if(btnDl) btnDl.disabled = false;
        renderGeneratedLLMPreview();
    } catch (e) {
        console.error(e);
        const stat = el("llmStatus");
        if(stat) stat.textContent = "LLM generation failed: " + e.message;
    }
  };

  const btnDlLLM = el("downloadLLMBtn");
  if (btnDlLLM) btnDlLLM.onclick = () => {
    if (!state.generatedLLM) return;
    const blob = new Blob([JSON.stringify(state.generatedLLM, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "generated_llm_plan.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- Weeks & Buttons ---
  const btnApplyWeeks = el("applyWeeksBtn");
  if (btnApplyWeeks) btnApplyWeeks.onclick = () => {
      const val = el("weeksCountInput")?.value;
      if(val) setWeeksCount(val);
  };
  
  const inpWeeks = el("weeksCountInput");
  if (inpWeeks) inpWeeks.addEventListener("keydown", (e) => {
    if (e.key === "Enter") setWeeksCount(e.target.value);
  });

  const btnDlPlan = el("downloadPlanBtn");
  if (btnDlPlan) btnDlPlan.onclick = () => {
    const blob = new Blob([JSON.stringify(state.plan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plan.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const btnClearWk = el("clearWeekBtn");
  if (btnClearWk) btnClearWk.onclick = () => {
    const wk = String(state.selectedWeek);
    if (!state.plan.weeks[wk]) state.plan.weeks[wk] = { topic: "", items: [] };
    state.plan.weeks[wk].items = [];
    renderAll();
  };

  // --- Initial Load ---
  try { await refreshProjectsList(); } catch (e) { console.warn("Projects list failed", e); }
}

boot();