from __future__ import annotations

import re
from dataclasses import dataclass
from math import isfinite
from typing import Iterable

MATCH_THRESHOLD = 0.55
STRONG_THRESHOLD = 0.72
STOPWORDS = {
    "a","an","the","and","or","but","of","to","in","on","for","with","at","by","from","as","is","are","was","were","be","been","it","this","that","these","those","you","i","we","they","he","she","uh","um",
}


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", text.lower())).strip()


def tokens(text: str) -> set[str]:
    return {t for t in normalize(text).split() if len(t) > 1 and t not in STOPWORDS}


def similarity(a: str, b: str) -> float:
    sa, sb = tokens(a), tokens(b)
    if not sa and not sb:
        return 0.0
    return len(sa & sb) / max(1, len(sa | sb))


def confidence(sim: float) -> float:
    return max(0.0, min(1.0, (sim - 0.3) / 0.6))


_SEMANTIC_MODEL = None


def _semantic_align(source: list[dict], edited: list[dict]) -> list[dict]:
    global _SEMANTIC_MODEL
    from sentence_transformers import SentenceTransformer  # type: ignore
    import faiss  # type: ignore

    if _SEMANTIC_MODEL is None:
        _SEMANTIC_MODEL = SentenceTransformer("all-MiniLM-L6-v2")
    source_text = [x["text"] for x in source]
    edited_text = [x["text"] for x in edited]
    if not source_text or not edited_text:
        return []
    src = _SEMANTIC_MODEL.encode(source_text, normalize_embeddings=True, convert_to_numpy=True).astype("float32")
    edt = _SEMANTIC_MODEL.encode(edited_text, normalize_embeddings=True, convert_to_numpy=True).astype("float32")
    index = faiss.IndexFlatIP(src.shape[1])
    index.add(src)
    scores, ids = index.search(edt, 1)
    candidates = []
    for edited_idx, (score_row, id_row) in enumerate(zip(scores, ids)):
        source_idx = int(id_row[0])
        sim = float(score_row[0])
        if source_idx >= 0 and sim >= MATCH_THRESHOLD:
            candidates.append((sim, source_idx, edited_idx))
    candidates.sort(reverse=True)
    used_s, used_e = set(), set()
    mappings = []
    for sim, source_idx, edited_idx in candidates:
        if source_idx in used_s or edited_idx in used_e:
            continue
        used_s.add(source_idx); used_e.add(edited_idx)
        mappings.append({"sourceIndex": source_idx, "editedIndex": edited_idx, "similarity": sim, "confidence": confidence(sim), "method": "sentence-transformers+faiss-v1"})
    return sorted(mappings, key=lambda x: x["sourceIndex"])


def align(source: list[dict], edited: list[dict]) -> tuple[list[dict], str | None]:
    try:
        mappings = _semantic_align(source, edited)
        return mappings, None
    except Exception as exc:
        # The deterministic token matcher is a real, explainable fallback. The
        # caller records the provider failure so it is never hidden.
        pairs = []
        for i, src in enumerate(source):
            for j, edt in enumerate(edited):
                sim = similarity(src["text"], edt["text"])
                if sim >= MATCH_THRESHOLD:
                    pairs.append((sim, i, j))
        pairs.sort(reverse=True)
        used_s, used_e = set(), set()
        mappings = []
        for sim, i, j in pairs:
            if i in used_s or j in used_e:
                continue
            used_s.add(i); used_e.add(j)
            mappings.append({"sourceIndex": i, "editedIndex": j, "similarity": sim, "confidence": confidence(sim), "method": "token-jaccard-fallback-v1"})
        return sorted(mappings, key=lambda x: x["sourceIndex"]), f"Semantic embedding/FAISS alignment unavailable; token-similarity fallback used ({type(exc).__name__})."


def detect_events(source: list[dict], edited: list[dict], mappings: list[dict], ocr_source: list[str] | None, ocr_edited: list[str] | None) -> list[dict]:
    events: list[dict] = []
    by_s = {x["index"]: x for x in source}
    by_e = {x["index"]: x for x in edited}
    matched_s = {x["sourceIndex"] for x in mappings}
    matched_e = {x["editedIndex"] for x in mappings}

    for seg in source:
        if seg["index"] in matched_s:
            continue
        dur = max(0.2, seg["endTime"] - seg["startTime"])
        if seg["confidence"] < 0.45 or dur < 1.0:
            continue
        sev = "high" if dur >= 12 else "medium" if dur >= 4 else "low"
        events.append({
            "category": "Omission", "severity": sev,
            "confidence": min(1, 0.55 + seg["confidence"] * 0.35),
            "sourceStart": seg["startTime"], "sourceEnd": seg["endTime"],
            "editedStart": None, "editedEnd": None,
            "evidenceType": "speech_alignment",
            "explanation": f"Source statement at {fmt(seg['startTime'])}–{fmt(seg['endTime'])} has no sufficiently similar counterpart in the edited transcript: \"{seg['text'][:140]}\"",
            "observedChange": f"Source segment at {fmt(seg['startTime'])} ({dur:.1f}s) has no counterpart in the edited version.",
            "contextualImpact": "Material source content is absent from the edit. Review the source interval to determine whether the omission changes the conveyed context.",
            "sourceSegmentIds": [seg["index"]], "editedSegmentIds": [],
        })

    by_edit_order = sorted(mappings, key=lambda x: x["editedIndex"])
    for prev, cur in zip(by_edit_order, by_edit_order[1:]):
        if cur["sourceIndex"] < prev["sourceIndex"]:
            a, b = by_s[prev["sourceIndex"]], by_s[cur["sourceIndex"]]
            ea, eb = by_e[prev["editedIndex"]], by_e[cur["editedIndex"]]
            avg = (prev["similarity"] + cur["similarity"]) / 2
            events.append({
                "category": "Reordering", "severity": "medium", "confidence": min(1, avg),
                "sourceStart": min(a["startTime"], b["startTime"]), "sourceEnd": max(a["endTime"], b["endTime"]),
                "editedStart": min(ea["startTime"], eb["startTime"]), "editedEnd": max(ea["endTime"], eb["endTime"]),
                "evidenceType": "speech_alignment",
                "explanation": f"Edited statements map to source segments in a different order around {fmt(ea['startTime'])}–{fmt(eb['startTime'])}.",
                "observedChange": f"Non-monotonic source mapping detected; average similarity {avg:.2f}.",
                "contextualImpact": "Reordering can alter chronology, emphasis or perceived causality; inspect both intervals.",
                "sourceSegmentIds": [prev["sourceIndex"], cur["sourceIndex"]], "editedSegmentIds": [prev["editedIndex"], cur["editedIndex"]],
            })
        elif cur["sourceIndex"] > prev["sourceIndex"]:
            gap = by_s[cur["sourceIndex"]]["startTime"] - by_s[prev["sourceIndex"]]["endTime"]
            if gap >= 20:
                events.append({
                    "category": "Discontinuity", "severity": "high" if gap >= 60 else "medium", "confidence": min(1, 0.5 + ((prev["similarity"] + cur["similarity"]) / 2) * 0.35),
                    "sourceStart": by_s[prev["sourceIndex"]]["endTime"], "sourceEnd": by_s[cur["sourceIndex"]]["startTime"],
                    "editedStart": by_e[prev["editedIndex"]]["endTime"], "editedEnd": by_e[cur["editedIndex"]]["startTime"],
                    "evidenceType": "speech_alignment",
                    "explanation": f"Adjacent edited statements jump across approximately {gap:.0f}s of source material.",
                    "observedChange": f"Non-contiguous source mapping with a {gap:.0f}s skipped interval.",
                    "contextualImpact": "The edit joins non-adjacent source material. Review the skipped interval to determine whether context is materially affected.",
                    "sourceSegmentIds": [prev["sourceIndex"], cur["sourceIndex"]], "editedSegmentIds": [prev["editedIndex"], cur["editedIndex"]],
                })

    for seg in edited:
        if seg["index"] in matched_e:
            continue
        dur = max(0.2, seg["endTime"] - seg["startTime"])
        if seg["confidence"] < 0.45 or dur < 1.5:
            continue
        before = any(x["editedIndex"] < seg["index"] for x in mappings)
        after = any(x["editedIndex"] > seg["index"] for x in mappings)
        if before and after:
            events.append({
                "category": "Splicing", "severity": "high" if dur >= 8 else "medium" if dur >= 3 else "low", "confidence": min(1, 0.5 + seg["confidence"] * 0.35),
                "sourceStart": None, "sourceEnd": None, "editedStart": seg["startTime"], "editedEnd": seg["endTime"],
                "evidenceType": "speech_alignment",
                "explanation": f"Edited-video speech at {fmt(seg['startTime'])}–{fmt(seg['endTime'])} has no counterpart in the provided source and is between matched material.",
                "observedChange": f"Unmatched inserted speech at {fmt(seg['startTime'])}.",
                "contextualImpact": "The edit contains material absent from the source. It may be an inserted excerpt or a source mismatch; inspect the interval before interpreting it.",
                "sourceSegmentIds": [], "editedSegmentIds": [seg["index"]],
            })

    if ocr_edited:
        speech = tokens(" ".join(x["text"] for x in edited))
        ocr = tokens(" ".join(ocr_edited))
        if len(ocr) >= 4:
            overlap = len(ocr & speech) / len(ocr)
            if overlap < 0.25:
                events.append({
                    "category": "Caption/Speech Mismatch", "severity": "low", "confidence": min(1, 0.5 + (0.25 - overlap)),
                    "sourceStart": None, "sourceEnd": None, "editedStart": None, "editedEnd": None,
                    "evidenceType": "ocr_caption",
                    "explanation": f"Visible edited-video text shares little vocabulary with the transcribed speech (overlap {overlap * 100:.0f}%).",
                    "observedChange": "Caption/speech vocabulary mismatch detected.",
                    "contextualImpact": "Visible text may add or alter information relative to speech. OCR quality should be reviewed before treating this as material evidence.",
                    "sourceSegmentIds": [], "editedSegmentIds": [],
                })
    return events


def compute_score(events: list[dict]) -> tuple[int, int]:
    weights = {"Omission": .35, "Reordering": .18, "Splicing": .22, "Discontinuity": .12, "Caption/Speech Mismatch": .08}
    penalty = 0.0
    high = 0
    for e in events:
        sev = {"high": 1.0, "medium": .6, "low": .3}[e["severity"]]
        penalty += weights.get(e["category"], .05) * sev * (.4 + e["confidence"] * .6)
        high += int(e["severity"] == "high")
    return round(max(0, min(1, 1 - penalty)) * 100), high


def run_analysis(source: list[dict], edited: list[dict], source_has_audio: bool, edited_has_audio: bool, ocr_source: list[str] | None = None, ocr_edited: list[str] | None = None) -> dict:
    mappings, alignment_warning = align(source, edited)
    events = detect_events(source, edited, mappings, ocr_source, ocr_edited)
    score, high = compute_score(events)
    coverage = max(0, min(1, 1 - (0.4 if not (source_has_audio and edited_has_audio) else 0) - 0.15 * (0 if source_has_audio and edited_has_audio else 1)))
    avg = sum(x["confidence"] for x in events) / len(events) if events else 0
    uncertainty = max(0, min(1, 0.35 + (1 - coverage) * .3 if not events else .9 - avg * .6 + (1 - coverage) * .2))
    return {"mappings": mappings, "alignmentWarning": alignment_warning, "events": events, "score": score, "highSeverityCount": high, "evidenceCoverage": coverage, "uncertainty": uncertainty}


def fmt(seconds: float | None) -> str:
    if seconds is None or not isfinite(seconds): return "—"
    seconds = max(0, seconds)
    return f"{int(seconds // 60):02d}:{int(seconds % 60):02d}.{int((seconds % 1) * 10)}"
