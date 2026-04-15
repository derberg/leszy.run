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

    # Build focused chunks (prices, deadlines, distances) from all content
    focused = build_focused_context(crawled, pdf_text)

    # Keep truncated raw content for general context (event types, URLs, etc.)
    # Focused chunks already have price/deadline/distance data, so raw can be shorter.
    raw_limit = 2000 if focused else config.max_page_chars
    sections = []
    for field, label in [("website", "WEBSITE CONTENT"), ("registration_url", "REGISTRATION PAGE")]:
        content = crawled.get(field)
        if content and isinstance(content, str) and content.strip():
            url = event.get(field, "")
            sections.append(f"--- {label} ({url}) ---\n{content[:raw_limit]}")

    # Include navigated follow-up pages (internal subpages, organizer sites)
    followup_count = 0
    for key, content in crawled.items():
        if key.startswith("followup:") and content and isinstance(content, str) and content.strip():
            followup_count += 1
            if followup_count > 4:
                break
            page_url = key.removeprefix("followup:")
            sections.append(f"--- FOLLOWUP PAGE ({page_url}) ---\n{content[:raw_limit]}")

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
        context_block = "(No web content or PDF available)"

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

RESPOND WITH THIS EXACT JSON STRUCTURE:
{{
  "distances": ["5 km", "10 km"],
  "event_types": ["uliczny"],
  "registration_deadline": "YYYY-MM-DD",
  "price_from": 50,
  "price_to": 90,
  "voivodeship": "Mazowieckie",
  "is_kids": false,
  "website": "https://example.pl",
  "website_is_official": true,
  "registration_url": "https://example.pl/zapisy",
  "regulamin_url": "https://example.pl/regulamin.pdf",
  "url_is_regulamin": true,
  "url_is_registration": true
}}

Use null for any field you cannot determine from the provided content.

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

VOIVODESHIP: exactly one of: {", ".join(VOIVODESHIPS)}. null if uncertain.

WEBSITE:
- Must be the event's OFFICIAL website (organizer's domain, dedicated event page)
- NOT a news article about the event (e.g. naszemiasto.pl, gazeta.pl, sport.pl, moje-gniezno.pl)
- NOT a social media page (facebook.com)
- NOT an aggregator (maratonypolskie.pl, datasport.pl, biegiwpolsce.pl, dostartu.pl)
- website_is_official: true if the URL is the event's own domain/page, false if it's news/article/social

URL VALIDATION:
- url_is_registration: does the registration_url contain an actual sign-up form? Login pages (dostartu.pl/permalink-*) count as YES — they lead to registration after login
- url_is_regulamin: does the regulamin_url contain actual race regulations?

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

    except Exception as e:
        import click
        click.echo(f"    llm error: {e}")
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
