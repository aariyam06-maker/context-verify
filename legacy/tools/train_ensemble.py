#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

FEATURES = ["primary_score", "secondary_score", "forensic_score", "temporal_agreement", "face_coverage"]


def main() -> None:
    p = argparse.ArgumentParser(description="Fit a ContextTrace meta-ensemble on video-level predictions.")
    p.add_argument("predictions", type=Path)
    p.add_argument("--out", type=Path, default=Path("data/models/ensemble_v1.json"))
    p.add_argument("--train-split", default="train")
    args = p.parse_args()
    df = pd.read_csv(args.predictions)
    missing = set(FEATURES + ["label"]) - set(df.columns)
    if missing:
        raise SystemExit(f"Missing columns: {sorted(missing)}")
    train = df[df.get("split", args.train_split) == args.train_split].copy() if "split" in df else df.copy()
    if len(train) < 100 or train.label.nunique() < 2:
        raise SystemExit("Ensemble training requires >=100 labeled training videos and both classes.")
    X = train[FEATURES].astype(float).fillna(0.5).to_numpy()
    y = train.label.astype(int).to_numpy()
    model = LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced")
    model.fit(X, y)
    p_train = model.predict_proba(X)[:, 1]
    payload = {
        "schemaVersion": 1,
        "model": "logistic_meta_ensemble",
        "features": FEATURES,
        "coef": model.coef_[0].tolist(),
        "intercept": float(model.intercept_[0]),
        "n": int(len(train)),
        "train_auc": float(roc_auc_score(y, p_train)),
        "warning": "Training AUC is not a generalization metric. Evaluate on a generator-disjoint holdout set before enabling this artifact in production."
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
