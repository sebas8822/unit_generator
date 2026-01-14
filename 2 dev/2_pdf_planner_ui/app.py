from __future__ import annotations

import json
import hashlib
import re
import datetime 
from pathlib import Path
from typing import Any, Dict, Optional

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

    paths["generated_plan_json"].write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return JSONResponse({"ok": True, "generated_path": str(paths["generated_plan_json"]), "plan": result})

@app.get("/api/project/{course_id}/generated_plan")
def get_generated_plan(course_id: str):
    paths = _ensure_project(course_id)
    return JSONResponse(_read_json_or_default(paths["generated_plan_json"], {}))

@app.get("/api/project/{course_id}/generated_llm_plan")
def get_generated_llm_plan(course_id: str):
    paths = _ensure_project(course_id)
    return JSONResponse(_read_json_or_default(paths["generated_llm_plan_json"], {}))

@app.get("/api/project/{course_id}/llm_health")
def api_llm_health(course_id: str, host: str = Query("http://localhost:11434"), model: str = Query("qwen3:8b")):
    _ensure_project(course_id)
    try:
        gen = ContentGenerator(ollama_host=host, ollama_model=model)
        # Call the new real check
        check = gen.validate_server_and_model()
        return JSONResponse(check)
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)})

@app.post("/api/project/{course_id}/llm_generate_week")
async def api_llm_generate_week(course_id: str, payload: Dict[str, Any]):
    """
    Generates enriched content for one week using the LLM.
    Saves to: data/<course_id>/generated_llm_plan/generated_llm_plan.json
    """
    paths = _ensure_project(course_id)
    project = _read_json_or_default(paths["project_json"], {"course_id": course_id, "unit_name": ""})

    host = payload.get("ollama_host", "http://localhost:11434")
    model = payload.get("ollama_model", "qwen3:8b")

    try:
        gen = ContentGenerator(ollama_host=host, ollama_model=model)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM init failed: {e}")

    week_number = int(payload.get("week_number", 1))
    generated_plan = payload.get("generated_plan") or {}  # full plan structure

    # 1. Drill down to the specific week's data
    weeks_map = generated_plan.get("weeks", {})
    week_key = str(week_number)
    
    if week_key not in weeks_map:
        raise HTTPException(status_code=404, detail=f"Week {week_number} not found in generated plan.")

    week_data = weeks_map[week_key]

    # Add project meta as context (optional, if you need it later)
    context = {
        "course_id": project.get("course_id", course_id),
        "unit_name": project.get("unit_name", ""),
    }

    try:
        # 2. Process JUST that week's data (week_data contains 'deck_plans')
        # process_plan modifies the dictionary in-place
        gen.process_plan(week_data) 
        
        # 3. Update the full plan with the modified week
        # (This step is implicit since 'week_data' is a reference to the dict inside 'generated_plan',
        # but explicit assignment is fine too).
        
        # 4. Save the FULL plan to disk (preserving other weeks)
        paths["generated_llm_plan_json"].write_text(json.dumps(generated_plan, ensure_ascii=False, indent=2), encoding="utf-8")
        
        # 5. Return the FULL plan so the frontend can update state
        return JSONResponse({"ok": True, "generated_path": str(paths["generated_llm_plan_json"]), "plan": generated_plan})

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM generation failed: {e}")