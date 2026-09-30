---
name: running-vision-pipeline
description: Use when running, testing, retraining, measuring or debugging the finish-gate camera pipeline in `vision/` - "why did it read the wrong number", "retrain the recognizer", "measure the read rate", "the camera sees nothing", "regenerate the training data". Covers the gate the whole phase exists to pass and the three failure classes that do not cost the same.
---

# Running the vision pipeline

`vision/` reads bib numbers from photographs taken at the finish gate. It is a
second source for runners the chip missed. It never outranks a chip read.

Read `docs/superpowers/specs/2026-09-30-vision-bib-recognition-design.md`
before changing behaviour. That path is gitignored, so it exists only in the
main checkout.

## The environment

```bash
cd vision
.venv/bin/python -m pytest
```

If `.venv` is missing, see `INSTALL-RASPBERRY-PI.md` section 4 on the Pi, or on
a workstation:

```bash
cd vision
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev,train]"
.venv/bin/python scripts/fetch_models.py
```

`fetch_models.py` pulls the person detector, which is 14 MB and not
committed. Without it the detector and pipeline tests skip rather than run,
so a green suite that says `8 skipped` means you have not tested half of it.
`models/digits.onnx` IS committed and needs no download.

Python 3.12, not the system default. `mediapipe==0.10.21` has no 3.14 wheels,
and 1.0.x aborts on macOS arm64. That pin is deliberate and the reason is in
`pyproject.toml`.

## Measuring the read rate

This is the gate. It writes nothing.

```bash
cd vision
.venv/bin/python scripts/measure_read_rate.py --frames <dir> --truth <dir>/truth.txt
```

`truth.txt` is one bib number per line: the numbers people were actually
wearing.

**The three outcomes do not cost the same, and the report separates them for
that reason.**

- **missed** is a runner nobody read. Recoverable: a person finds them in the
  photographs and fills the gap.
- **wrong** is a runner handed somebody else's number. Nobody notices. This is
  the number that decides whether the system ships.
- **spurious** is a number nobody was wearing. It invents a runner.

Judge `wrong` first. A pipeline with a lower read rate and no wrong reads is
better than one that reads more and occasionally lies.

## Retraining the recognizer

```bash
cd vision
.venv/bin/python scripts/train_recognizer.py --numbers 1-999 --per-number 10
```

About three minutes. It renders synthetic bibs, augments them, segments them
into digits, trains, and writes `models/digits.onnx`, which is committed.

**Never train on photographs from a real race.** Those are the measurement
set. A model trained on its own exam produces a read rate that means nothing.

The trainer drops any bib whose segmentation disagrees with its label, and
prints how many. A sudden jump in that number means segmentation broke, not
that the data got harder.

## When a number reads wrong

Work down the stages. Each is testable on its own.

1. `detect_people` (`vision/people.py`). No person box means no bib is ever
   looked for. Check the model file exists.
2. `resolve_bib_claims` (`vision/pipeline.py`). When two runners overlap, the
   same bib falls inside both person boxes. It goes to whoever it sits most
   centrally within, and the other runner gets a miss. A runner who should
   have a number and has None may have lost it here.
3. `extract_bib` (`vision/locate.py`). Colour and ROTATED-rectangle fit
   inside the person box, then a deskew. The saturation gate keeps forest
   undergrowth out: wet moss sits close to the block in hue and far from it
   in saturation. Fit and fill are judged on the rotated rect because an
   upright fit lost the block from about ten degrees of tilt. Always read
   from the crop `extract_bib` returns, never from `image.crop(box)`: 47 read
   off a tilted axis-aligned crop came back as 40.
4. `segment_digits` (`vision/recognize.py`). Components are filtered by
   height, because the corner marks reach about 19 percent into the block
   while digits start at about 10 percent, and then by aspect ratio. Real
   digits measure 0.37 to 0.70 wide over tall. A dropped digit is usually the
   aspect gate, and that gate is deliberate: without it a bright strap became
   a leading digit and blurred digits merged into one.
5. `read_bib`. Confidence is the weakest digit, because a bib is read whole or
   not at all.
6. `Tracker` (`vision/track.py`). Thirty frames vote. If one bad frame decided
   the answer, the tracker is not linking frames and the runner produced
   several one-frame tracks.

Usually the cause is upstream of all of it: the bib is too small in frame. Aim
for at least 40 px of digit height at the read point before changing code.

## When the camera sees nothing

Black frames mean no light. The Camera Module v2.1 has an infrared-cut filter
and the shutter is locked fast to freeze runners. A night race needs a lit
gate. No code change fixes darkness.

## Things that will look like bugs and are not

- A track with `text=None` is kept on purpose. It says somebody crossed and
  could not be read, which is the most useful row in the table when a runner is
  missing.
- A blank bib block returns `None`, not a number. Otsu returns a split even for
  a uniform image, so `_bright_mask` gates on contrast and coverage first. That
  gate exists because a blank block was once read as `1`.
- `clock_synced()` returning `None` warns instead of refusing. That is a
  workstation with no `timedatectl`. `False` still refuses.
- A bib that is present and legible to you but comes back as None. Check the
  aspect gate and `resolve_bib_claims` before anything else. Both turn a
  would-be wrong answer into an honest miss on purpose, and a miss is the
  recoverable outcome.
- `score()` calling an extra number "wrong" rather than "spurious" whenever
  any runner went unread. That is the rule: an extra number an absent runner
  could account for is a wrong read. The older same-length-one-digit test
  filed every length-changing misread as harmless, which made the gate metric
  blind to the failures this pipeline actually makes.
