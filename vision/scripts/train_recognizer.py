"""Train the digit recognizer on synthetic bibs and export it to ONNX.

Training data is generated, never photographed. Real photographs are the exam
in phase 0, and a model trained on the exam tells you nothing about how it
will do on a race it has not seen.

Labels come from the filename, and a sample is kept only when segmentation
returns exactly as many digits as the number has. A bib whose segmentation
disagrees with its label would teach the model the wrong digit.

Usage:
  python scripts/train_recognizer.py --numbers 1-999 --per-number 12
"""
import argparse
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vision.recognize import DIGIT_SIZE, segment_digits  # noqa: E402
from vision.synth.augment import build_dataset  # noqa: E402

MODEL_OUT = Path(__file__).resolve().parents[1] / "models" / "digits.onnx"


class DigitNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.body = nn.Sequential(
            nn.Conv2d(1, 16, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
            nn.Conv2d(16, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        )
        self.head = nn.Sequential(
            nn.Flatten(), nn.Linear(64 * 6 * 4, 128), nn.ReLU(), nn.Linear(128, 10)
        )

    def forward(self, x):
        return self.head(self.body(x))


def extract_samples(bib_dir: Path):
    xs, ys, kept, dropped = [], [], 0, 0
    for path in sorted(bib_dir.glob("*.png")):
        label = path.name.split("_")[0]
        digits = segment_digits(Image.open(path))
        if len(digits) != len(label):
            dropped += 1
            continue
        kept += 1
        for crop, char in zip(digits, label):
            xs.append(np.asarray(crop.convert("L"), dtype=np.float32) / 255.0)
            ys.append(int(char))
    return np.stack(xs)[:, None], np.array(ys), kept, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--numbers", default="1-999")
    ap.add_argument("--per-number", type=int, default=12)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    lo, hi = (int(v) for v in args.numbers.split("-"))
    work = Path(tempfile.mkdtemp(prefix="bibtrain-"))
    try:
        print(f"rendering {(hi - lo + 1) * args.per_number} bibs ...")
        build_dataset(work, range(lo, hi + 1), args.per_number, args.seed)
        print("segmenting ...")
        x, y, kept, dropped = extract_samples(work)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"bibs kept {kept}, dropped {dropped} (segmentation disagreed with label)")
    print(f"digit samples {len(y)}, class counts {np.bincount(y, minlength=10).tolist()}")

    rng = np.random.default_rng(args.seed)
    order = rng.permutation(len(y))
    x, y = x[order], y[order]
    split = int(len(y) * 0.9)
    xtr, ytr, xte, yte = x[:split], y[:split], x[split:], y[split:]

    torch.manual_seed(args.seed)
    model = DigitNet()
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.CrossEntropyLoss()
    xtr_t, ytr_t = torch.from_numpy(xtr), torch.from_numpy(ytr).long()

    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(len(ytr_t))
        total = 0.0
        for i in range(0, len(perm), 256):
            idx = perm[i:i + 256]
            opt.zero_grad()
            loss = loss_fn(model(xtr_t[idx]), ytr_t[idx])
            loss.backward()
            opt.step()
            total += float(loss) * len(idx)
        model.eval()
        with torch.no_grad():
            pred = model(torch.from_numpy(xte)).argmax(1).numpy()
        acc = float((pred == yte).mean())
        print(f"epoch {epoch + 1}/{args.epochs}  loss {total / len(ytr_t):.4f}  held-out digit accuracy {acc:.4f}")

    MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, 1, DIGIT_SIZE[1], DIGIT_SIZE[0])
    torch.onnx.export(
        model, (dummy,), str(MODEL_OUT),
        input_names=["digits"], output_names=["logits"],
        dynamic_axes={"digits": {0: "n"}, "logits": {0: "n"}},
        opset_version=17,
    )
    print(f"wrote {MODEL_OUT}")


if __name__ == "__main__":
    main()
