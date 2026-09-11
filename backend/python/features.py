"""ContextTrace forensic feature extraction.

Reference implementation of the 12 forensic features computed from a grayscale
pixel matrix. The JS detector (src/lib/ai-scan.ts) computes the same 12
features from canvas ImageData; the conformance tests assert numerical
agreement to ~1e-9 relative tolerance.

All features are computed from a 160-wide luma plane, matching the browser
pipeline exactly. Feature order is fixed and shared across languages.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

SAT_ANCHOR = 0.35


def to_gray(rgb: Sequence[Sequence[Sequence[float]]]) -> np.ndarray:
    """RGB (H,W,3) float 0..255 -> luma plane (H,W) float64."""
    arr = np.asarray(rgb, dtype=np.float64)
    return 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]


def _blockiness(g: np.ndarray) -> float:
    h, w = g.shape
    on_grid = off_grid = 0.0
    on_n = off_n = 0
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            gx = abs(g[y, x + 1] - g[y, x - 1])
            gy = abs(g[y + 1, x] - g[y - 1, x])
            grad = gx + gy
            if x % 8 == 0 or y % 8 == 0:
                on_grid += grad
                on_n += 1
            else:
                off_grid += grad
                off_n += 1
    on_avg = on_grid / on_n if on_n else 0.0
    off_avg = off_grid / off_n if off_n else 0.0
    return on_avg / off_avg if off_avg > 0 else 1.0


def _temporal_flicker(cur: np.ndarray, prev: np.ndarray) -> float:
    n = min(cur.size, prev.size)
    if n == 0:
        return 0.0
    d = float(np.mean(np.abs(cur.ravel()[:n] - prev.ravel()[:n])))
    denom = max(1.0, (float(cur.mean()) + float(prev.mean())) / 2.0)
    return d / denom


def _saturation_dev(rgb: Sequence[Sequence[Sequence[float]]]) -> float:
    arr = np.asarray(rgb, dtype=np.float64)
    mx = arr.max(axis=2)
    mn = arr.min(axis=2)
    mask = mx > 0
    if not mask.any():
        return 0.0
    # Subsample every 4th pixel in each axis (matches JS stride of 16 bytes = 4 px).
    sub = mask[::4, ::4]
    sat = ((mx - mn) / np.where(mx == 0, 1, mx))[::4, ::4]
    avg = float(sat[sub].mean()) if sub.any() else 0.0
    return abs(avg - SAT_ANCHOR)


def _texture_stats(g: np.ndarray) -> Tuple[float, float]:
    """Returns (uniformity = 1/(1+cv), cv) over 8x8 patches."""
    h, w = g.shape
    p = 8
    vars_: List[float] = []
    for by in range(0, h - p + 1, p):
        for bx in range(0, w - p + 1, p):
            patch = g[by : by + p, bx : bx + p]
            mu = float(patch.mean())
            vars_.append(float((patch**2).mean()) - mu * mu)
    if len(vars_) < 4:
        return 0.0, 0.0
    arr = np.array(vars_)
    mu = float(arr.mean())
    cv = float(arr.std()) / max(1e-6, mu)
    return 1.0 / (1.0 + cv), cv


def _compression_noise(g: np.ndarray) -> float:
    h, w = g.shape
    if h < 3 or w < 3:
        return 0.0
    interior = g[1:-1, 1:-1]
    blur = (
        interior
        + g[1:-1, :-2]
        + g[1:-1, 2:]
        + g[:-2, 1:-1]
        + g[2:, 1:-1]
    ) / 5.0
    return float(np.abs(interior - blur).mean())


def _spectral_energy(g: np.ndarray) -> float:
    h, w = g.shape
    if w < 9:
        return 0.0
    c = g[:, 4:-4]
    near = g[:, 3:-5] + g[:, 5:-3]
    far = g[:, 0:-8] + g[:, 1:-7] + g[:, 7:-1] + g[:, 8:]
    low = float(np.abs(2 * c - near).sum())
    high = float(np.abs(4 * c - far).sum())
    return high / low if low > 0 else 0.0


def _entropy(g: np.ndarray, bins: int = 64) -> float:
    hist, _ = np.histogram(g, bins=bins, range=(0, 255))
    p = hist.astype(np.float64)
    s = p.sum()
    if s <= 0:
        return 0.0
    p = p / s
    p = p[p > 0]
    return float(-(p * np.log2(p)).sum())


def _noise_luma_corr(g: np.ndarray) -> float:
    """Pearson correlation between |high-freq residual| and luma.

    Camera shot noise is signal-dependent (variance scales with luma), so the
    residual magnitude correlates with brightness. Generative drift noise is
    independent of the underlying signal, giving ~0 correlation. This is the
    strongest single physical discriminator.
    """
    h, w = g.shape
    if h < 3 or w < 3:
        return 0.0
    interior = g[1:-1, 1:-1]
    blur = (interior + g[1:-1, :-2] + g[1:-1, 2:] + g[:-2, 1:-1] + g[2:, 1:-1]) / 5.0
    residual = np.abs(interior - blur)
    luma = interior
    r = residual.ravel()
    l = luma.ravel()
    if r.std() < 1e-9 or l.std() < 1e-9:
        return 0.0
    return float(np.corrcoef(r, l)[0, 1])


def _blocking_anisotropy(g: np.ndarray) -> float:
    """Axis-aligned vs diagonal gradient energy ratio on the 8px grid.

    Codec DCT blocking is axis-aligned; natural texture is not.
    """
    h, w = g.shape
    if h < 9 or w < 9:
        return 0.0
    gxA = np.abs(g[:, 8:] - g[:, :-8]).mean()  # axis-aligned, 8 apart
    gyA = np.abs(g[8:, :] - g[:-8, :]).mean()
    diag1 = np.abs(g[8:, 8:] - g[:-8, :-8]).mean()
    diag2 = np.abs(g[8:, :-8] - g[:-8, 8:]).mean()
    axis = (gxA + gyA) / 2.0
    diag = (diag1 + diag2) / 2.0 + 1e-9
    return float(axis / diag)


def _residual_kurtosis(g: np.ndarray) -> float:
    """Kurtosis of the high-freq residual: quantization/blur tails vs Gaussian."""
    h, w = g.shape
    if h < 3 or w < 3:
        return 0.0
    interior = g[1:-1, 1:-1]
    blur = (interior + g[1:-1, :-2] + g[1:-1, 2:] + g[:-2, 1:-1] + g[2:, 1:-1]) / 5.0
    r = (interior - blur).ravel()
    s = r.std()
    if s < 1e-9:
        return 0.0
    return float(((r - r.mean()) ** 4).mean() / (s**4))


def _temporal_whiteness(
    cur: np.ndarray, prev: np.ndarray
) -> float:
    """Spatial smoothness of the temporal difference field.

    Structured motion (camera) produces a smooth difference field; white
    per-frame drift (generative) produces an uncorrelated one. Returns the
    lag-1 horizontal autocorrelation of the difference.
    """
    h, w = cur.shape
    if w < 3 or h < 1:
        return 0.0
    d = np.abs(cur - prev)
    a = d[:, :-1]
    b = d[:, 1:]
    if a.std() < 1e-9 or b.std() < 1e-9:
        return 0.0
    return float(np.corrcoef(a.ravel(), b.ravel())[0, 1])


def _blockiness_std(g: np.ndarray) -> float:
    """Std of per-row-band blockiness — measures *spatial consistency* of blocking."""
    h, w = g.shape
    bands: List[float] = []
    for by in range(1, h - 1, 16):
        band = g[by : min(by + 16, h - 1), 1:-1]
        if band.shape[0] < 3:
            continue
        # grid vs off-grid for this band
        on = off = 0.0
        on_n = off_n = 0
        for y in range(band.shape[0]):
            gy_abs = by + y
            for x in range(1, w - 1):
                gx = abs(g[gy_abs, x + 1] - g[gy_abs, x - 1])
                if x % 8 == 0 or gy_abs % 8 == 0:
                    on += gx
                    on_n += 1
                else:
                    off += gx
                    off_n += 1
        bands.append(on / on_n if on_n else 0.0)
    if len(bands) < 2:
        return 0.0
    arr = np.array(bands)
    return float(arr.std())


def _high_freq_ratio(g: np.ndarray) -> float:
    """Energy ratio of the horizontal-difference histogram tails (x1..x3 vs x0)."""
    h, w = g.shape
    if w < 5:
        return 0.5
    d1 = np.abs(np.diff(g, axis=1)).mean()
    d2 = np.abs(g[:, 2:] - g[:, :-2]).mean()
    d3 = np.abs(g[:, 3:] - g[:, :-3]).mean()
    d0 = np.abs(g).mean() + 1e-6
    return float((d1 + d2 + d3) / (3 * d0))


def extract_frame_features(
    rgb: Sequence[Sequence[Sequence[float]]],
    prev_gray: Optional[np.ndarray] = None,
) -> Tuple[List[float], np.ndarray]:
    """Compute the fixed-order 12-feature vector for one frame.

    Returns (features, gray) so callers can feed `gray` back as `prev_gray`.
    """
    g = to_gray(rgb)

    blockiness = _blockiness(g)
    flicker = _temporal_flicker(g, prev_gray) if prev_gray is not None else 0.0
    saturation_dev = _saturation_dev(rgb)
    uniformity, texture_cv = _texture_stats(g)
    noise = _compression_noise(g)
    spectral = _spectral_energy(g)
    bstd = _blockiness_std(g)
    luma_mean = float(g.mean())
    luma_std = float(g.std())
    hfr = _high_freq_ratio(g)
    entropy = _entropy(g)
    noise_luma_corr = _noise_luma_corr(g)
    blocking_anisotropy = _blocking_anisotropy(g)
    residual_kurtosis = _residual_kurtosis(g)
    temporal_whiteness = (
        _temporal_whiteness(g, prev_gray) if prev_gray is not None else 0.0
    )

    feats = [
        blockiness,
        flicker,
        saturation_dev,
        uniformity,
        noise,
        spectral,
        bstd,
        texture_cv,
        luma_mean,
        luma_std,
        hfr,
        entropy,
        noise_luma_corr,
        blocking_anisotropy,
        residual_kurtosis,
        temporal_whiteness,
    ]
    return feats, g


FEATURE_NAMES = [
    "blockiness",
    "temporal_flicker",
    "saturation_dev",
    "texture_uniformity",
    "compression_noise",
    "frequency_energy",
    "blockiness_std",
    "texture_cv",
    "luma_mean",
    "luma_std",
    "high_freq_ratio",
    "entropy",
    "noise_luma_corr",
    "blocking_anisotropy",
    "residual_kurtosis",
    "temporal_whiteness",
]
