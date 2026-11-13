# ContextTrace implementation status

This implementation follows the supplied SRS/SDS source/edit workflow and adds a clearly separated single-video AI-artifact scan.

## Core SRS

| Requirement | Implementation |
|---|---|
| FR-01 | FastAPI authentication, Argon2id password hashing (with legacy PBKDF2 rehash), short-lived access JWT, rotated HttpOnly refresh session, server-side logout/revocation |
| FR-02 | Source + edited video upload with ownership checks |
| FR-03 | FFprobe validation before persistence |
| FR-04 | Background job controller with QUEUED/RUNNING/DEGRADED/COMPLETED/FAILED states |
| FR-05 | Evidence-backed report UI |
| FR-06 | Synchronized source/edit timeline and finding navigation |
| FR-07 | Authorised report history |
| FR-08 | faster-whisper adapter; no fabricated transcript fallback |
| FR-09 | Sentence-Transformers + FAISS with explicit token fallback and warning |
| FR-10 | OpenCLIP visual correspondence with OpenCV fallback |
| FR-11 | PaddleOCR timestamped observations with explicit degraded state |
| FR-12 | Omission, reordering, splicing, discontinuity and caption/speech mismatch detection |
| FR-13 | Separate contextual-impact assessment in event records; labelled validation corpus still required |
| FR-14 | Evidence-backed score with event-level provenance |
| Report download | PDF + JSON download endpoints |
| Administrator | Protected review console + user role management + job inspection |

## Single-video AI scan

The detector is server-side and uses a registry-driven research ensemble: GenD DINOv3 on tracked face crops when available, a secondary frame-level ViT detector, temporal aggregation, and low-weight OpenCV forensic support. OCR and C2PA provenance are separate evidence channels. A project-specific calibration artifact is required before the UI calls the score a calibrated probability.

The displayed percentage is explicitly an **AI-artifact likelihood score**. It is not a literal percentage of generated content and is not treated as a calibrated authorship probability until a representative held-out evaluation corpus has been run.

## Important integrity rule

If faster-whisper is unavailable or produces no usable speech, ContextTrace no longer substitutes a demo transcript. The compare job is treated as insufficient for the speech-first baseline instead of producing a misleading complete report. This follows the SRS failure-handling rule that unavailable evidence must remain visible as uncertainty.
