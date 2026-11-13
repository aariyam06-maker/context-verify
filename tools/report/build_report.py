"""Build ContextTrace_Project_Report.pdf (project root).

Everything in the report is generated from the recorded experiment files:
  data/models/experiments.json        AI detector research (E1-E6)
  data/models/tamper_experiments.json tamper-direction model research
  data/models/baselines.json          zero-shot pretrained baselines
  data/models/acceptance_tests.json   end-to-end random-clip tests
  data/datasets/*manifest.csv         dataset provenance
Usage: python tools/report/build_report.py
"""
from __future__ import annotations

import csv
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch  # noqa: E402
from reportlab.lib import colors  # noqa: E402
from reportlab.lib.enums import TA_CENTER  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet  # noqa: E402
from reportlab.lib.units import cm  # noqa: E402
from reportlab.platypus import Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIG = ROOT / "data" / "report_figs"
FIG.mkdir(parents=True, exist_ok=True)
OUT = ROOT / "ContextTrace_Project_Report.pdf"
M = ROOT / "data" / "models"
RED, BLUE, GREEN, AMBER, VIOLET, GREY = "#c8102e", "#1f5fbf", "#2e8b57", "#d08700", "#7a4fc9", "#6b7280"
plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False, "axes.titlesize": 10, "axes.titleweight": "bold", "figure.dpi": 150})


def load(name):
    p = M / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


E, TE, BL, AC = load("experiments.json"), load("tamper_experiments.json"), load("baselines.json"), load("acceptance_tests.json")
TRAIN = list(csv.DictReader(open(ROOT / "data/datasets/manifest.csv", encoding="utf-8")))
OOD = list(csv.DictReader(open(ROOT / "data/datasets/ood_manifest.csv", encoding="utf-8")))
N_SRC = len({r["source"] for r in TRAIN}); N_SRC_REAL = len({r["source"] for r in TRAIN if r["label"] == "real"})
N_REAL = sum(r["label"] == "real" for r in TRAIN); N_AI = len(TRAIN) - N_REAL; N_GEN = len({r["generator"] for r in TRAIN if r["label"] == "ai"})


def pct(v, d=1):
    return "-" if v is None else f"{100 * v:.{d}f}%"


def save(fig, name):
    p = FIG / name
    fig.tight_layout()
    fig.savefig(p, dpi=170, bbox_inches="tight")
    plt.close(fig)
    return p


# ============================================================ diagrams
def boxes_diagram(name, boxes, arrows, size=(11, 5.6), title=None):
    fig, ax = plt.subplots(figsize=size)
    ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.axis("off")
    if title:
        ax.set_title(title, loc="left")
    centers = {}
    for key, (x, y, w, h, label, sub, col) in boxes.items():
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.4,rounding_size=1.2", fc=col + "1a", ec=col, lw=1.4))
        ax.text(x + w / 2, y + h / 2 + (2.2 if sub else 0), label, ha="center", va="center", fontsize=8.6, fontweight="bold")
        if sub:
            ax.text(x + w / 2, y + h / 2 - 2.6, sub, ha="center", va="center", fontsize=6.8, color="#333")
        centers[key] = (x, y, w, h)
    for a, b, *lab in arrows:
        xa, ya, wa, ha_ = centers[a]; xb, yb, wb, hb = centers[b]
        ca = np.array([xa + wa / 2, ya + ha_ / 2]); cb = np.array([xb + wb / 2, yb + hb / 2])
        d = cb - ca
        # exit/enter at box edges
        def edge(c, w, h, v):
            t = min(abs((w / 2) / v[0]) if v[0] else 1e9, abs((h / 2) / v[1]) if v[1] else 1e9)
            return c + v * t
        pa = edge(ca, wa + 1, ha_ + 1, d); pb = edge(cb, wb + 1, hb + 1, -d)
        ax.add_patch(FancyArrowPatch(pa, pb, arrowstyle="-|>", mutation_scale=10, lw=1.1, color="#444", connectionstyle="arc3,rad=0.0"))
        if lab:
            mid = (pa + pb) / 2
            ax.text(mid[0], mid[1] + 1.4, lab[0], fontsize=6.5, ha="center", color="#444", bbox=dict(fc="white", ec="none", pad=0.5))
    return save(fig, name)


def fig_architecture():
    B = {
        "user": (2, 78, 16, 14, "Browser user", "React app :3000", BLUE),
        "dev": (2, 52, 16, 14, "Developer", "Dev console :3751", VIOLET),
        "api": (27, 72, 20, 22, "FastAPI :8000", "auth / videos / jobs\nadmin / health", RED),
        "run": (55, 76, 18, 14, "Job runner", "1 worker thread", RED),
        "det": (80, 82, 18, 12, "detector.py", "Service 1", GREEN),
        "tam": (80, 64, 18, 12, "tamper_service.py", "Service 2", GREEN),
        "core": (55, 46, 43, 13, "ML core", "video_io | features (CLIP, forensics, flow) | tamper (align, cuts, regions) | gemini", GREEN),
        "db": (27, 40, 20, 14, "SQLite / Postgres", "users, videos,\njobs, reports", AMBER),
        "fs": (2, 26, 22, 14, "data/uploads", "video files per user", AMBER),
        "models": (55, 26, 22, 13, "data/models", "*.joblib + experiments", AMBER),
        "gem": (80, 26, 18, 13, "Gemini API", "optional 2nd opinion", GREY),
        "train": (27, 4, 71, 13, "Offline training pipeline (tools/)", "download_datasets > extract_features > train_ai_detector > build_tamper_pairs > train_tamper > acceptance_tests > build_report", VIOLET),
    }
    A = [("user", "api", "REST + JWT"), ("api", "run", "submit"), ("run", "det"), ("run", "tam"), ("det", "core"), ("tam", "core"), ("api", "db"), ("run", "db", "results"),
         ("api", "fs", "upload"), ("core", "models", "load"), ("core", "gem"), ("dev", "db", "read-only"), ("dev", "models"), ("train", "models", "writes")]
    return boxes_diagram("architecture.png", B, A, (11, 6.2))


def fig_service1():
    B = {
        "up": (1, 40, 12, 18, "Upload", "1 video\n<=500 MB", BLUE),
        "smp": (17, 40, 13, 18, "Sampler", "16 frames\n(+next frame)\nfirst 10 s", BLUE),
        "clip": (35, 70, 15, 16, "CLIP ViT-B/32", "512-d / frame", GREEN),
        "for": (35, 41, 15, 16, "Forensics", "34 features / frame", GREEN),
        "tmp": (35, 12, 15, 16, "Temporal", "flow + noise corr.", GREEN),
        "vec": (55, 41, 13, 16, "Video vector", "mean, std,\nembedding sims", AMBER),
        "vm": (72, 58, 13, 15, "Video model", "selected clf", RED),
        "fm": (72, 22, 13, 15, "Frame model", "logistic", RED),
        "cal": (88, 58, 11, 15, "Platt", "calibrated P", RED),
        "out": (88, 22, 11, 15, "Report", "P(AI), share,\ntimeline", VIOLET),
    }
    A = [("up", "smp"), ("smp", "clip"), ("smp", "for"), ("smp", "tmp"), ("clip", "vec"), ("for", "vec"), ("tmp", "vec"), ("vec", "vm"), ("clip", "fm"), ("for", "fm"), ("vm", "cal"), ("cal", "out"), ("fm", "out")]
    return boxes_diagram("service1.png", B, A, (11, 4.4), "Service 1 - AI-generated video detection (per request)")


def fig_service2():
    B = {
        "a": (1, 62, 12, 16, "Video A", "", BLUE), "b": (1, 22, 12, 16, "Video B", "", BLUE),
        "s1": (18, 62, 15, 16, "Service 1 on A", "AI prob + timeline", GREEN), "s1b": (18, 22, 15, 16, "Service 1 on B", "AI prob + timeline", GREEN),
        "trk": (38, 42, 15, 16, "Tracks", "3 fps samples,\nblock thumbs, CLIP,\ncut detector", AMBER),
        "al": (57, 62, 16, 16, "Alignment A<->B", "block-robust match,\nmonotonic path", AMBER),
        "st": (57, 22, 16, 16, "Structure", "unmatched runs, jumps,\nregion diff, speed", AMBER),
        "dir": (77, 42, 11, 16, "Direction\nmodel", "18 antisym.\nfeatures", RED),
        "out": (91, 42, 8, 16, "Verdict", "orig /\ntampered\n+ events", VIOLET),
    }
    A = [("a", "s1"), ("b", "s1b"), ("a", "trk"), ("b", "trk"), ("trk", "al"), ("trk", "st"), ("al", "st"), ("al", "dir"), ("st", "dir"), ("s1", "dir", "AI evidence"), ("s1b", "dir"), ("dir", "out")]
    return boxes_diagram("service2.png", B, A, (11, 4.4), "Service 2 - evidence tamper check (per request)")


def fig_training():
    B = {
        "d1": (1, 60, 15, 22, f"{N_SRC} public datasets", f"{len(TRAIN)} videos\n{N_REAL} real / {N_AI} AI\n{N_GEN} generators", BLUE),
        "d2": (1, 15, 15, 22, "OOD hold-out", "60 videos, 6 unseen\nsources (never used\nfor training/selection)", GREY),
        "ext": (21, 60, 15, 22, "extract_features", "clean + re-compressed\nview per video\nCLIP, DINOv2, forensic", GREEN),
        "e1": (41, 72, 18, 14, "E1 25 candidates", "5 feature sets x 5 clfs", RED),
        "e2": (41, 52, 18, 14, "E2/E3 LOSO, LOGO", "generalisation tests", RED),
        "sel": (63, 60, 15, 22, "Select + calibrate", "best LOSO among\ntop-4 CV AUC,\nPlatt scaling", RED),
        "e5": (82, 60, 16, 22, "E5 OOD test", "evaluated once", VIOLET),
        "pairs": (21, 15, 15, 22, "build_tamper_pairs", "300 pairs, 10 ops,\n2 encoding conds.", AMBER),
        "tt": (41, 15, 18, 22, "train_tamper", "4 candidate clfs,\nCV grouped by clip", AMBER),
        "acc": (63, 15, 35, 22, "acceptance_tests", "random OOD clips via real HTTP API:\n5 AI + 5 real, 5 tampered pairs, 2 controls", VIOLET),
    }
    A = [("d1", "ext"), ("ext", "e1"), ("ext", "e2"), ("e1", "sel"), ("e2", "sel"), ("sel", "e5"), ("d2", "e5"), ("d1", "pairs"), ("pairs", "tt"), ("sel", "tt", "AI evidence"), ("tt", "acc"), ("d2", "acc")]
    return boxes_diagram("training.png", B, A, (11, 4.8), "Offline research & training pipeline")


# ============================================================ charts
def fig_datasets():
    c = Counter((r["source"], r["label"]) for r in TRAIN)
    srcs = sorted({s for s, _ in c}, key=lambda s: (s not in {r["source"] for r in TRAIN if r["label"] == "real"}, s))
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.4), gridspec_kw={"width_ratios": [1.4, 1]})
    vals = [c[(s, "real")] + c[(s, "ai")] for s in srcs]
    ax[0].barh(srcs, vals, color=[BLUE if c[(s, "real")] else RED for s in srcs]); ax[0].invert_yaxis(); ax[0].set_title("Training videos per source (blue real, red AI)")
    for i, v in enumerate(vals):
        ax[0].text(v + 2, i, str(v), va="center", fontsize=7)
    g = Counter(r["generator"] for r in TRAIN if r["label"] == "ai")
    ax[1].barh(list(g), list(g.values()), color=RED); ax[1].invert_yaxis(); ax[1].set_title("AI clips per generator")
    return save(fig, "datasets.png")


def fig_compare():
    fs = list(dict.fromkeys(r["features"] for r in E["comparison"])); ms = list(dict.fromkeys(r["model"] for r in E["comparison"]))
    A = np.array([[next(r["cv"]["auc"] for r in E["comparison"] if r["features"] == f and r["model"] == m) for m in ms] for f in fs])
    B = np.array([[next(r["cv"]["accuracy"] for r in E["comparison"] if r["features"] == f and r["model"] == m) for m in ms] for f in fs])
    fig, axs = plt.subplots(1, 2, figsize=(11, 3.6))
    for ax, X, t in ((axs[0], A, "Cross-validated ROC-AUC"), (axs[1], B, "Cross-validated accuracy")):
        im = ax.imshow(X, cmap="RdYlGn", vmin=max(0.5, X.min() - 0.02), vmax=1)
        ax.set_xticks(range(len(ms)), ms, rotation=25, ha="right"); ax.set_yticks(range(len(fs)), fs); ax.set_title(t)
        for i in range(len(fs)):
            for j in range(len(ms)):
                ax.text(j, i, f"{X[i, j]:.3f}", ha="center", va="center", fontsize=7.5, fontweight="bold" if (fs[i], ms[j]) == (E["selected"]["features"], E["selected"]["model"]) else "normal")
        fig.colorbar(im, ax=ax, shrink=0.8)
    return save(fig, "compare.png")


def fig_roc_cm():
    fig, ax = plt.subplots(1, 3, figsize=(11, 3.4))
    ax[0].plot(E["roc_cv"]["fpr"], E["roc_cv"]["tpr"], color=BLUE, label=f"CV  AUC {E['roc_cv']['auc']:.3f}")
    ax[0].plot(E["ood"]["roc"]["fpr"], E["ood"]["roc"]["tpr"], color=RED, label=f"OOD AUC {E['ood']['overall_clean'].get('auc', 0):.3f}")
    if BL:
        for mid, r in BL.items():
            if "ood_predictions" in r:
                from sklearn.metrics import roc_curve

                y = [1 if p["label"] == "ai" else 0 for p in r["ood_predictions"] if p["prob_ai"] is not None]
                s = [p["prob_ai"] for p in r["ood_predictions"] if p["prob_ai"] is not None]
                f, t, _ = roc_curve(y, s)
                ax[0].plot(f, t, lw=0.9, ls="--", label=f"{mid.split('/')[0]} OOD {r['ood']['auc']:.2f}")
    ax[0].plot([0, 1], [0, 1], color=GREY, ls=":"); ax[0].set_title("ROC curves"); ax[0].set_xlabel("false-positive rate"); ax[0].set_ylabel("true-positive rate"); ax[0].legend(fontsize=6.5)
    for a, (title, cmx) in zip(ax[1:], (("Confusion - cross-validated", E["cv_selected"]["confusion"]), ("Confusion - OOD (unseen sources)", E["ood"]["overall_clean"]["confusion"]))):
        cmx = np.array(cmx)
        a.imshow(cmx, cmap="Blues"); a.set_xticks([0, 1], ["pred real", "pred AI"]); a.set_yticks([0, 1], ["real", "AI"]); a.set_title(title)
        for i in range(2):
            for j in range(2):
                a.text(j, i, str(cmx[i, j]), ha="center", va="center", fontsize=12, fontweight="bold", color="white" if cmx[i, j] > cmx.max() / 2 else "black")
    return save(fig, "roc_cm.png")


def fig_generalisation():
    key = f"{E['selected']['features']}|{E['selected']['model']}"
    lo = E["loso"].get(key) or list(E["loso"].values())[0]
    fig, ax = plt.subplots(1, 3, figsize=(11, 3.6))
    ks = list(lo["per_source"]); v = [lo["per_source"][k]["accuracy"] for k in ks]
    ax[0].barh(ks, v, color=[RED if lo["per_source"][k]["label"] == "ai" else BLUE for k in ks]); ax[0].invert_yaxis(); ax[0].set_xlim(0, 1); ax[0].set_title(f"Leave-one-source-out (mean {lo['mean_accuracy']:.3f})")
    ks = list(E["logo"]); v = [E["logo"][k]["recall"] for k in ks]
    ax[1].barh(ks, v, color=RED); ax[1].invert_yaxis(); ax[1].set_xlim(0, 1); ax[1].set_title("Leave-one-generator-out recall")
    po = E["ood"]["per_source"]; ks = list(po)
    ax[2].bar(range(len(ks)), [po[k]["accuracy"] for k in ks], color=[RED if po[k]["label"] == "ai" else BLUE for k in ks]); ax[2].set_xticks(range(len(ks)), [f"{k}\n(n={po[k]['n']})" for k in ks], fontsize=7, rotation=20)
    ax[2].set_ylim(0, 1); ax[2].set_title("OOD accuracy per unseen source")
    for a in ax[:2]:
        for i, val in enumerate(a.patches):
            a.text(val.get_width() + 0.01, val.get_y() + val.get_height() / 2, f"{val.get_width():.2f}", va="center", fontsize=6.5)
    return save(fig, "generalisation.png")


def fig_calib_lc():
    fig, ax = plt.subplots(1, 3, figsize=(11, 3.3))
    c = E["calibration"]["curve"]
    ax[0].plot(c["mean_predicted"], c["frac_positive"], "o-", color=AMBER); ax[0].plot([0, 1], [0, 1], ":", color=GREY)
    ax[0].set_title(f"Reliability (ECE {E['calibration']['ece_calibrated']:.3f})"); ax[0].set_xlabel("predicted P(AI)"); ax[0].set_ylabel("observed AI fraction")
    lc = E["learning_curve"]
    ax[1].errorbar([r["videos"] for r in lc], [r["accuracy_mean"] for r in lc], yerr=[r["accuracy_std"] for r in lc], fmt="o-", color=GREEN, capsize=3)
    ax[1].set_title("Learning curve"); ax[1].set_xlabel("training videos"); ax[1].set_ylabel("CV accuracy")
    rb = E["robustness"]
    lab = ["accuracy", "AUC", "recall AI", "F1"]
    x = np.arange(4)
    ax[2].bar(x - 0.18, [rb["clean"]["accuracy"], rb["clean"]["auc"], rb["clean"]["recall"], rb["clean"]["f1"]], 0.36, color=BLUE, label="clean")
    ax[2].bar(x + 0.18, [rb["degraded"]["accuracy"], rb["degraded"]["auc"], rb["degraded"]["recall"], rb["degraded"]["f1"]], 0.36, color=AMBER, label="re-compressed")
    ax[2].set_xticks(x, lab); ax[2].set_ylim(0.5, 1); ax[2].legend(fontsize=7); ax[2].set_title("Robustness to re-compression")
    return save(fig, "calib_lc.png")


def fig_importance():
    imp = E["forensic_importance"][:16]
    fig, ax = plt.subplots(figsize=(11, 3.4))
    ax.barh([r["feature"] for r in imp], [r["weight"] for r in imp], color=[RED if r["weight"] > 0 else BLUE for r in imp]); ax.invert_yaxis()
    ax.axvline(0, color="#333", lw=0.8); ax.set_title("Interpretable forensic signals: standardised logistic weights (red = pushes towards AI, blue = towards real camera)")
    return save(fig, "importance.png")


def fig_baselines():
    names, accs, aucs = [], [], []
    for mid, r in (BL or {}).items():
        if "ood" in r:
            names.append(mid.split("/")[-1][:28] + "\n(zero-shot)"); accs.append(r["ood"]["accuracy"]); aucs.append(r["ood"]["auc"])
    names.append("ContextTrace v4\n(selected)"); accs.append(E["ood"]["overall_clean"]["accuracy"]); aucs.append(E["ood"]["overall_clean"].get("auc", 0))
    fig, ax = plt.subplots(figsize=(11, 3.2))
    x = np.arange(len(names))
    ax.bar(x - 0.18, accs, 0.36, color=BLUE, label="OOD accuracy"); ax.bar(x + 0.18, aucs, 0.36, color=AMBER, label="OOD ROC-AUC")
    for i, (a, b) in enumerate(zip(accs, aucs)):
        ax.text(i - 0.18, a + 0.01, f"{a:.2f}", ha="center", fontsize=7); ax.text(i + 0.18, b + 0.01, f"{b:.2f}", ha="center", fontsize=7)
    ax.set_xticks(x, names, fontsize=7.5); ax.set_ylim(0, 1.08); ax.axhline(0.5, ls=":", color=GREY); ax.legend(fontsize=7); ax.set_title("Same 60 unseen OOD videos: off-the-shelf detectors vs. ContextTrace")
    return save(fig, "baselines.png")


def fig_tamper():
    fig, ax = plt.subplots(1, 3, figsize=(11, 3.6))
    c = TE["comparison"]; ks = list(c)
    ax[0].bar(range(len(ks)), [c[k]["accuracy"] for k in ks], color=[RED if k == TE["selected"] else BLUE for k in ks]); ax[0].set_xticks(range(len(ks)), ks, rotation=20, fontsize=7.5)
    ax[0].set_ylim(0.5, 1); ax[0].set_title("Direction model candidates (CV acc.)")
    for i, k in enumerate(ks):
        ax[0].text(i, c[k]["accuracy"] + 0.005, f"{c[k]['accuracy']:.3f}", ha="center", fontsize=7)
    o = TE["accuracy_by_operation"]; ks = list(o)
    ax[1].barh([f"{k} (n={o[k]['n']})" for k in ks], [o[k]["accuracy"] for k in ks], color=VIOLET); ax[1].invert_yaxis(); ax[1].set_xlim(0, 1); ax[1].set_title("Direction accuracy by operation")
    ev = TE["event_detection_recall"]; ks = list(ev)
    ax[2].barh(ks, [ev[k]["recall"] for k in ks], color=GREEN); ax[2].invert_yaxis(); ax[2].set_xlim(0, 1); ax[2].set_title("Edit localisation recall")
    return save(fig, "tamper.png")


def fig_tamper_weights():
    w = TE.get("weights")
    if not w:
        return None
    ks = sorted(w, key=lambda k: -abs(w[k]))
    fig, ax = plt.subplots(figsize=(11, 3.0))
    ax.bar(ks, [w[k] for k in ks], color=[RED if w[k] > 0 else BLUE for k in ks]); ax.axhline(0, color="#333", lw=0.8)
    ax.set_xticks(range(len(ks)), ks, rotation=35, ha="right", fontsize=7.5); ax.set_title("Antisymmetric logistic weights (per unit of B-minus-A evidence; + = evidence that B is tampered)")
    return save(fig, "tamper_weights.png")


# ============================================================ document
ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontSize=17, textColor=colors.HexColor(RED), spaceBefore=6, spaceAfter=8)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontSize=12.5, spaceBefore=10, spaceAfter=5)
H3 = ParagraphStyle("H3", parent=ss["Heading3"], fontSize=10.5, spaceBefore=6, spaceAfter=3)
BODY = ParagraphStyle("B", parent=ss["BodyText"], fontSize=9.2, leading=12.6, spaceAfter=5)
SMALL = ParagraphStyle("S", parent=BODY, fontSize=7.8, leading=10)
CAP = ParagraphStyle("C", parent=BODY, fontSize=7.8, textColor=colors.HexColor("#555"), alignment=TA_CENTER, spaceAfter=10)
CELL = ParagraphStyle("cell", parent=BODY, fontSize=7.6, leading=9.4, spaceAfter=0)


def P(t, st=BODY):
    return Paragraph(t, st)


def img(p, width=17.5 * cm, cap=None):
    from reportlab.lib.utils import ImageReader

    iw, ih = ImageReader(str(p)).getSize()
    out = [Image(str(p), width=width, height=width * ih / iw)]
    if cap:
        out.append(P(cap, CAP))
    return KeepTogether(out)


def table(rows, widths, head=True, zebra=True):
    data = [[c if not isinstance(c, str) else Paragraph(c, CELL) for c in r] for r in rows]
    t = Table(data, colWidths=widths, repeatRows=1 if head else 0)
    style = [("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#bbbbbb")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5)]
    if head:
        style.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#ececec")))
    if zebra:
        for i in range(1 if head else 0, len(rows)):
            if i % 2 == 0:
                style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#f8f8f8")))
    t.setStyle(TableStyle(style))
    return t


def footer(c, doc):
    c.saveState(); c.setFont("Helvetica", 7.5); c.setFillColor(colors.HexColor("#777"))
    c.drawString(1.8 * cm, 1.1 * cm, "ContextTrace v4 - project, architecture & model research report")
    c.drawRightString(A4[0] - 1.8 * cm, 1.1 * cm, f"page {doc.page}")
    c.restoreState()


def build():
    sel = E["selected"]
    cv, ood = E["cv_selected"], E["ood"]["overall_clean"]
    ac = (AC or {}).get("summary", {})
    tsel = TE["comparison"][TE["selected"]]
    figs = {k: f() for k, f in [("arch", fig_architecture), ("s1", fig_service1), ("s2", fig_service2), ("train", fig_training), ("data", fig_datasets), ("cmp", fig_compare),
                                ("roc", fig_roc_cm), ("gen", fig_generalisation), ("cal", fig_calib_lc), ("imp", fig_importance), ("tam", fig_tamper)]}
    figs["base"] = fig_baselines() if BL else None
    figs["tw"] = fig_tamper_weights()
    S = []
    # ---------------------------------------------------------------- title
    S += [Spacer(1, 2.2 * cm), P("ContextTrace v4", ParagraphStyle("T", parent=H1, fontSize=30, leading=34)),
          P("AI-generated video detection &amp; two-video evidence-tamper analysis", ParagraphStyle("st", parent=H2, fontSize=15)),
          P("Project report - architecture, data, model research, evaluation evidence and acceptance tests", BODY), Spacer(1, 0.6 * cm),
          P(f"Generated {datetime.now().strftime('%d %B %Y %H:%M')} from the recorded experiment files in <font face='Courier'>data/models/</font>. "
            f"AI model <b>{E['version']}</b>, tamper model <b>{TE['version']}</b>.", BODY), Spacer(1, 0.8 * cm)]
    S.append(table([["Headline result", "Value", "Evidence"],
                    ["AI detector - accuracy on never-seen sources (OOD)", pct(ood["accuracy"]), f"60 videos from 6 sources/generators never used in training or model selection; AUC {ood.get('auc', 0):.3f}"],
                    ["AI detector - cross-validated accuracy", pct(cv["accuracy"]), f"5-fold grouped CV, {E['n_train_videos']} videos x 2 views, AUC {cv.get('auc', 0):.3f}"],
                    ["AI detector - after re-compression", pct(E["robustness"]["degraded"]["accuracy"]), "random down-scaling 240-720 px + JPEG q45-91"],
                    ["Tamper direction (which file is original)", pct(tsel["accuracy"]), f"{TE['n_pairs']} synthetic pairs, 10 operations, CV grouped by source clip"],
                    ["Acceptance - scenario 1 (random clips)", f"{ac.get('detect_correct', '-')}/{ac.get('detect_total', '-')}", "5 AI + 5 real random OOD clips, <=10 s, through the live API"],
                    ["Acceptance - scenario 2 (random pairs)", f"{ac.get('tamper_correct', '-')}/{ac.get('tamper_total', '-')}", "5 tampered pairs, random upload order, through the live API"],
                    ["Acceptance - controls", f"{ac.get('controls_correct', '-')}/{ac.get('controls_total', '-')}", "identical pair -> no tampering; unrelated pair -> unrelated"]],
                   [6.2 * cm, 2.2 * cm, 9.1 * cm]))
    S.append(PageBreak())
    # ---------------------------------------------------------------- 1 motive
    S += [P("1. Project motive and scope", H1),
          P("Synthetic video is now cheap to produce and edited footage circulates as 'evidence'. ContextTrace gives an analyst two answers, each with a probability, a "
            "timeline and the forensic reasons behind it:"),
          table([["Service", "Input", "Question answered", "Output"],
                 ["1 - AI-generated video detection", "one video", "Was this clip made by an AI generator (text-to-video, face re-enactment / deepfake)? How much of it?",
                  "calibrated P(AI); AI content share (% of timeline); per-frame timeline; segment list; top forensic signals; optional Gemini second opinion"],
                 ["2 - Evidence tamper check", "two videos, any order", "Is one an edited copy of the other? Which is the original, which was tampered, and what was changed?",
                  "verdict (tampered / identical / unrelated); original vs tampered with confidence; originality %; located events (inserted, removed, re-ordered, in-frame edit, speed, re-encode); service-1 analysis of both"]],
                [3.4 * cm, 2.2 * cm, 5.4 * cm, 6.5 * cm]), Spacer(1, 6),
          P("<b>Why two services instead of three.</b> Version 3 had (a) source-vs-edit transcript comparison, (b) single-video AI scan and (c) a client-side 'mitigation' pass "
            "that re-encoded a video to lower its AI score. (c) is an evasion tool and contradicts the forensic purpose, so it was removed. (a) was folded into service 2, "
            "which compares visual content directly - it works without speech, subtitles or a separate ASR stack and also catches visual-only edits. The old code is preserved under "
            "<font face='Courier'>legacy/</font>."),
          P("<b>One command.</b> <font face='Courier'>python start.py</font> (or double-click <font face='Courier'>start.bat</font>, or <font face='Courier'>npm start</font>) "
            "creates the virtual environment, installs dependencies, trains the models if they are missing and starts all three services: web app on :3000, API on :8000, "
            "developer console on :3751. Demo logins are seeded automatically and offered as one-click buttons on the sign-in page: "
            "<b>demo@contexttrace.app / DemoTrace@2026</b> (analyst) and <b>admin@contexttrace.app / AdminTrace@2026</b> (admin).")]
    # ---------------------------------------------------------------- 2 architecture
    S += [PageBreak(), P("2. System architecture", H1), img(figs["arch"], cap="Figure 1 - runtime components (top) and the offline research/training pipeline (bottom)."),
          img(figs["s1"], cap="Figure 2 - request flow for service 1."), img(figs["s2"], cap="Figure 3 - request flow for service 2.")]
    S += [P("2.1 Which code does what", H2), table([["Path", "Responsibility"],
          ["start.py / start.bat", "One-command bootstrap: venv + pip + npm install, optional training, launches API (:8000), dev console (:3751) and Vite web app (:3000); Ctrl+C stops all."],
          ["backend/app/main.py", "FastAPI app; DB bootstrap; seeds demo accounts; /api/health; public /api/models/summary."],
          ["backend/app/api/auth.py", "Register / login / refresh / logout / guest; demo accounts + GET /api/auth/demo; rate limiting; Argon2 hashes, JWT access + rotating refresh cookie."],
          ["backend/app/api/videos.py", "Authenticated upload (streamed, size-limited, validated by decoding) and owner-only streaming."],
          ["backend/app/api/jobs.py", "POST /jobs/detect, POST /jobs/tamper, list/get/delete, GET /report, PDF/JSON download."],
          ["backend/app/services/runner.py", "Single-worker background queue; stage/progress updates; stores the result JSON in the reports table."],
          ["backend/app/services/report_pdf.py", "Per-job downloadable PDF report."],
          ["backend/app/ml/video_io.py", "OpenCV decoding, fast sampled decoding (grab/retrieve), probing, H.264 writing via bundled FFmpeg (imageio-ffmpeg)."],
          ["backend/app/ml/features.py", "34 forensic + 8 temporal features per frame, CLIP ViT-B/32 (QuickGELU, OpenAI weights) and DINOv2-small embedders, degradation augmentation, video-vector assembly."],
          ["backend/app/ml/detector.py", "Service 1 runtime: loads ai_detector.joblib, scores video + frames, Platt calibration, AI share, segments, plain-language evidence."],
          ["backend/app/ml/tamper.py", "Service 2 core: tracks, block-robust alignment, cut detection, unmatched runs, jumps, re-ordering, in-frame region diff, speed, 18 antisymmetric features."],
          ["backend/app/ml/tamper_service.py", "Service 2 runtime: runs service 1 on both, pair analysis, direction model, verdict and event narration."],
          ["backend/app/ml/tamper_synth.py", "10 tampering operations used for training pairs and acceptance tests."],
          ["backend/app/ml/gemini.py", "Optional Gemini (free tier) second opinion on 4 key-frames; enabled only by GEMINI_API_KEY."],
          ["backend/devdash/", "Developer console (:3751): live runs, latency, CPU/RAM, animated inference graph, all research charts, acceptance results."],
          ["src/pages/", "React UI: Landing, Auth (demo buttons), Dashboard, Detect, Tamper, Result, History, Admin, Legal."],
          ["tools/datasets/", "Reproducible dataset download (training + OOD) with full manifests."],
          ["tools/ml/", "Feature extraction, AI detector research/training, pair synthesis, tamper training, baselines, acceptance tests."],
          ["tools/report/build_report.py", "Generates this PDF from the recorded experiment files."],
          ["tests/test_contexttrace.py", "pytest: API/auth/demo, ML units (features, ops, alignment antisymmetry), end-to-end detect and tamper jobs."]],
          [5.2 * cm, 12.3 * cm])]
    S += [P("2.2 What the data folders hold", H2), table([["Path", "Contents"],
          ["data/datasets/raw/&lt;source&gt;/", f"{len(TRAIN)} training videos from {N_SRC} public sources; provenance in manifest.csv (source, label, generator, origin URL, licence note)."],
          ["data/datasets/ood/", "60 held-out videos from 6 unseen sources; ood_manifest.csv."],
          ["data/features/{train,ood}/", "Cached per-video features (clean + re-compressed view): forensic, temporal, CLIP, DINOv2, labels, metadata."],
          ["data/tamper_pairs/", "index.jsonl (ops, conditions, structural metrics) + per-pair cache.npz; first 12 pairs keep their mp4 files."],
          ["data/models/", "ai_detector.joblib, tamper_model.joblib, experiments.json, tamper_experiments.json, baselines.json, acceptance_tests.json (+ history)."],
          ["data/acceptance/", "The exact clips and pairs used by the acceptance tests - can be re-uploaded in the UI."],
          ["data/uploads/, data/artifacts/", "Runtime: user uploads and generated per-job PDF/JSON reports."],
          ["data/contexttrace.db", "SQLite database: users, auth sessions, videos, analysis jobs, reports."]], [5.2 * cm, 12.3 * cm])]
    # ---------------------------------------------------------------- 3 data
    S += [PageBreak(), P("3. Data", H1), P(f"The training corpus has <b>{len(TRAIN)} videos from {N_SRC} public datasets</b> ({N_SRC_REAL} real-camera, {N_SRC - N_SRC_REAL} AI) and spans "
          f"{len({r['generator'] for r in TRAIN if r['label'] == 'ai'})} AI generators: commercial text-to-video systems and academic portrait animation / face re-enactment models. "
          "All data are downloaded by script from Hugging Face; nothing requires a licence form."), img(figs["data"], cap="Figure 4 - training corpus composition.")]
    notes = {}
    for r in TRAIN:
        notes.setdefault(r["source"], (r["label"], r["repo"], r["note"]))
    rows = [["Source", "Label", "n", "Hugging Face repository", "Description / citation"]]
    for s, (lab, repo, note) in notes.items():
        rows.append([s, lab, str(sum(1 for r in TRAIN if r["source"] == s)), repo, note])
    S.append(table(rows, [2.3 * cm, 1.1 * cm, 0.9 * cm, 5.4 * cm, 7.8 * cm]))
    S += [P("Out-of-distribution (OOD) hold-out set", H3),
          table([["Source", "Label", "n", "Why it is a hard test"]] + [[s, lab, str(n), why] for s, lab, n, why in [
              ("veo3.1", "ai", sum(r["source"] == "veo3.1" for r in OOD), "Google Veo 3.1 - newer than every training generator"),
              ("magi1", "ai", sum(r["source"] == "magi1" for r in OOD), "Sand-AI MAGI-1 autoregressive video model - architecture family absent from training"),
              ("hallo3", "ai", sum(r["source"] == "hallo3" for r in OOD), "Hallo3 portrait animation (diffusion transformer)"),
              ("community_ai", "ai", sum(r["source"] == "community_ai" for r in OOD), "community-made AI animations of unknown origin"),
              ("phone_selfie", "real", sum(r["source"] == "phone_selfie" for r in OOD), "smartphone .MOV selfies - phone ISP & HEVC, not seen in training"),
              ("street", "real", sum(r["source"] == "street" for r in OOD), "crowd-sourced street videos (HumynLabs) - handheld phones, varied cities and light. "
               "Replaced Wikimedia Commons, which rate-limited bulk download (HTTP 429)")]], [2.6 * cm, 1.2 * cm, 1 * cm, 12.7 * cm]),
          P("<b>Bias controls.</b> (i) Every video contributes a clean and a re-compressed view (random short side 240/360/480/720 px, JPEG quality 45-91), applied identically "
            "to both classes, so resolution or compression cannot be used as a shortcut. (ii) Container metadata, fps, duration and resolution are <i>not</i> features. "
            "(iii) Only the first 10 s are analysed in training and at inference. (iv) CV folds are grouped by video so both views of a clip are always on the same side. "
            "(v) Talking-head fakes (TalkingHeadBench) are matched with real talking heads (CelebV-HQ) so 'contains a face' is not predictive. "
            "(vi) The OOD set is evaluated exactly once, after model selection.")]
    # ---------------------------------------------------------------- 4 AI model research
    S += [PageBreak(), P("4. Service 1 - model research", H1),
          P("<b>Candidate feature families.</b> "
            "<b>CLIP ViT-B/32</b> embeddings (Radford et al., 2021): large-scale vision-language features that transfer well to detecting generated imagery "
            "(UnivFD, Ojha et al., CVPR 2023). "
            "<b>DINOv2-small</b> (Oquab et al., 2023): a self-supervised backbone with strong low-level sensitivity (CLS token + mean patch token, 768-d). "
            "<b>Forensic features</b> (34 per frame): radial power spectrum slope, high/mid-frequency energy and periodic spectral peaks (up-sampling artefacts; Durall et al., 2020; Frank et al., 2020; Corvi et al., 2023), "
            "noise-residual strength, kurtosis and cross-channel correlation (demosaicing traces), sharpness, LBP texture entropy, saturation, blockiness. "
            "<b>Temporal features</b> (8 per frame pair): Farneback optical-flow magnitude and smoothness, flow-warp photometric error, and temporal correlation of the noise residual. Real sensor noise is independent from frame to frame, while generated noise tends to be smooth."),
          P("<b>Candidate classifiers.</b> L2-regularised logistic regression, RBF-kernel SVM, random forest, gradient boosting (on 64 PCA components), and a neural network "
            "(MLP 256-64, early stopping). 5 feature sets x 5 classifiers = <b>25 candidates</b>."),
          img(figs["cmp"], cap="Figure 5 - E1: all 25 candidates, 5-fold StratifiedGroupKFold. Bold = selected model.")]
    rows = [["Features", "Model", "Dims", "CV acc.", "CV AUC", "clean acc.", "re-comp. acc.", "F1", "Brier"]]
    for r in sorted(E["comparison"], key=lambda r: -r["cv"].get("auc", 0)):
        star = (r["features"], r["model"]) == (sel["features"], sel["model"])
        f = (lambda s: f"<b>{s}</b>") if star else (lambda s: s)
        rows.append([f(r["features"]), f(r["model"]), str(r["dims"]), f(pct(r["cv"]["accuracy"])), f(f"{r['cv']['auc']:.3f}"), pct(r["cv_clean"]["accuracy"]), pct(r["cv_degraded"]["accuracy"]), f"{r['cv']['f1']:.3f}", f"{r['cv']['brier']:.3f}"])
    S += [table(rows, [4.3 * cm, 2.3 * cm, 1.2 * cm, 1.6 * cm, 1.5 * cm, 1.7 * cm, 1.8 * cm, 1.4 * cm, 1.4 * cm]), Spacer(1, 6)]
    lo_rows = [["Candidate (top-4 by CV AUC)", "Mean held-out-source accuracy"]] + [[k.replace("|", " + "), pct(v["mean_accuracy"])] for k, v in E["loso"].items()]
    S += [P("Model selection", H2), P("The top-4 candidates by CV AUC were re-tested with <b>leave-one-source-out</b> (LOSO): each of the "
          f"{N_SRC} datasets is removed entirely, the model is trained on the other {N_SRC - 1} and tested on the held-out one. This is a much harder test than random CV because the camera pipeline, compression and generator of the test source "
          "are unseen. <b>The candidate with the highest mean LOSO accuracy is selected</b>. The OOD set plays no part in selection."),
          table(lo_rows, [11 * cm, 6.5 * cm]), Spacer(1, 4),
          P(f"<b>Selected:</b> {sel['features']} + {sel['model']}. The final video model is refitted on all {E['n_train_videos']} videos x 2 views. Its raw score is calibrated "
            f"by Platt scaling fitted on out-of-fold predictions (ECE {E['calibration']['ece_raw']:.3f} raw -> {E['calibration']['ece_calibrated']:.3f} calibrated), "
            "so the reported percentage behaves like a probability. A separate per-frame logistic model "
            f"(CLIP + forensic + temporal per frame; frame-level CV AUC {E['frame_level_cv'].get('auc', 0):.3f}) produces the timeline. The <b>AI content share</b> is the fraction of "
            "sampled frames whose blended score, 0.5 x frame probability + 0.5 x video probability after a 3-tap median filter, is at least 0.5.")]
    S += [PageBreak(), P("5. Service 1 - evaluation evidence", H1), img(figs["roc"], cap="Figure 6 - ROC curves (CV, OOD and zero-shot baselines on OOD) and confusion matrices."),
          img(figs["gen"], cap="Figure 7 - generalisation: E2 leave-one-source-out, E3 leave-one-generator-out, E5 OOD per unseen source."),
          img(figs["cal"], cap="Figure 8 - calibration reliability curve, learning curve, and robustness to re-compression (E4).")]
    S += [table([["Metric", "Cross-validated (all views)", "OOD - clean", "OOD - re-compressed"],
                 ["Accuracy", pct(cv["accuracy"]), pct(ood["accuracy"]), pct(E["ood"]["overall_degraded"]["accuracy"])],
                 ["Balanced accuracy", pct(cv["balanced_accuracy"]), pct(ood["balanced_accuracy"]), pct(E["ood"]["overall_degraded"]["balanced_accuracy"])],
                 ["ROC-AUC", f"{cv.get('auc', 0):.3f}", f"{ood.get('auc', 0):.3f}", f"{E['ood']['overall_degraded'].get('auc', 0):.3f}"],
                 ["Precision (AI)", pct(cv["precision"]), pct(ood["precision"]), pct(E["ood"]["overall_degraded"]["precision"])],
                 ["Recall (AI)", pct(cv["recall"]), pct(ood["recall"]), pct(E["ood"]["overall_degraded"]["recall"])],
                 ["F1", f"{cv['f1']:.3f}", f"{ood['f1']:.3f}", f"{E['ood']['overall_degraded']['f1']:.3f}"],
                 ["Brier score", f"{cv['brier']:.3f}", f"{ood['brier']:.3f}", f"{E['ood']['overall_degraded']['brier']:.3f}"],
                 ["n", str(cv["n"]), str(ood["n"]), str(E["ood"]["overall_degraded"]["n"])]], [4.5 * cm, 4.4 * cm, 4.3 * cm, 4.3 * cm])]
    if figs["base"]:
        rows = [["Model", "Train-sample acc.", "Train-sample AUC", "OOD acc.", "OOD AUC", "OOD recall AI", "OOD specificity"]]
        for mid, r in BL.items():
            if "ood" in r:
                rows.append([mid, pct(r["train_sample"]["accuracy"]), f"{r['train_sample']['auc']:.3f}", pct(r["ood"]["accuracy"]), f"{r['ood']['auc']:.3f}", pct(r["ood"]["recall_ai"]), pct(r["ood"]["specificity_real"])])
        rows.append([f"<b>ContextTrace v4 ({sel['model']})</b>", "(CV) " + pct(cv["accuracy"]), f"{cv.get('auc', 0):.3f}", f"<b>{pct(ood['accuracy'])}</b>", f"<b>{ood.get('auc', 0):.3f}</b>", pct(ood["recall"]),
                     pct(ood["confusion"][0][0] / max(1, sum(ood["confusion"][0])))])
        S += [PageBreak(), P("5.1 Comparison with off-the-shelf pretrained detectors", H2),
              P("Three popular Hugging Face image classifiers were applied zero-shot (mean fake-class probability over 8 frames) to a stratified 198-video sample of the training "
                "corpus and to the same 60 OOD videos. <font face='Courier'>dima806/deepfake_vs_real_image_detection</font> was the secondary detector of the previous v3 release."),
              img(figs["base"], cap="Figure 9 - zero-shot baselines vs the trained ContextTrace detector on identical unseen videos."), table(rows, [5.6 * cm, 2 * cm, 2 * cm, 1.8 * cm, 1.6 * cm, 2.2 * cm, 2.3 * cm])]
    S += [P("5.2 What the model looks at", H2), img(figs["imp"], cap="Figure 10 - standardised weights of an interpretable forensic-only logistic model. The same signals are listed per video in every report.")]
    # ---------------------------------------------------------------- tamper
    S += [PageBreak(), P("6. Service 2 - evidence tamper check", H1),
          P("<b>Alignment.</b> Each video is sampled at 3 fps (up to 32 samples). Every sample is described by a 32x32 grey thumbnail split into a 4x4 block grid, plus a CLIP "
            "embedding. Block similarity keeps only the best 75% of blocks, so a local edit such as a caption, an inpainted object or a cloned patch does not break the "
            "correspondence. Frames match when the block score is at least 0.85 and CLIP is at least 0.62, or when CLIP is at least 0.955, which covers re-coloured or cropped copies. "
            "Ties in static scenes are resolved toward the next expected index, which keeps the path monotonic."),
          P("<b>Structure.</b> From the two alignments (A->B, B->A) the analyser extracts: unmatched runs and their <i>foreignness</i>. A run whose boundaries are visual "
            "discontinuities is inserted footage; a run that flows continuously from its neighbours is native content removed from the other copy. It also extracts hard cuts "
            "with no counterpart in the other video, source-time jumps between consecutive matched samples, the non-monotonic fraction (re-ordering, via the longest increasing "
            "subsequence), playback-speed ratio (median local slope), a vote-based in-frame region diff with bounding box, and quality/compression statistics."),
          P("<b>Direction model.</b> 18 features are computed as <i>evidence(B) - evidence(A)</i>. They are antisymmetric by construction, so swapping the upload order flips the "
            "feature vector (tested in the suite), and every pair is trained in both orders. AI evidence adds the mean frame-level AI probability and the maximum AI probability "
            "inside unmatched footage. A pair is <i>unrelated</i> when neither video covers 30% of the other, and <i>identical</i> when both cover 97% or more with no cut, region, "
            "speed or order difference."),
          P(f"<b>Training data.</b> {TE['n_pairs']} pairs synthesised from training clips: 80% real originals and 20% AI originals. Ten operations are used: cut_middle, insert_foreign, insert_ai, "
            "replace_segment, reorder, object_removal (TELEA inpainting), copy_move, caption_overlay, speed_change and trim_ends, with 30% of pairs receiving two operations. "
            "Splice material comes from other real or AI clips. Two encoding conditions are mixed 50/50 so the model cannot simply pick the more-compressed file: "
            "<i>chain</i> (original CRF 14, tampered CRF 18-30) and <i>equal</i> (both encoded at the same CRF 18-28). CV is grouped by source clip."),
          img(figs["tam"], cap="Figure 11 - candidate models, direction accuracy per operation, and edit-localisation recall.")]
    if figs["tw"]:
        S.append(img(figs["tw"], cap="Figure 12 - learned evidence weights of the antisymmetric logistic model."))
    rows = [["Model", "CV accuracy", "CV AUC"]] + [[("<b>%s</b>" % k) if k == TE["selected"] else k, pct(v["accuracy"]), f"{v['auc']:.3f}"] for k, v in TE["comparison"].items()]
    S += [table(rows, [7 * cm, 5 * cm, 5.5 * cm]), Spacer(1, 4),
          table([["Condition", "Direction accuracy", "n"]] + [[k, pct(v["accuracy"]), str(v["n"])] for k, v in TE["accuracy_by_condition"].items()], [7 * cm, 5 * cm, 5.5 * cm])]
    # ---------------------------------------------------------------- acceptance
    if AC:
        S += [PageBreak(), P("7. Acceptance tests on random free-source clips", H1),
              P(f"Run {AC['created'][:19]} UTC, seed {ac.get('seed')}. Clips are drawn at random from the OOD pool, so neither their sources nor their generators were seen in "
                "training, and they are trimmed to 10 s or less. Every case goes through the real HTTP API: demo login, upload, job, polling and report. For scenario 2 each "
                "pair uses a different operation, and the upload order is randomised."),
              table([["Scenario", "Correct", "Accuracy", "Detail"],
                     ["1 - AI detection", f"{ac['detect_correct']}/{ac['detect_total']}", pct(ac["detect_accuracy"]), f"AI recall {pct(ac['detect_ai_recall'])}, real specificity {pct(ac['detect_real_specificity'])}, mean {ac['mean_seconds_detect']:.1f} s/video"],
                     ["2 - tamper check", f"{ac['tamper_correct']}/{ac['tamper_total']}", pct(ac["tamper_accuracy"]), f"original vs tampered decision, mean {ac['mean_seconds_tamper']:.1f} s/pair"],
                     ["controls", f"{ac['controls_correct']}/{ac['controls_total']}", "-", "identical pair and unrelated pair"]], [3.6 * cm, 2 * cm, 2 * cm, 9.9 * cm]), Spacer(1, 6)]
        rows = [["#", "Scenario", "Clip(s)", "Truth", "Prediction", "Scores", "OK", "s"]]
        for i, c in enumerate(AC["cases"], 1):
            rows.append([str(i), c["scenario"], c["files"], c["truth"], c["prediction"], c["score"], "yes" if c["correct"] else "<font color='#c8102e'><b>NO</b></font>", str(c["seconds"])])
        S.append(table(rows, [0.6 * cm, 2.3 * cm, 5.6 * cm, 1.6 * cm, 1.8 * cm, 3.8 * cm, 0.8 * cm, 1 * cm]))
        hist = M / "acceptance_history.jsonl"
        if hist.exists():
            H = [json.loads(l) for l in hist.open(encoding="utf-8")]
            if len(H) > 1:
                S += [Spacer(1, 6), P("Repeated runs with different random seeds", H3),
                      table([["Run (UTC)", "Seed", "Scenario 1", "Scenario 2", "Controls"]] + [[h["created"][:19], str(h["seed"]), f"{h['detect_correct']}/{h['detect_total']}",
                             f"{h['tamper_correct']}/{h['tamper_total']}", f"{h['controls_correct']}/{h['controls_total']}"] for h in H], [4.5 * cm, 2 * cm, 3.6 * cm, 3.6 * cm, 3.8 * cm])]
    # ---------------------------------------------------------------- training pipeline & gemini & limitations
    S += [PageBreak(), P("8. Research pipeline, Gemini and the developer console", H1), img(figs["train"], cap="Figure 13 - offline research and training pipeline."),
          P("<b>Gemini (optional).</b> With <font face='Courier'>GEMINI_API_KEY</font> set, four key-frames are sent to <font face='Courier'>gemini-2.5-flash</font> (free tier) "
            "and asked for a JSON probability with reasons. The answer is shown separately and blended with weight 0.25 (<font face='Courier'>CTXTRACE_GEMINI_WEIGHT</font>). "
            "The local model always remains primary. <b>Status: implemented but not evaluated.</b> No API key was available during this work, so every number in this "
            "report comes from the local models alone. Because the local detector already meets the target on unseen sources, Gemini is off by default."),
          P("<b>Developer console (http://localhost:3751).</b> A read-only page that refreshes every 3 s. It shows service health, CPU/RAM, run counts, success rate, latency, "
            "flag rates, the recent-runs table and an animated inference graph that lights up the stages of the job currently running. It also shows every research chart from "
            "this report (model comparison, ROC, LOSO, LOGO, OOD, calibration, learning curve, confusion matrices, robustness, forensic weights, tamper results) and the latest "
            "acceptance-test table."),
          P("9. Limitations and threats to validity", H1),
          P("1. <b>Generator drift.</b> New generators can defeat any detector. LOGO and OOD results estimate this risk, but they do not remove it. Retrain with "
            "<font face='Courier'>python start.py --train</font> after adding sources to <font face='Courier'>tools/datasets/download_datasets.py</font>."),
          P("2. <b>Watermarks and stylistic cues.</b> Some commercial generators add visible watermarks or have a recognisable style, and CLIP may use them. This is a real-world "
            "signal, but it inflates accuracy relative to watermark-free generations."),
          P("3. <b>Synthetic tampering.</b> The direction model is trained on programmatic edits. Professional manual editing, such as colour-matched compositing or AI "
            "inpainting of whole objects, may be subtler. The per-operation and per-condition breakdowns show where it is weaker."),
          P("4. <b>Small OOD set.</b> 60 videos give a 95% confidence interval of roughly +/-7-9 points around the reported accuracy, and the acceptance tests (10 + 5 cases) are a smoke test, not a benchmark."),
          P("5. <b>Analysis window.</b> Only the first 10 s are analysed (<font face='Courier'>CTXTRACE_MAX_SECONDS</font>). Edits outside the window are not seen."),
          P("6. <b>Not legal proof.</b> Outputs are calibrated forensic indicators. Decisions should combine them with provenance, metadata and human review."),
          P("10. Reproducing every number", H1),
          table([["Step", "Command"], ["everything", "python start.py --train"], ["datasets", "python tools/datasets/download_datasets.py && python tools/datasets/download_ood.py"],
                 ["features", "python tools/ml/extract_features.py"], ["AI detector research", "python tools/ml/train_ai_detector.py"], ["baselines", "python tools/ml/baseline_pretrained.py"],
                 ["tamper model", "python tools/ml/build_tamper_pairs.py && python tools/ml/train_tamper.py"], ["tests", "python start.py --test   (pytest + acceptance tests)"],
                 ["this report", "python tools/report/build_report.py"]], [4 * cm, 13.5 * cm]),
          P("References", H2),
          P("Radford et al. (2021) Learning Transferable Visual Models From Natural Language Supervision (CLIP). | Ojha, Li, Lee (2023) Towards Universal Fake Image Detectors that "
            "Generalize Across Generative Models, CVPR (UnivFD). | Oquab et al. (2023) DINOv2: Learning Robust Visual Features without Supervision. | Durall, Keuper, Keuper (2020) "
            "Watch your Up-Convolution: CNN Based Generative Deep Neural Networks are Failing to Reproduce Spectral Distributions, CVPR. | Frank et al. (2020) Leveraging Frequency "
            "Analysis for Deep Fake Image Recognition, ICML. | Corvi et al. (2023) On the Detection of Synthetic Images Generated by Diffusion Models, ICASSP. | Rossler et al. (2019) "
            "FaceForensics++, ICCV. | Farneback (2003) Two-Frame Motion Estimation Based on Polynomial Expansion. | Platt (1999) Probabilistic Outputs for Support Vector Machines. | "
            "Telea (2004) An Image Inpainting Technique Based on the Fast Marching Method. | Datasets: Soomro et al. (2012) UCF101; Kuehne et al. (2011) HMDB51; Pont-Tuset et al. (2017) "
            "DAVIS; Kay et al. (2017) Kinetics; Zhu et al. (2022) CelebV-HQ; Rapidata text-to-video preference sets; TalkingHeadBench (Qi et al., 2025).", SMALL)]
    doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=1.8 * cm, rightMargin=1.8 * cm, topMargin=1.6 * cm, bottomMargin=1.8 * cm,
                            title="ContextTrace v4 - Project Report", author="ContextTrace")
    doc.build(S, onFirstPage=footer, onLaterPages=footer)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
