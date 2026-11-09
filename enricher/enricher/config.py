import os
from pathlib import Path
from dataclasses import dataclass, field
from dotenv import load_dotenv


@dataclass
class Config:
    supabase_url: str = ""
    supabase_key: str = ""
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen3.6:27b"
    searxng_url: str = "http://localhost:8888"
    # Brave Search API key. When set, search uses Brave and falls back to SearXNG.
    brave_api_key: str = ""
    url_timeout: int = 10
    max_page_chars: int = 6_000
    # Raised from 6k: the opłata startowa table frequently lives on page 3-4 of a
    # regulamin, after ~8k chars of generic preamble. Chunks step keyword-filters
    # this down before sending to the LLM, so raw size no longer hits the prompt.
    max_pdf_chars: int = 25_000
    ollama_temperature: float = 0.1
    ollama_max_tokens: int = 1024

    aggregator_domains: list = field(default_factory=lambda: [
        "maratonypolskie.pl",
        "liveds.datasport.pl",
        "datasport.pl",
        "biegiwpolsce.pl",
        "elektronicznezapisy.pl",
        "bieganie.pl",
        "kalendarzbiegowy.pl",
        "enduhub.com",
        "traseo.pl",
    ])

    valid_event_types: list = field(default_factory=lambda: [
        "trail", "nocny", "ocr", "nordic walking", "ultra", "charytatywny", "uliczny",
    ])

    voivodeships: list = field(default_factory=lambda: [
        "Dolnośląskie", "Kujawsko-Pomorskie", "Łódzkie", "Lubelskie", "Lubuskie",
        "Małopolskie", "Mazowieckie", "Opolskie", "Podkarpackie", "Podlaskie",
        "Pomorskie", "Śląskie", "Świętokrzyskie", "Warmińsko-Mazurskie",
        "Wielkopolskie", "Zachodniopomorskie",
    ])


# The repository's own .env, which holds the keys the backend and Docker use.
# A host run (`cd enricher && python -m enricher run`) used to read only
# enricher/.env, which had no BRAVE_SEARCH_API_KEY, so on 2026-11-09 every
# search silently went to SearXNG and found a URL for 3 of 87 events.
# A bare load_dotenv() walks up from this file and stops at the FIRST .env,
# which is enricher/.env, so the root one was never read.
ENRICHER_ENV = Path(__file__).resolve().parents[1] / ".env"
REPO_ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"


def load_config(enricher_env: Path = ENRICHER_ENV, root_env: Path = REPO_ROOT_ENV) -> Config:
    # enricher/.env first, then the repo root fills what it left unset.
    # Neither overrides a variable already in the environment (Docker).
    for env_file in (enricher_env, root_env):
        if env_file.is_file():
            load_dotenv(env_file)
    return Config(
        supabase_url=os.environ["SUPABASE_URL"],
        supabase_key=os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        ollama_url=os.getenv("OLLAMA_URL", "http://localhost:11434"),
        ollama_model=os.getenv("OLLAMA_MODEL", "qwen3.6:27b"),
        searxng_url=os.getenv("SEARXNG_URL", "http://localhost:8888"),
        brave_api_key=os.getenv("BRAVE_SEARCH_API_KEY", ""),
    )
