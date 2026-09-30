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


def locate_bib(image: Image.Image, region=None):
    """Return (x1, y1, x2, y2) of the bib block, or None."""
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
        area = w * h
        if h == 0 or area < width * height * MIN_AREA_FRACTION:
            continue
        if not ASPECT_MIN < w / h < ASPECT_MAX:
            continue
        if cv2.contourArea(contour) / area < MIN_FILL:
            continue
        if area > best_area:
            best, best_area = (x, y, x + w, y + h), area

    if best is None:
        return None
    return (best[0] + offset_x, best[1] + offset_y,
            best[2] + offset_x, best[3] + offset_y)
