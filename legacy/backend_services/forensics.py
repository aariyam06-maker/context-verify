from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np


def _sample_times(duration: float, count: int = 12) -> list[float]:
    if duration <= 0:
        return []
    if count <= 1:
        return [duration / 2]
    pad = min(0.15, duration / (count * 4))
    end = max(pad + 0.01, duration - pad)
    return [round(pad + i * (end - pad) / (count - 1), 3) for i in range(count)]


def extract_ocr(path: Path, duration: float, count: int = 12) -> tuple[list[dict[str, Any]], str | None]:
    """Run PaddleOCR over representative video frames.

    OCR is deliberately an evidence channel, not an AI-origin classifier. If
    PaddleOCR is unavailable the caller receives an explicit warning.
    """
    try:
        from paddleocr import PaddleOCR  # type: ignore

        ocr = PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            lang="en",
        )
        observations: list[dict[str, Any]] = []
        for timestamp in _sample_times(duration, count):
            cap = cv2.VideoCapture(str(path))
            try:
                cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
                ok, frame = cap.read()
            finally:
                cap.release()
            if not ok or frame is None:
                continue

            result = ocr.predict(frame)
            for item in result:
                texts = item.get("rec_texts", []) if hasattr(item, "get") else []
                scores = item.get("rec_scores", []) if hasattr(item, "get") else []
                for idx, text in enumerate(texts):
                    text = str(text).strip()
                    if not text:
                        continue
                    score = float(scores[idx]) if idx < len(scores) else 0.5
                    observations.append(
                        {
                            "timestamp": timestamp,
                            "text": text,
                            "confidence": max(0.0, min(1.0, score)),
                        }
                    )
        return observations, None
    except Exception as exc:
        return [], f"PaddleOCR unavailable; OCR evidence not measured ({type(exc).__name__})."
