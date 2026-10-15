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
LOCATE_WIDTH = 800             # search area is shrunk to this before locating
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
# Which way up the bib is, read from the paper above and below the block. The
# top banner carries the logo and a LESZY.RUN wordmark set at 260 points; the
# bottom one only LESZY.RUN/KALENDARZ at 150. Measured on Pi frames as glyph
# height over block height: header 0.14 to 0.25, footer 0.05 to 0.12.
BANNER_BAND = 0.4              # band searched above and below, share of block height
HEADER_GLYPH = 0.13            # a glyph this tall can only be the header
HEADER_OVER_FOOTER = 1.3       # with both bands seen, how much taller the header must be
MIN_GLYPHS = 3                 # fewer is a hand or a shadow, not a line of text
MIN_PAPER = 0.3                # share of a band that must be bright paper
PAPER_OVER_BLOCK = 1.4         # paper is this much brighter than the olive block
# Dusk. After sunset at the 2026-10-15 test race the camera ran at its gain
# and shutter ceilings and the block still came back at a value of about 16,
# under MIN_VALUE, so no runner of the race proper was located by colour. A
# search area whose brightest pixels sit under DARK_BELOW is multiplied up
# before anything else looks at it. Every channel takes the same gain, which
# keeps hue and saturation, and the absolute levels the locator also leans
# on (MIN_VALUE, digits 25 levels above the block, paper brighter than the
# block) scale with the picture instead of being tuned for the dark.
DARK_BELOW = 120               # 99th percentile grey of the search area
LIFT_TO = 220
MAX_LIFT = 8.0                 # beyond this it is amplifying sensor noise


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
    return best


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
    # Located at no more than LOCATE_WIDTH pixels across. On the Pi a
    # torso-sized search area at full resolution cost 53 ms a frame, enough
    # to leave the reader behind the camera. The deskew and crop that follow
    # still use the full-resolution frame.
    scale = max(1.0, rgb.shape[1] / LOCATE_WIDTH)
    if scale > 1.0:
        rgb = cv2.resize(rgb, (int(rgb.shape[1] / scale), int(rgb.shape[0] / scale)),
                         interpolation=cv2.INTER_AREA)

    # The strict pass finds a well-lit print by colour alone, which also
    # keeps a block pasted straight onto foliage apart from it. Only when it
    # finds nothing does the relaxed pass run, and there colour no longer
    # separates bib from foliage, so the candidate must also hold digits.
    best = _best_block(rgb, _colour_mask(rgb))
    if best is None:
        best = _best_relaxed(rgb)
    if best is None:
        return None
    (x1, y1, x2, y2), ((cx, cy), (rw, rh), angle) = best
    return (
        (int(x1 * scale) + offset_x, int(y1 * scale) + offset_y,
         int(x2 * scale) + offset_x, int(y2 * scale) + offset_y),
        ((cx * scale + offset_x, cy * scale + offset_y), (rw * scale, rh * scale), angle),
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


def _lift(image: Image.Image, region=None) -> Image.Image:
    """The image with a dark search area brought up to daylight levels.

    The gain is measured on the search area alone, because a runner in the
    shade of a lit gate is dark while the frame is not. Returned unchanged
    when the area is bright enough already.
    """
    rgb = np.asarray(image.convert("RGB"))
    area = rgb
    if region is not None:
        x1, y1, x2, y2 = (int(v) for v in region)
        area = rgb[y1:y2, x1:x2]
    if area.size == 0:
        return image
    grey = cv2.cvtColor(np.ascontiguousarray(area[::4, ::4]), cv2.COLOR_RGB2GRAY)
    top = float(np.percentile(grey, 99))
    if top >= DARK_BELOW:
        return image
    gain = min(MAX_LIFT, LIFT_TO / max(top, 1.0))
    return Image.fromarray(cv2.convertScaleAbs(rgb, alpha=gain))


def locate_bib(image: Image.Image, region=None):
    """Return (x1, y1, x2, y2) of the bib block, or None."""
    found = _find_block(_lift(image, region), region)
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


def _glyph_height(band, block_h, block_grey):
    """Typical height of the dark letters in one banner band, or None.

    The tallest few glyphs, so the dot and the slash in the wordmark do not
    drag it down. A band that is not mostly bright paper is a shirt or a
    hand and says nothing: dark folds of clothing under a bare block once
    passed for a header and turned a 47 upside down.
    """
    if band.size == 0:
        return None
    grey = cv2.cvtColor(band, cv2.COLOR_RGB2GRAY)
    paper = np.percentile(grey, 85)
    if paper < block_grey * PAPER_OVER_BLOCK or (grey > paper - 40).mean() < MIN_PAPER:
        return None
    dark = (grey < paper * 0.6).astype(np.uint8)
    count, _, stats, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    heights = []
    for x, y, w, h, area in stats[1:count]:
        if (0.04 * block_h <= h <= 0.32 * block_h and w < 0.3 * band.shape[1]
                and area > 0.15 * w * h):
            heights.append(h / block_h)
    if len(heights) < MIN_GLYPHS:
        return None
    return float(np.median(sorted(heights)[-6:]))


def bib_orientation(context: np.ndarray):
    """'upright', 'flipped' or None, from a straightened crop round the block.

    The locator turns the block so its long edge is level, and a rectangle
    looks the same after half a turn, so a bib held upside down came out
    upside down and its 6 was read as 9. Only the paper round the block says
    which way up it is: the taller lettering is the header. None when the
    banners are hidden or out of frame, which is common, so a caller must
    treat None as "could be either", never as upright.
    """
    olive = _colour_mask(context, relaxed=True) > 0
    # The block's rows are found in two strips just inside its left and
    # right edges, where the number never reaches: a whole-row test failed
    # because wide digits cut the block apart (across a 71 no row was a
    # quarter olive), so the "band above" fell inside the number and a bib
    # held upright was turned over. Either strip is enough, since a hand
    # holding the bib covers one side. The context is 1.1 block widths, so
    # the block runs from about 4.5 to 95.5 percent of it.
    width = olive.shape[1]
    left = olive[:, int(width * 0.055):int(width * 0.10)].mean(axis=1)
    right = olive[:, int(width * 0.90):int(width * 0.945)].mean(axis=1)
    rows = np.maximum(left, right) > 0.5
    # The run through the middle, where the locator put the block. Gaps of
    # a few rows (a corner mark, a crease) are bridged; the white banners
    # are far wider than that.
    centre = len(rows) // 2
    gap = max(2, int(len(rows) / 2.4 * 0.1))
    top = bottom = None
    last = centre
    for i in range(centre, -1, -1):
        if rows[i]:
            top, last = i, i
        elif last - i > gap:
            break
    last = centre
    for i in range(centre, len(rows)):
        if rows[i]:
            bottom, last = i + 1, i
        elif i - last > gap:
            break
    if top is None or bottom is None:
        return None
    run = bottom - top
    if run < 10:
        return None
    cols = np.flatnonzero(olive[top:bottom].mean(axis=0) > 0.5)
    if len(cols) < 10:
        return None
    margin = int((cols[-1] - cols[0]) * 0.05)
    left, right = cols[0] + margin, cols[-1] - margin
    band = int(run * BANNER_BAND)
    grey = cv2.cvtColor(context, cv2.COLOR_RGB2GRAY)
    block_grey = float(np.median(grey[top:bottom][olive[top:bottom]]))
    above = _glyph_height(context[max(0, top - band):top, left:right], run, block_grey)
    below = _glyph_height(context[bottom:bottom + band, left:right], run, block_grey)

    if above is not None and below is not None:
        if above >= HEADER_GLYPH and above > below * HEADER_OVER_FOOTER:
            return "upright"
        if below >= HEADER_GLYPH and below > above * HEADER_OVER_FOOTER:
            return "flipped"
        return None
    # One band only. A tall line of text above is the header, which only
    # confirms what is assumed anyway. Turning the crop over takes both
    # bands: a wrong turn reads a 6 as 9 with nothing to show for it.
    if above is not None and above >= HEADER_GLYPH:
        return "upright"
    return None


def extract_bib(image: Image.Image, region=None):
    """Return (box, upright crop) for the bib block, or (None, None).

    The crop is deskewed. Reading straight off a tilted crop is not safe:
    measured on a rendered bib, 47 came back as 40 at ten degrees of tilt and
    55 at twenty, both at around 0.5 confidence. A bib pinned to a moving
    runner tilts as a matter of course, so that is an ordinary input, and a
    confidently wrong number is the costliest thing this pipeline can produce.

    The crop comes from the lifted image too, so a dusk crop reaches the
    recognizer at the levels it was located at.
    """
    image = _lift(image, region)
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
    context = cv2.getRectSubPix(
        straightened, (int(rect_w * 1.1), int(rect_h * 2.4)), (cx, cy)
    )
    orientation = bib_orientation(context)
    crop = Image.fromarray(upright)
    if orientation == "flipped":
        crop = crop.rotate(180)
    # read_bib reads this: with no proof of which way up, a 6 and a 9 are
    # the same picture.
    crop.info["orientation"] = orientation
    return box, crop
