"""Clock discipline for capture.

A Pi with no real-time clock boots in 1970. A 1970 timestamp in a record of
what happened at a race is worse than no record at all, so capture refuses to
start until the clock is synchronized. checkpoint-agent/src/clock.js guards
recording the same way and for the same reason.
"""
import subprocess
from datetime import datetime, timezone


def clock_synced():
    """True, False, or None when it cannot be determined.

    None is a development laptop with no timedatectl, not a failure. The
    caller decides what to do with it, and capture treats it as a warning
    rather than a refusal, because refusing would make the package
    untestable off the Pi.
    """
    try:
        result = subprocess.run(
            ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
            capture_output=True, text=True, timeout=5, check=True,
        )
        return result.stdout.strip() == "yes"
    except Exception:
        return None


def monotonic_to_utc(ns: int, offset: float) -> datetime:
    """Convert a sensor timestamp to wall clock using an offset captured once.

    The offset is taken at the start of a session, so every frame in that
    session shares one conversion and their relative order is exact even if
    the wall clock is nudged while the session runs.
    """
    return datetime.fromtimestamp(offset + ns / 1e9, tz=timezone.utc)


def check_ordering(timestamps: list) -> list:
    """Indices where a timestamp is earlier than the one before it.

    An empty list means time only moved forwards. Anything else is reported
    rather than sorted away: a sensor clock that steps backwards mid-session
    means the timestamps on either side of the step cannot be compared, and
    quietly reordering them would hide that.
    """
    return [i for i in range(1, len(timestamps))
            if timestamps[i] < timestamps[i - 1]]
