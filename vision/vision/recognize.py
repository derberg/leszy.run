"""Read the number from a bib crop.

Two stages. Segmentation splits the crop into single digits, using the fact
that leszy.run digits are bright shapes on a flat dark block: a brightness
threshold plus connected components separates them with no model at all.
Classification then labels each digit with a small network trained on
synthetic renders of the real bib face.

read_bib returns a string rather than an int, so a leading zero survives.
"047" and "47" are different runners.
"""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "digits.onnx"
DIGIT_SIZE = (32, 48)          # width, height, as PIL wants it
MIN_HEIGHT_RATIO = 0.45        # against the tallest component in the crop
MIN_AREA_PX = 12
MIN_CONTRAST = 40              # grey levels between the block and the digits
MAX_BRIGHT_COVERAGE = 0.6      # above this, the bright class is the background


def _bright_mask(crop: Image.Image):
    """Bright-pixel mask, or None when there is nothing to threshold.

    Otsu is used because exposure at the gate is not controlled, so an
    absolute level cannot work. But Otsu always returns a split, even for a
    uniform image where no split exists: a blank block came back as one
    enormous bright component and was read as the number 1. So contrast is
    checked first, and a mask covering most of the crop is rejected as
    background rather than trusted as digits.
    """
    grey = np.asarray(crop.convert("L"))
    if int(grey.max()) - int(grey.min()) < MIN_CONTRAST:
        return None
    _, mask = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if (mask > 0).mean() > MAX_BRIGHT_COVERAGE:
        return None
    return mask


def segment_digits(crop: Image.Image) -> list:
    """Return single-digit crops, left to right.

    Components are filtered by height rather than by cropping a fixed margin.
    The corner registration marks are bright too, but they are short, while
    every digit is close to the full height of the tallest one. A fixed margin
    cannot separate them: the marks reach about 19 percent into the block and
    the digits start at about 10 percent, so any margin wide enough to drop a
    mark also clips the digits.
    """
    mask = _bright_mask(crop)
    if mask is None:
        return []
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return []

    boxes = [
        (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
         stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT],
         stats[i, cv2.CC_STAT_AREA])
        for i in range(1, count)
    ]
    boxes = [b for b in boxes if b[4] >= MIN_AREA_PX]
    if not boxes:
        return []

    tallest = max(b[3] for b in boxes)
    digits = [b for b in boxes if b[3] >= tallest * MIN_HEIGHT_RATIO]
    digits.sort(key=lambda b: b[0])

    return [
        crop.crop((x, y, x + w, y + h)).resize(DIGIT_SIZE, Image.BILINEAR)
        for x, y, w, h, _ in digits
    ]


_session = None


def _model():
    global _session
    if _session is None:
        import onnxruntime as ort
        if not MODEL_PATH.exists():
            raise FileNotFoundError(
                f"No recognizer at {MODEL_PATH}. Run: "
                "python scripts/train_recognizer.py"
            )
        _session = ort.InferenceSession(
            str(MODEL_PATH), providers=["CPUExecutionProvider"]
        )
    return _session


def read_bib(crop: Image.Image) -> tuple:
    """Return (number as a string or None, confidence between 0 and 1)."""
    digits = segment_digits(crop)
    if not digits:
        return None, 0.0

    batch = np.stack([
        np.asarray(d.convert("L"), dtype=np.float32)[None] / 255.0 for d in digits
    ])
    session = _model()
    logits = session.run(None, {session.get_inputs()[0].name: batch})[0]
    shifted = np.exp(logits - logits.max(axis=1, keepdims=True))
    probs = shifted / shifted.sum(axis=1, keepdims=True)

    labels = probs.argmax(axis=1)
    # The weakest digit sets the confidence: one uncertain digit makes the
    # whole number uncertain, because a bib is read as a whole or not at all.
    return "".join(str(int(v)) for v in labels), float(probs.max(axis=1).min())
