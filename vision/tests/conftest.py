"""Shared test setup.

The person detector model is 14 MB and is not committed, so the tests that
need it skip with an instruction rather than erroring. Everything that can be
tested without a download still runs on a fresh clone.
"""
import pytest

from vision.people import MODEL_PATH

needs_detector = pytest.mark.skipif(
    not MODEL_PATH.exists(),
    reason=(
        f"detector model missing at {MODEL_PATH}. "
        "Run: python scripts/fetch_models.py"
    ),
)
