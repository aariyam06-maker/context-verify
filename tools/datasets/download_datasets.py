"""Download the ContextTrace training/evaluation corpus from free, public Hugging Face datasets.

Twelve sources are used (6 real-camera, 6 AI-generated). Every file is listed in
data/datasets/manifest.csv with its source, label, generator and origin URL so
the corpus is fully reproducible.

Usage:  python tools/datasets/download_datasets.py [--scale 1.0]
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "datasets" / "raw"
MANIFEST = ROOT / "data" / "datasets" / "manifest.csv"
API = "https://huggingface.co/api/datasets/{repo}/tree/main/{path}"
RESOLVE = "https://huggingface.co/datasets/{repo}/resolve/main/{path}"
VIDEO_EXT = (".mp4", ".avi", ".mov", ".webm", ".mkv")

# name, repo, folders, label, generator rule, max files, max bytes per file
SOURCES = [
    # ---------------- real camera footage ----------------
    dict(name="ucf101", repo="bitmind/UCF101-Videos", folders=[""], include=r"^test\\", label="real", generator="camera", n=60, max_bytes=4_000_000,
         note="UCF101 action recognition (Soomro et al., 2012) - YouTube user videos"),
    dict(name="hmdb51", repo="divm/hmdb51", folders=["test"], label="real", generator="camera", n=60, max_bytes=4_000_000,
         note="HMDB51 (Kuehne et al., 2011) - movie & web clips of human actions"),
    dict(name="davis2017", repo="emirkisa/DAVIS-2017-480p-mp4", folders=[""], label="real", generator="camera", n=60, max_bytes=8_000_000, include=r"_raw_",
         note="DAVIS-2017 (Pont-Tuset et al., 2017) - high quality camera sequences"),
    dict(name="pexels", repo="minh132/pexels-videos", folders=[""], label="real", generator="camera", n=100, max_bytes=9_000_000,
         note="Pexels stock footage (free licence) - HD/4K professional camera clips"),
    dict(name="celebvhq", repo="saeed-5959/celebv_hq_head_talking", folders=["head_talk", "head_talk_2"], label="real", generator="camera", n=110, max_bytes=4_000_000,
         note="CelebV-HQ (Zhu et al., 2022) - real talking-head YouTube clips"),
    dict(name="kinetics", repo="nateraw/kinetics-mini", folders=["train", "val"], recursive=True, label="real", generator="camera", n=50, max_bytes=4_000_000,
         note="Kinetics-400 mini (Kay et al., 2017) - YouTube action clips"),
    # ---------------- AI generated ----------------
    dict(name="rapidata_t2v", repo="Rapidata/text-2-video-human-preferences-veo3", folders=["videos"], label="ai", generator="from_filename", n=270, per_generator=30, max_bytes=8_000_000,
         note="Rapidata T2V preference set - Sora, Veo2, Veo3, Wan2.1, Hunyuan, Pika 1.x, Pika 2.2, Luma Ray2, Runway Alpha"),
    dict(name="liveportrait", repo="luchaoqi/TalkingHeadBench", folders=["fake/LivePortrait/test", "fake/LivePortrait/train"], label="ai", generator="liveportrait", n=50, max_bytes=4_000_000,
         note="TalkingHeadBench - LivePortrait face reenactment deepfakes"),
    dict(name="hallo", repo="luchaoqi/TalkingHeadBench", folders=["fake/Hallo/test", "fake/Hallo2/test", "fake/Hallo/train", "fake/Hallo2/train"], label="ai", generator="from_filename_suffix", n=60, max_bytes=4_000_000,
         note="TalkingHeadBench - Hallo / Hallo2 audio-driven portrait animation"),
    dict(name="aniportrait", repo="luchaoqi/TalkingHeadBench", folders=["fake/AniPortraitVideo/test"], label="ai", generator="aniportrait", n=30, max_bytes=4_000_000,
         note="TalkingHeadBench - AniPortrait video-driven animation"),
    dict(name="emoportrait", repo="luchaoqi/TalkingHeadBench", folders=["fake/EmoPortrait/test", "fake/EmoPortrait/train"], label="ai", generator="emoportrait", n=45, max_bytes=4_000_000,
         note="TalkingHeadBench - EmoPortrait one-shot head avatars"),
    dict(name="aniportrait_audio", repo="luchaoqi/TalkingHeadBench", folders=["fake/AniPortraitAudio/test", "fake/AniPortraitAudio/train"], label="ai", generator="aniportrait-audio", n=40, max_bytes=4_000_000,
         note="TalkingHeadBench - AniPortrait audio-driven animation"),
]


def _get_json(url: str):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.loads(r.read().decode())
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return []


def list_files(repo: str, folder: str, recursive: bool = False) -> list[dict]:
    url = API.format(repo=repo, path=urllib.parse.quote(folder)) + ("?recursive=true" if recursive else "")
    items = _get_json(url)
    return [x for x in items if x.get("type") == "file" and x["path"].lower().endswith(VIDEO_EXT)]


def generator_of(src: dict, path: str) -> str:
    base = path.split("/")[-1]
    if src["generator"] == "from_filename":
        g = re.sub(r"^\d+_", "", base).split("_")[0]
        return {"alpha": "runway-alpha", "ray2": "luma-ray2", "pika": "pika-1.x"}.get(g, g)
    if src["generator"] == "from_filename_suffix":
        return base.rsplit("--", 1)[-1].rsplit(".", 1)[0].lower()
    return src["generator"]


def choose(src: dict, files: list[dict], rng: random.Random, scale: float) -> list[dict]:
    files = [f for f in files if f.get("size", 0) <= src["max_bytes"] and f.get("size", 0) > 20_000]
    if src.get("include"):
        files = [f for f in files if re.search(src["include"], f["path"])]
    rng.shuffle(files)
    n = max(4, int(src["n"] * scale))
    if src.get("per_generator"):
        per = max(2, int(src["per_generator"] * scale))
        buckets: dict[str, list] = {}
        for f in files:
            buckets.setdefault(generator_of(src, f["path"]), []).append(f)
        return [f for b in buckets.values() for f in b[:per]]
    # spread across sub-classes (action category) where the path encodes one
    buckets = {}
    for f in files:
        p = f["path"].replace("\\", "/")
        key = p.split("/")[-2] if p.count("/") >= 2 else re.split(r"[_\-]", p.split("/")[-1])[0]
        buckets.setdefault(key, []).append(f)
    out, i = [], 0
    keys = list(buckets)
    while len(out) < n and any(buckets.values()):
        k = keys[i % len(keys)]
        if buckets[k]:
            out.append(buckets[k].pop())
        i += 1
    return out


def download(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "contexttrace-dataset-fetch/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r, tmp.open("wb") as out:
                while chunk := r.read(1 << 20):
                    out.write(chunk)
            tmp.replace(dest)
            return True
        except Exception:
            time.sleep(2 * (attempt + 1))
    tmp.unlink(missing_ok=True)
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=float, default=1.0, help="multiply per-source counts")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    rng = random.Random(1337)
    jobs = []
    for src in SOURCES:
        files = []
        for folder in src["folders"]:
            files += list_files(src["repo"], folder, src.get("recursive", False))
        chosen = choose(src, files, rng, args.scale)
        print(f"[{src['name']}] listed {len(files)} -> selected {len(chosen)}", flush=True)
        for f in chosen:
            safe = re.sub(r"[^A-Za-z0-9_.\-]", "_", f["path"].replace("\\", "/").split("/")[-1])
            dest = RAW / src["name"] / safe
            url = RESOLVE.format(repo=src["repo"], path=urllib.parse.quote(f["path"]))
            jobs.append((src, f, dest, url))

    rows = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(download, url, dest): (src, f, dest, url) for src, f, dest, url in jobs}
        for fut in as_completed(futures):
            src, f, dest, url = futures[fut]
            done += 1
            if fut.result():
                rows.append({"path": str(dest.relative_to(ROOT)).replace("\\", "/"), "source": src["name"], "label": src["label"],
                             "generator": generator_of(src, f["path"]), "repo": src["repo"], "url": url, "bytes": f.get("size", 0), "note": src["note"]})
            if done % 25 == 0:
                print(f"  downloaded {done}/{len(jobs)}", flush=True)
    rows.sort(key=lambda r: (r["source"], r["path"]))
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with MANIFEST.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(f"manifest: {MANIFEST} ({len(rows)} videos)")


if __name__ == "__main__":
    sys.exit(main())
