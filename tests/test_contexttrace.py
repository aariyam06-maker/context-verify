"""ContextTrace v4 test-suite: API, auth/demo login, ML building blocks, end-to-end jobs."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(ROOT / 'data' / 'test_contexttrace.db').as_posix()}")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.ml import features as F  # noqa: E402
from app.ml import tamper as T  # noqa: E402
from app.ml import tamper_synth as S  # noqa: E402
from app.ml import video_io  # noqa: E402

MODELS_READY = (ROOT / "data/models/ai_detector.joblib").exists() and (ROOT / "data/models/tamper_model.joblib").exists()


def synthetic_frames(n=90, w=320, h=240, seed=0):
    rng = np.random.default_rng(seed)
    base = (rng.random((h * 2, w * 2, 3)) * 255).astype(np.uint8)
    import cv2

    base = cv2.GaussianBlur(base, (0, 0), 4)
    return [np.ascontiguousarray(base[i: i + h, i: i + w]) for i in range(n)]


@pytest.fixture(scope="session")
def clip(tmp_path_factory):
    p = tmp_path_factory.mktemp("v") / "clip.mp4"
    return video_io.write_video(synthetic_frames(), 30.0, p, crf=18)


@pytest.fixture(scope="session")
def client():
    return TestClient(app)


@pytest.fixture(scope="session")
def auth(client):
    r = client.post("/api/auth/login", json={"email": "demo@contexttrace.app", "password": "DemoTrace@2026"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ------------------------------------------------------------------ API & auth
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_default_frontend_origin_allowed(client):
    response = client.options("/api/videos/upload", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_demo_accounts_listed(client):
    d = client.get("/api/auth/demo").json()
    assert d["enabled"] and {a["email"] for a in d["accounts"]} == {"demo@contexttrace.app", "admin@contexttrace.app"}


def test_demo_admin_login_has_admin_role(client):
    r = client.post("/api/auth/login", json={"email": "admin@contexttrace.app", "password": "AdminTrace@2026"})
    assert r.status_code == 200 and r.json()["user"]["role"] == "admin"


def test_wrong_password_rejected(client):
    assert client.post("/api/auth/login", json={"email": "demo@contexttrace.app", "password": "wrong-password-123"}).status_code == 401


def test_jobs_require_auth(client):
    assert client.get("/api/jobs").status_code == 401


def test_invalid_sampling_mode_rejected(client, auth):
    response = client.post("/api/jobs/detect", params={"videoId": "missing", "inferenceMode": "invalid"}, headers=auth)
    assert response.status_code == 422


def test_rejects_non_video_upload(client, auth, tmp_path):
    p = tmp_path / "notes.txt"; p.write_text("hello")
    with p.open("rb") as fh:
        r = client.post("/api/videos/upload", headers=auth, files={"file": ("notes.txt", fh, "text/plain")}, data={"type": "detect"})
    assert r.status_code == 400


def test_upload_and_probe(client, auth, clip):
    with clip.open("rb") as fh:
        r = client.post("/api/videos/upload", headers=auth, files={"file": ("clip.mp4", fh, "video/mp4")}, data={"type": "detect"})
    assert r.status_code == 200, r.text
    assert 2.5 < r.json()["durationSeconds"] < 3.5 and r.json()["width"] == 320


# ------------------------------------------------------------------ ML building blocks
def test_probe_and_sampling(clip):
    meta = video_io.probe(clip)
    assert meta["frames"] == 90 and abs(meta["fps"] - 30) < 0.1
    frames, nexts, times, fps = video_io.read_sampled(clip, k=8)
    assert len(frames) == 8 and len(nexts) == 8 and times == sorted(times)


def test_forensic_features_are_finite():
    f = synthetic_frames(3)
    v = F.forensic_frame(f[0]); t = F.temporal_pair(f[0], f[1])
    assert v.shape == (len(F.FORENSIC_NAMES),) and t.shape == (len(F.TEMPORAL_NAMES),)
    assert np.isfinite(v).all() and np.isfinite(t).all()


def test_tamper_ops_change_video():
    fr = synthetic_frames(60)
    rng = np.random.default_rng(1)
    for op in S.OPS:
        res = S.tamper(fr, 30.0, rng, ops=[op], foreign=synthetic_frames(60, seed=5), ai_foreign=synthetic_frames(60, seed=9))
        changed = len(res.frames) != len(fr) or any(not np.array_equal(a, b) for a, b in zip(res.frames, fr))
        assert changed, op


def test_identical_videos_detected_identical(clip):
    a = T.load_track(clip); b = T.load_track(clip)
    pa = T.analyse_pair(a, b)
    assert pa.related and pa.identical and pa.coverage_a_in_b > 0.97


def test_direction_vector_is_antisymmetric(clip, tmp_path):
    fr, fps = video_io.read_frames(clip)
    cut = fr[:30] + fr[60:]
    p2 = video_io.write_video(cut, fps, tmp_path / "cut.mp4", crf=24)
    a, b = T.load_track(clip), T.load_track(p2)
    v_ab = T.direction_vector(T.analyse_pair(a, b)); v_ba = T.direction_vector(T.analyse_pair(b, a))
    assert np.allclose(v_ab, -v_ba, atol=1e-4)


# ------------------------------------------------------------------ end-to-end (needs trained models)
def _wait(client, auth, job):
    for _ in range(600):
        j = client.get(f"/api/jobs/{job}", headers=auth).json()
        if j["status"] in ("COMPLETED", "FAILED"):
            return j
        time.sleep(0.5)
    raise TimeoutError


@pytest.mark.skipif(not MODELS_READY, reason="models not trained")
@pytest.mark.parametrize("inference_mode", ["full", "light"])
def test_detect_job_end_to_end(client, auth, clip, inference_mode):
    with clip.open("rb") as fh:
        vid = client.post("/api/videos/upload", headers=auth, files={"file": ("clip.mp4", fh, "video/mp4")}, data={"type": "detect"}).json()["videoId"]
    job = client.post(f"/api/jobs/detect?videoId={vid}&inferenceMode={inference_mode}", headers=auth).json()["jobId"]
    assert _wait(client, auth, job)["status"] == "COMPLETED"
    res = client.get(f"/api/jobs/{job}/report", headers=auth).json()["result"]
    assert 0 <= res["aiProbability"] <= 100 and 0 <= res["aiContentShare"] <= 100 and res["timeline"]
    assert res["inferenceMode"] == inference_mode
    assert res["media"]["framesAnalysed"] == (8 if inference_mode == "light" else 16)
    pdf = client.get(f"/api/jobs/{job}/report/download?format=pdf", headers=auth)
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"


@pytest.mark.skipif(not MODELS_READY, reason="models not trained")
def test_tamper_job_identifies_cut_copy(client, auth, clip, tmp_path):
    fr, fps = video_io.read_frames(clip)
    p2 = video_io.write_video(fr[:25] + fr[55:], fps, tmp_path / "edited.mp4", crf=28)
    ids = []
    for p, kind in ((p2, "a"), (clip, "b")):
        with p.open("rb") as fh:
            ids.append(client.post("/api/videos/upload", headers=auth, files={"file": (p.name, fh, "video/mp4")}, data={"type": kind}).json()["videoId"])
    job = client.post(f"/api/jobs/tamper?videoAId={ids[0]}&videoBId={ids[1]}", headers=auth).json()["jobId"]
    assert _wait(client, auth, job)["status"] == "COMPLETED"
    res = client.get(f"/api/jobs/{job}/report", headers=auth).json()["result"]
    assert res["verdict"] == "tampered" and res["tampered"] == "a" and res["original"] == "b"
