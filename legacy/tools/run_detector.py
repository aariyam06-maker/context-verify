#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from backend.app.services.ai_detector import analyze_video
from backend.app.services.media import probe_media


def main() -> None:
    p = argparse.ArgumentParser(description="Run the ContextTrace detector over a manifest and emit video-level predictions.")
    p.add_argument("manifest", type=Path)
    p.add_argument("--out", type=Path, default=Path("predictions.csv"))
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args()
    df = pd.read_csv(args.manifest)
    rows = []
    for idx, item in df.iterrows():
        if args.limit and idx >= args.limit:
            break
        path = Path(str(item["path"]))
        if not path.exists():
            raise SystemExit(f"Missing media: {path}")
        meta = probe_media(path)
        result = analyze_video(path, float(meta["duration"]))
        rows.append({
            "path": str(path),
            "label": int(item["label"]),
            "generator": str(item["generator"]),
            "source_id": str(item["source_id"]),
            "split": str(item["split"]),
            "domain": str(item["domain"]),
            "primary_score": next((c["score"] for c in result["components"] if c["id"] == "face_temporal_detector"), 0.5),
            "secondary_score": next((c["score"] for c in result["components"] if c["id"] == "frame_detector"), 0.5),
            "forensic_score": result["forensicSupportScore"] / 100.0,
            "temporal_agreement": result["temporalAgreement"],
            "face_coverage": result["faceCoverage"],
            "score": result["rawAiArtifactIndex"] / 100.0,
            "score_type": result["scoreType"],
            "model_version": result["modelVersion"],
        })
        print(f"[{idx + 1}/{len(df)}] {path.name}: {result['rawAiArtifactIndex']:.1f}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(args.out, index=False)
    print(json.dumps({"rows": len(rows), "output": str(args.out)}, indent=2))


if __name__ == "__main__":
    main()
