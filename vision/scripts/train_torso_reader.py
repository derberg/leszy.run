"""Train the torso reader and export it to ONNX.

This one trains on photographs from a real race, unlike the digit
recognizer. Synthetic bibs alone could not teach it what a 30-pixel bib looks
like on a moving runner in shade, and the race photographs could. To keep a
measurement that means something, runners are split by bib number: a share
of them never reaches training, and the read rate, the wrong rate and the
false reads on spectators are all measured on them.

Inputs, all kept next to the frames and never committed, because they are
photographs of people and the numbers they wore:
  --labels       CSV frame,x1,y1,x2,y2,bib,track  (a person box per frame, the
                 bib read by eye and checked against the chip roster)
  --backgrounds  CSV frame,x1,y1,x2,y2  (spectators: people at least 10 s away
                 from any chip finish)

Usage:
  python scripts/train_torso_reader.py --frames <done dir> \\
      --labels <dir>/labels.csv --backgrounds <dir>/backgrounds.csv
"""
import argparse
import collections
import csv
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vision.synth.paste import paste_bib  # noqa: E402
from vision.torso import BLANK, MIN_CONFIDENCE, MODEL_PATH, torso_crop  # noqa: E402


def encode(number: str) -> list:
    out = [BLANK] * 3
    for i, ch in enumerate(reversed(number[-3:])):
        out[2 - i] = int(ch)
    return out


def decode(labels) -> str:
    return "".join(str(int(d)) for d in labels if d != BLANK)


class TorsoNet(nn.Module):
    def __init__(self):
        super().__init__()

        def block(i, o):
            return nn.Sequential(
                nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(),
                nn.Conv2d(o, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(),
                nn.MaxPool2d(2))

        self.body = nn.Sequential(block(3, 24), block(24, 48), block(48, 96),
                                  block(96, 128), nn.AdaptiveMaxPool2d((2, 2)))
        self.head = nn.Sequential(nn.Flatten(), nn.Dropout(0.3), nn.Linear(512, 256),
                                  nn.ReLU(), nn.Linear(256, 33))

    def forward(self, x):
        return self.head(self.body(x)).view(-1, 3, 11)


def load_crops(frames: Path, rows):
    cache, out = {}, []
    for row in rows:
        name = row["frame"]
        if name not in cache:
            cache.clear()
            cache[name] = Image.open(frames / name).convert("RGB")
        box = [int(row[k]) for k in ("x1", "y1", "x2", "y2")]
        out.append(np.asarray(torso_crop(cache[name], box)))
    return np.stack(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=Path, required=True)
    ap.add_argument("--labels", type=Path, required=True)
    ap.add_argument("--backgrounds", type=Path, required=True)
    ap.add_argument("--holdout", type=float, default=0.3)
    ap.add_argument("--synthetic", type=int, default=40000)
    ap.add_argument("--steps", type=int, default=15000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--all", action="store_true",
                    help="train on every runner after measuring, for the model that ships")
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    torch.manual_seed(args.seed)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"

    labels = list(csv.DictReader(open(args.labels)))
    bibs = sorted({r["bib"] for r in labels})
    order = np.random.default_rng(7).permutation(len(bibs))
    held = {bibs[i] for i in order[:int(len(bibs) * args.holdout)]}
    if args.all:
        held = set()
    print(f"loading {len(labels)} labelled crops, {len(bibs)} runners, {len(held)} held out")
    real = load_crops(args.frames, labels)
    real_bib = np.array([r["bib"] for r in labels])
    real_track = np.array([r["track"] for r in labels])
    test = np.isin(real_bib, list(held))

    backs = list(csv.DictReader(open(args.backgrounds)))
    background = load_crops(args.frames, backs)
    split = int(len(background) * 0.9)
    bg_train, bg_test = background[:split], background[split:]

    print(f"pasting {args.synthetic} synthetic bibs ...")
    synth_x, synth_y = [], []
    for _ in range(args.synthetic):
        number = int(rng.integers(1, 1000)) if rng.random() < 0.3 else int(rng.integers(1, 260))
        synth_x.append(paste_bib(bg_train[rng.integers(len(bg_train))], number, rng))
        synth_y.append(encode(str(number)))

    def tensor(x):
        return torch.tensor(np.asarray(x)).permute(0, 3, 1, 2).contiguous().to(dev)

    sources = [
        (tensor(real[~test]), torch.tensor([encode(b) for b in real_bib[~test]]).to(dev), 0.35),
        (tensor(synth_x), torch.tensor(synth_y).to(dev), 0.50),
        (tensor(bg_train), torch.full((len(bg_train), 3), BLANK).to(dev), 0.15),
    ]

    def batch(n=128):
        xs, ys = [], []
        for x, y, share in sources:
            pick = torch.randint(len(x), (int(n * share),), device=dev)
            xs.append(x[pick])
            ys.append(y[pick])
        x = torch.cat(xs).float() / 255.0
        k = x.shape[0]
        x = x * torch.empty(k, 1, 1, 1, device=dev).uniform_(0.6, 1.3)
        x = x + torch.empty(k, 1, 1, 1, device=dev).uniform_(-0.08, 0.08)
        x = x * torch.empty(k, 3, 1, 1, device=dev).uniform_(0.9, 1.1)
        sx, sy = (int(v) for v in rng.integers(-8, 9, 2))
        return torch.roll(x.clamp(0, 1), (sy, sx), (2, 3)), torch.cat(ys)

    net = TorsoNet().to(dev)
    opt = torch.optim.AdamW(net.parameters(), 1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 3e-3, total_steps=args.steps)
    loss_fn = nn.CrossEntropyLoss()

    def predict(x):
        net.eval()
        out = []
        with torch.no_grad():
            for i in range(0, len(x), 256):
                chunk = torch.tensor(x[i:i + 256]).permute(0, 3, 1, 2).float().to(dev) / 255.0
                out.append(torch.softmax(net(chunk), -1).cpu().numpy())
        net.train()
        return np.concatenate(out)

    def measure():
        """Per pass on held-out runners: right, wrong, unread. Plus spectators."""
        result = collections.Counter()
        if test.any():
            probs = predict(real[test])
            text = [decode(p.argmax(-1)) for p in probs]
            sure = probs.max(-1).min(-1) >= MIN_CONFIDENCE
            for track in sorted(set(real_track[test])):
                idx = np.flatnonzero(real_track[test] == track)
                truth = real_bib[test][idx[0]]
                votes = collections.Counter(text[i] for i in idx if sure[i] and text[i])
                if not votes or votes.most_common(1)[0][1] < 2:
                    result["unread"] += 1
                else:
                    result["right" if votes.most_common(1)[0][0] == truth else "wrong"] += 1
        probs = predict(bg_test)
        false = np.mean([bool(decode(p.argmax(-1))) and p.max(-1).min() >= MIN_CONFIDENCE
                         for p in probs])
        return dict(result), float(false)

    for step in range(args.steps):
        x, y = batch()
        loss = loss_fn(net(x).reshape(-1, 11), y.reshape(-1))
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if (step + 1) % 1000 == 0:
            passes, false = measure()
            print(f"step {step + 1}  loss {loss.item():.3f}  held-out passes {passes}  "
                  f"spectators read as a number {false:.2%}", flush=True)

    net.eval().cpu()
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        net, (torch.zeros(1, 3, 128, 128),), str(MODEL_PATH),
        input_names=["torso"], output_names=["logits"],
        dynamic_axes={"torso": {0: "n"}, "logits": {0: "n"}},
        opset_version=17, dynamo=False,
    )
    print(f"wrote {MODEL_PATH}")


if __name__ == "__main__":
    main()
