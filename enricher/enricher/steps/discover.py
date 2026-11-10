"""Find a race's registration form, regulamin and own page by reading search hits.

The search step used to take the first relevant web result and treat it as the
registration page. For a small local race that result is almost always a news
article: III Gminny Bieg Niepodległości (Cikowice, 2026-11-10) came back as five
local news stories, the first was taken as the registration URL, the verify
gate rightly rejected an article as a sign-up form, and nothing was left. Two of
those articles linked the Microsoft Forms sign-up and the organizer's site
(gck.bochnia.pl), whose own post held the form and the regulamin PDF.

So this step reads up to MAX_SEEDS search hits and the pages they lead to, and
takes links only from a page that is about THIS edition: it names the race, the
town and the event's year. From such a page it takes:

  - a registration link: an online form or registration platform, or a link
    labelled zapisy / rejestracja / zgłoszenia / formularz;
  - a regulamin link: a document that says it is the regulamin;
  - the website: the page itself when the regulamin it links is on its own
    host, which is what an organizer's page does and a news portal does not.

It follows, one level deep, the external site roots a page links (the article's
"gck.bochnia.pl") and same-site links whose address or label names the race (the
organizer's "czytaj więcej" to its post). A page that is not about the event is
never a source of links, only of further pages to look at.
"""
import html as _html
import re
import unicodedata
from html.parser import HTMLParser
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx

from enricher.steps.navigate import is_social_host, page_matches_event

MAX_SEEDS = 5
MAX_PAGES = 12
MAX_DEPTH = 2

# Online forms that a browser fills in and an automated client cannot read.
FORM_HOSTS = (
    "forms.cloud.microsoft", "forms.office.com", "forms.gle", "docs.google.com",
    "form.jotform.com", "jotform.com", "tally.so", "typeform.com",
)

# Registration platforms: a link to one of these from a page about the race is a
# sign-up link. Their roots list every event, so they are never a website.
PLATFORM_HOSTS = (
    "dostartu.pl", "plus-timing.pl", "b4sportonline.pl", "elektronicznezapisy.pl",
    "datasport.pl", "zapisyonline.pl", "e-gepard.eu", "foxter-sport.pl",
    "zapisy.info", "sts-timing.pl", "superczas.pl", "time-sport.pl", "timekeeper.pl",
    "chronotex.pl", "zmierzymyczas.pl", "inessport.pl", "ultimasport.pl",
    "pomiaryczasu.pl", "wbtiming.pl", "bgtimesport.pl", "protiming24.pl",
    "sport-time.com.pl", "time4run.com.pl", "ecityup.pl", "maratonczykpomiarczasu.pl",
    "raatiming.pl", "catchtime.pl", "czasomierzyk.pl", "kepasport.pl",
)

# Calendars and portals that list other people's races.
AGGREGATOR_HOSTS = (
    "maratonypolskie.pl", "kalendarzbiegowy.pl", "bieganie.pl", "enduhub.com",
    "traseo.pl", "biegiwpolsce.pl", "zawodybiegowe.pl", "maratonczyk.pl",
    "finishers.com", "ahotu.com", "biegowe.pl", "runnersworld.pl",
)

# Site-wide documents and pages every portal links from its footer or menu.
_SITE_WIDE = re.compile(
    r"serwis|portal|parking|reklam|sklep|cookie|prywatn|privacy|newsletter|"
    r"wynik|results|klasyfikac|polkoloni|zajeci|cgu|terms|legal",
    re.I,
)

_REG_WORDS = re.compile(r"zapis|rejestr|zgłosz|zglosz|formularz|registration|sign.?up", re.I)
_REG_PATH = re.compile(r"zapis|rejestr|zglosz|formularz|registration|signup|/e/|/forms/", re.I)
_REGULAMIN = re.compile(r"regulamin|statut", re.I)
# A consent form or data clause linked next to the regulamin. Its own filename
# saying "regulamin" still wins (a combined "regulamin oraz zgoda" document).
_NOT_REGULAMIN = re.compile(r"klauzul|zgod|oświadcz|oswiadcz|rodo|informacja-dotyczaca", re.I)
_DOC_EXT = re.compile(r"\.(pdf|docx?|odt)(\?|$)", re.I)


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower().removeprefix("www.")
    except Exception:
        return ""


def _host_in(url: str, hosts) -> bool:
    h = _host(url)
    return any(h == d or h.endswith("." + d) for d in hosts)


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", (text or "").lower().replace("ł", "l"))
    return "".join(c for c in text if not unicodedata.combining(c))


class _Anchors(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self.text: list[str] = []
        self._href: Optional[str] = None
        self._buf: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self._skip += 1
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._buf = []

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1
        if tag == "a" and self._href is not None:
            self.links.append((self._href, " ".join("".join(self._buf).split())))
            self._href = None

    def handle_data(self, data):
        if self._skip:
            return
        self.text.append(data)
        if self._href is not None:
            self._buf.append(data)


def parse_page(page_html: str, base_url: str) -> tuple[str, list[tuple[str, str]]]:
    """(visible text, [(absolute href, label)]) of one HTML page."""
    p = _Anchors()
    try:
        p.feed(page_html or "")
    except Exception:
        pass
    links = []
    for href, label in p.links:
        href = (href or "").strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        # A link pasted into text often keeps the sentence's punctuation
        # ("http://www.citytrail.pl/zapisy;").
        absolute = urljoin(base_url, _html.unescape(href)).split("#", 1)[0].rstrip(";,.)")
        links.append((absolute, label))
    return " ".join(" ".join(p.text).split()), links


def page_is_about_event(event: dict, text: str) -> bool:
    """The page names this race, its year and its town."""
    if not text or not page_matches_event(event, text):
        return False
    year = str(event.get("date") or "")[:4]
    if year and year not in text:
        return False
    town = _fold((event.get("location") or "").split(",")[0]).strip()
    if town:
        # Polish inflects the town ("Cikowice" -> "w Cikowicach"): match a stem.
        stem = town.split()[0][: max(4, len(town.split()[0]) - 2)]
        if stem not in _fold(text):
            return False
    return True


def _names_event_any(event: dict, href: str, label: str) -> bool:
    """The link's address or label carries at least one distinctive word of the
    race's name. Footer and menu links (a portal's regulamin, its "zapisy na
    półkolonie") never do."""
    from enricher.steps.navigate import _distinctive_tokens
    toks = _distinctive_tokens(_fold(event.get("name") or ""))
    hay = _fold(f"{label} {urlparse(href).path} {urlparse(href).query}")
    return any(t[:6] in hay for t in toks)


_ROMAN = re.compile(r"^[ivxlc]+$")


def _edition(event: dict) -> tuple[Optional[str], Optional[str]]:
    """(edition numeral, the name word after it) for "XIX Jelczańsko-…" or
    "18 Bieg Wegański"; (None, None) when the name carries no edition."""
    words = [w for w in re.split(r"[^a-z0-9]+", _fold(event.get("name") or "")) if w]
    if len(words) >= 2 and (_ROMAN.match(words[0]) or words[0].isdigit()):
        return words[0], words[1]
    return None, None


def is_other_edition(event: dict, href: str, label: str) -> bool:
    """The link names another edition of the race: "xviii-jelczansko" for XIX
    Jelczańsko-Oławski, "zapisy-na-i-biegowe" for VI Biegowe Grand Prix
    (2026-11-10). Read as the numeral right before the name's first word."""
    numeral, first = _edition(event)
    if not numeral:
        return False
    words = [w for w in re.split(r"[^a-z0-9]+", _fold(f"{label} {urlparse(href).path}")) if w]
    for i, w in enumerate(words[1:], start=1):
        prev = words[i - 1]
        if w.startswith(first[:6]) and (_ROMAN.match(prev) or prev.isdigit()) and prev != numeral:
            return True
    return False


def is_registration_link(href: str, label: str, event: dict) -> bool:
    if _DOC_EXT.search(href) or _SITE_WIDE.search(_fold(f"{href} {label}")):
        return False
    if is_other_edition(event, href, label):
        return False
    if _host_in(href, FORM_HOSTS):
        # A form's address is an opaque id. Its link must be shown as the
        # address itself (how articles paste it), name the race, or say zapisy.
        if _host(href) == "docs.google.com" and "/forms/" not in href:
            return False
        bare = (label or "").strip().rstrip("/") == href.rstrip("/")
        return bare or _names_event_any(event, href, label) or bool(_REG_WORDS.search(label or ""))
    if _host_in(href, PLATFORM_HOSTS):
        return bool(urlparse(href).path.strip("/")) and _names_event_any(event, href, label)
    return (
        bool(_REG_WORDS.search(label or "")) and bool(_REG_PATH.search(href))
        and _names_event_any(event, href, label)
    )


def is_regulamin_link(href: str, label: str, event: dict) -> bool:
    name = _fold(urlparse(href).path.rsplit("/", 1)[-1])
    if _SITE_WIDE.search(_fold(f"{href} {label}")) or is_other_edition(event, href, label):
        return False
    says_regulamin = bool(_REGULAMIN.search(name)) or (
        bool(_REGULAMIN.search(label or ""))
        and not (_NOT_REGULAMIN.search(name) or _NOT_REGULAMIN.search(label or ""))
    )
    if not says_regulamin:
        return False
    # A document file next to the race's text, or any link that names the race.
    return bool(_DOC_EXT.search(href)) or _names_event_any(event, href, label)


def _names_event(event: dict, href: str, label: str) -> bool:
    """A link whose label or address names the race (an organizer's "czytaj
    więcej" carries the name only in its slug)."""
    from enricher.steps.navigate import _distinctive_tokens
    toks = _distinctive_tokens(_fold(event.get("name") or ""))
    if not toks:
        return False
    hay = _fold(f"{label} {urlparse(href).path}")
    # Every distinctive word: a news site links a dozen stories that share one.
    return all(t[:6] in hay for t in toks)


def _fetch(url: str, timeout: int) -> Optional[tuple[str, str]]:
    try:
        with httpx.Client(
            follow_redirects=True, timeout=timeout,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Accept-Language": "pl,en-US;q=0.9",
            },
        ) as client:
            resp = client.get(url)
        if resp.status_code >= 400 or "html" not in resp.headers.get("content-type", "html"):
            return None
        return str(resp.url), resp.text
    except Exception:
        return None


def discover_from_pages(event: dict, seeds: list[str], fetch=None, timeout: int = 10) -> dict:
    """Walk the seed pages and return what pages about this event link to.

    Returns {"registration_url", "regulamin_url", "website", "source_pages",
    "visited"}; a field is None when nothing qualified. `fetch(url)` returns
    (final_url, html) or None and is injectable for tests.
    """
    fetch = fetch or (lambda u: _fetch(u, timeout))
    queue = [(u, 0) for u in seeds[:MAX_SEEDS]]
    seen: set[str] = set()
    visited: list[str] = []
    registration = regulamin = website = None
    source_pages: list[str] = []

    while queue and len(visited) < MAX_PAGES:
        url, depth = queue.pop(0)
        if url in seen or is_social_host(url):
            continue
        seen.add(url)
        got = fetch(url)
        if not got:
            continue
        final, page_html = got
        visited.append(final)
        text, links = parse_page(page_html, final)
        about = page_is_about_event(event, text)

        if about:
            page_reg = next((h for h, l in links if is_registration_link(h, l, event)), None)
            page_regs = [h for h, l in links if is_regulamin_link(h, l, event)]
            page_regulamin = next((h for h in page_regs if _DOC_EXT.search(h)), page_regs[0] if page_regs else None)
            organizer_page = bool(
                page_regulamin and _host(page_regulamin) == _host(final)
                and not _host_in(final, PLATFORM_HOSTS + AGGREGATOR_HOSTS)
            )
            # An organizer's own page outranks a news article's copy of its links.
            if page_reg and (registration is None or organizer_page):
                registration = page_reg
            if page_regulamin and (regulamin is None or organizer_page):
                regulamin = page_regulamin
            if organizer_page and website is None:
                website = final
            if page_reg or page_regulamin:
                source_pages.append(final)

        if depth + 1 > MAX_DEPTH:
            continue
        for href, label in links:
            if href in seen or not href.startswith("http"):
                continue
            if _host_in(href, FORM_HOSTS + PLATFORM_HOSTS + AGGREGATOR_HOSTS) or is_social_host(href):
                continue
            if _DOC_EXT.search(href):
                continue
            same_site = _host(href) == _host(final)
            parts = urlparse(href)
            is_root = not parts.path.strip("/") and not parts.query
            if about and not same_site and is_root:
                # An organizer's site named by an article about the race: look
                # at it before anything else still waiting.
                queue.insert(0, (href, depth + 1))
            elif same_site and _names_event(event, href, label):
                queue.append((href, depth + 1))

        if registration and regulamin and website:
            break

    return {
        "registration_url": registration,
        "regulamin_url": regulamin,
        "website": website,
        "source_pages": source_pages,
        "visited": visited,
    }
