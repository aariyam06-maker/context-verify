# ContextTrace FastAPI backend

This backend is the authoritative application boundary described by the SRS/SDS.

## Run

```bash
python -m venv .venv
# activate the environment
pip install -r backend/requirements-dev.txt
python backend/run.py
```

The service listens on `http://localhost:8000`.

## Database

- Default: SQLite at `data/contexttrace.db`.
- Production-style: PostgreSQL 15+ through `DATABASE_URL`.
- `docker compose up -d postgres` starts the bundled PostgreSQL 16 service.

## Pipeline

`media_validation -> preprocessing -> speech_analysis -> semantic_alignment -> visual_evidence -> ocr_evidence -> edit_detection -> context_analysis -> report_generation`

Long-running comparisons execute outside the request/response path. Critical errors mark jobs failed; optional modality failures produce a degraded report with explicit warnings.

## AI providers

Base requirements include FFmpeg/OpenCV for a runnable baseline. `requirements-ai.txt` adds the SRS-listed heavier providers:

- faster-whisper
- Sentence-Transformers
- FAISS
- OpenCLIP
- PaddleOCR

The service records the actual model/provider configuration in every report.
