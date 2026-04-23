"""Fast-path HTTP fetch and lightweight HTML parsing for the audit command.

Extracts just enough of a page (title, meta description, h1 texts, body sample)
to feed a short LLM prompt. No JS rendering — that is the full-path fallback's
job (Crawl4AI).
"""
import time
import warnings
from dataclasses import dataclass, field
from typing import Optional

import httpx
from bs4 import BeautifulSoup

# Silence the urllib3 InsecureRequestWarning we'd otherwise get on every fetch
# because we pass verify=False intentionally (see fetch_fast for rationale).
try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass
warnings.filterwarnings("ignore", message="Unverified HTTPS request")


# macOS mDNSResponder occasionally drops DNS queries under sustained load, which
# surfaces as getaddrinfo "nodename nor servname provided, or not known".
# It looks identical to a real NXDOMAIN but is transient — a short retry recovers
# 99% of the time. These substrings identify DNS-style failures to retry on.
_DNS_ERROR_HINTS = (
    "nodename nor servname",
    "getaddrinfo",
    "temporary failure in name resolution",
    "name or service not known",
)

_MAX_DNS_RETRIES = 2
_DNS_RETRY_BACKOFF_S = 1.5


def _confirm_nxdomain(url: str) -> bool:
    """Return True if the URL's host is NXDOMAIN according to a public resolver.

    Protects against local-resolver false negatives (mDNSResponder flakes, corp
    DNS misconfig) that would otherwise cause us to mark live URLs as dead.
    Uses `dig +short @1.1.1.1` — no extra Python deps.
    """
    import subprocess
    from urllib.parse import urlparse
    try:
        host = urlparse(url).hostname
        if not host:
            return False
        res = subprocess.run(
            ["dig", "+short", f"@1.1.1.1", "+time=3", "+tries=1", host],
            capture_output=True, text=True, timeout=6,
        )
        # Empty stdout + no error means NXDOMAIN; anything else (an IP, a CNAME)
        # means the host exists.
        return res.returncode == 0 and res.stdout.strip() == ""
    except Exception:
        # If we can't confirm, don't claim NXDOMAIN — stay conservative.
        return False


# Same headers as validate_urls.py — many Polish CMSes gatekeep on UA.
_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pl,en-US;q=0.9,en;q=0.8",
}


@dataclass
class FastPage:
    url: str
    final_url: str = ""
    status: str = "ok"          # "ok" | "dead"
    http_status: int = 0
    title: str = ""
    meta_description: str = ""
    h1: list = field(default_factory=list)
    body_sample: str = ""
    error: Optional[str] = None
    # When the local resolver cannot find a host, we verify against a public DNS
    # (1.1.1.1) before calling it truly dead. The local resolver (macOS
    # mDNSResponder, corporate DNS, etc.) is known to have false negatives.
    nxdomain_confirmed: bool = False


def fetch_fast(url: str, timeout: int = 10, body_chars: int = 2000) -> Optional[FastPage]:
    """Fetch a URL via plain HTTP GET and extract a FastPage.

    Returns None only on catastrophic failures that we want to swallow in the
    caller (we don't currently have any — this is future-proofing).
    """
    attempt = 0
    while True:
        try:
            # verify=False mirrors what a human user does: many small Polish event
            # sites have misconfigured HTTPS (hostname-mismatch, self-signed, expired)
            # but serve the correct content. Refusing to fetch = false "skipped_dead"
            # verdicts. The audit is read-only (no credentials sent), so the security
            # downside of bypassing verification is negligible.
            with httpx.Client(
                follow_redirects=True,
                timeout=timeout,
                headers=_BROWSER_HEADERS,
                verify=False,
            ) as client:
                resp = client.get(url)
            break
        except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError) as e:
            err_msg = str(e)
            is_dns = any(hint in err_msg.lower() for hint in _DNS_ERROR_HINTS)
            if is_dns and attempt < _MAX_DNS_RETRIES:
                attempt += 1
                time.sleep(_DNS_RETRY_BACKOFF_S * attempt)
                continue
            # DNS failed locally after retries — verify against 1.1.1.1 before
            # calling it truly dead. `nxdomain_confirmed=True` lets audit.py
            # promote the verdict to mismatch (so --apply nulls the field).
            confirmed_dead = is_dns and _confirm_nxdomain(url)
            return FastPage(
                url=url, status="dead",
                error=err_msg[:200],
                nxdomain_confirmed=confirmed_dead,
            )

    if resp.status_code >= 400:
        return FastPage(
            url=url,
            final_url=str(resp.url),
            status="dead",
            http_status=resp.status_code,
            error=f"HTTP {resp.status_code}",
        )

    content_type = resp.headers.get("content-type", "").lower()
    if "html" not in content_type and "xml" not in content_type:
        return FastPage(
            url=url,
            final_url=str(resp.url),
            status="dead",
            http_status=resp.status_code,
            error="non-html content",
        )

    page = parse_html(resp.text, body_chars=body_chars)
    page.url = url
    page.final_url = str(resp.url)
    page.http_status = resp.status_code
    page.status = "ok"
    return page


def parse_html(html: str, body_chars: int = 2000) -> FastPage:
    """Parse HTML into a FastPage (no network I/O)."""
    soup = BeautifulSoup(html or "", "html.parser")

    # Strip noise
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    meta_desc = ""
    meta_tag = soup.find("meta", attrs={"name": "description"})
    if meta_tag and meta_tag.get("content"):
        meta_desc = meta_tag["content"].strip()

    h1_tags = soup.find_all("h1", limit=5)
    h1_texts = [t.get_text(" ", strip=True) for t in h1_tags if t.get_text(strip=True)]

    # Body sample: visible text of body, whitespace-collapsed, truncated
    body_root = soup.body or soup
    body_text = body_root.get_text(" ", strip=True)
    # Collapse runs of whitespace
    body_text = " ".join(body_text.split())
    body_sample = body_text[:body_chars]

    return FastPage(
        url="",
        title=title,
        meta_description=meta_desc,
        h1=h1_texts,
        body_sample=body_sample,
    )
