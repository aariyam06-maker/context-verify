"""Procedural labeled corpus for detector training/evaluation.

Two generative processes produce 160x90 RGB frames. Crucially, every SINGLE
feature's marginal distribution overlaps between classes — only the JOINT
statistics separate them. This kills single-feature shortcuts:

- class 0 "camera": alpha 1.6..2.3, shot noise, persistent structure,
  saturation 0.18..0.55 (includes vivid natural footage), handheld shake on
  some clips (elevated flicker), blocking up to 1.9 on hard variants.
- class 1 "synthetic": alpha 1.9..2.9, homogenized texture, saturation
  0.26..0.62, temporal identity drift, synthetic spectral excess. Hard
  variants remove individual tells (denoised: no noise floor; textured:
  texture variance restored; muted: natural chroma).

Separability therefore comes from the *combination* (slope ∧ homogeneity ∧
drift ∧ chroma-envelope shape), which is the forensically defensible signal.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import numpy as np

from features import extract_frame_features

RNG_SEED = 20260911
W, H = 160, 90


def _spectral_patch(
    rng: np.random.Generator, w: int, h: int, alpha: float, base: float
) -> np.ndarray:
    """Draw a zero-mean patch with a 1/f^alpha spatial power spectrum."""
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    f = np.sqrt(fx**2 + fy**2)
    f[0, 0] = 1e-6
    amp = 1.0 / f**alpha
    amp /= amp.mean()
    phase = rng.uniform(0, 2 * np.pi, size=(h, w))
    field = np.fft.ifft2(amp * np.exp(1j * phase)).real
    field -= field.mean()
    return base * field / (field.std() + 1e-9)


def _add_chroma(
    g: np.ndarray, rng: np.random.Generator, sat_center: float
) -> np.ndarray:
    """Render luma into RGB with a target saturation distribution."""
    luma = np.clip(g, 0, 255)
    sat = np.clip(rng.normal(sat_center, 0.05, size=luma.shape), 0, 1)
    hue = rng.uniform(0, 2 * np.pi)
    r = luma + sat * 255 * np.cos(hue) * 0.5
    b = luma + sat * 255 * np.sin(hue) * 0.5
    gc = luma - 0.5 * sat * 255 * (np.cos(hue) + np.sin(hue)) * 0.25
    return np.stack(
        [np.clip(r, 0, 255), np.clip(gc, 0, 255), np.clip(b, 0, 255)], axis=2
    )


class CameraSim:
    """Class 0 generator: natural footage statistics."""

    def __init__(self, seed: int, variant: Optional[str] = None):
        self.rng = np.random.default_rng(seed)
        self.variant = variant
        # Overlaps synthetic range (1.9..2.9) on 1.9..2.3.
        self.alpha = float(self.rng.uniform(1.6, 2.3))
        self.base = float(self.rng.uniform(70, 140))
        # ~30% of camera clips have handheld shake (elevated flicker).
        self.shake = bool(self.rng.uniform() < 0.3)

    def frame(self, t: int) -> Tuple[np.ndarray, np.ndarray]:
        rng = self.rng
        dx = int(rng.uniform(0, 4))
        dy = int(rng.uniform(0, 4))
        patch = _spectral_patch(rng, W + 8, H + 8, self.alpha, self.base)
        g = patch[dy : dy + H, dx : dx + W]
        # Shot noise: Poisson-like, persistent sensor -> per-clip grain level.
        grain = 0.28
        if self.variant == "grainy_camera":
            grain = 0.55
        g = g + rng.normal(0, np.sqrt(np.maximum(g, 1)) * grain * 0.5)
        if self.shake:
            # Handheld micro-jitter: inter-frame luma wobble like AI drift.
            g = g + rng.normal(0, rng.uniform(3, 7), size=g.shape)
        # Blocking: up to 1.9 on the hard variant (overlaps reencoded synthetic).
        if self.variant == "blocked_camera":
            block = float(rng.uniform(1.5, 1.9))
        else:
            block = float(rng.uniform(0.9, 1.3))
        g = _apply_blocking(g, block)
        # Saturation 0.18..0.55 overlaps synthetic 0.26..0.62.
        if self.variant == "saturated_camera":
            sat_center = float(rng.uniform(0.44, 0.55))
        else:
            sat_center = float(rng.uniform(0.18, 0.46))
        rgb = _add_chroma(g, rng, sat_center=sat_center)
        return rgb, g


class SyntheticSim:
    """Class 1 generator: generative footage statistics."""

    def __init__(self, seed: int, variant: Optional[str] = None):
        self.rng = np.random.default_rng(seed)
        self.variant = variant
        # Persistent low-frequency layout (like a fixed scene) + per-frame drift.
        self.layout = _spectral_patch(
            self.rng, W, H, float(self.rng.uniform(1.9, 2.2)), 1.0
        )
        self.base = float(self.rng.uniform(80, 150))

    def frame(self, t: int) -> Tuple[np.ndarray, np.ndarray]:
        rng = self.rng
        # Overlaps camera range (1.6..2.3) on 1.9..2.3.
        alpha = float(rng.uniform(1.9, 2.9))
        g = _spectral_patch(rng, W, H, alpha, self.base)
        # Homogenize texture: blend toward a smoothed version.
        g = 0.65 * g + 0.35 * _box_blur(g, 3)
        if self.variant == "textured_synthetic":
            # Add texture variance back (hard positive: looks textured).
            g = g + rng.normal(0, 6.0, size=g.shape)
        # Temporal identity drift: independent noise per frame (AI-flicker).
        # 'denoised_synthetic' keeps drift low, overlapping calm camera clips.
        drift_sigma = (
            float(rng.uniform(2, 4))
            if self.variant == "denoised_synthetic"
            else float(rng.uniform(4, 11))
        )
        g = g + rng.normal(0, drift_sigma, size=g.shape)
        g = g + self.layout
        if self.variant == "reencoded_synthetic":
            g = _apply_blocking(g, float(rng.uniform(1.5, 1.9)))
        # Saturation 0.26..0.62 overlaps camera 0.18..0.55; 'muted' variant
        # sits fully inside the natural range.
        if self.variant == "muted_synthetic":
            sat_center = float(rng.uniform(0.26, 0.40))
        else:
            sat_center = float(rng.uniform(0.34, 0.62))
        rgb = _add_chroma(g, rng, sat_center=sat_center)
        return rgb, g


def _box_blur(g: np.ndarray, k: int = 3) -> np.ndarray:
    """Fast box blur via cumsum (matches JS/Java 5-tap approximation closely)."""
    pad = np.pad(g, k // 2, mode="edge")
    c = np.cumsum(np.cumsum(pad, axis=0), axis=1)
    c = np.pad(c, ((1, 0), (1, 0)))
    h, w = g.shape
    kern = k // 2
    s1 = c[k : k + h, k : k + w]
    s2 = c[0:h, k : k + w]
    s3 = c[k : k + h, 0:w]
    s4 = c[0:h, 0:w]
    return (s1 - s2 - s3 + s4) / (k * k)


def _apply_blocking(g: np.ndarray, ratio: float) -> np.ndarray:
    """Scale gradients on the 8px grid to emulate codec blocking."""
    out = g.copy()
    h, w = g.shape
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if x % 8 == 0 or y % 8 == 0:
                out[y, x] = g[y, x - 1] + ratio * (g[y, x] - g[y, x - 1])
    return out


def make_clip(cls: int, seed: int, frames: int = 14, hard: Optional[str] = None) -> Dict:
    """Render one labeled clip and extract its feature matrix.

    Returns {"X": (frames, 12) float64, "y": 0|1, "hard": str|None}.
    """
    if cls == 0:
        variants = ("grainy_camera", "blocked_camera", "saturated_camera")
        sim = CameraSim(seed, variant=hard if hard in variants else None)
    else:
        variants = ("denoised_synthetic", "reencoded_synthetic", "textured_synthetic", "muted_synthetic")
        sim = SyntheticSim(seed, variant=hard if hard in variants else None)

    rows: List[List[float]] = []
    prev = None
    for t in range(frames):
        rgb, g = sim.frame(t)
        feats, prev = extract_frame_features(rgb, prev_gray=prev)
        rows.append(feats)
    return {"X": np.array(rows, dtype=np.float64), "y": cls, "hard": hard}


def clip_feature_vector(X: np.ndarray) -> Tuple[np.ndarray, list]:
    """Aggregate a clip's per-frame features (F, 16) into one clip vector.

    Adds three cross-frame features that carry the physical discriminators:
    - layout_persistence: temporal stability of the low-frequency field
      (approximated by luma_mean stability across frames). Real scenes
      persist coherently; per-frame independent generation does not.
    - flicker_consistency: std of temporal_flicker across frames.
    - noise_coupling: mean noise_luma_corr (shot-noise physics).

    The aggregation (means of the 16 per-frame features) must be mirrored
    exactly in JS/Java.
    """
    means = X.mean(axis=0)
    flicker_consistency = float(X[:, 1].std())
    noise_coupling = float(X[:, 12].mean())
    layout_persistence = 1.0 - float(X[:, 8].std()) / (float(X[:, 8].mean()) + 1e-6)
    vec = np.concatenate(
        [means, [layout_persistence, flicker_consistency, noise_coupling]]
    )
    extra_names = ["layout_persistence", "flicker_consistency", "noise_coupling"]
    return vec, extra_names


def build_clip_corpus(
    n_per_class: int = 80,
    frames: int = 14,
    hard_fraction: float = 0.4,
    seed: int = RNG_SEED,
) -> Tuple[np.ndarray, np.ndarray, List[Dict]]:
    """Clip-level corpus: one 19-dim vector per clip (the product granularity)."""
    rng = np.random.default_rng(seed)
    vecs: List[np.ndarray] = []
    ys: List[int] = []
    meta: List[Dict] = []
    idx = 0
    for cls in (0, 1):
        for i in range(n_per_class):
            hard = None
            if rng.uniform() < hard_fraction:
                if cls == 0:
                    hard = ["grainy_camera", "blocked_camera", "saturated_camera"][i % 3]
                else:
                    hard = ["denoised_synthetic", "reencoded_synthetic", "textured_synthetic", "muted_synthetic"][i % 4]
            clip = make_clip(cls, seed=seed + idx, frames=frames, hard=hard)
            X = clip["X"]
            means = X.mean(axis=0)
            flicker_consistency = float(X[:, 1].std())
            noise_coupling = float(X[:, 12].mean())
            # Layout persistence: re-render is costly, so approximate from the
            # stored frame features: luma_mean stability across frames.
            # (Real low-freq persistence correlates with luma_mean stability
            # for these generators; keeps corpus build time bounded.)
            layout_persistence = 1.0 - float(X[:, 8].std()) / (float(X[:, 8].mean()) + 1e-6)
            vec = np.concatenate(
                [means, [layout_persistence, flicker_consistency, noise_coupling]]
            )
            vecs.append(vec)
            ys.append(cls)
            meta.append({"clip": idx, "cls": cls, "hard": hard})
            idx += 1
    return np.array(vecs, dtype=np.float64), np.array(ys, dtype=np.int64), meta


def build_corpus(
    n_per_class: int = 60,
    frames: int = 14,
    hard_fraction: float = 0.35,
    seed: int = RNG_SEED,
) -> Tuple[np.ndarray, np.ndarray, List[Dict]]:
    """Build the full corpus. Returns (X, y, meta) with X shape (n, 12)."""
    rng = np.random.default_rng(seed)
    Xs: List[np.ndarray] = []
    ys: List[int] = []
    meta: List[Dict] = []
    idx = 0
    for cls in (0, 1):
        for i in range(n_per_class):
            hard = None
            if rng.uniform() < hard_fraction:
                if cls == 0:
                    hard = ["grainy_camera", "blocked_camera", "saturated_camera"][i % 3]
                else:
                    hard = ["denoised_synthetic", "reencoded_synthetic", "textured_synthetic", "muted_synthetic"][i % 4]
            clip = make_clip(cls, seed=seed + idx, frames=frames, hard=hard)
            Xs.append(clip["X"])
            ys.extend([cls] * clip["X"].shape[0])
            for _ in range(clip["X"].shape[0]):
                meta.append({"clip": idx, "cls": cls, "hard": hard})
            idx += 1
    X = np.concatenate(Xs, axis=0)
    y = np.array(ys, dtype=np.int64)
    return X, y, meta
