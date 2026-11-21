from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import select

from ..auth import current_user
from ..config import settings
from ..db import SessionLocal
from ..models import AnalysisJob, Report, User, Video
from ..services import runner

router = APIRouter(prefix="/jobs", tags=["analysis jobs"])


def ms(dt):
    return int(dt.timestamp() * 1000) if dt else None


def _owned(db, user: User, job_id: str) -> AnalysisJob:
    job = db.get(AnalysisJob, job_id)
    if not job or job.owner_id != user.id:
        raise HTTPException(404, "Job not found.")
    return job


def _video(db, user: User, vid: str) -> Video:
    v = db.get(Video, vid)
    if not v or v.owner_id != user.id:
        raise HTTPException(404, "Video not found.")
    return v


def _summary(db, job: AnalysisJob) -> dict:
    a = db.get(Video, job.source_video_id) if job.source_video_id else None
    b = db.get(Video, job.edited_video_id) if job.edited_video_id else None
    rep = db.scalar(select(Report).where(Report.job_id == job.id))
    res = (rep.report_json or {}).get("result", {}) if rep else {}
    headline = None
    if rep and job.mode == "detect":
        headline = {"aiProbability": res.get("aiProbability"), "aiContentShare": res.get("aiContentShare"), "verdict": res.get("verdict"), "verdictLabel": res.get("verdictLabel")}
    elif rep and job.mode == "tamper":
        headline = {"verdict": res.get("verdict"), "original": res.get("original"), "tampered": res.get("tampered"), "confidence": res.get("confidence"), "summary": res.get("summary")}
    return {"_id": job.id, "mode": job.mode, "status": job.status, "currentStage": job.current_stage, "progress": job.progress,
            "createdAt": ms(job.created_at), "startedAt": ms(job.started_at), "completedAt": ms(job.completed_at), "errorMessage": job.error_message,
            "videoA": a.filename if a else None, "videoB": b.filename if b else None, "videoAId": a.id if a else None, "videoBId": b.id if b else None,
            "headline": headline}


@router.post("/detect")
def create_detect(videoId: str, user: User = Depends(current_user), inferenceMode: Literal["full", "light"] = "full"):
    db = SessionLocal()
    try:
        v = _video(db, user, videoId)
        job = AnalysisJob(owner_id=user.id, source_video_id=v.id, mode="detect", status="QUEUED", current_stage="queued", progress=0,
                          pipeline_version="contexttrace v4", model_configuration=f"ai_detector:{inferenceMode}", warnings=[])
        db.add(job); db.commit(); db.refresh(job)
        runner.submit(job.id)
        return {"jobId": job.id}
    finally:
        db.close()


@router.post("/tamper")
def create_tamper(videoAId: str, videoBId: str, user: User = Depends(current_user)):
    if videoAId == videoBId:
        raise HTTPException(400, "Upload two different files.")
    db = SessionLocal()
    try:
        a = _video(db, user, videoAId); b = _video(db, user, videoBId)
        job = AnalysisJob(owner_id=user.id, source_video_id=a.id, edited_video_id=b.id, mode="tamper", status="QUEUED", current_stage="queued", progress=0,
                          pipeline_version="contexttrace v4", model_configuration="tamper_model", warnings=[])
        db.add(job); db.commit(); db.refresh(job)
        runner.submit(job.id)
        return {"jobId": job.id}
    finally:
        db.close()


@router.get("")
def list_jobs(user: User = Depends(current_user)):
    db = SessionLocal()
    try:
        jobs = db.scalars(select(AnalysisJob).where(AnalysisJob.owner_id == user.id, AnalysisJob.mode.in_(["detect", "tamper"])).order_by(AnalysisJob.created_at.desc()).limit(200)).all()
        return [_summary(db, j) for j in jobs]
    finally:
        db.close()


@router.get("/{job_id}")
def get_job(job_id: str, user: User = Depends(current_user)):
    db = SessionLocal()
    try:
        return _summary(db, _owned(db, user, job_id))
    finally:
        db.close()


@router.get("/{job_id}/report")
def get_report(job_id: str, user: User = Depends(current_user)):
    db = SessionLocal()
    try:
        job = _owned(db, user, job_id)
        rep = db.scalar(select(Report).where(Report.job_id == job.id))
        if not rep:
            raise HTTPException(404, "Report is not available yet.")
        return {**_summary(db, job), "interpretation": rep.interpretation, "result": (rep.report_json or {}).get("result", {})}
    finally:
        db.close()


@router.delete("/{job_id}")
def delete_job(job_id: str, user: User = Depends(current_user)):
    db = SessionLocal()
    try:
        job = _owned(db, user, job_id)
        rep = db.scalar(select(Report).where(Report.job_id == job.id))
        if rep:
            db.delete(rep)
        db.delete(job); db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.get("/{job_id}/report/download")
def download_report(job_id: str, format: str = Query("pdf", pattern="^(pdf|json)$"), user: User = Depends(current_user)):
    db = SessionLocal()
    try:
        job = _owned(db, user, job_id)
        rep = db.scalar(select(Report).where(Report.job_id == job.id))
        if not rep:
            raise HTTPException(404, "Report is not available yet.")
        summary = _summary(db, job)
        result = (rep.report_json or {}).get("result", {})
    finally:
        db.close()
    out_dir = Path(settings.artifact_dir) / user.id
    out_dir.mkdir(parents=True, exist_ok=True)
    if format == "json":
        p = out_dir / f"contexttrace-{job_id}.json"
        p.write_text(json.dumps({"job": summary, "result": result}, indent=2, default=str), encoding="utf-8")
        return FileResponse(p, media_type="application/json", filename=p.name)
    from ..services.report_pdf import build_report_pdf

    p = out_dir / f"contexttrace-{job_id}.pdf"
    build_report_pdf(p, summary, result)
    return FileResponse(p, media_type="application/pdf", filename=p.name)
