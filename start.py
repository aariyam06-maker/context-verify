"""ContextTrace - one command to set up and run everything.

    python start.py            install what is missing, then start all services
    python start.py --train    (re)build datasets + train both models, then start
    python start.py --test     run the backend test-suite and the acceptance tests
    python start.py --no-browser

Services
    http://localhost:3000   web app (React)            <- users
    http://localhost:8000   REST API (FastAPI, /docs)
    http://localhost:3751   developer console (models, accuracy, live runs)

Demo logins (also shown on the sign-in page)
    demo@contexttrace.app  / DemoTrace@2026   (analyst)
    admin@contexttrace.app / AdminTrace@2026  (admin)
"""
from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import venv
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
NPM = shutil.which("npm.cmd" if os.name == "nt" else "npm") or shutil.which("npm")
MODELS = ROOT / "data" / "models"
PORTS = {"web": 3000, "api": 8000, "dev": 3751}


def say(msg: str) -> None:
    print(f"\033[1;31m>>\033[0m {msg}", flush=True)


def run(cmd, **kw) -> None:
    subprocess.run(cmd, check=True, **kw)


def ensure_python(research: bool = False) -> None:
    if sys.version_info < (3, 10):
        sys.exit("Python 3.10+ is required.")
    if not PY.exists():
        say("Creating virtual environment .venv ...")
        venv.create(VENV, with_pip=True)
    # Check installation without importing both heavyweight encoder libraries at
    # every launch. Actual models stay lazy and are exercised by inference tests.
    modules = ["fastapi", "sqlalchemy", "cv2", "sklearn", "torch", "open_clip", "transformers", "PIL", "joblib", "imageio_ffmpeg", "psutil", "dotenv", "reportlab", "argon2", "jwt"]
    if research:
        modules += ["pytest", "pandas", "matplotlib"]
    probe = f"import importlib.util, sys; sys.exit(any(importlib.util.find_spec(name) is None for name in {modules!r}))"
    if subprocess.run([str(PY), "-c", probe], capture_output=True).returncode != 0:
        say("Installing Python dependencies (first run only, ~1-3 GB incl. CPU PyTorch) ...")
        run([str(PY), "-m", "pip", "install", "--upgrade", "pip", "-q"])
        run([str(PY), "-m", "pip", "install", "-q", "-r", str(ROOT / "backend" / ("requirements-dev.txt" if research else "requirements-inference.txt"))])


def ensure_node() -> None:
    if not NPM:
        sys.exit("Node.js 20+ (npm) is required: https://nodejs.org")
    if not (ROOT / "node_modules" / "vite").exists():
        say("Installing frontend dependencies (npm install) ...")
        run([NPM, "install", "--no-audit", "--no-fund"], cwd=ROOT)


def train() -> None:
    steps = [
        ("Downloading 12 training datasets (~3 GB)", ["tools/datasets/download_datasets.py"]),
        ("Downloading held-out OOD test set", ["tools/datasets/download_ood.py"]),
        ("Extracting CLIP / DINOv2 / forensic features", ["tools/ml/extract_features.py"]),
        ("Training + evaluating the AI detector (25 candidates)", ["tools/ml/train_ai_detector.py"]),
        ("Synthesising 300 original/tampered pairs", ["tools/ml/build_tamper_pairs.py"]),
        ("Training + evaluating the tamper-direction model", ["tools/ml/train_tamper.py"]),
    ]
    for title, args in steps:
        say(title + " ...")
        run([str(PY), "-u", *args], cwd=ROOT)


def env() -> dict:
    e = dict(os.environ)
    dotenv = ROOT / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                e.setdefault(k.strip(), v.strip())
    origins = {f"http://localhost:{PORTS['web']}", f"http://127.0.0.1:{PORTS['web']}", f"http://localhost:{PORTS['dev']}"}
    origins |= {o for o in e.get("CTXTRACE_ALLOWED_ORIGINS", "").split(",") if o}
    e["CTXTRACE_ALLOWED_ORIGINS"] = ",".join(sorted(origins))
    e["DATABASE_URL"] = e.get("DATABASE_URL") if str(e.get("DATABASE_URL", "")).startswith("postgres") else f"sqlite:///{(ROOT / 'data' / 'contexttrace.db').as_posix()}"
    e["PYTHONIOENCODING"] = "utf-8"
    e["TOKENIZERS_PARALLELISM"] = "false"
    e["VITE_API_URL"] = e.get("VITE_API_URL", f"http://localhost:{PORTS['api']}/api")
    if PORTS["web"] != 3000:
        e.setdefault("CTXTRACE_VITE_CACHE_DIR", f"node_modules/.vite-{PORTS['web']}")
    return e


def wait(url: str, seconds: int = 120) -> bool:
    t = time.time()
    while time.time() - t < seconds:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(1)
    return False


def main() -> None:
    ap = argparse.ArgumentParser(description="Run ContextTrace")
    ap.add_argument("--train", action="store_true", help="download data and (re)train both models first")
    ap.add_argument("--test", action="store_true", help="run tests instead of starting the servers")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--dev-console", action="store_true", help="also start the optional research console")
    ap.add_argument("--api-port", type=int, default=PORTS["api"])
    ap.add_argument("--web-port", type=int, default=PORTS["web"])
    a = ap.parse_args()
    if not all(1 <= port <= 65535 for port in (a.api_port, a.web_port)):
        ap.error("ports must be between 1 and 65535")
    PORTS.update(api=a.api_port, web=a.web_port)

    if not a.train and not a.test and not all((MODELS / name).exists() for name in ("ai_detector.joblib", "tamper_model.joblib")):
        sys.exit("Trained checkpoints are missing. Restore data/models/*.joblib, or explicitly run python start.py --train. Normal startup never downloads datasets or retrains.")
    if a.train and not (ROOT / "tools/ml/train_ai_detector.py").exists():
        sys.exit("Training tools are not included in the runtime package. Use the research checkout for --train.")
    if a.dev_console and not (ROOT / "backend/devdash/app.py").exists():
        sys.exit("The research console is not included in the runtime package. Omit --dev-console.")
    if not a.test:
        required_ports = (PORTS["api"], PORTS["web"]) + ((PORTS["dev"],) if a.dev_console else ())
        if len(set(required_ports)) != len(required_ports):
            ap.error("each enabled service needs a different port")
        for port in required_ports:
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", port)) == 0:
                    sys.exit(f"Port {port} is already in use. Stop the existing service or use its running app before starting another instance.")
    ensure_python(research=a.train or a.test)
    if a.test:
        run([str(PY), "-m", "pytest", "-q", "tests"], cwd=ROOT, env=env())
        if (ROOT / "data/datasets/ood_manifest.csv").is_file():
            run([str(PY), "-u", "tools/ml/acceptance_tests.py"], cwd=ROOT, env=env())
        else:
            say("Dataset-based acceptance replay requires the optional OOD dataset. The bundled browser demo uses sample_videos/.")
        return
    ensure_node()
    if a.train:
        train()

    e = env()
    procs = []
    say(f"Starting API on :{PORTS['api']} and web app on :{PORTS['web']} ...")
    procs.append(subprocess.Popen([str(PY), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(PORTS["api"])], cwd=ROOT / "backend", env=e))
    if a.dev_console:
        procs.append(subprocess.Popen([str(PY), "backend/devdash/app.py"], cwd=ROOT, env={**e, "CTXTRACE_DEV_PORT": str(PORTS["dev"])}))
    procs.append(subprocess.Popen([NPM, "run", "dev", "--", "--port", str(PORTS["web"]), "--strictPort", "--clearScreen", "false"], cwd=ROOT, env=e))

    def stop(*_):
        say("Stopping ...")
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(8)
            except Exception:
                p.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)
    ok = wait(f"http://127.0.0.1:{PORTS['api']}/api/health") and wait(f"http://127.0.0.1:{PORTS['web']}")
    print()
    say("ContextTrace is running" if ok else "Some services did not respond yet - see the logs above")
    print(f"     Web app            http://localhost:{PORTS['web']}")
    if a.dev_console:
        print(f"     Developer console  http://localhost:{PORTS['dev']}")
    print(f"     API docs           http://localhost:{PORTS['api']}/docs")
    print("     Demo login         demo@contexttrace.app / DemoTrace@2026   (Ctrl+C to stop)\n")
    if ok and not a.no_browser:
        webbrowser.open(f"http://localhost:{PORTS['web']}")
    while True:
        for p in procs:
            if p.poll() is not None:
                say(f"A service exited (code {p.returncode}); shutting down.")
                stop()
        time.sleep(1)


if __name__ == "__main__":
    main()
