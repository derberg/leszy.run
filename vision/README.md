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
.venv/bin/python -m pytest
```

Python 3.12 rather than the system default, because mediapipe publishes no
wheels for 3.14 yet.

## Models

`models/` is not committed. Two files go there:

- `digits.onnx`, produced by `scripts/train_recognizer.py`
- `efficientdet_lite0.tflite`, downloaded once (Apache 2.0)

## Licensing

No AGPL dependencies. The YOLOv8 and Ultralytics family is not used here.
Person detection is MediaPipe, Apache 2.0.
