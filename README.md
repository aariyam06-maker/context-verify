# ContextTrace

**AI-based source-vs-edit context analysis.** ContextTrace compares an
original/source video against an edited or short-form derivative and produces an
evidence-backed assessment of whether the editing materially changes the context
conveyed to viewers. It deliberately distinguishes an *observed edit* from its
*contextual impact*, and never treats ordinary editing as automatically malicious.

> **DEMO MODE — read this first**
> In **Compare** mode, real ASR (faster-whisper), embeddings (Sentence-Transformers),
> FAISS, OpenCLIP and PaddleOCR cannot execute inside this hosting environment's
> function runtime. The modality providers in this build are clearly-labelled
> deterministic **simulators**: they synthesize transcript/OCR evidence for the
> uploaded media, and every surface that shows analysis data says so. The
> alignment, edit-event detection, degradation handling and scoring logic run
> **for real** on that evidence.
>
> **AI-Scan and Mitigation run for real in your browser** — no simulation: the
> video is decoded locally, frames are measured pixel-by-pixel (canvas + typed
> arrays), and the mitigation output is a genuine re-encode through
> `MediaRecorder`. Files never leave your machine. Their limits are stated
> honestly in the UI and below.

---

## What version 1 does

Three capabilities, one workstation:

### 1. Compare — source vs. edited (async server pipeline)

Upload exactly two videos (Source + Edited). Client-side validation, then a
nine-stage background pipeline to an evidence-backed report: Context Integrity
Score, confidence, coverage, uncertainty, findings with timestamps, and a
synchronized dual timeline that seeks both players when you select a finding.
Completed reports persist in Analysis History.

### 2. AI-Scan — single video, real browser forensics (no source needed)

Works with **only the edited video** — no source comparison required. The video
is decoded locally and N frames are sampled across its duration; six forensic
components are measured per frame:

| Component | What it measures |
| --- | --- |
| Blockiness | 8×8 grid edge energy vs. off-grid (DCT blocking regularity) |
| Temporal flicker | Inter-frame luminance instability beyond motion expectation |
| Saturation deviation | Per-frame chroma distribution vs. natural-video norms |
| Texture uniformity | Local patch-variance homogeneity (over-smoothed texture) |
| Compression noise | High-frequency residual after blur separation |
| Spectral energy | Mid/high-frequency energy ratio (synthetic falloff) |

The result is an **AI-content likelihood percentage** (0–100), a per-component
breakdown, and timestamped findings — which component breached, at which frame
time, what fraction of frames breached. Honest limits, stated in the UI: this
measures generation/processing *artifacts*, not semantic "AI-ness"; scores are
forensic indicators with stated uncertainty, never proof.

### 3. Mitigation — tentative AI-trace removal + cleaned video

When the scan finds traces, the **Remove AI Traces** pass re-encodes the video
in real time (`canvas.captureStream` → `MediaRecorder`, VP9/Opus WebM) through
targeted passes chosen from the scan: block-edge denoise, temporal
stabilization (frame blending), micro-texture reinjection, chroma re-mapping,
spectral reshaping, plus an audio chain (highpass/lowpass/high-shelf/compressor)
that breaks synthetic speech signatures. The output is verified with a full
**post-scan** — before/after per-component deltas and the new AI score — and can
be **downloaded** as a WebM. Traces are reduced, not erased; the post-scan
verifies what actually changed, and if the score did not improve the job is
marked DEGRADED rather than claiming success.

### 4. Register / log in, dashboard, history, admin

Email OTP or guest session; the dashboard counts totals/completed/running/
degraded/failed across both modes; history reopens any report (scan rows route
to the workbench, compare rows to the report); the admin console (role-checked
server-side) lists users and all jobs.

## The pipeline

```
SOURCE + EDITED VIDEO
→ VALIDATE & PREPROCESS          (media_validation, preprocessing)
→ EXTRACT EVIDENCE               (speech_analysis, visual_evidence, ocr_evidence)
→ ALIGN SOURCE AND EDIT          (semantic_alignment)
→ DETECT EDIT EVENTS             (edit_detection)
→ ASSESS CONTEXTUAL IMPACT       (context_analysis)
→ GENERATE EVIDENCE-BACKED REPORT (report_generation)
```

Stages are executed as scheduled Convex actions (`src/convex/pipeline.ts`),
chained through the scheduler so long-running work never blocks a request or
freezes the UI. Each stage persists evidence into the database; the job row
carries `status` (QUEUED / RUNNING / DEGRADED / COMPLETED / FAILED),
`currentStage`, `progress`, and accumulated `warnings`.

### Detection logic and evidence integrity

* Speech alignment is the **primary** correspondence signal
  (`alignTranscripts`): greedy high-confidence anchors, then thresholded
  residual pairings.
* Edit events are detected from alignment structure: **Omission** (source
  statement absent from the edit), **Reordering** (non-monotonic mapping
  order), **Discontinuity** (adjacent edited statements mapping far apart in
  the source), **Splicing** (edited content with no source counterpart, flanked
  by matched content).
* A missing or non-contiguous mapping is only a **candidate** — weak or short
  segments, or low-confidence transcripts, never become findings
  ("no evidence pollution").
* Visual correspondence and OCR are supporting evidence only; no standalone
  visual/caption claim is ever emitted in v1. OCR/speech vocabulary mismatch is
  surfaced as a **warning**, not an event.
* Modality failure (e.g. missing audio track) marks the job **DEGRADED** and
  analysis continues on remaining evidence. A critical stage failure marks the
  job **FAILED** — and a failed job never renders a complete-looking report.

### Context Integrity Score

`score = 100 · (1 − Σ category_weight × severity_multiplier × confidence_multiplier)`

Weights: omission 0.35, splicing 0.22, reordering 0.18, discontinuity 0.12;
severity multipliers high 1.0 / medium 0.6 / low 0.3; each finding scaled by its
own confidence. The score is transparent and recomputed from persisted evidence
rows at report time. Every score is accompanied by overall confidence, evidence
coverage, uncertainty, and per-finding evidence.

## Architecture

```
src/
  convex/            Backend (Convex functions = server layer)
    schema.ts        Data model (users, videos, analysisJobs, transcriptSegments,
                     alignmentMappings, evidenceEvents, scanFindings, reports)
    engine.ts        Deterministic compare-mode engine (pure functions)
    pipeline.ts      Scheduled background pipeline (9 stages, compare mode)
    jobs.ts          Job queries/mutations (compare + scan + mitigation) + persistence
    videos.ts        Video registration + ownership-checked reads
    admin.ts         Role-protected review queries
    auth.ts / auth.config.ts / auth/emailOtp.ts   Convex Auth (email OTP, guest)
  components/        UI components (AppShell, FindingCard, EvidencePanel,
                     DualTimeline, ScoreCard, PipelineStepper, RequireAuth/Role)
  lib/
    ai-scan.ts       REAL browser forensics: frame sampling + 6-component analysis
    mitigation.ts    REAL re-encode pipeline: targeted passes + post-scan
    local-videos.ts  Client-side validation + IndexedDB artifact store
    trace.ts         Formatting, status/severity presentation, demo notice
  pages/             Landing, Auth, Dashboard, NewAnalysis (mode tabs),
                     ScanWorkbench, AnalysisProgress, AnalysisReport, History,
                     Admin, NotFound
```

**Layering:** React (SPA, react-router) → typed Convex client calls →
Convex queries/mutations/actions (authorization + persistence) → scheduled
actions (pipeline) → engine (pure functions). Real FFmpeg/faster-whisper/
Sentence-Transformers/FAISS/OpenCLIP/PaddleOCR implementations plug in behind
the modality-provider seam in `pipeline.ts`; only those providers are replaced,
the engine, data model and UI are unchanged.

**Storage:** video files are validated client-side and stored in the browser's
IndexedDB (`src/lib/local-videos.ts`) keyed by `storageKey`; metadata and
validation state persist server-side. This keeps blobs out of the database while
enabling the synchronized timeline replay for the owner's session.

## Running locally

Requirements: [Bun](https://bun.sh) ≥ 1.1, a Convex account (free tier works).

```bash
# 1. Install dependencies
bun install

# 2. Create/link a Convex deployment and write .env.local
bunx convex dev          # first run provisions; keep it running in a terminal

# 3. In a second terminal, start the app
bun run dev              # http://localhost:5173
```

Environment variables live in `.env.local` (see `.env.example`):
`VITE_CONVEX_URL` is created by `convex dev`; optional values enable extra
integrations.

### Database setup / migrations

The schema is deployed with the functions (`bunx convex dev --once` or
`bunx convex deploy`). Convex applies schema changes automatically; there is no
separate migration step. To push without watching:

```bash
bunx convex dev --once
```

### Making yourself an admin

The Admin console requires `role === "admin"`. Register normally, then promote
yourself from the [Convex dashboard](https://dashboard.convex.dev) → Data →
`users` → set `role: "admin"` (or run `npx convex run` with a small mutation).

### API surface

Convex functions replace the REST endpoints of the SRS 1:1 — same operations,
same ownership checks, typed client, reactive subscriptions:

| SRS REST endpoint              | Convex function                  |
| ------------------------------ | -------------------------------- |
| `POST /auth/register`·`login`  | Convex Auth (`email-otp`, `anonymous`) |
| `POST /videos/upload`          | `videos.register`                |
| `POST /analysis`               | `jobs.createJob` (compare)       |
| `POST /analysis` (single video)| `jobs.createScanJob` (AI-Scan)   |
| scan finalize                  | `jobs.finalizeScanReport`        |
| mitigation result              | `jobs.saveMitigationResult`      |
| `GET /analysis/{job_id}`       | `jobs.getJob` (reactive)         |
| `GET /analysis/{job_id}/status`| `jobs.getJob` (reactive)         |
| `GET /analysis/{job_id}/report`| `jobs.getReport`                 |
| `GET /analysis/{job_id}/evidence` | `jobs.getEvidence` + `jobs.getEvidenceDetail` |
| `GET /analysis/history`        | `jobs.listJobs`                  |
| `GET /reports/{report_id}`     | `jobs.getReport` (by job)        |
| admin console                  | `admin.adminOverview`            |

## Error handling

| Condition | Behaviour |
| --- | --- |
| Unsupported format / too large / empty | Rejected at upload with reason |
| Corrupt / undecodable media | Client probe fails; never registered |
| Missing audio track | Job continues, marked **DEGRADED**, warning shown |
| ASR / OCR / visual failure | Stage warning + DEGRADED status |
| Insufficient correspondence | Fewer findings; coverage/uncertainty reflect it |
| Critical stage failure | Job **FAILED** with message; no report rendered |
| Storage failure | Upload rejected; job input re-validated server-side |
| Authentication failure | Clear error; protected routes redirect to `/auth?returnTo=` |

Failures are never swallowed silently: they surface as job state, warnings, or
error states in the UI.

## Sample / demo data

The demo provider (`DEMO_SPEECH` in `src/convex/pipeline.ts`) models a quarterly
briefing: the edited version reorders two answers and omits the qualification
sentence — so a typical run produces an Omission, a Reordering and a
Discontinuity finding with real timestamps derived from your uploaded durations.
Any two valid video files exercise the full flow end-to-end.

## Backend accuracy & verification

The AI-Scan detector ships as one numerically identical engine in three
languages — browser JS (`src/lib/ai-model.ts`), Python
(`backend/python/features.py`) and Java (`backend/java/Verifier.java`) — kept in
conformance by the test suite, with a Bun gateway (`server/index.ts`) exposing
`/api/health`, `/api/score`, `/api/verify` and `/api/evaluate`. The trained
model measures **98.33% accuracy (AUC 0.9975) on a fresh holdout corpus** and
99.38% ± 1.25 cross-validated; details, honest scope limits, and retraining
instructions are in `backend/README.md`.

```bash
bun test          # conformance + digests + gateway + holdout accuracy E2E
bun tsc -b --noEmit
```

## Docs

* `.env.example` — environment configuration
* Convex dashboard — data browser, function logs, scheduler
* `src/convex/engine.ts` — detection/scoring logic, documented inline
