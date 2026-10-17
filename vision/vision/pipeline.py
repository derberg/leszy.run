"""Read every bib in one frame.

Person first, then the bib inside that person. When a person has no bib
inside their box, the whole frame is searched once and a bib found there is
given to the nearest person without one: a runner holding the number out in
a hand, or wearing it on an arm, has it outside the box the detector draws.
The locator's own checks (digits inside, clear of the frame edge) and the
two-frame rule in the tracker stand between that wider search and foliage.

A person with no readable bib still produces a Sighting whose text is None.
That row is evidence, not noise: it says somebody crossed and could not be
read, which is exactly the lead an operator needs when a runner is missing.
"""
from dataclasses import dataclass

from PIL import Image

from vision.locate import extract_bib
from vision.people import detect_people
from vision.recognize import read_bib
from vision.torso import read_torsos, torso_box


@dataclass(frozen=True)
class Sighting:
    text: str | None
    confidence: float
    bib_box: tuple | None
    person_box: tuple


def _centre_offset(person_box, bib_box) -> float:
    """How far the bib sits from the middle of the person, 0 is dead centre.

    Normalised by the person's width so a distant runner is judged the same
    as a near one.
    """
    px1, _, px2, _ = person_box
    bx1, _, bx2, _ = bib_box
    person_mid = (px1 + px2) / 2
    bib_mid = (bx1 + bx2) / 2
    width = max(1.0, px2 - px1)
    return abs(bib_mid - person_mid) / width


def resolve_bib_claims(claims: list) -> list:
    """Give each bib to exactly one person.

    locate_bib searches inside a person box and returns the largest block it
    finds there. It has no idea whose bib that is. When two people overlap,
    the same bib lands inside both boxes and both are given that number, at
    full confidence, so one runner is silently handed the other's time.

    The bib goes to the person it sits most centrally within, because a
    runner wears their own number on their own chest. Everybody else loses
    it and comes back with None, which is a miss: recoverable, and a person
    can still resolve it from the photograph.
    """
    resolved = [None] * len(claims)
    by_bib = {}
    for index, (person_box, bib_box) in enumerate(claims):
        if bib_box is None:
            resolved[index] = (person_box, None)
            continue
        by_bib.setdefault(tuple(bib_box), []).append(index)

    for bib_box, contenders in by_bib.items():
        winner = min(
            contenders,
            key=lambda i: _centre_offset(claims[i][0], bib_box),
        )
        for index in contenders:
            resolved[index] = (
                claims[index][0], bib_box if index == winner else None
            )
    return resolved


def _distance(person_box, bib_box) -> float:
    """Gap between the bib's centre and the person's box, 0 when inside."""
    px1, py1, px2, py2 = person_box
    bx1, by1, bx2, by2 = bib_box
    cx, cy = (bx1 + bx2) / 2, (by1 + by2) / 2
    dx = max(px1 - cx, 0, cx - px2)
    dy = max(py1 - cy, 0, cy - py2)
    return (dx * dx + dy * dy) ** 0.5


def _overlap(a, b) -> float:
    """Intersection over union of two boxes."""
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)
    return inter / union if union > 0 else 0.0


SAME_BIB = 0.5


def locate_claims(image: Image.Image, people: list):
    """(claims, crops): each person with the bib box found for them, or None.

    Shared by read_frame and the live reader so both search the same way.
    One bib found from two overlapping person boxes comes back a few pixels
    apart, (693, 379, 938, 530) and (696, 383, 941, 521) on one frame of 71.
    Taken as two bibs, each started its own track, the reads split between
    them one apiece, and neither reached the two frames a number needs. So
    a box that mostly overlaps one already found is that same bib.
    """
    claims, crops = [], {}
    for person_box in people:
        bib_box, crop = extract_bib(image, region=person_box)
        if bib_box is not None:
            same = next((k for k in crops if _overlap(k, bib_box) > SAME_BIB), None)
            if same is not None:
                bib_box = same
            else:
                crops[tuple(bib_box)] = crop
        claims.append((person_box, bib_box))

    bare = [i for i, (_, bib_box) in enumerate(claims) if bib_box is None]
    if bare:
        bib_box, crop = extract_bib(image)
        # The bib the whole frame turns up is usually one a person already
        # holds, found again a few pixels off. Given to a bare box it became
        # a second claim, and a poster on the wall the detector takes for a
        # person collected a vote from every runner who passed in front.
        if bib_box is not None and not any(
                _overlap(k, bib_box) > SAME_BIB for k in crops):
            nearest = min(bare, key=lambda i: _distance(claims[i][0], bib_box))
            claims[nearest] = (claims[nearest][0], bib_box)
            crops[tuple(bib_box)] = crop
    return claims, crops


# A bib is never bigger than the person wearing it. At the 2026-10-17 race the
# whole-frame search handed the recognizer the arch and the tent, blocks 900
# to 1,368 pixels wide given to runners 40 to 480 wide, and 21 finishers came
# back with a 1 or a 4 that nobody wore. A bib held out beside the body is
# still accepted: it sits outside the box but is the size of a bib.
def _plausible(person_box, bib_box) -> bool:
    px1, py1, px2, py2 = person_box
    bx1, by1, bx2, by2 = bib_box
    return bx2 - bx1 <= px2 - px1 and by2 - by1 <= (py2 - py1) * 0.5


def _audit_crop(image, person_box):
    """The torso, cut below the chin, for the audit list.

    The list shows a picture beside every read and must not show a face, so
    this starts lower than the band the model reads.
    """
    x1, y1, x2, y2 = (int(v) for v in person_box)
    h = y2 - y1
    return image.convert("RGB").crop((x1, int(y1 + 0.22 * h), x2, int(y1 + 0.72 * h)))


def read_people(image: Image.Image) -> list:
    """(Sighting, crop) for every detected person, readable or not.

    Two readers look at each person. The torso reader is the one that reads
    a small bib: it takes the person's torso and returns the number directly.
    The colour locator and digit recogniser still read a large olive block,
    and a bib held out beside the body, but only count when the block is no
    bigger than the person. When both read a number and the numbers differ, the
    person is refused: one of them is wrong and nothing here says which.
    """
    people = detect_people(image)
    if not people:
        return []
    from_torso = read_torsos(image, people)
    claims, crops = locate_claims(image, people)

    out = []
    for (t_text, t_conf), (person_box, bib_box) in zip(
            from_torso, resolve_bib_claims(claims)):
        b_text, b_conf, crop = None, 0.0, None
        if bib_box is not None:
            crop = crops[tuple(bib_box)]
            b_text, b_conf = read_bib(crop)
            if b_text is not None and not _plausible(person_box, bib_box):
                b_text, b_conf = None, 0.0
        if t_text is not None and b_text is not None and t_text != b_text:
            sighting = Sighting(None, max(t_conf, b_conf), bib_box, person_box)
        elif t_text is not None:
            sighting = Sighting(t_text, t_conf, torso_box(person_box), person_box)
            crop = _audit_crop(image, person_box)
        elif b_text is not None:
            sighting = Sighting(b_text, b_conf, bib_box, person_box)
        else:
            # Nobody read a number. A refusal from either reader still
            # counts against the winner in the tracker, as before.
            sighting = Sighting(None, max(t_conf, b_conf), bib_box, person_box)
        out.append((sighting, crop if sighting.bib_box is not None else None))
    return out


def read_frame(image: Image.Image) -> list:
    """Return one Sighting per detected person, readable or not."""
    return [sighting for sighting, _ in read_people(image)]
