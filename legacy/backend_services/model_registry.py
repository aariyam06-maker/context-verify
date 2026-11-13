from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
REGISTRY_PATH = Path(os.getenv("CTXTRACE_MODEL_REGISTRY", ROOT / "models" / "model_registry.json"))


def load_registry() -> dict[str, Any]:
    if not REGISTRY_PATH.exists():
        return {"schemaVersion": 1, "activeProfile": "research_ensemble", "profiles": {}, "models": {}}
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def active_profile() -> dict[str, Any]:
    registry = load_registry()
    requested = os.getenv("CTXTRACE_DETECTOR_PROFILE", registry.get("activeProfile", "research_ensemble"))
    return registry.get("profiles", {}).get(requested, {})


def model_metadata(model_id: str) -> dict[str, Any]:
    return load_registry().get("models", {}).get(model_id, {})


def configuration_string() -> str:
    profile = active_profile()
    parts = [f"profile={os.getenv('CTXTRACE_DETECTOR_PROFILE', 'research_ensemble')}"]
    for key in ("primary", "secondary", "forensic", "calibration"):
        if profile.get(key):
            parts.append(f"{key}={profile[key]}")
    return "; ".join(parts)
