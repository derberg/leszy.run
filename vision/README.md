# vision

Reads leszy.run bib numbers from photographs taken at the finish gate. This is
phase 0: the goal is a measured read rate, not a running system. See
`docs/superpowers/specs/2026-09-30-vision-bib-recognition-design.md`.

## What this package never does

It never opens a network connection, never talks to a database, and never
uploads a photograph anywhere. Frames stay on the machine that captured them.
That property is what makes the data protection position defensible, so keep it.

## Running the tests

```bash
cd vision
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python scripts/fetch_models.py
.venv/bin/python -m pytest
```

Add the `train` extra (`".[dev,train]"`) only if you intend to retrain the
recognizer. It pulls in PyTorch, which the Pi never needs.

Python 3.12 rather than the system default, because mediapipe publishes no
wheels for 3.14 yet.

## Models

`models/digits.onnx` (with its `.data` sidecar) IS committed, so the tests and
the phase 0 measurement are reproducible against the exact weights that
produced the number. Regenerate it with `scripts/train_recognizer.py`.

`models/efficientdet_lite0.tflite` is 14 MB and is not committed. Fetch it
once. Tests that need it skip with an instruction until you do.

## Licensing

No AGPL dependencies. The YOLOv8 and Ultralytics family is not used here.
Person detection is MediaPipe, Apache 2.0.
