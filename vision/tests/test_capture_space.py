from collections import namedtuple

import vision.capture as capture

Usage = namedtuple("Usage", "total used free")


def test_room_while_free_space_is_above_the_margin(tmp_path, monkeypatch):
    monkeypatch.setattr(capture.shutil, "disk_usage",
                        lambda _: Usage(100, 10, 6_000_000_000))
    assert capture.has_room(tmp_path, 5_000_000_000)


def test_no_room_once_free_space_drops_below_the_margin(tmp_path, monkeypatch):
    # A boot service with no limit fills the SD card the database lives on.
    monkeypatch.setattr(capture.shutil, "disk_usage",
                        lambda _: Usage(100, 96, 4_000_000_000))
    assert not capture.has_room(tmp_path, 5_000_000_000)
