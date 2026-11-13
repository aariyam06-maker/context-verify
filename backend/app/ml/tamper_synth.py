"""Synthetic evidence-tampering generator.

Creates a tampered derivative of an original clip using operations seen in
real-world manipulated evidence. Used to train/evaluate the pairwise
"which one is original" model and for the scenario-2 acceptance tests.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

OPS = ["cut_middle", "insert_foreign", "insert_ai", "replace_segment", "reorder", "object_removal", "copy_move", "caption_overlay", "speed_change", "trim_ends"]


@dataclass
class TamperResult:
    frames: list[np.ndarray]
    fps: float
    ops: list[dict] = field(default_factory=list)


def _fit(frames: list[np.ndarray], shape: tuple[int, int]) -> list[np.ndarray]:
    h, w = shape
    out = []
    for f in frames:
        fh, fw = f.shape[:2]
        s = max(w / fw, h / fh)
        r = cv2.resize(f, (int(fw * s) + 1, int(fh * s) + 1))
        y, x = (r.shape[0] - h) // 2, (r.shape[1] - w) // 2
        out.append(r[y:y + h, x:x + w])
    return out


def cut_middle(frames, fps, rng, **_):
    n = len(frames)
    length = int(n * rng.uniform(0.18, 0.40))
    start = int(rng.integers(int(n * 0.15), max(int(n * 0.15) + 1, n - length - int(n * 0.1))))
    out = frames[:start] + frames[start + length:]
    return out, {"op": "cut_middle", "removed_original_s": [start / fps, (start + length) / fps], "tampered_cut_s": start / fps}


def _insert(frames, fps, rng, foreign, kind):
    n = len(frames)
    seg_len = int(min(len(foreign), fps * rng.uniform(1.5, 3.0)))
    fstart = int(rng.integers(0, max(1, len(foreign) - seg_len)))
    seg = _fit(foreign[fstart:fstart + seg_len], frames[0].shape[:2])
    pos = int(rng.integers(int(n * 0.2), int(n * 0.8)))
    out = frames[:pos] + seg + frames[pos:]
    return out, {"op": kind, "inserted_tampered_s": [pos / fps, (pos + len(seg)) / fps]}


def insert_foreign(frames, fps, rng, foreign=None, **_):
    return _insert(frames, fps, rng, foreign, "insert_foreign")


def insert_ai(frames, fps, rng, ai_foreign=None, foreign=None, **_):
    return _insert(frames, fps, rng, ai_foreign if ai_foreign is not None else foreign, "insert_ai")


def replace_segment(frames, fps, rng, foreign=None, ai_foreign=None, **_):
    src = ai_foreign if (ai_foreign is not None and rng.random() < 0.5) else foreign
    n = len(frames)
    seg_len = int(min(len(src), n * rng.uniform(0.15, 0.30)))
    pos = int(rng.integers(int(n * 0.15), max(int(n * 0.15) + 1, n - seg_len - int(n * 0.1))))
    seg = _fit(src[:seg_len], frames[0].shape[:2])
    out = frames[:pos] + seg + frames[pos + seg_len:]
    return out, {"op": "replace_segment", "replaced_s": [pos / fps, (pos + seg_len) / fps], "ai_source": src is ai_foreign}


def reorder(frames, fps, rng, **_):
    n = len(frames)
    a = int(rng.integers(int(n * 0.15), int(n * 0.45)))
    b = int(rng.integers(a + int(n * 0.2), int(n * 0.85)))
    out = frames[:a] + frames[b:] + frames[a:b]
    return out, {"op": "reorder", "moved_original_s": [a / fps, b / fps]}


def _region(shape, rng, frac=(0.03, 0.10)):
    h, w = shape[:2]
    area = h * w * rng.uniform(*frac)
    rw = int(np.sqrt(area * rng.uniform(0.6, 1.6)))
    rh = int(area / max(rw, 1))
    rw, rh = min(rw, w - 4), min(rh, h - 4)
    x = int(rng.integers(2, max(3, w - rw - 2)))
    y = int(rng.integers(2, max(3, h - rh - 2)))
    return x, y, rw, rh


def object_removal(frames, fps, rng, **_):
    """Inpaint a region over a time span (classic 'remove an object/person' edit)."""
    n = len(frames)
    x, y, rw, rh = _region(frames[0].shape, rng)
    t0 = int(rng.integers(0, max(1, n // 3)))
    t1 = int(rng.integers(max(t0 + int(n * 0.3), t0 + 1), n + 1))
    out = []
    mask = np.zeros(frames[0].shape[:2], np.uint8)
    mask[y:y + rh, x:x + rw] = 255
    for i, f in enumerate(frames):
        if t0 <= i < t1:
            small = cv2.resize(f, None, fx=0.5, fy=0.5)
            m2 = cv2.resize(mask, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
            filled = cv2.resize(cv2.inpaint(small, m2, 5, cv2.INPAINT_TELEA), (f.shape[1], f.shape[0]))
            g = f.copy(); g[y:y + rh, x:x + rw] = filled[y:y + rh, x:x + rw]
            out.append(g)
        else:
            out.append(f)
    return out, {"op": "object_removal", "bbox": [x, y, rw, rh], "tampered_s": [t0 / fps, t1 / fps]}


def copy_move(frames, fps, rng, **_):
    n = len(frames)
    x, y, rw, rh = _region(frames[0].shape, rng, (0.02, 0.07))
    h, w = frames[0].shape[:2]
    dx = int(rng.integers(2, max(3, w - rw - 2))); dy = int(rng.integers(2, max(3, h - rh - 2)))
    t0 = int(rng.integers(0, max(1, n // 2))); t1 = min(n, t0 + int(n * rng.uniform(0.3, 0.7)))
    out = []
    for i, f in enumerate(frames):
        if t0 <= i < t1:
            g = f.copy()
            patch = f[y:y + rh, x:x + rw]
            g[dy:dy + rh, dx:dx + rw] = cv2.GaussianBlur(patch, (3, 3), 0) if rng.random() < 0.5 else patch
            out.append(g)
        else:
            out.append(f)
    return out, {"op": "copy_move", "bbox": [dx, dy, rw, rh], "tampered_s": [t0 / fps, t1 / fps]}


CAPTIONS = ["BREAKING: CAUGHT ON CAMERA", "This happened yesterday", "OFFICIAL FOOTAGE", "Leaked video", "LIVE", "Exclusive", "They lied to you", "#viral"]


def caption_overlay(frames, fps, rng, **_):
    text = str(rng.choice(CAPTIONS))
    h, w = frames[0].shape[:2]
    scale = max(0.5, w / 900)
    y = int(h * rng.uniform(0.12, 0.9))
    out = []
    for f in frames:
        g = f.copy()
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, scale, 2)
        x = max(4, (w - tw) // 2)
        if rng.random() < 0.6:  # banner background
            cv2.rectangle(g, (x - 8, y - th - 8), (x + tw + 8, y + 8), (0, 0, 180), -1)
        cv2.putText(g, text, (x, y), cv2.FONT_HERSHEY_DUPLEX, scale, (255, 255, 255), 2, cv2.LINE_AA)
        out.append(g)
    return out, {"op": "caption_overlay", "text": text}


def speed_change(frames, fps, rng, **_):
    step = 2 if rng.random() < 0.7 else 3
    out = frames[::step]
    return out, {"op": "speed_change", "factor": step}


def trim_ends(frames, fps, rng, **_):
    n = len(frames)
    a = int(n * rng.uniform(0.05, 0.25)); b = n - int(n * rng.uniform(0.05, 0.25))
    return frames[a:b], {"op": "trim_ends", "kept_original_s": [a / fps, b / fps]}


FUNCS = {f.__name__: f for f in [cut_middle, insert_foreign, insert_ai, replace_segment, reorder, object_removal, copy_move, caption_overlay, speed_change, trim_ends]}


def tamper(frames: list[np.ndarray], fps: float, rng: np.random.Generator, ops: list[str] | None = None,
           foreign: list[np.ndarray] | None = None, ai_foreign: list[np.ndarray] | None = None) -> TamperResult:
    if ops is None:
        ops = [str(rng.choice(OPS))]
        if rng.random() < 0.3:
            extra = str(rng.choice([o for o in OPS if o != ops[0]]))
            ops.append(extra)
    if foreign is None:
        foreign = ai_foreign
    log = []
    cur = list(frames)
    for op in ops:
        if op in ("insert_foreign", "replace_segment", "insert_ai") and foreign is None:
            op = "cut_middle"
        cur, info = FUNCS[op](cur, fps, rng, foreign=foreign, ai_foreign=ai_foreign)
        log.append(info)
    return TamperResult(cur, fps, log)
