"""Feature extraction shared by training, evaluation and the live API.

Three feature families are produced for each sampled frame:

1. **Forensic (hand-crafted, 34 dims)** - frequency spectrum shape (GAN/diffusion
   up-sampling leaves periodic high-frequency traces), sensor-noise residual
   statistics, colour/texture statistics and compression blockiness.
2. **Temporal (8 dims)** - computed between a sampled frame and the very next
   frame: Farneback optical-flow magnitude, flow-warp photometric error and
   temporal correlation of the noise residual (real sensor noise is temporally
   independent; generated video noise is usually smooth/correlated).
3. **Deep embeddings** - CLIP ViT-B/32 image embedding (512 dims, the UnivFD
   approach of Ojha et al., CVPR 2023) and optionally DINOv2-small (384 dims).

Video-level vectors are the mean and standard deviation of the per-frame
vectors plus temporal-consistency statistics of the embeddings.
"""
from __future__ import annotations

import math
import os
import threading
from dataclasses import dataclass, field

import cv2
import numpy as np

FORENSIC_NAMES = [
    "spec_slope", "spec_hf_ratio", "spec_mf_ratio", "spec_peakiness", "spec_r1", "spec_r2", "spec_r3", "spec_r4", "spec_r5", "spec_r6",
    "res_std", "res_kurt", "res_absmean", "res_rg_corr", "res_rb_corr", "res_std_ratio_hi_lo",
    "lap_logvar", "grad_mean", "edge_density", "sat_mean", "sat_std", "val_std", "entropy", "blockiness",
    "hue_entropy", "dark_frac", "bright_frac", "chroma_noise", "local_var_cv", "jpeg_q_proxy",
    "texture_lbp_entropy", "smooth_frac", "highlight_clip", "colour_cast",
]
TEMPORAL_NAMES = ["flow_mag", "flow_std", "warp_err", "warp_err_norm", "frame_diff", "res_tcorr", "res_tcorr_hi", "flow_smooth"]


def _crop(gray: np.ndarray, size: int = 256) -> np.ndarray:
    h, w = gray.shape[:2]
    if h < size or w < size:
        s = size / min(h, w)
        gray = cv2.resize(gray, (max(size, int(w * s) + 1), max(size, int(h * s) + 1)), interpolation=cv2.INTER_CUBIC)
        h, w = gray.shape[:2]
    y, x = (h - size) // 2, (w - size) // 2
    return gray[y:y + size, x:x + size]


_RADIAL_CACHE: dict[int, np.ndarray] = {}


def _radial_index(size: int) -> np.ndarray:
    if size not in _RADIAL_CACHE:
        yy, xx = np.indices((size, size))
        r = np.sqrt((yy - size / 2) ** 2 + (xx - size / 2) ** 2)
        _RADIAL_CACHE[size] = r.astype(np.int32)
    return _RADIAL_CACHE[size]


def _spectrum(gray_crop: np.ndarray) -> list[float]:
    g = gray_crop.astype(np.float32)
    g = (g - g.mean()) * np.outer(np.hanning(g.shape[0]), np.hanning(g.shape[1]))
    mag = np.abs(np.fft.fftshift(np.fft.fft2(g))) + 1e-6
    r = _radial_index(g.shape[0])
    radial = np.bincount(r.ravel(), mag.ravel()) / np.maximum(np.bincount(r.ravel()), 1)
    radial = radial[1: g.shape[0] // 2]
    freqs = np.arange(1, len(radial) + 1)
    lo, hi = 4, len(radial) - 2
    slope = float(np.polyfit(np.log(freqs[lo:hi]), np.log(radial[lo:hi]), 1)[0])
    total = float(radial.sum())
    n = len(radial)
    hf = float(radial[int(n * 0.66):].sum() / total)
    mf = float(radial[int(n * 0.33):int(n * 0.66)].sum() / total)
    # peakiness: periodic up-sampling artefacts create spikes in the log spectrum
    logmag = np.log(mag)
    smooth = cv2.GaussianBlur(logmag.astype(np.float32), (0, 0), 3)
    resid = logmag - smooth
    outer = r > g.shape[0] // 4
    peak = float(np.percentile(resid[outer], 99.5) - np.median(resid[outer]))
    bins = np.array_split(np.log(radial), 6)
    prof = [float(b.mean()) for b in bins]
    prof = [p - prof[0] for p in prof]
    return [slope, hf, mf, peak] + prof


def _entropy(values: np.ndarray, bins: int = 64, rng: tuple[float, float] = (0, 256)) -> float:
    hist, _ = np.histogram(values, bins=bins, range=rng)
    p = hist.astype(np.float64) / max(1, hist.sum())
    p = p[p > 0]
    return float(-(p * np.log2(p)).sum())


def forensic_frame(frame: np.ndarray) -> np.ndarray:
    gray_full = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    crop_bgr = frame
    if min(frame.shape[:2]) >= 256:
        h, w = frame.shape[:2]
        y, x = (h - 256) // 2, (w - 256) // 2
        crop_bgr = frame[y:y + 256, x:x + 256]
    gray = _crop(gray_full, 256)
    spec = _spectrum(gray)

    f = crop_bgr.astype(np.float32)
    if f.shape[0] < 32 or f.shape[1] < 32:
        f = cv2.resize(f, (256, 256))
    den = cv2.medianBlur(np.clip(f, 0, 255).astype(np.uint8), 3).astype(np.float32)
    res = f - den
    rg = res[..., 0].ravel(); gg = res[..., 1].ravel(); bb = res[..., 2].ravel()
    rstd = float(res.std()) + 1e-6
    kurt = float(((res - res.mean()) ** 4).mean() / (rstd ** 4))
    corr_rg = float(np.corrcoef(rg, gg)[0, 1]) if rg.std() > 1e-6 and gg.std() > 1e-6 else 0.0
    corr_rb = float(np.corrcoef(rg, bb)[0, 1]) if rg.std() > 1e-6 and bb.std() > 1e-6 else 0.0
    g32 = gray.astype(np.float32)
    lap = cv2.Laplacian(g32, cv2.CV_32F)
    local_var = cv2.blur(g32 ** 2, (8, 8)) - cv2.blur(g32, (8, 8)) ** 2
    smooth_mask = local_var < 4.0
    hi_mask = local_var > np.percentile(local_var, 75)
    lo_mask = local_var < np.percentile(local_var, 25)
    gres = res.mean(axis=2) if res.shape[:2] == g32.shape else cv2.resize(res.mean(axis=2), g32.shape[::-1])
    ratio = float((gres[hi_mask].std() + 1e-3) / (gres[lo_mask].std() + 1e-3))

    gx = cv2.Sobel(g32, cv2.CV_32F, 1, 0); gy = cv2.Sobel(g32, cv2.CV_32F, 0, 1)
    grad = np.sqrt(gx ** 2 + gy ** 2)
    edges = cv2.Canny(gray, 80, 160)
    hsv = cv2.cvtColor(frame if frame.shape[0] * frame.shape[1] <= 640 * 360 else cv2.resize(frame, (640, int(640 * frame.shape[0] / frame.shape[1]))), cv2.COLOR_BGR2HSV)
    sat = hsv[..., 1].astype(np.float32) / 255.0
    val = hsv[..., 2].astype(np.float32) / 255.0
    block = 0.0
    if g32.shape[0] > 16:
        v = np.abs(np.diff(g32, axis=1)); hh = np.abs(np.diff(g32, axis=0))
        seam = v[:, 7::8].mean() + hh[7::8, :].mean()
        off = v[:, 3::8].mean() + hh[3::8, :].mean()
        block = float(seam / max(off, 1e-6))
    ycc = cv2.cvtColor(crop_bgr if crop_bgr.shape[0] >= 32 else cv2.resize(crop_bgr, (256, 256)), cv2.COLOR_BGR2YCrCb).astype(np.float32)
    chroma = float(np.abs(ycc[..., 1] - cv2.medianBlur(ycc[..., 1].astype(np.uint8), 3)).mean())
    # LBP-ish texture entropy (8-neighbour sign pattern)
    c = g32[1:-1, 1:-1]
    code = np.zeros_like(c, dtype=np.uint8)
    for i, (dy, dx) in enumerate([(-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1)]):
        code |= ((g32[1 + dy:g32.shape[0] - 1 + dy, 1 + dx:g32.shape[1] - 1 + dx] >= c).astype(np.uint8) << i)
    lbp_ent = _entropy(code, 256, (0, 256))
    hue_ent = _entropy(hsv[..., 0], 36, (0, 180))
    mean_bgr = frame.reshape(-1, 3).mean(axis=0)
    cast = float(np.std(mean_bgr) / (np.mean(mean_bgr) + 1e-3))
    lv = local_var.ravel()
    feats = spec + [
        rstd, kurt, float(np.abs(res).mean()), corr_rg, corr_rb, ratio,
        float(np.log1p(lap.var())), float(grad.mean()), float((edges > 0).mean()), float(sat.mean()), float(sat.std()), float(val.std()),
        _entropy(gray), block, hue_ent, float((val < 0.08).mean()), float((val > 0.92).mean()), chroma,
        float(lv.std() / (lv.mean() + 1e-3)), float(np.abs(lap).mean() / (grad.mean() + 1e-3)), lbp_ent, float(smooth_mask.mean()),
        float((gray_full >= 250).mean()), cast,
    ]
    return np.nan_to_num(np.asarray(feats, dtype=np.float32), nan=0.0, posinf=0.0, neginf=0.0)


def temporal_pair(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    def small(x):
        h, w = x.shape[:2]
        s = 320 / max(h, w)
        return cv2.resize(cv2.cvtColor(x, cv2.COLOR_BGR2GRAY), (max(16, int(w * s)), max(16, int(h * s))), interpolation=cv2.INTER_AREA)

    ga, gb = small(a), small(b)
    flow = cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    mag = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2)
    h, w = ga.shape
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    warped = cv2.remap(gb, gx + flow[..., 0], gy + flow[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    err = np.abs(warped.astype(np.float32) - ga.astype(np.float32))
    diff = float(np.abs(ga.astype(np.float32) - gb.astype(np.float32)).mean())
    ca, cb = _crop(cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), 256).astype(np.float32), _crop(cv2.cvtColor(b, cv2.COLOR_BGR2GRAY), 256).astype(np.float32)
    ra = ca - cv2.GaussianBlur(ca, (0, 0), 1.0); rb = cb - cv2.GaussianBlur(cb, (0, 0), 1.0)
    tc = float(np.corrcoef(ra.ravel(), rb.ravel())[0, 1]) if ra.std() > 1e-6 and rb.std() > 1e-6 else 0.0
    ra2 = ca - cv2.medianBlur(ca.astype(np.uint8), 3).astype(np.float32); rb2 = cb - cv2.medianBlur(cb.astype(np.uint8), 3).astype(np.float32)
    tc2 = float(np.corrcoef(ra2.ravel(), rb2.ravel())[0, 1]) if ra2.std() > 1e-6 and rb2.std() > 1e-6 else 0.0
    fdx = np.abs(np.diff(flow, axis=1)).mean() + np.abs(np.diff(flow, axis=0)).mean()
    feats = [float(mag.mean()), float(mag.std()), float(err.mean()), float(err.mean() / (diff + 1.0)), diff, tc, tc2, float(fdx / (mag.mean() + 0.05))]
    return np.nan_to_num(np.asarray(feats, dtype=np.float32))


# --------------------------------------------------------------------------- deep embedders
_lock = threading.Lock()
_clip = {}
_dino = {}


def _torch():
    import torch

    torch.set_num_threads(max(1, min(8, (os.cpu_count() or 4))))
    return torch


def clip_embed(frames_bgr: list[np.ndarray], batch: int = 16) -> np.ndarray:
    torch = _torch()
    with _lock:
        if not _clip:
            import open_clip

            model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32-quickgelu", pretrained="openai")
            model.eval()
            _clip.update(model=model, preprocess=preprocess)
    from PIL import Image

    model, preprocess = _clip["model"], _clip["preprocess"]
    out = []
    for i in range(0, len(frames_bgr), batch):
        ims = torch.stack([preprocess(Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))) for f in frames_bgr[i:i + batch]])
        with torch.inference_mode():
            e = model.encode_image(ims)
            e = e / e.norm(dim=-1, keepdim=True).clamp_min(1e-8)
        out.append(e.float().numpy())
    return np.concatenate(out, axis=0) if out else np.zeros((0, 512), np.float32)


def dino_embed(frames_bgr: list[np.ndarray], batch: int = 16) -> np.ndarray:
    torch = _torch()
    with _lock:
        if not _dino:
            from transformers import AutoImageProcessor, AutoModel

            _dino["proc"] = AutoImageProcessor.from_pretrained("facebook/dinov2-small")
            _dino["model"] = AutoModel.from_pretrained("facebook/dinov2-small").eval()
    from PIL import Image

    out = []
    for i in range(0, len(frames_bgr), batch):
        ims = [Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB)) for f in frames_bgr[i:i + batch]]
        inputs = _dino["proc"](images=ims, return_tensors="pt")
        with torch.inference_mode():
            h = _dino["model"](**inputs).last_hidden_state
        cls = h[:, 0]
        patch_mean = h[:, 1:].mean(dim=1)
        e = torch.cat([cls, patch_mean], dim=-1)
        e = e / e.norm(dim=-1, keepdim=True).clamp_min(1e-8)
        out.append(e.float().numpy())
    return np.concatenate(out, axis=0) if out else np.zeros((0, 768), np.float32)


# --------------------------------------------------------------------------- sampling
def sample_indices(n_frames: int, k: int) -> list[int]:
    """k evenly spaced indices that each leave room for a following frame."""
    if n_frames <= 1:
        return [0] * k
    last = max(0, n_frames - 2)
    return sorted(set(int(round(x)) for x in np.linspace(0, last, k)))


def degrade(frame: np.ndarray, rng: np.random.Generator, spec: dict | None = None) -> np.ndarray:
    """Training-time augmentation that mimics social-media re-processing.

    Applied identically to real and AI clips so resolution / compression cannot
    act as a shortcut feature.
    """
    spec = spec or {}
    h, w = frame.shape[:2]
    side = spec.get("side", int(rng.choice([240, 360, 480, 720])))
    s = side / min(h, w)
    if s < 1.0:
        frame = cv2.resize(frame, (max(32, int(w * s)), max(32, int(h * s))), interpolation=cv2.INTER_AREA)
    q = spec.get("quality", int(rng.integers(45, 92)))
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, q])
    if ok:
        frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    return frame


@dataclass
class FrameFeatures:
    times: list[float]
    forensic: np.ndarray            # (k, 34)
    temporal: np.ndarray            # (k, 8)
    clip: np.ndarray | None = None  # (k, 512)
    dino: np.ndarray | None = None  # (k, 768)
    extra: dict = field(default_factory=dict)


def features_from_pairs(frames: list[np.ndarray], nexts: list[np.ndarray], times: list[float], use_clip: bool = True, use_dino: bool = False,
                        augment: dict | None = None, rng: np.random.Generator | None = None) -> FrameFeatures:
    sel, nxt = frames, nexts
    if augment is not None:
        rng = rng or np.random.default_rng(0)
        sel = [degrade(a, rng, augment) for a in frames]
        nxt = [degrade(b, rng, augment) for b in nexts]
    forensic = np.stack([forensic_frame(f) for f in sel])
    temporal = np.stack([temporal_pair(a, b) for a, b in zip(sel, nxt)])
    clip = clip_embed(sel) if use_clip else None
    dino = dino_embed(sel) if use_dino else None
    return FrameFeatures(times=list(times), forensic=forensic, temporal=temporal, clip=clip, dino=dino)


def extract_frame_features(frames: list[np.ndarray], fps: float, k: int = 12, use_clip: bool = True, use_dino: bool = False,
                           augment: dict | None = None, rng: np.random.Generator | None = None, indices: list[int] | None = None) -> FrameFeatures:
    idx = indices if indices is not None else sample_indices(len(frames), k)
    sel = [frames[i] for i in idx]
    nxt = [frames[min(i + 1, len(frames) - 1)] for i in idx]
    return features_from_pairs(sel, nxt, [i / fps for i in idx], use_clip, use_dino, augment, rng)


def _emb_temporal(e: np.ndarray | None) -> list[float]:
    if e is None or len(e) < 2:
        return [1.0, 0.0, 0.0]
    sims = np.sum(e[1:] * e[:-1], axis=1)
    centroid = e.mean(axis=0)
    spread = float(np.linalg.norm(e - centroid, axis=1).mean())
    return [float(sims.mean()), float(sims.std()), spread]


def video_vector(ff: FrameFeatures, families: tuple[str, ...]) -> np.ndarray:
    parts = []
    if "forensic" in families:
        parts += [ff.forensic.mean(0), ff.forensic.std(0)]
    if "temporal" in families:
        parts += [ff.temporal.mean(0), ff.temporal.std(0)]
    if "clip" in families and ff.clip is not None:
        parts += [ff.clip.mean(0), np.asarray(_emb_temporal(ff.clip), np.float32)]
    if "dino" in families and ff.dino is not None:
        parts += [ff.dino.mean(0), np.asarray(_emb_temporal(ff.dino), np.float32)]
    return np.concatenate(parts).astype(np.float32)


def frame_matrix(ff: FrameFeatures, families: tuple[str, ...]) -> np.ndarray:
    parts = []
    if "forensic" in families:
        parts.append(ff.forensic)
    if "temporal" in families:
        parts.append(ff.temporal)
    if "clip" in families and ff.clip is not None:
        parts.append(ff.clip)
    if "dino" in families and ff.dino is not None:
        parts.append(ff.dino)
    return np.concatenate(parts, axis=1).astype(np.float32)


def feature_names(families: tuple[str, ...]) -> list[str]:
    names = []
    if "forensic" in families:
        names += [f"{n}_mean" for n in FORENSIC_NAMES] + [f"{n}_std" for n in FORENSIC_NAMES]
    if "temporal" in families:
        names += [f"{n}_mean" for n in TEMPORAL_NAMES] + [f"{n}_std" for n in TEMPORAL_NAMES]
    if "clip" in families:
        names += [f"clip_{i}" for i in range(512)] + ["clip_tsim_mean", "clip_tsim_std", "clip_spread"]
    if "dino" in families:
        names += [f"dino_{i}" for i in range(768)] + ["dino_tsim_mean", "dino_tsim_std", "dino_spread"]
    return names
