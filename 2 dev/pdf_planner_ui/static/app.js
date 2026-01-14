// app.js


const state = {
  outline: { weeklySchedule: [] },
  sources: {},
  activeSourceId: null,

  // ToC UI state (per source_id + toc_id)
  tocCollapsed: {},

  plan: { meta: { weeks_count: 12 }, weeks: {} },
  selectedWeek: 1,
  weeksCount: 12,

  planContent: {
    course_id: "ICT312",
    unit_name: "Digital Forensic",
    interactive: true,
    interactive_deep: false,
    parameters_slides: {
      slides_per_hour: 16,
      time_per_content_slides_min: 3,
      time_per_interactive_slide_min: 5,
      time_for_framework_slides_min: 6
    },
    // optional
    sessions_per_week: 1,
    session_duration_hours: 2
  },

  generated: null,
  generatedLLM: null,
  generatedView: "base",

  llm: { host: "http://localhost:11434", model: "llama3.1" },
  llmOk: false,
  llmBusy: false
};

function tocKey(sourceId, tocId) {
  return `${sourceId}::${String(tocId)}`;
}

const el = (id) => document.getElementById(id);

function initWeeks() {
  const ws = el("weekSelect");
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

function setWeeksCount(n, { syncInput = true } = {}) {
  const count = clampInt(n, 1, 52);

  state.weeksCount = count;

  // persist in plan
  if (!state.plan.meta) state.plan.meta = {};
  state.plan.meta.weeks_count = count;

  // keep selectedWeek in range
  if (state.selectedWeek > count) state.selectedWeek = count;

  ensureWeeksExist(count);

  if (syncInput) {
    const inp = el("weeksCountInput");
    if (inp) inp.value = String(count);
  }

  initWeeks();   // repopulate dropdown
  renderAll();   // rebuild table with correct number of rows
}

function fillPlanContentUI() {
  el("courseIdInput").value = state.planContent.course_id || "";
  el("unitNameInput").value = state.planContent.unit_name || "";
  el("interactiveInput").checked = !!state.planContent.interactive;
  el("interactiveDeepInput").checked = !!state.planContent.interactive_deep;

  const p = state.planContent.parameters_slides || {};
  el("slidesPerHourInput").value = p.slides_per_hour ?? 16;
  el("timePerContentInput").value = p.time_per_content_slides_min ?? 3;
  el("timePerInteractiveInput").value = p.time_per_interactive_slide_min ?? 5;
  el("timeFrameworkInput").value = p.time_for_framework_slides_min ?? 6;

  el("sessionsPerWeekInput").value = state.planContent.sessions_per_week ?? 1;
  el("sessionHoursInput").value = state.planContent.session_duration_hours ?? 2;

  updatePlanContentUIEnabled();
}

function updatePlanContentUIEnabled() {
  const on = el("interactiveInput").checked;
  el("interactiveDeepInput").disabled = !on;
  if (!on) el("interactiveDeepInput").checked = false;
}

function readPlanContentFromUI() {
  state.planContent.course_id = (el("courseIdInput").value || "").trim();
  state.planContent.unit_name = (el("unitNameInput").value || "").trim();
  state.planContent.interactive = !!el("interactiveInput").checked;
  state.planContent.interactive_deep = !!el("interactiveDeepInput").checked;

  state.planContent.parameters_slides = {
    slides_per_hour: parseInt(el("slidesPerHourInput").value, 10) || 16,
    time_per_content_slides_min: parseInt(el("timePerContentInput").value, 10) || 3,
    time_per_interactive_slide_min: parseInt(el("timePerInteractiveInput").value, 10) || 5,
    time_for_framework_slides_min: parseInt(el("timeFrameworkInput").value, 10) || 6
  };

  state.planContent.sessions_per_week = parseInt(el("sessionsPerWeekInput").value, 10) || 1;
  state.planContent.session_duration_hours = parseFloat(el("sessionHoursInput").value) || 2;

  // persist into plan.json
  if (!state.plan.meta) state.plan.meta = {};
  state.plan.meta.plan_content = state.planContent;
}

function flattenSubtree(node) {
  // Pre-order flatten: parent first, then children
  const out = [];
  (function walk(n) {
    if (!n) return;
    out.push(n);
    if (Array.isArray(n.children)) {
      for (const ch of n.children) walk(ch);
    }
  })(node);
  return out;
}

function assignSubtreeToWeek(sourceId, node, weekStr, { includeParent = true } = {}) {
  const nodes = flattenSubtree(node);
  const picked = includeParent ? nodes : nodes.slice(1);

  // Nothing to do
  if (!picked.length) return;

  const ids = new Set(picked.map(n => n.toc_id));

  // Remove these nodes from any other week first (keeps unique assignment)
  for (const w of Object.values(state.plan.weeks)) {
    w.items = (w.items || []).filter(it => !(it.source_id === sourceId && ids.has(it.toc_id)));
  }

  // Add to selected week
  if (!state.plan.weeks[weekStr]) state.plan.weeks[weekStr] = { topic: "", items: [] };
  const dest = state.plan.weeks[weekStr];

  for (const n of picked) {
    dest.items.push({
      source_id: sourceId,
      toc_id: n.toc_id,
      title: n.title,
      titles_path: n.titles_path || [n.title],
    });
  }
}

function unassignSubtree(sourceId, node, { includeParent = true } = {}) {
  const nodes = flattenSubtree(node);
  const picked = includeParent ? nodes : nodes.slice(1);
  if (!picked.length) return;

  const ids = new Set(picked.map(n => n.toc_id));
  for (const w of Object.values(state.plan.weeks)) {
    w.items = (w.items || []).filter(it => !(it.source_id === sourceId && ids.has(it.toc_id)));
  }
}

function subtreeCount(node) {
  return flattenSubtree(node).length;
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

function setActiveSource(sourceId) {
  state.activeSourceId = sourceId;
  // Generated plan preview toggles (Base vs LLM)
  const baseBtn = el("generatedViewBaseBtn");
  const llmBtn = el("generatedViewLlmBtn");
  const dlLlmBtn = el("downloadGeneratedLlmBtn");
  if (baseBtn) baseBtn.onclick = () => { state.generatedView = "base"; renderGeneratedPlan(); };
  if (llmBtn) llmBtn.onclick = () => { state.generatedView = "llm"; renderGeneratedPlan(); };
  if (dlLlmBtn) dlLlmBtn.onclick = () => {
    if (!state.generatedLLM) return;
    const blob = new Blob([JSON.stringify(state.generatedLLM, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "generated_llm_plan.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  renderAll();
}

function isAssigned(sourceId, tocId) {
  const key = String(state.selectedWeek);
  const week = state.plan.weeks[key];
  return week.items.some(x => x.source_id === sourceId && x.toc_id === tocId);
}

function findAssignedWeek(sourceId, tocId) {
  for (const [wk, wobj] of Object.entries(state.plan.weeks)) {
    const hit = wobj.items.find(x => x.source_id === sourceId && x.toc_id === tocId);
    if (hit) return wk;
  }
  return null;
}

function assignNodeToWeek(sourceId, node, weekStr) {
  // Remove from any other week first (unique assignment)
  for (const w of Object.values(state.plan.weeks)) {
    w.items = w.items.filter(x => !(x.source_id === sourceId && x.toc_id === node.toc_id));
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
    w.items = w.items.filter(x => !(x.source_id === sourceId && x.toc_id === tocId));
  }
}

function renderPdfList() {
  const list = el("pdfList");
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
    left.innerHTML = `<div><b>${src.filename}</b></div>
                      <div class="muted small">source_id: ${sourceId}</div>`;

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
  container.innerHTML = "";

  if (!state.activeSourceId) {
    meta.textContent = "Upload a PDF and click Open to view its ToC.";
    return;
  }

  const src = state.sources[state.activeSourceId];
  meta.textContent = `Viewing: ${src.filename} • nodes: ${src.toc_entries_count}`;

  const renderNode = (node) => {
    const wrap = document.createElement("div");
    wrap.className = "tocNode";

    const head = document.createElement("div");
    head.className = "tocHead";

    const left = document.createElement("div");

    const key = tocKey(state.activeSourceId, node.toc_id);
    const hasKids = !!(node.children && node.children.length);
    const collapsed = !!state.tocCollapsed[key];

    // Title row with optional collapse toggle
    const titleRow = document.createElement("div");
    titleRow.className = "tocTitleRow";

    if (hasKids) {
      const toggleBtn = document.createElement("button");
      toggleBtn.className = "tocToggleBtn";
      toggleBtn.type = "button";
      toggleBtn.textContent = collapsed ? "▸" : "▾";
      toggleBtn.title = collapsed ? "Expand" : "Collapse";
      toggleBtn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        state.tocCollapsed[key] = !state.tocCollapsed[key];
        // Re-render ToC only (faster than renderAll)
        renderToc();
      };
      titleRow.appendChild(toggleBtn);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "tocToggleSpacer";
      titleRow.appendChild(spacer);
    }

    const titleDiv = document.createElement("div");
    titleDiv.className = "tocTitle";
    titleDiv.textContent = node.title || "(untitled)";
    titleRow.appendChild(titleDiv);
    left.appendChild(titleRow);

    const metaDiv = document.createElement("div");
    metaDiv.className = "tocMeta";
    const subtreeStr = hasKids ? ` • Subtree: ${subtreeCount(node)} nodes` : "";
    metaDiv.textContent = `ToC ID: ${node.toc_id ?? "-"} • Page: ${node.page_1based ?? "-"}${subtreeStr}`;
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

      // OPTIONAL UX: Shift+click assigns subtree
      if (ev && ev.shiftKey && node.children && node.children.length) {
        assignSubtreeToWeek(state.activeSourceId, node, wk, { includeParent: true });
      } else {
        assignNodeToWeek(state.activeSourceId, node, wk);
      }
      renderAll();
      state.llmOk = false;
      setLlmStatus("Plan ready — run health check.", false);
    };

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn";
    removeBtn.textContent = "Remove";
    removeBtn.onclick = () => {
      unassignNode(state.activeSourceId, node.toc_id);
      renderAll();
    };

    right.appendChild(assignBtn);

    // NEW: subtree buttons only when node has children
    if (node.children && node.children.length) {
      const assignAllBtn = document.createElement("button");
      assignAllBtn.className = "btn";
      assignAllBtn.textContent = "Assign + children";
      assignAllBtn.title = "Assign this chapter and all descendants to the selected week";
      assignAllBtn.onclick = () => {
        const wk = String(state.selectedWeek);
        assignSubtreeToWeek(state.activeSourceId, node, wk, { includeParent: true });
        renderAll();
      };

      const removeAllBtn = document.createElement("button");
      removeAllBtn.className = "btn danger";
      removeAllBtn.textContent = "Remove subtree";
      removeAllBtn.title = "Remove this chapter and all descendants from all weeks";
      removeAllBtn.onclick = () => {
        unassignSubtree(state.activeSourceId, node, { includeParent: true });
        renderAll();
      };

      right.appendChild(assignAllBtn);
      right.appendChild(removeAllBtn);
    }

    right.appendChild(removeBtn);

    head.appendChild(left);
    head.appendChild(right);
    wrap.appendChild(head);

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

function buildWeekTree(items) {
  const root = {
    label: "__root__",
    children: {},
    selected: [],
    sourceId: null,
    minTocId: Infinity,
    count: 0,
  };

  for (const it of (items || [])) {
    const sourceId = it.source_id;
    const sourceLabel = (state.sources[sourceId]?.filename) || sourceId;

    const titles = (Array.isArray(it.titles_path) && it.titles_path.length)
      ? it.titles_path
      : [it.title || `ToC ${it.toc_id}`];

    const path = [sourceLabel, ...titles];

    let cur = root;
    for (let i = 0; i < path.length; i++) {
      const seg = (path[i] || "(untitled)");
      if (!cur.children[seg]) {
        cur.children[seg] = {
          label: seg,
          children: {},
          selected: [],
          sourceId: (i === 0) ? sourceId : cur.sourceId,
          minTocId: Infinity,
          count: 0,
        };
      }
      cur = cur.children[seg];
      if (i === 0) cur.sourceId = sourceId;
    }

    cur.selected.push({
      source_id: sourceId,
      toc_id: it.toc_id,
      title: it.title,
      titles_path: titles,
    });
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

    const actions = document.createElement("div");
    actions.className = "wkActions";

    // View/remove only if THIS exact node is selected
    if (node.selected && node.selected.length) {
      const sel = node.selected[0];

      const view = document.createElement("button");
      view.className = "btn smallBtn";
      view.textContent = "View";
      view.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPreview(sel.source_id, String(sel.toc_id));
      };
      actions.appendChild(view);

      const rm = document.createElement("button");
      rm.className = "btn smallBtn";
      rm.textContent = "Remove";
      rm.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        unassignNode(sel.source_id, sel.toc_id);
        renderAll();
      };
      actions.appendChild(rm);
    }

    line.appendChild(actions);
    return line;
  };

  if (hasKids) {
    const det = document.createElement("details");
    det.className = "wkNode";
    det.open = depth < 2; // open source + chapter by default

    const sum = document.createElement("summary");
    sum.className = "wkSummary";
    sum.appendChild(makeLine());
    det.appendChild(sum);

    const kidsWrap = document.createElement("div");
    kidsWrap.className = "wkChildren";

    const children = Object.values(node.children).sort(
      (a, b) => (a.minTocId - b.minTocId) || a.label.localeCompare(b.label)
    );
    for (const ch of children) {
      kidsWrap.appendChild(renderWeekTreeNode(ch, depth + 1));
    }

    det.appendChild(kidsWrap);
    return det;
  }

  return makeLine();
}

function renderWeekSummary() {
  const wrap = el("weekTableWrap");
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

    const sumLeft = document.createElement("div");
    sumLeft.innerHTML = `<b>Week ${i}</b> <span class="muted small">(${items.length} sections)</span>`;
    sum.appendChild(sumLeft);

    const sumRight = document.createElement("div");
    sumRight.className = "row";

    const clearBtn = document.createElement("button");
    clearBtn.className = "btn danger smallBtn";
    clearBtn.textContent = "Clear";
    clearBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.plan.weeks[wk]) state.plan.weeks[wk] = { topic: "", items: [] };
      state.plan.weeks[wk].items = [];
      renderAll();
    };
    sumRight.appendChild(clearBtn);

    sum.appendChild(sumRight);
    weekDet.appendChild(sum);

    const body = document.createElement("div");
    body.className = "weekBody";

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "muted small";
      empty.textContent = "No sections assigned.";
      body.appendChild(empty);
    } else {
      const tree = buildWeekTree(items);
      const sources = Object.values(tree.children).sort((a, b) => a.label.localeCompare(b.label));
      for (const srcNode of sources) {
        body.appendChild(renderWeekTreeNode(srcNode, 0));
      }
    }

    weekDet.appendChild(body);
    wrap.appendChild(weekDet);
  }
}


function renderGeneratedPlan() {
  const wrap = el("generatedPlanWrap");
  const hint = el("generatedPlanHint");
  if (!wrap) return;

  const mode = state.generatedView || "base";
  const plan = (mode === "llm") ? (state.generatedLLM || state.generated) : (state.generated || state.generatedLLM);
  // Toggle styles + download availability
  const baseBtn = el("generatedViewBaseBtn");
  const llmBtn = el("generatedViewLlmBtn");
  const dlLlmBtn = el("downloadGeneratedLlmBtn");
  if (baseBtn) baseBtn.classList.toggle("primary", mode !== "llm");
  if (llmBtn) llmBtn.classList.toggle("primary", mode === "llm");
  if (dlLlmBtn) dlLlmBtn.disabled = !state.generatedLLM;

  wrap.innerHTML = "";

  if (!plan || !plan.weeks) {
    if (hint) hint.style.display = "block";
    return;
  }
  if (hint) hint.style.display = "none";

  const wk = String(state.selectedWeek);
  const wobj = plan.weeks[wk];
  if (!wobj || !Array.isArray(wobj.deck_plans) || wobj.deck_plans.length === 0) {
    wrap.innerHTML = `<div class="muted small">No generated content for Week ${wk}.</div>`;
    return;
  }

  const overall = (wobj.overall_topic || wobj.topic || "").trim();
  const slides = wobj.weekly_slide_summary?.total_slides_for_week ?? 0;
  const minutes = wobj.weekly_time_summary_minutes?.total_time_for_week_minutes ?? 0;

  const head = document.createElement("div");
  head.className = "genHeader";
  head.innerHTML = `
    <div><b>Week ${wk}</b>${overall ? ` — ${escapeHtml(overall)}` : ""}</div>
    <div class="muted small">${slides} slides • ${minutes} min • ${wobj.deck_plans.length} deck(s)</div>
  `;
  wrap.appendChild(head);

  const decksWrap = document.createElement("div");
  decksWrap.className = "genDecks";
  wrap.appendChild(decksWrap);

  for (const deck of wobj.deck_plans) {
    const det = document.createElement("details");
    det.className = "genDeck";
    det.open = false;

    const dSlides = deck.slide_count_breakdown
      ? ((deck.slide_count_breakdown.framework || 0) + (deck.slide_count_breakdown.content || 0) + (deck.slide_count_breakdown.interactive || 0))
      : (deck.total_slides_in_deck ?? 0);
    const dMin = deck.time_breakdown_minutes?.total_deck_time ?? 0;

    const sum = document.createElement("summary");
    sum.innerHTML = `<b>Lecture ${deck.deck_number}</b> <span class="muted small">• ${dSlides} slides • ${dMin} min</span>`;
    det.appendChild(sum);

    const body = document.createElement("div");
    body.className = "genDeckBody";

    const sections = Array.isArray(deck.sections) ? deck.sections : [];
    for (const sec of sections) {
      const st = sec.section_type || "Section";
      if (st !== "Content") {
        const row = document.createElement("div");
        row.className = "genFrameworkRow";
        row.innerHTML = `<span class="pill">${escapeHtml(st)}</span><span class="muted small">${escapeHtml(sec.content?.title || "")}</span>`;
        body.appendChild(row);
        continue;
      }

      const blocks = sec.content_blocks || sec.content?.content_blocks || [];
      if (!blocks.length) {
        const empty = document.createElement("div");
        empty.className = "muted small";
        empty.textContent = "No content blocks.";
        body.appendChild(empty);
        continue;
      }

      const title = document.createElement("div");
      title.className = "genContentTitle";
      title.textContent = "Content blocks";
      body.appendChild(title);

      // Group blocks by top-level parent (chapter/parent)
      const groups = {};
      for (const b of blocks) {
        const path = b.title_path || b.titles_path || [b.title || "Untitled"];
        const root = (path && path.length) ? path[0] : (b.title || "Untitled");
        if (!groups[root]) groups[root] = [];
        groups[root].push({ ...b, _path: path });
      }

      for (const root of Object.keys(groups).sort((a, b) => a.localeCompare(b))) {
        const rootDet = document.createElement("details");
        rootDet.className = "genRoot";
        rootDet.open = false;

        const rootSum = document.createElement("summary");
        rootSum.innerHTML = `<b>${escapeHtml(root)}</b> <span class="muted small">(${groups[root].length})</span>`;
        rootDet.appendChild(rootSum);

        const rootBody = document.createElement("div");
        rootBody.className = "genRootBody";

        for (const b of groups[root]) {
          const item = document.createElement("div");
          item.className = "genItem";

          const pathStr = (b._path || [b.title || "Untitled"]).join(" / ");
          const cSlides = b.content_slides ?? b.direct_slides_content ?? 0;
          const iSlides = b.interactive_slides ?? (b.interactive_activity?.slides_allocated ?? 0);
          const mins = b.time_minutes ?? b.time_allocation_minutes?.total_branch_time ?? 0;
          const iType = b.interactive_type || b.interactive_activity?.title || "";

          const left = document.createElement("div");
          left.className = "genItemLeft";
          left.innerHTML = `
            <div class="genItemTitle">${escapeHtml(pathStr)}</div>
            <div class="muted small">${cSlides} content • ${iSlides} interactive • ${mins} min ${iType ? `• ${escapeHtml(iType)}` : ""}</div>
          `;

          const right = document.createElement("div");
          right.className = "genItemRight";

          const viewBtn = document.createElement("button");
          viewBtn.className = "btn smallBtn";
          viewBtn.textContent = "View";
          viewBtn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const text = b.content;
            if (text && String(text).trim().length > 0) {
              openTextModal(pathStr, text);
            } else if (b.source_id && (b.toc_id !== undefined && b.toc_id !== null)) {
              await openPreview(b.source_id, String(b.toc_id));
            } else {
              openTextModal(pathStr, "(No content available.)");
            }
          };
          right.appendChild(viewBtn);

          item.appendChild(left);
          item.appendChild(right);
          rootBody.appendChild(item);
        }

        rootDet.appendChild(rootBody);
        body.appendChild(rootDet);
      }
    }

    det.appendChild(body);
    decksWrap.appendChild(det);
  }
}


async function openPreview(sourceId, tocId) {
  const modal = el("previewModal");
  el("previewTitle").textContent = "Loading...";
  el("previewBody").textContent = "";
  modal.classList.remove("hidden");

  const data = await apiGet(`/api/section_text/${encodeURIComponent(sourceId)}/${encodeURIComponent(tocId)}?max_chars=20000`);
  el("previewTitle").textContent = data.title_path || data.title || `ToC ${tocId}`;
  el("previewBody").textContent = data.text || "(No extracted text found for this node.)";
}

function openTextModal(title, text) {
  const modal = el("previewModal");
  el("previewTitle").textContent = title || "Preview";
  el("previewBody").textContent = text || "(No content available.)";
  modal.classList.remove("hidden");
}

function closePreview() {
  el("previewModal").classList.add("hidden");
}
// ---------------------------------------------------------------------------
// LLM (Ollama) helpers
// ---------------------------------------------------------------------------

function _getSelectedWeekKey() {
  return String(state.selectedWeek || 1);
}

function setLlmStatus(message, busy = false) {
  const status = el("llmStatus");
  const genBtn = el("llmGenerateBtn");
  const checkBtn = el("llmCheckBtn");
  const viewBtn = el("llmViewWeekBtn");

  if (status) {
    status.innerHTML = "";
    if (busy) {
      const sp = document.createElement("span");
      sp.className = "spinner";
      status.appendChild(sp);
      const t = document.createElement("span");
      t.textContent = " " + message;
      status.appendChild(t);
    } else {
      status.textContent = message || "";
    }
  }

  if (genBtn) genBtn.disabled = busy || !state.generated || !state.llmOk;
  if (viewBtn) viewBtn.disabled = !(state.generatedLLM || state.generated);
  if (checkBtn) checkBtn.disabled = busy;
}

async function llmHealthCheck() {
  const hostInput = el("llmHostInput");
  const modelInput = el("llmModelInput");
  const host = (hostInput ? hostInput.value : state.llm.host).trim();
  const model = (modelInput ? modelInput.value : state.llm.model).trim();

  state.llm.host = host || state.llm.host;
  state.llm.model = model || state.llm.model;

  setLlmStatus("Checking Ollama…", true);

  try {
    const url = `/api/llm_health?host=${encodeURIComponent(state.llm.host)}&model=${encodeURIComponent(state.llm.model)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      state.llmOk = false;
      setLlmStatus(`❌ ${data.error || "Model is not reachable."}`, false);
      return;
    }

    state.llmOk = true;
    const extra = (data.found_model === false) ? " (model not found on host)" : "";
    setLlmStatus(`✅ Ollama reachable${extra}. Models: ${data.models_count ?? "?"}`, false);
  } catch (err) {
    state.llmOk = false;
    setLlmStatus(`❌ Health check failed: ${err.message || err}`, false);
  }
}

async function llmGenerateSelectedWeek() {
  if (!(state.generatedLLM || state.generated)) {
    setLlmStatus("Generate a plan first (Step 4).", false);
    return;
  }
  const wk = _getSelectedWeekKey();
  const weekPlan = (state.generated.weeks || {})[wk];
  if (!weekPlan) {
    setLlmStatus(`Week ${wk} not found in generated plan.`, false);
    return;
  }

  state.llmBusy = true;
  setLlmStatus(`Generating week ${wk} content…`, true);

  // dot animation
  let dots = 0;
  const dotTimer = setInterval(() => {
    dots = (dots + 1) % 4;
    const msg = `Generating week ${wk} content${".".repeat(dots)}`;
    setLlmStatus(msg, true);
  }, 600);

  try {
    const payload = {
      week: parseInt(wk, 10),
      week_plan: weekPlan,
      host: state.llm.host,
      model: state.llm.model,
    };

    const res = await fetch("/api/llm_generate_week", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "LLM generation failed.");
    }

    // Update in-memory generated plan
    state.generated.weeks[wk] = data.week_plan;

    setLlmStatus(`✅ Generated content for week ${wk}.`, false);
    renderAll();
  } catch (err) {
    setLlmStatus(`❌ ${err.message || err}`, false);
  } finally {
    clearInterval(dotTimer);
    state.llmBusy = false;
    // refresh buttons
    const genBtn = el("llmGenerateBtn");
    if (genBtn) genBtn.disabled = !state.generated || !state.llmOk;
  }
}

function wireLLMCard() {
  const hostInput = el("llmHostInput");
  const modelInput = el("llmModelInput");
  const checkBtn = el("llmCheckBtn");
  const genBtn = el("llmGenerateBtn");
  const viewBtn = el("llmViewWeekBtn");

  if (!hostInput || !modelInput || !checkBtn || !genBtn) {
    // Card not present (or HTML not updated). Don't crash the rest of the app.
    return;
  }

  hostInput.value = state.llm.host || "";
  modelInput.value = state.llm.model || "";

  hostInput.addEventListener("input", () => { state.llm.host = hostInput.value.trim(); state.llmOk = false; setLlmStatus("Host updated — run health check.", false); });
  modelInput.addEventListener("input", () => { state.llm.model = modelInput.value.trim(); state.llmOk = false; setLlmStatus("Model updated — run health check.", false); });

  checkBtn.addEventListener("click", llmHealthCheck);
  genBtn.addEventListener("click", llmGenerateSelectedWeek);

  if (viewBtn) {
    viewBtn.addEventListener("click", () => {
      const wk = _getSelectedWeekKey();
      const weekPlan = (state.generated && state.generated.weeks) ? state.generated.weeks[wk] : null;
      openTextModal(`Week ${wk} plan (JSON)`, weekPlan ? JSON.stringify(weekPlan, null, 2) : "(No week plan.)");
    });
  }

  // initial state
  setLlmStatus("Run health check, then generate.", false);
  genBtn.disabled = true;
}



function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
function escapeAttr(s){ return escapeHtml(s).replace(/"/g, "&quot;"); }

function renderAll() {
  renderPdfList();
  renderToc();
  renderWeekSummary();
  renderGeneratedPlan();
}

async function boot() {
  initWeeks();

  // Load outline + plan if exists
  try {
    state.outline = await apiGet("/api/outline");
  } catch (_) {}

  try {
    state.plan = await apiGet("/api/plan");
  } catch (_) {}

  // (Optional) Load last generated plan on refresh (requires /api/generated_plan)
  try {
    const gp = await apiGet("/api/generated_plan");
    if (gp && gp.ok && gp.plan) {
      state.generated = gp.plan;
      el("downloadGeneratedBtn").disabled = false;
    }
  } catch (_) {}

  initWeeks();
  renderAll();
  wireLLMCard();

  // Drop zone behavior
  const dz = el("dropZone");
  const fi = el("fileInput");

  dz.addEventListener("click", () => fi.click());
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  });
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

  // Outline upload
  el("outlineInput").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;

    await uploadFileTo("/api/upload_outline", f);
    el("outlineInput").value = "";

    // reload outline and auto-set week count
    try {
      state.outline = await apiGet("/api/outline");
      const n = Array.isArray(state.outline.weeklySchedule) ? state.outline.weeklySchedule.length : 12;
      if (n > 0) setWeeksCount(n);
    } catch (_) {}

    alert("Outline uploaded.");
  });

  // Save / load plan
  el("savePlanBtn").onclick = async () => {
    if (!state.plan.meta) state.plan.meta = {};
    state.plan.meta.weeks_count = state.weeksCount;
    await apiPost("/api/plan", state.plan);
    alert("Plan saved.");
  };
  el("loadPlanBtn").onclick = async () => {
    state.plan = await apiGet("/api/plan");
    initWeeks();
    renderAll();
    alert("Plan loaded.");
  };

    // load planContent from plan.meta if present
  if (state.plan?.meta?.plan_content) {
    state.planContent = state.plan.meta.plan_content;
  }

  fillPlanContentUI();

  el("interactiveInput").addEventListener("change", () => {
    updatePlanContentUIEnabled();
    readPlanContentFromUI();
  });
  el("interactiveDeepInput").addEventListener("change", readPlanContentFromUI);

  ["courseIdInput","unitNameInput","slidesPerHourInput","timePerContentInput","timePerInteractiveInput","timeFrameworkInput","sessionsPerWeekInput","sessionHoursInput"]
    .forEach(id => el(id).addEventListener("input", readPlanContentFromUI));

  el("closePreviewBtn").onclick = closePreview;
  el("previewModal").addEventListener("click", (e) => {
    if (e.target.id === "previewModal") closePreview();
  });

  el("generatePlanBtn").onclick = async () => {
    try {
      readPlanContentFromUI();
      el("genStatus").textContent = "Generating plan...";
      const res = await apiPost("/api/generate_plan", { plan: state.plan, config: state.planContent });
      state.generated = res.plan;

      el("genStatus").textContent = "Plan generated ✔";
      el("downloadGeneratedBtn").disabled = false;
      renderAll();
    } catch (err) {
      console.error(err);
      el("genStatus").textContent = "Generate failed: " + err.message;
    }
  };

  el("downloadGeneratedBtn").onclick = () => {
    if (!state.generated) return;
    const blob = new Blob([JSON.stringify(state.generated, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "generated_plan.json";
    a.click();
    URL.revokeObjectURL(url);
  };


  // pick weeksCount from saved plan first, otherwise outline length, otherwise default 12
  const planWeeks = state.plan?.meta?.weeks_count;
  const outlineWeeks = Array.isArray(state.outline?.weeklySchedule) ? state.outline.weeklySchedule.length : 0;

  const initialWeeks = planWeeks ?? (outlineWeeks > 0 ? outlineWeeks : 12);
  setWeeksCount(initialWeeks);

  // Weeks count controls
  el("applyWeeksBtn").onclick = () => {
    const v = el("weeksCountInput").value;
    setWeeksCount(v);
  };

  // Optional: apply immediately on Enter
  el("weeksCountInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") setWeeksCount(e.target.value);
  });

  el("downloadPlanBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(state.plan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plan.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  el("clearWeekBtn").onclick = () => {
    const wk = String(state.selectedWeek);
    if (!state.plan.weeks[wk]) state.plan.weeks[wk] = { topic: "", items: [] };
    state.plan.weeks[wk].items = [];
    renderAll();
  };
}

async function handlePdfUpload(file) {
  try {
    const res = await uploadFileTo("/api/upload_pdf", file);
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

boot();
