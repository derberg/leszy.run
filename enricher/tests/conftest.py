import pytest


@pytest.fixture
def sample_event():
    """A typical scraper_all row with some fields filled, some empty."""
    return {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "name": "Bieg Leszka",
        "date": "2026-05-10",
        "location": "Warszawa",
        "distances": None,
        "event_types": None,
        "registration_url": "https://example.pl/zapisy",
        "regulamin_url": "https://example.pl/regulamin.pdf",
        "regulamin_urls": None,
        "website": None,
        "registration_deadline": None,
        "price_from": None,
        "price_to": None,
        "voivodeship": None,
        "is_kids": None,
        "enriched_at": None,
        "enriched_regulamin_at": None,
        "enriched_search_at": None,
    }


@pytest.fixture
def sample_event_full():
    """A scraper_all row with all fields already populated."""
    return {
        "id": "660e8400-e29b-41d4-a716-446655440001",
        "name": "Maraton Krakowski",
        "date": "2026-06-15",
        "location": "Kraków",
        "distances": "10 km, 21.1 km, 42.2 km",
        "event_types": ["uliczny"],
        "registration_url": "https://maraton.krakow.pl/zapisy",
        "regulamin_url": "https://maraton.krakow.pl/regulamin.pdf",
        "regulamin_urls": None,
        "website": "https://maraton.krakow.pl",
        "registration_deadline": "2026-06-01",
        "price_from": 80,
        "price_to": 150,
        "voivodeship": "Małopolskie",
        "is_kids": False,
        "enriched_at": None,
        "enriched_regulamin_at": None,
        "enriched_search_at": None,
    }


@pytest.fixture
def sample_llm_response():
    """Typical JSON response from the Ollama LLM."""
    return {
        "distances": ["5 km", "10 km"],
        "event_types": ["uliczny", "charytatywny"],
        "registration_deadline": "2026-05-01",
        "price_from": 40,
        "price_to": 80,
        "voivodeship": "Mazowieckie",
        "is_kids": False,
        "website": "https://biegleszka.pl",
        "registration_url": "https://biegleszka.pl/zapisy",
        "regulamin_url": "https://biegleszka.pl/regulamin.pdf",
        "url_is_regulamin": True,
        "url_is_registration": True,
    }
