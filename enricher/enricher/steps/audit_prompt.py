"""Prompts for the website audit.

Fast prompt: tiny, based on FastPage (title, meta, h1, 2KB body).
Full prompt: longer, based on crawled markdown content from Crawl4AI.

Both ask the LLM to return identical JSON shape so the caller parses one way.
"""
from typing import Optional

from enricher.steps.audit_fetch import FastPage


JSON_INSTRUCTIONS = """Return ONLY valid JSON, no prose, no code fences. Shape:
{
  "verdict": "match" | "mismatch" | "uncertain",
  "confidence": 0.0 to 1.0,
  "reasoning": "one to three short sentences in English explaining the decision, citing concrete evidence (event name on page, year in title, city in body, distances, etc.)"
}

Use "match" when the page is clearly about this specific event (same name or close variant, same year, same city).
Use "mismatch" when the page is clearly about a different event, a past edition of the same name, a news article, an aggregator listing, or is unrelated.
Use "uncertain" only if you genuinely cannot tell from the provided content."""


def _fmt_distances(d) -> str:
    if not d:
        return "unknown"
    if isinstance(d, list):
        return ", ".join(str(x) for x in d)
    return str(d)


def _fmt_val(v, default: str = "unknown") -> str:
    if v is None or v == "":
        return default
    return str(v)


def build_fast_prompt(event: dict, field: str, url: str, page: FastPage) -> str:
    """Build the lean fast-path prompt from extracted HTML fragments."""
    h1_joined = " | ".join(page.h1) if page.h1 else "(none)"
    return f"""You are auditing whether a webpage actually belongs to a specific Polish running/walking event.

EVENT:
  name: {_fmt_val(event.get("name"))}
  date: {_fmt_val(event.get("date"))}
  city: {_fmt_val(event.get("location"))}
  voivodeship: {_fmt_val(event.get("voivodeship"))}
  known distances: {_fmt_distances(event.get("distances"))}

FIELD UNDER AUDIT: {field}
URL: {url}

PAGE (extracted from HTML):
  <title>: {_fmt_val(page.title, "(empty)")}
  <meta description>: {_fmt_val(page.meta_description, "(empty)")}
  <h1>: {h1_joined}
  body sample: {_fmt_val(page.body_sample, "(empty)")}

{JSON_INSTRUCTIONS}"""


def build_full_prompt(
    event: dict,
    field: str,
    url: str,
    crawled_content: str,
    max_content_chars: int,
) -> str:
    """Build the full-path prompt using Crawl4AI markdown content."""
    content = (crawled_content or "")[:max_content_chars]
    if not content.strip():
        content = "(page appeared empty after rendering)"
    return f"""You are auditing whether a webpage actually belongs to a specific Polish running/walking event.

EVENT:
  name: {_fmt_val(event.get("name"))}
  date: {_fmt_val(event.get("date"))}
  city: {_fmt_val(event.get("location"))}
  voivodeship: {_fmt_val(event.get("voivodeship"))}
  known distances: {_fmt_distances(event.get("distances"))}

FIELD UNDER AUDIT: {field}
URL: {url}

PAGE CONTENT (rendered with JavaScript, up to {max_content_chars} chars):
{content}

{JSON_INSTRUCTIONS}"""
