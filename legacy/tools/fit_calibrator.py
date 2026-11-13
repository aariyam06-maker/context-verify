#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score


def main() -> None:
    p = argparse.ArgumentParser(description="Fit a probability calibration artifact from a held-out calibration split.")
    p.add_argument("predictions", type=Path)
    p.add_argument("--score", default="score")
    p.add_argument("--label", default="label")
    p.add_argument("--split", default="calibration")
    p.add_argument("--method", choices=["platt", "isotonic"], default="platt")
    p.add_argument("--out", type=Path, default=Path("data/models/ai_calibration.json"))
    args = p.parse_args()
    df = pd.read_csv(args.predictions)
    if "split" in df.columns:
        df = df[df["split"] == args.split]
    y = df[args.label].astype(int).to_numpy()
    x = np.clip(df[args.score].astype(float).to_numpy(), 0, 1)
    if len(df) < 50 or len(np.unique(y)) < 2:
        raise SystemExit("Calibration requires at least 50 labeled samples and both classes.")
    if args.method == "platt":
        model = LogisticRegression(C=1e6, solver="lbfgs")
        model.fit(x.reshape(-1, 1), y)
        prob = model.predict_proba(x.reshape(-1, 1))[:, 1]
        payload = {"schemaVersion": 1, "method": "platt", "a": float(model.coef_[0, 0]), "b": float(model.intercept_[0]), "n": len(df), "generatorCount": int(df["generator"].nunique()) if "generator" in df else None}
    else:
        model = IsotonicRegression(out_of_bounds="clip")
        model.fit(x, y)
        prob = model.predict(x)
        payload = {"schemaVersion": 1, "method": "isotonic", "x_thresholds": model.X_thresholds_.tolist(), "y_thresholds": model.y_thresholds_.tolist(), "n": len(df), "generatorCount": int(df["generator"].nunique()) if "generator" in df else None}
    payload["training_metrics"] = {"brier": float(brier_score_loss(y, prob)), "log_loss": float(log_loss(y, np.clip(prob, 1e-6, 1 - 1e-6))), "roc_auc": float(roc_auc_score(y, x))}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
