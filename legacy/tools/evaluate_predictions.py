#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    roc_auc_score,
    roc_curve,
)


def metrics(df: pd.DataFrame, score_col: str, label_col: str) -> dict:
    y = df[label_col].astype(int).to_numpy()
    s = df[score_col].astype(float).to_numpy()
    pred = (s >= 0.5).astype(int)
    out = {
        "n": int(len(df)),
        "positives": int(y.sum()),
        "negatives": int(len(y) - y.sum()),
        "accuracy_at_0_5": float(accuracy_score(y, pred)),
        "f1_at_0_5": float(f1_score(y, pred, zero_division=0)),
        "confusion_matrix": confusion_matrix(y, pred).tolist(),
    }
    if len(np.unique(y)) > 1:
        out["roc_auc"] = float(roc_auc_score(y, s))
        out["pr_auc"] = float(average_precision_score(y, s))
        fpr, tpr, thresholds = roc_curve(y, s)
        precision, recall, pr_thresholds = precision_recall_curve(y, s)
        out["roc_curve"] = {"fpr": fpr.tolist(), "tpr": tpr.tolist(), "thresholds": thresholds.tolist()}
        out["pr_curve"] = {"precision": precision.tolist(), "recall": recall.tolist(), "thresholds": pr_thresholds.tolist()}
        out["tpr_at_fpr_0_01"] = float(np.max(tpr[fpr <= 0.01])) if np.any(fpr <= 0.01) else 0.0
        out["tpr_at_fpr_0_05"] = float(np.max(tpr[fpr <= 0.05])) if np.any(fpr <= 0.05) else 0.0
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="Evaluate ContextTrace detector predictions with generator-aware breakdowns.")
    p.add_argument("predictions", type=Path)
    p.add_argument("--score", default="score")
    p.add_argument("--label", default="label")
    p.add_argument("--out", type=Path, default=Path("data/models/evaluation.json"))
    args = p.parse_args()
    df = pd.read_csv(args.predictions)
    required = {args.score, args.label, "generator"}
    missing = required - set(df.columns)
    if missing:
        raise SystemExit(f"Missing columns: {sorted(missing)}")
    result = {"overall": metrics(df, args.score, args.label), "by_generator": {}}
    for generator, group in df.groupby("generator", dropna=False):
        result["by_generator"][str(generator)] = metrics(group, args.score, args.label)
    if "split" in df.columns:
        result["by_split"] = {str(split): metrics(group, args.score, args.label) for split, group in df.groupby("split")}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"overall": result["overall"], "by_generator": result["by_generator"]}, indent=2))


if __name__ == "__main__":
    main()
