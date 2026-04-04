import json
import os
from datetime import datetime, timezone


class RunLogger:
    def __init__(self, log_dir="logs"):
        os.makedirs(log_dir, exist_ok=True)
        self.log_dir = log_dir
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
        self.log_path = os.path.join(log_dir, f"run-{ts}.jsonl")

    def log(self, event_id, event_name, step, data):
        entry = {
            "id": event_id,
            "name": event_name,
            "step": step,
            "data": data,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        with open(self.log_path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def get_completed_ids(self):
        """Read this run's log and return IDs that have a 'merge' step."""
        if not os.path.exists(self.log_path):
            return set()
        return self._extract_completed(self.log_path)

    @staticmethod
    def load_completed_from_latest(log_dir):
        """Find the most recent log file and return completed IDs."""
        if not os.path.exists(log_dir):
            return set()
        logs = sorted(
            [f for f in os.listdir(log_dir) if f.startswith("run-") and f.endswith(".jsonl")]
        )
        if not logs:
            return set()
        latest = os.path.join(log_dir, logs[-1])
        return RunLogger._extract_completed(latest)

    @staticmethod
    def _extract_completed(path):
        completed = set()
        with open(path) as f:
            for line in f:
                entry = json.loads(line)
                if entry.get("step") == "merge":
                    completed.add(entry["id"])
        return completed
