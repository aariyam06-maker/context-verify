"""Video decoding, probing and re-encoding helpers.

OpenCV (bundled FFmpeg) handles decoding, so no system FFmpeg install is
needed. Re-encoding (tamper synthesis, trimming) uses the FFmpeg binary that
ships inside the `imageio-ffmpeg` wheel.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import cv2
import numpy as np

MAX_ANALYSIS_SECONDS = 10.0


def ffmpeg_exe() -> str | None:
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        import shutil

        return shutil.which("ffmpeg")


def has_audio_stream(path: Path) -> bool:
    exe = ffmpeg_exe()
    if not exe:
        return False
    try:
        proc = subprocess.run([exe, "-hide_banner", "-i", str(path)], capture_output=True, text=True, timeout=30)
        return bool(re.search(r"Stream #\d+:\d+.*Audio:", proc.stderr))
    except Exception:
        return False


def probe(path: Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError("Unreadable media: the file could not be decoded as video.")
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        ok, frame = cap.read()
        if not ok or frame is None:
            raise ValueError("No decodable video frames were found.")
        if fps <= 1e-3 or fps > 240:
            fps = 25.0
        if frames <= 0:
            frames = 1
            while cap.read()[0]:
                frames += 1
        duration = frames / fps
        if duration <= 0:
            raise ValueError("Video duration could not be determined.")
        codec = int(cap.get(cv2.CAP_PROP_FOURCC) or 0)
        fourcc = "".join(chr((codec >> 8 * i) & 0xFF) for i in range(4)).strip("\x00 ") or "unknown"
    finally:
        cap.release()
    return {"duration": duration, "fps": fps, "frames": frames, "width": width, "height": height, "codec": fourcc, "has_audio": has_audio_stream(path)}


def read_frames(path: Path, max_seconds: float = MAX_ANALYSIS_SECONDS, max_side: int = 960) -> tuple[list[np.ndarray], float]:
    """Sequentially decode up to `max_seconds` of video (robust for AVI/MP4/WebM).

    Frames larger than `max_side` are downscaled to bound memory on 4K input.
    """
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError("Could not open video.")
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if fps <= 1e-3 or fps > 240:
        fps = 25.0
    limit = int(round(max_seconds * fps)) if max_seconds else 10**9
    out: list[np.ndarray] = []
    try:
        while len(out) < limit:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            h, w = frame.shape[:2]
            if max(h, w) > max_side:
                s = max_side / max(h, w)
                frame = cv2.resize(frame, (int(w * s) // 2 * 2, int(h * s) // 2 * 2), interpolation=cv2.INTER_AREA)
            out.append(frame)
    finally:
        cap.release()
    if not out:
        raise ValueError("No decodable frames.")
    return out, fps


def read_sampled(path: Path, k: int = 8, max_seconds: float = MAX_ANALYSIS_SECONDS, max_side: int = 960, pair: bool = True) -> tuple[list[np.ndarray], list[np.ndarray], list[float], float]:
    """Decode only k evenly spaced frames (plus the frame right after each one).

    Uses grab() to skip frames without colour conversion, which is ~3-5x faster
    than decoding every frame. Returns (frames, next_frames, timestamps, fps).
    """
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError("Could not open video.")
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if fps <= 1e-3 or fps > 240:
        fps = 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    limit = int(round(max_seconds * fps)) if max_seconds else total
    n = min(total, limit) if total > 0 else limit
    n = max(2, n)
    targets = sorted(set(int(round(x)) for x in np.linspace(0, max(0, n - 2), k)))
    wanted = set(targets) | ({t + 1 for t in targets} if pair else set())
    got: dict[int, np.ndarray] = {}
    idx = 0
    last_needed = max(wanted)

    def shrink(frame):
        h, w = frame.shape[:2]
        if max(h, w) > max_side:
            s = max_side / max(h, w)
            frame = cv2.resize(frame, (int(w * s) // 2 * 2, int(h * s) // 2 * 2), interpolation=cv2.INTER_AREA)
        return frame

    try:
        while idx <= last_needed:
            if not cap.grab():
                break
            if idx in wanted:
                ok, frame = cap.retrieve()
                if ok and frame is not None:
                    got[idx] = shrink(frame)
            idx += 1
    finally:
        cap.release()
    frames, nexts, times = [], [], []
    for t in targets:
        if t in got:
            frames.append(got[t]); nexts.append(got.get(t + 1, got[t])); times.append(t / fps)
    if not frames:
        raise ValueError("No decodable frames.")
    return frames, nexts, times, fps


def write_video(frames: list[np.ndarray], fps: float, dest: Path, crf: int = 23, preset: str = "veryfast") -> Path:
    """Encode BGR frames to H.264 MP4 through the bundled FFmpeg (falls back to OpenCV mp4v)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    h, w = frames[0].shape[:2]
    w2, h2 = w // 2 * 2, h // 2 * 2
    exe = ffmpeg_exe()
    if exe:
        cmd = [exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w2}x{h2}", "-r", f"{fps:.4f}", "-i", "-",
               "-c:v", "libx264", "-preset", preset, "-crf", str(int(crf)), "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dest)]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        assert proc.stdin is not None
        try:
            for f in frames:
                if f.shape[0] != h2 or f.shape[1] != w2:
                    f = cv2.resize(f, (w2, h2))
                proc.stdin.write(np.ascontiguousarray(f).tobytes())
        finally:
            proc.stdin.close()
        proc.wait(timeout=600)
        if proc.returncode == 0 and dest.exists():
            return dest
    writer = cv2.VideoWriter(str(dest), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w2, h2))
    for f in frames:
        writer.write(cv2.resize(f, (w2, h2)) if f.shape[:2] != (h2, w2) else f)
    writer.release()
    return dest


def trim_copy(src: Path, dest: Path, seconds: float = MAX_ANALYSIS_SECONDS, max_side: int = 960, crf: int = 20) -> Path:
    frames, fps = read_frames(src, seconds, max_side=max_side)
    return write_video(frames, fps, dest, crf=crf)
