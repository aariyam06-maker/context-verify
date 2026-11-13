from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import admin, auth, jobs, videos
from .config import settings
from .db import init_db

if os.getenv("CTXTRACE_AUTO_CREATE_DB", "true").lower() == "true":
    init_db()
auth.seed_demo_accounts()

app = FastAPI(title="ContextTrace API", version="4.0.0",
              description="AI-generated video detection and two-video evidence-tampering analysis.")
app.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins), allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.include_router(auth.router, prefix="/api")
app.include_router(videos.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(admin.router, prefix="/api")


@app.get("/api/health")
def health():
    from .ml import detector, tamper_service

    return {"ok": True, "service": "contexttrace-api", "version": "4.0.0",
            "models": {"aiDetector": detector.model_available(), "tamper": tamper_service.MODEL_PATH.exists()},
            "gemini": bool(os.getenv("GEMINI_API_KEY"))}


@app.get("/api/models/summary")
def models_summary():
    """Public headline metrics of the shipped models (from the training experiment records)."""
    import json

    from .config import ROOT

    out = {}
    p = ROOT / "data" / "models" / "experiments.json"
    if p.exists():
        e = json.loads(p.read_text(encoding="utf-8"))
        out["ai"] = {"version": e.get("version"), "selected": e.get("selected"), "trainVideos": e.get("n_train_videos"),
                     "cvAccuracy": e.get("cv_selected", {}).get("accuracy"), "cvAuc": e.get("cv_selected", {}).get("auc"),
                     "oodAccuracy": e.get("ood", {}).get("overall_clean", {}).get("accuracy"), "oodAuc": e.get("ood", {}).get("overall_clean", {}).get("auc"),
                     "sources": len(e.get("sources", {}))}
    p = ROOT / "data" / "models" / "tamper_experiments.json"
    if p.exists():
        e = json.loads(p.read_text(encoding="utf-8"))
        out["tamper"] = {"version": e.get("version"), "selected": e.get("selected"), "pairs": e.get("n_pairs"),
                         "cvAccuracy": e.get("comparison", {}).get(e.get("selected"), {}).get("accuracy")}
    p = ROOT / "data" / "models" / "acceptance_tests.json"
    if p.exists():
        out["acceptance"] = json.loads(p.read_text(encoding="utf-8")).get("summary")
    return out
