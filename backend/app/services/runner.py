"""Background job execution for the two ContextTrace services.

A single worker thread processes jobs in order: model inference is CPU/RAM
heavy, so serialising jobs keeps latency predictable on laptops.
"""
from __future__ import annotations

import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from ..db import SessionLocal
from ..models import AnalysisJob, Report, Video

_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ctx-job")


def submit(job_id: str) -> None:
    _pool.submit(run_job, job_id)


def _stage(db, job: AnalysisJob, stage: str, pct: int) -> None:
    job.status = "RUNNING"; job.current_stage = stage; job.progress = pct
    db.commit()


def _clean(obj):
    """Drop private keys (e.g. cached feature objects) before JSON storage."""
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items() if not str(k).startswith("_")}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    import numpy as np

    if isinstance(obj, np.generic):  # numpy scalars (float32 timestamps etc.) are not JSON serialisable
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj


def run_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(AnalysisJob, job_id)
        if not job:
            return
        job.started_at = datetime.now(timezone.utc)
        _stage(db, job, "loading_models", 5)
        if job.mode == "detect":
            from ..ml import detector

            video = db.get(Video, job.source_video_id)
            detector.load_model()
            _stage(db, job, "frame_sampling_and_features", 25)
            inference_mode = "light" if job.model_configuration == "ai_detector:light" else "full"
            result = detector.analyze(Path(video.storage_path), mode=inference_mode)
            result.pop("_ff", None)
            _stage(db, job, "report_generation", 92)
            score = int(round(result["aiProbability"]))
            conf = float(result["confidence"])
            interpretation = (f"{result['verdictLabel']} - {result['aiProbability']:.0f}% probability of AI generation; "
                              f"{result['aiContentShare']:.0f}% of the analysed timeline classified as AI-generated.")
            payload = {"mode": "detect", "result": _clean(result)}
            model_cfg = result["model"]["version"]
        elif job.mode == "tamper":
            from ..ml import detector, tamper_service

            va = db.get(Video, job.source_video_id); vb = db.get(Video, job.edited_video_id)
            detector.load_model(); tamper_service.load_model()
            _stage(db, job, "ai_analysis_and_alignment", 25)
            result = tamper_service.compare(Path(va.storage_path), Path(vb.storage_path), (va.filename, vb.filename))
            _stage(db, job, "report_generation", 92)
            # score = confidence (0-100) that tampering between the pair was found
            score = int(round(100 * result["confidence"])) if result["verdict"] == "tampered" else 0
            conf = float(result["confidence"])
            interpretation = result["summary"]
            payload = {"mode": "tamper", "result": _clean(result)}
            model_cfg = result["model"]["version"]
        else:
            raise RuntimeError(f"Unknown job mode {job.mode}")
        report = db.scalar(select(Report).where(Report.job_id == job.id))
        if report is None:
            report = Report(job_id=job.id, owner_id=job.owner_id)
            db.add(report)
        report.score = score; report.overall_confidence = conf; report.evidence_coverage = 1.0; report.uncertainty = max(0.0, 1 - conf)
        report.interpretation = interpretation; report.pipeline_version = "contexttrace v4"; report.model_configuration = model_cfg
        report.degraded = False; report.event_count = len(payload["result"].get("events", payload["result"].get("evidence", [])))
        report.report_json = payload
        job.status = "COMPLETED"; job.current_stage = "done"; job.progress = 100; job.model_configuration = model_cfg
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:
        db.rollback()
        job = db.get(AnalysisJob, job_id)
        if job:
            job.status = "FAILED"; job.current_stage = "failed"
            job.error_message = f"{type(exc).__name__}: {exc}"
            job.warnings = [traceback.format_exc()[-1500:]]
            job.completed_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        db.close()
