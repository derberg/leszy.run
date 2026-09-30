"""Link sightings across frames and vote on the number.

One runner approaching the camera produces thirty-odd frames. Linking them by
box overlap and voting means one blurred or half-covered frame gets outvoted
rather than believed. This is why the camera points down the lane: a sideways
view gives four frames, and four cannot outvote a bad one.

Overlapping runners stay apart because each sighting claims at most one track
per frame, and a track accepts at most one sighting per frame.
"""
from collections import defaultdict
from dataclasses import dataclass, field

IOU_MATCH = 0.3
MAX_GAP_FRAMES = 5


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_w = max(0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0, min(ay2, by2) - max(ay1, by1))
    intersection = inter_w * inter_h
    if intersection == 0:
        return 0.0
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - intersection
    return intersection / union


@dataclass
class TrackResult:
    text: str | None
    confidence: float
    frame_count: int
    best_frame_index: int
    votes: dict


@dataclass
class _Track:
    box: tuple
    last_frame: int
    frames: list = field(default_factory=list)
    votes: dict = field(default_factory=lambda: defaultdict(float))
    best_confidence: float = 0.0
    best_frame_index: int = -1


class Tracker:
    def __init__(self):
        self._tracks = []

    def add(self, frame_index: int, sightings: list) -> None:
        live = [t for t in self._tracks
                if frame_index - t.last_frame <= MAX_GAP_FRAMES]
        claimed = set()

        for sight in sightings:
            match, best_overlap = None, IOU_MATCH
            for track in live:
                if id(track) in claimed:
                    continue
                overlap = iou(track.box, sight.person_box)
                if overlap > best_overlap:
                    match, best_overlap = track, overlap

            if match is None:
                match = _Track(box=sight.person_box, last_frame=frame_index)
                self._tracks.append(match)

            claimed.add(id(match))
            match.box = sight.person_box
            match.last_frame = frame_index
            match.frames.append(frame_index)
            if sight.text is not None:
                match.votes[sight.text] += sight.confidence
            if sight.confidence > match.best_confidence:
                match.best_confidence = sight.confidence
                match.best_frame_index = frame_index

    def results(self) -> list:
        out = []
        for track in self._tracks:
            if track.votes:
                text = max(track.votes, key=track.votes.get)
                total = sum(track.votes.values())
                confidence = track.votes[text] / total if total else 0.0
            else:
                # An unreadable track keeps its row. Somebody crossed.
                text, confidence = None, 0.0
            out.append(TrackResult(
                text=text,
                confidence=confidence,
                frame_count=len(track.frames),
                best_frame_index=track.best_frame_index,
                votes=dict(track.votes),
            ))
        return out
