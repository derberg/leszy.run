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


def _holds_digits(rgb_box, contour, origin) -> bool:
    """True when the candidate has bright shapes inside it, as a bib does.

    The digits are holes in the colour mask, so the test runs on the filled
    contour: pixels clearly brighter than the block's own median, covering a
    share of it no blank patch and no all-white sheet would.
    """
    filled = np.zeros(rgb_box.shape[:2], np.uint8)
    cv2.drawContours(filled, [contour - np.array(origin)], -1, 255, cv2.FILLED)
    inside = filled > 0
    if inside.sum() == 0:
        return False
    grey = cv2.cvtColor(rgb_box, cv2.COLOR_RGB2GRAY).astype(np.float32)[inside]
    block = float(np.median(grey))
    bright = (grey > block + 25).mean()
    return MIN_DIGIT_FRACTION <= bright <= MAX_DIGIT_FRACTION


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
    best = _best_block(rgb, _colour_mask(rgb), structural=False)
    if best is None:
        best = _best_block(rgb, _colour_mask(rgb, relaxed=True), structural=True)
    if best is None:
        return None
    (x1, y1, x2, y2), ((cx, cy), size, angle) = best
    return (
        (x1 + offset_x, y1 + offset_y, x2 + offset_x, y2 + offset_y),
        ((cx + offset_x, cy + offset_y), size, angle),
    )


def _best_block(rgb, mask, structural):
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
        if structural:
            # A field of foliage filling the search area touches its edge.
            # A bib on a torso, or pasted into a scene, sits inside it.
            if x == 0 or y == 0 or x + w >= width or y + h >= height:
                continue
            if not _holds_digits(rgb[y:y + h, x:x + w], contour, (x, y)):
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
