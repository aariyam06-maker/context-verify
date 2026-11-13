"""Optional Google Gemini second opinion (free tier).

Enabled only when GEMINI_API_KEY is set. Four key-frames are sent to the
Gemini REST API and the model is asked for a probability that the footage is
AI-generated. The local model always remains the primary decision-maker; the
Gemini answer is blended with weight CTXTRACE_GEMINI_WEIGHT (default 0.25)
and shown separately in the report.
"""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.request

import cv2
import numpy as np

MODEL = os.getenv("CTXTRACE_GEMINI_MODEL", "gemini-2.5-flash")
PROMPT = (
    "You are a video forensics assistant. These are frames sampled in order from one short video. "
    "Estimate the probability (0 to 1) that the video was generated or synthesised by AI (text-to-video, "
    "face reenactment, deepfake) rather than recorded by a real camera. Look for physically implausible motion, "
    "texture smearing, warped hands/text, inconsistent lighting and identity drift. Reply with JSON only: "
    '{"probability": <number>, "reasons": ["short reason", ...]}'
)


def gemini_opinion(frames: list[np.ndarray], n: int = 4, timeout: int = 40) -> dict | None:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        return None
    picks = [frames[int(i)] for i in np.linspace(0, len(frames) - 1, min(n, len(frames)))]
    parts = [{"text": PROMPT}]
    for f in picks:
        h, w = f.shape[:2]
        s = 768 / max(h, w)
        if s < 1:
            f = cv2.resize(f, (int(w * s), int(h * s)))
        ok, buf = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 88])
        if ok:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(buf.tobytes()).decode()}})
    body = json.dumps({"contents": [{"parts": parts}], "generationConfig": {"temperature": 0, "responseMimeType": "application/json"}}).encode()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode())
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        m = re.search(r"\{.*\}", text, re.S)
        parsed = json.loads(m.group(0) if m else text)
        p = float(parsed.get("probability"))
        return {"model": MODEL, "probability": max(0.0, min(1.0, p)), "reasons": [str(x) for x in parsed.get("reasons", [])][:5]}
    except Exception as exc:  # network / quota / parse errors never break the local analysis
        return {"model": MODEL, "probability": None, "error": f"{type(exc).__name__}: {str(exc)[:160]}"}
