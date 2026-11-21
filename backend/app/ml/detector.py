"""Runtime AI-generation detector (service 1) used by the API.

Loads the trained artifact `data/models/ai_detector.joblib` (produced by
tools/ml/train_ai_detector.py) and returns a report-ready dictionary:

  aiProbability    calibrated probability that the video is AI-generated
  aiContentShare   % of the analysed timeline whose frames are classified AI
  verdict          'ai_generated' | 'authentic' (+ confidence band)
  timeline         per-frame probabilities
  evidence         plain-language forensic reasons
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from . import features as F
from . import video_io

ROOT = Path(__file__).resolve().parents[3]
MODEL_PATH = Path(os.getenv("CTXTRACE_AI_MODEL", ROOT / "data" / "models" / "ai_detector.joblib"))
FRAMES = int(os.getenv("CTXTRACE_AI_FRAMES", "16"))
MAX_SECONDS = float(os.getenv("CTXTRACE_MAX_SECONDS", "10"))

_lock = threading.Lock()
_model: dict | None = None

EXPLAIN = {
    "res_tcorr": ("Sensor-noise temporal correlation", "Camera sensor noise is random from frame to frame; generated video tends to carry smooth, correlated noise."),
    "res_tcorr_hi": ("Fine-grain noise correlation", "Fine noise residuals repeat across frames more than real sensor noise does."),
    "warp_err_norm": ("Motion-compensated consistency", "How well one frame predicts the next after optical-flow warping; generated motion is often unnaturally smooth or inconsistent."),
    "spec_slope": ("Frequency-spectrum fall-off", "Natural images follow a characteristic 1/f spectrum; diffusion up-samplers change the high-frequency slope."),
    "spec_hf_ratio": ("High-frequency energy", "Share of image energy in fine detail; generators tend to under- or over-produce fine detail."),
    "spec_peakiness": ("Periodic spectral peaks", "Up-sampling layers leave periodic peaks in the 2-D spectrum."),
    "res_std": ("Noise residual strength", "Strength of pixel-level noise left after denoising."),
    "res_kurt": ("Noise distribution shape", "Real sensor noise has a different statistical shape than synthetic texture."),
    "res_rg_corr": ("Cross-channel noise coupling", "Camera demosaicing couples R/G noise in a specific way that generators do not reproduce."),
    "res_rb_corr": ("Cross-channel noise coupling (R/B)", "Demosaicing signature between red and blue channels."),
    "lap_logvar": ("Sharpness profile", "Variance of the Laplacian (overall crispness)."),
    "sat_mean": ("Colour saturation", "Generated footage is often more saturated / stylised."),
    "sat_std": ("Saturation variability", "Spread of colour saturation within a frame."),
    "smooth_frac": ("Texture-free area", "Fraction of the frame with almost no texture (plastic-looking surfaces)."),
    "texture_lbp_entropy": ("Micro-texture richness", "Entropy of local binary patterns; real scenes have richer micro-texture."),
    "flow_smooth": ("Motion-field smoothness", "Spatial smoothness of the optical-flow field."),
    "frame_diff": ("Frame-to-frame change", "Average pixel change between consecutive frames."),
    "chroma_noise": ("Chroma noise", "Colour noise level (real low-light footage has more)."),
    "blockiness": ("Compression blockiness", "8x8 block artefacts from codecs."),
    "edge_density": ("Edge density", "Proportion of strong edges."),
}


def model_available() -> bool:
    return MODEL_PATH.exists()


def load_model() -> dict:
    global _model
    with _lock:
        if _model is None:
            import joblib

            if not MODEL_PATH.exists():
                raise RuntimeError("AI detector model not found. Run `python start.py --train` (or tools/ml/train_ai_detector.py).")
            _model = joblib.load(MODEL_PATH)
        return _model


def _platt(p: np.ndarray, ab) -> np.ndarray:
    z = np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
    return 1 / (1 + np.exp(-(ab[0] * z + ab[1])))


def score_features(ff: F.FrameFeatures, m: dict | None = None) -> dict[str, Any]:
    m = m or load_model()
    fams = tuple(m["families"])
    vec = F.video_vector(ff, fams).reshape(1, -1)
    p_raw = float(m["video_model"].predict_proba(vec)[0, 1])
    p = float(_platt(np.array([p_raw]), m["platt"])[0])
    fm = F.frame_matrix(ff, tuple(m["frame_families"]))
    fp = m["frame_model"].predict_proba(fm)[:, 1]
    # blend local evidence with the global decision for a stable per-frame label
    blended = 0.5 * fp + 0.5 * p
    if len(blended) >= 3:
        sm = blended.copy()
        sm[1:-1] = np.median(np.stack([blended[:-2], blended[1:-1], blended[2:]]), axis=0)
        blended = sm
    share = float((blended >= 0.5).mean())
    return {"p": p, "p_raw": p_raw, "frame_probs": fp, "blended": blended, "share": share}


def explain(ff: F.FrameFeatures, m: dict, is_ai: bool, top: int = 5) -> list[dict]:
    names = m["forensic_names"]
    x = F.video_vector(ff, ("forensic", "temporal"))
    lr = m["forensic_model"].named_steps["clf"]
    sc = m["forensic_model"].named_steps["sc"]
    z = (x - sc.mean_) / sc.scale_
    contrib = lr.coef_[0] * z  # >0 pushes towards AI
    order = np.argsort(-contrib if is_ai else contrib)
    out = []
    for i in order:
        base = names[i].rsplit("_", 1)[0]
        if base not in EXPLAIN or any(o["key"] == base for o in out):
            continue
        title, desc = EXPLAIN[base]
        real_m, ai_m = float(m["forensic_real_mean"][i]), float(m["forensic_ai_mean"][i])
        closer = "AI-generated" if abs(x[i] - ai_m) < abs(x[i] - real_m) else "real camera"
        out.append({"key": base, "title": title, "description": desc, "value": round(float(x[i]), 4), "typicalReal": round(real_m, 4), "typicalAI": round(ai_m, 4),
                    "closerTo": closer, "pushesTowards": "AI" if contrib[i] > 0 else "authentic", "weight": round(float(abs(contrib[i])), 3)})
        if len(out) >= top:
            break
    return out


def analyze(path: Path, use_gemini: bool | None = None, mode: str = "full") -> dict[str, Any]:
    t0 = time.time()
    m = load_model()
    meta = video_io.probe(path)
    if mode not in {"full", "light"}:
        raise ValueError("Inference mode must be full or light.")
    frames, nexts, times, fps = video_io.read_sampled(path, k=min(FRAMES, 8) if mode == "light" else FRAMES, max_seconds=MAX_SECONDS)
    t_dec = time.time()
    families = set(m["families"]) | set(m["frame_families"])
    ff = F.features_from_pairs(frames, nexts, times, use_clip="clip" in families, use_dino="dino" in families)
    t_feat = time.time()
    result = analyze_features(ff, meta, frames, list(times), use_gemini, (t0, t_dec, t_feat))
    result["inferenceMode"] = mode
    result["samplingWarning"] = "Sparse samples cover only the analysis window; timeline share is not a measured fraction of all video frames."
    return result


def analyze_features(ff: F.FrameFeatures, meta: dict, frames: list, times: list, use_gemini: bool | None = None, clock: tuple | None = None) -> dict[str, Any]:
    """Score already-extracted features (used directly by the tamper check to avoid decoding twice)."""
    m = load_model()
    t0, t_dec, t_feat = clock or (time.time(),) * 3
    if "dino" in m["families"] and ff.dino is None:
        ff.dino = F.dino_embed(frames)
    s = score_features(ff, m)
    p = s["p"]
    gemini = None
    if use_gemini is None:
        use_gemini = bool(os.getenv("GEMINI_API_KEY"))
    if use_gemini:
        from .gemini import gemini_opinion

        gemini = gemini_opinion(frames)
        if gemini and gemini.get("probability") is not None:
            # Second opinion only - weighted lightly; the local model remains primary.
            w = float(os.getenv("CTXTRACE_GEMINI_WEIGHT", "0.25"))
            p = float((1 - w) * p + w * gemini["probability"])
    is_ai = p >= 0.5
    conf = abs(p - 0.5) * 2
    band = "high" if conf >= 0.6 else "medium" if conf >= 0.3 else "low"
    segments = []
    cur = None
    for t, b in zip(times, s["blended"]):
        lab = "ai" if b >= 0.5 else "real"
        if cur and cur["label"] == lab:
            cur["end"] = t
        else:
            cur = {"label": lab, "start": t, "end": t}
            segments.append(cur)
    step = (times[1] - times[0]) if len(times) > 1 else 0.5
    for seg in segments:
        seg["end"] = round(seg["end"] + step, 2); seg["start"] = round(seg["start"], 2)
    return {
        "aiProbability": round(p * 100, 1),
        "aiContentShare": round(s["share"] * 100, 1),
        "authenticity": round((1 - p) * 100, 1),
        "verdict": "ai_generated" if is_ai else "authentic",
        "verdictLabel": ("Likely AI-generated" if is_ai else "Likely camera-recorded"),
        "confidence": round(conf, 3),
        "confidenceBand": band,
        "rawModelScore": round(s["p_raw"], 4),
        "timeline": [{"t": round(float(t), 2), "frameProb": round(float(fp) * 100, 1), "blended": round(float(b) * 100, 1)} for t, fp, b in zip(times, s["frame_probs"], s["blended"])],
        "segments": segments,
        "evidence": explain(ff, m, is_ai),
        "gemini": gemini,
        "media": {"duration": round(meta["duration"], 2), "analysedSeconds": round(min(meta["duration"], MAX_SECONDS), 2), "fps": round(meta["fps"], 2),
                  "width": meta["width"], "height": meta["height"], "codec": meta["codec"], "hasAudio": meta["has_audio"], "framesAnalysed": len(times)},
        "model": {"version": m["version"], "features": m["selected"]["features"], "classifier": m["selected"]["model"], "metrics": m.get("metrics", {})},
        "timing": {"decode": round(t_dec - t0, 2), "features": round(t_feat - t_dec, 2), "total": round(time.time() - t0, 2)},
        "_ff": ff,
    }
