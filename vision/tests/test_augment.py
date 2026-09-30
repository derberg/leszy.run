from pathlib import Path

import numpy as np

from vision.synth.augment import augment, build_dataset
from vision.synth.render import render_bib


def _pixels(im):
    return np.asarray(im)


def test_augmentation_changes_the_image():
    base = render_bib(47, px_per_mm=2.0)
    assert not np.array_equal(_pixels(augment(base, seed=1)), _pixels(base))


def test_same_seed_gives_the_same_image():
    base = render_bib(47, px_per_mm=2.0)
    assert np.array_equal(_pixels(augment(base, seed=7)), _pixels(augment(base, seed=7)))


def test_different_seeds_give_different_images():
    base = render_bib(47, px_per_mm=2.0)
    assert not np.array_equal(_pixels(augment(base, seed=1)), _pixels(augment(base, seed=2)))


def test_build_dataset_writes_labelled_files(tmp_path: Path):
    written = build_dataset(tmp_path, numbers=range(1, 6), per_number=3, seed=0)
    assert written == 15
    files = sorted(p.name for p in tmp_path.glob("*.png"))
    assert len(files) == 15
    assert all(f.split("_")[0].isdigit() for f in files)
    assert {f.split("_")[0] for f in files} == {"1", "2", "3", "4", "5"}
