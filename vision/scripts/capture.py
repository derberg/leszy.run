"""Capture frames at the finish gate into a queue directory.

Runs on the Raspberry Pi. See vision/INSTALL-RASPBERRY-PI.md.

Usage:
  python scripts/capture.py --queue /mnt/ssd/frames --seconds 300
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vision.capture import ClockNotSynced, run_capture  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", required=True)
    ap.add_argument("--seconds", type=float, required=True)
    ap.add_argument("--exposure-us", type=int, default=1200)
    ap.add_argument("--gain", type=float, default=4.0,
                    help="analogue gain; there is no automatic adaptation")
    ap.add_argument("--width", type=int, default=1640)
    ap.add_argument("--height", type=int, default=1232)
    ap.add_argument("--allow-unsynced-clock", action="store_true")
    args = ap.parse_args()

    try:
        run_capture(
            args.queue, args.seconds,
            size=(args.width, args.height),
            exposure_us=args.exposure_us,
            gain=args.gain,
            allow_unsynced_clock=args.allow_unsynced_clock,
        )
    except ClockNotSynced as err:
        sys.exit(str(err))


if __name__ == "__main__":
    main()
