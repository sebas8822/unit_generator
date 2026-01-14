# Project-based PDF Planner UI

This version adds:
- A toolbar project selector (course_id + unit_name centered).
- Per-project folders under `data/<course_id>/...`.
- Separate outputs:
  - `generated_plan/generated_plan.json` (rule-based planner)
  - `generated_llm_plan/generated_llm_plan.json` (LLM planner)

## Folder structure

project_root/
  app.py
  extractor.py
  planner_simple.py
  generator_llm.py
  static/
    index.html
    app.js
    styles.css
  data/
    <course_id>/
      project.json
      plan.json
      unit_outline.json
      uploads/
      extracted/
        <source_id>/
          toc.json
          sections.jsonl
          ... extracted text files ...
      generated_plan/
        generated_plan.json
      generated_llm_plan/
        generated_llm_plan.json
      final_presentations/

## How to use

1) Copy the files from this bundle into your project:
- `app.py` -> your backend `app.py` (or merge the endpoints into yours)
- `static/*` -> your `static/` folder

2) Run:
uvicorn app:app --reload

3) In the UI:
- Click **New project** to create a new `course_id`
- Upload PDFs and outline
- Create/assign weekly plan
- Generate plans (simple and LLM)

