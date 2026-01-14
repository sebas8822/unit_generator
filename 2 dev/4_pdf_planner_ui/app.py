from __future__ import annotations

import json
import hashlib
import re
import datetime 
import zipfile
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional
import sys
import subprocess
import os

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from extractor_s import extract_pdf_for_ui
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


def _provider_model_folder(provider: str, model: str, max_len: int = 80) -> str:
    """Create a stable folder name for a provider+model pair (keeps underscores, replaces unsafe chars)."""
    provider = (provider or "llm").strip().lower()
    model = (model or "model").strip()

    # Join and replace path separators + whitespace/colon/etc with underscore.
    folder = f"{provider}__{model}"
    folder = folder.replace(os.sep, "_").replace("/", "_").replace("\\", "_")
    folder = re.sub(r"[^A-Za-z0-9_.-]+", "_", folder).strip("._-")

    # Collapse multiple underscores
    folder = re.sub(r"_+", "_", folder)

    if not folder:
        folder = "llm__model"
    return folder[:max_len]


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
    folder = _provider_model_folder(provider, model, max_len=80)
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


# -------------------------
# Slide generation (PPTX)
# -------------------------

_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$")

def _require_safe_filename(name: str) -> str:
    name = (name or "").strip()
    if not _FILENAME_RE.match(name) or ("/" in name) or ("\\" in name) or (".." in name):
        raise HTTPException(status_code=400, detail="Unsafe filename.")
    return name

def _resolve_slide_style_paths(template_path: Optional[str] = None, layout_config_path: Optional[str] = None) -> tuple[Path, Path]:
    """Resolve slide template and layout config paths with sensible defaults."""
    def _resolve_one(p: Optional[str], candidates: list[Path]) -> Path:
        if p:
            pp = Path(p)
            if not pp.is_absolute():
                pp = (BASE_DIR / pp).resolve()
            if not pp.exists():
                raise HTTPException(status_code=400, detail=f"File not found: {pp}")
            return pp
        for cand in candidates:
            if cand.exists():
                return cand
        raise HTTPException(status_code=500, detail="Slide style files not found. Check slide_style folder.")

    style_dir = BASE_DIR / "slide_style"
    template_candidates = [
        style_dir / "slide_style_test_2_ACIT.pptx",
        BASE_DIR / "slide_style_test_2_ACIT.pptx",
    ]
    layout_candidates = [
        style_dir / "layout_mapping_test_Mod.json",
        BASE_DIR / "layout_mapping_test_Mod.json",
    ]
    return _resolve_one(template_path, template_candidates), _resolve_one(layout_config_path, layout_candidates)

def _extract_title_content_from_deck(deck: Dict[str, Any]) -> Dict[str, Any]:
    sections = deck.get("sections", []) or []
    title_section = next((s for s in sections if s.get("section_type") == "Title"), None)
    if title_section and isinstance(title_section, dict):
        return title_section.get("content", {}) or {}
    # fallback: first section content
    if sections and isinstance(sections[0], dict):
        return sections[0].get("content", {}) or {}
    return {}

def _build_expected_pptx_filename(deck: Dict[str, Any], week_num: Any) -> str:
    content = _extract_title_content_from_deck(deck)
    unit_code = content.get("unit_code", "UNIT") or "UNIT"
    deck_num = deck.get("deck_number", "Y")
    return f"{unit_code}_Week{week_num}_Deck{deck_num}_Presentation.pptx"

def _generate_pptx_for_week(course_id: str, week_num: int, week_obj: Dict[str, Any],
                            template_path: Path, layout_config_path: Path, output_dir: Path) -> List[Dict[str, Any]]:
    """Generate one PPTX per deck for a given week object."""
    # Import lazily so the app can still run even if slide_generator.py is missing
    try:
        from slide_generator import PresentationAgent  # type: ignore
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"slide_generator.py import failed: {e}")

    decks = week_obj.get("deck_plans", []) or []
    if not decks:
        return []

    tmp_dir = output_dir / "_tmp_plans"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    agent = PresentationAgent(str(template_path), str(layout_config_path))
    created = []

    for deck in decks:
        deck_num = deck.get("deck_number", "Y")
        tmp_path = tmp_dir / f"week_{int(week_num):02d}_deck_{deck_num}.json"
        deck_plan = {
            "week": week_obj.get("week", week_num),
            "overall_topic": week_obj.get("overall_topic", ""),
            "deck_plans": [deck],
        }
        _write_json(tmp_path, deck_plan)

        # Generate and then rename/move into the standardized output naming:
        #   final_presentations/<provider_model>/week##.pptx
        # If a week has multiple decks, deck 1 is week##.pptx and the rest are week##_deck##.pptx.
        before_files = set(output_dir.glob("*.pptx"))
        agent.create_presentation_from_plan(str(tmp_path), str(output_dir))
        after_files = set(output_dir.glob("*.pptx"))
        new_files = list(after_files - before_files)

        if new_files:
            new_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            out_path = new_files[0]
        else:
            pptx_files = sorted(after_files, key=lambda p: p.stat().st_mtime, reverse=True)
            out_path = pptx_files[0] if pptx_files else None

        if out_path is None:
            raise HTTPException(status_code=500, detail="Slide generation produced no .pptx output.")

        # Standardize filename
        wk_val = week_obj.get("week", week_num)
        try:
            wk_int = int(wk_val)
        except Exception:
            wk_int = int(week_num)

        # Deck number (optional)
        try:
            deck_int = int(deck_num)
        except Exception:
            deck_int = None

        if len(decks) > 1 and deck_int and deck_int != 1:
            filename = f"week{wk_int:02d}_deck{deck_int:02d}.pptx"
        else:
            filename = f"week{wk_int:02d}.pptx"

        final_path = output_dir / filename

        # Overwrite target if it exists (regeneration)
        try:
            if final_path.exists() and final_path.resolve() != out_path.resolve():
                final_path.unlink()
        except Exception:
            pass

        if final_path.resolve() != out_path.resolve():
            out_path.replace(final_path)
            out_path = final_path

        created.append({
            "week": wk_int,
            "deck_number": deck_num,
            "filename": filename,
            "path": str(out_path),
            "download_url": f"/api/project/{course_id}/presentation/{filename}",
        })

    return created

def _get_slides_output_dir(base_out_dir: Path, mode: str, provider: str, model: str) -> Path:
    """
    Determines the specific subdirectory for slides based on mode and model.
    Structure: data/<course>/final_presentations/<provider>__<model>/
    """
    if mode == "llm":
        # Create a folder name based on the model used
        folder_name = _provider_model_folder(provider, model, max_len=80)
        target_dir = base_out_dir / folder_name
    else:
        # Default folder for non-LLM (Base) generations
        target_dir = base_out_dir / "base_content"
    
    target_dir.mkdir(parents=True, exist_ok=True)
    return target_dir

@app.get("/api/project/{course_id}/presentations")
def list_presentations(course_id: str):
    course_id = _require_safe_course_id(course_id)
    paths = _project_paths(course_id)
    out_dir = paths["final_presentations"]
    out_dir.mkdir(parents=True, exist_ok=True)

    files = []
    # PATCH: Use rglob to find files in subdirectories (e.g. ollama__qwen3/slide.pptx)
    all_files = sorted(out_dir.rglob("*.pptx")) + sorted(out_dir.rglob("*.zip"))
    
    for p in all_files:
        # Calculate relative path to display subfolders (e.g. "ollama__qwen3/Week1...")
        rel_name = str(p.relative_to(out_dir)).replace("\\", "/")
        
        # Determine a safe download URL (we need to encode the path if it has slashes)
        # However, simple API usually expects flat filenames. 
        # Strategy: The download_presentation endpoint needs to handle relative paths or we flatten the view.
        # Let's pass the relative path as the 'filename' param, ensuring the backend handles subdirs safely.
        
        files.append({
            "filename": rel_name, 
            "size_bytes": p.stat().st_size,
            "mtime": p.stat().st_mtime,
            "download_url": f"/api/project/{course_id}/presentation/{rel_name}",
        })
    
    # Sort by modification time descending
    files.sort(key=lambda x: x["mtime"], reverse=True)
    return {"ok": True, "files": files}

@app.get("/api/project/{course_id}/presentation/{filename:path}")
def download_presentation(course_id: str, filename: str):
    """
    PATCHED: filename:path allows slashes in the URL, enabling subdirectories.
    """
    course_id = _require_safe_course_id(course_id)
    # filename might be "ollama__qwen3/Week1.pptx"
    
    paths = _project_paths(course_id)
    out_dir = paths["final_presentations"]
    
    # Securely resolve path
    file_path = (out_dir / filename).resolve()
    
    # Ensure the resolved path is still inside the final_presentations folder
    if not str(file_path).startswith(str(out_dir.resolve())):
        raise HTTPException(status_code=400, detail="Unsafe path.")
        
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found.")

    media_type = "application/zip" if str(filename).lower().endswith(".zip") else "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    return FileResponse(path=str(file_path), filename=file_path.name, media_type=media_type)

@app.post("/api/project/{course_id}/slides_generate_week")
def slides_generate_week(course_id: str, payload: Dict[str, Any]):
    """Generate PPTX slides for the selected week (one PPTX per deck)."""
    course_id = _require_safe_course_id(course_id)
    paths = _project_paths(course_id)
    
    # PATCH: Determine specific output folder
    plan_mode = (payload.get("plan_mode") or "base").lower()
    llm_provider = payload.get("llm_provider", "unknown")
    llm_model = payload.get("llm_model", "unknown")
    
    target_out_dir = _get_slides_output_dir(paths["final_presentations"], plan_mode, llm_provider, llm_model)

    week_num = int(payload.get("week_number") or payload.get("week") or 1)
    plan_obj = payload.get("generated_plan")

    # Fallback loading logic
    if not plan_obj:
        fallback_path = paths["generated_llm_plan_json"] if plan_mode == "llm" and paths["generated_llm_plan_json"].exists() else paths["generated_plan_json"]
        if not fallback_path.exists():
            raise HTTPException(status_code=400, detail="No generated plan found. Generate a plan first.")
        plan_obj = json.loads(fallback_path.read_text(encoding="utf-8"))

    weeks = (plan_obj or {}).get("weeks", {}) or {}
    week_obj = weeks.get(str(week_num))
    if not week_obj:
        raise HTTPException(status_code=404, detail=f"Week {week_num} not found in plan.")

    template_path, layout_config_path = _resolve_slide_style_paths(
        template_path=payload.get("template_path"),
        layout_config_path=payload.get("layout_config_path"),
    )

    created = _generate_pptx_for_week(course_id, week_num, week_obj, template_path, layout_config_path, target_out_dir)
    
    # Return relative path for UI feedback
    rel_path = target_out_dir.relative_to(paths["root"])
    
    # Fix download URLs in response to include subdirectory
    for c in created:
        rel_file = Path(c["path"]).relative_to(paths["final_presentations"])
        c["download_url"] = f"/api/project/{course_id}/presentation/{rel_file}"

    return {"ok": True, "created": created, "output_dir": str(target_out_dir), "relative_output_dir": str(rel_path)}

@app.post("/api/project/{course_id}/slides_generate_all")
def slides_generate_all(course_id: str, payload: Dict[str, Any]):
    """Generate PPTX slides for ALL weeks.

    By default this only writes PPTX files into the output folder.
    Set payload["create_zip"]=true if you also want a zip bundle.
    """
    course_id = _require_safe_course_id(course_id)
    paths = _project_paths(course_id)

    # Determine specific output folder
    plan_mode = (payload.get("plan_mode") or "base").lower()
    llm_provider = payload.get("llm_provider", "unknown")
    llm_model = payload.get("llm_model", "unknown")

    target_out_dir = _get_slides_output_dir(paths["final_presentations"], plan_mode, llm_provider, llm_model)

    plan_obj = payload.get("generated_plan")
    if not plan_obj:
        fallback_path = paths["generated_llm_plan_json"] if plan_mode == "llm" and paths["generated_llm_plan_json"].exists() else paths["generated_plan_json"]
        if not fallback_path.exists():
            raise HTTPException(status_code=400, detail="No generated plan found. Generate a plan first.")
        plan_obj = json.loads(fallback_path.read_text(encoding="utf-8"))

    template_path, layout_config_path = _resolve_slide_style_paths(
        template_path=payload.get("template_path"),
        layout_config_path=payload.get("layout_config_path"),
    )

    weeks = (plan_obj or {}).get("weeks", {}) or {}
    created_all: List[Dict[str, Any]] = []
    for wk in sorted(weeks.keys(), key=lambda x: int(x) if str(x).isdigit() else 9999):
        week_obj = weeks[wk]
        created_all.extend(_generate_pptx_for_week(course_id, int(wk), week_obj, template_path, layout_config_path, target_out_dir))

    # Fix download URLs to include subdirectory
    for c in created_all:
        rel_file = Path(c["path"]).relative_to(paths["final_presentations"])
        c["download_url"] = f"/api/project/{course_id}/presentation/{rel_file}"

    create_zip = bool(payload.get("create_zip", False))
    zip_name = None
    zip_download_url = None

    if create_zip and created_all:
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        zip_name = f"{course_id}_slides_{plan_mode}_{ts}.zip"
        zip_path = target_out_dir / zip_name  # Save zip in the specific folder

        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for item in created_all:
                p = Path(item["path"])
                if p.exists():
                    zf.write(p, arcname=p.name)

        rel_zip = zip_path.relative_to(paths["final_presentations"])
        zip_download_url = f"/api/project/{course_id}/presentation/{rel_zip}"

    rel_dir_display = target_out_dir.relative_to(paths["root"])
    resp: Dict[str, Any] = {
        "ok": True,
        "created": created_all,
        "output_dir": str(target_out_dir),
        "relative_output_dir": str(rel_dir_display),
    }
    if create_zip and zip_name and zip_download_url:
        resp["zip_filename"] = zip_name
        resp["zip_download_url"] = zip_download_url
    return resp

@app.post("/api/project/{course_id}/open_presentation_folder")
def open_presentation_folder(course_id: str, payload: Dict[str, Any]):
    """Opens the local file explorer to the slides folder."""
    course_id = _require_safe_course_id(course_id)
    paths = _project_paths(course_id)
    
    plan_mode = (payload.get("plan_mode") or "base").lower()
    llm_provider = payload.get("llm_provider", "unknown")
    llm_model = payload.get("llm_model", "unknown")
    
    # Resolve the folder path using the same logic as generation
    target_dir = _get_slides_output_dir(paths["final_presentations"], plan_mode, llm_provider, llm_model)

    if not target_dir.exists():
        # Fallback to parent if specific model folder doesn't exist yet
        target_dir = paths["final_presentations"]
    
    path_str = str(target_dir.resolve())
    
    try:
        if sys.platform == "win32":
            os.startfile(path_str)
        elif sys.platform == "darwin":
            # Use Popen to avoid blocking the server response
            subprocess.Popen(["open", path_str])
        else:
            # Linux / WSL Logic
            if "microsoft-standard" in os.uname().release:
                # We are in WSL (Windows Subsystem for Linux), use Windows Explorer
                # We must convert the path to Windows format (wslpath -w)
                subprocess.Popen(["explorer.exe", subprocess.check_output(["wslpath", "-w", path_str]).strip()])
            else:
                # Standard Linux
                subprocess.Popen(["xdg-open", path_str])
                
        return {"ok": True, "path": path_str}
    except Exception as e:
        return {"ok": False, "message": str(e), "path": path_str}
