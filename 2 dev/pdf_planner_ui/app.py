from __future__ import annotations

import json
import requests
import logging
import hashlib
from pathlib import Path
from typing import Any, Dict
from fastapi import Query


from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from extractor import extract_pdf_for_ui
from planner_simple import generate_plan_from_ui_selection
from generator_llm import ContentGenerator




BASE_DIR = Path(__file__).parent.resolve()

DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
EXTRACTED_DIR = DATA_DIR / "extracted"
PLAN_PATH = DATA_DIR / "plan.json"
OUTLINE_PATH = DATA_DIR / "unit_outline.json"
GENERATED_PATH = DATA_DIR / "generated_plan.json"
GENERATED_LLM_PATH = DATA_DIR / "generated_llm_plan.json"

for p in [DATA_DIR, UPLOADS_DIR, EXTRACTED_DIR]:
    p.mkdir(parents=True, exist_ok=True)

# Create default plan if missing
if not PLAN_PATH.exists():
    PLAN_PATH.write_text(json.dumps({"weeks": {}}, indent=2), encoding="utf-8")

app = FastAPI(title="PDF ToC Week Planner")
logger = logging.getLogger(__name__)


# Serve static frontend
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.get("/")
def root():
    return FileResponse(str(BASE_DIR / "static" / "index.html"))


@app.get("/api/health")
def health():
    return {"ok": True}


def _sha1_bytes(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()


@app.post("/api/upload_pdf")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF.")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file.")

    source_id = _sha1_bytes(content)[:16]
    pdf_path = UPLOADS_DIR / f"{source_id}__{Path(file.filename).name}"
    pdf_path.write_bytes(content)

    out_dir = EXTRACTED_DIR / source_id
    out_dir.mkdir(parents=True, exist_ok=True)

    result = extract_pdf_for_ui(
        pdf_path=pdf_path,
        out_dir=out_dir,
        source_id=source_id,
        work_id="local_upload",
        unit_code="UNIT",
    )
    return JSONResponse(result)


@app.get("/api/toc/{source_id}")
def get_toc(source_id: str):
    toc_path = EXTRACTED_DIR / source_id / "toc.json"
    if not toc_path.exists():
        raise HTTPException(status_code=404, detail="ToC not found.")
    return JSONResponse(json.loads(toc_path.read_text(encoding="utf-8")))


@app.get("/api/plan")
def load_plan():
    return JSONResponse(json.loads(PLAN_PATH.read_text(encoding="utf-8")))


@app.post("/api/plan")
async def save_plan(payload: Dict[str, Any]):
    PLAN_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "saved_to": str(PLAN_PATH)}


@app.post("/api/upload_outline")
async def upload_outline(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Upload a JSON file (unit_outline.json).")
    content = await file.read()
    try:
        obj = json.loads(content.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON.")

    OUTLINE_PATH.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "weeks": obj.get("weeklySchedule", [])}


@app.get("/api/outline")
def get_outline():
    if not OUTLINE_PATH.exists():
        return JSONResponse({"weeklySchedule": []})
    return JSONResponse(json.loads(OUTLINE_PATH.read_text(encoding="utf-8")))


_SECTION_INDEX_CACHE: Dict[str, Dict[str, Any]] = {}

def _load_sections_index(source_id: str) -> Dict[str, Any]:
    """
    Returns dict: toc_id(str) -> record (from sections.jsonl)
    Cached by mtime.
    """
    jsonl_path = EXTRACTED_DIR / source_id / "sections.jsonl"
    if not jsonl_path.exists():
        return {}

    mtime = jsonl_path.stat().st_mtime
    cached = _SECTION_INDEX_CACHE.get(source_id)
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

    _SECTION_INDEX_CACHE[source_id] = {"mtime": mtime, "idx": idx}
    return idx

@app.get("/api/section_text/{source_id}/{toc_id}")
def section_text(
    source_id: str,
    toc_id: str,
    kind: str = Query("main", pattern="^(main|full)$"),
    max_chars: int = Query(20000, ge=200, le=200000),
):
    idx = _load_sections_index(source_id)
    rec = idx.get(str(toc_id))
    if not rec:
        raise HTTPException(status_code=404, detail="Section not found (toc_id).")

    # pick which text to show
    if kind == "full":
        text_path = rec.get("text_path_full_with_children") or rec.get("text_path") or ""
    else:
        text_path = rec.get("text_path_main") or rec.get("text_path") or ""

    text = ""
    if text_path:
        p = Path(text_path)
        try:
            rp = p.resolve()
            base = (EXTRACTED_DIR / source_id).resolve()
            if base not in rp.parents and rp != base:
                raise HTTPException(status_code=400, detail="Unsafe text path.")
        except Exception:
            raise HTTPException(status_code=400, detail="Bad text path.")

        if p.exists():
            text = p.read_text(encoding="utf-8", errors="ignore")[:max_chars]

    title_path = " / ".join(rec.get("titles_path") or [rec.get("title", "")]).strip()

    # end alias handling
    end_obj = rec.get("end") or rec.get("end_main") or rec.get("end_full")

    return JSONResponse({
        "source_id": source_id,
        "toc_id": rec.get("toc_id"),
        "title": rec.get("title"),
        "title_path": title_path,
        "start": rec.get("start"),
        "end": end_obj,
        "has_children_effective": rec.get("has_children_effective", False),
        "kind": kind,
        "text_chars": rec.get("text_chars", rec.get("text_chars_main", 0)),
        "text": text,
    })



@app.post("/api/generate_plan")
async def generate_plan(payload: Dict[str, Any]):
    plan = payload.get("plan") or {}
    config = payload.get("config") or {}

    # lookup function passed to planner
    def sections_index_lookup(source_id: str) -> Dict[str, Any]:
        if not source_id:
            return {}
        return _load_sections_index(source_id)

    result = generate_plan_from_ui_selection(
        plan=plan,
        config=config,
        sections_index_lookup=sections_index_lookup,
    )

    GENERATED_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return JSONResponse({"ok": True, "generated_path": str(GENERATED_PATH), "plan": result})

# ---------------------------------------------------------------------------
# LLM (Ollama) endpoints
# ---------------------------------------------------------------------------

def _ollama_list_models(host: str) -> list[str]:
    """Return model names from Ollama /api/tags."""
    host = (host or "").rstrip("/")
    url = f"{host}/api/tags"
    r = requests.get(url, timeout=5)
    r.raise_for_status()
    data = r.json() or {}
    models = data.get("models") or []
    names = []
    for m in models:
        name = m.get("name") if isinstance(m, dict) else None
        if name:
            names.append(name)
    return names

@app.get("/api/generated_plan")
def api_generated_plan():
    """Fetch the most recently generated plan from disk (if available)."""
    if not GENERATED_PATH.exists():
        return {"ok": True, "plan": None}
    try:
        return {"ok": True, "plan": json.loads(GENERATED_PATH.read_text(encoding="utf-8"))}
    except Exception as e:
        return {"ok": False, "error": f"Failed to read generated plan: {e}"}


@app.get("/api/generated_llm_plan")
def api_generated_llm_plan():
    """Fetch the LLM-enriched generated plan (if available)."""
    if not GENERATED_LLM_PATH.exists():
        return {"ok": True, "plan": {"weeks": {}}}
    try:
        return {"ok": True, "plan": json.loads(GENERATED_LLM_PATH.read_text(encoding="utf-8"))}
    except Exception as e:
        return {"ok": False, "error": f"Failed to read LLM generated plan: {e}"}

@app.get("/api/llm_health")
def api_llm_health(host: str = Query("http://localhost:11434"), model: str = Query(""), timeout_sec: int = Query(5)):
    """Checks whether Ollama is reachable and (optionally) whether a model exists."""
    try:
        # quick connect check
        host_clean = (host or "").rstrip("/")
        url = f"{host_clean}/api/tags"
        r = requests.get(url, timeout=max(1, int(timeout_sec)))
        r.raise_for_status()
        data = r.json() or {}
        models = data.get("models") or []
        names = [m.get("name") for m in models if isinstance(m, dict) and m.get("name")]
        found_model = None
        if model:
            found_model = model in names
        return {
            "ok": True,
            "host": host_clean,
            "model": model,
            "found_model": found_model,
            "models_count": len(names),
            "models": names[:25],  # keep payload small
        }
    except Exception as e:
        return {"ok": False, "host": host, "model": model, "error": str(e)}

@app.post("/api/llm_generate_week")
def api_llm_generate_week(payload: Dict[str, Any]):
    """
    Generate LLM slide drafts for a single week plan (from Step 4 output).
    Expects payload:
      - week: int
      - week_plan: dict (a week object with deck_plans/sections/content_blocks)
      - host: str (optional)
      - model: str (optional)
    Returns: updated week_plan with 'slides' filled in.
    """
    try:
        week = int(payload.get("week", 0) or 0)
        week_plan = payload.get("week_plan") or {}
        host = (payload.get("host") or "http://localhost:11434").strip()
        model = (payload.get("model") or "llama3.1").strip()

        if week <= 0:
            raise HTTPException(status_code=400, detail="Missing/invalid 'week'.")
        if not isinstance(week_plan, dict) or not week_plan.get("deck_plans"):
            raise HTTPException(status_code=400, detail="Missing/invalid 'week_plan' (needs deck_plans).")

        # Optional: verify host reachable & model exists (if provided)
        try:
            names = _ollama_list_models(host)
            if model and names and model not in names:
                # don't hard-fail; some hosts may not expose tags; but warn
                logger.warning("Requested model '%s' not found in /api/tags list.", model)
        except Exception as e:
            logger.warning("Ollama tags check failed: %s", e)

        gen = ContentGenerator(ollama_host=host, ollama_model=model)
        updated_week = gen.process_plan(week_plan)

        # Persist to a *separate* file so you can compare:
        #   - generated_plan.json        (deterministic allocator output)
        #   - generated_llm_plan.json    (LLM-enriched slide drafts)
        wk_key = str(week)

        # Load base plan as template (if it exists)
        if GENERATED_PATH.exists():
            try:
                base_full = json.loads(GENERATED_PATH.read_text(encoding="utf-8"))
            except Exception:
                base_full = {"weeks": {}}
        else:
            base_full = {"weeks": {}}

        # Load existing LLM plan or clone base structure
        llm_full = None
        if GENERATED_LLM_PATH.exists():
            try:
                llm_full = json.loads(GENERATED_LLM_PATH.read_text(encoding="utf-8"))
            except Exception:
                llm_full = None
        if not llm_full:
            llm_full = json.loads(json.dumps(base_full))

        llm_full.setdefault("weeks", {})
        llm_full["weeks"][wk_key] = updated_week

        try:
            GENERATED_LLM_PATH.write_text(json.dumps(llm_full, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to persist LLM plan into %s: %s", GENERATED_LLM_PATH, e)
        return {"ok": True, "week": week, "week_plan": updated_week, "plan": llm_full, "llm_generated_path": str(GENERATED_LLM_PATH)}
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.exception("LLM generation failed")
        raise HTTPException(status_code=500, detail=str(e))
