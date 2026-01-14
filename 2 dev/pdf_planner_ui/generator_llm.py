from __future__ import annotations

import json
import re
import logging
import os
from typing import Dict, Any, Optional, List
import ollama
from tenacity import retry, stop_after_attempt, wait_exponential

# Basic Logger
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# =============================================================================
# PROMPTS
# =============================================================================

SINGLE_STEP_CONTENT_SLIDE_GENERATION_PROMPT = """
You are an expert university lecturer and instructional designer with a keen eye for slide composition. Your task is not just to summarize text, but to design a clear and effective PowerPoint slide.

**CONTEXT:**
- **Main Topic:** "{main_topic_title}"
- **The ENTIRE Raw Text for this Topic:** ```{topic_raw_content}```
- **Total Slides to Create:** You must cover all the key concepts in the raw text over a total of **{total_slides_for_topic}** slides.
- **Current Task:** You are generating slide **{current_slide_num}** of {total_slides_for_topic}.
- **Topics Already Covered on Previous Slides:** {generation_history}

**YOUR GOAL AND INSTRUCTIONS:**
1.  **Analyze the ENTIRE raw text.** Identify the distinct sub-topics within it.
2.  **Review the topics already covered** in the `generation_history`.
3.  **Identify the NEXT logical sub-topic from the raw text that has NOT been covered yet.** Your primary goal is to ensure comprehensive coverage without repetition.
4.  **Create the content for a single slide** that is focused *only* on this new, uncovered sub-topic.
5.  **Bold key concepts** by enclosing important keywords or phrases in **double asterisks**. This helps emphasize critical terminology."
6.  **Slide Composition and Object Structuring (CRITICAL):**
    -   This is your most important design task. Evaluate the content for this slide. If it contains two distinct but related components that would benefit from being presented side-by-side (e.g., 'Requirements' vs. 'Procedures', 'Pros' and 'Cons', 'Problem' and 'Solution'), you **MUST** structure your output to use **two objects** in the `objects` array.
    -   If the content is a single, unified topic, use only **one object**.
    -   **Crucial Rule:** Do not merge two distinct lists that could be separate into a single bullet point object. Use two objects to create a two-column layout.
7.  Your output **MUST** be a single, well-formed JSON object. Do not add any text or explanations outside the JSON object.

**JSON OUTPUT STRUCTURE & RULES:**
{{
  "title": "string | The main title for the slide, consistent with the main topic.",
  "subtitle": "string | A more specific subtitle for this particular slide. Ensure this exists",
  "objects": [
    {{
      "content_type": "string | CHOOSE ONE: 'bullet_points', 'table'.",
      "content_purpose": "string | CHOOSE ONE: 'description', 'explanation', 'timeline', 'process', 'cycle', 'comparison', 'contrast', 'hierarchy', 'case_study', 'example'.",
      "data": "object | The structured data for the slide. See examples below."
    }}
  ]
}}

**DATA STRUCTURE EXAMPLES:**
- For "bullet_points": "data": ["Point 1", {{"text": "Point 2", "children": ["Sub-point 2.1"]}}]
- For "table": "data": {{"headers": ["Col A"], "rows": [["Data 1"]]}}

Now, generate the JSON for slide {current_slide_num}.
"""

MULTIPLE_STEP_CONTENT_SLIDE_GENERATION_PROMPT = """
You are an expert university lecturer and instructional designer with a keen eye for slide composition. Your task is to create the content for a single, specific PowerPoint slide based on a pre-defined plan.

**CONTEXT:**
- **Main Topic:** "{main_topic_title}"
- **The ENTIRE Raw Text for this Topic:** ```{topic_raw_content}```
- **Current Task:** You are generating slide **{current_slide_num}** of **{total_slides_for_topic}**.
- **Slide Focus:** This slide should be exclusively about **"{slide_subtitle_to_generate}"**.
- **Topics Already Covered on Previous Slides:** {generation_history}

**YOUR GOAL AND INSTRUCTIONS:**
1.  **Refer to the ENTIRE raw text** to find the information related to **"{slide_subtitle_to_generate}"**.
2.  **Create the content for this single slide.**
3.  **Do not repeat content from previous slides** as detailed in the history.
4.  **Bold key concepts** by enclosing important keywords or phrases in **double asterisks**. This helps emphasize critical terminology."
5.  **Slide Composition and Object Structuring (CRITICAL):**
    -   This is your most important design task. Evaluate the content for this slide. If it contains two distinct but related components that would benefit from being presented side-by-side (e.g., 'Requirements' vs. 'Procedures', 'Pros' and 'Cons', 'Problem' and 'Solution'), you **MUST** structure your output to use **two objects** in the `objects` array.
    -   If the content is a single, unified topic, use only **one object**.
    -   **Crucial Rule:** Do not merge two distinct lists that could be separate into a single bullet point object. Use two objects to create a two-column layout.
6.  Your output **MUST** be a single, well-formed JSON object.

**JSON OUTPUT STRUCTURE & RULES:**
{{
  "title": "string | The main title for the slide, consistent with the main topic.",
  "subtitle": "string | A more specific subtitle for this particular slide. Ensure this exits",
  "objects": [
    {{
      "content_type": "string | CHOOSE ONE: 'bullet_points', 'table'.",
      "content_purpose": "string | CHOOSE ONE: 'description', 'explanation', 'timeline', 'process', 'cycle', 'comparison', 'contrast', 'hierarchy', 'case_study', 'example'.",
      "data": "object | The structured data for the slide. See examples below."
    }}
  ]
}}

**DATA STRUCTURE EXAMPLES:**
- For "bullet_points": "data": ["Point 1", {{"text": "Point 2", "children": ["Sub-point 2.1"]}}]
- For "table": "data": {{"headers": ["Col A"], "rows": [["Data 1"]]}}

Now, generate the JSON for slide {current_slide_num}.
"""

INTERACTIVE_ACTIVITY_PROMPT = """
You are an engaging university lecturer creating an interactive slide to test student understanding.

**CONTEXT:**
- **Topic for this Activity:** "{topic_title}"
- **Raw Text Content for this Topic:** ```{topic_raw_content}```

**INSTRUCTIONS:**
1.  Create a single, insightful multiple-choice question that assesses a key concept from the provided raw text.
2.  The question must have exactly 4 options. Provide the correct answer and a brief, clear explanation.
3.  Your output **MUST** be a single, well-formed JSON object that adheres strictly to the structure below.

**JSON OUTPUT STRUCTURE:**
{{
  "title": "Let's Apply This!",
  "subtitle": "Knowledge Check: {topic_title}",
  "objects": [
    {{
      "content_type": "multiple_choice_question",
      "content_purpose": "knowledge_check",
      "data": {{
        "question_text": "string | The question to be asked.",
        "options": [
          {{"label": "A", "text": "string"}},
          {{"label": "B", "text": "string"}},
          {{"label": "C", "text": "string"}},
          {{"label": "D", "text": "string"}}
        ],
        "correct_answer": {{
          "label": "string | e.g., 'B'",
          "explanation": "string | A brief explanation of why this answer is correct."
        }}
      }}
    }}
  ]
}}

Now, generate the JSON for the interactive activity.
"""

SUMMARY_GENERATION_PROMPT = """
You are an expert university lecturer crafting the final, conclusive summary slide for a lecture.

**CONTEXT:**
- **Overall Lecture Topic:** "{lecture_topic}"
- **Detailed Content of Slides Presented:**
```json
{slide_content_details}
INSTRUCTIONS: Analyze the detailed content of all the slides provided in the JSON context. Synthesize the most critical points into 3-5 concise, high-level takeaways. Do not just list the subtitles. Capture the core lesson of each major section. Your output MUST be a single, well-formed JSON object that adheres to the standard slide structure below. This ensures it can be rendered correctly.

JSON OUTPUT STRUCTURE: {{ "title": "Summary & Key Takeaways", "subtitle": null, "objects": [ {{ "content_type": "bullet_points", "content_purpose": "description", "data": [ "string | Key takeaway 1.", "string | Key takeaway 2.", "string | Key takeaway 3.", "string | Key takeaway 4.", "string | Key takeaway 5." ] }} ] }} Now, generate the JSON for the final summary slide. """

PLANNING_PROMPT = """ You are an expert instructional designer tasked with creating a content plan for a series of PowerPoint slides.

CONTEXT:

Main Topic: "{main_topic_title}"

The ENTIRE Raw Text for this Topic: {topic_raw_content}

Total Slides to Create: You must create a plan to cover all the key concepts in the raw text over a total of {total_slides_for_topic} slides.

YOUR GOAL AND INSTRUCTIONS:

Analyze the ENTIRE raw text.

Identify the main sub-topics that need to be covered.

Create a plan to break down these sub-topics into a sequence of {total_slides_for_topic} slides. Each slide in your plan should cover a distinct and logical piece of information.

Your output MUST be a single, well-formed JSON object that is an array of slide plans. Do not add any text or explanations outside of the JSON object.

JSON OUTPUT STRUCTURE & RULES: {{ "slide_plan": [ {{ "slide_number": 1, "subtitle": "A concise and descriptive subtitle for this slide's content." }}, {{ "slide_number": 2, "subtitle": "A concise and descriptive subtitle for the next slide's content." }} ] }}

Now, generate the JSON for the slide plan. """

class ContentGenerator:

    def __init__(
        self,
        ollama_host: str = "http://localhost:11434",
        ollama_model: str = "llama3.1:8b",
        model_name: Optional[str] = None,
    ):
        """Create a generator for an Ollama chat model.

        Compatibility note:
        - Older callers may pass `ollama_model=...`.
        - The UI/API may pass `model_name=...`.

        If both are provided, `model_name` takes precedence.
        """
        if model_name:
            ollama_model = model_name

        self.client = ollama.Client(host=ollama_host)
        self.model = ollama_model
        self.total_slides_to_generate = 0
        self.llm_calls_made = 0

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=5))
    def _call_ollama_with_retry(self, prompt: str) -> str:
        self.llm_calls_made += 1
        logger.info(f"LLM Call {self.llm_calls_made}/{self.total_slides_to_generate} (approx). Model: {self.model}")
        response = self.client.chat(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            format="json",
            options={"temperature": 0.2}
        )
        if not response or 'message' not in response or not response['message'].get('content'):
            raise ValueError("Ollama returned empty response.")
        return response['message']['content']

    def _parse_llm_json_output(self, content: str) -> Optional[Dict]:
        try:
            match = re.search(r'\{.*\}', content, re.DOTALL)
            if not match: return None
            return json.loads(match.group(0))
        except (json.JSONDecodeError, TypeError):
            return None

    def _count_total_slides(self, plan_data: Dict) -> int:
        count = 0
        for deck in plan_data.get('deck_plans', []):
            if any(s.get('section_type') == 'Summary' for s in deck.get('sections', [])):
                count += 1
            for section in deck.get('sections', []):
                if section.get('section_type') == 'Content':
                    for content_block in section.get('content_blocks', []):
                        def _rec(node):
                            nonlocal count
                            count += int(node.get('direct_slides_content', 0))
                            if 'interactive_activity' in node:
                                count += 1
                            for child in node.get('children', []):
                                _rec(child)
                        _rec(content_block)
        return count

    def _process_content_node_recursively(self, node: dict):
        num_slides = int(node.get('direct_slides_content', 0))
        generated_slides = []

        if num_slides > 0:
            content_text = node.get('content', '')
            if num_slides == 1:
                # Single slide case
                prompt = SINGLE_STEP_CONTENT_SLIDE_GENERATION_PROMPT.format(
                    main_topic_title=node.get('title'),
                    topic_raw_content=content_text,
                    current_slide_num=1,
                    total_slides_for_topic=1,
                    generation_history="None."
                )
                try:
                    res = self._call_ollama_with_retry(prompt)
                    slide_json = self._parse_llm_json_output(res)
                    if slide_json:
                        generated_slides.append({
                            "seq_id": float(f"{node.get('seq_id', 0)}.1"),
                            "llm_generated_content": slide_json
                        })
                except Exception as e:
                    logger.error(f"Error gen single slide for {node.get('title')}: {e}")

            else:
                # Multi-slide case
                try:
                    # Plan
                    plan_prompt = PLANNING_PROMPT.format(
                        main_topic_title=node.get('title'),
                        topic_raw_content=content_text,
                        total_slides_for_topic=num_slides
                    )
                    plan_res = self._call_ollama_with_retry(plan_prompt)
                    plan_json = self._parse_llm_json_output(plan_res)
                    slide_plan = plan_json.get("slide_plan", []) if plan_json else []

                    # Execute
                    history = "None."
                    for i, item in enumerate(slide_plan):
                        if i >= num_slides: break
                        subtitle = item.get("subtitle", f"Part {i+1}")
                        gen_prompt = MULTIPLE_STEP_CONTENT_SLIDE_GENERATION_PROMPT.format(
                            main_topic_title=node.get('title'),
                            topic_raw_content=content_text,
                            current_slide_num=i+1,
                            total_slides_for_topic=num_slides,
                            slide_subtitle_to_generate=subtitle,
                            generation_history=history
                        )
                        res = self._call_ollama_with_retry(gen_prompt)
                        slide_json = self._parse_llm_json_output(res)
                        if slide_json:
                            generated_slides.append({
                                "seq_id": float(f"{node.get('seq_id', 0)}.{i+1}"),
                                "llm_generated_content": slide_json
                            })
                            history += f"\n- Slide {i+1}: {slide_json.get('subtitle')}"
                except Exception as e:
                    logger.error(f"Error gen multi slides for {node.get('title')}: {e}")

            if generated_slides:
                node['slides'] = generated_slides

        # Interactive
        if 'interactive_activity' in node:
            try:
                prompt = INTERACTIVE_ACTIVITY_PROMPT.format(
                    topic_title=node.get('title'),
                    topic_raw_content=node.get('content', '')
                )
                res = self._call_ollama_with_retry(prompt)
                act_json = self._parse_llm_json_output(res)
                if act_json:
                    node['interactive_activity']['llm_generated_content'] = act_json
            except Exception as e:
                logger.error(f"Error gen interactive for {node.get('title')}: {e}")

        # Children
        for child in node.get('children', []):
            self._process_content_node_recursively(child)

    def process_plan(self, plan_data: Dict) -> Dict:
        """
        Main entry point to process a plan dictionary in-place.
        Returns the modified plan dictionary.
        """
        self.total_slides_to_generate = self._count_total_slides(plan_data)
        logger.info(f"Starting LLM Generation. Total estimated slides: {self.total_slides_to_generate}")

        for deck in plan_data.get('deck_plans', []):
            all_slide_contents = []

            # 1. Generate content for blocks
            for section in deck.get('sections', []):
                if section.get('section_type') == 'Content':
                    for block in section.get('content_blocks', []):
                        self._process_content_node_recursively(block)

            # 2. Collect content for Summary
            for section in deck.get('sections', []):
                if section.get('section_type') == 'Content':
                    for block in section.get('content_blocks', []):
                        def collect(n):
                            for s in n.get('slides', []):
                                if 'llm_generated_content' in s:
                                    all_slide_contents.append(s['llm_generated_content'])
                            if 'interactive_activity' in n and 'llm_generated_content' in n['interactive_activity']:
                                all_slide_contents.append(n['interactive_activity']['llm_generated_content'])
                            for ch in n.get('children', []):
                                collect(ch)
                        collect(block)

            # 3. Generate Summary
            summary_section = next((s for s in deck['sections'] if s.get('section_type') == 'Summary'), None)
            if summary_section and all_slide_contents:
                try:
                    prompt = SUMMARY_GENERATION_PROMPT.format(
                        lecture_topic=plan_data.get('overall_topic', 'Lecture'),
                        slide_content_details=json.dumps(all_slide_contents, indent=2)
                    )
                    res = self._call_ollama_with_retry(prompt)
                    sum_json = self._parse_llm_json_output(res)
                    if sum_json:
                        summary_section['llm_generated_content'] = sum_json
                except Exception as e:
                    logger.error(f"Error generating summary: {e}")

        return plan_data
