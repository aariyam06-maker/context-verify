from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def inspect_c2pa(path: Path) -> dict[str, Any]:
    """Inspect Content Credentials when the optional C2PA Python SDK is installed.

    Provenance is kept separate from detector scores: a valid signed manifest is
    an attestation about provenance, while a model score is an inference.
    """
    try:
        import c2pa  # type: ignore
        reader = c2pa.Reader(str(path))
        raw = reader.json()
        payload = json.loads(raw) if isinstance(raw, str) else raw
        return {"available": True, "status": "manifest_found", "manifest": payload}
    except Exception as exc:
        return {"available": False, "status": "not_available", "reason": f"C2PA inspection unavailable: {type(exc).__name__}"}
