"""Run the pipeline over a directory of frames and report the read rate.

This is the phase 0 gate. It writes nothing and changes nothing.

The frames directory holds files named so that sorting them sorts by time,
which is what the capture queue already produces. truth.txt holds one bib
number per line: the numbers people were actually wearing.

Usage:
  python scripts/measure_read_rate.py --frames shoot/ --truth shoot/truth.txt
"""
import argparse
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vision.measure import score  # noqa: E402
from vision.pipeline import read_frame  # noqa: E402
from vision.track import Tracker  # noqa: E402

FRAME_SUFFIXES = {".jpg", ".jpeg", ".png"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", required=True)
    ap.add_argument("--truth", required=True)
    args = ap.parse_args()

    frames = sorted(
        p for p in Path(args.frames).iterdir() if p.suffix.lower() in FRAME_SUFFIXES
    )
    if not frames:
        sys.exit(f"no frames found in {args.frames}")

    expected = [
        line.strip() for line in Path(args.truth).read_text().splitlines()
        if line.strip()
    ]

    tracker = Tracker()
    for index, path in enumerate(frames):
        tracker.add(index, read_frame(Image.open(path)))
        if (index + 1) % 25 == 0:
            print(f"  {index + 1}/{len(frames)} frames", file=sys.stderr)

    results = tracker.results()
    got = [r.text for r in results if r.text is not None]
    unreadable = sum(1 for r in results if r.text is None)

    print(f"\nframes {len(frames)}, tracks {len(results)}, unreadable tracks {unreadable}\n")
    print(score(expected, got).summary())
    print(
        "\nJudge the wrong rate first. A missed runner leaves a gap a person "
        "fills.\nA wrong number gives somebody else's time to a runner and "
        "nobody notices."
    )


if __name__ == "__main__":
    main()
