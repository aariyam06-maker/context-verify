import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/AppShell";
import {
  SCAN_COMPONENTS,
  SCAN_STAGE_LABELS,
  sampleFrames,
  analyzeFrames,
  planMitigation,
  type ScanResult,
  type ScanProgress,
  type MitigationPlan,
} from "@/lib/ai-scan";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { runMitigation, type MitigationResult } from "@/lib/mitigation";
import {
  aiScoreBand,
  formatBytes,
  formatDuration,
  formatPercent,
  SEVERITY_CLASSES,
} from "@/lib/trace";
import { cn } from "@/lib/utils";
import { validateAndStore, getVideo, putVideo } from "@/lib/local-videos";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertTriangle,
  ArrowRight,
  Download,
  Eraser,
  FileVideo,
  Loader2,
  PlayCircle,
  RotateCcw,
  ScanLine,
  X,
} from "lucide-react";
import { useNavigate, useParams } from "react-router";

type Phase =
  | { kind: "idle" }
  | { kind: "scanning"; stage: string; pct: number }
  | { kind: "done" }
  | { kind: "mitigating"; stage: string; pct: number }
  | { kind: "mitigated" }
  | { kind: "error"; message: string };

export default function ScanWorkbench() {
  const { jobId: jobIdParam } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const registerVideo = useMutation(api.videos.register);
  const createScanJob = useMutation(api.jobs.createScanJob);
  const finalizeScanReport = useMutation(api.jobs.finalizeScanReport);
  const saveMitigationResult = useMutation(api.jobs.saveMitigationResult);

  const job = useQuery(
    api.jobs.getJob,
    jobIdParam ? { jobId: jobIdParam as Id<"analysisJobs"> } : "skip",
  );

  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<{
    filename: string;
    byteSize: number;
    durationSeconds: number;
    width: number;
    height: number;
    hasAudio: boolean;
  } | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [result, setResult] = useState<ScanResult | null>(null);
  const [mitigated, setMitigated] = useState<MitigationResult | null>(null);
  const [selectedFinding, setSelectedFinding] = useState<string | null>(null);
  const [storedVideoId, setStoredVideoId] = useState<Id<"videos"> | null>(null);
  const urlRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Rehydrate the file from IndexedDB when opening a saved job in this browser.
  useEffect(() => {
    if (!job) return;
    const key = job.sourceVideo?.storageKey;
    if (!key || file) return;
    void (async () => {
      const f = await getVideo(key);
      if (!f) return;
      setFile(f);
      setMeta({
        filename: f.name,
        byteSize: f.size,
        durationSeconds: job.sourceVideo?.durationSeconds ?? 0,
        width: 0,
        height: 0,
        hasAudio: job.sourceVideo?.hasAudio ?? true,
      });
    })();
  }, [job, file]);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const setFileAndUrl = (f: File | null) => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setFile(f);
    setVideoUrl(null);
    setMeta(null);
    setResult(null);
    setMitigated(null);
    setInvalid(null);
    setPhase({ kind: "idle" });
    setSelectedFinding(null);
    if (!f) return;
    const url = URL.createObjectURL(f);
    urlRef.current = url;
    setVideoUrl(url);
  };

  const handleFile = useCallback(
    async (f: File) => {
      setFileAndUrl(f);
      setPhase({ kind: "scanning", stage: "Validating media", pct: 1 });
      const res = await validateAndStore(f);
      if (!res.ok) {
        setInvalid(res.error);
        setPhase({ kind: "idle" });
        return;
      }
      setMeta({
        filename: res.filename,
        byteSize: res.byteSize,
        durationSeconds: res.durationSeconds,
        width: res.width,
        height: res.height,
        hasAudio: res.hasAudio,
      });
      setPhase({ kind: "idle" });
    },
    [],
  );

  const startScan = async () => {
    if (!file || !meta || meta.durationSeconds <= 0) return;
    setPhase({ kind: "scanning", stage: SCAN_STAGE_LABELS.decode_metadata, pct: 2 });

    // Ensure the video row + job exist server-side (new runs on this page).
    let videoId = storedVideoId;
    if (!videoId) {
      const reg = await registerVideo({
        type: "scan",
        filename: meta.filename,
        mimeType: file.type || "video/mp4",
        byteSize: meta.byteSize,
        durationSeconds: meta.durationSeconds,
        width: meta.width,
        height: meta.height,
        hasAudio: meta.hasAudio,
        storageKey: extractKey(file),
      });
      if (reg.ok) setStoredVideoId(reg.videoId);
      videoId = reg.ok ? reg.videoId : null;
    }

    let currentJobId = jobIdParam ? (jobIdParam as Id<"analysisJobs">) : null;
    if (!currentJobId && videoId) {
      currentJobId = (await createScanJob({ videoId })) as Id<"analysisJobs">;
      navigate(`/scan/${currentJobId}`, { replace: true });
    }
    if (!currentJobId) {
      setPhase({ kind: "error", message: "Could not register the video server-side." });
      return;
    }

    const warnings: string[] = [];
    let degraded = false;

    let frames;
    try {
      frames = await sampleFrames(file, meta.durationSeconds, 32, (p: ScanProgress) =>
        setPhase({ kind: "scanning", stage: p.stage, pct: p.pct }),
      );
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : "Frame sampling failed.",
      });
      return;
    }
    if (frames.length < 2) {
      setPhase({
        kind: "error",
        message:
          "Could not decode enough frames for analysis. The file may use an unsupported codec.",
      });
      return;
    }

    setPhase({ kind: "scanning", stage: SCAN_STAGE_LABELS.aggregate, pct: 82 });
    const scan = analyzeFrames(frames, {
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
      durationSeconds: meta.durationSeconds,
    });

    if (!meta.hasAudio) {
      warnings.push("No audio track present; audio-based components unmeasured.");
      degraded = true;
    }
    if (frames.length < 12) {
      warnings.push(`Only ${frames.length} frames sampled; confidence reduced.`);
      degraded = true;
    }

    setResult(scan);
    setSelectedFinding(scan.findings[0]?.componentId ?? null);
    setPhase({ kind: "done" });

    try {
      await finalizeScanReport({
        jobId: currentJobId,
        result: scan,
        degraded,
        warnings,
      });
    } catch {
      // Non-fatal: the report is still shown locally; server persistence failed.
      setPhase({ kind: "done" });
    }
  };

  const startMitigation = async () => {
    if (!file || !meta || !result) return;
    const plan: MitigationPlan = planMitigation(result);
    try {
      const out = await runMitigation({
        file,
        durationSeconds: meta.durationSeconds,
        plan,
        pre: result,
        onProgress: (p) => setPhase({ kind: "mitigating", stage: p.stage, pct: p.pct }),
      });
      setMitigated(out);
      setPhase({ kind: "mitigated" });

      const key = `ct_mit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      await putVideo(
        key,
        new File([out.blob], "cleaned-output.webm", {
          type: out.blob.type || "video/webm",
        }),
      );
      await saveMitigationResult({
        jobId: jobIdParam as Id<"analysisJobs">,
        aiBefore: out.aiBefore,
        aiAfter: out.aiAfter,
        passesApplied: out.passesApplied,
        outputStorageKey: key,
        outputByteSize: out.byteSize,
        outputDurationSeconds: out.durationSeconds,
        outputWidth: out.post.meta.width,
        outputHeight: out.post.meta.height,
        deltas: out.deltas,
      });
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : "Mitigation failed.",
      });
    }
  };

  const reset = () => {
    setStoredVideoId(null);
    setFileAndUrl(null);
  };

  const band = result ? aiScoreBand(result.aiScore) : null;
  const plan = result ? planMitigation(result) : null;

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="meta-label">Single-video mode · no source comparison</p>
          <h1 className="display-lg mt-2 text-4xl">AI Content Scan</h1>
        </div>
        <p className="meta-label max-w-xs leading-5 text-right">
          OCR, pixel and spectral forensics on the uploaded video — percentage,
          components, timestamps.
        </p>
      </div>

      {/* Upload / current file */}
      <section className="mt-8 border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="meta-label font-semibold text-[var(--trace-blue)]">
              SUBJECT VIDEO
            </p>
            <p className="text-sm font-medium tracking-tight text-muted-foreground">
              The video to examine for AI-generation artifacts
            </p>
          </div>
          {file && (
            <button
              type="button"
              onClick={reset}
              className="meta-label inline-flex items-center gap-1 border px-2 py-1 hover:bg-secondary"
            >
              <X className="size-3" /> Remove
            </button>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,video/x-m4v,.mp4,.mov,.webm,.mkv,.avi,.m4v"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />

        {!file && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-6 flex w-full flex-col items-center justify-center border border-dashed px-6 py-14 transition-colors hover:border-foreground/50 hover:bg-secondary"
          >
            <UploadIcon />
            <span className="mt-4 text-sm font-medium tracking-tight">
              Drop a video here or click to browse
            </span>
            <span className="meta-label mt-1">Scanned locally — the file never leaves your browser</span>
          </button>
        )}

        {file && (
          <div className="mt-6 grid gap-4 lg:grid-cols-[300px_1fr]">
            <div className="border bg-secondary/40 p-3">
              {videoUrl ? (
                <video
                  src={videoUrl}
                  controls
                  className="aspect-video w-full border bg-black"
                />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center border bg-secondary/60">
                  <FileVideo className="size-8 text-muted-foreground" />
                </div>
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium tracking-tight" title={file.name}>
                {file.name}
              </p>
              {meta ? (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="meta-label">size <span className="text-foreground">{formatBytes(meta.byteSize)}</span></span>
                  <span className="meta-label">duration <span className="text-foreground">{formatDuration(meta.durationSeconds)}</span></span>
                  {meta.width > 0 && (
                    <span className="meta-label">res <span className="text-foreground">{meta.width}×{meta.height}</span></span>
                  )}
                  <span className="meta-label">audio <span className={cn(meta.hasAudio ? "text-foreground" : "text-[var(--trace-red)]")}>{meta.hasAudio ? "present" : "missing"}</span></span>
                </div>
              ) : invalid ? (
                <div className="mt-3 flex items-center gap-2 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-3 py-2">
                  <AlertTriangle className="size-4 shrink-0 text-[var(--trace-red)]" />
                  <p className="meta-value text-[var(--trace-red)]">{invalid}</p>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <span className="meta-label">Validating…</span>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  onClick={() => void startScan()}
                  disabled={phase.kind === "scanning" || phase.kind === "mitigating" || !meta}
                >
                  {phase.kind === "scanning" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Scanning…
                    </>
                  ) : (
                    <>
                      <ScanLine className="size-4" /> Run AI Scan
                    </>
                  )}
                </Button>
                {result && (
                  <Button variant="outline" onClick={() => setFileAndUrl(null)}>
                    <RotateCcw className="size-4" /> New file
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Scan progress */}
      {phase.kind === "scanning" && (
        <section className="mt-6 border bg-card p-6">
          <div className="flex items-center justify-between">
            <p className="meta-label flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin" /> {phase.stage}
            </p>
            <span className="meta-value text-foreground tabular-nums">{phase.pct}%</span>
          </div>
          <div className="mt-3 h-2 w-full border bg-secondary">
            <div className="h-full bg-foreground transition-all" style={{ width: `${phase.pct}%` }} />
          </div>
        </section>
      )}

      {phase.kind === "error" && (
        <div className="mt-6 flex items-start gap-3 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--trace-red)]" />
          <div>
            <p className="meta-label text-[var(--trace-red)]">Scan failed</p>
            <p className="meta-value mt-1 leading-5 text-foreground/90">{phase.message}</p>
          </div>
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          <section className="mt-8 border bg-card">
            <div className="grid md:grid-cols-[280px_1fr]">
              <div className="border-b p-6 md:border-b-0 md:border-r">
                <p className="meta-label">AI Content Likelihood</p>
                <div className="mt-2 flex items-end gap-3">
                  <span className={cn("display-xl text-7xl font-bold leading-none tracking-tight", band?.className)}>
                    {result.aiScore}
                  </span>
                  <span className="meta-label pb-2">% AI-detected</span>
                </div>
                <p className={cn("meta-label mt-3", band?.className)}>{band?.label}</p>
                <div className="mt-4 h-2 w-full border">
                  <div
                    className={cn("h-full", result.aiScore >= 70 ? "bg-[var(--trace-red)]" : result.aiScore >= 45 ? "bg-[var(--trace-red)]/70" : "bg-[var(--trace-blue)]")}
                    style={{ width: `${result.aiScore}%` }}
                  />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-px border bg-border">
                  <div className="bg-card p-2.5">
                    <p className="meta-label">confidence</p>
                    <p className="meta-value mt-0.5 text-foreground">{formatPercent(result.confidence)}</p>
                  </div>
                  <div className="bg-card p-2.5">
                    <p className="meta-label">frames</p>
                    <p className="meta-value mt-0.5 text-foreground">{result.analyzedFrames}</p>
                  </div>
                </div>
              </div>
              <div className="p-6">
                <p className="meta-label">Component breakdown</p>
                <p className="text-xs text-muted-foreground">
                  Each component is normalized to 0..1 against documented calibration anchors (approximations from natural-video baselines). The weighted mean × 100 is the reported score.
                </p>
                <div className="mt-3 space-y-3">
                  {result.components.map((c) => (
                    <div key={c.id}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium tracking-tight">{c.label}</span>
                        <span className="meta-value tabular-nums text-muted-foreground">
                          {Math.round(c.score * 100)}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full bg-secondary">
                        <div
                          className={cn("h-full", c.score >= 0.55 ? "bg-[var(--trace-red)]" : c.score >= 0.35 ? "bg-[var(--trace-red)]/50" : "bg-[var(--trace-blue)]/60")}
                          style={{ width: `${Math.round(c.score * 100)}%` }}
                        />
                      </div>
                      <p className="meta-label mt-1 leading-4 text-muted-foreground">{c.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="border-t bg-secondary/60 px-4 py-2">
              <DiagnosticsPanel
                components={result.components.map((c) => ({
                  id: c.id,
                  label: c.label,
                  score: c.score,
                  confidence: c.confidence,
                  summary: c.summary,
                }))}
                aiScore={result.aiScore}
                confidence={result.confidence}
              />
            </div>
            <p className="border-t bg-secondary/60 px-4 py-2 meta-value text-muted-foreground">
              Measured from {result.analyzedFrames} decoded frames across {formatDuration(result.durationSeconds)} of footage. Artifact signatures indicate generation/processing traces — not proof of AI authorship.
            </p>
          </section>

          {/* Findings with timestamps */}
          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(300px,2fr)_3fr]">
            <section>
              <h2 className="text-sm font-semibold tracking-tight">
                Findings
                <span className="meta-label ml-2">{result.findings.length} components breached</span>
              </h2>
              <div className="mt-4 space-y-px border bg-border">
                {result.findings.length === 0 ? (
                  <div className="bg-card p-8 text-center">
                    <p className="meta-label">No breaches</p>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      No component cleared its calibrated threshold. This is not a
                      guarantee of authenticity — see confidence and uncertainty.
                    </p>
                  </div>
                ) : (
                  result.findings.map((f) => (
                    <button
                      key={f.componentId}
                      type="button"
                      onClick={() => setSelectedFinding(f.componentId)}
                      className={cn(
                        "block w-full bg-card p-4 text-left transition-colors hover:bg-secondary",
                        selectedFinding === f.componentId && "bg-secondary",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold tracking-tight">{f.label}</span>
                        <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold tracking-widest", SEVERITY_CLASSES[f.severity])}>
                          {f.severity.toUpperCase()}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                        <span className="meta-label">timestamp <span className="text-foreground">{formatDuration(f.timestamp)}</span></span>
                        <span className="meta-label">breach <span className="text-foreground">{f.breachPct}%</span> of frames</span>
                        <span className="meta-label">score <span className="text-foreground">{Math.round(f.score * 100)}%</span></span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="border bg-card p-6">
              {(() => {
                const sel = result.findings.find((f) => f.componentId === selectedFinding) ?? result.findings[0] ?? null;
                if (!sel) {
                  return (
                    <div className="py-10 text-center">
                      <p className="meta-label">Nothing selected</p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Findings with component detail appear here when detected.
                      </p>
                    </div>
                  );
                }
                const comp = SCAN_COMPONENTS.find((c) => c.id === sel.componentId);
                return (
                  <>
                    <p className="meta-label text-[var(--trace-red)]">{sel.severity.toUpperCase()} · {comp?.label ?? sel.label}</p>
                    <h3 className="display-lg mt-1 text-2xl">{sel.label}</h3>
                    <p className="mt-3 text-sm leading-6 text-foreground/90">{sel.explanation}</p>
                    <div className="mt-5 grid grid-cols-3 gap-px border bg-border">
                      <Cell label="Most indicative frame" value={formatDuration(sel.timestamp)} />
                      <Cell label="Frame value" value={sel.frameValue.toFixed(3)} />
                      <Cell label="Breach coverage" value={`${sel.breachPct}%`} />
                    </div>
                    {comp && (
                      <p className="meta-value mt-4 border-t pt-3 leading-5 text-muted-foreground">
                        Method: {comp.description}
                      </p>
                    )}
                  </>
                );
              })()}
            </section>
          </div>

          {/* Mitigation */}
          <section className="mt-8 border bg-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-xl">
                <p className="meta-label font-semibold text-[var(--trace-blue)]">
                  AI-TRACE MITIGATION
                </p>
                <h2 className="mt-1 text-lg font-bold tracking-tight">
                  Produce a tentative cleaned version
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Re-encodes the video through targeted passes against the
                  detected artifacts: {plan?.passes.join("; ").toLowerCase()}. Traces are reduced, not erased — the post-scan verifies what actually changed.
                </p>
                {plan && (
                  <p className="meta-label mt-2">
                    Expected trace reduction ≈ {plan.expectedReductionPct}%
                  </p>
                )}
              </div>
              {phase.kind !== "mitigated" && (
                <Button
                  size="lg"
                  onClick={() => void startMitigation()}
                  disabled={phase.kind === "scanning" || phase.kind === "mitigating"}
                >
                  {phase.kind === "mitigating" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Processing…
                    </>
                  ) : (
                    <>
                      <Eraser className="size-4" /> Remove AI Traces <ArrowRight className="size-4" />
                    </>
                  )}
                </Button>
              )}
            </div>

            {phase.kind === "mitigating" && (
              <div className="mt-6">
                <div className="flex items-center justify-between">
                  <p className="meta-label flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" /> {phase.stage}
                  </p>
                  <span className="meta-value tabular-nums text-foreground">{phase.pct}%</span>
                </div>
                <div className="mt-3 h-2 w-full border bg-secondary">
                  <div className="h-full bg-foreground transition-all" style={{ width: `${phase.pct}%` }} />
                </div>
                <p className="meta-label mt-2 text-muted-foreground">
                  Realtime re-encode — keep this tab visible until it completes.
                </p>
              </div>
            )}

            {mitigated && (
              <div className="mt-6 border-t pt-6">
                <div className="flex flex-wrap items-end gap-6">
                  <div>
                    <p className="meta-label">AI score</p>
                    <p className="mt-1 text-3xl font-bold tabular-nums">
                      {mitigated.aiBefore}
                      <span className="mx-2 text-muted-foreground">→</span>
                      <span className={cn(mitigated.aiAfter < mitigated.aiBefore ? "text-[var(--trace-blue)]" : "text-[var(--trace-red)]")}>
                        {mitigated.aiAfter}
                      </span>
                    </p>
                  </div>
                  <div>
                    <p className="meta-label">Output</p>
                    <p className="meta-value mt-1 text-foreground">
                      {formatBytes(mitigated.byteSize)} · {formatDuration(mitigated.durationSeconds)} · WebM re-encode
                    </p>
                  </div>
                  <a
                    href={mitigated.url}
                    download={mitigated.downloadName}
                    className="inline-flex h-10 items-center gap-2 border bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
                  >
                    <Download className="size-4" /> Download cleaned video
                  </a>
                </div>

                <div className="mt-5 grid gap-px border bg-border md:grid-cols-2">
                  {mitigated.deltas.map((d) => (
                    <div key={d.id} className="bg-card p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium tracking-tight">{d.label}</span>
                        <span className={cn("meta-value tabular-nums", d.changePct < 0 ? "text-[var(--trace-blue)]" : d.changePct > 0 ? "text-[var(--trace-red)]" : "text-muted-foreground")}>
                          {d.changePct > 0 ? "+" : ""}{d.changePct}%
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1.5 flex-1 bg-secondary">
                          <div className="h-full bg-[var(--trace-red)]/60" style={{ width: `${Math.round(d.before * 100)}%` }} />
                        </div>
                        <span className="meta-label">→</span>
                        <div className="h-1.5 flex-1 bg-secondary">
                          <div className="h-full bg-[var(--trace-blue)]" style={{ width: `${Math.round(d.after * 100)}%` }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="meta-label mt-3 leading-5 text-muted-foreground">
                  Red bar = before, blue bar = after. Passes applied: {mitigated.passesApplied.join("; ")}.
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card p-3">
      <p className="meta-label">{label}</p>
      <p className="meta-value mt-1 text-foreground">{value}</p>
    </div>
  );
}

function UploadIcon() {
  return <PlayCircle className="size-8 text-muted-foreground" strokeWidth={1.5} />;
}

// The validateAndStore result holds the IndexedDB key internally; for the scan
// flow we derive a stable key from the filename + size so rehydration works.
function extractKey(file: File): string {
  return `ct_scan_${file.name.replace(/[^a-z0-9]/gi, "_")}_${file.size}`;
}
