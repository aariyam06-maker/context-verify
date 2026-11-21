"""Run a real CPU classification and print checkpoint, score and elapsed time."""
import argparse
import json
import sys
from pathlib import Path
from time import perf_counter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.app.ml import detector, tamper_service


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    args = parser.parse_args()
    if not args.video.is_file():
        parser.error(f"video does not exist: {args.video}")

    before = perf_counter()
    ai = detector.load_model()
    direction = tamper_service.load_model()
    print(f'Loaded {ai["version"]} and {direction["version"]} in {perf_counter() - before:.2f} s', flush=True)
    print(f"Running full CPU inference on {args.video.name}", flush=True)
    before = perf_counter()
    report = detector.analyze(args.video, use_gemini=False)
    print(json.dumps({
        "verdict": report["verdictLabel"],
        "aiProbability": report["aiProbability"],
        "aiContentShare": report["aiContentShare"],
        "samples": len(report["timeline"]),
        "elapsedSeconds": round(perf_counter() - before, 2),
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
