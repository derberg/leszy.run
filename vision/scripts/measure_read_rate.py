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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vision.clock import check_ordering  # noqa: E402
from vision.measure import load_frame, per_track_rows, score  # noqa: E402
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

    # Frames named by sensor timestamp: if the clock stepped backwards the
    # sorted order above is meaningless across the step, so say so.
    stamps = []
    for path in frames:
        try:
            stamps.append(int(path.stem))
        except ValueError:
            stamps = []
            break
    if stamps:
        anomalies = check_ordering(stamps)
        if anomalies:
            print(f"WARNING: sensor clock stepped backwards at frame indices "
                  f"{anomalies}. Frames either side of a step cannot be "
                  f"ordered against each other.\n")

    tracker = Tracker()
    unreadable_files = 0
    for index, path in enumerate(frames):
        image = load_frame(path)
        if image is None:
            unreadable_files += 1
            continue
        tracker.add(index, read_frame(image))
        if (index + 1) % 25 == 0:
            print(f"  {index + 1}/{len(frames)} frames", file=sys.stderr)

    results = tracker.results()
    got = [r.text for r in results if r.text is not None]
    unreadable = sum(1 for r in results if r.text is None)

    print(f"\nframes {len(frames)}, unreadable files {unreadable_files}, "
          f"tracks {len(results)}, unreadable tracks {unreadable}\n")
    print(score(expected, got).summary())

    print("\nper track (this is where the confidence floor comes from):")
    print(f"  {'number':>8}  {'conf':>6}  {'frames':>6}  verdict")
    for row in sorted(per_track_rows(results, expected),
                      key=lambda r: r.confidence, reverse=True):
        label = row.text if row.text is not None else "-"
        print(f"  {label:>8}  {row.confidence:6.3f}  {row.frame_count:6d}  {row.verdict}")

    print(
        "\nJudge the wrong rate first. A missed runner leaves a gap a person "
        "fills.\nA wrong number gives somebody else's time to a runner and "
        "nobody notices."
    )


if __name__ == "__main__":
    main()
