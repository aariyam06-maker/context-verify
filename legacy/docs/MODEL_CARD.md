# ContextTrace detector model card

## System

ContextTrace AI-Scan is an ensemble screening system for AI/synthetic-video artifacts. It is not an authorship or intent detector.

### Primary model

`Ant-One/GenD_DINOv3_L_FF` (GenD DINOv3, FaceForensics++-trained) is used on detected face crops when available. The model card reports 91.84% video AUROC and 89.88% video mAP on its stated benchmark. These figures are third-party benchmark results, not ContextTrace results. citeturn0search4turn0search2

### Secondary model

`dima806/deepfake_vs_real_image_detection` is used frame-wise as a secondary image-level signal. It is deliberately not treated as a video-level accuracy claim.

### Supporting signals

OpenCV forensic features measure compression/temporal characteristics. They are low-weight supporting evidence and are not independently validated as universal synthetic-media signatures.

### Provenance

Optional C2PA inspection is performed separately. C2PA is a provenance standard, not a detector; verified provenance assertions can be materially different evidence from a model inference. The current C2PA specification includes AI disclosure assertions and emphasizes verifiable provenance rather than value judgments. citeturn1search3turn1search8

## Output semantics

- **Calibrated probability:** shown only if `data/models/ai_calibration.json` exists and was fitted from a labeled held-out calibration set.
- **AI-artifact index:** default 0–100 ensemble index before calibration.
- **Confidence:** confidence in the stability/coverage of the analysis, not probability that the verdict is correct.
- **Frame findings:** timestamps where detector evidence is strongest.

The score is never described as “X% of the video was made by AI.”

## Intended use

Research, education, fact-checking assistance and media forensics. The result must be reviewed alongside provenance and source evidence.

## Known limitations

Current research shows detector performance can collapse on generators outside the training distribution. Recent benchmarking reports substantial generator-specific degradation, so generator-disjoint evaluation is a mandatory ContextTrace release gate. citeturn0search3turn0academia34turn0academia36

## Release requirements

Before claiming project accuracy, retain:

1. exact model registry snapshot;
2. dataset manifest and licenses;
3. source-identity-safe train/calibration/test splits;
4. generator-disjoint holdout metrics;
5. ROC-AUC and PR-AUC;
6. F1 and TPR at low FPR operating points;
7. Brier/log-loss calibration metrics;
8. per-generator and per-domain breakdowns;
9. false-positive/false-negative review set;
10. reproducible environment information.
