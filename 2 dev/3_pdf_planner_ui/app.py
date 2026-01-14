from __future__ import annotations

import json
import hashlib
import re
import datetime 
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from extractor import extract_pdf_for_ui
from planner_simple import generate_plan_from_ui_selection
from generator_llm import ContentGenerator


# =========================
# Project-based data layout
# =========================
BASE_DIR = Path(__file__).parent.resolve()
DATA_ROOT = BASE_DIR / "data"   # projects live under data/<course_id>/...

STATIC_DIR = BASE_DIR / "static"
INDEX_HTML = STATIC_DIR / "index.html"

DATA_ROOT.mkdir(parents=True, exist_ok=True)

# Cache: key=f"{course_id}:{source_id}" -> {"mtime": float, "idx": dict}
_SECTION_INDEX_CACHE: Dict[str, Dict[str, Any]] = {}


# -------------------------
# Helpers
# -------------------------
_COURSE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")

def _require_safe_course_id(course_id: str) -> str:
    course_id = (course_id or "").strip()
    if not _COURSE_ID_RE.match(course_id):
        raise HTTPException(status_code=400, detail="Invalid course_id. Use letters/numbers and _ . - (max 64).")
    return course_id

def _project_dir(course_id: str) -> Path:
    course_id = _require_safe_course_id(course_id)
    return DATA_ROOT / course_id

def _project_paths(course_id: str) -> Dict[str, Path]:
    pdir = _project_dir(course_id)
    return {
        "root": pdir,
        "project_json": pdir / "project.json",
        "plan_json": pdir / "plan.json",
        "outline_json": pdir / "unit_outline.json",
        "uploads": pdir / "uploads",
        "extracted": pdir / "extracted",
        "generated_plan_dir": pdir / "generated_plan",
        "generated_llm_plan_dir": pdir / "generated_llm_plan",
        "final_presentations": pdir / "final_presentations",
        "generated_plan_json": pdir / "generated_plan" / "generated_plan.json",
        "generated_llm_plan_json": pdir / "generated_llm_plan" / "generated_llm_plan.json",
    }

def _ensure_project(course_id: str, unit_name: Optional[str] = None) -> Dict[str, Path]:
    paths = _project_paths(course_id)
    paths["root"].mkdir(parents=True, exist_ok=True)
    for k in ["uploads", "extracted", "generated_plan_dir", "generated_llm_plan_dir", "final_presentations"]:
        paths[k].mkdir(parents=True, exist_ok=True)

    # project metadata
    if not paths["project_json"].exists():
        meta = {
            "course_id": course_id,
            "unit_name": unit_name or "",
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        paths["project_json"].write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        if unit_name is not None:
            try:
                meta = json.loads(paths["project_json"].read_text(encoding="utf-8"))
            except Exception:
                meta = {"course_id": course_id, "unit_name": ""}
            meta["course_id"] = course_id
            meta["unit_name"] = unit_name
            paths["project_json"].write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # default plan
    if not paths["plan_json"].exists():
        paths["plan_json"].write_text(json.dumps({"meta": {"weeks_count": 12}, "weeks": {}}, indent=2), encoding="utf-8")

    # default outline
    if not paths["outline_json"].exists():
        paths["outline_json"].write_text(json.dumps({"weeklySchedule": []}, indent=2), encoding="utf-8")

    return paths

def _read_json_or_default(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def _write_json(path: Path, obj: Any) -> None:
    """Write JSON (UTF-8) with stable formatting. Creates parent dirs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def _write_weekly_plan_files(
    plan_obj: Dict[str, Any],
    out_dir: Path,
    course_id: str,
    unit_name: str,
    *,
    file_prefix: str = "week_",
    digits_min: int = 2,
    summary_name: str = "weekly_budget_summary.json",
    only_weeks: Optional[List[int]] = None,
) -> List[str]:
    """
    Writes one JSON file per week into out_dir, plus a weekly budget summary file.

    Output files:
      - out_dir / week_01.json, week_02.json, ...
      - out_dir / weekly_budget_summary.json
    """
    out_dir.mkdir(parents=True, exist_ok=True)

    weeks = (plan_obj or {}).get("weeks") or {}
    # If only_weeks is provided, write only those week keys.
    # (Handles both '1' and '01' style keys.)
    if only_weeks:
        only_set: set[str] = set()
        for w in only_weeks:
            wi = int(w)
            only_set.add(str(wi))
            only_set.add(f"{wi:0{int(digits_min)}d}")
            only_set.add(str(w))
        weeks = {k: v for k, v in weeks.items() if str(k) in only_set}
    # Determine numbering width
    try:
        max_week = max(int(k) for k in weeks.keys()) if weeks else 0
    except Exception:
        max_week = 0
    width = max(int(digits_min), len(str(max_week or 0)))

    written: List[str] = []
    summary_rows: List[Dict[str, Any]] = []

    for wk_key in sorted(weeks.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x)):
        wk_data = weeks.get(wk_key) or {}
        if not isinstance(wk_data, dict):
            wk_data = {}

        wk_num = int(wk_key) if str(wk_key).isdigit() else wk_key
        wk_num_int = int(wk_key) if str(wk_key).isdigit() else None

        # Add small metadata to each week file (keeps files self-contained)
        week_file_obj = dict(wk_data)
        week_file_obj.setdefault("week", wk_num_int if wk_num_int is not None else wk_key)
        week_file_obj["_meta"] = {
            "course_id": course_id,
            "unit_name": unit_name,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

        fname = f"{file_prefix}{int(wk_key):0{width}d}.json" if wk_num_int is not None else f"{file_prefix}{wk_key}.json"
        out_path = out_dir / fname
        _write_json(out_path, week_file_obj)
        written.append(str(out_path))

        # Lightweight budget summary row (for quick review)
        slide_sum = wk_data.get("weekly_slide_summary") or {}
        time_sum = wk_data.get("weekly_time_summary") or wk_data.get("weekly_time_summary_minutes") or {}
        summary_rows.append({
            "week": wk_num,
            "overall_topic": wk_data.get("overall_topic", ""),
            "number_of_decks": slide_sum.get("number_of_decks", 0),
            "total_slides_for_week": slide_sum.get("total_slides_for_week", 0),
            "total_time_for_week_minutes": time_sum.get("total_time_for_week_minutes", 0),
        })

    # Write summary file
    _write_json(out_dir / summary_name, {
        "_meta": {
            "course_id": course_id,
            "unit_name": unit_name,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
        "weeks": summary_rows,
    })

    return written


def _safe_slug(text: str, max_len: int = 60) -> str:
    """Create an ASCII, filename-safe slug."""
    text = (text or "").strip()
    if not text:
        return "untitled"

    # Normalize + strip accents
    norm = unicodedata.normalize("NFKD", text)
    norm = norm.encode("ascii", "ignore").decode("ascii", errors="ignore")

    # Keep only [a-zA-Z0-9_-], collapse spaces/punct to '-'
    norm = re.sub(r"[^A-Za-z0-9]+", "-", norm).strip("-")
    norm = re.sub(r"-+", "-", norm)

    return (norm or "untitled")[:max_len]


def _export_llm_content_files(
    plan_obj: Dict[str, Any],
    out_dir: Path,
    course_id: str,
    unit_name: str,
    *,
    content_subdir: str = "content",
    manifest_name: str = "content_manifest.json",
    clean_existing: bool = True,
) -> Dict[str, Any]:
    """Export LLM-generated slide/activity/summary JSON into many small files for review."""
    out_dir.mkdir(parents=True, exist_ok=True)
    content_dir = out_dir / content_subdir
    content_dir.mkdir(parents=True, exist_ok=True)

    # Keep the review folder in sync with the current plan to avoid stale files.
    if clean_existing:
        for p in content_dir.glob("*.json"):
            try:
                p.unlink()
            except Exception:
                pass

    weeks = (plan_obj or {}).get("weeks") or {}
    entries: List[Dict[str, Any]] = []

    def write_item(*, week: Any, deck_number: Any, kind: str, seq_id: Any, title: str, subtitle: str, payload: Any) -> None:
        seq_part = str(seq_id).replace(".", "_") if seq_id is not None else "na"
        base = f"wk{int(week):02d}" if str(week).isdigit() else f"wk{week}"
        deck_part = f"deck{int(deck_number):02d}" if str(deck_number).isdigit() else f"deck{deck_number}"
        name_part = _safe_slug(subtitle or title or kind)
        fname = f"{base}_{deck_part}_{kind}_{seq_part}_{name_part}.json"
        out_path = content_dir / fname

        _write_json(out_path, {
            "_meta": {
                "course_id": course_id,
                "unit_name": unit_name,
                "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "week": week,
                "deck_number": deck_number,
                "kind": kind,
                "seq_id": seq_id,
                "title": title,
                "subtitle": subtitle,
            },
            "llm_generated_content": payload,
        })

        entries.append({
            "week": week,
            "deck_number": deck_number,
            "kind": kind,
            "seq_id": seq_id,
            "title": title,
            "subtitle": subtitle,
            "path": str(out_path.relative_to(out_dir)),
        })

    def walk_node(node: Dict[str, Any], *, week: Any, deck_number: Any) -> None:
        node_title = (node or {}).get("title") or ""
        node_seq = (node or {}).get("seq_id")

        # Slides
        for s in (node or {}).get("slides") or []:
            llm = (s or {}).get("llm_generated_content")
            if llm:
                write_item(
                    week=week,
                    deck_number=deck_number,
                    kind="slide",
                    seq_id=(s or {}).get("seq_id") or node_seq,
                    title=str(llm.get("title") or node_title),
                    subtitle=str(llm.get("subtitle") or ""),
                    payload=llm,
                )

        # Interactive activity
        ia = (node or {}).get("interactive_activity") or {}
        ia_llm = ia.get("llm_generated_content")
        if ia_llm:
            write_item(
                week=week,
                deck_number=deck_number,
                kind="interactive",
                seq_id=node_seq,
                title=str(ia_llm.get("title") or "Let's Apply This!"),
                subtitle=str(ia_llm.get("subtitle") or node_title),
                payload=ia_llm,
            )

        for ch in (node or {}).get("children") or []:
            if isinstance(ch, dict):
                walk_node(ch, week=week, deck_number=deck_number)

    # Traverse weeks -> decks -> sections
    for wk_key in sorted(weeks.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x)):
        wk_data = weeks.get(wk_key) or {}
        week_num = wk_data.get("week", wk_key)

        for deck in (wk_data.get("deck_plans") or []):
            deck_number = deck.get("deck_number") or 1

            # Summary slide (deck-level)
            for sec in (deck.get("sections") or []):
                if sec.get("section_type") == "Summary" and sec.get("llm_generated_content"):
                    llm = sec.get("llm_generated_content")
                    write_item(
                        week=week_num,
                        deck_number=deck_number,
                        kind="summary",
                        seq_id=None,
                        title=str(llm.get("title") or "Summary & Key Takeaways"),
                        subtitle=str(llm.get("subtitle") or ""),
                        payload=llm,
                    )

            # Content slides + interactives
            for sec in (deck.get("sections") or []):
                if sec.get("section_type") != "Content":
                    continue
                for block in (sec.get("content_blocks") or []):
                    if isinstance(block, dict):
                        walk_node(block, week=week_num, deck_number=deck_number)

    manifest_path = out_dir / manifest_name
    _write_json(manifest_path, {
        "_meta": {
            "course_id": course_id,
            "unit_name": unit_name,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
        "content_dir": str(content_dir),
        "items": entries,
    })

    return {
        "content_dir": str(content_dir),
        "manifest_path": str(manifest_path),
        "items_count": len(entries),
    }



def _sha1_bytes(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()

def _count_toc_nodes(toc_tree: Any) -> int:
    def walk(node) -> int:
        if not isinstance(node, dict):
            return 0
        c = 1
        for ch in node.get("children", []) or []:
            c += walk(ch)
        return c
    if isinstance(toc_tree, list):
        return sum(walk(n) for n in toc_tree)
    if isinstance(toc_tree, dict) and "toc_tree" in toc_tree:
        return _count_toc_nodes(toc_tree.get("toc_tree"))
    if isinstance(toc_tree, dict):
        return walk(toc_tree)
    return 0

def _get_uploaded_filename(paths: Dict[str, Path], source_id: str) -> str:
    # uploads are saved as "<source_id>__<original_filename>"
    for p in paths["uploads"].glob(f"{source_id}__*"):
        return p.name.split("__", 1)[1] if "__" in p.name else p.name
    return f"{source_id}.pdf"


# -------------------------
# FastAPI app
# -------------------------

def _llm_run_dir(base_llm_dir: Path, provider: str, model: str) -> Path:
    """Folder for a specific LLM run, grouped by provider+model (safe for Windows/macOS/Linux)."""
    provider = (provider or "llm").strip().lower()
    model = (model or "model").strip()
    folder = _safe_slug(f"{provider}__{model}", max_len=80)
    return base_llm_dir / folder


def _write_llm_run_meta(
    run_dir: Path,
    *,
    course_id: str,
    unit_name: str,
    provider: str,
    model: str,
    host: str = "",
) -> Path:
    """Write a small metadata file inside the model folder."""
    meta_path = run_dir / "llm_run_meta.json"
    _write_json(meta_path, {
        "course_id": course_id,
        "unit_name": unit_name,
        "provider": provider,
        "model": model,
        "host": host,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })
    return meta_path


app = FastAPI(title="PDF ToC Week Planner (Projects)")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
def root():
    return FileResponse(str(INDEX_HTML))

@app.get("/api/health")
def health():
    return {"ok": True}

# -------------------------
# Projects API
# -------------------------
@app.get("/api/projects")
def list_projects():
    projects = []
    # If DATA_ROOT doesn't exist yet, return empty
    if not DATA_ROOT.exists():
         return JSONResponse({"projects": []})

    for d in sorted(DATA_ROOT.iterdir(), key=lambda p: p.name.lower()):
        if not d.is_dir():
            continue
        pj = d / "project.json"
        # Only list projects that have a valid metadata file
        if pj.exists():
            meta = _read_json_or_default(pj, {})
            projects.append({
                "course_id": d.name,
                "unit_name": meta.get("unit_name", ""),
            })
    return JSONResponse({"projects": projects})

@app.post("/api/projects")
async def create_project(payload: Dict[str, Any]):
    course_id = _require_safe_course_id(payload.get("course_id", ""))
    unit_name = (payload.get("unit_name") or "").strip()
    _ensure_project(course_id, unit_name=unit_name)
    return JSONResponse({"ok": True, "course_id": course_id, "unit_name": unit_name})

@app.get("/api/project/{course_id}")
def get_project(course_id: str):
    paths = _ensure_project(course_id)
    meta = _read_json_or_default(paths["project_json"], {"course_id": course_id, "unit_name": ""})
    return JSONResponse(meta)

@app.get("/api/project/{course_id}/bootstrap")
def bootstrap_project(course_id: str):
    paths = _ensure_project(course_id)
    project = _read_json_or_default(paths["project_json"], {"course_id": course_id, "unit_name": ""})
    plan = _read_json_or_default(paths["plan_json"], {"meta": {"weeks_count": 12}, "weeks": {}})
    outline = _read_json_or_default(paths["outline_json"], {"weeklySchedule": []})

    # Sources (already extracted)
    sources: Dict[str, Any] = {}
    if paths["extracted"].exists():
        for src_dir in paths["extracted"].iterdir():
            if not src_dir.is_dir():
                continue
            source_id = src_dir.name
            toc_path = src_dir / "toc.json"
            if not toc_path.exists():
                continue
            toc_obj = _read_json_or_default(toc_path, {})
            toc_tree = toc_obj.get("toc_tree") if isinstance(toc_obj, dict) else toc_obj
            count = toc_obj.get("toc_entries_count") if isinstance(toc_obj, dict) else None
            if not count:
                count = _count_toc_nodes(toc_tree)
            sources[source_id] = {
                "filename": _get_uploaded_filename(paths, source_id),
                "toc_tree": toc_tree,
                "toc_entries_count": int(count or 0),
            }

    generated_plan = _read_json_or_default(paths["generated_plan_json"], None)
    generated_llm_plan = _read_json_or_default(paths["generated_llm_plan_json"], None)

    return JSONResponse({
        "project": project,
        "plan": plan,
        "outline": outline,
        "sources": sources,
        "generated_plan": generated_plan,
        "generated_llm_plan": generated_llm_plan,
    })


# -------------------------
# PDF upload / extraction
# -------------------------
@app.post("/api/project/{course_id}/upload_pdf")
async def upload_pdf(course_id: str, file: UploadFile = File(...)):
    paths = _ensure_project(course_id)
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF.")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file.")

    source_id = _sha1_bytes(content)[:16]
    pdf_path = paths["uploads"] / f"{source_id}__{Path(file.filename).name}"
    pdf_path.write_bytes(content)

    out_dir = paths["extracted"] / source_id
    out_dir.mkdir(parents=True, exist_ok=True)

    result = extract_pdf_for_ui(
        pdf_path=pdf_path,
        out_dir=out_dir,
        source_id=source_id,
        work_id="local_upload",
        unit_code=course_id,
    )
    return JSONResponse(result)

@app.get("/api/project/{course_id}/toc/{source_id}")
def get_toc(course_id: str, source_id: str):
    paths = _ensure_project(course_id)
    toc_path = paths["extracted"] / source_id / "toc.json"
    if not toc_path.exists():
        raise HTTPException(status_code=404, detail="ToC not found.")
    return JSONResponse(_read_json_or_default(toc_path, {}))


def _load_sections_index(course_id: str, source_id: str) -> Dict[str, Any]:
    """
    Returns dict: toc_id(str) -> record (from sections.jsonl)
    Cached by mtime, keyed by course_id+source_id.
    """
    paths = _ensure_project(course_id)
    jsonl_path = paths["extracted"] / source_id / "sections.jsonl"
    if not jsonl_path.exists():
        return {}

    key = f"{course_id}:{source_id}"
    mtime = jsonl_path.stat().st_mtime
    cached = _SECTION_INDEX_CACHE.get(key)
    if cached and cached.get("mtime") == mtime:
        return cached["idx"]

    idx: Dict[str, Any] = {}
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            idx[str(rec.get("toc_id"))] = rec

    _SECTION_INDEX_CACHE[key] = {"mtime": mtime, "idx": idx}
    return idx

@app.get("/api/project/{course_id}/section_text/{source_id}/{toc_id}")
def section_text(course_id: str, source_id: str, toc_id: str, max_chars: int = Query(20000, ge=200, le=200000)):
    idx = _load_sections_index(course_id, source_id)
    rec = idx.get(str(toc_id))
    if not rec:
        raise HTTPException(status_code=404, detail="Section not found (toc_id).")

    text_path = rec.get("text_path") or ""
    text = ""
    if text_path:
        p = Path(text_path)
        # safety: ensure path is within extracted folder
        try:
            rp = p.resolve()
            base = (_project_paths(course_id)["extracted"] / source_id).resolve()
            if base not in rp.parents and rp != base:
                raise HTTPException(status_code=400, detail="Unsafe text path.")
        except Exception:
            raise HTTPException(status_code=400, detail="Bad text path.")

        if p.exists():
            text = p.read_text(encoding="utf-8", errors="ignore")[:max_chars]

    title_path = " / ".join(rec.get("titles_path") or [rec.get("title", "")]).strip()

    return JSONResponse({
        "source_id": source_id,
        "toc_id": rec.get("toc_id"),
        "title": rec.get("title"),
        "title_path": title_path,
        "start": rec.get("start"),
        "end": rec.get("end"),
        "text_chars": rec.get("text_chars", 0),
        "text": text,
    })


# -------------------------
# Plan + outline per project
# -------------------------
@app.get("/api/project/{course_id}/plan")
def load_plan(course_id: str):
    paths = _ensure_project(course_id)
    return JSONResponse(_read_json_or_default(paths["plan_json"], {"meta": {"weeks_count": 12}, "weeks": {}}))

@app.post("/api/project/{course_id}/plan")
async def save_plan(course_id: str, payload: Dict[str, Any]):
    paths = _ensure_project(course_id)
    paths["plan_json"].write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return JSONResponse({"ok": True, "saved_to": str(paths["plan_json"])})

@app.post("/api/project/{course_id}/upload_outline")
async def upload_outline(course_id: str, file: UploadFile = File(...)):
    paths = _ensure_project(course_id)
    if not file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Upload a JSON file (unit_outline.json).")
    content = await file.read()
    try:
        obj = json.loads(content.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON.")

    paths["outline_json"].write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    return JSONResponse({"ok": True, "weeks": obj.get("weeklySchedule", [])})

@app.get("/api/project/{course_id}/outline")
def get_outline(course_id: str):
    paths = _ensure_project(course_id)
    return JSONResponse(_read_json_or_default(paths["outline_json"], {"weeklySchedule": []}))


# -------------------------
# Generated plans (simple + LLM)
# -------------------------
@app.post("/api/project/{course_id}/generate_plan")
async def generate_plan(course_id: str, payload: Dict[str, Any]):
    paths = _ensure_project(course_id)
    project = _read_json_or_default(paths["project_json"], {"course_id": course_id, "unit_name": ""})

    plan = payload.get("plan") or {}
    config = payload.get("config") or {}

    # Inject project meta into config so planner output stays informative.
    config = dict(config)
    config["course_id"] = project.get("course_id", course_id)
    config["unit_name"] = project.get("unit_name", "")

    def sections_index_lookup(source_id: str) -> Dict[str, Any]:
        if not source_id:
            return {}
        return _load_sections_index(course_id, source_id)

    result = generate_plan_from_ui_selection(
        plan=plan,
        config=config,
        sections_index_lookup=sections_index_lookup,
    )

    _write_json(paths["generated_plan_json"], result)

    weekly_files = _write_weekly_plan_files(
        plan_obj=result,
        out_dir=paths["generated_plan_dir"],
        course_id=project.get("course_id", course_id),
        unit_name=project.get("unit_name", ""),
    )

    return JSONResponse({
        "ok": True,
        "generated_path": str(paths["generated_plan_json"]),
        "weekly_files": weekly_files,
        "weekly_budget_summary": str(paths["generated_plan_dir"] / "weekly_budget_summary.json"),
        "plan": result,
    })

@app.get("/api/project/{course_id}/generated_plan")
def get_generated_plan(course_id: str):
    paths = _ensure_project(course_id)
    return JSONResponse(_read_json_or_default(paths["generated_plan_json"], {}))

@app.get("/api/project/{course_id}/generated_llm_plan")
def get_generated_llm_plan(course_id: str):
    paths = _ensure_project(course_id)
    return JSONResponse(_read_json_or_default(paths["generated_llm_plan_json"], {}))

@app.get("/api/project/{course_id}/llm_health")
def api_llm_health(
    course_id: str, 
    host: str = Query("http://localhost:11434"), 
    model: str = Query("qwen3:8b"),
    provider: str = Query("ollama"),
    api_key: str = Query("")
):
    _ensure_project(course_id)
    try:
        gen = ContentGenerator(
            ollama_host=host,
            ollama_model=model,
            provider=provider,
            api_key=api_key,
            # For non-ollama providers, ContentGenerator uses model_name
            model_name=model,
        )
        # Now returns { ok, message, models: [] }
        check = gen.validate_server_and_model()
        return JSONResponse(check)
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e), "models": []})

@app.post("/api/project/{course_id}/llm_generate_week")
async def api_llm_generate_week(course_id: str, payload: Dict[str, Any]):
    paths = _ensure_project(course_id)
    project = _read_json_or_default(paths["project_json"], {"course_id": course_id, "unit_name": ""})

    host = payload.get("ollama_host", "http://localhost:11434")
    model = payload.get("ollama_model", "qwen3:8b")
    model_name = payload.get("llm_model", "")
    
    # <--- EXTRACT NEW PARAMS
    provider = payload.get("llm_provider", "ollama") 
    api_key = payload.get("llm_api_key", "")

    try:
        # Pass them here
        gen = ContentGenerator(
            ollama_host=host, 
            ollama_model=model,
            provider=provider,
            api_key=api_key,
            model_name=model_name
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM init failed: {e}")

    week_number = int(payload.get("week_number", 1))
    generated_plan = payload.get("generated_plan") or {}

    weeks_map = generated_plan.get("weeks", {})
    week_key = str(week_number)
    
    if week_key not in weeks_map:
        raise HTTPException(status_code=404, detail=f"Week {week_number} not found in generated plan.")

    week_data = weeks_map[week_key]

    try:
        gen.process_plan(week_data)

        # --- Model-folder run dir (provider__model) ---
        run_dir = _llm_run_dir(
            paths["generated_llm_plan_dir"],
            provider=getattr(gen, "provider", provider),
            model=getattr(gen, "model", model),
        )
        run_dir.mkdir(parents=True, exist_ok=True)
        _write_llm_run_meta(
            run_dir,
            course_id=project.get("course_id", course_id),
            unit_name=project.get("unit_name", ""),
            provider=getattr(gen, "provider", provider),
            model=getattr(gen, "model", model),
            host=host,
        )

        # 1) Archive the full LLM plan (latest pointer for the UI)
        _write_json(paths["generated_llm_plan_json"], generated_plan)

        # 1b) Also keep a copy inside the model folder for precise review
        _write_json(run_dir / "generated_llm_plan.json", generated_plan)

        # 2) Week-by-week JSON files (inside generated_llm_plan/<model>/)
        weekly_files = _write_weekly_plan_files(
            plan_obj=generated_plan,
            out_dir=run_dir,
            course_id=project.get("course_id", course_id),
            unit_name=project.get("unit_name", ""),
            only_weeks=[week_number],
        )

        return JSONResponse({
            "ok": True,
            # latest pointer (kept for backward compatibility / UI)
            "generated_path": str(paths["generated_llm_plan_json"]),
            # model-specific folder artifacts
            "generated_path_model": str(run_dir / "generated_llm_plan.json"),
            "model_run_dir": str(run_dir),
            "provider_used": getattr(gen, "provider", provider),
            "model_used": getattr(gen, "model", model),

            "weekly_files": weekly_files,
            "weekly_budget_summary": str(run_dir / "weekly_budget_summary.json"),

            "plan": generated_plan,
        })

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM generation failed: {e}")
    
@app.post("/api/project/{course_id}/llm_calculate_cost")
async def api_llm_calculate_cost(course_id: str, payload: Dict[str, Any]):
    """
    Calculates estimated cost for the Google provider based on plan size.
    """
    generated_plan = payload.get("generated_plan") or {}
    provider = payload.get("llm_provider", "google")
    model = payload.get("llm_model", "")
    api_key = payload.get("llm_api_key", "")

    try:
        gen = ContentGenerator(provider=provider, api_key=api_key, model_name=model)
        estimate = gen.estimate_cost(generated_plan)
        return JSONResponse({"ok": True, "estimate": estimate})
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)})
    
@app.post("/api/project/{course_id}/llm_generate_all")
async def api_llm_generate_all(course_id: str, payload: Dict[str, Any]):
    paths = _ensure_project(course_id)
    
    generated_plan = payload.get("generated_plan") or {}
    host = payload.get("ollama_host", "http://localhost:11434")
    model = payload.get("ollama_model", "")
    model_name = payload.get("llm_model", "")
    provider = payload.get("llm_provider", "ollama")
    api_key = payload.get("llm_api_key", "")

    try:
        gen = ContentGenerator(
            ollama_host=host, 
            ollama_model=model,
            provider=provider,
            api_key=api_key,
            model_name=model_name
        )
        
        # Process the ENTIRE plan object
        # The updated ContentGenerator.process_plan now handles the full 'weeks' dict
        gen.process_plan(generated_plan)

        # --- Model-folder run dir (provider__model) ---
        project = _read_json_or_default(paths["project_json"], {"course_id": course_id, "unit_name": ""})
        run_dir = _llm_run_dir(
            paths["generated_llm_plan_dir"],
            provider=getattr(gen, "provider", provider),
            model=getattr(gen, "model", model),
        )
        run_dir.mkdir(parents=True, exist_ok=True)
        _write_llm_run_meta(
            run_dir,
            course_id=project.get("course_id", course_id),
            unit_name=project.get("unit_name", ""),
            provider=getattr(gen, "provider", provider),
            model=getattr(gen, "model", model),
            host=host,
        )

        # 1) Archive the full LLM plan (latest pointer for the UI)
        _write_json(paths["generated_llm_plan_json"], generated_plan)

        # 1b) Also keep a copy inside the model folder for precise review
        _write_json(run_dir / "generated_llm_plan.json", generated_plan)

        # 2) Week-by-week JSON files (inside generated_llm_plan/<model>/)
        weekly_files = _write_weekly_plan_files(
            plan_obj=generated_plan,
            out_dir=run_dir,
            course_id=project.get("course_id", course_id),
            unit_name=project.get("unit_name", ""),
        )

        return JSONResponse({
            "ok": True,
            # latest pointer (kept for backward compatibility / UI)
            "generated_path": str(paths["generated_llm_plan_json"]),
            # model-specific folder artifacts
            "generated_path_model": str(run_dir / "generated_llm_plan.json"),
            "model_run_dir": str(run_dir),
            "provider_used": getattr(gen, "provider", provider),
            "model_used": getattr(gen, "model", model),

            "weekly_files": weekly_files,
            "weekly_budget_summary": str(run_dir / "weekly_budget_summary.json"),

            "plan": generated_plan,
        })

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM Batch generation failed: {e}")