"""Runtime evidence-tampering comparison (service 2).

compare(path_a, path_b) -> report-ready dict containing
  * AI-generation analysis of each video (service 1 applied to both)
  * relationship: derived / unrelated / identical
  * verdict: which video is the original and which is tampered (+ confidence)
  * a list of located tampering events in plain language
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from . import detector
from . import features as F
from . import tamper as T

ROOT = Path(__file__).resolve().parents[3]
MODEL_PATH = Path(os.getenv("CTXTRACE_TAMPER_MODEL", ROOT / "data" / "models" / "tamper_model.joblib"))
_lock = threading.Lock()
_model: dict | None = None


def load_model() -> dict:
    global _model
    with _lock:
        if _model is None:
            import joblib

            if not MODEL_PATH.exists():
                raise RuntimeError("Tamper model not found. Run `python start.py --train`.")
            _model = joblib.load(MODEL_PATH)
        return _model


def _fmt(t: float) -> str:
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def _frame_probs(ai: dict, t: T.Track) -> np.ndarray:
    ff = F.FrameFeatures(times=list(t.times), forensic=t.forensic, temporal=t.temporal, clip=t.clip)
    return ai["frame_model"].predict_proba(F.frame_matrix(ff, tuple(ai["frame_families"])))[:, 1]


def _detect_from_track(t: T.Track, path: Path) -> dict:
    from . import video_io

    ff = F.FrameFeatures(times=list(t.times), forensic=t.forensic, temporal=t.temporal, clip=t.clip)
    meta = {"duration": t.duration, "fps": t.fps, "width": t.width, "height": t.height, "codec": "-", "has_audio": video_io.has_audio_stream(path)}
    try:
        meta["codec"] = video_io.probe(path)["codec"]
    except Exception:
        pass
    out = detector.analyze_features(ff, meta, t.frames, list(t.times))
    out.pop("_ff", None)
    return out


def _events(pa: T.PairAnalysis, tampered: str, fp: dict) -> list[dict]:
    """Translate structural findings into role-based events (tampered vs original)."""
    out = []
    tam_t = pa.b if tampered == "b" else pa.a
    org_t = pa.a if tampered == "b" else pa.b
    for e in pa.events:
        side = e["side"]
        if e["kind"] == "unmatched":
            dur = e["end"] - e["start"]
            if side == tampered:
                probs = fp[side][e["frames"]]
                ai_p = float(probs.mean()) if len(probs) else 0.0
                kind = "AI-generated insertion" if ai_p >= 0.6 else "Inserted / replaced footage"
                out.append({"type": "inserted_segment", "title": kind, "in": "tampered", "start": round(e["start"], 2), "end": round(e["end"], 2),
                            "severity": "high" if dur >= 1.0 else "medium", "aiProbability": round(ai_p * 100, 1),
                            "description": f"{dur:.1f}s of footage at {_fmt(e['start'])}-{_fmt(e['end'])} in the tampered video does not exist anywhere in the original" +
                                           (f" and looks AI-generated ({ai_p:.0%})." if ai_p >= 0.6 else ".")})
            else:
                out.append({"type": "removed_segment", "title": "Removed footage", "in": "original", "start": round(e["start"], 2), "end": round(e["end"], 2),
                            "severity": "high" if dur >= 1.0 else "medium",
                            "description": f"{dur:.1f}s of the original ({_fmt(e['start'])}-{_fmt(e['end'])}) is missing from the tampered video."})
        elif e["kind"] in ("jump_cut", "cut") and side == tampered:
            out.append({"type": "edit_cut", "title": "Edit point / jump cut", "in": "tampered", "start": round(e["time"], 2), "end": round(e["time"], 2), "severity": "medium",
                        "description": f"Hard cut at {_fmt(e['time'])} in the tampered video with no matching cut in the original."})
    tm = pa.metrics_b if tampered == "b" else pa.metrics_a
    if tm["disorder"] > 0.05:
        out.append({"type": "reordered", "title": "Re-ordered footage", "in": "tampered", "severity": "high",
                    "description": f"{tm['disorder']:.0%} of matched footage plays in a different order than in the original."})
    structural = any(e["type"] in ("inserted_segment", "removed_segment", "edit_cut") for e in out) or tm["disorder"] > 0.05
    # around cuts/inserts, slightly offset frame pairs can create a weak "region"; require persistence then
    if pa.region.get("found") and (not structural or pa.region.get("persistence", 0) >= 0.5):
        x, y, w, h = pa.region["bbox"]
        H, W = pa.region["frame_shape"]
        out.append({"type": "in_frame_edit", "title": "In-frame manipulation", "in": "tampered", "severity": "high",
                    "bbox": {"x": round(x / W, 3), "y": round(y / H, 3), "w": round(w / W, 3), "h": round(h / H, 3)},
                    "description": f"A localised region ({pa.region['area']:.1%} of the frame) differs between the two videos while the rest of the frame is identical - "
                                   "consistent with object removal, cloning, or an added caption/overlay."})
    dt, do = tam_t.duration, org_t.duration
    if do - dt >= 0.15:
        from .temporal_localization import localize_single_deletion

        localized = localize_single_deletion(Path(org_t.path), Path(tam_t.path))
        if localized["localized"]:
            # Prefer a supported dense estimate over coarse unmatched-sample
            # bounds. This changes event reporting only, never direction inputs.
            out = [e for e in out if e["type"] != "removed_segment"]
            out.append({"type": "removed_segment", "title": "Removed footage", "in": "original", "severity": "high",
                        "start": round(localized["start"], 3), "end": round(localized["end"], 3), "localization": localized,
                        "description": f"Estimated removed interval {_fmt(localized['start'])}-{_fmt(localized['end'])} in the original; boundary resolution approximately {localized['boundary_resolution_seconds']:.2f}s under a single-deletion hypothesis."})
        elif not any(e["type"] == "removed_segment" for e in out):
            out.append({"type": "shortened", "title": "Footage removed", "in": "tampered", "severity": "high", "localization": localized,
                        "description": f"The modified copy is {do - dt:.1f}s shorter ({dt:.1f}s vs {do:.1f}s). Its exact removed interval cannot be established reliably: {localized['reason']}"})
    sp = pa.speed_ratio if tampered == "b" else 1.0 / max(pa.speed_ratio, 1e-3)
    if abs(np.log(max(sp, 1e-3))) > 0.15:
        out.append({"type": "speed_change", "title": "Playback speed altered", "in": "tampered", "severity": "medium",
                    "description": f"The tampered video plays at about {sp:.2f}x the speed of the original."})
    om = pa.metrics_a if tampered == "b" else pa.metrics_b
    if tm["lapvar"] < om["lapvar"] - 0.25 or tm["bpp"] < om["bpp"] - 0.4:
        out.append({"type": "re_encoded", "title": "Extra compression generation", "in": "tampered", "severity": "low",
                    "description": "The tampered copy is softer / more compressed than the original, consistent with being decoded, edited and re-encoded."})
    return out


def compare(path_a: Path, path_b: Path, names: tuple[str, str] = ("Video A", "Video B")) -> dict[str, Any]:
    t0 = time.time()
    ai = detector.load_model()
    tm = load_model()
    ta, tb = T.load_track(path_a), T.load_track(path_b)
    # service-1 analysis re-uses the frames/features already extracted for alignment (no second decode)
    det_a = _detect_from_track(ta, path_a); det_b = _detect_from_track(tb, path_b)
    pa = T.analyse_pair(ta, tb)
    fpa, fpb = _frame_probs(ai, ta), _frame_probs(ai, tb)
    T.set_ai_evidence(pa, float(fpa.mean()), float(fpb.mean()), fpa, fpb)
    x = T.direction_vector(pa).reshape(1, -1)
    m = tm["model"]
    p_b = float(0.5 * (m.predict_proba(x)[0, 1] + 1 - m.predict_proba(-x)[0, 1]))
    result: dict[str, Any] = {
        "videos": {"a": {"name": names[0], "ai": det_a}, "b": {"name": names[1], "ai": det_b}},
        "coverage": {"aInB": round(pa.coverage_a_in_b * 100, 1), "bInA": round(pa.coverage_b_in_a * 100, 1)},
        "model": {"version": tm["version"], "classifier": tm["name"], "cvAccuracy": tm.get("cv_accuracy"), "cvAuc": tm.get("cv_auc")},
    }
    a_ai, b_ai = det_a["verdict"] == "ai_generated", det_b["verdict"] == "ai_generated"
    if not pa.related:
        result.update(relationship="unrelated", verdict="unrelated", original=None, tampered=None, confidence=round(1 - max(pa.coverage_a_in_b, pa.coverage_b_in_a), 3),
                      summary="The two videos share almost no footage, so neither can be shown to be an edited copy of the other. Each video's AI analysis is reported independently.",
                      events=[])
        if a_ai != b_ai:
            real, fake = ("a", "b") if b_ai else ("b", "a")
            result["summary"] += f" Note: {result['videos'][fake]['name']} is classified as AI-generated while {result['videos'][real]['name']} is classified as authentic."
            result["likelyGenuine"] = real
    elif pa.identical:
        result.update(relationship="identical", verdict="no_tampering", original=None, tampered=None, confidence=0.9,
                      summary="Both videos contain the same footage frame-for-frame with no inserted, removed, re-ordered or locally edited content. No tampering detected between them.",
                      events=[])
    else:
        tampered = "b" if p_b >= 0.5 else "a"
        original = "a" if tampered == "b" else "b"
        conf = abs(p_b - 0.5) * 2
        events = _events(pa, tampered, {"a": fpa, "b": fpb})
        ev_titles = ", ".join(sorted({e["title"].lower() for e in events if e["severity"] != "low"})) or "subtle re-processing"
        result.update(relationship="derived", verdict="tampered", original=original, tampered=tampered, confidence=round(conf, 3),
                      probabilityBTampered=round(p_b * 100, 1),
                      summary=f"{result['videos'][original]['name']} is the original; {result['videos'][tampered]['name']} is a tampered derivative ({ev_titles}).",
                      events=events)
    # per-video originality: probability that this file is the unaltered original
    # (A is the original exactly when B is the tampered one)
    if result["verdict"] == "tampered":
        result["videos"]["a"]["originality"] = round(100 * p_b, 1)
        result["videos"]["b"]["originality"] = round(100 * (1 - p_b), 1)
    else:
        for k in ("a", "b"):
            result["videos"][k]["originality"] = None
    result["timing"] = {"total": round(time.time() - t0, 2)}
    return result
