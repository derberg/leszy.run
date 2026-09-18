import re
import unicodedata
from urllib.parse import urlparse

import httpx


# TLDs acceptable for Polish running events. Anything else is rejected outright —
# no Chinese Q&A sites, no German Wikipedia, no random country TLDs.
_ACCEPTED_TLDS = {"pl", "com", "eu", "net", "org", "run", "sport", "info"}

# Hostnames known to be irrelevant junk that SearXNG keeps surfacing.
_HARD_BLOCKLIST = {
    "zhihu.com", "zhidao.baidu.com", "baidu.com", "autohome.com.cn",
    "wikipedia.org", "en.wikipedia.org", "de.wikipedia.org", "de.m.wikipedia.org",
    "pl.wikipedia.org", "support.google.com", "translate.google.com",
    "www.google.com", "google.com", "github.com", "www.agropolska.pl",
    "run-log.com", "www.run-log.com", "runningpoland.com",
}


# Mirrors IS_REGULAMIN in backend/src/lib/pickRegulaminUrl.js: a link is the
# regulamin only if it says so. SearXNG ranks an organizer's "start zapisow" post
# above the per-distance regulamin pages that same post links to, and extraction
# reads the regulamin only — so a relevant but wrong hit does not just miss the
# rules document, it also fills the slot that would have been searched again.
_IS_REGULAMIN = re.compile(r"regulamin|regulation|statut|\brules?\b", re.IGNORECASE)


def search_missing_urls(event: dict, missing_fields: list[str], config) -> dict:
    """Search SearXNG for missing URLs. Returns {field_name: url} for found candidates.

    Candidates must pass a relevance check (domain allowed AND event name tokens
    appear in the result title or snippet). Irrelevant results are dropped —
    better to return nothing than a junk URL.
    """
    if not missing_fields:
        return {}

    name = event.get("name", "")
    date = event.get("date", "")
    year = date[:4] if date else ""
    location = event.get("location", "")

    # We search for the two source-of-truth URLs only — registration and
    # regulamin. Organizer websites are intentionally NOT searched (low-yield).
    queries = {}
    if "registration_url" in missing_fields:
        queries["registration_url"] = f"{name} {year} zapisy rejestracja {location}"
    if "regulamin_url" in missing_fields:
        queries["regulamin_url"] = f"{name} {year} regulamin"

    name_tokens = _tokenize(name)

    results = {}
    for field, query in queries.items():
        # A regulamin hit must announce itself; relevance alone is not enough.
        declares = _IS_REGULAMIN if field == "regulamin_url" else None
        url = _searxng_search(query, name_tokens, config, declares)
        if url:
            results[field] = url

    return results


def _searxng_search(query: str, name_tokens: set[str], config, declares=None) -> str | None:
    """Call SearXNG and return the first relevant, non-aggregator URL.

    `declares` is an optional pattern the result URL or title must match, for
    fields where the wrong document costs more than an empty one.
    """
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(
                f"{config.searxng_url}/search",
                params={
                    "q": query,
                    "format": "json",
                    "language": "pl",
                    "categories": "general",
                },
            )
            resp.raise_for_status()

        data = resp.json()
        for item in data.get("results", []):
            url = item.get("url", "")
            title = item.get("title", "") or ""
            content = item.get("content", "") or ""

            if not url:
                continue
            if _is_blocklisted(url):
                continue
            if _is_aggregator(url, config.aggregator_domains):
                continue
            if not _tld_accepted(url):
                continue
            if not _is_relevant(name_tokens, title, content, url):
                continue
            if declares is not None and not (declares.search(url) or declares.search(title)):
                continue
            return url
    except (httpx.HTTPError, Exception):
        pass
    return None


def _is_aggregator(url: str, domains: list[str]) -> bool:
    try:
        hostname = urlparse(url).hostname or ""
        hostname = hostname.removeprefix("www.")
        return any(hostname == d or hostname.endswith(f".{d}") for d in domains)
    except Exception:
        return False


def _is_blocklisted(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
        if not host:
            return True
        host = host.removeprefix("www.")
        if host in _HARD_BLOCKLIST:
            return True
        # Catch any remaining .cn / .ru / .jp / .kr / .cn-like domains
        tld = host.rsplit(".", 1)[-1] if "." in host else ""
        if tld in {"cn", "ru", "jp", "kr", "tw", "hk", "kz", "tr"}:
            return True
        return False
    except Exception:
        return True


def _tld_accepted(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
        if not host:
            return False
        tld = host.rsplit(".", 1)[-1] if "." in host else ""
        return tld in _ACCEPTED_TLDS
    except Exception:
        return False


_NAME_STOPWORDS = {
    # Common Polish/running words that appear in nearly every event name
    "bieg", "biegu", "biegi", "maraton", "polmaraton", "półmaraton",
    "run", "running", "edycja", "im", "ii", "iii", "iv", "v", "vi",
    "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi",
    "xvii", "xviii", "xix", "xx", "xxi", "xxii", "xxiii", "xxiv", "xxv",
    "the", "and", "of", "dla", "po", "na", "na",
}


def _strip_accents(text: str) -> str:
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _tokenize(text: str) -> set[str]:
    """Lowercase, strip accents, split on non-alphanumerics, drop stopwords/short tokens."""
    if not text:
        return set()
    flat = _strip_accents(text).lower()
    parts = re.split(r"[^a-z0-9]+", flat)
    return {p for p in parts if len(p) >= 4 and p not in _NAME_STOPWORDS}


def _is_relevant(name_tokens: set[str], title: str, content: str, url: str) -> bool:
    """Require at least one meaningful event-name token to appear in title/snippet/url.

    Without this check, SearXNG routinely returns totally unrelated pages
    (Chinese Q&A, German Wikipedia) as "results" for Polish event queries.
    """
    if not name_tokens:
        # No meaningful tokens to match — refuse to trust the result at all.
        return False

    haystack = _strip_accents(f"{title} {content} {url}").lower()
    return any(tok in haystack for tok in name_tokens)
