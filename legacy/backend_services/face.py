from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
YUNET_PATH = Path(os.getenv("CTXTRACE_YUNET_MODEL", ROOT / "data" / "models" / "face_detection_yunet_2023mar.onnx"))
_detector = None


def _yunet():
    global _detector
    if _detector is not None:
        return _detector
    if not YUNET_PATH.exists() or not hasattr(cv2, "FaceDetectorYN"):
        return None
    _detector = cv2.FaceDetectorYN.create(str(YUNET_PATH), "", (320, 320), 0.7, 0.3, 5000)
    return _detector


def detect_largest_face(frame: np.ndarray) -> tuple[np.ndarray | None, dict[str, Any]]:
    h, w = frame.shape[:2]
    det = _yunet()
    boxes: list[tuple[int, int, int, int, float]] = []
    if det is not None:
        try:
            det.setInputSize((w, h))
            _, faces = det.detect(frame)
            if faces is not None:
                for row in faces:
                    x, y, fw, fh = [int(v) for v in row[:4]]
                    score = float(row[-1])
                    boxes.append((x, y, fw, fh, score))
        except Exception:
            boxes = []
    if not boxes:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=5, minSize=(48, 48))
        boxes = [(int(x), int(y), int(fw), int(fh), 0.5) for x, y, fw, fh in faces]
    if not boxes:
        return None, {"found": False, "method": "none", "confidence": 0.0, "count": 0}
    x, y, fw, fh, score = max(boxes, key=lambda b: b[2] * b[3])
    pad_x, pad_y = int(fw * 0.30), int(fh * 0.38)
    x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
    x1, y1 = min(w, x + fw + pad_x), min(h, y + fh + pad_y)
    crop = frame[y0:y1, x0:x1]
    return crop if crop.size else None, {"found": True, "method": "yunet" if det is not None else "haar", "confidence": score, "count": len(boxes), "box": [x, y, fw, fh]}


def track_largest_faces(frames: list[tuple[float, np.ndarray]]) -> list[tuple[np.ndarray | None, dict[str, Any]]]:
    """Detect and temporally associate the dominant face across sampled frames.

    This is a lightweight IoU tracker: detection is performed per frame, then
    the box with the strongest overlap to the previous tracked box is selected.
    It is intentionally deterministic and avoids claiming multi-person identity
    tracking. The returned metadata exposes coverage and detector provenance.
    """
    previous: tuple[int, int, int, int] | None = None
    output: list[tuple[np.ndarray | None, dict[str, Any]]] = []
    for _, frame in frames:
        crop, meta = detect_largest_face(frame) if previous is None else (None, None)
        # Re-run detection when a track exists so the crop follows head motion.
        if previous is not None:
            h, w = frame.shape[:2]
            det = _yunet()
            candidates: list[tuple[int, int, int, int, float, str]] = []
            if det is not None:
                try:
                    det.setInputSize((w, h)); _, faces = det.detect(frame)
                    if faces is not None:
                        candidates = [(int(r[0]), int(r[1]), int(r[2]), int(r[3]), float(r[-1]), "yunet") for r in faces]
                except Exception:
                    candidates = []
            if not candidates:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
                candidates = [(int(x), int(y), int(fw), int(fh), 0.5, "haar") for x, y, fw, fh in cascade.detectMultiScale(gray, 1.08, 5, minSize=(48, 48))]
            if candidates:
                px, py, pw, ph = previous
                def iou(c: tuple[int, int, int, int, float, str]) -> float:
                    x, y, cw, ch = c[:4]
                    ax0, ay0, ax1, ay1 = px, py, px + pw, py + ph
                    bx0, by0, bx1, by1 = x, y, x + cw, y + ch
                    ix0, iy0, ix1, iy1 = max(ax0, bx0), max(ay0, by0), min(ax1, bx1), min(ay1, by1)
                    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
                    union = pw * ph + cw * ch - inter
                    return inter / max(union, 1)
                best = max(candidates, key=iou)
                if iou(best) < 0.05:
                    best = max(candidates, key=lambda c: c[2] * c[3])
                x, y, fw, fh, conf, method = best
                # EMA smoothing reduces frame-to-frame crop jitter.
                x = int(0.65 * px + 0.35 * x); y = int(0.65 * py + 0.35 * y)
                fw = int(0.65 * pw + 0.35 * fw); fh = int(0.65 * ph + 0.35 * fh)
                previous = (x, y, fw, fh)
                pad_x, pad_y = int(fw * 0.30), int(fh * 0.38)
                x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
                x1, y1 = min(w, x + fw + pad_x), min(h, y + fh + pad_y)
                crop = frame[y0:y1, x0:x1]
                meta = {"found": bool(crop.size), "method": method, "confidence": conf, "count": len(candidates), "box": [x, y, fw, fh], "tracked": True}
            else:
                previous = None
                crop, meta = None, {"found": False, "method": "lost", "confidence": 0.0, "count": 0, "tracked": True}
        else:
            if meta and meta.get("found") and meta.get("box"):
                previous = tuple(meta["box"])
                meta["tracked"] = True
        output.append((crop, meta or {"found": False, "method": "none", "confidence": 0.0, "count": 0, "tracked": False}))
    return output
