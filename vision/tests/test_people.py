from PIL import Image

from vision.people import detect_people

FIXTURE = "tests/fixtures/runner.jpg"


def test_returns_a_list_on_an_empty_scene():
    assert detect_people(Image.new("RGB", (640, 480), (90, 110, 70))) == []


def test_finds_the_person_in_the_fixture():
    assert len(detect_people(Image.open(FIXTURE))) >= 1


def test_boxes_are_inside_the_image_and_ordered_by_area():
    image = Image.open(FIXTURE)
    boxes = detect_people(image)
    for x1, y1, x2, y2 in boxes:
        assert 0 <= x1 < x2 <= image.width
        assert 0 <= y1 < y2 <= image.height
    areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in boxes]
    assert areas == sorted(areas, reverse=True)
