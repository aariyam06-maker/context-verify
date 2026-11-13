# ContextTrace AI-detection engineering standard

## Output semantics

ContextTrace never represents the displayed score as “the percentage of the video that is AI”. A video-level score is an evidence index unless a project-specific calibration artifact exists. When calibration exists, the UI may show a calibrated probability, but that probability is still an estimate of detector evidence, not proof of authorship.

## Detector stack

1. **Primary:** GenD DINOv3 FF face-video detector when face crops are available.
2. **Secondary:** frame-level ViT real/fake detector on full frames.
3. **Temporal aggregation:** robust median/upper-quantile aggregation; isolated spikes do not determine the verdict.
4. **Forensic support:** OpenCV compression/temporal measurements. These never act as an independent proof signal.
5. **OCR:** PaddleOCR is a separate evidence channel.
6. **Calibration:** optional Platt or isotonic calibration trained only from a held-out calibration split.

## Face processing

The detector prefers OpenCV YuNet when `CTXTRACE_YUNET_MODEL` points to a local ONNX model, and falls back to Haar detection for CPU-only development. Face coverage is reported because a face detector cannot provide evidence where no face exists.

## Evaluation protocol

The project must report:

- ROC-AUC and PR-AUC;
- F1/accuracy at the selected operating threshold;
- TPR at FPR 1% and 5%;
- Brier score and log loss after calibration;
- confusion matrix;
- results by generator/manipulation family;
- results on a generator-disjoint holdout;
- results by domain (camera, social, face-swap, reenactment, text-to-video, image-to-video, etc.).

Do not split frames from one video across train/test. `source_id` must remain in one split. The final robustness result should use leave-one-generator-out evaluation where feasible.

## Dataset protocol

Use `data/datasets/manifest.csv` with:

`path,label,generator,source_id,split,domain`

Run:

```bash
python tools/manifest_check.py data/datasets/manifest.csv
```

Then run your detector over the videos and write a prediction CSV containing at least:

`path,label,generator,split,primary_score,secondary_score,forensic_score,temporal_agreement,face_coverage,score`

Evaluate:

```bash
python tools/evaluate_predictions.py predictions.csv --out data/models/evaluation.json
```

Fit calibration only on the calibration split:

```bash
python tools/fit_calibrator.py predictions.csv --method platt --out data/models/ai_calibration.json
```

The calibration artifact is intentionally absent from the repository until a real labeled calibration corpus is supplied.

## Why this is necessary

Current research shows substantial detector degradation under generator shift. GenVidBench provides a large cross-generator benchmark, while recent independent benchmarking reports severe failures on unseen generators. A detector's published in-domain score must therefore not be presented as the ContextTrace real-world accuracy. citeturn0search10turn0search3

The GenD detector is a reasonable research baseline because its published model card reports video-level metrics and describes generator/manipulation-oriented training, but those numbers remain the model authors' benchmark results rather than ContextTrace's validation. citeturn0search4turn0search2
