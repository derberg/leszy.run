import json
import httpx
import respx
import pytest
from enricher.steps.llm import call_ollama, build_prompt, parse_llm_response
from enricher.config import Config

config = Config()


def test_build_prompt_includes_event_metadata():
    event = {"name": "Bieg Leszka", "date": "2026-05-10", "location": "Warszawa",
             "distances": "5 km", "event_types": ["uliczny"], "registration_deadline": None,
             "price_from": None, "price_to": None, "voivodeship": None}
    crawled = {"registration_url": "# Zapisy\nRejestracja otwarta do 1 maja"}
    pdf_text = None
    prompt = build_prompt(event, crawled, pdf_text, config)
    assert "Bieg Leszka" in prompt
    assert "2026-05-10" in prompt
    assert "Warszawa" in prompt
    assert "REGISTRATION PAGE" in prompt
    assert "Zapisy" in prompt


def test_build_prompt_includes_pdf_text():
    event = {"name": "Test", "date": "2026-01-01", "location": "X",
             "distances": None, "event_types": None, "registration_deadline": None,
             "price_from": None, "price_to": None, "voivodeship": None}
    pdf_text = "Regulamin biegu: dystans 10 km, teren leśny"
    prompt = build_prompt(event, {}, pdf_text, config)
    assert "REGULAMIN" in prompt
    assert "dystans 10 km" in prompt


def test_build_prompt_omits_empty_sections():
    event = {"name": "Test", "date": "2026-01-01", "location": "X",
             "distances": None, "event_types": None, "registration_deadline": None,
             "price_from": None, "price_to": None, "voivodeship": None}
    prompt = build_prompt(event, {}, None, config)
    assert "REGULAMIN" not in prompt
    assert "WEBSITE CONTENT" not in prompt


def test_parse_llm_response_valid_json():
    raw = '{"distances": ["5 km", "10 km"], "event_types": ["uliczny"], "registration_deadline": null, "price_from": 50, "price_to": 100, "voivodeship": "Mazowieckie", "is_kids": false, "website": null, "registration_url": null, "regulamin_url": null, "url_is_regulamin": true, "url_is_registration": true}'
    result = parse_llm_response(raw)
    assert result["distances"] == ["5 km", "10 km"]
    assert result["price_from"] == 50


def test_parse_llm_response_json_in_markdown():
    raw = 'Here is the extracted data:\n```json\n{"distances": ["5 km"], "event_types": ["trail"]}\n```'
    result = parse_llm_response(raw)
    assert result["distances"] == ["5 km"]


def test_parse_llm_response_garbage():
    result = parse_llm_response("I don't know anything about this event")
    assert result is None


def test_call_ollama_sends_correct_request():
    llm_response = json.dumps({
        "response": '{"distances": ["10 km"], "event_types": ["uliczny"], "registration_deadline": null, "price_from": null, "price_to": null, "voivodeship": null, "is_kids": false, "website": null, "registration_url": null, "regulamin_url": null, "url_is_regulamin": true, "url_is_registration": true}',
        "done": True,
    })
    with respx.mock:
        route = respx.post("http://localhost:11434/api/generate").mock(
            return_value=httpx.Response(200, json=json.loads(llm_response))
        )
        result = call_ollama("test prompt", config)
    assert route.called
    request_body = json.loads(route.calls[0].request.content)
    assert request_body["model"] == "qwen2.5:72b-instruct-q4_0"
    assert request_body["stream"] is False
    assert request_body["options"]["temperature"] == 0.1
