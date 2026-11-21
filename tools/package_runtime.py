"""Build a dataset-free runtime source ZIP using an explicit inclusion list.
Run npm run build first. Encoder caches and dependencies must be provisioned separately.
"""
import argparse, zipfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
ap = argparse.ArgumentParser(); ap.add_argument("--output", type=Path, default=ROOT / "dist/contexttrace-runtime.zip"); args=ap.parse_args()
files=[]
for folder in ("backend/app", "src", "public", "migrations"):
    files += [p for p in (ROOT/folder).rglob("*") if p.is_file() and "__pycache__" not in p.parts]
for name in ("start.py","start.bat","README.md",".env.example",".gitignore","package.json","package-lock.json","index.html","vite.config.ts","tsconfig.json","tsconfig.app.json","tsconfig.node.json","postcss.config.cjs","components.json","alembic.ini","backend/requirements.txt","backend/requirements-inference.txt","data/models/ai_detector.joblib","data/models/tamper_model.joblib"):
    p=ROOT/name
    if not p.exists(): raise SystemExit(f"Missing required runtime file: {name}")
    files.append(p)
for name in ("experiments.json", "tamper_experiments.json"):
    # Optional small UI metric records are not necessary for inference, and
    # may be absent in a clean checkout because research outputs are ignored.
    p = ROOT / "data/models" / name
    if p.exists():
        files.append(p)
args.output.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(args.output,"w",zipfile.ZIP_DEFLATED) as archive:
    for p in files: archive.write(p,p.relative_to(ROOT))
print(f"{args.output}: {len(files)} files; {args.output.stat().st_size} bytes (dependencies and encoder weights excluded)")
