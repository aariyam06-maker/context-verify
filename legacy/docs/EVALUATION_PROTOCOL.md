# ContextTrace evaluation protocol

## Gates

A detector release is not “validated” until all gates pass:

1. **Data integrity:** no source identity appears in more than one split.
2. **Generator separation:** final test includes generators absent from training.
3. **Real-media floor:** real camera/social/compressed media are included.
4. **Calibration:** probability calibration is fit only on calibration data.
5. **Metrics:** ROC-AUC, PR-AUC, F1, TPR@1% FPR, TPR@5% FPR, Brier and log loss.
6. **Per-generator report:** no single aggregate hides a generator failure.
7. **Failure analysis:** false positives and false negatives are exported for manual review.
8. **Reproducibility:** registry, manifest hash, preprocessing settings and software versions are retained.

## Required artifact set

```text
artifacts/
  predictions.csv
  evaluation.json
  calibration.json
  manifest.sha256
  model_registry.json
  environment.txt
```

A model can be promoted to `production` only after these artifacts are generated from the same commit and dataset snapshot.

Generate predictions from actual media:

```bash
python tools/run_detector.py data/datasets/manifest.csv --out predictions.csv
python tools/evaluate_predictions.py predictions.csv --out data/models/evaluation.json
```
