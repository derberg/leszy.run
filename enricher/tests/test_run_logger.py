import json
import os
import tempfile
from enricher.run_logger import RunLogger


def test_logger_creates_file():
    with tempfile.TemporaryDirectory() as d:
        logger = RunLogger(log_dir=d)
        logger.log("event-1", "Bieg Testowy", "validate", {"urls_checked": 2})
        assert os.path.exists(logger.log_path)


def test_logger_writes_jsonl():
    with tempfile.TemporaryDirectory() as d:
        logger = RunLogger(log_dir=d)
        logger.log("event-1", "Bieg Testowy", "validate", {"urls_checked": 2})
        logger.log("event-1", "Bieg Testowy", "merge", {"fields_updated": ["distances"]})

        with open(logger.log_path) as f:
            lines = f.readlines()
        assert len(lines) == 2

        first = json.loads(lines[0])
        assert first["id"] == "event-1"
        assert first["name"] == "Bieg Testowy"
        assert first["step"] == "validate"
        assert first["data"]["urls_checked"] == 2
        assert "ts" in first


def test_get_completed_ids():
    with tempfile.TemporaryDirectory() as d:
        logger = RunLogger(log_dir=d)
        logger.log("event-1", "Bieg A", "merge", {"fields_updated": []})
        logger.log("event-2", "Bieg B", "llm", {"duration_s": 30})
        # event-2 has no "merge" step → not completed

        completed = logger.get_completed_ids()
        assert completed == {"event-1"}


def test_resume_loads_most_recent_log():
    with tempfile.TemporaryDirectory() as d:
        # Create an older log file
        older = os.path.join(d, "run-2026-04-04T100000.jsonl")
        with open(older, "w") as f:
            f.write(json.dumps({"id": "old-1", "name": "Old", "step": "merge", "data": {}, "ts": ""}) + "\n")

        # Create a newer log file
        newer = os.path.join(d, "run-2026-04-04T120000.jsonl")
        with open(newer, "w") as f:
            f.write(json.dumps({"id": "new-1", "name": "New", "step": "merge", "data": {}, "ts": ""}) + "\n")

        completed = RunLogger.load_completed_from_latest(d)
        assert completed == {"new-1"}
