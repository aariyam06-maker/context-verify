"""Zero-shot baselines: off-the-shelf Hugging Face AI-image / deepfake classifiers.

Each model scores 8 frames per video; the video score is the mean frame
probability of the 'fake/AI' class. Evaluated on (a) a stratified 200-video
sample of the training corpus and (b) the full 60-video OOD set, so they can
be compared with the trained ContextTrace detector on identical videos.

`dima806/deepfake_vs_real_image_detection` is the secondary model that the
previous (v3) ContextTrace detector shipped with.

Output: data/models/baselines.json
"""
from __future__ import annotations

import csv
import json
import random
import sys
import time
import warnings
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.ml import video_io  # noqa: E402

CANDIDATES = [
    "dima806/deepfake_vs_real_image_detection",
    "umm-maybe/AI-image-detector",
    "Organika/sdxl-detector",
]


def fake_index(model) -> int:
    for i, lab in (model.config.id2label or {}).items():
        if any(t in str(lab).lower() for t in ("fake", "artificial", "ai", "synthetic", "generated", "sdxl")):
            return int(i)
    return 1


def score_videos(model_id, rows):
    import cv2
    import torch
    from PIL import Image
    from transformers import AutoImageProcessor, AutoModelForImageClassification

    proc = AutoImageProcessor.from_pretrained(model_id)
    model = AutoModelForImageClassification.from_pretrained(model_id).eval()
    fi = fake_index(model)
    out = []
    for r in rows:
        try:
            frames, _, _, _ = video_io.read_sampled(ROOT / r["path"], k=8, pair=False)
            ims = [Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB)) for f in frames]
            with torch.inference_mode():
                logits = model(**proc(images=ims, return_tensors="pt")).logits
            p = torch.softmax(logits, -1)[:, fi].mean().item()
            out.append(p)
        except Exception:
            out.append(np.nan)
    return np.array(out), {str(k): v for k, v in model.config.id2label.items()}, fi


def metrics(y, p):
    from sklearn.metrics import accuracy_score, balanced_accuracy_score, roc_auc_score

    m = ~np.isnan(p)
    y, p = y[m], p[m]
    return {"n": int(m.sum()), "accuracy": float(accuracy_score(y, p >= 0.5)), "balanced_accuracy": float(balanced_accuracy_score(y, p >= 0.5)),
            "auc": float(roc_auc_score(y, p)), "recall_ai": float((p[y == 1] >= 0.5).mean()), "specificity_real": float((p[y == 0] < 0.5).mean())}


def main():
    train = list(csv.DictReader(open(ROOT / "data/datasets/manifest.csv", encoding="utf-8")))
    ood = list(csv.DictReader(open(ROOT / "data/datasets/ood_manifest.csv", encoding="utf-8")))
    rng = random.Random(11)
    by_src = {}
    for r in train:
        by_src.setdefault(r["source"], []).append(r)
    sample = [x for rows in by_src.values() for x in rng.sample(rows, min(len(rows), 18))]
    res = {}
    for mid in CANDIDATES:
        t0 = time.time()
        try:
            ps, labels, fi = score_videos(mid, sample)
            po, _, _ = score_videos(mid, ood)
        except Exception as exc:
            res[mid] = {"error": f"{type(exc).__name__}: {exc}"}
            print(mid, "ERROR", exc, flush=True)
            continue
        ys = np.array([1 if r["label"] == "ai" else 0 for r in sample]); yo = np.array([1 if r["label"] == "ai" else 0 for r in ood])
        res[mid] = {"labels": labels, "fake_index": fi, "train_sample": metrics(ys, ps), "ood": metrics(yo, po), "seconds": round(time.time() - t0, 1),
                    "ood_predictions": [{"source": r["source"], "label": r["label"], "prob_ai": None if np.isnan(p) else float(p)} for r, p in zip(ood, po)]}
        print(mid, json.dumps({k: res[mid][k] for k in ("train_sample", "ood")}), flush=True)
    (ROOT / "data/models/baselines.json").write_text(json.dumps(res, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
