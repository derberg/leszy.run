"""Find the bib block in an image.

The leszy.run bib is a flat rectangle of one saturated colour with bright
digits inside, so a colour mask plus a rectangle fit finds it without a
trained model.

Pass `region` to search inside a detected person. Colour alone cannot
separate the bib from foliage: photographed in dull light the printed block
measured (57, -7, 16) in OpenCV's 8-bit Lab against the PDF's (128, -22, 55),
about as chromatic as moss. What foliage lacks is the structure, so a candidate must
also hold bright digits and sit clear of the edge of the search area.
"""
import cv2
import numpy as np
from PIL import Image

from vision.bib_spec import BIB

MIN_AREA_FRACTION = 0.002
ASPECT_MIN, ASPECT_MAX = 1.2, 3.2
MAX_HUE_DISTANCE = 12          # OpenCV hue units, so 24 degrees
MAX_SAT_DISTANCE = 90          # strict pass: close to the PDF's olive
# Relaxed pass: a floor, not a distance from the PDF's fully saturated olive: a print under
# real light measured saturation 104 to 140 of 255 and was never located.
MIN_SATURATION = 60
MIN_VALUE = 20                 # below this, hue is sensor noise
# Share of the block the digits cover. Measured on renders of 1 to 4 digits;
# a patch with no bright shapes inside is foliage, not a bib.
MIN_DIGIT_FRACTION = 0.05
# Closing that joins the pieces of a block cut apart by its own digits, as a
# share of the search area's width: about one digit stroke on a torso.
JOIN_FRACTION = 0.025
MAX_DIGIT_FRACTION = 0.6
MIN_FILL = 0.7                 # a real block is solid; foliage is ragged


def _colour_mask(rgb: np.ndarray, relaxed: bool = False) -> np.ndarray:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    target = cv2.cvtColor(
        np.array(BIB.block_rgb, dtype=np.uint8).reshape(1, 1, 3), cv2.COLOR_RGB2HSV
    ).astype(np.float32)[0, 0]

    diff = np.abs(hsv[..., 0] - target[0])
    hue_distance = np.minimum(diff, 180 - diff)      # hue wraps
    if relaxed:
        colour = (hsv[..., 1] >= MIN_SATURATION) & (hsv[..., 2] >= MIN_VALUE)
    else:
        colour = np.abs(hsv[..., 1] - target[1]) < MAX_SAT_DISTANCE

    mask = ((hue_distance < MAX_HUE_DISTANCE) & colour).astype(np.uint8) * 255
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))


def _best_relaxed(rgb):
    """The bib block judged by its structure, when colour alone is not enough.

    The digits of a real bib are nearly as tall as the block and cut it into
    pieces in the colour mask: on a photographed bib 20 the olive alone
    filled 42 percent of its rectangle and the digits sat outside its
    outline. So the pieces are joined with a closing about one digit stroke
    wide, the rectangle is fitted to the convex hull, and a pixel counts as
    bib when it is olive OR clearly brighter than the olive. A field of
    foliage touches the edge of the search area and has no bright shapes
    inside it, so both are refused.
    """
    # Structure survives halving, and on a torso-sized search area the full
    # resolution doubled the reader's time per frame on the Pi.
    scale = 2 if rgb.shape[1] > 800 else 1
    if scale > 1:
        rgb = cv2.resize(rgb, (rgb.shape[1] // scale, rgb.shape[0] // scale),
                         interpolation=cv2.INTER_AREA)
    olive = _colour_mask(rgb, relaxed=True)
    height, width = olive.shape
    k = max(7, int(width * JOIN_FRACTION))
    joined = cv2.morphologyEx(olive, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    grey = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    best, best_area = None, 0
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w * h < width * height * MIN_AREA_FRACTION:
            continue
        if x == 0 or y == 0 or x + w >= width or y + h >= height:
            continue
        rect = cv2.minAreaRect(cv2.convexHull(contour))
        (_, _), (rect_w, rect_h), _ = rect
        if rect_w < 1 or rect_h < 1:
            continue
        if not ASPECT_MIN < max(rect_w, rect_h) / min(rect_w, rect_h) < ASPECT_MAX:
            continue
        inside = np.zeros((height, width), np.uint8)
        cv2.fillPoly(inside, [np.int32(cv2.boxPoints(rect))], 255)
        inside = inside > 0
        block_px = (olive > 0) & inside
        if not block_px.any():
            continue
        bright = (grey > np.median(grey[block_px]) + 25) & inside
        if ((olive > 0) | bright)[inside].mean() < MIN_FILL:
            continue
        if not MIN_DIGIT_FRACTION <= bright[inside].mean() <= MAX_DIGIT_FRACTION:
            continue
        if rect_w * rect_h > best_area:
            best, best_area = ((x, y, x + w, y + h), rect), rect_w * rect_h
    if best is None or scale == 1:
        return best
    (x1, y1, x2, y2), ((cx, cy), (rw, rh), angle) = best
    return ((x1 * scale, y1 * scale, x2 * scale, y2 * scale),
            ((cx * scale, cy * scale), (rw * scale, rh * scale), angle))


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

    # The strict pass finds a well-lit print by colour alone, which also
    # keeps a block pasted straight onto foliage apart from it. Only when it
    # finds nothing does the relaxed pass run, and there colour no longer
    # separates bib from foliage, so the candidate must also hold digits.
    best = _best_block(rgb, _colour_mask(rgb))
    if best is None:
        best = _best_relaxed(rgb)
    if best is None:
        return None
    (x1, y1, x2, y2), ((cx, cy), size, angle) = best
    return (
        (x1 + offset_x, y1 + offset_y, x2 + offset_x, y2 + offset_y),
        ((cx + offset_x, cy + offset_y), size, angle),
    )


def _best_block(rgb, mask):
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
    return best


def locate_bib(image: Image.Image, region=None):
    """Return (x1, y1, x2, y2) of the bib block, or None."""
    found = _find_block(image, region)
    return None if found is None else found[0]


def _upright(rect_w, rect_h, angle):
    """Return ((long, short), angle) that puts the block's long edge horizontal.

    minAreaRect may describe the block standing on its short edge, so swap the
    sides and turn by 90. Then take the smallest rotation that does it.
    OpenCV's angle convention is not stable across releases: 4.11 reports an
    untilted block at +90 degrees and 4.14 at -90. Subtracting 90 from the
    second gives -180, which turns the crop upside down, and 47 then reads as
    24. A rectangle looks the same after half a turn, so the correction is
    always folded into [-90, 90) and never flips the crop.
    """
    if rect_w < rect_h:
        rect_w, rect_h = rect_h, rect_w
        angle -= 90.0
    angle = (angle + 90.0) % 180.0 - 90.0
    return (rect_w, rect_h), angle


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

    (rect_w, rect_h), angle = _upright(rect_w, rect_h, angle)

    rgb = np.asarray(image.convert("RGB"))
    rotation = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
    straightened = cv2.warpAffine(
        rgb, rotation, (rgb.shape[1], rgb.shape[0]), flags=cv2.INTER_CUBIC
    )
    upright = cv2.getRectSubPix(
        straightened, (int(round(rect_w)), int(round(rect_h))), (cx, cy)
    )
    return box, Image.fromarray(upright)
