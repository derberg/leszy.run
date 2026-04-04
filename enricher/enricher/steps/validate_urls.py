from dataclasses import dataclass
from typing import Optional
import httpx


@dataclass
class UrlStatus:
    url: str
    status: str  # "alive", "dead"
    final_url: Optional[str] = None  # set if redirected
    is_pdf: bool = False
    error: Optional[str] = None


def validate_urls(urls_dict: dict, timeout: int = 10) -> dict[str, UrlStatus]:
    """Validate all URLs on an event. Returns {field_name: UrlStatus}.

    urls_dict keys: registration_url, regulamin_url, regulamin_urls, website
    regulamin_urls is a list — each entry gets its own result keyed as regulamin_urls[i].
    None values are skipped.
    """
    results = {}

    flat = {}
    for key, value in urls_dict.items():
        if value is None:
            continue
        if key == "regulamin_urls" and isinstance(value, list):
            for i, url in enumerate(value):
                if url:
                    flat[f"regulamin_urls[{i}]"] = url
        elif isinstance(value, str) and value.strip():
            flat[key] = value

    for field_name, url in flat.items():
        results[field_name] = _check_url(url, field_name, timeout)

    return results


def _check_url(url: str, field_name: str, timeout: int) -> UrlStatus:
    try:
        with httpx.Client(follow_redirects=True, timeout=timeout) as client:
            resp = client.head(url)

        final_url = str(resp.url) if str(resp.url) != url else None
        content_type = resp.headers.get("content-type", "")
        is_pdf = "pdf" in content_type.lower()

        if resp.status_code < 400:
            return UrlStatus(
                url=url,
                status="alive",
                final_url=final_url,
                is_pdf=is_pdf,
            )
        else:
            return UrlStatus(url=url, status="dead", error=f"HTTP {resp.status_code}")

    except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPError) as e:
        return UrlStatus(url=url, status="dead", error=str(e)[:100])
