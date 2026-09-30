"""Score a pipeline run against the bib numbers people were actually wearing.

Three outcomes are counted separately because they cost different things.

A missed runner leaves a gap that a person can fill from the photographs. A
wrong number puts somebody else's time on a runner and nobody notices, which
is the failure that should decide whether this system ships. A spurious
number invents a runner who was never there.
"""
from collections import Counter
from dataclasses import dataclass


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


def _looks_like_a_misread_of(candidate: str, target: str) -> bool:
    """One substituted digit, same length. 41 for 47, not 999 for 1."""
    return (len(candidate) == len(target)
            and sum(a != b for a, b in zip(candidate, target)) == 1)


def score(expected: list, got: list) -> Report:
    expected_counts, got_counts = Counter(expected), Counter(got)
    correct = sum((expected_counts & got_counts).values())
    missed = sorted((expected_counts - got_counts).elements())
    extra = sorted((got_counts - expected_counts).elements())

    # An extra number that reads like a corruption of a missed one is a wrong
    # read. Anything else is spurious, invented from nothing.
    unmatched = list(missed)
    wrong, spurious = [], []
    for candidate in extra:
        near = next(
            (m for m in unmatched if _looks_like_a_misread_of(candidate, m)), None
        )
        if near is not None:
            unmatched.remove(near)
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
