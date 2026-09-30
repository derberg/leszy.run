"""Download the model files that are not committed.

Only the person detector. The digit recognizer, models/digits.onnx, IS
committed, so the phase 0 measurement is reproducible against the exact
weights that produced it.

Usage:
  python scripts/fetch_models.py
"""
import sys
import urllib.request
from pathlib import Path

DETECTOR_URL = (
    "https://storage.googleapis.com/mediapipe-models/object_detector/"
    "efficientdet_lite0/float32/1/efficientdet_lite0.tflite"
)
MODELS = Path(__file__).resolve().parents[1] / "models"


def main():
    MODELS.mkdir(parents=True, exist_ok=True)
    target = MODELS / "efficientdet_lite0.tflite"
    if target.exists():
        print(f"already present: {target}")
        return
    print(f"downloading {target.name} ...")
    try:
        urllib.request.urlretrieve(DETECTOR_URL, target)
    except Exception as err:
        target.unlink(missing_ok=True)
        sys.exit(f"download failed: {err}")
    print(f"wrote {target} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
