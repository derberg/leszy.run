"""Capture frames at the finish gate into a queue directory.

Runs on the Raspberry Pi. See vision/INSTALL-RASPBERRY-PI.md.

Usage:
  python scripts/capture.py --queue /mnt/ssd/frames --seconds 300
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vision.capture import CameraStalled, ClockNotSynced, run_capture  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", required=True)
    ap.add_argument("--seconds", type=float, required=True)
    ap.add_argument("--exposure-us", type=int, default=1200)
    ap.add_argument("--gain", type=float, default=4.0,
                    help="starting analogue gain; adapts unless --manual-exposure")
    ap.add_argument("--manual-exposure", action="store_true",
                    help="hold --gain and --exposure-us fixed")
    ap.add_argument("--target-luminance", type=float, default=0.4)
    ap.add_argument("--max-exposure-us", type=int, default=3000,
                    help="longest shutter auto exposure may use")
    ap.add_argument("--fps", type=float, default=6.0,
                    help="frames a second; keep it below what the reader manages")
    ap.add_argument("--width", type=int, default=2304)
    ap.add_argument("--height", type=int, default=1296)
    ap.add_argument("--focus-m", type=float, default=3.0,
                    help="distance the lens is held at, in metres")
    ap.add_argument("--allow-unsynced-clock", action="store_true")
    ap.add_argument("--min-free-gb", type=float, default=1.0,
                    help="stop cleanly when the disk has less than this free")
    args = ap.parse_args()

    try:
        run_capture(
            args.queue, args.seconds,
            size=(args.width, args.height),
            exposure_us=args.exposure_us,
            gain=args.gain,
            allow_unsynced_clock=args.allow_unsynced_clock,
            min_free_bytes=int(args.min_free_gb * 1e9),
            fps=args.fps,
            focus_m=args.focus_m,
            auto_exposure=not args.manual_exposure,
            target_luminance=args.target_luminance,
            max_exposure_us=args.max_exposure_us,
        )
    except (ClockNotSynced, CameraStalled) as err:
        sys.exit(str(err))


if __name__ == "__main__":
    main()
