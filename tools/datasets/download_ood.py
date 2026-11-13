"""Download the out-of-distribution (OOD) held-out test corpus.

None of these sources or generators appear in training data:
  AI   : Google Veo 3.1, Sand-AI MAGI-1, Hallo3, misc. community AI animations
  Real : smartphone selfie videos (ud-biometrics), crowd-sourced street videos (HumynLabs);
         Wikimedia Commons footage optionally (--commons; Commons rate-limits bulk downloads)

Usage: python tools/datasets/download_ood.py
"""
from __future__ import annotations

import csv
import json
import random
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from download_datasets import RESOLVE, download, list_files  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "datasets" / "ood"
MANIFEST = ROOT / "data" / "datasets" / "ood_manifest.csv"
UA = {"User-Agent": "ContextTrace-research-dataset-fetch/1.0 (academic evaluation)"}

HF = [
    dict(name="veo3.1", repo="Rapidata/text-2-video-human-preferences-veo3.1", folders=["videos"], label="ai", generator="veo-3.1", n=15, max_bytes=6_000_000),
    dict(name="magi1", repo="luchaoqi/TalkingHeadBench", folders=["fake/additional_dataset/MAGI-1"], label="ai", generator="magi-1", n=10, max_bytes=6_000_000, recursive=True),
    dict(name="hallo3", repo="luchaoqi/TalkingHeadBench", folders=["fake/additional_dataset/Hallo3"], label="ai", generator="hallo3", n=8, max_bytes=6_000_000, recursive=True),
    dict(name="community_ai", repo="coolyfrank/ai-generated-videos", folders=[""], label="ai", generator="community-ai", n=3, max_bytes=6_000_000),
    dict(name="street", repo="HumynLabs/Street-videos", folders=[""], label="real", generator="camera", n=14, max_bytes=9_000_000, recursive=True),
    dict(name="phone_selfie", repo="ud-biometrics/Anti-Spoofing-Real-Videos", folders=["files"], label="real", generator="camera", n=10, max_bytes=30_000_000, recursive=True),
]
COMMONS_CATEGORIES = ["Videos_of_dogs", "Videos_of_cats", "Videos_of_birds", "Videos_of_road_traffic", "Videos_of_waterfalls", "Videos_of_people_walking", "Videos_of_trains", "Videos_of_horses"]


def commons(n_total: int = 14, max_bytes: int = 9_000_000) -> list[tuple[str, str]]:
    out = []
    for cat in COMMONS_CATEGORIES:
        q = ("https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers&gcmtitle=Category:" + cat +
             "&gcmtype=file&gcmlimit=40&prop=videoinfo&viprop=url|size|mediatype&format=json")
        try:
            with urllib.request.urlopen(urllib.request.Request(q, headers=UA), timeout=60) as r:
                pages = json.loads(r.read().decode()).get("query", {}).get("pages", {}).values()
        except Exception:
            continue
        picks = [p["videoinfo"][0] for p in pages if p.get("videoinfo") and 200_000 < p["videoinfo"][0].get("size", 0) <= max_bytes
                 and p["videoinfo"][0].get("mediatype") == "VIDEO"]
        random.Random(cat).shuffle(picks)
        for v in picks[:2]:
            out.append((cat, v["url"]))
    return out[:n_total]


def main() -> None:
    rng = random.Random(2026)
    rows, jobs = [], []
    for src in HF:
        files = []
        for folder in src["folders"]:
            files += list_files(src["repo"], folder, src.get("recursive", False))
        files = [f for f in files if 20_000 < f.get("size", 0) <= src["max_bytes"]]
        rng.shuffle(files)
        for f in files[: src["n"]]:
            safe = re.sub(r"[^A-Za-z0-9_.\-]", "_", f["path"].replace("/", "_"))[-90:]
            jobs.append((src["name"], src["label"], src["generator"], RESOLVE.format(repo=src["repo"], path=urllib.parse.quote(f["path"])), OUT / src["name"] / safe))
        print(f"[{src['name']}] {min(len(files), src['n'])} files", flush=True)
    for cat, url in (commons() if "--commons" in sys.argv else []):
        # strip the ?utm_... query string - otherwise every Commons file gets the same name
        name = re.sub(r"[^A-Za-z0-9_.\-]", "_", urllib.parse.unquote(urllib.parse.urlparse(url).path.split("/")[-1]))[-80:]
        jobs.append(("wikimedia", "real", "camera", url, OUT / "wikimedia" / name))
    print(f"[wikimedia] {sum(1 for j in jobs if j[0] == 'wikimedia')} files", flush=True)

    def fetch(j):
        name, label, gen, url, dest = j
        ok = download(url, dest)
        return j, ok

    with ThreadPoolExecutor(6) as pool:
        for (name, label, gen, url, dest), ok in pool.map(fetch, jobs):
            if ok:
                rows.append({"path": str(dest.relative_to(ROOT)).replace("\\", "/"), "source": name, "label": label, "generator": gen, "url": url})
    rows.sort(key=lambda r: (r["source"], r["path"]))
    with MANIFEST.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print(f"OOD manifest: {MANIFEST} ({len(rows)} videos)")


if __name__ == "__main__":
    main()
