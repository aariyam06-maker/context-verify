from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from pydantic import BaseModel, Field

from ..auth import admin_user
from ..db import SessionLocal
from ..models import AnalysisJob, Report, User, Video

router = APIRouter(prefix="/admin", tags=["admin"])


def ms(dt): return int(dt.timestamp() * 1000) if dt else None

@router.get("/overview")
def overview(_: User = Depends(admin_user)):
    db = SessionLocal()
    try:
        users = db.scalars(select(User).order_by(User.created_at.desc()).limit(100)).all()
        jobs = db.scalars(select(AnalysisJob).order_by(AnalysisJob.created_at.desc()).limit(100)).all()
        stats = {
            "users": len(users),
            "jobs": len(jobs),
            "running": sum(j.status in {"RUNNING", "QUEUED"} for j in jobs),
            "degraded": sum(j.status == "DEGRADED" for j in jobs),
            "failed": sum(j.status == "FAILED" for j in jobs),
            "completed": sum(j.status == "COMPLETED" for j in jobs),
        }
        rows = []
        for j in jobs:
            owner = db.get(User, j.owner_id)
            source = db.get(Video, j.source_video_id) if j.source_video_id else None
            edited = db.get(Video, j.edited_video_id) if j.edited_video_id else None
            report = db.scalar(select(Report).where(Report.job_id == j.id))
            rows.append({"_id": j.id, "status": j.status, "currentStage": j.current_stage, "progress": j.progress, "createdAt": ms(j.created_at), "completedAt": ms(j.completed_at), "errorMessage": j.error_message, "warnings": j.warnings or [], "ownerEmail": owner.email if owner else "—", "sourceFilename": source.filename if source else "—", "editedFilename": edited.filename if edited else "—", "score": report.score if report else None})
        user_rows = [{"_id": u.id, "email": u.email, "name": None, "role": u.role, "createdAt": ms(u.created_at)} for u in users]
        return {"stats": stats, "jobs": rows, "users": user_rows}
    finally:
        db.close()


class RoleUpdate(BaseModel):
    role: str = Field(pattern="^(user|admin)$")

@router.patch("/users/{user_id}/role")
def update_role(user_id: str, payload: RoleUpdate, admin: User = Depends(admin_user)):
    db = SessionLocal()
    try:
        target = db.get(User, user_id)
        if not target:
            raise HTTPException(404, "User not found.")
        if target.id == admin.id and payload.role != "admin":
            raise HTTPException(400, "You cannot remove your own administrator role.")
        target.role = payload.role
        db.commit()
        return {"ok": True, "userId": target.id, "role": target.role}
    finally:
        db.close()

@router.get("/models")
def model_registry(_: User = Depends(admin_user)):
    import json
    from ..config import ROOT
    out = {}
    for name in ("experiments", "tamper_experiments"):
        p = ROOT / "data" / "models" / f"{name}.json"
        if p.exists():
            out[name] = json.loads(p.read_text(encoding="utf-8"))
    return out
