# ContextTrace v4

**Is this video AI-generated? Which copy of the evidence was tampered with?**

ContextTrace runs two forensic services on your own machine. Models are trained on 935 videos from 12 public datasets and evaluated on sources they have never seen.

| Service | Input | Output |
|---|---|---|
| **1 · AI-generated video detection** | one video | calibrated AI probability, **AI content share** (% of timeline), per-frame timeline, forensic reasons |
| **2 · Evidence tamper check** | two videos (any order) | **which is original / which is tampered**, located edits (inserted, removed, re-ordered, in-frame, speed, re-encode), AI + originality analysis of both |

## Run it: one command

```bash
python start.py          # or double-click start.bat, or: npm start
```

The first run creates `.venv`, installs Python and npm dependencies, and trains the models if `data/models/*.joblib` are missing. It then starts three services:

| URL | What |
|---|---|
| http://localhost:3000 | web app |
| http://localhost:3751 | **developer console**: live runs, latency, CPU/RAM, animated inference graph, every accuracy/research chart, acceptance tests |
| http://localhost:8000/docs | REST API |

**Demo logins** (one-click buttons on the sign-in page):
- `demo@contexttrace.app` / `DemoTrace@2026` (analyst)
- `admin@contexttrace.app` / `AdminTrace@2026` (admin)

Other commands: `python start.py --train` (re-download data and retrain) · `python start.py --test` (pytest + acceptance tests) · `python tools/report/build_report.py` (regenerate the PDF).

Requirements: Python 3.10+ and Node 20+. No GPU, system FFmpeg or API key is needed.

## Documentation

**`ContextTrace_Project_Report.pdf`** (in this folder) covers:
- architecture and flow diagrams
- which code does what, and what each data folder holds
- datasets and bias controls
- all 25 model candidates and why the final one was chosen
- ROC, LOSO, LOGO, OOD, calibration, learning-curve and robustness evidence
- the tamper-model research
- acceptance tests on random clips
- limitations

## Optional: Gemini second opinion

Set `GEMINI_API_KEY` in `.env` (free tier). Four key-frames go to `gemini-2.5-flash`. Its answer is shown separately and blended at weight 0.25. The local model stays primary. This feature is off by default and was not evaluated, because no key was available.

## Layout

```
start.py / start.bat         one-command launcher
backend/app/api              auth (demo accounts), videos, jobs, admin
backend/app/ml               video_io, features, detector, tamper, tamper_service, tamper_synth, gemini
backend/app/services         job runner, per-job PDF
backend/devdash              developer console (:3751)
src/pages                    Landing, Auth, Dashboard, Detect, Tamper, Result, History, Admin
tools/datasets               reproducible dataset download (12 train sources + 6 OOD sources)
tools/ml                     features, training, baselines, pair synthesis, acceptance tests
tools/report                 builds ContextTrace_Project_Report.pdf
data/models                  trained models + all experiment records (JSON)
legacy/                      superseded v3 code (3-service pipeline), kept for reference
```

Outputs are calibrated forensic indicators, not legal proof.
