from __future__ import annotations

from pathlib import Path
from typing import Any

from ..ml.video_io import probe

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}


def probe_media(path: Path) -> dict[str, Any]:
    """Validate and describe an uploaded video (OpenCV decoder + bundled FFmpeg)."""
    from ..config import settings

    meta = probe(path)
    if meta["duration"] > settings.max_duration_seconds:
        raise ValueError(f"Video exceeds the {settings.max_duration_seconds:g} second duration limit. Upload a shorter clip; only the first 10 seconds are analysed.")
    if max(meta["width"], meta["height"]) > 4096:
        raise ValueError("Video resolution exceeds 4096 pixels per side. Resize before uploading.")
    return meta


def validate_extension(filename: str) -> None:
    if Path(filename).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError("Unsupported video format. Use mp4, mov, webm, mkv, avi or m4v.")
