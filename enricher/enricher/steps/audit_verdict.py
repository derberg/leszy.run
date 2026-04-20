"""AuditVerdict dataclass and LLM call wrapper for the audit command."""
import json
import re
import time
from dataclasses import dataclass
from typing import Optional

import httpx


ALLOWED_VERDICTS = {"match", "mismatch", "uncertain"}


@dataclass
class AuditVerdict:
    verdict: str           # "match" | "mismatch" | "uncertain"
    confidence: float      # 0.0..1.0
    reasoning: str
    duration_s: float = 0.0


def parse_verdict(raw: Optional[str]) -> Optional[AuditVerdict]:
    """Extract a verdict from raw LLM text. Returns None on any failure."""
    if not raw:
        return None

    cleaned = re.sub(r"```json\s*", "", raw)
    cleaned = re.sub(r"```\s*", "", cleaned)
    match = re.search(r"\{[\s\S]*\}", cleaned)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None

    verdict = obj.get("verdict")
    confidence = obj.get("confidence")
    reasoning = obj.get("reasoning")
    if verdict not in ALLOWED_VERDICTS:
        return None
    if not isinstance(confidence, (int, float)):
        return None
    if not isinstance(reasoning, str):
        return None

    # Clamp confidence to [0, 1]
    conf = float(confidence)
    if conf > 1.0:
        conf = 1.0
    if conf < 0.0:
        conf = 0.0

    return AuditVerdict(verdict=verdict, confidence=conf, reasoning=reasoning)


def call_audit_llm(prompt: str, config) -> Optional[AuditVerdict]:
    """Call Ollama for an audit verdict. Returns None on any error."""
    start = time.time()
    try:
        with httpx.Client(timeout=600) as client:
            resp = client.post(
                f"{config.ollama_url}/api/generate",
                json={
                    "model": config.ollama_model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": config.ollama_temperature,
                        "num_predict": config.ollama_max_tokens,
                        "num_ctx": 32768,
                    },
                },
            )
            resp.raise_for_status()
        data = resp.json()
        raw = data.get("response", "")
        verdict = parse_verdict(raw)
        if verdict:
            verdict.duration_s = round(time.time() - start, 1)
        return verdict
    except Exception:
        return None
