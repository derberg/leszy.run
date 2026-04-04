import os
from dataclasses import dataclass, field
from dotenv import load_dotenv


@dataclass
class Config:
    supabase_url: str = ""
    supabase_key: str = ""
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5:72b-instruct-q4_0"
    searxng_url: str = "http://localhost:8888"
    url_timeout: int = 10
    max_page_chars: int = 10_000
    max_pdf_chars: int = 15_000
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
        ollama_model=os.getenv("OLLAMA_MODEL", "qwen2.5:72b-instruct-q4_0"),
        searxng_url=os.getenv("SEARXNG_URL", "http://localhost:8888"),
    )
