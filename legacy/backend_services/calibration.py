from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_PATH = ROOT / "data" / "models" / "ai_calibration.json"


def load_calibration(path: Path | None = None) -> dict[str, Any] | None:
    p = path or Path(__import__("os").getenv("CTXTRACE_CALIBRATION_PATH", DEFAULT_PATH))
    if not p.exists():
        return None
    try:
        payload = json.loads(p.read_text(encoding="utf-8"))
        if payload.get("schemaVersion") != 1:
            return None
        return payload
    except Exception:
        return None


def apply_calibration(raw_score: float, calibration: dict[str, Any] | None) -> float | None:
    if not calibration:
        return None
    score = float(np.clip(raw_score, 0.0, 1.0))
    method = calibration.get("method")
    if method == "platt":
        a = float(calibration["a"])
        b = float(calibration["b"])
        z = np.clip(a * score + b, -40.0, 40.0)
        return float(1.0 / (1.0 + np.exp(-z)))
    if method == "isotonic":
        x = np.asarray(calibration["x_thresholds"], dtype=float)
        y = np.asarray(calibration["y_thresholds"], dtype=float)
        return float(np.interp(score, x, y))
    return None
