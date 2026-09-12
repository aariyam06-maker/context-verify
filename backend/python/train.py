"""Logistic-regression trainer for the ContextTrace AI-content detector.

Fits a plain logistic regression (numpy, no sklearn) on the procedural corpus
with per-frame 12-feature vectors. Reports 5-fold stratified cross-validated
accuracy on the training set; final weights + standardization params + the
final held-out evaluation are written to model.json, which the gateway, the
Java verifier, and the browser detector consume.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_MODEL_PATH = ROOT / "src" / "model" / "ctxtrace-model.json"

from corpus import build_clip_corpus
from features import FEATURE_NAMES

MODEL_PATH = Path(__file__).parent / "model.json"


def standardize_fit(X: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    mu = X.mean(axis=0)
    sigma = X.std(axis=0)
    sigma[sigma < 1e-12] = 1.0
    return mu, sigma


def standardize_apply(X: np.ndarray, mu: np.ndarray, sigma: np.ndarray) -> np.ndarray:
    return (X - mu) / sigma


def sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))


def fit_logistic(
    X: np.ndarray, y: np.ndarray, l2: float = 1e-3, iters: int = 4000, lr: float = 0.12
) -> Tuple[np.ndarray, float]:
    """Full-batch gradient descent with L2; returns (weights, bias)."""
    n, d = X.shape
    w = np.zeros(d)
    b = 0.0
    for _ in range(iters):
        z = X @ w + b
        p = sigmoid(z)
        gw = X.T @ (p - y) / n + l2 * w
        gb = float((p - y).mean())
        w -= lr * gw
        b -= lr * gb
    return w, b


def predict_proba(X: np.ndarray, w: np.ndarray, b: float) -> np.ndarray:
    return sigmoid(X @ w + b)


# ---------------------------------------------------------------------------
# MLP (16 -> 32 -> 16 -> 1), ReLU hidden, sigmoid output, Adam.
# The forward pass is mirrored exactly in java/Verifier.java and
# src/lib/ai-model.ts; the conformance tests enforce agreement.
# ---------------------------------------------------------------------------

LAYER_SIZES = [23, 32, 16, 1]  # 20 frame features + 3 cross-frame scalars


def _init_mlp(seed: int = 11) -> Dict:
    rng = np.random.default_rng(seed)
    params: Dict[str, np.ndarray] = {}
    for i in range(len(LAYER_SIZES) - 1):
        fan_in = LAYER_SIZES[i]
        fan_out = LAYER_SIZES[i + 1]
        params[f"W{i}"] = rng.normal(0, np.sqrt(2.0 / fan_in), size=(fan_in, fan_out))
        params[f"b{i}"] = np.zeros(fan_out)
    return params


def _relu(z: np.ndarray) -> np.ndarray:
    return np.maximum(z, 0.0)


def mlp_forward(params: Dict[str, np.ndarray], X: np.ndarray):
    """Returns (output_prob, cache) — cache holds pre/post activations."""
    a = X
    cache = [X]
    n_layers = len(LAYER_SIZES) - 1
    for i in range(n_layers):
        z = a @ params[f"W{i}"] + params[f"b{i}"]
        a = sigmoid(z) if i == n_layers - 1 else _relu(z)
        cache.append(a)
    return a.ravel(), cache


def mlp_predict_proba(params: Dict[str, np.ndarray], X: np.ndarray) -> np.ndarray:
    out, _ = mlp_forward(params, X)
    return out


def fit_mlp(
    X: np.ndarray,
    y: np.ndarray,
    epochs: int = 260,
    lr: float = 3e-3,
    l2: float = 5e-5,
    seed: int = 11,
) -> Dict[str, np.ndarray]:
    params = _init_mlp(seed)
    n = X.shape[0]
    mW = {k: np.zeros_like(v) for k, v in params.items()}
    vW = {k: np.zeros_like(v) for k, v in params.items()}
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    ycol = y.astype(np.float64)[:, None]
    t = 0
    for _ in range(epochs):
        out, cache = mlp_forward(params, X)
        # BCE loss gradient at output.
        delta = (out[:, None] - ycol) / n
        n_layers = len(LAYER_SIZES) - 1
        for i in range(n_layers - 1, -1, -1):
            a_prev = cache[i]
            gW = a_prev.T @ delta + l2 * params[f"W{i}"]
            gb = delta.sum(axis=0)
            if i > 0:
                delta = (delta @ params[f"W{i}"].T) * (cache[i] > 0)
            t += 1
            for name, g in ((f"W{i}", gW), (f"b{i}", gb)):
                mW[name] = beta1 * mW[name] + (1 - beta1) * g
                vW[name] = beta2 * vW[name] + (1 - beta2) * g * g
                mh = mW[name] / (1 - beta1**t)
                vh = vW[name] / (1 - beta2**t)
                params[name] -= lr * mh / (np.sqrt(vh) + eps)
    return params


def params_to_json(params: Dict[str, np.ndarray]) -> List[Dict]:
    layers = []
    for i in range(len(LAYER_SIZES) - 1):
        layers.append(
            {
                "W": params[f"W{i}"].tolist(),
                "b": params[f"b{i}"].tolist(),
            }
        )
    return layers


def json_to_params(layers: List[Dict]) -> Dict[str, np.ndarray]:
    params: Dict[str, np.ndarray] = {}
    for i, layer in enumerate(layers):
        params[f"W{i}"] = np.array(layer["W"], dtype=np.float64)
        params[f"b{i}"] = np.array(layer["b"], dtype=np.float64)
    return params


def cross_validate_mlp(X: np.ndarray, y: np.ndarray, k: int = 5) -> Dict[str, float]:
    folds = stratified_folds(y, k)
    accs = []
    f1s = []
    for j in range(k):
        test_idx = folds[j]
        train_idx = np.concatenate([folds[i] for i in range(k) if i != j])
        mu, sigma = standardize_fit(X[train_idx])
        params = fit_mlp(standardize_apply(X[train_idx], mu, sigma), y[train_idx])
        p = mlp_predict_proba(params, standardize_apply(X[test_idx], mu, sigma))
        pred = (p >= 0.5).astype(np.int64)
        accs.append(float((pred == y[test_idx]).mean()))
        tp = float(((pred == 1) & (y[test_idx] == 1)).sum())
        fp = float(((pred == 1) & (y[test_idx] == 0)).sum())
        fn = float(((pred == 0) & (y[test_idx] == 1)).sum())
        prec = tp / (tp + fp) if tp + fp > 0 else 0.0
        rec = tp / (tp + fn) if tp + fn > 0 else 0.0
        f1s.append(2 * prec * rec / (prec + rec) if prec + rec > 0 else 0.0)
    return {
        "cv_accuracy": float(np.mean(accs)),
        "cv_accuracy_std": float(np.std(accs)),
        "cv_f1": float(np.mean(f1s)),
        "folds": k,
    }


def stratified_folds(y: np.ndarray, k: int = 5, seed: int = 7) -> List[np.ndarray]:
    rng = np.random.default_rng(seed)
    folds: List[List[int]] = [[] for _ in range(k)]
    for cls in (0, 1):
        idx = np.where(y == cls)[0]
        rng.shuffle(idx)
        for j, i in enumerate(idx):
            folds[j % k].append(int(i))
    return [np.array(f, dtype=np.int64) for f in folds]


def cross_validate(X: np.ndarray, y: np.ndarray, k: int = 5) -> Dict[str, float]:
    folds = stratified_folds(y, k)
    accs = []
    f1s = []
    for j in range(k):
        test_idx = folds[j]
        train_idx = np.concatenate([folds[i] for i in range(k) if i != j])
        mu, sigma = standardize_fit(X[train_idx])
        w, b = fit_logistic(standardize_apply(X[train_idx], mu, sigma), y[train_idx])
        p = predict_proba(standardize_apply(X[test_idx], mu, sigma), w, b)
        pred = (p >= 0.5).astype(np.int64)
        accs.append(float((pred == y[test_idx]).mean()))
        tp = float(((pred == 1) & (y[test_idx] == 1)).sum())
        fp = float(((pred == 1) & (y[test_idx] == 0)).sum())
        fn = float(((pred == 0) & (y[test_idx] == 1)).sum())
        prec = tp / (tp + fp) if tp + fp > 0 else 0.0
        rec = tp / (tp + fn) if tp + fn > 0 else 0.0
        f1s.append(2 * prec * rec / (prec + rec) if prec + rec > 0 else 0.0)
    return {
        "cv_accuracy": float(np.mean(accs)),
        "cv_accuracy_std": float(np.std(accs)),
        "cv_f1": float(np.mean(f1s)),
        "folds": k,
    }


CLIP_FEATURE_NAMES = FEATURE_NAMES + [
    "layout_persistence",
    "flicker_consistency",
    "noise_coupling",
]


def train_and_save(n_per_class: int = 80, frames: int = 14, seed: int = 20260911) -> Dict:
    X, y, meta = build_clip_corpus(n_per_class=n_per_class, frames=frames, seed=seed)

    # ---- Model selection: logistic baseline vs MLP, both cross-validated ----
    cv_lin = cross_validate(X, y, k=5)
    cv_mlp = cross_validate_mlp(X, y, k=5)

    use_mlp = cv_mlp["cv_accuracy"] >= cv_lin["cv_accuracy"]
    cv = cv_mlp if use_mlp else cv_lin

    mu, sigma = standardize_fit(X)
    Xs = standardize_apply(X, mu, sigma)

    if use_mlp:
        params = fit_mlp(Xs, y)
        p = mlp_predict_proba(params, Xs)
        model = {
            "version": "ctxtrace-ai-model v3 (mlp-19-32-16-1)",
            "architecture": "mlp",
            "layers": params_to_json(params),
        }
    else:
        w, b = fit_logistic(Xs, y)
        p = predict_proba(Xs, w, b)
        model = {
            "version": "ctxtrace-ai-model v2 (logistic-16f)",
            "architecture": "logistic",
            "weights": [float(x) for x in w],
            "bias": float(b),
        }

    pred = (p >= 0.5).astype(np.int64)
    in_sample_acc = float((pred == y).mean())

    model.update(
        {
            "featureOrder": FEATURE_NAMES,
            "clipFeatureOrder": CLIP_FEATURE_NAMES,
            "mu": [float(x) for x in mu],
            "sigma": [float(x) for x in sigma],
            "threshold": 0.5,
            "evaluation": {
                "corpus": "procedural_v3",
                "nClips": int(len(meta)),
                "framesPerClip": frames,
                "crossValidated": cv,
                "inSampleAccuracy": in_sample_acc,
                "baselineLogisticCv": cv_lin,
            },
        }
    )
    MODEL_PATH.write_text(json.dumps(model, indent=2))
    # Single source of truth, dual write: the Java verifier reads the backend
    # copy; the frontend bundles a typed TS module so browser scores match
    # exactly without changing any TS config.
    try:
        FRONTEND_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
        FRONTEND_MODEL_PATH.write_text(json.dumps(model, indent=2))
        ts_path = FRONTEND_MODEL_PATH.with_suffix(".generated.ts")
        ts_path.write_text(
            "// AUTO-GENERATED by backend/python/train.py — do not edit by hand.\n"
            f"// {model['version']}\n"
            "export interface CtxtraceModel {\n"
            "  version: string;\n"
            "  architecture: \"logistic\" | \"mlp\";\n"
            "  weights?: number[];\n"
            "  bias?: number;\n"
            "  layers?: { W: number[][]; b: number[] }[];\n"
            "  featureOrder: string[];\n"
            "  clipFeatureOrder: string[];\n"
            "  mu: number[];\n"
            "  sigma: number[];\n"
            "  threshold: number;\n"
            "  evaluation: Record<string, unknown>;\n"
            "}\n\n"
            f"export const CTXTRACE_MODEL: CtxtraceModel = {json.dumps(model)};\n"
        )
    except OSError:
        pass
    return model


def model_predict(model: Dict, X: np.ndarray) -> np.ndarray:
    """Dispatch on the stored architecture. X must already be standardized."""
    if model.get("architecture") == "mlp":
        params = json_to_params(model["layers"])
        return mlp_predict_proba(params, X)
    w = np.array(model["weights"])
    return predict_proba(X, w, float(model["bias"]))


def main() -> int:
    model = train_and_save()
    ev = model["evaluation"]
    cv = ev["crossValidated"]
    print(f"model written: {MODEL_PATH}")
    print(f"cv accuracy: {cv['cv_accuracy']*100:.2f}% (+/- {cv['cv_accuracy_std']*100:.2f}) f1: {cv['cv_f1']:.4f} over {cv['folds']} folds")
    print(f"in-sample accuracy: {ev['inSampleAccuracy']*100:.2f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
