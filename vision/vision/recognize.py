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

from vision.bib_spec import BIB

MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "digits.onnx"
DIGIT_SIZE = (32, 48)          # width, height, as PIL wants it
MIN_HEIGHT_RATIO = 0.45        # against the tallest component in the crop
MIN_AREA_PX = 12
# Measured across every digit rendered in the real bib face: width over
# height runs 0.37 (the 1) to 0.70 (the 4). The bounds below leave room for
# the perspective skew of an off-angle approach, and reject the two shapes
# that are not digits at all: a thin bright strap or belt (about 0.15) and
# several digits merged into one blob by heavy blur (about 1.6).
MIN_DIGIT_ASPECT = 0.22
MAX_DIGIT_ASPECT = 1.00
# Grey levels between the median block pixel and the median digit pixel.
# Medians, not max minus min: one black border pixel or one glint passes a
# range test on a blank block, and a dim but clean bib indoors has a block
# near 12 and digits near 39.
MIN_CONTRAST = 15
MAX_BRIGHT_COVERAGE = 0.6      # above this, the bright class is the background
MIN_DIGIT_CONFIDENCE = 0.7
# Share of its bounding box a digit's strokes fill. Measured on Pi crops:
# digits 0.47 to 0.73, the paper ring round a block 0.13 to 0.20.
MIN_DIGIT_SOLIDITY = 0.3
# Two digits that touch are cut at the narrowest column, if it is this thin
# against their height. The flag of a 1 reaching a 7 left a bridge 9 pixels
# tall on a 94-pixel 71. Measured on renders, the thinnest inner column of a
# single digit is 0.37 of its height or more, except the 1 (0.20), which is
# too narrow to be tried: only shapes wider than SPLIT_ASPECT are, and the
# widest digit, the 4, is 0.69.
MAX_BRIDGE = 0.25
SPLIT_ASPECT = 0.75


def _levels(crop: Image.Image):
    """(bright mask, median block level, median digit level), or None.

    Otsu is used because exposure at the gate is not controlled, so an
    absolute level cannot work. But Otsu always returns a split, even for a
    uniform image where no split exists: a blank block came back as one
    enormous bright component and was read as the number 1. So contrast is
    checked first, and a mask covering most of the crop is rejected as
    background rather than trusted as digits.
    """
    grey = np.asarray(crop.convert("L"))
    _, mask = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = mask > 0
    if not bright.any() or bright.all() or bright.mean() > MAX_BRIGHT_COVERAGE:
        return None
    block, digit = float(np.median(grey[~bright])), float(np.median(grey[bright]))
    if digit - block < MIN_CONTRAST:
        return None
    return mask, block, digit


def _bright_mask(crop: Image.Image):
    levels = _levels(crop)
    return None if levels is None else levels[0]


def _lum(rgb) -> float:
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def normalise(crop: Image.Image):
    """The crop with its block and digits moved to the levels of the bib face.

    The classifier trains on renders where the digits sit near 245 and the
    block near 107. Indoors a real crop of 65 peaked at 54 of 255 and was read
    as 44 with confidence 0.66: a confidently wrong number, from a crop a
    person reads at a glance. Stretched to the trained levels it reads 65.
    Returns None when there is no digit-against-block contrast to stretch.
    """
    levels = _levels(crop)
    if levels is None:
        return None
    _, block, digit = levels
    grey = np.asarray(crop.convert("L"), dtype=np.float32)
    lo, hi = _lum(BIB.block_rgb), _lum(BIB.digit_rgb)
    stretched = (grey - block) / (digit - block) * (hi - lo) + lo
    return Image.fromarray(np.clip(stretched, 0, 255).astype(np.uint8))


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
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return []

    boxes = [
        (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
         stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT],
         stats[i, cv2.CC_STAT_AREA], i)
        for i in range(1, count)
    ]
    boxes = [b for b in boxes if b[4] >= MIN_AREA_PX]
    if not boxes:
        return []

    tallest = max(b[3] for b in boxes)
    digits = [b for b in boxes if b[3] >= tallest * MIN_HEIGHT_RATIO]
    # Something touching the left or right edge of the crop is usually the
    # bib's white paper: a ring round the block (wide, mostly hollow) or a
    # sliver of the sheet's edge (thin). Those are dropped. But a shape with
    # a digit's proportions and solidity there means the number is not all
    # in the crop: a 2 cut off by the edge left bib 20 reading 0, and a
    # skewed crop read 19. A shortened number is somebody else's, so then
    # the whole read is refused. Top and bottom are not checked: the digits
    # fill most of the block's height and touch a tightly fitted crop there
    # on good reads.
    width = mask.shape[1]
    inside = []
    for b in digits:
        if b[0] > 0 and b[0] + b[2] < width:
            inside.append(b)
        elif (MIN_DIGIT_ASPECT <= b[2] / b[3] <= MAX_DIGIT_ASPECT
              and b[4] / (b[2] * b[3]) >= MIN_DIGIT_SOLIDITY):
            return []
    digits = inside
    # Shape gate. Without it a bright strap beside the number becomes a
    # leading digit (47 read as 147 at 0.93 confidence). Dropping a thin
    # component turns that into an honest miss. A wide component may be
    # digits run together, so it is cut where they touch: a touching 71 was
    # 0.97 wide, inside the single-digit bound, and would otherwise have
    # been read as one digit. One too wide to be any digit that cannot be
    # cut refuses the whole read, because dropping it would shorten the
    # number to somebody else's.
    shaped = []
    for b in digits:
        aspect = b[2] / b[3]
        parts = _split_touching(labels == b[5], b) if aspect > SPLIT_ASPECT else None
        if parts is not None:
            shaped.extend(parts)
        elif aspect > MAX_DIGIT_ASPECT:
            return []
        elif aspect >= MIN_DIGIT_ASPECT:
            shaped.append(b)
    digits = sorted(shaped, key=lambda b: b[0])

    return [
        crop.crop((x, y, x + w, y + h)).resize(DIGIT_SIZE, Image.BILINEAR)
        for x, y, w, h, *_ in digits
    ]


def _split_touching(component: np.ndarray, box, depth: int = 0):
    """Cut a run of touching digits at its thinnest columns, or None.

    Every piece must come out digit-shaped and nearly as tall as the run.
    Anything else is a blob that cannot be taken apart honestly.
    """
    x, y, w, h = box[:4]
    region = component[y:y + h, x:x + w]
    columns = region.sum(axis=0)
    lo, hi = int(w * 0.2), int(w * 0.8)
    if hi <= lo:
        return None
    cut = lo + int(np.argmin(columns[lo:hi]))
    if columns[cut] > MAX_BRIDGE * h:
        return None
    pieces = []
    for start, stop in ((0, cut), (cut + 1, w)):
        part = region[:, start:stop]
        cols, rows = np.flatnonzero(part.any(axis=0)), np.flatnonzero(part.any(axis=1))
        if len(cols) == 0:
            return None
        piece = (x + start + cols[0], y + rows[0], cols[-1] - cols[0] + 1,
                 rows[-1] - rows[0] + 1, int(part.sum()), box[5])
        if piece[3] < 0.8 * h:
            return None
        aspect = piece[2] / piece[3]
        if aspect > MAX_DIGIT_ASPECT and depth < 2:
            sub = np.zeros_like(component)
            sub[y:y + h, x + start:x + stop] = part
            more = _split_touching(sub, piece, depth + 1)
            if more is None:
                return None
            pieces.extend(more)
        elif MIN_DIGIT_ASPECT <= aspect <= MAX_DIGIT_ASPECT:
            pieces.append(piece)
        else:
            return None
    return pieces


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


# What each digit becomes turned half round, in the bib face. 3, 4 and 7
# become no digit at all.
TURNED = {"0": "0", "1": "1", "2": "2", "5": "5", "6": "9", "8": "8", "9": "6"}


def turned_reading(text: str):
    """The number the same bib shows upside down, or None if it shows none.

    A reading with a leading zero is not a bib, so 20 turned is no number.
    """
    if not all(d in TURNED for d in text):
        return None
    turned = "".join(TURNED[d] for d in reversed(text))
    return None if turned.startswith("0") else turned


def read_bib(crop: Image.Image) -> tuple:
    """Return (number as a string or None, confidence between 0 and 1).

    A crop from extract_bib says in crop.info["orientation"] whether its way
    up was proven. When it was not, a number that is a different bib upside
    down is refused: a 6 held upside down reads as a clean 9, and 16 as 91.
    """
    text, confidence = _read_upright(crop)
    if text is None or crop.info.get("orientation", "upright") is not None:
        return text, confidence
    turned = turned_reading(text)
    if turned is not None and turned != text:
        return None, 0.0
    return text, confidence


def _read_upright(crop: Image.Image) -> tuple:
    crop = normalise(crop)
    if crop is None:
        return None, 0.0
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
    weakest = float(probs.max(axis=1).min())
    # A skewed bib read as 19 with its weakest digit at 0.56. One uncertain
    # digit makes the number a guess, and a guess hands out another time.
    if weakest < MIN_DIGIT_CONFIDENCE:
        return None, weakest
    # The weakest digit sets the confidence: one uncertain digit makes the
    # whole number uncertain, because a bib is read as a whole or not at all.
    return "".join(str(int(v)) for v in labels), float(probs.max(axis=1).min())
