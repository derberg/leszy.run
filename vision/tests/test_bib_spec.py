from vision.bib_spec import BIB


def test_digit_height_is_recorded_in_millimetres():
    assert BIB.digit_height_mm == 76


def test_block_is_wider_than_it_is_tall():
    assert BIB.block_w_mm > BIB.block_h_mm


def test_colours_are_rgb_triples():
    for colour in (BIB.block_rgb, BIB.digit_rgb):
        assert len(colour) == 3
        assert all(0 <= c <= 255 for c in colour)
