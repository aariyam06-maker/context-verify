# ContextTrace

**AI-based source-vs-edit context analysis.** ContextTrace compares an
original/source video against an edited or short-form derivative and produces an
evidence-backed assessment of whether the editing materially changes the context
conveyed to viewers. It deliberately distinguishes an *observed edit* from its
*contextual impact*, and never treats ordinary editing as automatically malicious.

> **DEMO MODE — read this first**
> Real ASR (faster-whisper), embeddings (Sentence-Transformers), FAISS, OpenCLIP
> and PaddleOCR cannot execute inside this hosting environment's function
> runtime. The modality providers in this build are clearly-labelled
> deterministic **simulators**: they synthesize transcript/OCR evidence for the
> uploaded media, and every surface that shows analysis data says so. The
> alignment, edit-event detection, degradation handling and scoring logic run
> **for real** on that evidence. Nothing is presented as a real AI verdict —
> findings, timestamps, confidences and the Context Integrity Score derive from
> the deterministic engine (`src/convex/engine.ts`), not from fabricated output.

---

## What version 1 does

Scope (per the v1 spec): **upload two videos and follow job progress to a report**.

1. Register / log in (email OTP or guest session).
2. **New Analysis** — upload exactly two videos: Source + Edited. Each file is
   validated client-side (container, size, decodability, duration, audio track)
   before the analysis can start.
3. An asynchronous analysis job is created and walked through nine visible
   pipeline stages on the server, with live progress (percentage, current stage,
   elapsed time, job ID).
4. The completed **Analysis Report** shows the Context Integrity Score,
   overall confidence, evidence coverage, uncertainty, and every finding with
   source/edited timestamps, observed change vs. contextual impact.
5. Selecting a finding **seeks both synchronized video players** to the relevant
   timestamps; aligned intervals and event markers are drawn on both timelines.
6. Completed reports are stored in **Analysis History** and reopen without
   re-upload (video replay requires the same browser session, where the files
   are stored locally).
7. An **Admin / Review** console (role-protected, enforced server-side) lists
   users, all jobs, failures, degraded jobs and scores.

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
                     alignmentMappings, evidenceEvents, reports) + indexes
    engine.ts        Deterministic analysis engine (pure functions, testable)
    pipeline.ts      Scheduled background pipeline (9 stages)
    jobs.ts          Job queries/mutations + internal pipeline persistence
    videos.ts        Video registration + ownership-checked reads
    admin.ts         Role-protected review queries
    auth.ts / auth.config.ts / auth/emailOtp.ts   Convex Auth (email OTP, guest)
  components/        UI components (AppShell, FindingCard, EvidencePanel,
                     DualTimeline, ScoreCard, PipelineStepper, RequireAuth/Role)
  lib/
    engine.test-…    (see below)
    local-videos.ts  Client-side validation + IndexedDB artifact store
    trace.ts         Formatting, status/severity presentation, demo notice
  pages/             Landing, Auth, Dashboard, NewAnalysis, AnalysisProgress,
                     AnalysisReport, History, Admin, NotFound
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
| `POST /analysis`               | `jobs.createJob`                 |
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

## Docs

* `.env.example` — environment configuration
* Convex dashboard — data browser, function logs, scheduler
* `src/convex/engine.ts` — detection/scoring logic, documented inline
