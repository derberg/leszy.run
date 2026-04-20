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
