import numpy as np
import pytest

from vision.bib_spec import BIB
from vision.synth.render import render_bib


def test_renders_expected_pixel_size():
    im = render_bib(47, px_per_mm=2.0)
    assert im.size == (int(BIB.block_w_mm * 2), int(BIB.block_h_mm * 2))


@pytest.mark.parametrize("number", [1, 47, 100, 999])
def test_digits_cover_a_plausible_share_of_the_block(number):
    arr = np.asarray(render_bib(number, px_per_mm=2.0).convert("L"))
    share = float((arr > 200).mean())
    assert 0.02 < share < 0.45, f"{number} covered {share:.3f}"


def test_digit_height_is_constant_from_one_digit_to_three():
    def digit_rows(n):
        arr = np.asarray(render_bib(n, px_per_mm=2.0).convert("L"))
        rows = np.where((arr > 200).any(axis=1))[0]
        return int(rows.max() - rows.min())

    assert abs(digit_rows(1) - digit_rows(100)) <= 2
