from vision.bib_spec import BIB


def test_digit_height_is_recorded_in_millimetres():
    assert BIB.digit_height_mm == 76


def test_block_is_wider_than_it_is_tall():
    assert BIB.block_w_mm > BIB.block_h_mm


def test_colours_are_rgb_triples():
    for colour in (BIB.block_rgb, BIB.digit_rgb):
        assert len(colour) == 3
        assert all(0 <= c <= 255 for c in colour)


def test_block_colour_is_the_sampled_olive_not_the_placeholder():
    # The placeholder was matplotlib olivedrab. A sampled value differing
    # from it is what proves the sampling step actually ran.
    assert BIB.block_rgb != (107, 142, 35)


def test_digits_are_much_brighter_than_the_block():
    def luma(c):
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

    assert luma(BIB.digit_rgb) - luma(BIB.block_rgb) > 80
