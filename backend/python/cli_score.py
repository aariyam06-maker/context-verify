"""Inference CLI for the ContextTrace AI-content detector.

Modes:
  score  — read {"features": [19 floats]} (16 frame means + 3 cross-frame) and
           print {"score","label","confidence"}
  feats  — read {"frames": [H,W,3 RGB arrays]} and print per-frame 16-feature
           vectors (used by the cross-language conformance tests)

Used by the bun gateway (server/index.ts) and the test suite.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, List

import numpy as np

from features import extract_frame_features, FEATURE_NAMES

MODEL_PATH = Path(__file__).parent / "model.json"


def load_model() -> Dict:
    if not MODEL_PATH.exists():
        from train import train_and_save

        train_and_save()
    return json.loads(MODEL_PATH.read_text())


def score_features(model: Dict, features: List[float]) -> Dict:
    from train import model_predict, standardize_apply

    x = np.array([features], dtype=np.float64)
    mu = np.array(model["mu"])
    sigma = np.array(model["sigma"])
    p = float(model_predict(model, standardize_apply(x, mu, sigma))[0])
    thr = float(model.get("threshold", 0.5))
    label = 1 if p >= thr else 0
    # Confidence: distance from the decision boundary, scaled to 0..1.
    confidence = abs(p - thr) / max(thr, 1 - thr)
    # NOTE: `score` is returned at full float64 precision on purpose — the
    # cross-language conformance suite asserts JS/Python/Java agreement to
    # 1e-9, which any rounding here would break.
    return {"score": p, "label": label, "confidence": round(confidence, 4)}


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid JSON input: {e}"}))
        return 1

    mode = payload.get("mode", "score")
    model = load_model()

    if mode == "feats":
        frames = payload.get("frames", [])
        out = []
        prev = None
        for f in frames:
            arr = np.array(f, dtype=np.float64)
            feats, prev = extract_frame_features(arr, prev_gray=prev)
            out.append([round(v, 9) for v in feats])
        print(json.dumps({"featureOrder": FEATURE_NAMES, "frames": out}))
        return 0

    if mode == "score":
        feats = payload.get("features")
        if not feats or len(feats) != len(model["weights"]):
            print(json.dumps({"error": f"expected {len(model['weights'])} features"}))
            return 1
        print(json.dumps(score_features(model, feats)))
        return 0

    print(json.dumps({"error": f"unknown mode: {mode}"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
