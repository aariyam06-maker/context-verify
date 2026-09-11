# ContextTrace polyglot backend

The production backend is split by language according to what each runtime is
best at, with a single orchestration gateway:

```
                 +------------------------+
   app (JS/TS) ->|  server/index.ts (bun) |  HTTP :8787, same-origin
                 |  gateway + routing     |
                 +---+---------------+----+
                     |               |
        +------------+---+   +-------+----------+
        | python/        |   | java/            |
        | feature ext.   |   | Verifier.java    |
        | corpus, train, |   | independent      |
        | evaluate,      |   | scoring + digest |
        | cli_score.py   |   | 2-of-3 consensus |
        +----------------+   +------------------+
```

* **Python** — numeric core: reference feature extractor (numpy), procedural
  labeled corpus, logistic-regression trainer, evaluation metrics, and the
  scoring CLI used at inference time.
* **Java** — independent verifier: re-implements the scoring math in pure Java,
  cross-checks JS/Python agreement, computes SHA-256 integrity digests over the
  feature vectors and model coefficients, and enforces 2-of-3 consensus.
* **JS/TS (bun)** — gateway server and orchestration; also the Convex functions
  that persist jobs/reports, and the browser-side real-time detector which is
  kept numerically identical to the Python reference by the conformance tests.

## Files

| Path | Role |
| --- | --- |
| `python/features.py` | 12-feature forensic extractor from grayscale pixel matrices |
| `python/corpus.py` | Procedurally rendered labeled corpus (camera/synthetic + hard negatives) |
| `python/train.py` | Feature→matrix assembly, standardization, model fitting, calibration report |
| `python/evaluate.py` | Confusion matrix, precision/recall/F1, ROC-AUC |
| `python/cli_score.py` | Inference CLI: JSON features in → score/label/confidence out |
| `java/Verifier.java` | Independent scorer + SHA-256 digest + 2-of-3 consensus |
| `server/index.ts` | Bun HTTP gateway: `/api/health`, `/api/score`, `/api/verify`, `/api/evaluate` |
| `server/gateway.test.ts` | Gateway integration tests (spawns real python + java) |
| `tests/backend.test.ts` | Engine conformance, digest integrity, corpus evaluation E2E |

## Run the tests

```bash
bun test                      # full suite (conformance + digests + gateway + corpus E2E)
bun test tests/backend.test.ts
bun test server/gateway.test.ts
```

## Re-train / re-evaluate the model

```bash
python3 python/train.py       # fits on the procedural corpus, writes model.json
python3 python/evaluate.py    # reports accuracy/precision/recall/F1/AUC + confusion matrix
```

`train.py` performs 5-fold stratified cross-validation and only reports the
cross-validated number; `model.json` embeds both the coefficients and the
final evaluation block so consumers can see the measured metrics the shipped
weights were evaluated with.

## Accuracy scope (read before quoting numbers)

The reported accuracy is measured on the procedural corpus defined in
`python/corpus.py` — procedurally rendered natural footage vs. procedurally
rendered synthetic footage, including hard negatives (denoised, re-encoded,
textured synthetic) and hard positives (grainy synthetic). It is a
self-consistent benchmark: it validates the feature extractor, the model, and
cross-language numerical agreement. It does **not** measure performance on
real-world AI-generated video from named production models; that would require
a labeled set of genuine model outputs, which this environment cannot produce.
The number is honest about exactly what it measures.
