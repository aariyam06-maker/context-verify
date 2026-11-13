"""ContextTrace developer dashboard (default port 3751).

Live view for the developer: model metrics & research evidence (from the
training experiment JSON files), acceptance-test results, and live job runs
read straight from the application database. Local-only, read-only.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.db import SessionLocal  # noqa: E402
from app.models import AnalysisJob, Report, User, Video  # noqa: E402

MODELS = ROOT / "data" / "models"
STARTED = time.time()
API = os.getenv("CTXTRACE_API_INTERNAL", "http://127.0.0.1:8000/api")

app = FastAPI(title="ContextTrace Dev Dashboard")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


def _json(name: str):
    p = MODELS / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


@app.get("/", response_class=HTMLResponse)
def index():
    return FileResponse(HERE / "index.html")


@app.get("/api/models")
def models():
    exp = _json("experiments.json")
    if exp:  # trim large arrays not needed by the UI
        exp = {k: v for k, v in exp.items() if k != "ood" or True}
    files = {p.name: {"bytes": p.stat().st_size, "modified": datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat()} for p in MODELS.glob("*") if p.is_file()}
    return {"ai": exp, "tamper": _json("tamper_experiments.json"), "acceptance": _json("acceptance_tests.json"), "files": files}


@app.get("/api/live")
def live():
    import psutil

    db = SessionLocal()
    try:
        jobs = db.query(AnalysisJob).filter(AnalysisJob.mode.in_(["detect", "tamper"])).order_by(AnalysisJob.created_at.desc()).limit(200).all()
        users = db.query(User).count()
        videos = db.query(Video).count()
        runs = []
        for j in jobs:
            rep = db.query(Report).filter(Report.job_id == j.id).first()
            res = (rep.report_json or {}).get("result", {}) if rep else {}
            owner = db.get(User, j.owner_id)
            dur = (j.completed_at - j.started_at).total_seconds() if j.completed_at and j.started_at else None
            row = {"id": j.id, "mode": j.mode, "status": j.status, "stage": j.current_stage, "progress": j.progress, "owner": owner.email if owner else "?",
                   "created": j.created_at.isoformat() if j.created_at else None, "seconds": dur, "error": j.error_message}
            if j.mode == "detect" and res:
                row.update(aiProbability=res.get("aiProbability"), aiShare=res.get("aiContentShare"), verdict=res.get("verdict"), confidence=res.get("confidence"),
                           timing=res.get("timing"), model=res.get("model", {}).get("version"), file=db.get(Video, j.source_video_id).filename if j.source_video_id else None)
            elif j.mode == "tamper" and res:
                row.update(verdict=res.get("verdict"), original=res.get("original"), tampered=res.get("tampered"), confidence=res.get("confidence"),
                           events=len(res.get("events", [])), model=res.get("model", {}).get("version"),
                           aiA=res.get("videos", {}).get("a", {}).get("ai", {}).get("aiProbability"), aiB=res.get("videos", {}).get("b", {}).get("ai", {}).get("aiProbability"))
            runs.append(row)
    finally:
        db.close()
    try:
        with urllib.request.urlopen(f"{API}/health", timeout=2) as r:
            api_health = json.loads(r.read().decode())
    except Exception as exc:
        api_health = {"ok": False, "error": type(exc).__name__}
    vm = psutil.virtual_memory()
    return {"now": datetime.now(timezone.utc).isoformat(), "uptime": round(time.time() - STARTED), "api": api_health, "users": users, "videos": videos,
            "system": {"cpu": psutil.cpu_percent(interval=None), "ramUsedGb": round(vm.used / 1e9, 2), "ramTotalGb": round(vm.total / 1e9, 2), "ramPct": vm.percent},
            "runs": runs}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("CTXTRACE_DEV_PORT", "3751")))
