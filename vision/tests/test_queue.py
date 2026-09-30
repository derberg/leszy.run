from PIL import Image

from vision.queue import FrameQueue


def frame():
    return Image.new("RGB", (64, 48), (10, 20, 30))


def test_written_frames_come_back_in_timestamp_order(tmp_path):
    queue = FrameQueue(tmp_path)
    queue.write(frame(), 300)
    queue.write(frame(), 100)
    queue.write(frame(), 200)
    assert [queue.timestamp_of(p) for p in queue.pending()] == [100, 200, 300]


def test_marking_done_removes_it_from_pending(tmp_path):
    queue = FrameQueue(tmp_path)
    queue.mark_done(queue.write(frame(), 100))
    assert queue.pending() == []


def test_a_partially_written_file_is_skipped_not_fatal(tmp_path):
    # Capture died mid-write. The reader must survive this.
    queue = FrameQueue(tmp_path)
    queue.write(frame(), 100)
    (tmp_path / "000000000000000200.jpg.part").write_bytes(b"\xff\xd8partial")
    assert len(queue.pending()) == 1


def test_writes_are_atomic(tmp_path):
    queue = FrameQueue(tmp_path)
    written = queue.write(frame(), 100)
    assert written.suffix == ".jpg"
    assert list(tmp_path.glob("*.part")) == []
