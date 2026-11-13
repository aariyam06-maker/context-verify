"""Build the synthetic original/tampered pair corpus for the direction model.

For each source clip (drawn from the training sources):
  1. trim to <=10 s, <=640 px and write `original.mp4`
  2. apply 1-2 random tampering operations (see app/ml/tamper_synth.py), using
     clips from *other* videos (real or AI-generated) as splice material
  3. write `tampered.mp4`
  4. run the full pair analysis and cache structural metrics + per-frame
     features (so AI-evidence features can be added once the detector exists)

Two encoding conditions are mixed 50/50 to stop the model from simply learning
"the more compressed file is the fake":
  * chain : original near-lossless (CRF 14), tampered re-encoded at CRF 18-30
  * equal : original and tampered encoded at the *same* CRF (18-28)

Usage: python tools/ml/build_tamper_pairs.py [--n 300]
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
import time
import warnings
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.ml import tamper as T  # noqa: E402
from app.ml import tamper_synth as S  # noqa: E402
from app.ml import video_io  # noqa: E402

OUT = ROOT / "data" / "tamper_pairs"


def save_track(prefix: str, t: T.Track, store: dict) -> None:
    store[prefix + "clip"] = t.clip.astype(np.float16)
    store[prefix + "forensic"] = t.forensic
    store[prefix + "temporal"] = t.temporal
    store[prefix + "times"] = t.times


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--keep-videos", type=int, default=12, help="keep the mp4s of the first N pairs for inspection")
    args = ap.parse_args()
    rows = list(csv.DictReader(open(ROOT / "data/datasets/manifest.csv", encoding="utf-8")))
    rng = np.random.default_rng(7)
    real = [r for r in rows if r["label"] == "real"]
    ai = [r for r in rows if r["label"] == "ai"]
    # 80% of originals are real camera clips, 20% AI clips (tampering of AI media is also realistic)
    n_real = int(args.n * 0.8)
    sources = list(rng.choice(real, n_real, replace=False)) + list(rng.choice(ai, args.n - n_real, replace=False))
    rng.shuffle(sources)
    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / "index.jsonl"
    done = set()
    if index_path.exists():
        done = {json.loads(l)["id"] for l in index_path.open(encoding="utf-8")}
    t0 = time.time()
    for k, src in enumerate(sources):
        pid = f"pair_{k:04d}"
        if pid in done:
            continue
        d = OUT / pid
        try:
            frames, fps = video_io.read_frames(ROOT / src["path"], 10.0, max_side=640)
            if len(frames) < fps * 2.5:
                continue
            frow = real[int(rng.integers(len(real)))]
            while frow["path"] == src["path"]:
                frow = real[int(rng.integers(len(real)))]
            arow = ai[int(rng.integers(len(ai)))]
            foreign, _ = video_io.read_frames(ROOT / frow["path"], 4.0, max_side=640)
            ai_foreign, _ = video_io.read_frames(ROOT / arow["path"], 4.0, max_side=640)
            condition = "chain" if rng.random() < 0.5 else "equal"
            crf_t = int(rng.integers(18, 31)) if condition == "chain" else int(rng.integers(18, 29))
            crf_o = 14 if condition == "chain" else crf_t
            orig_path = video_io.write_video(frames, fps, d / "original.mp4", crf=crf_o)
            # the tamperer starts from the decoded original file, like a real edit chain
            ofr, _ = video_io.read_frames(orig_path, 10.0, max_side=640)
            res = S.tamper(ofr, fps, rng, foreign=foreign, ai_foreign=ai_foreign)
            tam_path = video_io.write_video(res.frames, fps, d / "tampered.mp4", crf=crf_t)
            ta, tb = T.load_track(orig_path), T.load_track(tam_path)
            # randomise presentation order: label = 1 when B is the tampered one
            swap = bool(rng.random() < 0.5)
            A, B = (tb, ta) if swap else (ta, tb)
            pa = T.analyse_pair(A, B)
            store: dict = {}
            save_track("a_", A, store); save_track("b_", B, store)
            store["ab_matched"] = pa.ab.matched; store["ba_matched"] = pa.ba.matched
            np.savez_compressed(d / "cache.npz", **store)
            rec = {"id": pid, "source": src["source"], "source_path": src["path"], "source_label": src["label"], "ops": res.ops, "condition": condition,
                   "crf_original": crf_o, "crf_tampered": crf_t, "b_is_tampered": int(not swap), "foreign": frow["path"], "ai_foreign": arow["path"],
                   "metrics_a": pa.metrics_a, "metrics_b": pa.metrics_b, "coverage_a_in_b": pa.coverage_a_in_b, "coverage_b_in_a": pa.coverage_b_in_a,
                   "related": pa.related, "identical": pa.identical, "region": {k: v for k, v in pa.region.items() if k != "pairs"}, "speed": pa.speed_ratio}
            with index_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, default=float) + "\n")
            if k >= args.keep_videos:
                (d / "original.mp4").unlink(missing_ok=True); (d / "tampered.mp4").unlink(missing_ok=True)
        except Exception as exc:
            print(f"{pid} FAIL {type(exc).__name__}: {exc}", flush=True)
            shutil.rmtree(d, ignore_errors=True)
            continue
        if k % 10 == 0:
            print(f"[{k}/{len(sources)}] {(time.time() - t0) / 60:.1f} min  ops={[o['op'] for o in res.ops]} cov={pa.coverage_a_in_b:.2f}/{pa.coverage_b_in_a:.2f}", flush=True)
    print("done")


if __name__ == "__main__":
    main()
