"""Extract and cache per-frame features for the training and OOD corpora.

For each video two "views" are cached:
  clean    - frames as decoded
  degraded - every frame re-sized to a random short side (240-720 px) and JPEG
             re-compressed at random quality 45-91 (seeded per video). This
             mimics social-media re-processing and is applied to real and AI
             videos alike so the classifier cannot use resolution/compression
             as a shortcut.

Output: data/features/<split>/<source>/<file>.npz  (resumable)
Usage : python tools/ml/extract_features.py [--k 8] [--split train|ood|all]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import sys
import time
import warnings
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.ml import features as F  # noqa: E402
from app.ml import video_io  # noqa: E402

FEAT = ROOT / "data" / "features"
CLIP_ARCH = "ViT-B-32-quickgelu/openai"


def seed_of(path: str) -> int:
    return int(hashlib.md5(path.encode()).hexdigest()[:8], 16)


def process(row: dict, split: str, k: int) -> str:
    src = ROOT / row["path"]
    dest = FEAT / split / row["source"] / (Path(row["path"]).name + ".npz")
    if dest.exists():
        old = dict(np.load(dest))
        if str(old.get("clip_arch", "")) == CLIP_ARCH:
            return "cached"
        # cached before the QuickGELU fix: recompute only the CLIP arrays (same frames, same seeded augmentation)
        frames, nexts, times, fps = video_io.read_sampled(src, k=k)
        rng = np.random.default_rng(seed_of(row["path"]))
        spec = {"side": int(old["aug"][0]), "quality": int(old["aug"][1])}
        old["clip"] = clip16(F.clip_embed(frames))
        old["d_clip"] = clip16(F.clip_embed([F.degrade(f, rng, spec) for f in frames]))
        old["clip_arch"] = np.asarray(CLIP_ARCH)
        np.savez_compressed(dest, **old)
        return "clip-refreshed"
    dest.parent.mkdir(parents=True, exist_ok=True)
    frames, nexts, times, fps = video_io.read_sampled(src, k=k)
    meta = video_io.probe(src)
    rng = np.random.default_rng(seed_of(row["path"]))
    spec = {"side": int(rng.choice([240, 360, 480, 720])), "quality": int(rng.integers(45, 92))}
    clean = F.features_from_pairs(frames, nexts, times, use_clip=True, use_dino=True)
    deg = F.features_from_pairs(frames, nexts, times, use_clip=True, use_dino=True, augment=spec, rng=rng)
    np.savez_compressed(
        dest,
        times=np.asarray(times, np.float32),
        forensic=clean.forensic, temporal=clean.temporal, clip=clip16(clean.clip), dino=clip16(clean.dino),
        d_forensic=deg.forensic, d_temporal=deg.temporal, d_clip=clip16(deg.clip), d_dino=clip16(deg.dino),
        label=np.int8(1 if row["label"] == "ai" else 0),
        meta=np.asarray([meta["width"], meta["height"], meta["fps"], meta["duration"]], np.float32),
        aug=np.asarray([spec["side"], spec["quality"]], np.int16),
        clip_arch=np.asarray(CLIP_ARCH),
    )
    return "ok"


def clip16(x):
    return None if x is None else x.astype(np.float16)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--split", default="all", choices=["train", "ood", "all"])
    args = ap.parse_args()
    todo = []
    if args.split in ("train", "all"):
        todo += [("train", r) for r in csv.DictReader(open(ROOT / "data/datasets/manifest.csv", encoding="utf-8"))]
    if args.split in ("ood", "all"):
        todo += [("ood", r) for r in csv.DictReader(open(ROOT / "data/datasets/ood_manifest.csv", encoding="utf-8"))]
    t0 = time.time(); fails = 0
    for i, (split, row) in enumerate(todo, 1):
        try:
            status = process(row, split, args.k)
        except Exception as exc:  # corrupt / undecodable file: skip but log
            fails += 1
            status = f"FAIL {type(exc).__name__}: {exc}"
        if i % 10 == 0 or status.startswith("FAIL"):
            el = time.time() - t0
            print(f"[{i}/{len(todo)}] {el/60:.1f} min  {row['source']}/{Path(row['path']).name}: {status}", flush=True)
    print(f"done. failures={fails}")


if __name__ == "__main__":
    main()
