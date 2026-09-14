"""Is a URL the front door of a registration platform rather than one event?

WHY THIS IS NOT CAUGHT BY THE RELEVANCE GATE
`verify_url_relevance` fetches a candidate and asks whether the page mentions
the event. A platform homepage answers yes. https://zapisy.info/ lists its
upcoming races by name, "VII Bieg Pocztyliona" among them, so the homepage was
adopted as that race's registration_url. Its real page,
https://zapisy.info/imprezy/718/, is where the registration window lives and
nothing ever reached it. The homepage passes the check for every event the
platform runs, which is exactly why it identifies none of them.

The hosts below are the platforms this project scrapes (see
backend/src/scrapers/sources/). Being a scraper source is what makes a host a
platform: it serves many races under paths, so its root is a directory. An
organizer's own domain is deliberately absent — https://naszadycha.pl with an
empty path is that race's site and a fine registration_url.

Matching is on the exact host (www. stripped), never a parent domain: some
platforms give a race its own subdomain, where the root IS the event
(5.biegnijmy.pl, h2opolmaraton.pro-run.pl).

backend/src/lib/registrationPlatforms.js holds the same list for the JS
enrichers. Keep the two in step.
"""
from urllib.parse import urlparse, parse_qs


REGISTRATION_PLATFORM_HOSTS = frozenset({
    "aleczas.pl",
    "b4sportonline.pl",
    "bgtimesport.pl",
    "biegiwpolsce.pl",
    "biegnijmy.pl",
    "competitions.timekeeper.pl",
    "czasomierzyk.pl",
    "datasport.pl",
    "dostartu.pl",
    "e-gepard.eu",
    "elektronicznezapisy.pl",
    "formularz.czasomierzyk.pl",
    "foxter-sport.pl",
    "herkules.org.pl",
    "kepasport.pl",
    "liveds.datasport.pl",
    "lumisport.eu",
    "maratonczykpomiarczasu.pl",
    "maratonypolskie.pl",
    "motivato.pl",
    "online.datasport.pl",
    "pifsport.com.pl",
    "plus-timing.pl",
    "pomiarczasuatelier.pl",
    "pomiaryczasu.pl",
    "protiming24.pl",
    "rajsportactive.pl",
    "sport-time.com.pl",
    "super-sport.com.pl",
    "superczas.pl",
    "time-sport.pl",
    "timekeeper.pl",
    "timing4u.pl",
    "wbtiming.pl",
    "wyniki.plus-timing.pl",
    "zapisy.inessport.pl",
    "zapisy.info",
    "zapisy.raatiming.pl",
    "zapisyonline.pl",
    "zapisyvaldano.pl",
    "zmierzymyczas.pl",
})

# Query keys that carry no event identity — a share link picks these up on the
# way from Facebook, and the URL underneath is still the bare homepage.
_TRACKING_PARAMS = frozenset({
    "fbclid", "gclid", "brid", "mc_cid", "mc_eid",
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
})


def is_platform_root_url(url: str) -> bool:
    """True when `url` is a registration platform's root, naming no event."""
    if not url:
        return False
    try:
        parsed = urlparse(str(url).strip())
    except Exception:
        return False

    if parsed.scheme not in ("http", "https"):
        return False

    host = (parsed.hostname or "").lower().removeprefix("www.")
    if host not in REGISTRATION_PLATFORM_HOSTS:
        return False

    # A fragment addresses one entry in the platform's list (inessport's
    # #gr291), so the URL still points at an event.
    if parsed.fragment:
        return False

    if parsed.path.rstrip("/") != "":
        return False

    for key in parse_qs(parsed.query, keep_blank_values=True):
        if key.lower() not in _TRACKING_PARAMS:
            return False

    return True
