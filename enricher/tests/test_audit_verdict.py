from enricher.steps.audit_verdict import AuditVerdict, parse_verdict


def test_parse_verdict_clean_json():
    raw = '{"verdict":"match","confidence":0.9,"reasoning":"Title matches"}'
    v = parse_verdict(raw)
    assert v is not None
    assert v.verdict == "match"
    assert v.confidence == 0.9
    assert "Title" in v.reasoning


def test_parse_verdict_with_code_fences():
    raw = '```json\n{"verdict":"mismatch","confidence":0.82,"reasoning":"Different year"}\n```'
    v = parse_verdict(raw)
    assert v.verdict == "mismatch"
    assert abs(v.confidence - 0.82) < 1e-6


def test_parse_verdict_with_leading_prose():
    raw = 'Sure. Here is the JSON:\n{"verdict":"uncertain","confidence":0.3,"reasoning":"Thin content"}'
    v = parse_verdict(raw)
    assert v.verdict == "uncertain"


def test_parse_verdict_invalid_verdict_value_rejected():
    raw = '{"verdict":"great","confidence":1.0,"reasoning":"n/a"}'
    v = parse_verdict(raw)
    assert v is None


def test_parse_verdict_confidence_clamped():
    raw = '{"verdict":"match","confidence":1.5,"reasoning":"n/a"}'
    v = parse_verdict(raw)
    assert v is not None
    assert v.confidence == 1.0

    raw2 = '{"verdict":"match","confidence":-0.2,"reasoning":"n/a"}'
    v2 = parse_verdict(raw2)
    assert v2.confidence == 0.0


def test_parse_verdict_malformed_json_returns_none():
    assert parse_verdict("not json at all") is None
    assert parse_verdict("") is None
    assert parse_verdict(None) is None


def test_parse_verdict_missing_required_fields_returns_none():
    assert parse_verdict('{"verdict":"match"}') is None
    assert parse_verdict('{"confidence":0.5,"reasoning":"x"}') is None
