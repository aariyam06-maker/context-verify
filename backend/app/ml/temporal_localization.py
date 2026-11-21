"""Bounded, post-direction refinement of a single contiguous deletion.

This does not supply features to the direction classifier. It tests an explicit
single-deletion hypothesis and abstains when speed, multiple edits, or weak
visual information make that hypothesis unreliable.
"""
from pathlib import Path

import cv2
import numpy as np


def _signatures(path: Path, rate: float = 10.0, seconds: float = 10.0):
    cap = cv2.VideoCapture(str(path))
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS))
        count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if not cap.isOpened() or not 0 < fps <= 240 or count <= 0:
            raise ValueError("Reliable frame timestamps are unavailable.")
        duration = count / fps
        if duration > seconds + 1 / fps:
            raise ValueError("Single-deletion refinement is limited to complete clips of at most 10 seconds.")
        targets = set(int(round(t * fps)) for t in np.arange(0, duration, 1 / rate))
        frames, times = [], []
        for i in range(min(count, int(seconds * fps) + 1)):
            if not cap.grab():
                break
            if i in targets:
                ok, frame = cap.retrieve()
                if ok:
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                    frames.append(cv2.resize(gray, (64, 36), interpolation=cv2.INTER_AREA).reshape(-1).astype(np.float32) / 255)
                    times.append(i / fps)
        if len(frames) < 4:
            raise ValueError("Insufficient temporal samples.")
        return np.stack(frames), np.asarray(times), duration, fps
    finally:
        cap.release()


def localize_single_deletion(original: Path, edited: Path) -> dict:
    """Estimate [start,end) in ORIGINAL time, with a 0.1 s sampling floor."""
    try:
        source, st, sd, sfps = _signatures(original)
        target, tt, td, tfps = _signatures(edited)
    except (ValueError, cv2.error) as exc:
        return {"localized": False, "reason": str(exc)}
    delta = sd - td
    if delta < 0.15 or delta >= sd - 0.3:
        return {"localized": False, "reason": "No supported single-deletion duration difference."}

    def nearest(times):
        return np.argmin(np.abs(st[:, None] - times[None, :]), axis=0)

    before = np.mean((target - source[nearest(tt)]) ** 2, axis=1)
    after = np.mean((target - source[nearest(tt + delta)]) ** 2, axis=1)
    costs = np.r_[0., np.cumsum(before)] + np.r_[np.cumsum(after[::-1])[::-1], 0.]
    best = int(np.argmin(costs))
    fit = float(costs[best] / len(tt))
    # A uniform speed change is a competing explanation for unequal lengths.
    speed_fit = float(np.mean((target - source[nearest(tt * sd / td)]) ** 2))
    distances = np.maximum(0., np.mean(target ** 2, axis=1)[:, None] + np.mean(source ** 2, axis=1)[None, :] - 2 * (target @ source.T) / source.shape[1])
    free_fit = float(distances.min(axis=1).mean())
    near = np.flatnonzero(costs <= costs[best] + max(1e-7, float(np.median(costs) - costs[best]) * .02))
    split_times = np.r_[tt, td]
    width = float(split_times[near[-1]] - split_times[near[0]])
    diagnostics = {"fit_mse": fit, "speed_mse": speed_fit, "free_match_mse": free_fit, "candidate_width_seconds": width, "method": "single_deletion_thumbnail_change_point", "sampling_seconds": .1}
    if fit > .0025 or fit > max(4 * free_fit, 1e-6):
        return {**diagnostics, "localized": False, "reason": "A single deletion does not adequately explain the visual correspondence."}
    if speed_fit <= fit * 1.5 or width > .3:
        return {**diagnostics, "localized": False, "reason": "Ambiguous timing: speed change or insufficient visual information."}
    start = float(split_times[best])
    return {**diagnostics, "localized": True, "start": start, "end": min(sd, start + delta), "boundary_resolution_seconds": max(.1, 1 / sfps, 1 / tfps), "assumption": "One contiguous deletion, unchanged playback rate, otherwise corresponding complete short clips."}
