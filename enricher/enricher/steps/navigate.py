"""Pick follow-up URLs from a crawled page's links.

Addresses two recurring failure modes:

1. Aggregator stubs (dostartu.pl/permalink-*, elektronicznezapisy.pl/event/*/signup.html,
   biegiwpolsce.pl, etc.) — the landing URL itself is a thin login/signup shell. The
   useful content lives on the stub's internal subpages ("Opis imprezy", "Regulamin",
   "Dystanse") or on the external organizer site the stub links to.

2. Organizer landing pages — `bacabiegi.pl/` often redirects all real details to
   `/regulamin`, `/oplaty`, `/zapisy`. Crawling only the root wastes the LLM call.

This step inspects the already-crawled page's links and returns up to N follow-up URLs
worth crawling. PDF links are also picked up (they'll be handled by the PDF step).
"""
import re
from urllib.parse import urljoin, urlparse


# Anchor-text keywords that suggest a subpage contains race-specific information.
# Matched case-insensitively, with accent folding. Ordered from most to least specific.
KEYWORD_SCORES = {
    # Highest value — directly what we want to extract
    "regulamin": 10,
    "opłaty": 9, "oplaty": 9, "opłata": 9, "oplata": 9, "cennik": 9,
    "wpisowe": 8, "pakiet startowy": 8,
    "opis imprezy": 8, "opis zawodów": 8, "opis zawodow": 8,
    # Registration / dates
    "zapisy": 7, "zapisz": 7, "zgłoszenia": 7, "zgloszenia": 7,
    "rejestracja": 7, "termin": 6,
    # Event structure
    "dystans": 6, "dystanse": 6, "trasa": 6, "trasy": 6,
    "kategorie": 5, "program": 5, "harmonogram": 5,
    # General info pages
    "informacje": 4, "info": 4, "o biegu": 5, "o imprezie": 5,
    "opis": 5,
}

# Anchor text that actively indicates junk (skip even if other keywords match)
NEGATIVE_KEYWORDS = {
    "login", "zaloguj", "polityka prywatności", "cookies", "kontakt",
    "wyniki", "galeria", "archiwum", "historia", "facebook", "instagram",
    "youtube", "regulamin serwisu", "regulamin portalu", "regulamin strony",
}

# Hosts where the landing URL itself is a thin shell — always look for subpages/externals.
STUB_HOSTS = {
    "dostartu.pl", "elektronicznezapisy.pl", "biegiwpolsce.pl",
    "datasport.pl", "liveds.datasport.pl", "online.datasport.pl",
    "maratonypolskie.pl", "timekeeper.pl", "competitions.timekeeper.pl",
    "protiming24.pl", "www.protiming24.pl",
    "panel.maratonczykpomiarczasu.pl", "formularz.ultimasport.pl",
    "zmierzymyczas.pl", "www.zmierzymyczas.pl",
}

# Hosts that are junk destinations for external links (should never follow)
JUNK_EXTERNAL_HOSTS = {
    "facebook.com", "www.facebook.com", "m.facebook.com",
    "instagram.com", "www.instagram.com",
    "twitter.com", "x.com", "youtube.com", "www.youtube.com",
    "tiktok.com", "google.com", "www.google.com",
    "maps.google.com", "goo.gl",
    # aggregators / news we've seen return junk
    "zhihu.com", "baidu.com", "wikipedia.org",
}

# Hosts whose pages cannot be meaningfully analyzed by the LLM audit
# (JS-rendered app shells, auth-walled content). Left alone by the audit.
SOCIAL_HOSTS = {
    "facebook.com", "www.facebook.com", "m.facebook.com", "fb.com", "www.fb.com",
    "instagram.com", "www.instagram.com",
    "twitter.com", "x.com",
    "tiktok.com", "www.tiktok.com",
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
}


def is_stub_host(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
        return host in STUB_HOSTS or any(
            host.endswith(f".{d}") for d in STUB_HOSTS
        )
    except Exception:
        return False


def is_social_host(url: str) -> bool:
    """Return True if the URL's host is a social/media platform that the audit should skip."""
    if not url:
        return False
    try:
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
        if not host:
            return False
        return host in SOCIAL_HOSTS or any(
            host.endswith(f".{d}") for d in SOCIAL_HOSTS
        )
    except Exception:
        return False


def _score_anchor(text: str) -> int:
    """Return keyword-match score for an anchor text. 0 if nothing matches."""
    if not text:
        return 0
    flat = text.lower().strip()

    # Negative filter first
    for neg in NEGATIVE_KEYWORDS:
        if neg in flat:
            return 0

    score = 0
    for kw, val in KEYWORD_SCORES.items():
        if kw in flat:
            score = max(score, val)
    return score


def _is_junk_external(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower().removeprefix("www.")
        if not host:
            return True
        if host in JUNK_EXTERNAL_HOSTS:
            return True
        # Chinese/Russian/etc. TLDs
        tld = host.rsplit(".", 1)[-1] if "." in host else ""
        if tld in {"cn", "ru", "jp", "kr", "tw", "hk", "kz"}:
            return True
        return False
    except Exception:
        return True


# Path prefixes under which the next segment is an event identifier (slug or id).
# Used to detect internal links that point at a DIFFERENT event than the one being
# enriched — common on timing platforms that list sibling events in page chrome
# (e.g. pomiaryczasu.pl's "Najbliższe zawody" widget links every upcoming race).
EVENT_PREFIXES = {
    "registration", "event", "events", "wydarzenie", "wydarzenia",
    "zawody", "rejestracja", "zapisy", "bieg",
}


def _event_slug(url: str):
    """Return the event-identifying path segment (the one right after a known
    event prefix), lowercased, or None if the URL has no recognizable one."""
    try:
        parts = [p for p in urlparse(url).path.strip("/").split("/") if p]
    except Exception:
        return None
    for i, p in enumerate(parts):
        if p.lower() in EVENT_PREFIXES and i + 1 < len(parts):
            return parts[i + 1].lower()
    return None


def _is_foreign_event(base_url: str, candidate_url: str) -> bool:
    """True when candidate is the same host as base but identifies a DIFFERENT
    event (different slug under an event prefix). Prevents following sibling-event
    links — the cause of cross-event contamination (IX Bieg Wolności pulling
    Pętla Beskidzka's 54/108 km). Fires only when BOTH URLs expose an event slug,
    so stubs/landing pages with no slug are unaffected."""
    try:
        if (urlparse(base_url).hostname or "").lower() != (urlparse(candidate_url).hostname or "").lower():
            return False
    except Exception:
        return False
    bslug = _event_slug(base_url)
    cslug = _event_slug(candidate_url)
    return bool(bslug and cslug and bslug != cslug)


# Generic race-name words that don't identify WHICH event. Stripped before
# matching a page against an event, so the test keys off distinctive tokens
# (place / proper names) rather than "bieg"/"maraton" that every page shares.
GENERIC_NAME_WORDS = {
    "bieg", "biegu", "biegi", "biegow", "biegowy", "biegowa", "biegowe",
    "marsz", "maraton", "polmaraton", "półmaraton", "pulmaraton",
    "cwiercmaraton", "ćwierćmaraton", "cross", "crossowy", "crossowa",
    "nordic", "walking", "ultra", "run", "running", "bieganie",
    "charytatywny", "charytatywna", "memorial", "memoriał", "edycja",
    "puchar", "grand", "prix", "oraz", "kobiet", "mezczyzn", "mężczyzn",
    "dzieci", "miasta", "gmina", "gminy", "nocny", "nocna", "uliczny",
    "gorski", "górski", "lesny", "leśny", "zawody",
}

_MD_LINK_RE = re.compile(r"\]\((https?://[^)\s]+)\)")
_TOKEN_RE = re.compile(r"[a-z0-9ąćęłńóśźż]+", re.IGNORECASE)


def _distinctive_tokens(name: str) -> list[str]:
    """Tokens from an event name that actually identify it — drop short tokens,
    generic race words, and edition numerals (roman or arabic)."""
    out = []
    for t in _TOKEN_RE.findall((name or "").lower()):
        if len(t) < 4:
            continue
        if t in GENERIC_NAME_WORDS:
            continue
        if t.isdigit():
            continue
        if re.fullmatch(r"[ivxlc]+", t):  # roman edition (vii, xxviii, …)
            continue
        out.append(t)
    return out


def page_matches_event(event: dict, text: str) -> bool:
    """True if a crawled page plausibly describes THIS event — used to gate
    search-discovered pages so a wrong-event SearXNG hit (e.g. Ochabski →
    rundazubra.pl) is not extracted from. Keys off distinctive name tokens: at
    least half (and ≥1) must appear in the page text. If the event name has no
    distinctive tokens we can't judge, so we don't block (return True)."""
    if not text:
        return False
    toks = _distinctive_tokens(event.get("name", ""))
    if not toks:
        return True
    tl = text.lower()
    hits = sum(1 for t in toks if t in tl)
    return hits >= 1 and hits >= (len(toks) + 1) // 2


def strip_foreign_event_lines(text: str, self_urls: list) -> str:
    """Remove text lines that link to a DIFFERENT event on the same host — the
    "upcoming events" / sibling-race chrome that timing platforms embed on every
    page (pomiaryczasu's "Najbliższe zawody"). Without this, the LLM reads other
    races' distances (IX Bieg Wolności → Pętla Beskidzka's 54/108 km) straight
    from the page body, where link-following filters can't reach it.

    A line is dropped when it contains a markdown link to a same-host page whose
    event slug differs from every self slug. Lines about the event itself, and
    pages on hosts where we have no self slug (external organizer sites), are
    untouched."""
    if not text:
        return text
    # host (no www.) → set of this event's own slugs
    self_slugs: dict[str, set] = {}
    for u in self_urls or []:
        if not u:
            continue
        try:
            host = (urlparse(u).hostname or "").lower().removeprefix("www.")
        except Exception:
            continue
        slug = _event_slug(u)
        if host and slug:
            self_slugs.setdefault(host, set()).add(slug)
    if not self_slugs:
        return text

    kept = []
    for line in text.split("\n"):
        drop = False
        for link in _MD_LINK_RE.findall(line):
            try:
                host = (urlparse(link).hostname or "").lower().removeprefix("www.")
            except Exception:
                continue
            slug = _event_slug(link)
            if not slug:
                continue
            owned = self_slugs.get(host)
            if owned is not None and slug not in owned:
                drop = True
                break
        if not drop:
            kept.append(line)
    return "\n".join(kept)


def pick_followup_urls(
    base_url: str,
    internal_links: list,
    external_links: list,
    max_internal: int = 4,
    max_external: int = 1,
    include_pdfs: bool = True,
) -> list[str]:
    """Return a short, deduplicated list of URLs worth crawling next.

    - Internal links are ranked by anchor-keyword match; top-N taken.
    - PDF links in internal links are always included (cheap to download later).
    - External links are filtered against junk hosts; top-ranked is included
      (often the organizer's own site when the current URL is a stub).
    """
    chosen: list[str] = []
    seen: set[str] = set()

    def add(url: str):
        if not url or url in seen:
            return
        seen.add(url)
        chosen.append(url)

    # --- Internal links: score by anchor text ---
    scored_internal = []
    pdf_internal = []
    for link in internal_links or []:
        href = link.get("href", "")
        text = link.get("text", "")
        if not href:
            continue
        # Normalize to absolute
        try:
            absolute = urljoin(base_url, href)
        except Exception:
            continue
        if absolute == base_url:
            continue
        # Skip links that point at a different event on the same host (sibling
        # races listed in page chrome) — including their regulamin PDFs.
        if _is_foreign_event(base_url, absolute):
            continue

        lower = absolute.lower()
        if include_pdfs and lower.endswith(".pdf"):
            # Prefer PDFs whose filename or anchor text mentions regulamin/opłata
            pdf_score = 3  # baseline for any internal PDF
            anchor_score = _score_anchor(text)
            # Filename heuristic
            name_flat = lower.rsplit("/", 1)[-1]
            if "regulamin" in name_flat or "regulation" in name_flat:
                pdf_score = 10
            elif "oplat" in name_flat or "opłat" in name_flat:
                pdf_score = 9
            pdf_internal.append((max(pdf_score, anchor_score), absolute))
            continue

        score = _score_anchor(text)
        if score > 0:
            scored_internal.append((score, absolute))

    # Top PDFs first (usually the regulamin)
    for _, url in sorted(pdf_internal, key=lambda x: -x[0])[: max(1, max_internal // 2)]:
        add(url)

    # Top non-PDF internal links
    for _, url in sorted(scored_internal, key=lambda x: -x[0])[:max_internal]:
        add(url)

    # --- External links: the organizer's main site from a stub page ---
    if max_external > 0 and external_links:
        scored_external = []
        for link in external_links:
            href = link.get("href", "")
            text = link.get("text", "")
            if not href or _is_junk_external(href):
                continue
            # Score: anchor keyword match + bonus for .pl TLD
            score = _score_anchor(text)
            try:
                host = (urlparse(href).hostname or "").lower()
                if host.endswith(".pl"):
                    score += 2
            except Exception:
                pass
            if score > 0:
                scored_external.append((score, href))

        for _, url in sorted(scored_external, key=lambda x: -x[0])[:max_external]:
            add(url)

    return chosen
