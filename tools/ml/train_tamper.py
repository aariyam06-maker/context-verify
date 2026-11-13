"""Train/evaluate the "which video is the original?" direction model (service 2).

Inputs : data/tamper_pairs/index.jsonl + per-pair cache.npz (build_tamper_pairs.py)
         data/models/ai_detector.joblib (AI evidence for inserted segments)
Outputs: data/models/tamper_model.joblib, data/models/tamper_experiments.json

Every pair is used in both presentation orders (A,B) and (B,A); features are
antisymmetric differences so the task is symmetric by construction.
Cross-validation is grouped by the *source clip* so the same footage never
appears in train and test.
"""
from __future__ import annotations

import json
import sys
import warnings
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.base import clone
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.ml import features as F  # noqa: E402
from app.ml import tamper as T  # noqa: E402

PAIRS = ROOT / "data" / "tamper_pairs"
OUT = ROOT / "data" / "models"


def frame_probs(ai, prefix, c):
    ff = F.FrameFeatures(times=list(c[prefix + "times"]), forensic=c[prefix + "forensic"], temporal=c[prefix + "temporal"], clip=c[prefix + "clip"].astype(np.float32))
    fm = F.frame_matrix(ff, tuple(ai["frame_families"]))
    return ai["frame_model"].predict_proba(fm)[:, 1]


def build():
    ai = joblib.load(OUT / "ai_detector.joblib")
    recs = [json.loads(l) for l in (PAIRS / "index.jsonl").open(encoding="utf-8")]
    X, y, groups, meta = [], [], [], []
    for r in recs:
        c = dict(np.load(PAIRS / r["id"] / "cache.npz"))
        fa = frame_probs(ai, "a_", c)
        fb = frame_probs(ai, "b_", c)
        ma, mb = dict(r["metrics_a"]), dict(r["metrics_b"])
        ma["ai_prob"], mb["ai_prob"] = float(fa.mean()), float(fb.mean())
        ua, ub = ~c["ab_matched"], ~c["ba_matched"]
        ma["ai_unmatched"] = float(fa[ua].max()) if ua.any() else 0.0
        mb["ai_unmatched"] = float(fb[ub].max()) if ub.any() else 0.0
        v = np.array([mb[k] - ma[k] for k in T.DIRECTION_FEATURES], np.float32)
        X.append(v); y.append(r["b_is_tampered"]); groups.append(r["source_path"])
        meta.append({"id": r["id"], "ops": [o["op"] for o in r["ops"]], "condition": r["condition"], "related": r["related"], "identical": r["identical"],
                     "region_found": bool(r["region"].get("found")), "speed": r["speed"], "cov": (r["coverage_a_in_b"], r["coverage_b_in_a"]), "source_label": r["source_label"],
                     "ma": ma, "mb": mb})
    return np.stack(X), np.array(y), np.array(groups), meta


def candidates():
    return {
        "antisym_logreg": Pipeline([("sc", StandardScaler(with_mean=False)), ("clf", LogisticRegression(C=1.0, fit_intercept=False, max_iter=4000))]),
        "random_forest": RandomForestClassifier(n_estimators=400, min_samples_leaf=2, n_jobs=4, random_state=0),
        "grad_boost": HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, random_state=0),
        "mlp_nn": Pipeline([("sc", StandardScaler(with_mean=False)), ("clf", MLPClassifier(hidden_layer_sizes=(32, 16), alpha=1e-2, max_iter=2000, random_state=0))]),
    }


def sym(X, y):
    return np.concatenate([X, -X]), np.concatenate([y, 1 - y])


def predict_sym(m, X):
    # enforce antisymmetry for non-linear models: p(B tampered | x) = (p(x) + 1 - p(-x)) / 2
    return 0.5 * (m.predict_proba(X)[:, 1] + 1 - m.predict_proba(-X)[:, 1])


def main():
    X, y, g, meta = build()
    print(f"pairs={len(y)}")
    gkf = GroupKFold(n_splits=5)
    exp = {"created": datetime.now(timezone.utc).isoformat(), "n_pairs": int(len(y)), "features": T.DIRECTION_FEATURES, "comparison": {}}
    best = None
    oofs = {}
    for name, model in candidates().items():
        oof = np.zeros(len(y))
        for tr, te in gkf.split(X, y, g):
            Xt, yt = sym(X[tr], y[tr])
            m = clone(model).fit(Xt, yt)
            oof[te] = predict_sym(m, X[te])
        acc = accuracy_score(y, oof >= 0.5); auc = roc_auc_score(y, oof)
        exp["comparison"][name] = {"accuracy": float(acc), "auc": float(auc)}
        oofs[name] = oof
        print(f"{name:16s} acc={acc:.3f} auc={auc:.3f}")
        if best is None or acc > best[1]:
            best = (name, acc)
    name = best[0]
    oof = oofs[name]
    exp["selected"] = name
    # breakdowns
    by_op, by_cond, by_src = defaultdict(list), defaultdict(list), defaultdict(list)
    for k, mt in enumerate(meta):
        ok = int((oof[k] >= 0.5) == y[k])
        for op in mt["ops"]:
            by_op[op].append(ok)
        by_cond[mt["condition"]].append(ok)
        by_src[mt["source_label"]].append(ok)
    exp["accuracy_by_operation"] = {k: {"accuracy": float(np.mean(v)), "n": len(v)} for k, v in sorted(by_op.items())}
    exp["accuracy_by_condition"] = {k: {"accuracy": float(np.mean(v)), "n": len(v)} for k, v in by_cond.items()}
    exp["accuracy_by_source_label"] = {k: {"accuracy": float(np.mean(v)), "n": len(v)} for k, v in by_src.items()}
    # structural event detection recall (deterministic analysis, no learning)
    ev = defaultdict(list)
    for k, mt in enumerate(meta):
        tam, org = (mt["mb"], mt["ma"]) if y[k] == 1 else (mt["ma"], mt["mb"])
        for op in mt["ops"]:
            if op in ("insert_foreign", "insert_ai", "replace_segment"):
                ev[op].append(int(tam["foreign_s"] > 0.3 or tam["unexpl_cuts"] > 0))
            elif op in ("cut_middle", "trim_ends"):
                ev[op].append(int(org["unmatched_frac"] > 0.05 or tam["jumps"] > 0 or tam["unexpl_cuts"] > 0))
            elif op == "reorder":
                ev[op].append(int(tam["disorder"] > 0.05 or tam["jumps"] > 0 or tam["unexpl_cuts"] > 0))
            elif op in ("object_removal", "copy_move", "caption_overlay"):
                ev[op].append(int(mt["region_found"]))
            elif op == "speed_change":
                ev[op].append(int(abs(np.log(max(mt["speed"], 1e-3))) > 0.15))
    exp["event_detection_recall"] = {k: {"recall": float(np.mean(v)), "n": len(v)} for k, v in sorted(ev.items())}
    exp["relatedness_recall"] = float(np.mean([mt["related"] for mt in meta]))
    final = clone(candidates()[name]).fit(*sym(X, y))
    if name == "antisym_logreg":
        coef = final.named_steps["clf"].coef_[0] / final.named_steps["sc"].scale_
        exp["weights"] = {f: float(c) for f, c in zip(T.DIRECTION_FEATURES, coef)}
    exp["oof"] = [{"id": mt["id"], "ops": mt["ops"], "condition": mt["condition"], "p_b_tampered": float(oof[k]), "label": int(y[k])} for k, mt in enumerate(meta)]
    version = "ctx-tamper-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    joblib.dump({"version": version, "model": final, "name": name, "features": T.DIRECTION_FEATURES, "cv_accuracy": float(best[1]), "cv_auc": exp["comparison"][name]["auc"]}, OUT / "tamper_model.joblib", compress=3)
    exp["version"] = version
    (OUT / "tamper_experiments.json").write_text(json.dumps(exp, indent=1), encoding="utf-8")
    print(json.dumps({k: exp[k] for k in ("selected", "accuracy_by_operation", "accuracy_by_condition", "event_detection_recall")}, indent=1))


if __name__ == "__main__":
    main()
