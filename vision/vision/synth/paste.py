"""Paste a rendered bib onto a real torso, the way a runner wears it.

The torso reader learns from crops of one race, about a hundred numbers. A
pasted bib shows it every number from 1 to 999 against real clothing and
real light, so it learns digits rather than which shirt went with which
number. Backgrounds are torsos of spectators, who wear no bib.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from vision.synth.render import render_bib
from vision.torso import INPUT_SIZE

_bibs = {}


def full_bib(number: int) -> Image.Image:
    """The olive block on its sheet of paper, with stand-ins for the print.

    At 30 pixels the white paper round the block is one of the clearest
    things about a bib, so it is drawn even though the lettering on it is
    only roughly imitated.
    """
    if number in _bibs:
        return _bibs[number]
    block = render_bib(number, px_per_mm=1.2)
    bw, bh = block.size
    pw, ph = int(bw * 1.10), int(bh * 1.75)
    paper = Image.new("RGB", (pw, ph), (236, 236, 232))
    draw = ImageDraw.Draw(paper)
    top = int(bh * 0.45)
    for i in range(7):
        x = int(pw * 0.2) + i * int(pw * 0.09)
        draw.rectangle([x, int(top * 0.3), x + int(pw * 0.05), int(top * 0.75)], fill=(30, 40, 30))
    draw.rectangle([int(pw * 0.3), top + bh + int(bh * 0.08),
                    int(pw * 0.7), top + bh + int(bh * 0.18)], fill=(60, 70, 60))
    paper.paste(block, ((pw - bw) // 2, top))
    _bibs[number] = paper
    return paper


def paste_bib(background: np.ndarray, number: int, rng) -> np.ndarray:
    """A torso crop (INPUT_SIZE square, uint8 RGB) wearing bib `number`.

    Scale, tilt, shade and blur are drawn from what the 2026-10-17 frames
    showed: a bib a fifth to two fifths of the torso wide, in sun or in the
    shade of the runner's own body.
    """
    size = INPUT_SIZE
    image = Image.fromarray(background).copy()
    bib = full_bib(number).convert("RGBA")
    w = int(size * rng.uniform(0.2, 0.42))
    h = int(w * bib.size[1] / bib.size[0] * rng.uniform(0.85, 1.15))
    bib = bib.resize((w, h), Image.BILINEAR)
    dx, dy = w * 0.12, h * 0.12
    quad = (rng.uniform(0, dx), rng.uniform(0, dy), rng.uniform(0, dx), h - rng.uniform(0, dy),
            w - rng.uniform(0, dx), h - rng.uniform(0, dy), w - rng.uniform(0, dx), rng.uniform(0, dy))
    bib = bib.transform((w, h), Image.QUAD, quad, resample=Image.BILINEAR)
    bib = bib.rotate(rng.uniform(-18, 18), expand=True, resample=Image.BILINEAR)
    rgb = ImageEnhance.Brightness(bib.convert("RGB")).enhance(rng.uniform(0.3, 1.1))
    rgb = ImageEnhance.Contrast(rgb).enhance(rng.uniform(0.6, 1.1))
    tinted = np.asarray(rgb).astype(np.float32) * rng.uniform(0.85, 1.15, size=3)
    rgb = Image.fromarray(np.clip(tinted, 0, 255).astype(np.uint8))
    bib = Image.merge("RGBA", (*rgb.split(), bib.split()[3]))
    cx, cy = int(size * rng.uniform(0.3, 0.7)), int(size * rng.uniform(0.35, 0.85))
    image.paste(bib, (cx - bib.size[0] // 2, cy - bib.size[1] // 2), bib)
    if rng.random() < 0.25:
        # An arm or a pole across the number.
        draw = ImageDraw.Draw(image)
        colour = tuple(int(v) for v in background[int(rng.uniform(0, size - 1)), int(rng.uniform(0, size - 1))])
        x = cx + int(rng.uniform(-w / 2, w / 2))
        draw.line([(x, 0), (x + int(rng.uniform(-30, 30)), size - 1)],
                  fill=colour, width=int(rng.uniform(3, 10)))
    image = image.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.3)))
    noisy = np.asarray(image).astype(np.float32) + rng.normal(0, rng.uniform(1, 8), (size, size, 3))
    return np.clip(noisy, 0, 255).astype(np.uint8)
