"""Distort a rendered bib the way a finish line distorts a real one.

Each transform stands for something physical. Perspective is an off-angle
approach, the quad warp is fabric pinned at four corners, blur is motion,
brightness is the light at the gate, noise is sensor gain on a dull morning,
and the rectangle is an arm crossing the number.

Every transform is driven by one seeded generator, so a seed reproduces an
image exactly. That is what lets a training run be repeated.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from vision.synth.render import render_bib

OCCLUSION_CHANCE = 0.3


def augment(im: Image.Image, seed: int) -> Image.Image:
    rng = np.random.default_rng(seed)
    w, h = im.size

    dx, dy = w * 0.12, h * 0.12
    quad = (
        rng.uniform(0, dx), rng.uniform(0, dy),
        rng.uniform(0, dx), h - rng.uniform(0, dy),
        w - rng.uniform(0, dx), h - rng.uniform(0, dy),
        w - rng.uniform(0, dx), rng.uniform(0, dy),
    )
    im = im.transform((w, h), Image.QUAD, quad, resample=Image.BILINEAR)

    im = im.filter(ImageFilter.GaussianBlur(float(rng.uniform(0.3, 2.2))))
    im = ImageEnhance.Brightness(im).enhance(float(rng.uniform(0.45, 1.25)))
    im = ImageEnhance.Contrast(im).enhance(float(rng.uniform(0.7, 1.15)))

    arr = np.asarray(im).astype(np.int16)
    noise = rng.normal(0.0, float(rng.uniform(2, 14)), size=arr.shape)
    im = Image.fromarray(np.clip(arr + noise, 0, 255).astype(np.uint8))

    if rng.random() < OCCLUSION_CHANCE:
        draw = ImageDraw.Draw(im)
        ox = float(rng.uniform(0, w * 0.7))
        oy = float(rng.uniform(0, h * 0.7))
        draw.rectangle(
            [ox, oy,
             ox + w * float(rng.uniform(0.08, 0.22)),
             oy + h * float(rng.uniform(0.2, 0.6))],
            fill=(40, 40, 45),
        )
    return im


def build_dataset(out_dir, numbers, per_number: int, seed: int) -> int:
    """Write augmented bibs named <number>_<index>.png. Returns the count."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for number in numbers:
        base = render_bib(number, px_per_mm=2.0)
        for index in range(per_number):
            variant = augment(base, seed=seed + number * 1000 + index)
            variant.save(out_dir / f"{number}_{index}.png")
            written += 1
    return written
