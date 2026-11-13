# ContextTrace architecture

```text
React/Vite UI
   |
   | REST + JWT
   v
FastAPI application boundary
   |
   +--> Authentication / ownership / roles
   +--> Media manager ----> data/uploads
   +--> Job controller ----> background pipeline
   |                           |
   |                           +--> FFprobe/OpenCV
   |                           +--> faster-whisper (optional)
   |                           +--> Sentence-Transformers/FAISS (optional)
   |                           +--> OpenCLIP (optional)
   |                           +--> PaddleOCR (optional)
   |                           +--> Context/event engine
   |
   +--> SQLAlchemy ----------> SQLite / PostgreSQL
   |
   +--> Report/evidence API -> React report + timeline
```

The browser never performs authoritative ownership checks. Media, jobs and reports are protected server-side. Local IndexedDB is retained only as a convenience for the single-video scan/mitigation workflow; the source/edit comparison pipeline stores authoritative uploaded media under the server artifact boundary.

## AI-Scan engineering boundary

The single-video detector is a separate bounded pipeline:

```text
Video
  -> media decode
  -> sampled frames
  -> YuNet/Haar face detection + lightweight temporal association
  -> GenD DINOv3 face-video detector (primary, optional GPU)
  -> frame-level ViT detector (secondary)
  -> temporal robust aggregation
  -> OpenCV forensic support
  -> optional project-specific calibration
  -> C2PA provenance inspection
  -> OCR evidence
  -> report
```

No provenance assertion is converted into a model score, and no missing provenance is treated as evidence of AI generation.

The detector registry is `models/model_registry.json`. Evaluation/calibration artifacts live under `data/models/` and are never silently generated from demo media.
