"""Find the bib block in an image.

The leszy.run bib is a flat rectangle of one saturated colour with bright
digits inside, so a colour mask plus a rectangle fit finds it without a
trained model.

Pass `region` to search inside a detected person. That is what separates the
bib from mossy undergrowth at a trail race: the hue of wet moss is close to
the block, but moss is far less saturated, and it is not inside a torso.
"""
import cv2
import numpy as np
from PIL import Image

from vision.bib_spec import BIB

MIN_AREA_FRACTION = 0.002
ASPECT_MIN, ASPECT_MAX = 1.2, 3.2
MAX_HUE_DISTANCE = 12          # OpenCV hue units, so 24 degrees
MAX_SAT_DISTANCE = 90
MIN_FILL = 0.7                 # a real block is solid; foliage is ragged


def _colour_mask(rgb: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    target = cv2.cvtColor(
        np.array(BIB.block_rgb, dtype=np.uint8).reshape(1, 1, 3), cv2.COLOR_RGB2HSV
    ).astype(np.float32)[0, 0]

    diff = np.abs(hsv[..., 0] - target[0])
    hue_distance = np.minimum(diff, 180 - diff)      # hue wraps
    sat_distance = np.abs(hsv[..., 1] - target[1])

    mask = ((hue_distance < MAX_HUE_DISTANCE)
            & (sat_distance < MAX_SAT_DISTANCE)).astype(np.uint8) * 255
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))


def _find_block(image: Image.Image, region=None):
    """Return (axis-aligned box, rotated rect) for the bib block, or None."""
    rgb = np.asarray(image.convert("RGB"))
    offset_x = offset_y = 0
    if region is not None:
        x1, y1, x2, y2 = (int(v) for v in region)
        rgb = rgb[y1:y2, x1:x2]
        offset_x, offset_y = x1, y1
    if rgb.size == 0:
        return None

    mask = _colour_mask(rgb)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    height, width = mask.shape
    best, best_area = None, 0
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if h == 0 or w * h < width * height * MIN_AREA_FRACTION:
            continue

        # Fill and aspect are judged on the ROTATED rectangle, not the
        # axis-aligned one. A bib swings on a moving runner and the runner
        # leans, and a tilted rectangle fills less and less of its
        # axis-aligned box: measured against the upright fit, the block was
        # lost entirely from about ten degrees, which is ordinary rather
        # than exotic.
        (_, _), (rect_w, rect_h), _ = cv2.minAreaRect(contour)
        if rect_w < 1 or rect_h < 1:
            continue
        long_side, short_side = max(rect_w, rect_h), min(rect_w, rect_h)
        if not ASPECT_MIN < long_side / short_side < ASPECT_MAX:
            continue
        if cv2.contourArea(contour) / (rect_w * rect_h) < MIN_FILL:
            continue

        area = rect_w * rect_h
        if area > best_area:
            rect = cv2.minAreaRect(contour)
            best = ((x, y, x + w, y + h), rect)
            best_area = area

    if best is None:
        return None
    (x1, y1, x2, y2), ((cx, cy), size, angle) = best
    return (
        (x1 + offset_x, y1 + offset_y, x2 + offset_x, y2 + offset_y),
        ((cx + offset_x, cy + offset_y), size, angle),
    )


def locate_bib(image: Image.Image, region=None):
    """Return (x1, y1, x2, y2) of the bib block, or None."""
    found = _find_block(image, region)
    return None if found is None else found[0]


def extract_bib(image: Image.Image, region=None):
    """Return (box, upright crop) for the bib block, or (None, None).

    The crop is deskewed. Reading straight off a tilted crop is not safe:
    measured on a rendered bib, 47 came back as 40 at ten degrees of tilt and
    55 at twenty, both at around 0.5 confidence. A bib pinned to a moving
    runner tilts as a matter of course, so that is an ordinary input, and a
    confidently wrong number is the costliest thing this pipeline can produce.
    """
    found = _find_block(image, region)
    if found is None:
        return None, None
    box, ((cx, cy), (rect_w, rect_h), angle) = found

    # minAreaRect reports an angle in (0, 90] and may describe the block
    # standing on its short edge. Put the long edge horizontal, which is how
    # the block is printed. Subtracting brings the angle into (-90, 0], which
    # is the small correction a tilted bib needs. Adding instead turns the
    # crop nearly upside down, and 47 then reads as 22.
    if rect_w < rect_h:
        rect_w, rect_h = rect_h, rect_w
        angle -= 90.0

    rgb = np.asarray(image.convert("RGB"))
    rotation = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
    straightened = cv2.warpAffine(
        rgb, rotation, (rgb.shape[1], rgb.shape[0]), flags=cv2.INTER_CUBIC
    )
    upright = cv2.getRectSubPix(
        straightened, (int(round(rect_w)), int(round(rect_h))), (cx, cy)
    )
    return box, Image.fromarray(upright)
