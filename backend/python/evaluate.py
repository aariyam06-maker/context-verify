"""Holdout evaluation: confusion matrix, precision/recall/F1, ROC-AUC.

Loads model.json (or trains fresh if absent), renders a fresh holdout corpus
with a different seed than training, and reports the final measured metrics.
This is the number the README quotes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict

import numpy as np

from corpus import build_clip_corpus
from features import FEATURE_NAMES
from train import MODEL_PATH, model_predict, standardize_apply, standardize_fit


def roc_auc(y: np.ndarray, p: np.ndarray) -> float:
    """Rank-based ROC-AUC (handles ties by midpoint)."""
    order = np.argsort(p)
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(1, len(p) + 1, dtype=np.float64)
    # Midranks for ties:
    sp = p[order]
    i = 0
    while i < len(sp):
        j = i
        while j + 1 < len(sp) and sp[j + 1] == sp[i]:
            j += 1
        if j > i:
            ranks[order[i : j + 1]] = (i + 1 + j + 1) / 2.0
        i = j + 1
    n_pos = float((y == 1).sum())
    n_neg = float((y == 0).sum())
    if n_pos == 0 or n_neg == 0:
        return 0.5
    sum_pos = float(ranks[y == 1].sum())
    return (sum_pos - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def evaluate(model: Dict, n_per_class: int = 60, seed: int = 998877) -> Dict:
    X, y, meta = build_clip_corpus(n_per_class=n_per_class, frames=14, seed=seed)
    mu = np.array(model["mu"])
    sigma = np.array(model["sigma"])
    p = model_predict(model, standardize_apply(X, mu, sigma))
    pred = (p >= float(model.get("threshold", 0.5))).astype(np.int64)

    tp = int(((pred == 1) & (y == 1)).sum())
    tn = int(((pred == 0) & (y == 0)).sum())
    fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    accuracy = (tp + tn) / max(1, tp + tn + fp + fn)

    # Hard-subset diagnostics (if present in the holdout).
    hard_mask = np.array([m["hard"] is not None for m in meta])
    hard_acc = float((pred[hard_mask] == y[hard_mask]).mean()) if hard_mask.any() else None

    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "auc": roc_auc(y, p),
        "confusion": {"tp": tp, "tn": tn, "fp": fp, "fn": fn},
        "nClips": int(len(y)),
        "hardSubsetAccuracy": hard_acc,
        "hardSubsetClips": int(hard_mask.sum()),
        "version": model.get("version", "unknown"),
    }


def main() -> int:
    if MODEL_PATH.exists():
        model = json.loads(MODEL_PATH.read_text())
    else:
        from train import train_and_save

        model = train_and_save()

    ev = evaluate(model)
    print(json.dumps(ev, indent=2))
    print(
        f"accuracy {ev['accuracy']*100:.2f}%  precision {ev['precision']*100:.2f}%  "
        f"recall {ev['recall']*100:.2f}%  f1 {ev['f1']:.4f}  auc {ev['auc']:.4f}"
    )
    if ev["hardSubsetAccuracy"] is not None:
        print(
            f"hard subset ({ev['hardSubsetClips']} clips): {ev['hardSubsetAccuracy']*100:.2f}%"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
