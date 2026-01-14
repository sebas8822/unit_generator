from __future__ import annotations

import json
import re
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from difflib import SequenceMatcher

import fitz  # PyMuPDF


# ============================================================
# UI extractor (Anchors + Parent Intro + AUTO Subsections + No-ToC structuring)
#
# Writes:
#   out_dir/
#     toc.json (includes toc_tree + augmented_tree)
#     sections.jsonl
#     sections_text/<tree...>/(intro.txt | section.txt | full_with_children.txt)
#
# Backward compatible fields in sections.jsonl:
#   - "text_path" (alias of text_path_main)
#   - "end"       (alias of end_main if present else end_full)
#   - "text_chars"/"text_preview" (aliases of *_main)
# ============================================================

# -----------------------------
# Extraction options
# -----------------------------
SORT_BLOCKS = True
DROP_HEADERS_FOOTERS = True
HEADER_PX = 50.0
FOOTER_PX = 55.0

TITLE_MATCH_RATIO = 0.74
TITLE_SNAP_Y_WINDOW_UP = 120.0
TITLE_SNAP_Y_WINDOW_DOWN = 380.0

ANCHOR_Y_PROX = 90.0
SCORE_SAMPLE_N = 30

MAX_PREVIEW_CHARS = 2500

# Auto subsection discovery within a ToC parent range
DISCOVER_NUMBERED_SUBSECTIONS = True
DISCOVER_ONLY_IF_NO_TOC_CHILDREN = True
MAX_HEADING_LINE_LEN = 140
# Style-based subsection discovery for unnumbered headings (e.g., "Notes", "References", "Conclusion").
# Useful for academic books where only chapters are in the PDF ToC.
DISCOVER_STYLE_SUBHEADINGS = True
STYLE_HEADING_MIN_SIZE_DELTA = 0.9      # heading font size must exceed body by this delta (pt)
STYLE_HEADING_MIN_BOLD_RATIO = 0.65     # or mostly-bold text qualifies
STYLE_HEADING_MAX_WORDS = 14
STYLE_HEADING_MIN_CHARS = 3
STYLE_HEADING_MAX_CHARS = 90
STYLE_HEADING_JOIN_GAP_PX = 8.0         # join wrapped heading lines within this vertical gap
STYLE_HEADING_JOIN_X_TOL = 45.0         # join wrapped lines if x0 is within this tolerance
STYLE_HEADING_JOIN_SIZE_TOL = 0.8       # join wrapped lines if font size is within this tolerance
STYLE_HEADING_MIN_GAP_ABOVE = 10.0      # require extra vertical whitespace above (unless near top-of-page)
STYLE_HEADING_MIN_GAP_BELOW = 8.0       # require whitespace below (unless strong style)
STYLE_HEADING_SINGLE_WORD_WHITELIST = {
    "notes", "references", "conclusion", "introduction", "summary",
    "acknowledgments", "acknowledgements", "bibliography", "appendix",
    "preface", "foreword", "glossary", "index",
}


SUBHEADING_RE = re.compile(r"^\s*(?P<num>\d+(?:\.\d+)+)\.?\s+(?P<title>.+?)\s*$")
TOPHEADING_RE = re.compile(r"^\s*(?P<num>\d+)\.?\s+(?P<title>.+?)\s*$")
BAD_HEADING_PREFIXES = ("fig", "figure", "table", "eq", "equation")

# If PDF has NO ToC, build synthetic section tree from numbered headings
STRUCTURE_WHEN_NO_TOC = True
NO_TOC_MIN_HEADINGS = 5
NO_TOC_MAX_HEADINGS = 600
NO_TOC_MAX_DEPTH = 5


# ============================================================
# Helpers
# ============================================================

def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8", errors="ignore")).hexdigest()

def _norm(s: str) -> str:
    s = (s or "").lower()
    # Handle separators like " | " or " - " commonly found in book titles
    s = s.replace("|", " ").replace("-", " ")
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^\w\s]", "", s)
    return s.strip()

def _slug(s: str, max_len: int = 42) -> str:
    s = (s or "")
    s = s.replace("’", "'")
    s = re.sub(r"\s+", "_", s.strip())
    s = re.sub(r"[^A-Za-z0-9_\-]+", "", s)
    return (s or "untitled")[:max_len]

def _safe_seg(toc_id: int, title: str) -> str:
    h = _sha1(title)[:6]
    return f"toc{toc_id:04d}__{_slug(title)}__{h}"

def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def _clean_toc_title(title: str) -> str:
    """Best-effort cleanup for ToC titles so they match page headings.

    - Drops author suffixes often added after a comma (e.g., ", Jane Doe")
    - Normalizes whitespace
    """
    t = (title or "").strip()
    if "," in t:
        head, tail = t.split(",", 1)
        tail_norm = _norm(tail)
        if len(tail_norm) <= 40 and re.fullmatch(r"[a-z\s\.\-]+", tail_norm or ""):
            t = head.strip()
    t = re.sub(r"\s+", " ", t).strip()
    return t

def _title_match_score(candidate: str, title: str) -> float:
    """Score how well candidate text matches a ToC title (0..1)."""
    c = (candidate or "").strip()
    if not c:
        return 0.0
    t_clean = _clean_toc_title(title)
    s1 = _similar(c, title)
    s2 = _similar(c, t_clean)
    cn, tn = _norm(c), _norm(t_clean)
    incl = 1.0 if (cn and tn and (cn in tn or tn in cn)) else 0.0
    return max(s1, s2, incl)

def _block_list(page: fitz.Page) -> List[Tuple]:
    blocks = page.get_text("blocks", sort=SORT_BLOCKS)
    blocks = [b for b in blocks if b and len(b) >= 5]
    if DROP_HEADERS_FOOTERS:
        h = float(page.rect.height)
        out = []
        for b in blocks:
            y0, y1 = float(b[1]), float(b[3])
            txt = (b[4] or "").strip() if len(b) >= 5 else ""
            if y1 < HEADER_PX:
                continue
            if y0 > (h - FOOTER_PX):
                continue
            # Extra: drop common running-footers even when they sit above FOOTER_PX.
            # Keep this conservative: only near the bottom of the page.
            if txt and y0 > (0.65 * h):
                if re.search(r"\bdoi\s*:", txt, flags=re.IGNORECASE):
                    continue
                if "oxford university press" in _norm(txt):
                    continue
                if "downloaded from" in _norm(txt):
                    continue
            out.append(b)
        blocks = out
    return blocks

def _find_heading_block_y(page: fitz.Page, y_hint: float, title: str) -> Optional[float]:
    """Find a robust heading Y for a ToC entry on a given page.

    Some PDFs (including this book) have unreliable link destinations where the Y coordinate
    can fall outside the page. In those cases, a strict +/- window search misses the heading
    entirely and extraction starts at the bottom of the page.

    Strategy:
      - Treat y_hint as a weak hint. If it's out of range, scan the whole page.
      - Try joining 1..4 adjacent blocks to match multi-line headings.
      - Accept substring matches in either direction (short heading vs long ToC title).
      - Prefer earlier (top-of-page) matches to avoid DOIs/footers.
    """
    blocks = _block_list(page)
    h = float(page.rect.height)

    # If y_hint is invalid (common in this PDF), don't restrict to a narrow window.
    use_window = (y_hint is not None) and (0.0 <= float(y_hint) <= h)
    if use_window:
        y0_min = max(0.0, float(y_hint) - TITLE_SNAP_Y_WINDOW_UP)
        y0_max = min(h, float(y_hint) + TITLE_SNAP_Y_WINDOW_DOWN)
    else:
        y0_min, y0_max = 0.0, h

    # Clean ToC title so it matches page headings better (e.g., drop trailing author after comma).
    t_clean = (title or "").strip()
    if "," in t_clean:
        head, tail = t_clean.split(",", 1)
        tail_norm = _norm(tail)
        if len(tail_norm) <= 40 and re.fullmatch(r"[a-z\s\.\-]+", tail_norm or ""):
            t_clean = head.strip()
    t_clean = re.sub(r"\s+", " ", t_clean).strip()

    def title_match_score(candidate: str) -> float:
        c = (candidate or "").strip()
        if not c:
            return 0.0
        # similarity to raw and cleaned title
        s1 = _similar(c, title)
        s2 = _similar(c, t_clean)
        # inclusion (handles short on-page headings vs long ToC titles)
        cn = _norm(c)
        tn = _norm(t_clean)
        incl = 1.0 if (cn and tn and (cn in tn or tn in cn)) else 0.0
        return max(s1, s2, incl)

    # Flatten blocks (already header/footer filtered)
    blks: List[Tuple[float, float, float, float, str]] = []
    for (x0, y0, x1, y1, text, *rest) in blocks:
        t = (text or "").strip()
        if not t:
            continue
        y0f = float(y0)
        if y0f < y0_min or y0f > y0_max:
            continue
        blks.append((float(x0), y0f, float(x1), float(y1), t))

    # If the window is empty (or too restrictive), fall back to full page scan.
    if use_window and len(blks) < 2:
        blks = []
        for (x0, y0, x1, y1, text, *rest) in blocks:
            t = (text or "").strip()
            if not t:
                continue
            blks.append((float(x0), float(y0), float(x1), float(y1), t))

    if not blks:
        return None

    def consider_span(i: int, k: int) -> Optional[Tuple[float, float, float]]:
        """Return (score_eff, raw_score, y0) for blocks[i:i+k] joined."""
        if i + k > len(blks):
            return None
        x0, y0, _, y1, txt = blks[i]
        parts = [txt.replace("\n", " ")]
        prev_y1 = y1
        for j in range(i + 1, i + k):
            xj0, yj0, _, yj1, t = blks[j]
            # Join only visually contiguous lines/blocks (same column-ish, small vertical gap).
            if abs(xj0 - x0) > 80.0:
                return None
            if yj0 > prev_y1 + 25.0:
                return None
            parts.append(t.replace("\n", " "))
            prev_y1 = yj1

        cand = " ".join(parts).strip()
        raw = title_match_score(cand)
        # Positional bias: prefer upper-page matches.
        pos_bonus = 0.08 * (1.0 - min(1.0, max(0.0, y0 / max(h, 1.0))))
        return raw + pos_bonus, raw, y0

    best_eff = 0.0
    best_raw = 0.0
    best_y: Optional[float] = None

    # Try 1..4 blocks to capture multi-line headings.
    for i in range(len(blks)):
        for k in (1, 2, 3, 4):
            res = consider_span(i, k)
            if res is None:
                continue
            eff, raw, y0 = res
            if eff > best_eff:
                best_eff, best_raw, best_y = eff, raw, y0

    if best_y is not None:
        # Standard check
        if best_raw >= TITLE_MATCH_RATIO:
            return best_y
        # Relaxed check: if we have a very strong substring match (e.g. "Chapter 7" vs "7. Title")
        if best_raw > 0.6: 
             return best_y

    # If we used a narrow window and didn't meet the threshold, do a full-page scan with a
    # slightly more forgiving threshold.
    if use_window:
        all_blks = []
        for (x0, y0, x1, y1, text, *rest) in blocks:
            t = (text or "").strip()
            if t:
                all_blks.append((float(x0), float(y0), float(x1), float(y1), t))
        blks = all_blks

        best_eff = 0.0
        best_raw = 0.0
        best_y = None
        for i in range(len(blks)):
            for k in (1, 2, 3, 4):
                res = consider_span(i, k)
                if res is None:
                    continue
                eff, raw, y0 = res
                if eff > best_eff:
                    best_eff, best_raw, best_y = eff, raw, y0
        if best_y is not None and best_raw >= max(0.65, TITLE_MATCH_RATIO - 0.05):
            return best_y

    return None

    best = None
    best_score = 0.0
    for (x0, y0, x1, y1, text, *rest) in blocks:
        y0f = float(y0)
        if y0f < y0_min or y0f > y0_max:
            continue
        t = (text or "").strip()
        if not t:
            continue
        score = max(_similar(t, title), 1.0 if _norm(title) in _norm(t) else 0.0)
        if score > best_score:
            best_score = score
            best = y0f

    if best is not None and best_score >= TITLE_MATCH_RATIO:
        return best
    return None

def _extract_blocks_between(page: fitz.Page, y_start: float, y_end: Optional[float]) -> str:
    h = float(page.rect.height)
    y_start = max(0.0, min(y_start, h))
    if y_end is not None:
        y_end = max(0.0, min(y_end, h))
        if y_end <= y_start:
            return ""

    blocks = _block_list(page)
    out: List[str] = []
    for (x0, y0, x1, y1, text, *rest) in blocks:
        y0f, y1f = float(y0), float(y1)
        if y1f <= y_start:
            continue
        if y_end is not None and y0f >= y_end:
            continue
        t = (text or "").strip()
        if t:
            out.append(t)

    joined = "\n".join(out)
    joined = re.sub(r"\n{3,}", "\n\n", joined).strip()
    return joined

def _extract_range(
    doc: fitz.Document,
    start_page0: int,
    start_y: float,
    end_page0: Optional[int],
    end_y: Optional[float],
) -> str:
    n_pages = doc.page_count
    start_page0 = max(0, min(start_page0, n_pages - 1))

    if end_page0 is None:
        end_page0 = n_pages - 1
        end_y = None
    else:
        end_page0 = max(0, min(end_page0, n_pages - 1))

    if end_page0 < start_page0:
        end_page0 = start_page0
        end_y = None

    parts: List[str] = []
    if start_page0 == end_page0:
        parts.append(_extract_blocks_between(doc.load_page(start_page0), start_y, end_y))
    else:
        parts.append(_extract_blocks_between(doc.load_page(start_page0), start_y, None))
        for p in range(start_page0 + 1, end_page0):
            parts.append(_extract_blocks_between(doc.load_page(p), 0.0, None))
        parts.append(_extract_blocks_between(doc.load_page(end_page0), 0.0, end_y))

    text = "\n\n".join([p for p in parts if p.strip()]).strip()
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text

def _boundary_check(section_text: str, this_title: str, next_title: Optional[str]) -> Dict[str, Any]:
    head = (section_text or "")[:1800]
    ok_start = (_norm(this_title) in _norm(head)) or (_similar(head, this_title) >= 0.35)
    ok_end = True
    if next_title:
        ok_end = (_norm(next_title) not in _norm(head))
    return {"ok_start": bool(ok_start), "ok_end": bool(ok_end)}


# ============================================================
# ToC extraction + coordinate orientation selection
# ============================================================

def _get_detailed_toc(doc: fitz.Document) -> List[List[Any]]:
    return doc.get_toc(simple=False)

def _to_y_float(to: Any) -> float:
    if to is None:
        return 0.0
    if hasattr(to, "y"):
        return float(getattr(to, "y", 0.0))
    if isinstance(to, (list, tuple)) and len(to) >= 2:
        try:
            return float(to[1])
        except Exception:
            return 0.0
    return 0.0

def _score_orientation(doc: fitz.Document, toc_items: List[List[Any]], flip_y: bool) -> int:
    score = 0
    cache_blocks: Dict[int, List[Tuple]] = {}

    for row in toc_items[:SCORE_SAMPLE_N]:
        if len(row) < 4:
            continue
        title, page1, dest = row[1], row[2], row[3]
        if not isinstance(dest, dict):
            continue
        p0 = int(dest.get("page", (page1 - 1 if isinstance(page1, int) else 0)))
        if p0 < 0 or p0 >= doc.page_count:
            continue

        to = dest.get("to", None)
        if to is None:
            continue

        page = doc.load_page(p0)
        h = float(page.rect.height)
        y = _to_y_float(to)
        y = (h - y) if flip_y else y

        if p0 not in cache_blocks:
            cache_blocks[p0] = _block_list(page)

        title_s = (title or "").strip()
        if not title_s:
            continue

        found = False
        for (x0, y0, x1, y1, text, *rest) in cache_blocks[p0]:
            if abs(float(y0) - y) > ANCHOR_Y_PROX:
                continue
            t = (text or "").strip()
            if not t:
                continue
            if _norm(title_s) in _norm(t) or _similar(t, title_s) >= TITLE_MATCH_RATIO:
                found = True
                break

        if found:
            score += 1

    return score

def _build_tree(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_id = {e["toc_id"]: {k: e[k] for k in e.keys() if k not in ("parent_toc_id",)} for e in entries}
    root: List[Dict[str, Any]] = []
    for e in entries:
        node = by_id[e["toc_id"]]
        node["children"] = []
        pid = e.get("parent_toc_id")
        if pid is None:
            root.append(node)
        else:
            parent = by_id.get(pid)
            if parent is not None:
                parent["children"].append(node)
    return root

def _anchor_of_entry(e: Dict[str, Any]) -> Tuple[int, float]:
    return int(e["page_0based"]), float(e.get("y_snapped", e.get("y", 0.0)))

def _compute_end_anchors(entries: List[Dict[str, Any]], doc: fitz.Document) -> None:
    n = len(entries)
    for i in range(n):
        cur = entries[i]
        cur_lvl = int(cur["level"])

        end_full: Optional[Tuple[int, float]] = None
        next_peer_title: Optional[str] = None
        for j in range(i + 1, n):
            nxt = entries[j]
            if int(nxt["level"]) <= cur_lvl:
                end_full = _anchor_of_entry(nxt)
                next_peer_title = nxt["title"]
                break

        cur["end_full"] = end_full
        cur["next_peer_title"] = next_peer_title or ""

        kids = cur.get("children_toc_ids", [])
        if kids:
            first_child = next((x for x in entries if x["toc_id"] == kids[0]), None)
            cur["end_intro"] = _anchor_of_entry(first_child) if first_child else end_full
        else:
            cur["end_intro"] = end_full

def _build_entries_with_paths_and_anchors(doc: fitz.Document) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], bool]:
    toc_items = _get_detailed_toc(doc)
    if not toc_items:
        return [], [], False

    raw_score = _score_orientation(doc, toc_items, flip_y=False)
    flip_score = _score_orientation(doc, toc_items, flip_y=True)
    flip_y = (flip_score > raw_score)

    entries: List[Dict[str, Any]] = []
    stack_titles: List[str] = []
    stack_ids: List[int] = []

    toc_id = 0
    for row in toc_items:
        if len(row) < 3:
            continue
        lvl, title, page1 = row[0], row[1], row[2]
        dest = row[3] if len(row) >= 4 else None

        if not isinstance(lvl, int) or lvl < 1:
            continue
        title = (title or "").strip()
        if not title:
            continue
        if not isinstance(page1, int) or page1 < 1 or page1 > doc.page_count:
            continue

        if isinstance(dest, dict) and "page" in dest:
            page0 = int(dest["page"])
        else:
            page0 = page1 - 1
        page0 = max(0, min(page0, doc.page_count - 1))

        page = doc.load_page(page0)
        h = float(page.rect.height)

        y = 0.0
        if isinstance(dest, dict) and dest.get("to", None) is not None:
            y = _to_y_float(dest["to"])
            if flip_y:
                y = (h - y)

        level0 = lvl - 1

        stack_titles = stack_titles[:level0]
        stack_ids = stack_ids[:level0]
        parent_toc_id = stack_ids[-1] if stack_ids else None

        stack_titles.append(title)
        stack_ids.append(toc_id)

        e = {
            "toc_id": toc_id,
            "level": level0,
            "title": title,
            "titles_path": stack_titles.copy(),
            "toc_path_ids": stack_ids.copy(),
            "parent_toc_id": parent_toc_id,
            "page_0based": page0,
            "page_1based": page0 + 1,
            "y": float(y),
            "synthetic": False,
        }
        entries.append(e)
        toc_id += 1

    entries.sort(key=lambda e: (e["page_0based"], e["y"], e["toc_id"]))

    by_id = {e["toc_id"]: e for e in entries}
    children_map: Dict[int, List[int]] = {}
    for e in entries:
        pid = e.get("parent_toc_id")
        if pid is not None:
            children_map.setdefault(int(pid), []).append(int(e["toc_id"]))
    for pid, kids in children_map.items():
        kids.sort()
        by_id[pid]["children_toc_ids"] = kids
        by_id[pid]["first_child_toc_id"] = kids[0]

    # --- FIX: Sanitize Invalid Coordinates ---
    for e in entries:
        p0 = e["page_0based"]
        page = doc.load_page(p0)
        h = page.rect.height
        
        # 1. Try to find the actual text on page (Snap)
        snapped = _find_heading_block_y(page, e["y"], e["title"])
        
        if snapped is not None:
            e["y_snapped"] = float(snapped)
        else:
            # 2. If Snap failed, check if the original coordinate is garbage (off-page)
            orig_y = float(e["y"])
            if orig_y < 0 or orig_y > h:
                # If invalid, safe default is TOP of page (0.0)
                # This ensures we don't skip the content on this page.
                e["y_snapped"] = 0.0
            else:
                # If valid but unmatched, trust the PDF's coordinate
                e["y_snapped"] = orig_y

    return entries, _build_tree(entries), flip_y


# ============================================================
# Numbered subheadings discovery (dict lines + bbox)
# ============================================================

def _span_is_bold(sp: Dict[str, Any]) -> bool:
    """Best-effort bold detection for a text span."""
    font = (sp.get("font") or "").lower()
    if "bold" in font:
        return True
    flags = int(sp.get("flags") or 0)
    # PyMuPDF uses font flags; 16 is commonly bold (not guaranteed across all PDFs).
    if flags & 16:
        return True
    return False

def _estimate_body_font_size(page: fitz.Page) -> float:
    """Estimate the body font size for a page (used to detect style headings).

    We take a robust median of span sizes for spans that look like body text:
    - sufficiently long
    - mostly not bold
    - not in header/footer
    """
    try:
        d = page.get_text("dict")
    except Exception:
        return 10.5

    h = float(page.rect.height)
    sizes: List[float] = []

    for b in d.get("blocks", []):
        if b.get("type", 0) != 0:
            continue
        for ln in b.get("lines", []):
            bbox = ln.get("bbox", None)
            if not bbox or len(bbox) != 4:
                continue
            x0, y0, x1, y1 = map(float, bbox)

            if DROP_HEADERS_FOOTERS:
                if y1 < HEADER_PX:
                    continue
                if y0 > (h - FOOTER_PX):
                    continue

            spans = ln.get("spans", []) or []
            # text length heuristic
            txt = "".join([(sp.get("text") or "") for sp in spans]).strip()
            txt = re.sub(r"\s+", " ", txt).strip()
            if len(txt) < 25:
                continue

            # ignore mostly-bold lines (often headings)
            total_chars = 0
            bold_chars = 0
            max_size = 0.0
            for sp in spans:
                t = (sp.get("text") or "")
                n = len(t)
                if n == 0:
                    continue
                total_chars += n
                if _span_is_bold(sp):
                    bold_chars += n
                try:
                    max_size = max(max_size, float(sp.get("size") or 0.0))
                except Exception:
                    pass
            if total_chars == 0:
                continue
            bold_ratio = bold_chars / max(total_chars, 1)
            if bold_ratio >= 0.55:
                continue
            if max_size > 0:
                sizes.append(max_size)

    if not sizes:
        return 10.5

    sizes.sort()
    mid = len(sizes) // 2
    return float(sizes[mid])

def _iter_lines_with_style(page: fitz.Page) -> List[Tuple[float, float, float, float, str, float, float, bool]]:
    """Return page lines with bbox + style metrics: (x0,y0,x1,y1,text,max_size,bold_ratio,is_all_caps)."""
    d = page.get_text("dict")
    lines_out: List[Tuple[float, float, float, float, str, float, float, bool]] = []
    h = float(page.rect.height)

    for b in d.get("blocks", []):
        if b.get("type", 0) != 0:
            continue
        for ln in b.get("lines", []):
            bbox = ln.get("bbox", None)
            if not bbox or len(bbox) != 4:
                continue
            x0, y0, x1, y1 = map(float, bbox)

            if DROP_HEADERS_FOOTERS:
                if y1 < HEADER_PX:
                    continue
                if y0 > (h - FOOTER_PX):
                    continue

            spans = ln.get("spans", []) or []
            txt = "".join([(sp.get("text") or "") for sp in spans]).strip()
            txt = re.sub(r"\s+", " ", txt).strip()
            if not txt:
                continue

            total_chars = 0
            bold_chars = 0
            max_size = 0.0
            for sp in spans:
                t = (sp.get("text") or "")
                n = len(t)
                if n == 0:
                    continue
                total_chars += n
                if _span_is_bold(sp):
                    bold_chars += n
                try:
                    max_size = max(max_size, float(sp.get("size") or 0.0))
                except Exception:
                    pass
            bold_ratio = (bold_chars / max(total_chars, 1)) if total_chars else 0.0

            letters = re.sub(r"[^A-Za-z]+", "", txt)
            is_all_caps = bool(letters) and (letters.upper() == letters)

            lines_out.append((x0, y0, x1, y1, txt, float(max_size), float(bold_ratio), bool(is_all_caps)))

    # reading order
    lines_out.sort(key=lambda t: (t[1], t[0]))
    return lines_out

def _looks_like_style_heading(text: str, max_size: float, bold_ratio: float, body_size: float, is_all_caps: bool) -> bool:
    """Heuristic: decide if a line looks like an unnumbered subheading.

    Goal: catch headings like 'Notes' / 'References' while avoiding reference entries,
    running heads, and emphasized words inside prose.
    """
    t = (text or "").strip()
    if not t:
        return False
    if len(t) < STYLE_HEADING_MIN_CHARS:
        return False
    if len(t) > max(STYLE_HEADING_MAX_CHARS, MAX_HEADING_LINE_LEN):
        return False

    low = t.lower().strip()
    if any(low.startswith(pref) for pref in BAD_HEADING_PREFIXES):
        return False

    if t.startswith("(") or t.startswith("["):
        return False

    # Avoid typical non-heading punctuation patterns
    if t.endswith(".") or t.endswith(";"):
        return False
    if re.search(r"[,)\u201d\u2019]\s*$", t):  # many reference lines end with comma or ')'
        return False
    if re.search(r"[\.!?]\s+[A-Z]", t):  # multiple sentences
        return False

    # Avoid URLs / DOI-ish
    if "http" in low or "www" in low or "doi" in low:
        return False

    # Avoid lines that look like "Title:123" or "word.133" (page/footnote markers)
    if re.search(r"[\.:]\s*\d{1,4}$", t):
        return False

    # Avoid pure numbers / page artifacts
    if re.fullmatch(r"\d{1,4}", t):
        return False

    # Avoid pure roman numerals (often front-matter page numbering)
    if re.fullmatch(r"[ivxlcdm]{2,8}", low):
        return False

    words = t.split()
    if len(words) > STYLE_HEADING_MAX_WORDS:
        return False

    # single-word headings like Notes/References (but avoid months like 'May')
    if len(words) == 1:
        if len(t) < 4:
            # allow very short only if strongly heading-styled
            return (is_all_caps and (max_size >= body_size + 1.2) and (bold_ratio >= 0.75))

        months = {"january","february","march","april","may","june","july","august","september","october","november","december"}
        if low in months:
            return False

        if not (t[:1].isupper() or is_all_caps):
            return False
        if (not is_all_caps) and (low not in STYLE_HEADING_SINGLE_WORD_WHITELIST):
            return False
        if (bold_ratio >= 0.45) or (max_size >= body_size) or is_all_caps:
            return True

    # Reject headings that end with a trailing stop-word (often a wrapped sentence)
    tail_stop = {"a","an","the","and","or","of","to","in","on","for","with","by","as","at","from"}
    if words and words[-1].lower().strip(",:;") in tail_stop:
        return False

    # If digits appear, demand stronger style (to avoid dates/page headers in refs)
    if re.search(r"\d", t):
        if not ((bold_ratio >= 0.85) or (max_size >= body_size + 1.6)):
            return False

    # primary thresholds
    if max_size >= (body_size + STYLE_HEADING_MIN_SIZE_DELTA):
        return True
    if (bold_ratio >= STYLE_HEADING_MIN_BOLD_RATIO) and (max_size >= (body_size - 0.1)):
        return True
    if is_all_caps and (max_size >= (body_size + 0.3)):
        return True

    return False

def _iter_lines_with_bbox(page: fitz.Page) -> List[Tuple[float, float, float, float, str]]:
    d = page.get_text("dict")
    lines_out: List[Tuple[float, float, float, float, str]] = []
    h = float(page.rect.height)

    for b in d.get("blocks", []):
        if b.get("type", 0) != 0:
            continue
        for ln in b.get("lines", []):
            bbox = ln.get("bbox", None)
            if not bbox or len(bbox) != 4:
                continue
            x0, y0, x1, y1 = map(float, bbox)

            if DROP_HEADERS_FOOTERS:
                if y1 < HEADER_PX:
                    continue
                if y0 > (h - FOOTER_PX):
                    continue

            spans = ln.get("spans", [])
            txt = "".join([(sp.get("text") or "") for sp in spans]).strip()
            txt = re.sub(r"\s+", " ", txt).strip()
            if txt:
                lines_out.append((x0, y0, x1, y1, txt))
    return lines_out

def _extract_number_prefix_from_title(title: str) -> Optional[str]:
    m = re.match(r"^\s*(\d+(?:\.\d+)*)\b", title or "")
    return m.group(1) if m else None

def _find_numbered_subheadings_in_range(
    doc: fitz.Document,
    start_anchor: Tuple[int, float],
    end_anchor: Optional[Tuple[int, float]],
    parent_prefix: Optional[str],
    parent_title: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Discover subheadings inside a parent range.

    Primary signal: dotted numbering (e.g., 3.2.1 Title).
    Secondary signal (optional): style-based unnumbered headings (e.g., Notes, References),
    detected using font size and boldness relative to the page's body text, plus spacing cues.
    """
    s_p0, s_y = start_anchor
    if end_anchor is None:
        e_p0, e_y = (doc.page_count - 1, None)
    else:
        e_p0, e_y = (end_anchor[0], end_anchor[1])

    cands: List[Dict[str, Any]] = []
    seen = set()

    for p0 in range(s_p0, e_p0 + 1):
        page = doc.load_page(p0)
        page_h = float(page.rect.height)
        body_size = _estimate_body_font_size(page)
        lines = _iter_lines_with_style(page)

        prev_y1: Optional[float] = None

        i = 0
        while i < len(lines):
            x0, y0, x1, y1, line, max_size, bold_ratio, is_all_caps = lines[i]

            # range bounds
            if p0 == s_p0 and y1 <= s_y:
                i += 1
                continue
            if end_anchor is not None and p0 == e_p0 and e_y is not None and y0 >= e_y:
                i += 1
                continue

            gap_above = 999.0 if prev_y1 is None else float(y0) - float(prev_y1)
            prev_y1 = float(y1)

            if len(line) > MAX_HEADING_LINE_LEN:
                i += 1
                continue

            low = line.lower().strip()
            if any(low.startswith(pref) for pref in BAD_HEADING_PREFIXES):
                i += 1
                continue

            # 1) Numbered headings
            m = SUBHEADING_RE.match(line)
            if m:
                num = m.group("num").strip()
                ttl = m.group("title").strip()

                if parent_prefix:
                    must = parent_prefix + "."
                    if not num.startswith(must):
                        i += 1
                        continue

                key = f"{p0}|{round(y0,1)}|numbered|{num}|{_norm(ttl)}"
                if key not in seen:
                    seen.add(key)
                    cands.append({
                        "kind": "numbered",
                        "num": num,
                        "title": ttl,
                        "page_0based": p0,
                        "page_1based": p0 + 1,
                        "y": float(y0),
                    })
                i += 1
                continue

            # 2) Style-based unnumbered headings
            if DISCOVER_STYLE_SUBHEADINGS:
                merged_text = line
                merged_y0 = float(y0)
                merged_y1 = float(y1)
                merged_max_size = float(max_size)
                merged_bold_ratio = float(bold_ratio)
                merged_all_caps = bool(is_all_caps)

                j = i

                # try to merge wrapped heading lines
                maybe_headingish = (bold_ratio >= 0.55) or (max_size >= (body_size + 0.6)) or is_all_caps
                if maybe_headingish:
                    while (j + 1) < len(lines):
                        nx0, ny0, nx1, ny1, ntext, nsize, nbold, nallcaps = lines[j + 1]
                        if (float(ny0) - merged_y1) > STYLE_HEADING_JOIN_GAP_PX:
                            break
                        if abs(float(nx0) - float(x0)) > STYLE_HEADING_JOIN_X_TOL:
                            break
                        if abs(float(nsize) - merged_max_size) > STYLE_HEADING_JOIN_SIZE_TOL:
                            break
                        if len(merged_text) + 1 + len(ntext) > MAX_HEADING_LINE_LEN:
                            break
                        merged_text = (merged_text + " " + ntext).strip()
                        merged_y1 = float(ny1)
                        merged_max_size = max(merged_max_size, float(nsize))
                        merged_bold_ratio = max(merged_bold_ratio, float(nbold))
                        merged_all_caps = merged_all_caps or bool(nallcaps)
                        j += 1

                # reject likely running heads (page number + title near top)
                if merged_y0 < (HEADER_PX + 65.0) and re.match(r"^\d+\s+\S", merged_text.strip()):
                    i = j + 1
                    continue


                # Avoid capturing running heads like repeated chapter titles near the top
                if merged_y0 < (HEADER_PX + 90.0):
                    strong_top_style = (merged_max_size >= body_size + 1.2) or (merged_bold_ratio >= 0.92)
                    if not strong_top_style:
                        i = j + 1
                        continue

                # require whitespace above for mid-page style headings (helps avoid refs)
                near_top = merged_y0 < max(HEADER_PX + 25.0, 0.22 * page_h)
                if (not near_top) and (gap_above < STYLE_HEADING_MIN_GAP_ABOVE):
                    i = j + 1
                    continue

                # also require whitespace below for mid-page headings unless very strongly styled
                gap_below = 999.0
                if (j + 1) < len(lines):
                    gap_below = float(lines[j + 1][1]) - float(merged_y1)
                strong_style = (merged_max_size >= body_size + 1.4) or (merged_bold_ratio >= 0.92)
                if (not near_top) and (not strong_style) and (gap_below < STYLE_HEADING_MIN_GAP_BELOW):
                    i = j + 1
                    continue

                if _looks_like_style_heading(merged_text, merged_max_size, merged_bold_ratio, body_size, merged_all_caps):
                    if parent_title and _title_match_score(merged_text, parent_title) >= 0.82:
                        i = j + 1
                        continue

                    ttl = merged_text.strip()
                    key = f"{p0}|{round(merged_y0,1)}|style|{_norm(ttl)}"
                    if key not in seen:
                        seen.add(key)
                        cands.append({
                            "kind": "style",
                            "num": "",
                            "title": ttl,
                            "page_0based": p0,
                            "page_1based": p0 + 1,
                            "y": float(merged_y0),
                        })

                    i = j + 1
                    continue

            i += 1

    cands.sort(key=lambda x: (x["page_0based"], x["y"]))
    return cands


# ============================================================
# No-ToC structuring from numbered headings
# ============================================================

def _scan_numbered_headings_whole_doc(doc: fitz.Document) -> List[Dict[str, Any]]:
    cands: List[Dict[str, Any]] = []
    seen = set()

    for p0 in range(doc.page_count):
        page = doc.load_page(p0)
        for (x0, y0, x1, y1, line) in _iter_lines_with_bbox(page):
            if len(line) > MAX_HEADING_LINE_LEN:
                continue

            low = line.lower().strip()
            if any(low.startswith(pref) for pref in BAD_HEADING_PREFIXES):
                continue

            m = SUBHEADING_RE.match(line)
            if not m:
                m = TOPHEADING_RE.match(line)
            if not m:
                continue

            num = m.group("num").strip()
            ttl = m.group("title").strip()

            depth = num.count(".")
            if depth > NO_TOC_MAX_DEPTH:
                continue
            if not ttl or len(ttl) < 2:
                continue

            key = f"{p0}|{round(y0,1)}|{num}|{_norm(ttl)}"
            if key in seen:
                continue
            seen.add(key)

            cands.append({
                "num": num,
                "title": ttl,
                "page_0based": p0,
                "page_1based": p0 + 1,
                "y": float(y0),
            })

            if len(cands) >= NO_TOC_MAX_HEADINGS:
                break

    cands.sort(key=lambda x: (x["page_0based"], x["y"]))
    return cands

def _build_entries_from_numbered_headings(cands: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    entries: List[Dict[str, Any]] = []
    stack_titles: List[str] = []
    stack_ids: List[int] = []

    for toc_id, h in enumerate(cands):
        num = h["num"]
        ttl = h["title"]
        level = num.count(".")

        stack_titles = stack_titles[:level]
        stack_ids = stack_ids[:level]
        parent_toc_id = stack_ids[-1] if stack_ids else None

        full_title = f"{num} {ttl}".strip()
        stack_titles.append(full_title)
        stack_ids.append(toc_id)

        entries.append({
            "toc_id": toc_id,
            "level": level,
            "title": full_title,
            "titles_path": stack_titles.copy(),
            "toc_path_ids": stack_ids.copy(),
            "parent_toc_id": parent_toc_id,
            "page_0based": h["page_0based"],
            "page_1based": h["page_1based"],
            "y": float(h["y"]),
            "y_snapped": float(h["y"]),
            "synthetic": True,
            "synthetic_source": "text_numbered_headings",
            "synthetic_num": num,
        })

    by_id = {e["toc_id"]: e for e in entries}
    children_map: Dict[int, List[int]] = {}
    for e in entries:
        pid = e.get("parent_toc_id")
        if pid is not None:
            children_map.setdefault(int(pid), []).append(int(e["toc_id"]))
    for pid, kids in children_map.items():
        kids.sort()
        by_id[pid]["children_toc_ids"] = kids
        by_id[pid]["first_child_toc_id"] = kids[0]

    tree = _build_tree(entries)
    return entries, tree


# ============================================================
# Main entry: extract for UI
# ============================================================

def _build_tree(flat: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_id = {e["toc_id"]: {k: e[k] for k in e.keys() if k not in ("parent_toc_id",)} for e in flat}
    root: List[Dict[str, Any]] = []
    for e in flat:
        node = by_id[e["toc_id"]]
        node.setdefault("children", [])
        pid = e.get("parent_toc_id")
        if pid is None:
            root.append(node)
        else:
            parent = by_id.get(pid)
            if parent is not None:
                parent.setdefault("children", []).append(node)
    return root

def extract_pdf_for_ui(
    pdf_path: Path,
    out_dir: Path,
    source_id: str,
    work_id: str,
    unit_code: str,
) -> Dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    sections_text_dir = out_dir / "sections_text"
    sections_text_dir.mkdir(parents=True, exist_ok=True)

    toc_json_path = out_dir / "toc.json"
    sections_jsonl_path = out_dir / "sections.jsonl"

    info = {
        "unit": unit_code,
        "work_id": work_id,
        "source_id": source_id,
        "source_file": pdf_path.name,
        "pdf_path": str(pdf_path),
    }

    structured_from_text_headings = False

    with fitz.open(str(pdf_path)) as doc:
        info["page_count"] = doc.page_count

        # 1) Try real PDF ToC/bookmarks
        entries, toc_tree, flip_y = _build_entries_with_paths_and_anchors(doc)

        # 2) If no ToC: optionally structure from numbered headings
        if not entries and STRUCTURE_WHEN_NO_TOC:
            cands = _scan_numbered_headings_whole_doc(doc)
            if len(cands) >= NO_TOC_MIN_HEADINGS:
                entries, toc_tree = _build_entries_from_numbered_headings(cands)
                flip_y = False
                structured_from_text_headings = True

        # CASE A: no entries → fallback per-page export
        if not entries:
            doc_kind = "publication"
            flip_y_used = bool(flip_y)
            toc_payload = {
                "info": info,
                "doc_kind": doc_kind,
                "toc_entries_count": 0,
                "flip_y_used": flip_y_used,
                "structured_from_text_headings": False,
                "toc_tree": [],
                "flat_entries": [],
                "augmented_entries_count": 0,
                "augmented_tree": [],
                "augmented_flat_entries": [],
                "sections_jsonl": str(sections_jsonl_path),
                "sections_written": 0,
                "warnings": 0,
            }
            toc_json_path.write_text(json.dumps(toc_payload, ensure_ascii=False, indent=2), encoding="utf-8")

            written = 0
            warnings = 0
            with open(sections_jsonl_path, "w", encoding="utf-8") as f:
                for pno in range(doc.page_count):
                    text = doc.load_page(pno).get_text("text", sort=True).strip()
                    if not text:
                        continue

                    seg = f"page_{pno+1:04d}"
                    leaf_dir = sections_text_dir / seg
                    leaf_dir.mkdir(parents=True, exist_ok=True)
                    txt_path = leaf_dir / "section.txt"
                    txt_path.write_text(text, encoding="utf-8")

                    rec = {
                        **info,
                        "doc_kind": doc_kind,
                        "flip_y_used": flip_y_used,
                        "structured_from_text_headings": False,

                        "toc_id": pno,
                        "level": 0,
                        "title": f"Page {pno+1}",
                        "titles_path": [f"Page {pno+1}"],
                        "toc_path_ids": [pno],
                        "parent_toc_id": None,

                        "has_children_effective": False,
                        "has_toc_children": False,
                        "auto_children_count": 0,

                        "start": {"page_0based": pno, "page_1based": pno + 1, "y": 0.0},
                        "end_main": {"page_0based": pno, "page_1based": pno + 1, "y": None},
                        "end_full": {"page_0based": pno, "page_1based": pno + 1, "y": None},
                        "end": {"page_0based": pno, "page_1based": pno + 1, "y": None},  # legacy alias

                        "synthetic": True,
                        "synthetic_source": "per_page_fallback",

                        "text_path_main": str(txt_path),
                        "text_path_full_with_children": str(txt_path),
                        "text_path": str(txt_path),  # legacy alias

                        "text_chars_main": len(text),
                        "text_words_main": len(text.split()) if text else 0,
                        "text_preview_main": text[:MAX_PREVIEW_CHARS],
                        "text_chars": len(text),                 # legacy alias
                        "text_preview": text[:MAX_PREVIEW_CHARS],# legacy alias

                        "next_peer_title": "",
                        "ok_start": True,
                        "ok_end": True,
                    }
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    written += 1

            toc_payload["toc_entries_count"] = written
            toc_payload["sections_written"] = written
            toc_payload["warnings"] = warnings
            toc_payload["flat_entries"] = []
            toc_payload["toc_tree"] = []
            toc_payload["augmented_entries_count"] = written
            toc_payload["augmented_flat_entries"] = []
            toc_payload["augmented_tree"] = []
            toc_json_path.write_text(json.dumps(toc_payload, ensure_ascii=False, indent=2), encoding="utf-8")

            return {
                **info,
                "doc_kind": doc_kind,
                "toc_entries_count": written,
                "sections_written": written,
                "warnings": warnings,
                "flip_y_used": flip_y_used,
                "structured_from_text_headings": False,
                "toc_json": str(toc_json_path),
                "sections_jsonl": str(sections_jsonl_path),
                "toc_tree": [],
                "augmented_tree": [],
            }

        # CASE B: entries exist
        _compute_end_anchors(entries, doc)
        doc_kind = "book" if (not structured_from_text_headings and len(entries) >= 6) else "publication"
        flip_y_used = bool(flip_y)

        augmented_entries: List[Dict[str, Any]] = [dict(e) for e in entries]
        next_toc_id = max(e["toc_id"] for e in entries) + 1

        written = 0
        warnings = 0

        with open(sections_jsonl_path, "w", encoding="utf-8") as f:
            for e in entries:
                toc_id = int(e["toc_id"])
                title = e["title"]
                titles_path = e["titles_path"]
                toc_path_ids = e["toc_path_ids"]
                level = int(e["level"])

                cur_dir = sections_text_dir
                for aid, atitle in zip(toc_path_ids, titles_path):
                    cur_dir = cur_dir / _safe_seg(int(aid), atitle)
                cur_dir.mkdir(parents=True, exist_ok=True)

                start_anchor = _anchor_of_entry(e)
                end_full = e.get("end_full", None)

                toc_children = e.get("children_toc_ids", [])
                has_toc_children = bool(toc_children)

                discovered: List[Dict[str, Any]] = []
                if (not structured_from_text_headings) and DISCOVER_NUMBERED_SUBSECTIONS and (not DISCOVER_ONLY_IF_NO_TOC_CHILDREN or not has_toc_children):
                    parent_prefix = _extract_number_prefix_from_title(title)
                    discovered = _find_numbered_subheadings_in_range(
                        doc=doc,
                        start_anchor=start_anchor,
                        end_anchor=end_full,
                        parent_prefix=parent_prefix,
                        parent_title=title
                    )

                use_auto_children = (len(discovered) > 0) and (not has_toc_children)

                if use_auto_children:
                    first = discovered[0]
                    end_intro = (first["page_0based"], first["y"])
                    has_children_effective = True
                else:
                    end_intro = e.get("end_intro", end_full)
                    has_children_effective = has_toc_children

                # main text (intro if parent-effective, else leaf full)
                if has_children_effective:
                    if end_intro is None:
                        main_text = _extract_range(doc, start_anchor[0], start_anchor[1], None, None)
                    else:
                        main_text = _extract_range(doc, start_anchor[0], start_anchor[1], end_intro[0], end_intro[1])
                    main_path = cur_dir / "intro.txt"
                else:
                    if end_full is None:
                        main_text = _extract_range(doc, start_anchor[0], start_anchor[1], None, None)
                    else:
                        main_text = _extract_range(doc, start_anchor[0], start_anchor[1], end_full[0], end_full[1])
                    main_path = cur_dir / "section.txt"

                main_text = (main_text or "").strip()
                if main_text:
                    main_path.write_text(main_text, encoding="utf-8")

                # full-with-children
                if end_full is None:
                    full_with_children_txt = _extract_range(doc, start_anchor[0], start_anchor[1], None, None)
                else:
                    full_with_children_txt = _extract_range(doc, start_anchor[0], start_anchor[1], end_full[0], end_full[1])
                full_with_children_txt = (full_with_children_txt or "").strip()

                full_path = cur_dir / "full_with_children.txt"
                if full_with_children_txt:
                    full_path.write_text(full_with_children_txt, encoding="utf-8")

                next_peer_title = (e.get("next_peer_title") or "").strip()
                checks = _boundary_check(main_text, title, next_peer_title if next_peer_title else None)
                if not (checks["ok_start"] and checks["ok_end"]):
                    warnings += 1

                end_main_obj = None if end_intro is None else {"page_0based": end_intro[0], "page_1based": end_intro[0] + 1, "y": end_intro[1]}
                end_full_obj = None if end_full is None else {"page_0based": end_full[0], "page_1based": end_full[0] + 1, "y": end_full[1]}
                legacy_end = end_main_obj or end_full_obj  # for older code paths

                rec = {
                    **info,
                    "doc_kind": doc_kind,
                    "flip_y_used": flip_y_used,
                    "structured_from_text_headings": structured_from_text_headings,

                    "toc_id": toc_id,
                    "level": level,
                    "title": title,
                    "titles_path": titles_path,
                    "toc_path_ids": toc_path_ids,
                    "parent_toc_id": e.get("parent_toc_id"),

                    "start": {"page_0based": start_anchor[0], "page_1based": start_anchor[0] + 1, "y": start_anchor[1]},
                    "end_main": end_main_obj,
                    "end_full": end_full_obj,
                    "end": legacy_end,  # legacy alias

                    "has_children_effective": bool(has_children_effective),
                    "has_toc_children": bool(has_toc_children),
                    "auto_children_count": len(discovered) if use_auto_children else 0,

                    "synthetic": bool(e.get("synthetic", False)),
                    "synthetic_source": e.get("synthetic_source", ""),
                    "synthetic_num": e.get("synthetic_num", ""),

                    "text_path_main": str(main_path) if main_text else "",
                    "text_path_full_with_children": str(full_path) if full_with_children_txt else "",
                    "text_path": str(main_path) if main_text else "",  # legacy alias

                    "text_chars_main": len(main_text),
                    "text_words_main": len(main_text.split()) if main_text else 0,
                    "text_preview_main": main_text[:MAX_PREVIEW_CHARS],
                    "text_chars": len(main_text),                      # legacy alias
                    "text_preview": main_text[:MAX_PREVIEW_CHARS],     # legacy alias

                    "next_peer_title": next_peer_title,
                    **checks,
                }
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                written += 1

                # Emit synthetic children when ToC had none
                if use_auto_children:
                    for idx, h in enumerate(discovered):
                        child_start = (h["page_0based"], h["y"])
                        if idx < len(discovered) - 1:
                            nxt = discovered[idx + 1]
                            child_end = (nxt["page_0based"], nxt["y"])
                        else:
                            child_end = end_full

                        num = (h.get("num") or "").strip()
                        ttl = (h.get("title") or "").strip()
                        child_title = (f"{num} {ttl}".strip() if num else ttl)
                        child_kind = (h.get("kind") or ("numbered" if num else "style"))
                        child_source = "auto_style_subheadings" if child_kind == "style" else "auto_numbered_subheadings"

                        child_toc_id = next_toc_id
                        next_toc_id += 1

                        child_dir = cur_dir / _safe_seg(child_toc_id, child_title)
                        child_dir.mkdir(parents=True, exist_ok=True)

                        if child_end is None:
                            child_text = _extract_range(doc, child_start[0], child_start[1], None, None)
                        else:
                            child_text = _extract_range(doc, child_start[0], child_start[1], child_end[0], child_end[1])
                        child_text = (child_text or "").strip()

                        child_path = child_dir / "section.txt"
                        if child_text:
                            child_path.write_text(child_text, encoding="utf-8")

                        c_checks = _boundary_check(child_text, child_title, None)

                        child_entry = {
                            "toc_id": child_toc_id,
                            "level": level + 1,
                            "title": child_title,
                            "titles_path": titles_path + [child_title],
                            "toc_path_ids": toc_path_ids + [child_toc_id],
                            "parent_toc_id": toc_id,
                            "page_0based": child_start[0],
                            "page_1based": child_start[0] + 1,
                            "y": child_start[1],
                            "y_snapped": child_start[1],
                            "end_full": child_end,
                            "end_intro": child_end,
                            "next_peer_title": "",
                            "children_toc_ids": [],
                            "first_child_toc_id": None,
                            "synthetic": True,
                            "synthetic_source": child_source,
                            "synthetic_num": num,
                        }
                        augmented_entries.append(child_entry)

                        child_end_obj = None if child_end is None else {"page_0based": child_end[0], "page_1based": child_end[0] + 1, "y": child_end[1]}
                        child_rec = {
                            **info,
                            "doc_kind": doc_kind,
                            "flip_y_used": flip_y_used,
                            "structured_from_text_headings": structured_from_text_headings,

                            "toc_id": child_toc_id,
                            "level": level + 1,
                            "title": child_title,
                            "titles_path": titles_path + [child_title],
                            "toc_path_ids": toc_path_ids + [child_toc_id],
                            "parent_toc_id": toc_id,

                            "start": {"page_0based": child_start[0], "page_1based": child_start[0] + 1, "y": child_start[1]},
                            "end_main": child_end_obj,
                            "end_full": child_end_obj,
                            "end": child_end_obj,

                            "has_children_effective": False,
                            "has_toc_children": False,
                            "auto_children_count": 0,

                            "synthetic": True,
                            "synthetic_source": child_source,
                            "synthetic_from_parent_toc_id": toc_id,
                            "synthetic_num": num,

                            "text_path_main": str(child_path) if child_text else "",
                            "text_path_full_with_children": str(child_path) if child_text else "",
                            "text_path": str(child_path) if child_text else "",

                            "text_chars_main": len(child_text),
                            "text_words_main": len(child_text.split()) if child_text else 0,
                            "text_preview_main": child_text[:MAX_PREVIEW_CHARS],
                            "text_chars": len(child_text),
                            "text_preview": child_text[:MAX_PREVIEW_CHARS],

                            **c_checks,
                        }
                        f.write(json.dumps(child_rec, ensure_ascii=False) + "\n")
                        written += 1

        # Build augmented tree
        augmented_entries_sorted = sorted(
            augmented_entries,
            key=lambda e: (e["page_0based"], float(e.get("y_snapped", e.get("y", 0.0))), e["toc_id"])
        )
        by_aug_id = {e["toc_id"]: dict(e) for e in augmented_entries_sorted}
        aug_root: List[Dict[str, Any]] = []
        for e in augmented_entries_sorted:
            node = by_aug_id[e["toc_id"]]
            node.setdefault("children", [])
            pid = e.get("parent_toc_id")
            if pid is None:
                aug_root.append(node)
            else:
                parent = by_aug_id.get(pid)
                if parent is not None:
                    parent.setdefault("children", []).append(node)

        use_augmented = len(augmented_entries_sorted) > len(entries)
        
        final_tree = aug_root if use_augmented else toc_tree
        final_flat = augmented_entries_sorted if use_augmented else entries
        final_count = len(augmented_entries_sorted) if use_augmented else len(entries)

        toc_payload = {
            "info": info,
            "doc_kind": doc_kind,
            "toc_entries_count": final_count,  # <--- Use final_count
            "flip_y_used": flip_y_used,
            "structured_from_text_headings": structured_from_text_headings,

            "toc_tree": final_tree,            # <--- Use final_tree (The Fix)
            "flat_entries": final_flat,        # <--- Use final_flat

            # We keep these for debug/reference, but they are no longer strictly needed for the UI
            "augmented_entries_count": len(augmented_entries_sorted),
            "augmented_tree": aug_root,
            "augmented_flat_entries": augmented_entries_sorted,

            "auto_subsections_enabled": bool(DISCOVER_NUMBERED_SUBSECTIONS),
            "auto_only_when_no_toc_children": bool(DISCOVER_ONLY_IF_NO_TOC_CHILDREN),
            "structure_when_no_toc": bool(STRUCTURE_WHEN_NO_TOC),

            "sections_jsonl": str(sections_jsonl_path),
            "sections_written": written,
            "warnings": warnings,
        }
        toc_json_path.write_text(json.dumps(toc_payload, ensure_ascii=False, indent=2), encoding="utf-8")

        return {
            **info,
            "doc_kind": doc_kind,
            "toc_entries_count": final_count,   # <--- Update return value too
            "sections_written": written,
            "warnings": warnings,
            "flip_y_used": flip_y_used,
            "structured_from_text_headings": structured_from_text_headings,
            "toc_json": str(toc_json_path),
            "sections_jsonl": str(sections_jsonl_path),
            "toc_tree": final_tree,             # <--- Update return value too
            "augmented_tree": aug_root,
        }
