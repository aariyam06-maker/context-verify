from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.services.engine import align, compute_score, run_analysis


def test_alignment_and_context_engine():
    source = [
        {"index": 0, "startTime": 0, "endTime": 4, "text": "The project remains within budget at most sites.", "confidence": .95},
        {"index": 1, "startTime": 5, "endTime": 10, "text": "Two sites exceeded the target during August.", "confidence": .95},
        {"index": 2, "startTime": 11, "endTime": 20, "text": "The team expects the readings to normalize after rainfall.", "confidence": .93},
    ]
    edited = [source[1], source[0]]
    edited = [dict(x, index=i, startTime=i * 5, endTime=i * 5 + 4) for i, x in enumerate(edited)]
    mappings = align(source, edited)
    assert len(mappings) == 2
    result = run_analysis(source, edited, True, True)
    assert 0 <= result["score"] <= 100
    assert result["events"]


def test_score_is_bounded():
    score, high = compute_score([])
    assert score == 100
    assert high == 0


def test_health_and_auth_flow():
    client = TestClient(app)
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["ok"] is True

    email = "test-contexttrace@example.com"
    password = "correct-horse-battery-staple"
    register = client.post("/api/auth/register", json={"email": email, "password": password})
    assert register.status_code in {200, 409}
    login = client.post("/api/auth/login", json={"email": email, "password": password})
    assert login.status_code == 200
    assert login.json()["access_token"]
    refresh = client.post("/api/auth/refresh")
    assert refresh.status_code == 200
    assert refresh.json()["access_token"]
    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    assert client.post("/api/auth/refresh").status_code == 401


def test_ai_detector_pipeline_without_external_weights(tmp_path, monkeypatch):
    import cv2
    import numpy as np
    from backend.app.services import ai_detector

    video = tmp_path / "sample.mp4"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 8.0, (320, 240))
    for i in range(24):
        frame = np.full((240, 320, 3), 40 + i * 2, dtype=np.uint8)
        cv2.putText(frame, "ContextTrace", (30, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (220, 220, 220), 2)
        writer.write(frame)
    writer.release()

    monkeypatch.setattr(ai_detector, "_predict", lambda model_id, images: [0.72 if "GenD" in model_id else 0.61] * len(images))
    result = ai_detector.analyze_video(video, 3.0)
    assert 0 <= result["aiScore"] <= 100
    assert result["scoreType"] == "uncalibrated_ai_artifact_index"
    assert result["analyzedFrames"] >= 6
    assert result["components"]
    assert "modelRegistry" in result


def test_public_registration_cannot_create_admin():
    from sqlalchemy import select
    from backend.app.db import SessionLocal
    from backend.app.models import User
    client = TestClient(app)
    email = "admin-like-contexttrace@example.com"
    response = client.post("/api/auth/register", json={"email": email, "password": "long-secure-password-123"})
    assert response.status_code in {200, 409}
    db = SessionLocal()
    try:
        user = db.scalar(select(User).where(User.email == email))
        assert user is not None
        assert user.role == "user"
    finally:
        db.close()


def test_guest_signup_creates_persisted_account():
    client = TestClient(app)
    response = client.post("/api/auth/guest")
    assert response.status_code == 200
    payload = response.json()
    assert payload["access_token"]
    assert payload["user"]["email"].endswith("@trial.contexttrace.local")
    assert payload["user"]["role"] == "user"


def test_calibration_is_explicit(tmp_path, monkeypatch):
    import json
    from backend.app.services.calibration import apply_calibration, load_calibration
    path = tmp_path / "calibration.json"
    path.write_text(json.dumps({"schemaVersion": 1, "method": "platt", "a": 8.0, "b": -4.0}), encoding="utf-8")
    monkeypatch.setenv("CTXTRACE_CALIBRATION_PATH", str(path))
    payload = load_calibration()
    probability = apply_calibration(0.75, payload)
    assert probability is not None
    assert 0 < probability < 1
