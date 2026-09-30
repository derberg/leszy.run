"""Geometry and colour of the leszy.run bib.

Every number here is measured from leszy_bibs_light.pdf in the zatyrani.pl
repository. The colours start as placeholders; scripts/sample_bib_colours.py
replaces them with values sampled from the real document, because the digit
recognizer trains on these colours and a wrong olive shifts every training
image away from what the camera will see.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class BibSpec:
    block_w_mm: float
    block_h_mm: float
    digit_height_mm: float
    block_rgb: tuple
    digit_rgb: tuple
    corner_mark_mm: float


BIB = BibSpec(
    block_w_mm=190.0,
    block_h_mm=95.0,
    digit_height_mm=76.0,
    block_rgb=(107, 142, 35),
    digit_rgb=(240, 240, 240),
    corner_mark_mm=12.0,
)
