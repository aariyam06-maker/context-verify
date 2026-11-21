"""Verify dataset-free deployment by running inference from an isolated archive."""
import argparse, hashlib, json, os, subprocess, sys, tempfile, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument("--video",type=Path,required=True);ap.add_argument("--archive",type=Path,default=ROOT/"dist/contexttrace-runtime.zip");args=ap.parse_args()
with tempfile.TemporaryDirectory(prefix="contexttrace-runtime-check-") as target:
    target=Path(target)
    with zipfile.ZipFile(args.archive) as archive:
        names=archive.namelist();archive.extractall(target)
    assert not any(name.startswith(("data/datasets/","data/features/","data/uploads/","legacy/","tools/","tests/")) for name in names)
    code="""import sys,json,time
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'backend'))
from app.ml import detector
assert not (Path.cwd()/'data/datasets').exists()
start=time.perf_counter();result=detector.analyze(Path(sys.argv[1]),use_gemini=False,mode='light')
print(json.dumps({'model_path':str(detector.MODEL_PATH),'seconds':time.perf_counter()-start,'verdict':result['verdict'],'aiProbability':result['aiProbability'],'frames':result['media']['framesAnalysed'],'dataset_directory_present':False}))
"""
    env={**os.environ,"HF_HUB_OFFLINE":"1","CUDA_VISIBLE_DEVICES":"","TOKENIZERS_PARALLELISM":"false"}
    run=subprocess.run([sys.executable,"-c",code,str(args.video.resolve())],cwd=target,env=env,capture_output=True,text=True,timeout=180)
    report={"archive_bytes":args.archive.stat().st_size,"archive_sha256":hashlib.sha256(args.archive.read_bytes()).hexdigest(),"file_count":len(names),"exit_code":run.returncode,"output":run.stdout.strip(),"error":run.stderr[-2000:] if run.returncode else None,"dependencies":"Existing Python environment and cached encoder weights supplied externally","input":"One explicit external uploaded/test clip, not a training directory"}
    print(json.dumps(report,indent=2))
    if run.returncode:sys.exit(run.returncode)
