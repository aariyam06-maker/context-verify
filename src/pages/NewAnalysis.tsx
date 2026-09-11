import { useCallback, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { AppShell } from "@/components/AppShell";
import { validateAndStore, type LocalValidationResult } from "@/lib/local-videos";
import { formatBytes, formatDuration, DEMO_NOTICE } from "@/lib/trace";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  FileVideo,
  Loader2,
  Upload,
  X,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { useNavigate } from "react-router";
import type { Id } from "@/convex/_generated/dataModel";

type Slot = "source" | "edited";

type SlotState =
  | { status: "empty" }
  | { status: "validating"; filename: string }
  | {
      status: "valid";
      videoId: Id<"videos">;
      storageKey: string;
      filename: string;
      byteSize: number;
      durationSeconds: number;
      width: number;
      height: number;
      hasAudio: boolean;
    }
  | { status: "invalid"; filename: string; error: string };

export default function NewAnalysis() {
  const navigate = useNavigate();
  const registerVideo = useMutation(api.videos.register);
  const createJob = useMutation(api.jobs.createJob);
  const [slots, setSlots] = useState<Record<Slot, SlotState>>({
    source: { status: "empty" },
    edited: { status: "empty" },
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dragSlot, setDragSlot] = useState<Slot | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  // Guards against a slow validation overwriting a newer upload in the same slot.
  const tokenRef = useRef<Record<Slot, number>>({ source: 0, edited: 0 });

  const setSlot = (slot: Slot, state: SlotState) =>
    setSlots((prev) => ({ ...prev, [slot]: state }));

  const handleFile = useCallback(
    async (slot: Slot, file: File) => {
      const token = ++tokenRef.current[slot];
      setSlot(slot, { status: "validating", filename: file.name });
      try {
        const result: LocalValidationResult = await validateAndStore(file);
        if (token !== tokenRef.current[slot]) return;
        if (!result.ok) {
          setSlot(slot, {
            status: "invalid",
            filename: file.name,
            error: result.error,
          });
          return;
        }
        const reg = await registerVideo({
          type: slot,
          filename: result.filename,
          mimeType: result.mimeType,
          byteSize: result.byteSize,
          durationSeconds: result.durationSeconds,
          width: result.width,
          height: result.height,
          hasAudio: result.hasAudio,
          storageKey: result.storageKey,
        });
        if (token !== tokenRef.current[slot]) return;
        if (!reg.ok) {
          setSlot(slot, {
            status: "invalid",
            filename: file.name,
            error: reg.reason,
          });
          return;
        }
        setSlot(slot, {
          status: "valid",
          videoId: reg.videoId,
          storageKey: result.storageKey,
          filename: result.filename,
          byteSize: result.byteSize,
          durationSeconds: result.durationSeconds,
          width: result.width,
          height: result.height,
          hasAudio: result.hasAudio,
        });
      } catch (e) {
        if (token !== tokenRef.current[slot]) return;
        setSlot(slot, {
          status: "invalid",
          filename: file.name,
          error:
            e instanceof Error
              ? e.message
              : "Validation failed. Try a different file.",
        });
      }
    },
    [registerVideo],
  );

  const bothValid =
    slots.source.status === "valid" && slots.edited.status === "valid";
  const readyCount =
    (slots.source.status === "valid" ? 1 : 0) +
    (slots.edited.status === "valid" ? 1 : 0);

  const missingReason = (slot: Slot): string | null => {
    const current = slots[slot];
    const label = slot === "source" ? "Source" : "Edited";
    if (current.status === "valid") return null;
    if (current.status === "validating")
      return `${label} video is still validating`;
    if (current.status === "invalid")
      return `Replace the invalid ${label.toLowerCase()} video`;
    return `${label} video required`;
  };

  const startAnalysis = async () => {
    setAttempted(true);
    if (!bothValid) {
      const problems = [
        missingReason("source"),
        missingReason("edited"),
      ].filter((p): p is string => p !== null);
      setGateMessage(
        problems.length === 2
          ? "Upload a source video and an edited video to start the analysis."
          : problems.join(" · "),
      );
      return;
    }
    setGateMessage(null);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const jobId = (await createJob({
        sourceVideoId: (slots.source as Extract<SlotState, { status: "valid" }>).videoId,
        editedVideoId: (slots.edited as Extract<SlotState, { status: "valid" }>).videoId,
      })) as Id<"analysisJobs">;
      navigate(`/analysis/${jobId}/progress`);
    } catch (e) {
      setSubmitError(
        e instanceof Error ? e.message : "Failed to create analysis job.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="meta-label">Step 1 of 2 · Upload</p>
          <h1 className="display-lg mt-2 text-4xl">New Analysis</h1>
        </div>
        <p className="meta-label max-w-xs leading-5 text-right">
          Exactly two videos: the original material and its edited derivative.
        </p>
      </div>

      <div className="mt-8 grid gap-px border bg-border lg:grid-cols-2">
        <UploadPanel
          slot="source"
          title="SOURCE VIDEO"
          subtitle="Original / source material"
          state={slots.source}
          dragging={dragSlot === "source"}
          onFile={(f) => void handleFile("source", f)}
          onDragStateChange={(dragging) => setDragSlot(dragging ? "source" : null)}
          onRemove={() => setSlot("source", { status: "empty" })}
          missing={attempted && slots.source.status !== "valid"}
        />
        <UploadPanel
          slot="edited"
          title="EDITED VIDEO"
          subtitle="Edited / short-form version"
          state={slots.edited}
          dragging={dragSlot === "edited"}
          onFile={(f) => void handleFile("edited", f)}
          onDragStateChange={(dragging) => setDragSlot(dragging ? "edited" : null)}
          onRemove={() => setSlot("edited", { status: "empty" })}
          missing={attempted && slots.edited.status !== "valid"}
        />
      </div>

      {/* Requirements strip */}
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border bg-secondary px-4 py-3">
        <span className="meta-label">Accepted: mp4 · mov · webm · mkv · avi · m4v</span>
        <span className="meta-label">Max 500 MB each</span>
        <span className="meta-label">
          <span className="text-foreground">{readyCount}/2</span> videos validated
        </span>
        <span className="meta-label">Analysis starts only when both files validate</span>
      </div>

      {gateMessage && !bothValid && (
        <p className="mt-4 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-4 py-3 text-sm font-medium text-[var(--trace-red)]">
          {gateMessage}
        </p>
      )}

      {submitError && (
        <p className="mt-4 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-4 py-3 text-sm text-[var(--trace-red)]">
          {submitError}
        </p>
      )}

      <div className="mt-8 flex items-center justify-between border-t pt-6">
        <p className="meta-value max-w-lg leading-5 text-muted-foreground">
          {DEMO_NOTICE}
        </p>
        <Button
          size="lg"
          className="h-12 px-8"
          disabled={submitting}
          onClick={() => void startAnalysis()}
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Creating job…
            </>
          ) : (
            <>
              Start Analysis <ArrowRight className="size-4" />
            </>
          )}
        </Button>
      </div>
    </AppShell>
  );
}

function UploadPanel({
  slot,
  title,
  subtitle,
  state,
  dragging,
  onFile,
  onDragStateChange,
  onRemove,
  missing,
}: {
  slot: Slot;
  title: string;
  subtitle: string;
  state: SlotState;
  dragging: boolean;
  onFile: (f: File) => void;
  onDragStateChange: (dragging: boolean) => void;
  onRemove: () => void;
  missing: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <section
      className={cn(
        "bg-card p-6 transition-colors",
        dragging && "bg-[var(--trace-blue-soft)]",
        missing && "ring-1 ring-inset ring-[var(--trace-red)]",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        onDragStateChange(true);
      }}
      onDragLeave={() => onDragStateChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDragStateChange(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <div className="flex items-center justify-between">
        <div>
          <p
            className={cn(
              "meta-label font-semibold",
              slot === "source" ? "text-[var(--trace-blue)]" : "text-[var(--trace-red)]",
            )}
          >
            {title}
          </p>
          <p className="text-sm font-medium tracking-tight text-muted-foreground">
            {subtitle}
          </p>
        </div>
        {state.status === "valid" && (
          <button
            type="button"
            onClick={onRemove}
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
          if (f) onFile(f);
          e.target.value = "";
        }}
      />

      {state.status === "empty" && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={cn(
            "mt-6 flex w-full flex-col items-center justify-center border border-dashed px-6 py-14 transition-colors hover:border-foreground/50 hover:bg-secondary",
            missing && "border-[var(--trace-red)]/60",
          )}
        >
          <Upload className="size-8 text-muted-foreground" strokeWidth={1.5} />
          <span className="mt-4 text-sm font-medium tracking-tight">
            Drop video here or click to browse
          </span>
          <span className="meta-label mt-1">Upload the {slot} video</span>
        </button>
      )}

      {state.status === "validating" && (
        <div className="mt-6 flex flex-col items-center justify-center border border-dashed px-6 py-14">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
          <span className="meta-label mt-4">Validating {state.filename}…</span>
        </div>
      )}

      {state.status === "invalid" && (
        <div className="mt-6">
          <div className="flex items-center justify-between border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-4 py-3">
            <div className="flex items-center gap-3">
              <AlertTriangle className="size-4 shrink-0 text-[var(--trace-red)]" />
              <div>
                <p className="meta-value text-foreground">{state.filename}</p>
                <p className="meta-value mt-0.5 text-[var(--trace-red)]">
                  {state.error}
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-3 flex w-full items-center justify-center border border-dashed px-6 py-10 transition-colors hover:border-foreground/50 hover:bg-secondary"
          >
            <span className="meta-label">Replace file</span>
          </button>
        </div>
      )}

      {state.status === "valid" && (
        <div className="mt-6">
          <div className="flex items-start gap-3 border p-4">
            <FileVideo className="mt-0.5 size-5 shrink-0 text-[var(--trace-blue)]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium tracking-tight" title={state.filename}>
                {state.filename}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="meta-label">
                  size <span className="text-foreground">{formatBytes(state.byteSize)}</span>
                </span>
                <span className="meta-label">
                  duration <span className="text-foreground">{formatDuration(state.durationSeconds)}</span>
                </span>
                {state.width > 0 && (
                  <span className="meta-label">
                    res <span className="text-foreground">{state.width}×{state.height}</span>
                  </span>
                )}
                <span className="meta-label">
                  audio{" "}
                  <span className={state.hasAudio ? "text-foreground" : "text-[var(--trace-red)]"}>
                    {state.hasAudio ? "present" : "missing"}
                  </span>
                </span>
              </div>
            </div>
            <CheckCircle2 className="size-5 shrink-0 text-[var(--trace-blue)]" />
          </div>
          <div className="mt-2 flex items-center justify-between border bg-secondary px-3 py-2">
            <span className="meta-label inline-flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-[var(--trace-blue)]" />
              validation passed
            </span>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="meta-label hover:underline"
            >
              Replace
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
