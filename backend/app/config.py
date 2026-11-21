from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    app_name: str = "ContextTrace API"
    database_url: str = os.getenv("DATABASE_URL", f"sqlite:///{ROOT / 'data' / 'contexttrace.db'}")
    secret_key: str = os.getenv("CTXTRACE_SECRET_KEY", "")
    access_token_minutes: int = int(os.getenv("CTXTRACE_ACCESS_TOKEN_MINUTES", "20"))
    refresh_token_days: int = int(os.getenv("CTXTRACE_REFRESH_TOKEN_DAYS", "14"))
    cookie_secure: bool = os.getenv("CTXTRACE_COOKIE_SECURE", "false").lower() == "true"
    max_upload_mb: int = int(os.getenv("CTXTRACE_MAX_UPLOAD_MB", "100"))
    max_duration_seconds: float = float(os.getenv("CTXTRACE_MAX_DURATION_SECONDS", "60"))
    allowed_origins: tuple[str, ...] = tuple(x.strip() for x in os.getenv("CTXTRACE_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174").split(",") if x.strip())
    upload_dir: Path = ROOT / "data" / "uploads"
    artifact_dir: Path = ROOT / "data" / "artifacts"
    pipeline_version: str = "ctxtrace-engine v3.0.0"
    model_configuration: str = "data/models/ai_detector.joblib and tamper_model.joblib"


settings = Settings()
if not settings.secret_key:
    # Development only. Production startup is blocked by main.py when this
    # value is unchanged/empty so secrets are never silently deployed.
    settings = Settings(secret_key="development-only-contexttrace-secret")
settings.upload_dir.mkdir(parents=True, exist_ok=True)
settings.artifact_dir.mkdir(parents=True, exist_ok=True)
