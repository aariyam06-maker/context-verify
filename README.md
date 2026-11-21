# ContextTrace v4

ContextTrace is a local video-forensics workstation. It classifies sampled video content as AI-like or camera-like, and compares two copies to estimate their relationship, relative direction and possible edits. The timeline shows sampled model scores. Pairwise results describe the supplied copies and cannot establish provenance.

## Run locally

Use Python 3.10+ and Node 20.19+ or 22.12+. From the repository root:

```powershell
python start.py --no-browser
```

Open http://localhost:3000. The API reference is at http://localhost:8000/docs. The launcher sets up dependencies, and the first analysis may download pretrained CLIP and DINOv2 weights. The fitted classifier checkpoints are included. Normal launch uses inference only. The built-in demo sign-in is intended for local use. Leave Gemini unset to keep frame processing local.

## Demo videos

| File | Try it in the app |
| --- | --- |
| [Road reference](sample_videos/real_baseline.mp4) | Submit under AI Detection for the camera-labelled example. |
| [Edited road copy](sample_videos/real_cut.mp4) | Compare it with the road reference. The controlled deletion is 2.000–3.000 s in reference time. |
| [Veo 3.1 example](sample_videos/veo3.1.mp4) | Submit under AI Detection for the publisher-labelled generated example. |

[Sources and video licences](sample_videos/README.md)

## Verify

```powershell
.venv/Scripts/python.exe -m pip install -r backend/requirements-dev.txt
.venv/Scripts/python.exe -m pytest -q
npm run build
```

The optional browser test exercises uploads, progress, results and report exports against a running app.

```powershell
.venv/Scripts/python.exe -m pip install -r backend/requirements-browser-test.txt
.venv/Scripts/python.exe -m playwright install chromium ffmpeg
.venv/Scripts/python.exe tools/testing/browser_verify.py --output demo --record
```

The last verification passed 23 automated tests and seven Chromium checks. Historical training used 935 source-labelled videos and 265 controlled edit pairs. The direction model's compatibility with the exact upstream classifier used during training remains unverified, and the historical evaluation set has already been examined.

## Layout

- `backend/` — FastAPI, video processing, model inference and report generation.
- `src/` — React interface, result timelines and playback.
- `data/models/` — fitted classifiers. Trust local checkpoint sources before loading joblib files.
- `sample_videos/` — three attributed clips for the demo.
- `tests/` and `tools/` — automated checks, browser demo, packaging and offline training tools.

The optional research console starts with `python start.py --dev-console`. Offline retraining is explicitly requested with `python start.py --train` and requires downloading the research datasets.
