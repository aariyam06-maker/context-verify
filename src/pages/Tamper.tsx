import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeftRight, ArrowRight, Loader2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { UploadSlot } from "@/components/UploadSlot";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export default function Tamper() {
  const [a, setA] = useState<File | null>(null);
  const [b, setB] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const run = async () => {
    if (!a || !b) return;
    setError(null);
    try {
      setBusy("Uploading video A…");
      const ua = await api.videos.upload(a, "a");
      setBusy("Uploading video B…");
      const ub = await api.videos.upload(b, "b");
      setBusy("Starting comparison…");
      const job = await api.jobs.tamper(ua.videoId, ub.videoId);
      navigate(`/result/${job.jobId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
      setBusy(null);
    }
  };

  return (
    <AppShell>
      <p className="meta-label">Service 2</p>
      <h1 className="display-lg mt-2 text-4xl">Evidence tamper check</h1>
      <p className="mt-3 max-w-3xl text-muted-foreground">
        Upload two versions of the same evidence in any order. ContextTrace aligns them frame-by-frame, finds inserted, removed, re-ordered,
        sped-up and locally edited footage, runs AI detection on both, and declares which one is the original and which one was tampered with.
      </p>
      <div className="mt-8 grid items-start gap-6 md:grid-cols-[1fr_auto_1fr]">
        <UploadSlot label="Video A" file={a} onFile={setA} disabled={!!busy} />
        <div className="hidden h-full items-center justify-center md:flex"><ArrowLeftRight className="mt-8 size-6 text-muted-foreground" /></div>
        <UploadSlot label="Video B" file={b} onFile={setB} disabled={!!busy} />
      </div>
      {error && <p className="mt-6 border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-3 py-2 text-sm text-[var(--trace-red)]">{error}</p>}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border bg-card p-5">
        <p className="max-w-xl text-sm text-muted-foreground">You don't need to know which is which — the order is irrelevant. Both clips are analysed for AI generation and originality.</p>
        <Button size="lg" className="h-12 px-6" disabled={!a || !b || !!busy} onClick={run}>
          {busy ? <><Loader2 className="size-4 animate-spin" />{busy}</> : <>Compare videos<ArrowRight className="size-4" /></>}
        </Button>
      </div>
    </AppShell>
  );
}
