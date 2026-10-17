"""Read a bib number straight from a runner's torso.

The colour locator finds the olive block and hands it to a digit
segmenter. At Wilczy Półmaraton 2026-10-17 that read 3 of 196 finishers: the
block at the read point was about 30 pixels tall, the locator returned a
piece of it cut off by its own digits, and anything under 50 pixels is never
read. A person can read those bibs at a glance in the same frames.

So this reader skips locating altogether. It takes the torso band of the
box the person detector drew, scales it to INPUT_SIZE and asks a small
network for the number directly: three digit positions, right-aligned, each
a digit or blank. A torso with no bib reads as three blanks.

The network was trained on torso crops from that race, labelled by reading
the bibs by eye and checked against the chip roster, plus synthetic bibs
pasted onto spectators so it meets every number from 1 to 999 rather than
only the ones worn that day. Some runners were held out of training to
measure it. See scripts/train_torso_reader.py.
"""
import os
from pathlib import Path

import numpy as np
from PIL import Image

# The weights are learned from photographs of runners, so they may be kept
# outside the repository. VISION_TORSO_MODEL points at them; unset, the
# reader looks in models/.
MODEL_PATH = Path(os.environ.get(
    "VISION_TORSO_MODEL",
    Path(__file__).resolve().parents[1] / "models" / "torso_reader.onnx",
))
INPUT_SIZE = 128
# The band of the person box the bib is worn in, as shares of its height.
# Measured on the 2026-10-17 frames: bibs sat from the chest down to a waist
# belt, which is about 0.25 to 0.70 of the box.
TORSO_TOP, TORSO_BOTTOM = 0.12, 0.72
BLANK = 10
# Every position must be at least this sure. A number is read whole or not
# at all, as in recognize.read_bib.
MIN_CONFIDENCE = 0.9
# What "no bib" is worth as a vote against a number. A spectator who stands
# at the line for minutes makes a track hundreds of frames long, and if "no
# bib" counted for nothing, two stray reads in it won the vote outright. In
# the 2026-10-17 replay that let the drinks stand and a child read as 94, 88,
# 73 and 1. Counted against, they are outvoted, and a runner's own pass still
# holds the share Tracker asks for.
NO_BIB_CONFIDENCE = 0.01

_session = None


def torso_box(person_box):
    x1, y1, x2, y2 = (int(v) for v in person_box)
    h = y2 - y1
    return (x1, int(y1 + TORSO_TOP * h), x2, int(y1 + TORSO_BOTTOM * h))


def torso_crop(image: Image.Image, person_box) -> Image.Image:
    """The model's input. Training builds its crops with this function too."""
    crop = image.convert("RGB").crop(torso_box(person_box))
    return crop.resize((INPUT_SIZE, INPUT_SIZE), Image.BILINEAR)


def _model():
    global _session
    if _session is None:
        import onnxruntime as ort
        if not MODEL_PATH.exists():
            raise FileNotFoundError(
                f"No torso reader at {MODEL_PATH}. Run: "
                "python scripts/train_torso_reader.py"
            )
        _session = ort.InferenceSession(
            str(MODEL_PATH), providers=["CPUExecutionProvider"]
        )
    return _session


def decode(probs: np.ndarray) -> tuple:
    """(number or None, confidence) from one (3, 11) probability array.

    Three blanks is "no bib", returned as (None, NO_BIB_CONFIDENCE), which the
    tracker counts against a number like any refused read. A number with any position under MIN_CONFIDENCE
    is a refused read, (None, weakest), which the tracker does count against.
    A blank between two digits, or a leading zero, is not a bib either.
    """
    labels = probs.argmax(axis=1)
    weakest = float(probs.max(axis=1).min())
    digits = [int(v) for v in labels if v != BLANK]
    if not digits:
        return None, NO_BIB_CONFIDENCE
    first = int(np.flatnonzero(labels != BLANK)[0])
    if any(v == BLANK for v in labels[first:]) or digits[0] == 0:
        return None, weakest
    if weakest < MIN_CONFIDENCE:
        return None, weakest
    return "".join(str(d) for d in digits), weakest


def available() -> bool:
    return MODEL_PATH.exists()


def read_torsos(image: Image.Image, person_boxes: list) -> list:
    """(number or None, confidence) for each person box, in one model call.

    With no model on this machine every person reads as (None, 0.0) and the
    pipeline falls back to the colour locator alone, as it ran before.
    """
    if not person_boxes:
        return []
    if not available():
        return [(None, 0.0)] * len(person_boxes)
    batch = np.stack([
        np.asarray(torso_crop(image, box), dtype=np.float32) / 255.0
        for box in person_boxes
    ]).transpose(0, 3, 1, 2)
    session = _model()
    logits = session.run(None, {session.get_inputs()[0].name: batch})[0]
    shifted = np.exp(logits - logits.max(axis=2, keepdims=True))
    probs = shifted / shifted.sum(axis=2, keepdims=True)
    return [decode(p) for p in probs]
