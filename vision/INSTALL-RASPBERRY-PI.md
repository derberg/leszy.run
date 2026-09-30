# Installing the finish-gate camera on a Raspberry Pi

Written for whoever is sitting in front of the Pi with the parts in a box. You
do not need to have read any of the code.

English rather than Polish to match `checkpoint-agent/README.md`, which is the
other hardware reference in this repository. Ask if you would rather have it in
Polish.

> **Not verified on hardware yet.** Every command here is written from the
> code and the part numbers, but nobody has followed it end to end on a real
> Pi. Expect at least one thing to be wrong. Fix it here when you find it.

## 1. What you need

| Part | Notes |
|---|---|
| Raspberry Pi 5 | The one already running the timing stack is fine. |
| Camera Module v2.1 | The sensor is IMX219. It has an infrared-cut filter, so it cannot see in darkness. |
| Camera cable, 22-pin to 15-pin | Botland 23929, 50 cm. See the warning below. |
| USB SSD | Not the SD card. See section 8. |
| Tripod | Anything that holds the camera steady at chest height. |

**The cable is the easy thing to get wrong.** Botland sells two products with
the same pin counts and nearly the same name:

- `Taśma Raspberry Pi - kamera 22 żyły raster 0,5mm - 15 żył raster 1mm` is the
  one you want. Product 23927 is 20 cm, 23928 is 30 cm, 23929 is 50 cm.
- `Taśma Raspberry Pi - wyświetlacz ...` is for a display. It will not work.

Check the word `kamera` before you order and again before you plug it in.

The 22-pin end, which is the narrow one, goes into the Pi. The 15-pin end, the
wide one, goes into the camera.

## 2. Connecting the camera

With the Pi powered off:

1. Find the two connectors between the HDMI ports labelled `CAM/DISP 0` and
   `CAM/DISP 1`. Either works. Use `CAM/DISP 0`.
2. Lift the small plastic latch straight up. It moves about a millimetre and
   it does not come off.
3. Slide the narrow end of the cable in so the **silver contacts face the HDMI
   ports**. The blue stiffener faces away from them.
4. Press the latch back down. The cable should not pull out with light
   pressure.
5. Repeat at the camera end. There the contacts face **away** from the lens.

Take your time. The connectors are fragile and a cable that is in crooked
reports as no camera at all.

## 3. Confirming the Pi sees the camera

Power up and run:

```bash
rpicam-hello --list-cameras
```

You want a line naming `imx219`.

Nothing listed? In order: power down, reseat both ends of the cable, check the
contacts face the right way, and check you have the camera tape rather than the
display tape. On a Pi 5 running current Raspberry Pi OS no config change is
needed. There is no `start_x` setting any more and you should not add one.

## 4. Installing the software

```bash
sudo apt update
sudo apt install -y python3-picamera2 python3-venv libgl1 libglib2.0-0
```

`python3-picamera2` comes from apt rather than pip, because it is built
against the system camera stack.

Then, from the repository:

```bash
cd vision
python3 -m venv --system-site-packages .venv
.venv/bin/pip install -e ".[dev]"
```

`--system-site-packages` matters. Without it the virtual environment cannot
see the apt-installed `picamera2` and capture fails on import.

Download the person detector, which is not committed:

```bash
mkdir -p models
curl -sfL -o models/efficientdet_lite0.tflite \
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite"
```

The digit recognizer, `models/digits.onnx`, is committed. You do not need to
train anything on the Pi.

Check it:

```bash
.venv/bin/python -m pytest
```

## 5. Checking the clock

```bash
timedatectl
```

`NTPSynchronized: yes` is what you need. Capture refuses to run otherwise,
deliberately: a Pi with no real-time clock battery boots in 1970, and a 1970
timestamp in a race record is worse than no record.

If it says no, give it a minute with a network connection. If it stays no,
fit the RTC battery, the same fix as for the checkpoint agent.

## 6. Aiming the camera

This decides whether the whole thing works, so it is worth ten minutes.

**Point the camera down the lane at runners coming towards it.** Not sideways
across the line. Sideways gives you about four frames per runner and sees the
bib edge on. Down the lane gives thirty and sees it square.

1. Tripod at about 1.3 m, roughly chest height.
2. Stand it about a metre to one side of the finish line.
3. Aim back up the lane, so an approaching runner is in frame for several
   seconds before they cross.
4. Have somebody stand with a real bib about 2 to 3 m from the lens.
5. Capture a few seconds and look at a frame. The number must be clearly
   legible. If it is not, move the camera closer.

## 6a. Verify the shutter is actually locked

Do this before the staged shoot, not after. The whole reason for a fast
shutter is freezing runners, and if auto exposure is quietly overriding it the
frames will blur in exactly the dull light the setting was chosen for. Nobody
has checked this against a real camera yet.

Capture a few seconds and read back what the camera actually used:

```bash
.venv/bin/python - <<'EOF'
from picamera2 import Picamera2
from vision.capture import build_controls
camera = Picamera2()
camera.configure(camera.create_video_configuration(
    main={"size": (1640, 1232), "format": "RGB888"},
    controls=build_controls(exposure_us=1200, gain=4.0)))
camera.start()
import time; time.sleep(2)
meta = camera.capture_metadata()
print("ExposureTime", meta.get("ExposureTime"), "AnalogueGain", meta.get("AnalogueGain"))
camera.stop(); camera.close()
EOF
```

`ExposureTime` must come back close to 1200. If it comes back as something
else, auto exposure is still driving the shutter and `build_controls` in
`vision/capture.py` needs correcting.

There is **no automatic gain adaptation**. Set `--gain` for the light on the
day, take a test capture, and adjust. Too dark means raise it; grainy means
lower it and add light instead.

## 7. A test recording

```bash
cd vision
.venv/bin/python scripts/capture.py --queue /mnt/ssd/frames --seconds 30
```

Then read what it caught:

```bash
.venv/bin/python scripts/measure_read_rate.py \
  --frames /mnt/ssd/frames --truth /mnt/ssd/frames/truth.txt
```

`truth.txt` is one bib number per line: the numbers the people in front of the
camera were actually wearing. The report separates three things, and they do
not cost the same:

- **missed** is a runner nobody read. A person can fill that gap from the
  photographs.
- **wrong** is a runner given somebody else's number. Nobody notices. Judge
  this number first.
- **spurious** is a number nobody was wearing.

## 8. Storage

Use a USB SSD, not the SD card.

A two-hour race at fifteen frames a second runs into tens of gigabytes. That
is more than most cards hold, and sustained writing at that rate wears a card
out and then fails at the worst possible moment.

Point `--queue` at a directory on the SSD.

## 9. When it does not work

**All frames are black or nearly black.** There is not enough light. The
Camera Module v2.1 has an infrared-cut filter and cannot see in the dark, and
the shutter is deliberately locked fast to freeze runners. A night race needs
a lit gate. This is not something software can fix.

**`ModuleNotFoundError: No module named 'picamera2'`.** The virtual
environment was made without `--system-site-packages`. Delete `.venv` and
redo section 4.

**Capture exits saying the clock is not synchronized.** Section 5.

**`No detector model at .../efficientdet_lite0.tflite`.** The download in
section 4 did not run or did not finish.

**Numbers read wrong rather than not at all.** Usually the bib is too small in
frame. Move the camera closer and re-check section 6 before changing anything
in the code.

**Frames blurred despite the fast shutter.** Section 6a. Auto exposure is
probably still driving the shutter.
