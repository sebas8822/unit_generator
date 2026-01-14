from __future__ import annotations

import math
import json
from typing import Any, Dict, List, Tuple, Callable, Optional
from pathlib import Path


# -----------------------------
# helpers
# -----------------------------

def _largest_remainder_allocation(weights: List[int], total: int) -> List[int]:
    """
    Allocate an integer 'total' across items proportionally to integer 'weights',
    using the Largest Remainder (Hamilton) method.
    """
    if total <= 0 or not weights:
        return [0] * len(weights)

    wsum = sum(weights)
    if wsum <= 0:
        # fallback equal split
        base = total // len(weights)
        rem = total - base * len(weights)
        out = [base] * len(weights)
        for i in range(rem):
            out[i] += 1
        return out

    exact = [total * (w / wsum) for w in weights]
    floors = [int(math.floor(x)) for x in exact]
    rem = total - sum(floors)

    frac = [(i, exact[i] - floors[i]) for i in range(len(weights))]
    frac.sort(key=lambda t: t[1], reverse=True)

    out = floors[:]
    for k in range(rem):
        out[frac[k % len(frac)][0]] += 1
    return out


def _partition_sequentially(items: List[Dict[str, Any]], k: int) -> List[List[Dict[str, Any]]]:
    """
    Partition ordered items into k bins sequentially to preserve order.
    Used instead of bin_pack to ensure Chapter 1 comes before Chapter 2.
    """
    k = max(1, int(k))
    if not items:
        return [[] for _ in range(k)]
    
    # If only 1 bin, everything goes there in original order.
    if k == 1:
        return [list(items)]

    # Calculate target weight per bin
    total_weight = sum(int(it.get("weight", 0) or 0) for it in items)
    target = total_weight / k
    
    bins = []
    current_bin = []
    current_weight = 0
    
    # We want exactly k bins.
    # We will fill k-1 bins based on target, then dump the rest in the last bin.
    bin_count = 0
    
    for it in items:
        w = int(it.get("weight", 0) or 0)
        
        # Condition to switch to next bin:
        # 1. We aren't at the last bin yet.
        # 2. We have filled the current bin past the target weight.
        if bin_count < k - 1 and current_weight >= target:
            # Close current bin, start new
            bins.append(current_bin)
            current_bin = []
            current_weight = 0
            bin_count += 1
            
        current_bin.append(it)
        current_weight += w
        
    bins.append(current_bin)
    
    # Pad if we somehow didn't use k bins (e.g. huge items, small k)
    while len(bins) < k:
        bins.append([])
        
    return bins


def _safe_int(x: Any, default: int = 0) -> int:
    try:
        return int(x)
    except Exception:
        return default


def _path_key(path: Any) -> Tuple[str, ...]:
    if not path:
        return tuple()
    if isinstance(path, (list, tuple)):
        return tuple(str(p) for p in path if str(p).strip() != "")
    # if a single string was stored, keep it as one element
    s = str(path).strip()
    return (s,) if s else tuple()


# Keep generated JSON reasonably sized while still including "raw" extracted content.
# You can bump this if you want larger chunks embedded in generated_plan.json.
MAX_CONTENT_CHARS_DEFAULT = 200000


def _read_text_safe(text_path: Any, max_chars: int = MAX_CONTENT_CHARS_DEFAULT) -> str:
    """Best-effort file read. Returns "" if missing/unreadable."""
    if not text_path:
        return ""
    try:
        p = Path(str(text_path))
        if not p.exists() or not p.is_file():
            return ""
        return p.read_text(encoding="utf-8", errors="ignore")[: max(0, int(max_chars))]
    except Exception:
        return ""


# -----------------------------
# tree building + planning
# -----------------------------

def _build_path_reverse_index(sections_idx: Dict[str, Any]) -> Dict[Tuple[str, ...], Dict[str, Any]]:
    """
    Reverse index: titles_path(tuple) -> section record.
    Useful to recover toc_id/text metrics for synthetic parent nodes.
    """
    out: Dict[Tuple[str, ...], Dict[str, Any]] = {}
    for rec in sections_idx.values():
        tp = _path_key(rec.get("titles_path"))
        if tp:
            out[tp] = rec
    return out


def _create_or_get_node(
    nodes: Dict[Tuple[str, str, Tuple[str, ...]], Dict[str, Any]],
    source_id: str,
    subpath: Tuple[str, ...],
    path_to_rec: Dict[Tuple[str, ...], Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Keyed by (source_id, kind, titles_path). kind is always 'toc' here.
    """
    key = (source_id, "toc", subpath)
    node = nodes.get(key)
    if node is None:
        rec = path_to_rec.get(subpath, {}) if path_to_rec else {}
        toc_id = rec.get("toc_id")
        # Some pipelines expose "main" fields (intro-only) for parents.
        text_chars = rec.get("text_chars_main")
        if text_chars is None:
            text_chars = rec.get("text_chars")

        node = {
            "source_id": source_id,
            "toc_id": str(toc_id) if toc_id is not None else None,
            "title": subpath[-1] if subpath else "",
            "titles_path": list(subpath),
            # Raw extracted text for this node (when available in sections.jsonl)
            "content": _read_text_safe(rec.get("text_path_main") or rec.get("text_path")),
            "weight_direct": _safe_int(text_chars, 0),
            "total_weight_in_branch": 0,
            "budget_slides_content": 0,
            "direct_slides_content": 0,
            "total_slides_in_branch": 0,
            "time_allocation_minutes": {},
            "children": [],
        }
        nodes[key] = node
    return node


def _attach_child(parent: Dict[str, Any], child: Dict[str, Any]) -> None:
    # avoid duplicates if same child seen multiple times
    for ch in parent.get("children", []):
        if ch is child:
            return
        if ch.get("source_id") == child.get("source_id") and ch.get("titles_path") == child.get("titles_path"):
            return
    parent.setdefault("children", []).append(child)


def _compute_total_weight(node: Dict[str, Any]) -> int:
    total = _safe_int(node.get("weight_direct"), 0)
    for ch in node.get("children", []) or []:
        total += _compute_total_weight(ch)
    node["total_weight_in_branch"] = total
    return total


def _allocate_content_slides(node: Dict[str, Any], budget: int) -> None:
    """
    Recursively allocate integer content slides into a tree node and its children.
    Allocation is proportional to weight_direct vs total_weight_in_branch and child branch weights.
    """
    budget = max(0, int(budget))
    node["budget_slides_content"] = budget

    children = node.get("children", []) or []
    total_w = _safe_int(node.get("total_weight_in_branch"), 0)
    own_w = _safe_int(node.get("weight_direct"), 0)

    if not children:
        node["direct_slides_content"] = budget
        return

    own = 0
    if total_w > 0 and own_w > 0:
        own = int(round(budget * (own_w / total_w)))
    own = max(0, min(own, budget))
    node["direct_slides_content"] = own

    remaining = budget - own
    if remaining <= 0:
        for ch in children:
            _allocate_content_slides(ch, 0)
        return

    child_weights = [_safe_int(ch.get("total_weight_in_branch"), 0) for ch in children]
    child_budgets = _largest_remainder_allocation(child_weights, remaining)
    for ch, b in zip(children, child_budgets):
        _allocate_content_slides(ch, b)


def _add_interactive_activities(
    roots: List[Dict[str, Any]],
    interactive: bool,
    interactive_deep: bool,
) -> int:
    """
    Adds 'interactive_activity' objects into nodes, based on depth relative to each root:
      - interactive=True, interactive_deep=False: only depth==1 (root topics)
      - interactive=True, interactive_deep=True: depth==1 and depth==2 (root + immediate children)
    Returns count of interactive slides added.
    """
    # clear previous interactive_activity if regenerate
    def clear(node: Dict[str, Any]):
        if "interactive_activity" in node:
            node.pop("interactive_activity", None)
        for ch in node.get("children", []) or []:
            clear(ch)

    for r in roots:
        clear(r)

    if not interactive:
        return 0

    added_keys = set()

    def visit(node: Dict[str, Any], depth: int):
        if not node:
            return
        # Decide if this node should receive an activity slide
        add = False
        label = "Interactive Activity"
        if not interactive_deep:
            if depth == 1:
                add = True
        else:
            if depth in (1, 2):
                add = True
                label = "General Activity" if depth == 1 else "Deep-Dive Activity"

        if add:
            key = (node.get("source_id"), node.get("toc_id"), tuple(node.get("titles_path") or []))
            if key not in added_keys:
                added_keys.add(key)
                node["interactive_activity"] = {
                    "title": f"{node.get('title', '')} ({label})",
                    "source_id": node.get("source_id"),
                    "toc_id": node.get("toc_id"),
                    "slides_allocated": 1,
                    "interactive_type": label,
                }

        for ch in node.get("children", []) or []:
            visit(ch, depth + 1)

    for r in roots:
        visit(r, 1)

    return len(added_keys)


def _sum_slides_and_time(node: Dict[str, Any], time_per_content: int, time_per_interactive: int) -> Tuple[int, int]:
    """
    Returns (total_slides_in_branch, total_time_in_branch_minutes)
    and writes per-node time_allocation_minutes.
    """
    children_time = 0
    children_slides = 0
    for ch in node.get("children", []) or []:
        s, t = _sum_slides_and_time(ch, time_per_content, time_per_interactive)
        children_slides += s
        children_time += t

    direct_content_slides = _safe_int(node.get("direct_slides_content"), 0)
    interactive_slides = _safe_int((node.get("interactive_activity") or {}).get("slides_allocated"), 0)

    direct_content_time = direct_content_slides * time_per_content
    direct_interactive_time = interactive_slides * time_per_interactive
    total_time = direct_content_time + direct_interactive_time + children_time
    total_slides = direct_content_slides + interactive_slides + children_slides

    node["total_slides_in_branch"] = total_slides
    node["time_allocation_minutes"] = {
        "direct_content_time": direct_content_time,
        "direct_interactive_time": direct_interactive_time,
        "total_branch_time": total_time,
    }
    return total_slides, total_time


def _assign_sequence_ids_recursively(node: Dict[str, Any], counter: List[int]) -> None:
    """
    Depth-first seq_id assignment:
      - content node seq_id first
      - then children
      - then interactive_activity seq_id LAST
    """
    node["seq_id"] = counter[0]
    counter[0] += 1

    for ch in node.get("children", []) or []:
        _assign_sequence_ids_recursively(ch, counter)

    if "interactive_activity" in node and isinstance(node["interactive_activity"], dict):
        node["interactive_activity"]["seq_id"] = counter[0]
        counter[0] += 1


def _reorder_node_keys(node: Dict[str, Any]) -> Dict[str, Any]:
    """
    Reorder keys for readability (stable schema for downstream processing).
    """
    key_order = [
        "title",
        "source_id",
        "toc_id",
        "titles_path",
        "content",
        "weight_direct",
        "total_weight_in_branch",
        "budget_slides_content",
        "direct_slides_content",
        "total_slides_in_branch",
        "time_allocation_minutes",
        "seq_id",
        "children",
        "interactive_activity",
    ]
    reordered = {k: node[k] for k in key_order if k in node}

    if "children" in reordered:
        reordered["children"] = [_reorder_node_keys(ch) for ch in (reordered["children"] or [])]

    return reordered


def generate_plan_from_ui_selection(
    plan: Dict[str, Any],
    config: Dict[str, Any],
    sections_index_lookup: Callable[[str], Dict[str, Any]],  # callable(source_id)->dict[toc_id_str]->rec
) -> Dict[str, Any]:
    """
    Generates a hierarchical, time-bounded teaching plan from UI week selections.

    Interactive logic (requested):
      - interactive=True: add 1 interactive slide ONLY for each parent topic (deck root)
      - interactive_deep=True: add 1 interactive slide for each parent topic AND each immediate child

    Output includes:
      - per-deck framework sections (Title/Agenda/Content/Summary/End)
      - per-node slide and time allocations
      - seq_id ordering for slide generation
      - weekly + grand totals
    """
    meta = plan.get("meta", {}) or {}
    weeks_count = int(meta.get("weeks_count", 12))

    params = config.get("parameters_slides", {}) or {}
    TIME_PER_CONTENT = int(params.get("time_per_content_slides_min", 3))
    TIME_PER_INTERACTIVE = int(params.get("time_per_interactive_slide_min", 5))
    TIME_FRAMEWORK = int(params.get("time_for_framework_slides_min", 6))
    FRAMEWORK_SLIDES_PER_DECK = 4  # Title, Agenda, Summary, End

    sessions_per_week = int(config.get("sessions_per_week", 1))
    session_hours = float(config.get("session_duration_hours", 2))
    session_total_minutes = int(round(session_hours * 60))

    interactive = bool(config.get("interactive", True))
    interactive_deep = bool(config.get("interactive_deep", False))

    out_weeks: Dict[str, Any] = {}
    grand = {
        "total_slides_for_unit": 0,
        "total_framework_slides": 0,
        "total_content_slides": 0,
        "total_interactive_slides": 0,
        "total_number_of_decks": 0,
        "total_time_for_unit_minutes": 0,
    }

    for w in range(1, weeks_count + 1):
        wk = str(w)
        wobj = (plan.get("weeks", {}) or {}).get(wk, {"topic": "", "items": []})
        items = (wobj.get("items") or [])

        if not items:
            out_weeks[wk] = {
                "week": w,
                "overall_topic": wobj.get("topic", ""),
                "deck_plans": [],
                "weekly_slide_summary": {"total_slides_for_week": 0, "number_of_decks": 0},
                "weekly_time_summary_minutes": {"total_time_for_week_minutes": 0},
            }
            continue

        # --- Enrich items with extracted metadata ---
        enriched: List[Dict[str, Any]] = []
        idx_by_source: Dict[str, Dict[str, Any]] = {}
        path_to_rec_by_source: Dict[str, Dict[Tuple[str, ...], Dict[str, Any]]] = {}

        for it in items:
            source_id = str(it.get("source_id") or "")
            toc_id = str(it.get("toc_id") or "")

            if source_id and source_id not in idx_by_source:
                idx_by_source[source_id] = sections_index_lookup(source_id) or {}
                path_to_rec_by_source[source_id] = _build_path_reverse_index(idx_by_source[source_id])

            idx = idx_by_source.get(source_id, {})
            rec = idx.get(toc_id, {}) if toc_id else {}

            title_path = rec.get("titles_path") or it.get("titles_path") or [it.get("title", "")]
            title_path = list(_path_key(title_path))
            if not title_path:
                title_path = [it.get("title", "")]

            depth = len(title_path)
            # Prefer 'main' chars if present (Option A: parent intro-only text)
            weight = rec.get("text_chars_main")
            if weight is None:
                weight = rec.get("text_chars")
            weight = _safe_int(weight, 0)
            if weight <= 0:
                weight = 1

            enriched.append({
                **it,
                "source_id": source_id,
                "toc_id": toc_id,
                "title_path": title_path,
                "depth": depth,
                "weight": weight,
                "content": _read_text_safe(rec.get("text_path_main") or rec.get("text_path")),
            })

        # If no topic was provided in plan.json, use the first parent/chapter found.
        overall_topic = str(wobj.get("topic", "") or "").strip()
        if not overall_topic and enriched:
            first_path = enriched[0].get("title_path") or []
            if isinstance(first_path, list) and first_path:
                overall_topic = str(first_path[0])
            else:
                overall_topic = str(enriched[0].get("title", "") or "")

        # --- Build a hierarchical tree from titles_path (per source) ---
        nodes: Dict[Tuple[str, str, Tuple[str, ...]], Dict[str, Any]] = {}
        roots: List[Dict[str, Any]] = []

        for it in enriched:
            source_id = it["source_id"]
            path = _path_key(it.get("title_path"))
            if not source_id or not path:
                continue

            path_to_rec = path_to_rec_by_source.get(source_id, {})
            parent_node: Optional[Dict[str, Any]] = None

            for d in range(1, len(path) + 1):
                subpath = path[:d]
                node = _create_or_get_node(nodes, source_id, subpath, path_to_rec)

                # If this is the terminal node of a selected item, prefer its actual toc_id and weight.
                if d == len(path):
                    if it.get("toc_id"):
                        node["toc_id"] = str(it["toc_id"])
                    if not node.get("content"):
                        node["content"] = it.get("content") or ""
                    # weight_direct should reflect this node's own text (Option A: intro-only)
                    node["weight_direct"] = max(_safe_int(node.get("weight_direct"), 0), _safe_int(it.get("weight"), 0))

                if parent_node is not None:
                    _attach_child(parent_node, node)
                else:
                    # this is a root candidate (depth==1)
                    if node not in roots:
                        roots.append(node)

                parent_node = node

        for r in roots:
            _compute_total_weight(r)

        # Partition roots into decks
        partition_units = [{"node": r, "weight": _safe_int(r.get("total_weight_in_branch"), 1)} for r in roots]

        # --- DEBUG: Print ordered list of topics to console ---
        print("----------------------------------------------------------------")
        print(f"DEBUG: Processing Week {w}. Original Topic Order:")
        for idx, unit in enumerate(partition_units):
            print(f"  {idx + 1}. {unit['node'].get('title', 'Unknown Title')} (Weight: {unit['weight']})")
        print("----------------------------------------------------------------")
        # --------------------------------------------------------

        # Use new sequential partition instead of greedy bin pack
        decks = _partition_sequentially(partition_units, sessions_per_week)

        deck_plans: List[Dict[str, Any]] = []

        weekly_slide_summary = {
            "total_slides_for_week": 0,
            "total_framework_slides": 0,
            "total_content_slides": 0,
            "total_interactive_slides": 0,
            "number_of_decks": len([d for d in decks if d]),
        }
        weekly_time_summary = {
            "total_time_for_week_minutes": 0,
            "total_framework_time": 0,
            "total_content_and_interactive_time": 0,
        }

        for di, deck_units in enumerate(decks, start=1):
            if not deck_units:
                continue

            deck_roots = [u["node"] for u in deck_units]

            # 1) Add interactive activities first (so we can compute remaining time for content)
            interactive_slides = _add_interactive_activities(deck_roots, interactive, interactive_deep)

            # 2) Compute content slide budget from time constraints
            available = max(0, session_total_minutes - TIME_FRAMEWORK)
            remaining_after_interactive = max(0, available - interactive_slides * TIME_PER_INTERACTIVE)
            content_budget = remaining_after_interactive // max(1, TIME_PER_CONTENT)

            # 3) Allocate content budget across deck roots (by total weight)
            root_weights = [_safe_int(r.get("total_weight_in_branch"), 1) for r in deck_roots]
            root_budgets = _largest_remainder_allocation(root_weights, int(content_budget))
            for r, b in zip(deck_roots, root_budgets):
                _allocate_content_slides(r, b)

            # 4) Sum slides & time (bottom-up)
            deck_content_time = 0
            for r in deck_roots:
                _, t = _sum_slides_and_time(r, TIME_PER_CONTENT, TIME_PER_INTERACTIVE)
                deck_content_time += t

            # 5) Assign sequence IDs for framework + content
            week_number = w
            seq_counter = [0]

            title_section = {
                "section_type": "Title",
                "content": {
                    "unit_name": config.get("unit_name", "Course"),
                    "unit_code": config.get("course_id", ""),
                    "week_topic": overall_topic,
                    "deck_title": f"Week {week_number}, Lecture {di}",
                },
            }
            agenda_section = {
                "section_type": "Agenda",
                "content": {"title": "Today's Agenda", "items": [r.get("title", "Untitled Topic") for r in deck_roots]},
            }
            content_section = {
                "section_type": "Content",
                "content_blocks": deck_roots,
            }
            summary_section = {
                "section_type": "Summary",
                "content": {"title": "Summary & Key Takeaways", "placeholder": "Auto-generate based on covered topics."},
            }
            end_section = {
                "section_type": "End",
                "content": {"title": "Thank You", "text": "Questions?"},
            }

            sections = [title_section, agenda_section, content_section, summary_section, end_section]

            for sec in sections:
                if sec.get("section_type") == "Content":
                    for block in sec.get("content_blocks", []) or []:
                        _assign_sequence_ids_recursively(block, seq_counter)
                else:
                    sec["seq_id"] = seq_counter[0]
                    seq_counter[0] += 1

            # 6) Compute deck breakdown
            def count_content_slides(node: Dict[str, Any]) -> int:
                s = _safe_int(node.get("direct_slides_content"), 0)
                for ch in node.get("children", []) or []:
                    s += count_content_slides(ch)
                return s

            def count_interactive_slides(node: Dict[str, Any]) -> int:
                s = _safe_int((node.get("interactive_activity") or {}).get("slides_allocated"), 0)
                for ch in node.get("children", []) or []:
                    s += count_interactive_slides(ch)
                return s

            deck_content_slides = sum(count_content_slides(r) for r in deck_roots)
            deck_interactive_slides = sum(count_interactive_slides(r) for r in deck_roots)
            deck_total_slides = FRAMEWORK_SLIDES_PER_DECK + deck_content_slides + deck_interactive_slides
            deck_total_time = TIME_FRAMEWORK + deck_content_time

            # reorder nodes for output stability
            deck_roots_out = [_reorder_node_keys(r) for r in deck_roots]
            # swap into content section (so seq_id + interactive_activity ordering is preserved but keys are ordered)
            for sec in sections:
                if sec.get("section_type") == "Content":
                    sec["content_blocks"] = deck_roots_out

            deck_plans.append({
                "deck_number": di,
                "slide_count_breakdown": {
                    "framework": FRAMEWORK_SLIDES_PER_DECK,
                    "content": deck_content_slides,
                    "interactive": deck_interactive_slides,
                },
                "time_breakdown_minutes": {
                    "framework": TIME_FRAMEWORK,
                    "content_and_interactive": deck_content_time,
                    "total_deck_time": deck_total_time,
                },
                "sections": sections,
            })

            # weekly accumulators
            weekly_slide_summary["total_framework_slides"] += FRAMEWORK_SLIDES_PER_DECK
            weekly_slide_summary["total_content_slides"] += deck_content_slides
            weekly_slide_summary["total_interactive_slides"] += deck_interactive_slides
            weekly_slide_summary["total_slides_for_week"] += deck_total_slides

            weekly_time_summary["total_framework_time"] += TIME_FRAMEWORK
            weekly_time_summary["total_content_and_interactive_time"] += deck_content_time
            weekly_time_summary["total_time_for_week_minutes"] += deck_total_time

        out_weeks[wk] = {
            "week": w,
            "overall_topic": overall_topic,
            "weekly_slide_summary": weekly_slide_summary,
            "weekly_time_summary_minutes": weekly_time_summary,
            "deck_plans": deck_plans,
        }

        # grand totals
        grand["total_slides_for_unit"] += weekly_slide_summary["total_slides_for_week"]
        grand["total_framework_slides"] += weekly_slide_summary["total_framework_slides"]
        grand["total_content_slides"] += weekly_slide_summary["total_content_slides"]
        grand["total_interactive_slides"] += weekly_slide_summary["total_interactive_slides"]
        grand["total_number_of_decks"] += weekly_slide_summary["number_of_decks"]
        grand["total_time_for_unit_minutes"] += weekly_time_summary["total_time_for_week_minutes"]

    grand["total_time_for_unit_in_hour"] = round(grand["total_time_for_unit_minutes"] / 60.0, 2) if grand["total_time_for_unit_minutes"] else 0
    if grand["total_number_of_decks"]:
        grand["average_deck_time_in_min"] = round(grand["total_time_for_unit_minutes"] / grand["total_number_of_decks"], 2)
        grand["average_deck_time_in_hour"] = round((grand["total_time_for_unit_minutes"] / grand["total_number_of_decks"]) / 60.0, 2)
    else:
        grand["average_deck_time_in_min"] = 0
        grand["average_deck_time_in_hour"] = 0

    return {
        "course_id": config.get("course_id", ""),
        "unit_name": config.get("unit_name", ""),
        "interactive": interactive,
        "interactive_deep": interactive_deep,
        "parameters_slides": params,
        "sessions_per_week": sessions_per_week,
        "session_duration_hours": session_hours,
        "grand_total_summary": grand,
        "weeks": out_weeks,
    }