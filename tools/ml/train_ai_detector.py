"""Train, compare and evaluate the single-video AI-generation detector.

Experimental protocol (all numbers are written to data/models/experiments.json):

  E1  Model x feature-set comparison - 5-fold StratifiedGroupKFold (group = video,
      so a video's clean and degraded views never straddle train/test).
  E2  Leave-one-source-out (LOSO) - each training source is held out entirely.
  E3  Leave-one-generator-out (LOGO) - each AI generator is held out entirely.
  E4  Robustness - accuracy on clean vs. degraded (re-compressed) views.
  E5  Out-of-distribution test - 60 videos from 6 sources/generators never used
      in training or model selection (Veo 3.1, MAGI-1, Hallo3, community AI,
      smartphone selfies, Wikimedia Commons). Evaluated once with the final model.
  E6  Learning curve, calibration curve, feature-family ablation.

Model selection uses E1 + E2 only (never the OOD set).
Usage: python tools/ml/train_ai_detector.py
"""
from __future__ import annotations

import json
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.base import clone
from sklearn.calibration import calibration_curve
from sklearn.decomposition import PCA
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, balanced_accuracy_score, brier_score_loss, confusion_matrix, f1_score, precision_score, recall_score, roc_auc_score, roc_curve
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.ml import features as F  # noqa: E402

FEAT = ROOT / "data" / "features"
OUTDIR = ROOT / "data" / "models"
SEED = 42

FAMILY_SETS = {
    "forensic+temporal": ("forensic", "temporal"),
    "clip": ("clip",),
    "dinov2": ("dino",),
    "clip+forensic+temporal": ("clip", "forensic", "temporal"),
    "clip+dinov2+forensic+temporal": ("clip", "dino", "forensic", "temporal"),
}


def models() -> dict:
    return {
        "logreg": Pipeline([("sc", StandardScaler()), ("clf", LogisticRegression(C=0.05, max_iter=4000, class_weight="balanced"))]),
        "svm_rbf": Pipeline([("sc", StandardScaler()), ("clf", SVC(C=2.0, gamma="scale", probability=True, class_weight="balanced", random_state=SEED))]),
        "random_forest": RandomForestClassifier(n_estimators=400, min_samples_leaf=2, class_weight="balanced_subsample", n_jobs=4, random_state=SEED),
        "grad_boost": Pipeline([("pca", PCA(n_components=64, random_state=SEED)), ("clf", HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, random_state=SEED))]),
        "mlp_nn": Pipeline([("sc", StandardScaler()), ("clf", MLPClassifier(hidden_layer_sizes=(256, 64), alpha=1e-2, max_iter=600, early_stopping=True, random_state=SEED))]),
    }


class View:
    def __init__(self, d: dict, prefix: str):
        self.ff = F.FrameFeatures(times=list(d["times"]), forensic=d[prefix + "forensic"].astype(np.float32), temporal=d[prefix + "temporal"].astype(np.float32),
                                  clip=d[prefix + "clip"].astype(np.float32), dino=d[prefix + "dino"].astype(np.float32))


def load(split: str):
    recs = []
    for p in sorted((FEAT / split).rglob("*.npz")):
        d = dict(np.load(p))
        recs.append({"source": p.parent.name, "name": p.name[:-4], "label": int(d["label"]), "clean": View(d, ""), "degraded": View(d, "d_"), "meta": d["meta"]})
    return recs


def generator_map() -> dict:
    import csv

    m = {}
    for f in ("manifest.csv", "ood_manifest.csv"):
        for r in csv.DictReader(open(ROOT / "data/datasets" / f, encoding="utf-8")):
            m[(r["source"], Path(r["path"]).name)] = r["generator"]
    return m


def matrix(recs, fams, views=("clean", "degraded")):
    X, y, g, v = [], [], [], []
    for i, r in enumerate(recs):
        for view in views:
            X.append(F.video_vector(r[view].ff, fams)); y.append(r["label"]); g.append(i); v.append(view)
    return np.stack(X), np.array(y), np.array(g), np.array(v)


def metrics(y, p, thr=0.5) -> dict:
    pred = (p >= thr).astype(int)
    out = {"n": int(len(y)), "accuracy": float(accuracy_score(y, pred)), "balanced_accuracy": float(balanced_accuracy_score(y, pred)) if len(set(y)) > 1 else float(accuracy_score(y, pred)),
           "precision": float(precision_score(y, pred, zero_division=0)), "recall": float(recall_score(y, pred, zero_division=0)), "f1": float(f1_score(y, pred, zero_division=0)),
           "brier": float(brier_score_loss(y, p)), "confusion": confusion_matrix(y, pred, labels=[0, 1]).tolist()}
    if len(set(y)) > 1:
        out["auc"] = float(roc_auc_score(y, p))
    return out


def cv_oof(model, X, y, g, n_splits=5):
    oof = np.zeros(len(y))
    for tr, te in StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=SEED).split(X, y, g):
        m = clone(model).fit(X[tr], y[tr])
        oof[te] = m.predict_proba(X[te])[:, 1]
    return oof


def platt(oof, y):
    lr = LogisticRegression(C=100.0).fit(np.log(np.clip(oof, 1e-4, 1 - 1e-4) / (1 - np.clip(oof, 1e-4, 1 - 1e-4))).reshape(-1, 1), y)
    return float(lr.coef_[0, 0]), float(lr.intercept_[0])


def apply_platt(p, ab):
    z = np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
    return 1 / (1 + np.exp(-(ab[0] * z + ab[1])))


def ece(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1); e = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if m.any():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(e)


def main() -> None:
    t_start = time.time()
    train = load("train"); ood = load("ood")
    gens = generator_map()
    for r in train + ood:
        r["generator"] = gens.get((r["source"], r["name"]), "camera" if r["label"] == 0 else r["source"])
    print(f"train videos={len(train)} ood videos={len(ood)}")
    exp: dict = {"created": datetime.now(timezone.utc).isoformat(), "n_train_videos": len(train), "n_ood_videos": len(ood), "views_per_video": 2,
                 "sources": {}, "comparison": [], "loso": {}, "logo": {}, "ood": {}, "robustness": {}}
    for r in train:
        s = exp["sources"].setdefault(r["source"], {"label": "ai" if r["label"] else "real", "n": 0, "generators": set()})
        s["n"] += 1; s["generators"].add(r["generator"])
    for s in exp["sources"].values():
        s["generators"] = sorted(s["generators"])

    # ---------------- E1: model x feature comparison ----------------
    best = None
    for fname, fams in FAMILY_SETS.items():
        X, y, g, v = matrix(train, fams)
        for mname, model in models().items():
            t0 = time.time()
            oof = cv_oof(model, X, y, g)
            m_all = metrics(y, oof); m_clean = metrics(y[v == "clean"], oof[v == "clean"]); m_deg = metrics(y[v == "degraded"], oof[v == "degraded"])
            row = {"features": fname, "model": mname, "dims": int(X.shape[1]), "cv": m_all, "cv_clean": m_clean, "cv_degraded": m_deg, "seconds": round(time.time() - t0, 1)}
            exp["comparison"].append(row)
            print(f"E1 {fname:32s} {mname:14s} acc={m_all['accuracy']:.3f} auc={m_all.get('auc', 0):.3f} (clean {m_clean['accuracy']:.3f} / degraded {m_deg['accuracy']:.3f}) {row['seconds']}s", flush=True)

    # shortlist top-4 by CV AUC for the (expensive) LOSO generalisation test
    ranked = sorted(exp["comparison"], key=lambda r: -r["cv"].get("auc", 0))
    shortlist = []
    for r in ranked:
        key = (r["features"], r["model"])
        if key not in shortlist:
            shortlist.append(key)
        if len(shortlist) == 4:
            break
    sources = sorted({r["source"] for r in train})
    for fname, mname in shortlist:
        fams = FAMILY_SETS[fname]
        X, y, g, v = matrix(train, fams)
        src = np.array([train[i]["source"] for i in g])
        res = {}
        for s in sources:
            te = src == s
            m = clone(models()[mname]).fit(X[~te], y[~te])
            p = m.predict_proba(X[te])[:, 1]
            res[s] = {"label": "ai" if y[te][0] else "real", "accuracy": float(accuracy_score(y[te], (p >= 0.5).astype(int))), "mean_prob_ai": float(p.mean()), "n": int(te.sum())}
        bal = float(np.mean([res[s]["accuracy"] for s in sources]))
        exp["loso"][f"{fname}|{mname}"] = {"per_source": res, "mean_accuracy": bal}
        print(f"E2 LOSO {fname} {mname}: mean held-out-source accuracy {bal:.3f}", flush=True)
        if best is None or bal > best[2]:
            best = (fname, mname, bal)

    fname, mname, _ = best
    fams = FAMILY_SETS[fname]
    exp["selected"] = {"features": fname, "model": mname, "families": list(fams), "selection_rule": "highest mean leave-one-source-out accuracy among top-4 CV-AUC candidates"}
    print(f"SELECTED: {fname} + {mname}")

    # ---------------- E3: LOGO ----------------
    X, y, g, v = matrix(train, fams)
    gen = np.array([train[i]["generator"] for i in g])
    for gname in sorted(set(gen[y == 1])):
        te = gen == gname
        m = clone(models()[mname]).fit(X[~te], y[~te])
        p = m.predict_proba(X[te])[:, 1]
        exp["logo"][gname] = {"recall": float((p >= 0.5).mean()), "mean_prob_ai": float(p.mean()), "n": int(te.sum())}
        print(f"E3 LOGO {gname:14s} recall={exp['logo'][gname]['recall']:.3f}", flush=True)

    # ---------------- calibration (on out-of-fold predictions) ----------------
    oof = cv_oof(models()[mname], X, y, g)
    ab = platt(oof, y)
    cal = apply_platt(oof, ab)
    exp["calibration"] = {"method": "platt", "a": ab[0], "b": ab[1], "ece_raw": ece(y, oof), "ece_calibrated": ece(y, cal)}
    fr, mp = calibration_curve(y, cal, n_bins=10, strategy="quantile")
    exp["calibration"]["curve"] = {"frac_positive": fr.tolist(), "mean_predicted": mp.tolist()}
    fpr, tpr, thr = roc_curve(y, cal)
    exp["roc_cv"] = {"fpr": fpr[:: max(1, len(fpr) // 200)].tolist(), "tpr": tpr[:: max(1, len(tpr) // 200)].tolist(), "auc": float(roc_auc_score(y, cal))}
    exp["robustness"] = {"clean": metrics(y[v == "clean"], cal[v == "clean"]), "degraded": metrics(y[v == "degraded"], cal[v == "degraded"])}
    exp["cv_selected"] = metrics(y, cal)
    exp["cv_selected"]["ece"] = ece(y, cal)

    # ---------------- E6: learning curve & ablation ----------------
    lc = []
    rng = np.random.default_rng(SEED)
    vids = np.arange(len(train))
    for frac in (0.1, 0.2, 0.35, 0.5, 0.75, 1.0):
        accs = []
        for rep in range(3):
            sub = rng.choice(vids, max(20, int(len(vids) * frac)), replace=False)
            mask = np.isin(g, sub)
            o = cv_oof(models()[mname], X[mask], y[mask], g[mask], n_splits=4)
            accs.append(accuracy_score(y[mask], (o >= 0.5).astype(int)))
        lc.append({"fraction": frac, "videos": int(len(vids) * frac), "accuracy_mean": float(np.mean(accs)), "accuracy_std": float(np.std(accs))})
        print(f"E6 learning curve {frac:.2f}: {np.mean(accs):.3f}", flush=True)
    exp["learning_curve"] = lc

    # ---------------- final fit (video-level + frame-level) ----------------
    video_model = clone(models()[mname]).fit(X, y)
    FX, Fy = [], []
    frame_fams = ("clip", "forensic", "temporal")
    for r in train:
        for view in ("clean", "degraded"):
            fm = F.frame_matrix(r[view].ff, frame_fams)
            FX.append(fm); Fy += [r["label"]] * len(fm)
    FX = np.concatenate(FX); Fy = np.array(Fy)
    frame_model = Pipeline([("sc", StandardScaler()), ("clf", LogisticRegression(C=0.02, max_iter=4000, class_weight="balanced"))]).fit(FX, Fy)
    # frame-level CV estimate (grouped by video)
    fg = np.concatenate([[i] * (len(r["clean"].ff.times) * 2) for i, r in enumerate(train)])
    f_oof = cv_oof(frame_model, FX, Fy, fg, n_splits=5)
    exp["frame_level_cv"] = metrics(Fy, f_oof)

    # ---------------- E5: OOD (evaluated once) ----------------
    OX, Oy, Og, Ov = matrix(ood, fams)
    op = apply_platt(video_model.predict_proba(OX)[:, 1], ab)
    exp["ood"]["overall_clean"] = metrics(Oy[Ov == "clean"], op[Ov == "clean"])
    exp["ood"]["overall_degraded"] = metrics(Oy[Ov == "degraded"], op[Ov == "degraded"])
    per = {}
    for s in sorted({r["source"] for r in ood}):
        mask = np.array([ood[i]["source"] == s for i in Og]) & (Ov == "clean")
        per[s] = {"label": "ai" if Oy[mask][0] else "real", "n": int(mask.sum()), "accuracy": float(accuracy_score(Oy[mask], (op[mask] >= 0.5).astype(int))), "mean_prob_ai": float(op[mask].mean())}
    exp["ood"]["per_source"] = per
    exp["ood"]["predictions"] = [{"source": ood[i]["source"], "name": ood[i]["name"], "label": int(Oy[k]), "prob_ai": float(op[k])} for k, i in enumerate(Og) if Ov[k] == "clean"]
    fpr, tpr, _ = roc_curve(Oy[Ov == "clean"], op[Ov == "clean"])
    exp["ood"]["roc"] = {"fpr": fpr.tolist(), "tpr": tpr.tolist()}
    print(f"E5 OOD clean acc={exp['ood']['overall_clean']['accuracy']:.3f} auc={exp['ood']['overall_clean'].get('auc', 0):.3f} | degraded acc={exp['ood']['overall_degraded']['accuracy']:.3f}")

    # interpretable view: logistic weights of forensic/temporal features (on a forensic-only LR)
    XF, yF, _, _ = matrix(train, ("forensic", "temporal"))
    lrF = Pipeline([("sc", StandardScaler()), ("clf", LogisticRegression(C=0.1, max_iter=4000, class_weight="balanced"))]).fit(XF, yF)
    names = F.feature_names(("forensic", "temporal"))
    coefs = lrF.named_steps["clf"].coef_[0]
    order = np.argsort(-np.abs(coefs))[:20]
    exp["forensic_importance"] = [{"feature": names[i], "weight": float(coefs[i])} for i in order]

    OUTDIR.mkdir(parents=True, exist_ok=True)
    version = "ctx-ai-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    joblib.dump({"version": version, "video_model": video_model, "frame_model": frame_model, "families": list(fams), "frame_families": list(frame_fams),
                 "platt": ab, "threshold": 0.5, "selected": exp["selected"], "trained_on": len(train),
                 "forensic_model": lrF, "forensic_names": names, "forensic_real_mean": XF[yF == 0].mean(0), "forensic_ai_mean": XF[yF == 1].mean(0), "forensic_std": XF.std(0) + 1e-6,
                 "metrics": {"cv_accuracy": exp["cv_selected"]["accuracy"], "cv_auc": exp["cv_selected"].get("auc"), "ood_accuracy": exp["ood"]["overall_clean"]["accuracy"], "ood_auc": exp["ood"]["overall_clean"].get("auc")}}, OUTDIR / "ai_detector.joblib", compress=3)
    exp["version"] = version
    exp["train_seconds"] = round(time.time() - t_start, 1)
    (OUTDIR / "experiments.json").write_text(json.dumps(exp, indent=1, default=float), encoding="utf-8")
    print(f"saved {OUTDIR / 'ai_detector.joblib'} ({version}) in {exp['train_seconds']}s")


if __name__ == "__main__":
    main()
