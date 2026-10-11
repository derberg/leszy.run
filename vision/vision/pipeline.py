"""Read every bib in one frame.

Person first, then the bib inside that person. Searching a whole frame for
the block colour finds undergrowth at a trail race; searching inside a
detected torso does not.

A person with no readable bib still produces a Sighting whose text is None.
That row is evidence, not noise: it says somebody crossed and could not be
read, which is exactly the lead an operator needs when a runner is missing.
"""
from dataclasses import dataclass

from PIL import Image

from vision.locate import extract_bib
from vision.people import detect_people
from vision.recognize import read_bib


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


def read_frame(image: Image.Image) -> list:
    """Return one Sighting per detected person, readable or not."""
    people = detect_people(image)
    claims, crops = [], {}
    for person_box in people:
        bib_box, crop = extract_bib(image, region=person_box)
        claims.append((person_box, bib_box))
        if bib_box is not None:
            crops[tuple(bib_box)] = crop

    sightings = []
    for person_box, bib_box in resolve_bib_claims(claims):
        if bib_box is None:
            sightings.append(Sighting(None, 0.0, None, person_box))
            continue
        # The deskewed crop, not image.crop(bib_box): a tilted bib read off
        # its axis-aligned box comes back as a different number.
        text, confidence = read_bib(crops[tuple(bib_box)])
        sightings.append(Sighting(text, confidence, bib_box, person_box))
    return sightings
