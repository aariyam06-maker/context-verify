# Testing and verification

## Automated tests

Run from project root:

```bash
PYTHONPATH=. pytest -q tests/backend_test.py
```

The test suite covers:

- transcript alignment and event detection;
- score bounds and empty-event behaviour;
- FastAPI health endpoint;
- registration/login and JWT issuance.

## Manual acceptance test

1. Start PostgreSQL with `docker compose up -d postgres` or use the default SQLite database.
2. Start FastAPI: `python backend/run.py`.
3. Start Vite: `npm run dev`.
4. Register an analyst account.
5. Upload a valid source/edit pair.
6. Confirm the job transitions through queued/running to completed/degraded/failed.
7. Open the report and verify score, confidence, evidence coverage, uncertainty and pipeline/model configuration.
8. Select a finding and verify the source/edit timeline jumps to the associated intervals.
9. Verify transcript evidence is displayed for the selected event.
10. Open History and reopen the report without re-uploading.
11. Test a corrupt/unsupported file; it must be rejected before analysis.
12. Disable an optional modality dependency and verify the job becomes degraded rather than producing a false positive.

## Critical failure rule

A pipeline exception sets the job to `FAILED` and does not create a complete-looking report. This is required by NFR-02.

## Detector validation

The unit/integration suite intentionally does not download large model weights. The detector pipeline is tested with mocked learned predictions to verify aggregation, face tracking, provenance fields, score semantics and report shape.

Real detector validation is a separate acceptance gate:

```bash
python tools/manifest_check.py data/datasets/manifest.csv
python tools/evaluate_predictions.py predictions.csv --out data/models/evaluation.json
python tools/fit_calibrator.py predictions.csv --method platt --out data/models/ai_calibration.json
```

Do not treat unit-test success as detector accuracy.
