import sys
from pathlib import Path
from types import SimpleNamespace
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.services import media
from app import config

def test_duration_limit(monkeypatch):
    monkeypatch.setattr(media, "probe", lambda _: {"duration": 61, "width": 320, "height": 240})
    monkeypatch.setattr(config, "settings", SimpleNamespace(max_duration_seconds=60))
    with pytest.raises(ValueError, match="60 second"):
        media.probe_media(Path("unused.mp4"))

def test_resolution_limit(monkeypatch):
    monkeypatch.setattr(media, "probe", lambda _: {"duration": 1, "width": 8192, "height": 240})
    with pytest.raises(ValueError, match="4096"):
        media.probe_media(Path("unused.mp4"))

def test_detection_uses_union_of_classifier_families(monkeypatch):
    from app.ml import detector
    import numpy as np
    frames = [np.zeros((32, 32, 3), dtype=np.uint8)]
    monkeypatch.setattr(detector, "load_model", lambda: {"families": ["forensic"], "frame_families": ["clip"]})
    monkeypatch.setattr(detector.video_io, "probe", lambda _: {})
    called = {}
    def sample(*a, **kw):
        called.update(kw); return frames, frames, [0.], 25
    def features(*a, **kw):
        called.update(kw); return object()
    monkeypatch.setattr(detector.video_io, "read_sampled", sample)
    monkeypatch.setattr(detector.F, "features_from_pairs", features)
    monkeypatch.setattr(detector, "analyze_features", lambda *a: {})
    detector.analyze(Path("unused.mp4"), mode="light")
    assert called["k"] == 8 and called["use_clip"] is True and called["use_dino"] is False


def test_oversized_upload_closes_writer_and_removes_partial_file(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth import current_user
    from app.api import videos
    monkeypatch.setattr(videos, "settings", SimpleNamespace(upload_dir=tmp_path, max_upload_mb=1))
    app.dependency_overrides[current_user] = lambda: SimpleNamespace(id="limit-test")
    try:
        with TestClient(app) as client:
            response = client.post("/api/videos/upload", files={"file": ("oversize.mp4", b"x" * (1024 * 1024 + 1), "video/mp4")})
        assert response.status_code == 413
        assert "1 MB" in response.json()["detail"]
        assert not list(tmp_path.rglob("*.mp4"))
    finally:
        app.dependency_overrides.pop(current_user, None)
