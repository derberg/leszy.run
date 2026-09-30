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


def test_a_backwards_clock_jump_is_reported(tmp_path):
    # The requirement is that ordering stays stable AND the anomaly is
    # reported, not silently sorted away. pending() sorts, so without this
    # the frames on either side of the step look fine and nothing says
    # their order across it is meaningless.
    queue = FrameQueue(tmp_path)
    for ts in (100, 200, 150, 400):
        queue.write(frame(), ts)
    assert queue.ordering_anomalies() == [150]


def test_no_anomaly_when_the_clock_only_moved_forwards(tmp_path):
    queue = FrameQueue(tmp_path)
    for ts in (100, 200, 300):
        queue.write(frame(), ts)
    assert queue.ordering_anomalies() == []


def test_the_session_offset_survives_the_process(tmp_path):
    # The monotonic-to-UTC offset was printed and then lost, so frames could
    # never be tied back to a gun time once capture exited.
    queue = FrameQueue(tmp_path)
    queue.write_session(offset=1_700_000_000.5)
    assert FrameQueue(tmp_path).session_offset() == 1_700_000_000.5


def test_session_offset_is_none_when_never_written(tmp_path):
    assert FrameQueue(tmp_path).session_offset() is None
