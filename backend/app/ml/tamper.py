"""Two-video evidence-tampering analysis.

Given two videos that may share content, determine:
  * whether they are derived from one another (content alignment),
  * what differs (removed / inserted / reordered segments, in-frame edits,
    speed change, re-encoding quality loss),
  * which one is the original and which is the tampered derivative.

The direction decision is made by a learned, antisymmetric logistic model over
"evidence that X was tampered" features (see `side_metrics`). Structural
analysis (alignment, cuts, region diffs) is deterministic and explainable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import features as F

SAMPLE_FPS = 3.0
MAX_SAMPLES = 32
MATCH_CLIP = 0.62
MATCH_CLIP_STRONG = 0.955
MATCH_THUMB = 0.85


@dataclass
class Track:
    path: str
    fps: float
    duration: float
    width: int
    height: int
    bpp: float
    times: np.ndarray            # sampled timestamps (s)
    frames: list                 # sampled BGR frames (<=640px), kept in memory only
    thumbs: np.ndarray           # (n, 16, 64) block thumbnails (see _thumb)
    clip: np.ndarray             # (n, 512)
    forensic: np.ndarray         # (n, 34)
    temporal: np.ndarray         # (n, 8)
    cut_times: list[float]       # detected hard cuts (s)
    motion: float                # mean per-frame motion energy


def _thumb(frame: np.ndarray) -> np.ndarray:
    """32x32 grey thumbnail, z-scored per frame, split into a 4x4 grid of 8x8 blocks -> (16, 64)."""
    g = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    g = (g - g.mean()) / max(float(g.std()), 4.0)
    return g.reshape(4, 8, 4, 8).transpose(0, 2, 1, 3).reshape(16, 64)


def thumb_similarity(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Robust block similarity in [0, 1] between all frames of x (n,16,64) and y (m,16,64).

    Each block scores 1 - mean|a-b| / (mean|a| + mean|b| + 0.25); the frame score
    is the mean of the best 75% of blocks, so a local edit (caption, inpainted
    object, cloned patch) does not break the correspondence.
    """
    d = np.abs(x[:, None] - y[None]).mean(-1)                    # (n, m, 16)
    mag = np.abs(x).mean(-1)[:, None] + np.abs(y).mean(-1)[None]  # (n, m, 16)
    blk = np.clip(1.0 - d / (mag + 0.25), 0.0, 1.0)
    blk.sort(axis=-1)
    return blk[..., 4:].mean(-1)


def detect_cuts(small: list[np.ndarray], fps: float) -> list[float]:
    if len(small) < 3:
        return []
    d = np.array([np.abs(small[i].astype(np.float32) - small[i - 1].astype(np.float32)).mean() / 255.0 for i in range(1, len(small))])
    h = []
    for i in range(1, len(small)):
        a = cv2.calcHist([small[i - 1]], [0], None, [32], [0, 256]); b = cv2.calcHist([small[i]], [0], None, [32], [0, 256])
        h.append(1.0 - float(cv2.compareHist(cv2.normalize(a, a), cv2.normalize(b, b), cv2.HISTCMP_CORREL)))
    h = np.array(h)
    cuts = []
    for i in range(len(d)):
        lo, hi = max(0, i - 8), min(len(d), i + 9)
        neigh = np.concatenate([d[lo:i], d[i + 1:hi]])
        base = float(np.median(neigh)) if len(neigh) else 0.0
        if d[i] > max(0.06, 4.0 * base + 0.02) and (h[i] > 0.15 or d[i] > 0.15):
            cuts.append((i + 1) / fps)
    # merge cuts closer than 0.25 s
    merged: list[float] = []
    for c in cuts:
        if not merged or c - merged[-1] > 0.25:
            merged.append(c)
    return merged


def load_track(path: Path, max_seconds: float = 10.0) -> Track:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError(f"Could not open {Path(path).name}")
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    if fps <= 1e-3 or fps > 240:
        fps = 25.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0); h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    limit = int(max_seconds * fps) if max_seconds else total
    n_frames = min(total, limit) if total > 0 else limit
    n_samples = int(min(MAX_SAMPLES, max(6, round(n_frames / fps * SAMPLE_FPS))))
    targets = set(int(round(x)) for x in np.linspace(0, max(0, n_frames - 2), n_samples))
    want = targets | {t + 1 for t in targets}
    small, keep, idx = [], {}, 0
    try:
        while idx < limit:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            small.append(cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 36), interpolation=cv2.INTER_AREA))
            if idx in want:
                fh, fw = frame.shape[:2]
                if max(fh, fw) > 960:
                    s = 960 / max(fh, fw)
                    frame = cv2.resize(frame, (int(fw * s), int(fh * s)), interpolation=cv2.INTER_AREA)
                keep[idx] = frame
            idx += 1
    finally:
        cap.release()
    if not keep:
        raise ValueError(f"No decodable frames in {Path(path).name}")
    order = sorted(t for t in targets if t in keep)
    frames = [keep[t] for t in order]
    nexts = [keep.get(t + 1, keep[t]) for t in order]
    times = np.array([t / fps for t in order], np.float32)
    ff = F.features_from_pairs(frames, nexts, list(times), use_clip=True, use_dino=False)
    size = Path(path).stat().st_size
    duration = max(len(small), 1) / fps
    bpp = float(size * 8 / max(1, w * h * max(total, 1)))
    motion = float(np.mean([np.abs(small[i].astype(np.float32) - small[i - 1].astype(np.float32)).mean() for i in range(1, len(small))])) if len(small) > 1 else 0.0
    disp = [cv2.resize(f, (640, int(640 * f.shape[0] / f.shape[1]))) if f.shape[1] > 640 else f for f in frames]
    return Track(str(path), fps, duration, w, h, bpp, times, disp, np.stack([_thumb(f) for f in frames]), ff.clip, ff.forensic, ff.temporal, detect_cuts(small, fps), motion)


# --------------------------------------------------------------------------- alignment
@dataclass
class Alignment:
    best_idx: np.ndarray      # for each frame of X, index of best match in Y
    best_clip: np.ndarray
    best_thumb: np.ndarray
    matched: np.ndarray       # bool per frame of X


def align(x: Track, y: Track) -> Alignment:
    """Frame correspondence X -> Y.

    Grey thumbnails are robust to re-compression; CLIP is robust to colour
    grading / crop. A frame is matched when both agree (or CLIP is very high).
    Among near-equal candidates (static scenes) the one closest to the expected
    next index is chosen, which keeps the path monotonic where possible.
    """
    sc = x.clip @ y.clip.T
    st = thumb_similarity(x.thumbs, y.thumbs)
    combo = st + 0.5 * sc
    j = np.zeros(len(x.clip), dtype=int)
    prev = None
    for i in range(len(x.clip)):
        best = combo[i].max()
        cand = np.where(combo[i] >= best - 0.015)[0]
        if prev is None:
            j[i] = int(cand[np.argmin(cand)]) if len(cand) else int(combo[i].argmax())
        else:
            j[i] = int(cand[np.argmin(np.abs(cand - (prev + 1)))])
        prev = j[i]
    bc = sc[np.arange(len(j)), j]; bt = st[np.arange(len(j)), j]
    matched = ((bt >= MATCH_THUMB) & (bc >= MATCH_CLIP)) | ((bc >= MATCH_CLIP_STRONG) & (bt >= 0.6))
    return Alignment(j, bc, bt, matched)


def runs(mask: np.ndarray, min_len: int = 2) -> list[tuple[int, int]]:
    out, start = [], None
    for i, v in enumerate(list(mask) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    return out


def _lis_fraction(seq: np.ndarray) -> float:
    if len(seq) == 0:
        return 1.0
    import bisect

    tails: list[int] = []
    for v in seq:
        k = bisect.bisect_right(tails, int(v))
        if k == len(tails):
            tails.append(int(v))
        else:
            tails[k] = int(v)
    return len(tails) / len(seq)


def _region_diff(x: Track, y: Track, ax: Alignment, floor: float = 0.45, mult: float = 4.0) -> dict:
    """Locate a consistent in-frame difference between aligned frame pairs.

    `floor`/`mult` set the per-pixel threshold max(floor, mult*median + 0.15).
    The default is the setting the direction model was trained with; a more
    sensitive pass (floor 0.28) is used only before declaring two videos identical.
    """
    pairs = [(i, int(ax.best_idx[i])) for i in range(len(ax.matched)) if ax.matched[i] and ax.best_thumb[i] >= 0.93]
    if len(pairs) < 2:
        return {"found": False}
    kernel = np.ones((5, 5), np.uint8)
    masks, used = [], []
    shape = None
    for i, j in pairs[:: max(1, len(pairs) // 16)]:
        a = cv2.cvtColor(x.frames[i], cv2.COLOR_BGR2GRAY).astype(np.float32)
        b = cv2.cvtColor(y.frames[j], cv2.COLOR_BGR2GRAY).astype(np.float32)
        b = cv2.resize(b, (a.shape[1], a.shape[0]))
        if shape is None:
            shape = a.shape
        elif a.shape != shape:
            a = cv2.resize(a, (shape[1], shape[0])); b = cv2.resize(b, (shape[1], shape[0]))
        a = (a - a.mean()) / (a.std() + 1e-3); b = (b - b.mean()) / (b.std() + 1e-3)
        d = cv2.GaussianBlur(np.abs(a - b), (0, 0), 3)
        m = (d > max(floor, mult * float(np.median(d)) + 0.15)).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel)
        if m.mean() > 0.5:  # global mismatch (misaligned pair) - not a local edit
            continue
        masks.append(m); used.append((i, j))
    if len(masks) < 2:
        return {"found": False}
    votes = np.mean(masks, axis=0)
    consistent = (votes >= max(0.25, 1.5 / len(masks))).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(consistent, 8)
    if n <= 1:
        return {"found": False}
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    area = stats[k, cv2.CC_STAT_AREA] / consistent.size
    if area < 0.003:
        return {"found": False}
    bx, by, bw, bh = [int(v) for v in stats[k, :4]]
    hits = [float(m[lab == k].mean() > 0.3) for m in masks]
    on = [p for p, h in zip(used, hits) if h]
    return {"found": bool(np.mean(hits) >= 0.25 and area < 0.5), "bbox": [bx, by, bw, bh], "area": float(area), "persistence": float(np.mean(hits)),
            "frame_shape": list(shape), "pairs": on or used, "x_times": [float(x.times[i]) for i, _ in on]}


def _region_side_stats(t: Track, bbox, shape, idxs) -> dict:
    """Noise/texture statistics inside a region relative to the whole frame."""
    if not idxs:
        return {"res_ratio": 0.0, "edge_ratio": 0.0, "tstd": 0.0}
    bx, by, bw, bh = bbox
    rr, er, regs = [], [], []
    for i in idxs:
        f = cv2.cvtColor(t.frames[i], cv2.COLOR_BGR2GRAY)
        f = cv2.resize(f, (shape[1], shape[0])).astype(np.float32)
        res = f - cv2.medianBlur(f.astype(np.uint8), 3).astype(np.float32)
        reg = res[by:by + bh, bx:bx + bw]
        rr.append(np.log((reg.std() + 0.3) / (res.std() + 0.3)))
        e = cv2.Canny(f.astype(np.uint8), 80, 160) > 0
        er.append(np.log((e[by:by + bh, bx:bx + bw].mean() + 0.01) / (e.mean() + 0.01)))
        regs.append(f[by:by + bh, bx:bx + bw])
    tstd = float(np.mean(np.std(np.stack(regs), axis=0))) / (float(np.std(np.stack(regs))) + 1e-3) if len(regs) > 1 else 0.0
    return {"res_ratio": float(np.mean(rr)), "edge_ratio": float(np.mean(er)), "tstd": tstd}


def _boundary_discontinuity(t: Track, a: int, b: int) -> float:
    """1 - mean CLIP similarity across the edges of an unmatched run [a, b)."""
    sims = []
    if a > 0:
        sims.append(float(t.clip[a - 1] @ t.clip[a]))
    if b < len(t.clip):
        sims.append(float(t.clip[b - 1] @ t.clip[b]))
    if not sims:
        return 0.0
    return float(np.clip((0.97 - np.mean(sims)) / 0.17, 0, 1))


def _cut_near(cuts: list[float], t0: float, t1: float) -> bool:
    return any(t0 - 0.2 <= c <= t1 + 0.2 for c in cuts)


@dataclass
class PairAnalysis:
    a: Track
    b: Track
    ab: Alignment
    ba: Alignment
    coverage_a_in_b: float
    coverage_b_in_a: float
    related: bool
    identical: bool
    metrics_a: dict
    metrics_b: dict
    region: dict
    events: list = field(default_factory=list)
    speed_ratio: float = 1.0


def side_metrics(x: Track, y: Track, ax: Alignment, ay: Alignment) -> tuple[dict, list[dict]]:
    """Evidence that X (relative to Y) is the tampered one, plus X-side events."""
    dt = 1.0 / SAMPLE_FPS
    events = []
    unmatched = runs(~ax.matched, 2)
    foreign, native, unexpl_cut = 0.0, 0.0, 0
    for a, b in unmatched:
        disc = _boundary_discontinuity(x, a, b)
        t0, t1 = float(x.times[a]), float(x.times[b - 1]) + dt
        dur = t1 - t0
        cut_edge = _cut_near(x.cut_times, t0 - dt, t0) or _cut_near(x.cut_times, t1 - dt, t1)
        score = max(disc, 0.8 if cut_edge else 0.0)
        foreign += score * dur
        native += (1 - score) * dur
        events.append({"side": "x", "kind": "unmatched", "start": t0, "end": t1, "frames": list(range(a, b)), "foreignness": round(score, 3)})
    # visual cuts in X that are not mirrored in Y at the aligned time
    for c in x.cut_times:
        i = int(np.argmin(np.abs(x.times - c)))
        lo, hi = max(0, i - 1), min(len(x.times) - 1, i + 1)
        mapped = [float(y.times[ax.best_idx[k]]) for k in (lo, hi) if ax.matched[k]]
        if len(mapped) == 2 and abs(mapped[1] - mapped[0]) > 3 * dt + 0.3:
            unexpl_cut += 1  # cut coincides with a jump in source time: an edit point
            events.append({"side": "x", "kind": "jump_cut", "time": c})
        elif len(mapped) < 2:
            if not any(abs(yc - (mapped[0] if mapped else -99)) < 0.5 for yc in y.cut_times):
                unexpl_cut += 1
                events.append({"side": "x", "kind": "cut", "time": c})
    # source-time jumps between consecutive matched samples (cuts that are visually smooth)
    seq = [(i, int(ax.best_idx[i])) for i in range(len(ax.matched)) if ax.matched[i]]
    jumps = 0
    for (i0, j0), (i1, j1) in zip(seq, seq[1:]):
        gap_x = float(x.times[i1] - x.times[i0])
        gap_y = float(y.times[j1] - y.times[j0])
        if gap_x <= 2 * dt + 1e-3 and (gap_y > gap_x + 1.0 or gap_y < -0.5):
            jumps += 1
    order = np.array([j for _, j in seq])
    lis = _lis_fraction(order)
    q = x.forensic
    m = {
        "foreign_s": foreign, "native_s": native, "unexpl_cuts": float(unexpl_cut), "jumps": float(jumps), "disorder": 1.0 - lis,
        "lapvar": float(q[:, 16].mean()), "hf": float(np.log(q[:, 1].mean() + 1e-4)), "block": float(q[:, 23].mean()), "res_std": float(np.log(q[:, 10].mean() + 1e-3)),
        "bpp": float(np.log(x.bpp + 1e-4)), "pixels": float(np.log(max(1, x.width * x.height))), "motion": float(np.log(x.motion + 0.1)),
        "unmatched_frac": float(1.0 - ax.matched.mean()),
    }
    return m, events


DIRECTION_FEATURES = ["foreign_s", "native_s", "unexpl_cuts", "jumps", "disorder", "lapvar", "hf", "block", "res_std", "bpp", "pixels", "motion",
                      "region_res", "region_edge", "region_tstd", "ai_prob", "ai_unmatched", "speed"]


def analyse_pair(a: Track, b: Track) -> PairAnalysis:
    ab, ba = align(a, b), align(b, a)
    cov_a, cov_b = float(ab.matched.mean()), float(ba.matched.mean())
    related = max(cov_a, cov_b) >= 0.30
    ma, ea = side_metrics(a, b, ab, ba)
    mb, eb = side_metrics(b, a, ba, ab)
    region = _region_diff(b, a, ba) if related else {"found": False}
    if region.get("found"):
        shape = region["frame_shape"]
        # bbox is in B-frame coordinates (B grey frames, resized for diff); stats on each side's matched frames
        bi = [i for i, _ in region["pairs"]]
        ai = [j for _, j in region["pairs"]]
        sb = _region_side_stats(b, region["bbox"], shape, bi)
        sa = _region_side_stats(a, region["bbox"], shape, ai)
    else:
        sa = sb = {"res_ratio": 0.0, "edge_ratio": 0.0, "tstd": 0.0}
    for m, s in ((ma, sa), (mb, sb)):
        m["region_res"] = abs(s["res_ratio"]); m["region_edge"] = abs(s["edge_ratio"]); m["region_tstd"] = -s["tstd"]
    # playback speed: slope of matched source-time vs time
    speed = 1.0
    seq = [(float(b.times[i]), float(a.times[ba.best_idx[i]])) for i in range(len(ba.matched)) if ba.matched[i]]
    if len(seq) >= 4:
        steps = [(ta1 - ta0) / (tb1 - tb0) for (tb0, ta0), (tb1, ta1) in zip(seq, seq[1:]) if tb1 - tb0 > 1e-3 and 0 < ta1 - ta0 < 6 * (tb1 - tb0)]
        if len(steps) >= 3:
            slope = float(np.median(steps))
            if 0.2 < slope < 5:
                speed = slope
    ma["speed"] = -float(np.log(speed)); mb["speed"] = float(np.log(speed))  # B covers more source-time per second -> B sped up
    ma["ai_prob"] = mb["ai_prob"] = 0.0
    ma["ai_unmatched"] = mb["ai_unmatched"] = 0.0
    identical = cov_a > 0.97 and cov_b > 0.97 and not region.get("found") and abs(np.log(speed)) < 0.08 and ma["unexpl_cuts"] == mb["unexpl_cuts"] == 0
    dur_ratio = min(a.duration, b.duration) / max(a.duration, b.duration, 1e-6)
    if identical and dur_ratio < 0.95:
        # same-looking content but clearly different length: footage was removed (static scenes
        # let the removed frames find look-alike matches, so coverage alone cannot see the cut)
        identical = False
    if identical:
        # before declaring "no tampering", look again with a more sensitive region detector
        # (well-blended inpainting leaves only weak pixel differences)
        fine = _region_diff(b, a, ba, floor=0.28, mult=4.0)
        if fine.get("found"):
            region = fine
            identical = False
    for e in ea:
        e["side"] = "a"
    for e in eb:
        e["side"] = "b"
    return PairAnalysis(a, b, ab, ba, cov_a, cov_b, related, identical, ma, mb, region, ea + eb, speed)


def direction_vector(pa: PairAnalysis) -> np.ndarray:
    """Antisymmetric feature vector: positive values = evidence that B is tampered."""
    return np.array([pa.metrics_b[k] - pa.metrics_a[k] for k in DIRECTION_FEATURES], np.float32)


def set_ai_evidence(pa: PairAnalysis, ai_a: float, ai_b: float, frame_probs_a: np.ndarray, frame_probs_b: np.ndarray) -> None:
    pa.metrics_a["ai_prob"] = float(ai_a); pa.metrics_b["ai_prob"] = float(ai_b)
    ua = ~pa.ab.matched; ub = ~pa.ba.matched
    pa.metrics_a["ai_unmatched"] = float(np.max(frame_probs_a[ua])) if ua.any() else 0.0
    pa.metrics_b["ai_unmatched"] = float(np.max(frame_probs_b[ub])) if ub.any() else 0.0
