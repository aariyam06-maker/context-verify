"""End-to-end acceptance tests on random, never-seen, free-source clips (<=10 s).

Everything goes through the real HTTP API (FastAPI TestClient in-process):
demo login -> upload -> create job -> poll -> read report. Nothing is mocked.

Scenario 1 - AI detection   : 5 AI-generated + 5 real clips drawn at random from
                              the OOD pool (generators/sources never used in training).
Scenario 2 - tamper check   : 5 original/tampered pairs. Originals are random OOD
                              real clips; each gets a different tampering operation
                              (AI splice from an unseen generator, cut, object
                              removal, fake caption + trim, re-order). Upload order
                              is randomised so the system cannot rely on position.
Extra controls              : 1 identical pair (no tampering) and 1 unrelated pair.

Clips are saved to data/acceptance/ so they can be re-tried in the web UI.
Results  -> data/models/acceptance_tests.json
Usage    :  python tools/ml/acceptance_tests.py [--seed N]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(ROOT / 'data' / 'contexttrace.db').as_posix()}")
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.ml import tamper_synth as S  # noqa: E402
from app.ml import video_io  # noqa: E402

OUT = ROOT / "data" / "acceptance"


def login(client):
    r = client.post("/api/auth/login", json={"email": "demo@contexttrace.app", "password": "DemoTrace@2026"})
    r.raise_for_status()
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def upload(client, h, path: Path, kind: str) -> str:
    with path.open("rb") as fh:
        r = client.post("/api/videos/upload", headers=h, files={"file": (path.name, fh, "video/mp4")}, data={"type": kind})
    r.raise_for_status()
    return r.json()["videoId"]


def wait(client, h, job_id: str, timeout: int = 600) -> dict:
    t = time.time()
    while time.time() - t < timeout:
        j = client.get(f"/api/jobs/{job_id}", headers=h).json()
        if j["status"] in ("COMPLETED", "FAILED"):
            break
        time.sleep(1.0)
    if j["status"] != "COMPLETED":
        raise RuntimeError(f"job {job_id} {j['status']}: {j.get('errorMessage')}")
    return client.get(f"/api/jobs/{job_id}/report", headers=h).json()["result"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=int(time.time()) % 100000)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    nrng = np.random.default_rng(a.seed)
    OUT.mkdir(parents=True, exist_ok=True)
    rows = list(csv.DictReader(open(ROOT / "data/datasets/ood_manifest.csv", encoding="utf-8")))
    ai_pool = [r for r in rows if r["label"] == "ai"]
    real_pool = [r for r in rows if r["label"] == "real"]
    rng.shuffle(ai_pool); rng.shuffle(real_pool)
    cases = []
    client = TestClient(app)
    h = login(client)

    # ---------------- scenario 1 ----------------
    s1 = [(r, "ai") for r in ai_pool[:5]] + [(r, "real") for r in real_pool[:5]]
    rng.shuffle(s1)
    for r, truth in s1:
        src = ROOT / r["path"]
        clip = video_io.trim_copy(src, OUT / f"s1_{truth}_{r['source']}_{Path(r['path']).stem[:40]}.mp4", seconds=10.0)
        t0 = time.time()
        vid = upload(client, h, clip, "detect")
        job = client.post(f"/api/jobs/detect?videoId={vid}", headers=h).json()["jobId"]
        res = wait(client, h, job)
        pred = "ai" if res["verdict"] == "ai_generated" else "real"
        cases.append({"scenario": "1 - AI detection", "files": f"{clip.name}  [{r['source']} / {r['generator']}]", "truth": truth, "prediction": pred,
                      "score": f"AI {res['aiProbability']:.1f}% · share {res['aiContentShare']:.0f}%", "correct": pred == truth, "seconds": round(time.time() - t0, 1), "job": job})
        print(f"S1 {truth:4s} -> {pred:4s} ({res['aiProbability']:.1f}%)  {clip.name}", flush=True)

    # ---------------- scenario 2 ----------------
    ops = [["insert_ai"], ["cut_middle"], ["object_removal"], ["caption_overlay", "trim_ends"], ["reorder"]]
    originals = real_pool[5:10] if len(real_pool) >= 10 else real_pool[:5]
    for k, (r, op) in enumerate(zip(originals, ops)):
        frames, fps = video_io.read_frames(ROOT / r["path"], 10.0, max_side=960)
        orig = video_io.write_video(frames, fps, OUT / f"s2_pair{k + 1}_original.mp4", crf=16)
        ofr, _ = video_io.read_frames(orig, 10.0, max_side=960)
        ai_src = ai_pool[(5 + k) % len(ai_pool)]
        ai_frames, _ = video_io.read_frames(ROOT / ai_src["path"], 4.0, max_side=960)
        foreign, _ = video_io.read_frames(ROOT / real_pool[(k + 11) % len(real_pool)]["path"], 4.0, max_side=960)
        res_t = S.tamper(ofr, fps, nrng, ops=op, foreign=foreign, ai_foreign=ai_frames)
        tam = video_io.write_video(res_t.frames, fps, OUT / f"s2_pair{k + 1}_tampered.mp4", crf=int(nrng.integers(18, 27)))
        swap = rng.random() < 0.5
        first, second = (tam, orig) if swap else (orig, tam)
        truth_tampered = "a" if swap else "b"
        t0 = time.time()
        va, vb = upload(client, h, first, "a"), upload(client, h, second, "b")
        job = client.post(f"/api/jobs/tamper?videoAId={va}&videoBId={vb}", headers=h).json()["jobId"]
        res = wait(client, h, job)
        pred = res.get("tampered") or res["verdict"]
        cases.append({"scenario": "2 - tamper check", "files": f"A={first.name}  B={second.name}  ops={'+'.join(op)}", "truth": f"{truth_tampered.upper()} tampered",
                      "prediction": f"{pred.upper()} tampered" if pred in ("a", "b") else pred, "score": f"conf {res['confidence']:.2f} · {len(res.get('events', []))} events: " +
                      ", ".join(sorted({e['title'] for e in res.get('events', [])})), "correct": pred == truth_tampered, "seconds": round(time.time() - t0, 1), "job": job,
                      "ops_detail": res_t.ops})
        print(f"S2 pair{k + 1} {op} truth={truth_tampered} pred={pred} conf={res['confidence']:.2f}", flush=True)

    # ---------------- controls ----------------
    ctrl = OUT / "s2_pair1_original.mp4"
    t0 = time.time()
    va, vb = upload(client, h, ctrl, "a"), upload(client, h, ctrl, "b")
    res = wait(client, h, client.post(f"/api/jobs/tamper?videoAId={va}&videoBId={vb}", headers=h).json()["jobId"])
    cases.append({"scenario": "control - identical pair", "files": f"{ctrl.name} x2", "truth": "no_tampering", "prediction": res["verdict"], "score": f"conf {res['confidence']:.2f}",
                  "correct": res["verdict"] == "no_tampering", "seconds": round(time.time() - t0, 1)})
    print(f"CTRL identical -> {res['verdict']}", flush=True)
    t0 = time.time()
    va, vb = upload(client, h, OUT / "s2_pair2_original.mp4", "a"), upload(client, h, OUT / "s2_pair3_original.mp4", "b")
    res = wait(client, h, client.post(f"/api/jobs/tamper?videoAId={va}&videoBId={vb}", headers=h).json()["jobId"])
    cases.append({"scenario": "control - unrelated pair", "files": "s2_pair2_original.mp4 vs s2_pair3_original.mp4", "truth": "unrelated", "prediction": res["verdict"],
                  "score": f"coverage {res['coverage']['aInB']}% / {res['coverage']['bInA']}%", "correct": res["verdict"] == "unrelated", "seconds": round(time.time() - t0, 1)})
    print(f"CTRL unrelated -> {res['verdict']}", flush=True)

    d = [c for c in cases if c["scenario"].startswith("1")]
    t = [c for c in cases if c["scenario"].startswith("2")]
    c = [c for c in cases if c["scenario"].startswith("control")]
    summary = {"seed": a.seed, "detect_total": len(d), "detect_correct": sum(x["correct"] for x in d), "detect_accuracy": sum(x["correct"] for x in d) / max(1, len(d)),
               "detect_ai_recall": sum(x["correct"] for x in d if x["truth"] == "ai") / max(1, sum(x["truth"] == "ai" for x in d)),
               "detect_real_specificity": sum(x["correct"] for x in d if x["truth"] == "real") / max(1, sum(x["truth"] == "real" for x in d)),
               "tamper_total": len(t), "tamper_correct": sum(x["correct"] for x in t), "tamper_accuracy": sum(x["correct"] for x in t) / max(1, len(t)),
               "controls_correct": sum(x["correct"] for x in c), "controls_total": len(c),
               "mean_seconds_detect": float(np.mean([x["seconds"] for x in d])), "mean_seconds_tamper": float(np.mean([x["seconds"] for x in t]))}
    out = {"created": datetime.now(timezone.utc).isoformat(), "summary": summary, "cases": cases}
    hist = ROOT / "data" / "models" / "acceptance_history.jsonl"
    with hist.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"created": out["created"], **summary}) + "\n")
    (ROOT / "data" / "models" / "acceptance_tests.json").write_text(json.dumps(out, indent=1, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
