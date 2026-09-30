"""Detect people with MediaPipe Object Detector (EfficientDet-Lite).

Apache 2.0, which is why it is here. The YOLOv8 and Ultralytics family is
AGPL-3.0, and leszy.run is a commercial service, so that licence does not
belong inside it. Person detection is a solved problem and does not need the
most accurate model available.

Download the model once:
  curl -sfL -o models/efficientdet_lite0.tflite \\
    https://storage.googleapis.com/mediapipe-models/object_detector/\\
efficientdet_lite0/float32/1/efficientdet_lite0.tflite
"""
from pathlib import Path

import numpy as np
from PIL import Image

MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "efficientdet_lite0.tflite"
SCORE_FLOOR = 0.2

_detector = None


def _get_detector():
    global _detector
    if _detector is None:
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python import vision as mp_vision

        if not MODEL_PATH.exists():
            raise FileNotFoundError(
                f"No detector model at {MODEL_PATH}. See the download command "
                "in this module's docstring."
            )
        _detector = mp_vision.ObjectDetector.create_from_options(
            mp_vision.ObjectDetectorOptions(
                base_options=BaseOptions(model_asset_path=str(MODEL_PATH)),
                running_mode=mp_vision.RunningMode.IMAGE,
                category_allowlist=["person"],
                score_threshold=SCORE_FLOOR,
            )
        )
    return _detector


def detect_people(image: Image.Image, min_confidence: float = 0.4) -> list:
    """Return person boxes as (x1, y1, x2, y2), largest first."""
    import mediapipe as mp

    rgb = np.ascontiguousarray(np.asarray(image.convert("RGB")))
    result = _get_detector().detect(
        mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    )

    height, width = rgb.shape[:2]
    boxes = []
    for detection in result.detections:
        if not detection.categories:
            continue
        if detection.categories[0].score < min_confidence:
            continue
        box = detection.bounding_box
        # The model can return a box that runs past the edge. Clamp it, or a
        # later crop silently comes back the wrong size.
        x1 = max(0, int(box.origin_x))
        y1 = max(0, int(box.origin_y))
        x2 = min(width, int(box.origin_x + box.width))
        y2 = min(height, int(box.origin_y + box.height))
        if x2 > x1 and y2 > y1:
            boxes.append((x1, y1, x2, y2))

    boxes.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
    return boxes
