from __future__ import annotations

import json
import math
import shutil
import subprocess
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..models import AlignmentMapping, AnalysisJob, EvidenceEvent, Report, TranscriptSegment, Video
from .engine import run_analysis
from .media import probe_media

STAGES = [
    "media_validation", "preprocessing", "speech_analysis", "semantic_alignment",
    "visual_evidence", "ocr_evidence", "edit_detection", "context_analysis", "report_generation",
]

DEMO_SOURCE = [
    ("Welcome everyone. Today we're presenting the quarterly review of the water quality monitoring program.", .94),
    ("The monitoring program covers twelve river sites and three coastal stations across the region.", .96),
    ("Overall readings this quarter remained within acceptable limits at most sites.", .91),
    ("Two sites showed elevated phosphate levels during the August sampling window.", .95),
    ("We expect the elevated readings to normalise once the seasonal rainfall dilutes runoff concentrations.", .93),
    ("Funding for the lab analysis came from the regional environment agency grant.", .90),
    ("Next quarter we will publish the full site-by-site dataset on the public portal.", .92),
    ("Thank you for joining this briefing, and we welcome your questions by email.", .95),
]
DEMO_EDITED = [
    (DEMO_SOURCE[0][0], .93), DEMO_SOURCE[3], DEMO_SOURCE[2], DEMO_SOURCE[5], DEMO_SOURCE[7]
]


def _set_progress(db: Session, job: AnalysisJob, stage: str, pct: int) -> None:
    job.status = "RUNNING"
    job.current_stage = stage
    job.progress = pct
    db.commit()


def _sample_times(duration: float, count: int = 24) -> list[float]:
    if duration <= 0:
        return []
    if count == 1:
        return [duration / 2]
    return [round(i * duration / (count - 1), 3) for i in range(count)]


def _frame_histogram(path: Path, t: float) -> np.ndarray | None:
    cap = cv2.VideoCapture(str(path))
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            return None
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        return hist.flatten().astype(np.float32)
    finally:
        cap.release()


_OPENCLIP = None
_OPENCLIP_PREPROCESS = None
_OPENCLIP_DEVICE = None

def _openclip_embeddings(path: Path, times: list[float]):
    global _OPENCLIP, _OPENCLIP_PREPROCESS, _OPENCLIP_DEVICE
    import torch  # type: ignore
    import open_clip  # type: ignore
    from PIL import Image  # type: ignore

    if _OPENCLIP is None:
        _OPENCLIP_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
        _OPENCLIP, _, _OPENCLIP_PREPROCESS = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="openai", device=_OPENCLIP_DEVICE
        )
        _OPENCLIP.eval()

    frames = []
    valid_times = []
    for t in times:
        cap = cv2.VideoCapture(str(path))
        try:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = cap.read()
        finally:
            cap.release()
        if not ok or frame is None:
            continue
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        frames.append(_OPENCLIP_PREPROCESS(Image.fromarray(rgb)))
        valid_times.append(t)
    if not frames:
        return [], []
    batch = torch.stack(frames).to(_OPENCLIP_DEVICE)
    with torch.inference_mode():
        features = _OPENCLIP.encode_image(batch)
        features = features / features.norm(dim=-1, keepdim=True).clamp_min(1e-8)
    return valid_times, features.detach().cpu().numpy()


def visual_correspondence(source: Path, edited: Path, source_duration: float, edited_duration: float) -> list[dict]:
    source_times = _sample_times(source_duration, 24)
    edited_times = _sample_times(edited_duration, 24)

    # Prefer the SRS-named OpenCLIP path when the optional dependency is installed.
    # A deterministic OpenCV histogram remains the documented fallback for small
    # machines and environments without model weights.
    if os.getenv("CTXTRACE_OPENCLIP", "auto").lower() != "off":
        try:
            stimes, sfeat = _openclip_embeddings(source, source_times)
            etimes, efeat = _openclip_embeddings(edited, edited_times)
            if len(stimes) and len(etimes):
                sims = efeat @ sfeat.T
                out = []
                for i, et in enumerate(etimes):
                    j = int(np.argmax(sims[i]))
                    sim = float(sims[i, j])
                    out.append({"editedTime": et, "sourceTime": stimes[j], "similarity": max(0.0, min(1.0, (sim + 1) / 2)), "method": "openclip-vit-b32"})
                return out
        except Exception:
            pass

    source_feats = [(t, _frame_histogram(source, t)) for t in source_times]
    source_feats = [(t, f) for t, f in source_feats if f is not None]
    out = []
    for et in edited_times:
        ef = _frame_histogram(edited, et)
        if ef is None or not source_feats:
            continue
        scores = [(float(cv2.compareHist(ef, sf, cv2.HISTCMP_CORREL)), st) for st, sf in source_feats]
        score, st = max(scores, key=lambda x: x[0])
        out.append({"editedTime": et, "sourceTime": st, "similarity": max(0.0, min(1.0, (score + 1) / 2)), "method": "opencv-hsv-histogram"})
    return out


def transcribe(path: Path, duration: float, has_audio: bool, fixture: str = "source") -> tuple[list[dict], str | None]:
    if not has_audio:
        return [], "No audio track available."
    try:
        from faster_whisper import WhisperModel  # type: ignore

        model_size = "small"
        device = "cuda" if shutil.which("nvidia-smi") else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        segments, _ = model.transcribe(str(path), vad_filter=True, beam_size=3)
        rows = []
        for i, seg in enumerate(segments):
            text = (seg.text or "").strip()
            if not text:
                continue
            rows.append({"index": i, "startTime": float(seg.start), "endTime": float(seg.end), "text": text, "confidence": max(0.0, min(1.0, 1.0 - float(getattr(seg, "avg_logprob", -1.0)) / 10))})
        return rows, None if rows else "ASR returned no speech segments."
    except Exception as exc:
        # Never fabricate transcript content. The SRS requires missing modalities
        # to remain explicit uncertainty rather than become positive evidence.
        return [], f"faster-whisper unavailable; speech evidence not measured ({type(exc).__name__})."

def extract_ocr(path: Path, duration: float) -> tuple[list[str], list[dict], str | None]:
    try:
        from paddleocr import PaddleOCR  # type: ignore

        ocr = PaddleOCR(use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, lang="en")
        texts: list[str] = []
        observations: list[dict] = []
        for t in _sample_times(duration, 8):
            cap = cv2.VideoCapture(str(path)); cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000); ok, frame = cap.read(); cap.release()
            if not ok: continue
            result = ocr.predict(frame)
            for item in result:
                rec_texts = item.get("rec_texts", [])
                rec_scores = item.get("rec_scores", [])
                for i, text in enumerate(rec_texts):
                    if not text: continue
                    score = float(rec_scores[i]) if i < len(rec_scores) else 0.5
                    observations.append({"timestamp": t, "text": text, "confidence": max(0.0, min(1.0, score))})
                    if text not in texts: texts.append(text)
        return texts, observations, None
    except Exception as exc:
        return [], [], f"PaddleOCR unavailable; OCR evidence not measured ({type(exc).__name__})."


def interpretation(score: int, events: list[dict], degraded: bool) -> str:
    if score >= 85 and not events:
        text = "The edited version preserves the source's observed spoken content; no material structural differences were detected by the available correspondence evidence."
    elif score >= 70:
        text = "The edit is broadly consistent with the source, with limited structural differences detected."
    elif score >= 45:
        text = "The edit diverges materially from the source in places; evidence indicates structural changes consistent with excerpting or re-editing."
    else:
        text = "The edit differs substantially from the source; multiple structural differences were detected."
    if any(e["severity"] == "high" for e in events):
        text += " High-severity findings require direct review of the linked intervals."
    if degraded:
        text += " Some evidence modalities were unavailable, so the assessment is based on partial evidence."
    return text + " ContextTrace identifies evidence consistent with contextual change; it does not establish intent."


def run_compare(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(AnalysisJob, job_id)
        if not job:
            return
        source = db.get(Video, job.source_video_id) if job.source_video_id else None
        edited = db.get(Video, job.edited_video_id) if job.edited_video_id else None
        if not source or not edited:
            raise RuntimeError("Source/edit media records are missing.")
        job.started_at = datetime.now(timezone.utc)
        db.commit()

        _set_progress(db, job, "media_validation", 8)
        s_meta = probe_media(Path(source.storage_path)); e_meta = probe_media(Path(edited.storage_path))
        source.duration_seconds = s_meta["duration"]; source.width = s_meta["width"]; source.height = s_meta["height"]; source.has_audio = s_meta["has_audio"]
        edited.duration_seconds = e_meta["duration"]; edited.width = e_meta["width"]; edited.height = e_meta["height"]; edited.has_audio = e_meta["has_audio"]
        db.commit()

        _set_progress(db, job, "preprocessing", 16)
        warnings: list[str] = []

        _set_progress(db, job, "speech_analysis", 30)
        source_segments, sw = transcribe(Path(source.storage_path), s_meta["duration"], s_meta["has_audio"], "source")
        edited_segments, ew = transcribe(Path(edited.storage_path), e_meta["duration"], e_meta["has_audio"], "edited")
        if sw: warnings.append(f"Source speech: {sw}")
        if ew: warnings.append(f"Edited speech: {ew}")
        for row in source_segments:
            db.add(TranscriptSegment(job_id=job.id, video_id=source.id, index=row["index"], start_time=row["startTime"], end_time=row["endTime"], text=row["text"], confidence=row["confidence"]))
        for row in edited_segments:
            db.add(TranscriptSegment(job_id=job.id, video_id=edited.id, index=row["index"], start_time=row["startTime"], end_time=row["endTime"], text=row["text"], confidence=row["confidence"]))
        db.commit()

        _set_progress(db, job, "semantic_alignment", 42)
        _set_progress(db, job, "visual_evidence", 52)
        visual = visual_correspondence(Path(source.storage_path), Path(edited.storage_path), s_meta["duration"], e_meta["duration"])
        if not visual:
            warnings.append("Visual correspondence unavailable; no decodable representative frames were produced.")

        _set_progress(db, job, "ocr_evidence", 62)
        source_ocr, source_ocr_obs, ow1 = extract_ocr(Path(source.storage_path), s_meta["duration"])
        edited_ocr, edited_ocr_obs, ow2 = extract_ocr(Path(edited.storage_path), e_meta["duration"])
        if ow1: warnings.append(f"Source OCR: {ow1}")
        if ow2: warnings.append(f"Edited OCR: {ow2}")

        _set_progress(db, job, "edit_detection", 74)
        result = run_analysis(source_segments, edited_segments, s_meta["has_audio"], e_meta["has_audio"], source_ocr, edited_ocr)
        if result.get("alignmentWarning"): warnings.append(result["alignmentWarning"])
        for m in result["mappings"]:
            db.add(AlignmentMapping(job_id=job.id, source_index=m["sourceIndex"], edited_index=m["editedIndex"], similarity=m["similarity"], confidence=m["confidence"], method=m["method"]))
        for e in result["events"]:
            db.add(EvidenceEvent(job_id=job.id, category=e["category"], severity=e["severity"], confidence=e["confidence"], source_start=e.get("sourceStart"), source_end=e.get("sourceEnd"), edited_start=e.get("editedStart"), edited_end=e.get("editedEnd"), evidence_type=e["evidenceType"], explanation=e["explanation"], observed_change=e["observedChange"], contextual_impact=e["contextualImpact"], source_segment_ids=e.get("sourceSegmentIds", []), edited_segment_ids=e.get("editedSegmentIds", [])))
        db.commit()

        _set_progress(db, job, "context_analysis", 86)
        degraded = bool(warnings)
        _set_progress(db, job, "report_generation", 95)
        report = Report(job_id=job.id, owner_id=job.owner_id, score=result["score"], overall_confidence=max(0.0, min(1.0, 1 - result["uncertainty"])), evidence_coverage=result["evidenceCoverage"], uncertainty=result["uncertainty"], interpretation=interpretation(result["score"], result["events"], degraded), pipeline_version=settings.pipeline_version, model_configuration=settings.model_configuration, degraded=degraded, event_count=len(result["events"]), report_json={"mappings": result["mappings"], "visual": visual, "sourceOcr": source_ocr_obs, "editedOcr": edited_ocr_obs})
        db.add(report)
        job.status = "DEGRADED" if degraded else "COMPLETED"
        job.current_stage = "report_generation"
        job.progress = 100
        job.warnings = warnings
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:
        db.rollback()
        job = db.get(AnalysisJob, job_id)
        if job:
            job.status = "FAILED"; job.error_message = str(exc); job.completed_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        db.close()


def start_job(job_id: str) -> None:
    run_compare(job_id)
