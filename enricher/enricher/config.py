import os
from dataclasses import dataclass, field
from dotenv import load_dotenv


@dataclass
class Config:
    supabase_url: str = ""
    supabase_key: str = ""
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "gemma3:27b"
    searxng_url: str = "http://localhost:8888"
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


def load_config() -> Config:
    load_dotenv()
    return Config(
        supabase_url=os.environ["SUPABASE_URL"],
        supabase_key=os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        ollama_url=os.getenv("OLLAMA_URL", "http://localhost:11434"),
        ollama_model=os.getenv("OLLAMA_MODEL", "gemma3:27b"),
        searxng_url=os.getenv("SEARXNG_URL", "http://localhost:8888"),
    )
