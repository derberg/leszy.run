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
# A number must be read in this many frames of the pass to be reported. A
# fragment of the block read as 2 once in 163 frames came out at a vote share
# of 1.00, because it was the only vote. One frame is noise.
MIN_AGREEING_FRAMES = 2
# Frames where digits were found but the recognizer refused them count
# against the winner. A leafy patch of a runner's top read as 24 in two
# frames and was refused in about twenty: with only accepted reads voting it
# came out at a share of 1.00. The winner must hold this share of every
# frame where digits were found, accepted or refused.
MIN_READ_SHARE = 0.25
# One read may stand on its own, but only when nothing in the pass argues
# with it: a certain read, no other number, no refusal, and a pass short
# enough to be a runner crossing rather than someone standing at the gate,
# where fragments get read. A quick crossing gave ten frames and only one
# held the bib close enough to read, 7 at 1.00.
SINGLE_READ_CONFIDENCE = 0.99
SINGLE_READ_MAX_FRAMES = 20


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
    # Which box the winning read came from, so the screen can show the crop
    # that produced the number rather than guessing among several people.
    best_bib_box: tuple | None = None
    # Every frame the runner was seen in, so the audit screen can step
    # through the whole pass rather than one photograph of it.
    frame_indices: list = field(default_factory=list)


@dataclass
class _Track:
    box: tuple
    last_frame: int
    frames: list = field(default_factory=list)
    votes: dict = field(default_factory=lambda: defaultdict(float))
    read_frames: dict = field(default_factory=lambda: defaultdict(int))
    best_confidence: float = 0.0
    best_frame_index: int = -1
    best_bib_box: tuple | None = None
    reads: list = field(default_factory=list)   # (frame, text, confidence, bib box)
    refused: list = field(default_factory=list)  # frames whose digits the recognizer refused


def _split_numbers(track) -> list:
    """The numbers in one track that belong to different passes.

    Box overlap cannot tell two runners apart when one follows the other
    through the same spot without a gap: bib 33 then bib 55 shown on one
    body made one track, and the vote reported 55 and lost 33. A second
    number is a separate pass when it is read in enough frames of its own,
    all of them before or all after the first number's, and it is not a
    piece of the first. Interleaved misreads, and the "0" left when a 20 is
    cut by the frame edge, stay votes inside the one pass.
    """
    counts = {t: n for t, n in track.read_frames.items() if n >= MIN_AGREEING_FRAMES}
    if len(counts) < 2:
        return []
    spans = {t: (min(f for f, x, *_ in track.reads if x == t),
                 max(f for f, x, *_ in track.reads if x == t)) for t in counts}
    order = sorted(counts, key=lambda t: track.votes[t], reverse=True)
    kept = [order[0]]
    for text in order[1:]:
        lo, hi = spans[text]
        if all((hi < spans[k][0] or lo > spans[k][1]) and text not in k and k not in text
               for k in kept):
            kept.append(text)
    return sorted(kept, key=lambda t: spans[t][0]) if len(kept) > 1 else []


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
                match.read_frames[sight.text] += 1
                match.reads.append((frame_index, sight.text, sight.confidence, sight.bib_box))
            elif sight.confidence > 0:
                match.refused.append(frame_index)
            if sight.confidence > match.best_confidence:
                match.best_confidence = sight.confidence
                match.best_frame_index = frame_index
                match.best_bib_box = sight.bib_box

    @staticmethod
    def _stands(track, text) -> bool:
        agreeing = track.read_frames[text]
        attempts = sum(track.read_frames.values()) + len(track.refused)
        if agreeing / attempts < MIN_READ_SHARE:
            return False
        if agreeing >= MIN_AGREEING_FRAMES:
            return True
        return (attempts == 1
                and len(track.frames) <= SINGLE_READ_MAX_FRAMES
                and track.votes[text] >= SINGLE_READ_CONFIDENCE)

    @classmethod
    def _result(cls, track) -> TrackResult:
        text = max(track.votes, key=track.votes.get) if track.votes else None
        if text is not None and cls._stands(track, text):
            total = sum(track.votes.values())
            confidence = track.votes[text] / total if total else 0.0
        else:
            # An unreadable track keeps its row. Somebody crossed.
            text, confidence = None, 0.0
        return TrackResult(
            text=text,
            confidence=confidence,
            frame_count=len(track.frames),
            best_frame_index=track.best_frame_index,
            votes=dict(track.votes),
            best_bib_box=track.best_bib_box,
            frame_indices=list(track.frames),
        )

    @classmethod
    def _results(cls, track) -> list:
        """One result per pass in the track, usually exactly one."""
        numbers = _split_numbers(track)
        if not numbers:
            return [cls._result(track)]
        # Each pass owns the frames up to the midpoint between its reads and
        # the next pass's, so every frame of the track lands in one pass.
        firsts = [min(f for f, t, *_ in track.reads if t == n) for n in numbers]
        lasts = [max(f for f, t, *_ in track.reads if t == n) for n in numbers]
        cuts = [(lasts[i] + firsts[i + 1]) / 2 for i in range(len(numbers) - 1)]
        out = []
        for i, number in enumerate(numbers):
            lo = cuts[i - 1] if i else float("-inf")
            hi = cuts[i] if i < len(cuts) else float("inf")
            part = _Track(box=track.box, last_frame=track.last_frame)
            part.frames = [f for f in track.frames if lo < f <= hi]
            part.refused = [f for f in track.refused if lo < f <= hi]
            for frame, text, confidence, bib_box in track.reads:
                if not lo < frame <= hi:
                    continue
                part.votes[text] += confidence
                part.read_frames[text] += 1
                if confidence > part.best_confidence:
                    part.best_confidence = confidence
                    part.best_frame_index = frame
                    part.best_bib_box = bib_box
            out.append(cls._result(part))
        return out

    def results(self) -> list:
        return [r for t in self._tracks for r in self._results(t)]

    def pop_closed(self, frame_index: int) -> list:
        """Tracks that can no longer change, removed as they are returned.

        The audit screen shows runners while the race is still running, so a
        track has to be emitted the moment nothing more can join it rather
        than at the end of the session. The cut is the same MAX_GAP_FRAMES
        that add() uses to decide what is still live, so a track is never
        emitted while a later frame could still extend it.

        Removing them is what stops one runner appearing on the screen as
        two crossings, and it also keeps the tracker from growing for the
        whole race.
        """
        closed, live = [], []
        for track in self._tracks:
            (closed if frame_index - track.last_frame > MAX_GAP_FRAMES
             else live).append(track)
        self._tracks = live
        return [r for t in closed for r in self._results(t)]

    def flush(self) -> list:
        """Everything still open, emptied.

        The last runner of the day has nobody following them, so their track
        never ages out. Without this they would be lost at shutdown.
        """
        out = [r for t in self._tracks for r in self._results(t)]
        self._tracks = []
        return out
