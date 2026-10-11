"""Score a pipeline run against the bib numbers people were actually wearing.

Three outcomes are counted separately because they cost different things.

A missed runner leaves a gap that a person can fill from the photographs. A
wrong number puts somebody else's time on a runner and nobody notices, which
is the failure that should decide whether this system ships. A spurious
number invents a runner who was never there.
"""
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


@dataclass
class Report:
    read_rate: float
    wrong_rate: float
    missed: list
    wrong: list
    spurious: list
    expected_count: int
    got_count: int

    def summary(self) -> str:
        return (
            f"read rate   {self.read_rate:6.1%}  ({self.expected_count - len(self.missed)}"
            f"/{self.expected_count})\n"
            f"wrong rate  {self.wrong_rate:6.1%}  {self.wrong}\n"
            f"missed            {self.missed}\n"
            f"spurious          {self.spurious}"
        )


def edit_distance(a: str, b: str) -> int:
    """Levenshtein distance, so an inserted or dropped digit counts too."""
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(
                previous[j] + 1,            # delete
                current[j - 1] + 1,         # insert
                previous[j - 1] + (ca != cb),  # substitute
            ))
        previous = current
    return previous[-1]


def score(expected: list, got: list) -> Report:
    expected_counts, got_counts = Counter(expected), Counter(got)
    correct = sum((expected_counts & got_counts).values())
    missed = sorted((expected_counts - got_counts).elements())
    extra = sorted((got_counts - expected_counts).elements())

    # Any extra number that an absent runner could account for is a WRONG
    # read: somebody was not read, and a number came out that was not theirs.
    # Only an extra with no absent runner left to explain it is spurious.
    #
    # The earlier rule required the same length and exactly one differing
    # digit. That filed every length-changing misread as spurious, so the one
    # number this whole phase exists to produce could not see the failures the
    # pipeline actually makes: a bright strap turning 47 into 147, or a runner
    # handed the neighbour's bib. A staged shoot would have reported a wrong
    # rate of zero while both were happening.
    unmatched = list(missed)
    wrong, spurious = [], []
    for candidate in extra:
        if unmatched:
            nearest = min(unmatched, key=lambda m: edit_distance(candidate, m))
            unmatched.remove(nearest)
            wrong.append(candidate)
        else:
            spurious.append(candidate)

    denominator = len(expected) or 1
    return Report(
        read_rate=correct / denominator,
        wrong_rate=len(wrong) / denominator,
        missed=missed,
        wrong=wrong,
        spurious=spurious,
        expected_count=len(expected),
        got_count=len(got),
    )


def load_frame(path):
    """Open a frame, or return None when it cannot be read.

    Writes are atomic against a killed process, but never fsynced, so a power
    cut at the gate can land the rename before the data. Pillow opens lazily,
    so a torn file raises later, deep inside the pipeline. One bad frame out
    of two thousand must not lose the whole measurement.
    """
    try:
        image = Image.open(Path(path))
        image.load()
        return image
    except Exception:
        return None


@dataclass
class TrackRow:
    text: str
    confidence: float
    frame_count: int
    verdict: str


def per_track_rows(tracks, expected: list) -> list:
    """One row per track, with whether its number was worn by anybody.

    The spec asks the staged shoot to produce the confidence floor. Aggregate
    rates cannot yield it: the floor is the confidence above which incorrect
    reads stop appearing, and that is only visible per track.

    A verdict of "wrong" here means the number was not among the expected
    ones. That covers both of the aggregate report's wrong and spurious
    classes, because for choosing a floor the distinction does not matter:
    both are numbers that should not have been emitted.
    """
    remaining = Counter(expected)
    rows = []
    for track in tracks:
        if track.text is None:
            verdict = "unreadable"
        elif remaining[track.text] > 0:
            remaining[track.text] -= 1
            verdict = "correct"
        else:
            verdict = "wrong"
        rows.append(TrackRow(
            text=track.text,
            confidence=track.confidence,
            frame_count=track.frame_count,
            verdict=verdict,
        ))
    return rows
