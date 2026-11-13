from __future__ import annotations

from pathlib import Path
from typing import Any

from ..ml.video_io import probe

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}


def probe_media(path: Path) -> dict[str, Any]:
    """Validate and describe an uploaded video (OpenCV decoder + bundled FFmpeg)."""
    return probe(path)


def validate_extension(filename: str) -> None:
    if Path(filename).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError("Unsupported video format. Use mp4, mov, webm, mkv, avi or m4v.")
