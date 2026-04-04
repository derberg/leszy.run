import json
import re
import time
from typing import Optional
import httpx

VOIVODESHIPS = [
    "Dolnośląskie", "Kujawsko-Pomorskie", "Łódzkie", "Lubelskie", "Lubuskie",
    "Małopolskie", "Mazowieckie", "Opolskie", "Podkarpackie", "Podlaskie",
    "Pomorskie", "Śląskie", "Świętokrzyskie", "Warmińsko-Mazurskie",
    "Wielkopolskie", "Zachodniopomorskie",
]


def build_prompt(event: dict, crawled: dict, pdf_text: Optional[str], config) -> str:
    """Build the full extraction prompt with all gathered context."""
    distances = event.get("distances") or "unknown"
    event_types = event.get("event_types")
    types_str = ", ".join(event_types) if event_types else "unknown"
    deadline = event.get("registration_deadline") or "unknown"
    price_from = event.get("price_from")
    price_to = event.get("price_to")
    price_str = f"{price_from}-{price_to} PLN" if price_from else "unknown"
    voivodeship = event.get("voivodeship") or "unknown"

    sections = []

    # Content sections — only include non-empty ones
    for field, label in [("website", "WEBSITE CONTENT"), ("registration_url", "REGISTRATION PAGE")]:
        content = crawled.get(field)
        if content and isinstance(content, str) and content.strip():
            url = event.get(field, "")
            sections.append(f"--- {label} ({url}) ---\n{content}")

    if pdf_text and pdf_text.strip():
        regulamin_url = event.get("regulamin_url", "")
        sections.append(f"--- REGULAMIN ({regulamin_url}) ---\n{pdf_text}")
    elif crawled.get("regulamin_url"):
        regulamin_url = event.get("regulamin_url", "")
        sections.append(f"--- REGULAMIN ({regulamin_url}) ---\n{crawled['regulamin_url']}")

    context_block = "\n\n".join(sections) if sections else "(No web content or PDF available)"

    return f"""You are extracting structured data about a Polish running/walking race event.

Event name: {event.get("name", "")}
Event date: {event.get("date", "")}
Event location: {event.get("location", "unknown")}
Currently known data:
  distances: {distances}
  event_types: {types_str}
  registration_deadline: {deadline}
  price: {price_str}
  voivodeship: {voivodeship}

{context_block}

Extract ALL of the following. Return ONLY valid JSON, no other text:
{{
  "distances": ["5 km", "10 km", "21.1 km", "6h", "200m"],
  "event_types": ["uliczny", "trail", ...],
  "registration_deadline": "YYYY-MM-DD" or null,
  "price_from": number (PLN, e.g. 50) or null,
  "price_to": number (PLN, e.g. 120) or null,
  "voivodeship": "one of 16 Polish voivodeships" or null,
  "is_kids": true or false,
  "website": "https://..." or null,
  "registration_url": "https://..." or null,
  "regulamin_url": "https://..." or null,
  "url_is_regulamin": true or false,
  "url_is_registration": true or false
}}

DISTANCE RULES:
- Include all actual race distances (not age limits, elevation, or other numbers)
- Format: "N km" for kilometer distances (e.g. "5 km", "21.1 km", "42.2 km")
- półmaraton = "21.1 km", maraton = "42.2 km"
- Time-based ultras: "4h", "6h", "12h", "24h" (for timed events like "bieg 6-godzinny")
- Short/kids distances: "200m", "500m" (for distances under 1 km)
- If no distances found, use empty array []

EVENT TYPE RULES — classify into one or more. NEVER use "bieg". Valid types:
- "uliczny" — DEFAULT for most events. Road/city, asphalt, PZLA certified, sidewalks, cycling paths, cobblestone
- "trail" — off-road: forest paths, dirt trails, mountain, cross-country, mud, gravel, significant elevation
- "nocny" — night race, starts after 20:00, headlamp required
- "ocr" — obstacle course race, mud run, survival, extreme
- "nordic walking" — has nordic walking category alongside running
- "ultra" — any running distance over 50 km, or timed events (6h, 12h, 24h)
- "charytatywny" — charity event, proceeds go to a cause, fundraiser
An event can have MULTIPLE types (e.g. ["trail", "nocny"] for a night trail run).

PRICE RULES:
- price_from: cheapest registration option in PLN (whole number, e.g. 50)
- price_to: most expensive registration option in PLN (whole number, e.g. 120)
- If only one price exists, set both to the same value
- Convert from grosze if needed (5000 groszy = 50 PLN)
- If no price info found, use null

VOIVODESHIP: must be exactly one of: {", ".join(VOIVODESHIPS)}

URL VALIDATION:
- url_is_regulamin: does the regulamin_url page/PDF actually contain race regulations? true/false
- url_is_registration: does the registration_url page actually contain a registration form? true/false
- If you find better URLs for website/registration/regulamin in the content, include them

is_kids: true if any distance is ≤ 1 km OR if there is a dedicated children's category"""


def call_ollama(prompt: str, config) -> Optional[dict]:
    """Call Ollama API and return parsed JSON response."""
    start = time.time()
    try:
        with httpx.Client(timeout=300) as client:
            resp = client.post(
                f"{config.ollama_url}/api/generate",
                json={
                    "model": config.ollama_model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": config.ollama_temperature,
                        "num_predict": config.ollama_max_tokens,
                    },
                },
            )
            resp.raise_for_status()

        data = resp.json()
        raw_text = data.get("response", "")
        duration = time.time() - start
        parsed = parse_llm_response(raw_text)
        if parsed:
            parsed["_duration_s"] = round(duration, 1)
        return parsed

    except Exception:
        return None


def parse_llm_response(raw: str) -> Optional[dict]:
    """Extract JSON from LLM response text. Handles markdown code blocks."""
    if not raw:
        return None

    # Strip markdown code fences
    cleaned = re.sub(r"```json\s*", "", raw)
    cleaned = re.sub(r"```\s*", "", cleaned)

    # Find JSON object
    match = re.search(r"\{[\s\S]*\}", cleaned)
    if not match:
        return None

    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
