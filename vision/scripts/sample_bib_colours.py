"""Print the block colour and digit colour sampled from a bib PDF page.

The recognizer trains on rendered bibs, so these two colours decide how close
every training image is to what the camera will actually see. Guessing them
from a screenshot is not good enough.

Usage:
  python scripts/sample_bib_colours.py /path/to/leszy_bibs_light.pdf
"""
import os
import subprocess
import sys
import tempfile
from PIL import Image


def luma(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def dominant_colours(png_path):
    im = Image.open(png_path).convert("RGB")
    w, h = im.size
    # The first number block sits in the upper third, inset from the edges.
    crop = im.crop((int(w * 0.15), int(h * 0.15), int(w * 0.85), int(h * 0.38)))
    # getcolors rather than getdata: same counts, and getdata is deprecated.
    counts = crop.getcolors(maxcolors=crop.width * crop.height)
    ranked = sorted(counts, reverse=True)[:50]
    block = ranked[0][1]
    digit = max((c for _, c in ranked), key=luma)
    return block, digit


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: sample_bib_colours.py <bibs.pdf>")
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(
            ["pdftoppm", "-r", "150", "-f", "1", "-l", "1", "-png",
             sys.argv[1], os.path.join(d, "page")],
            check=True,
        )
        png = next(os.path.join(d, f) for f in os.listdir(d) if f.endswith(".png"))
        block, digit = dominant_colours(png)
    print(f"block_rgb={block}")
    print(f"digit_rgb={digit}")


if __name__ == "__main__":
    main()
