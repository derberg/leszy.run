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


def build_prompt(event: dict, crawled: dict, pdf_text: Optional[str], config, hints: Optional[dict] = None) -> str:
    """Build the full extraction prompt with all gathered context.

    hints: optional dict from regex pre-pass {price_from, price_to, registration_deadline}.
           Surfaced in the prompt so the LLM can confirm/correct concrete values rather
           than guess.
    """
    from enricher.steps.chunks import build_focused_context

    scraper_distances = event.get("distances") or ""
    event_types = event.get("event_types")
    types_str = ", ".join(event_types) if event_types else "unknown"
    deadline = event.get("registration_deadline") or "unknown"
    price_from = event.get("price_from")
    price_to = event.get("price_to")
    price_str = f"{price_from}-{price_to} PLN" if price_from else "unknown"
    voivodeship = event.get("voivodeship") or "unknown"

    # Build focused chunks (prices, deadlines, distances) from the regulamin only.
    # `crawled` here contains at most the regulamin HTML page; registration/website
    # content is never passed in (extraction is regulamin-only by design).
    focused = build_focused_context(crawled, pdf_text)

    # Raw regulamin context (for event types, kids categories, etc.). Focused
    # chunks already carry price/deadline/distance, so raw can be shorter.
    raw_limit = 2000 if focused else config.max_page_chars
    sections = []
    if pdf_text and pdf_text.strip():
        regulamin_url = event.get("regulamin_url", "")
        sections.append(f"--- REGULAMIN ({regulamin_url}) ---\n{pdf_text[:raw_limit]}")
    elif crawled.get("regulamin_url"):
        regulamin_url = event.get("regulamin_url", "")
        sections.append(f"--- REGULAMIN ({regulamin_url}) ---\n{crawled['regulamin_url'][:raw_limit]}")

    raw_context = "\n\n".join(sections) if sections else ""

    # Combine: focused chunks first (most important), then raw context
    if focused and raw_context:
        context_block = focused + "\n\n=== FULL PAGE CONTENT (for event types, URLs, other details) ===\n" + raw_context
    elif focused:
        context_block = focused
    elif raw_context:
        context_block = raw_context
    else:
        context_block = "(No regulamin content available)"

    # Hints block (regex pre-pass) — give LLM concrete anchors it can confirm
    hints_lines = []
    if hints:
        if hints.get("price_from") is not None and hints.get("price_to") is not None:
            hints_lines.append(
                f"  price candidates (regex-detected): {hints['price_from']} PLN (min), {hints['price_to']} PLN (max)"
            )
        if hints.get("registration_deadline"):
            hints_lines.append(
                f"  deadline candidate (regex-detected): {hints['registration_deadline']}"
            )
    hints_block = "\n".join(hints_lines)

    distances_line = f"  distances: {scraper_distances or 'unknown'}"
    if scraper_distances:
        distances_line += (
            "\n    ^^ These distances were already confirmed by the source listing."
            " Include ALL of them in your 'distances' output unless the regulamin"
            " explicitly contradicts (e.g. a distance was cancelled). Feel free"
            " to add more if the regulamin/page lists additional distances."
        )

    return f"""Extract structured data about a Polish running/walking race event.
Return ONLY valid JSON, no other text.

EVENT:
  name: {event.get("name", "")}
  date: {event.get("date", "")}
  location: {event.get("location", "unknown")}
{distances_line}
  event_types: {types_str}
  registration_deadline: {deadline}
  price: {price_str}
  voivodeship: {voivodeship}
{(chr(10) + 'REGEX PRE-PASS HINTS (confirm or correct with evidence from content below):' + chr(10) + hints_block) if hints_block else ''}

{context_block}

RESPOND WITH THIS EXACT JSON STRUCTURE (use null for any field not found in content — NEVER copy the placeholder/example values below; they show the SHAPE only, not real data):
{{
  "distances": ["<KM>", "<KM>"],
  "event_types": ["uliczny"],
  "registration_deadline": "YYYY-MM-DD",
  "price_from": null,
  "price_to": null,
  "location": null,
  "voivodeship": null,
  "is_kids": false,
  "registration_url": "<REPLACE-WITH-REAL-OR-NULL>",
  "regulamin_url": "<REPLACE-WITH-REAL-OR-NULL>",
  "url_is_regulamin": true,
  "url_is_registration": true
}}

Use null for any field you cannot determine from the provided content. The <REPLACE-WITH-REAL-OR-NULL> markers are placeholders — never emit them as output and never emit any example.com/example.pl URL.

=== FIELD RULES ===

DISTANCES:
- Format: "N km" (e.g. "5 km", "21.1 km"). półmaraton = "21.1 km", maraton = "42.2 km"
- Time-based: "6h", "12h", "24h". Short: "200m", "500m"
- Only actual race distances, not age limits or elevation numbers
- Empty array [] if none found

EVENT TYPES (one or more, NEVER use "bieg"):
- "uliczny" — road/city/asphalt, PZLA certified, cycling paths, cobblestone. DEFAULT for most events
- "trail" — off-road: forest, dirt, mountain, cross-country, mud, gravel, hills, "górski", "ślężański". IMPORTANT: "przełajowy", "cross", "bieg przełajowy", "górski" = ALWAYS trail, never uliczny. Also: races around/on mountains (Ślęża, Śnieżka, etc.) are trail even if partially on roads
- "nocny" — night race, starts after 20:00, headlamp required
- "ocr" — obstacle course, mud run, survival, extreme
- "nordic walking" — has NW category alongside running
- "ultra" — distance over 50 km, or timed events (6h+)
- "charytatywny" — charity, fundraiser, proceeds to a cause
Multiple types allowed (e.g. ["trail", "nocny"] for night trail).

PRICES — READ CAREFULLY, this is the most important field to extract:
- The Polish term for entry fee is "opłata startowa" — this is the DEFINITIVE price field
- Also look for: "wpisowe", "cena", "koszt", "pakiet startowy"
- REGULAMIN prices are AUTHORITATIVE — if the regulamin PDF has a price table, use those numbers over registration page prices
- Prices often have date tiers: "I termin" / "II termin" / "III termin" or "do [date]" columns
- There is often a "w dniu biegu" / "w dniu zawodów" (race day) price — this is the HIGHEST tier
- price_from: CHEAPEST adult entry fee across date tiers (first/early-bird price, in PLN, whole number)
- price_to: MOST EXPENSIVE adult entry fee — usually the race-day/"w dniu biegu" price or last tier (in PLN, whole number)
- ONLY copy exact numbers that appear in the text — NEVER infer, calculate, or estimate prices
- If only one price: set both to the same value
- If the MAIN ADULT race is "bezpłatny" / "darmowy" / "free": set both to 0
- IGNORE free kids/children entries ("biegi dla dzieci bezpłatne") — these are separate events, not a price tier of the main race. Only use prices for the main adult race distances
- null ONLY if absolutely no price information found anywhere in the content

REGISTRATION DEADLINE:
- Look for: "termin zgłoszeń", "zapisy do", "rejestracja do", "limit zgłoszeń"
- Format: YYYY-MM-DD. null if not found

LOCATION:
- The city/town/village where the event starts. e.g. "Warszawa", "Lisewo Malborskie", "Wieliszew"
- Look for "miejscowość", "miejsce startu", "Start:", "Trasa biegnie ulicami...", organizer's address
- One placename, no voivodeship suffix. Forest/region names ("Puszcza Bolimowska") only if no nearby city is mentioned
- null if uncertain

VOIVODESHIP: exactly one of: {", ".join(VOIVODESHIPS)}. null if uncertain.

URLs — extract ONLY if the regulamin text itself states them; otherwise null:
- registration_url: a sign-up link explicitly given in the regulamin (e.g. "zapisy na stronie ...")
- regulamin_url: leave null unless the document references its own canonical URL
- url_is_regulamin: true if the content you read above is genuinely race regulations
- url_is_registration: true only if registration_url points to an actual sign-up page

is_kids: true if any distance ≤ 1 km OR dedicated children's category exists"""


def call_ollama(prompt: str, config) -> Optional[dict]:
    """Call Ollama API and return parsed JSON response."""
    start = time.time()
    try:
        with httpx.Client(timeout=600) as client:
            resp = client.post(
                f"{config.ollama_url}/api/generate",
                json={
                    "model": config.ollama_model,
                    "prompt": prompt,
                    "stream": False,
                    "keep_alive": -1,
                    "options": {
                        "temperature": config.ollama_temperature,
                        "num_predict": config.ollama_max_tokens,
                        "num_ctx": 8192,
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

    except httpx.TimeoutException as e:
        import click
        click.echo(f"    llm error: {e}")
        raise
    except Exception as e:
        import click
        click.echo(f"    llm error: {e}")
        return None


_URL_FIELDS = ("registration_url", "regulamin_url")
_PLACEHOLDER_URL_SUBSTRINGS = ("example.pl", "example.com", "<replace-with-real")


def _scrub_placeholder_urls(data: dict) -> dict:
    """Drop any URL field whose value matches a placeholder we accidentally prompt-leaked.

    Guards against the model copying the JSON-example URLs verbatim (and against any
    future drift in the placeholder string). Converts the field to None instead of
    silently writing junk into Supabase.
    """
    for fld in _URL_FIELDS:
        v = data.get(fld)
        if isinstance(v, str) and any(s in v.lower() for s in _PLACEHOLDER_URL_SUBSTRINGS):
            data[fld] = None
    return data


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
        return _scrub_placeholder_urls(json.loads(match.group(0)))
    except json.JSONDecodeError:
        return None
