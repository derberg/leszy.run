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

from vision.locate import locate_bib
from vision.people import detect_people
from vision.recognize import read_bib


@dataclass(frozen=True)
class Sighting:
    text: str
    confidence: float
    bib_box: tuple
    person_box: tuple


def read_frame(image: Image.Image) -> list:
    """Return one Sighting per detected person, readable or not."""
    sightings = []
    for person_box in detect_people(image):
        bib_box = locate_bib(image, region=person_box)
        if bib_box is None:
            sightings.append(Sighting(None, 0.0, None, person_box))
            continue
        text, confidence = read_bib(image.crop(bib_box))
        sightings.append(Sighting(text, confidence, bib_box, person_box))
    return sightings
