import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Loader2, ScanSearch } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { UploadSlot } from "@/components/UploadSlot";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export default function Detect() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const run = async () => {
    if (!file) return;
    setError(null);
    try {
      setBusy("Uploading…");
      const up = await api.videos.upload(file, "detect");
      setBusy("Starting analysis…");
      const job = await api.jobs.detect(up.videoId);
      navigate(`/result/${job.jobId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
      setBusy(null);
    }
  };

  return (
    <AppShell>
      <p className="meta-label">Service 1</p>
      <h1 className="display-lg mt-2 text-4xl">AI-generated video detection</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Upload one video. ContextTrace samples frames across the first 10 seconds, runs a CLIP vision backbone plus noise, spectrum and optical-flow forensics,
        and tells you how likely the video is AI-generated and how much of its timeline looks synthetic.
      </p>
      <div className="mt-8 grid gap-8 lg:grid-cols-[1.3fr_1fr]">
        <UploadSlot label="Video to analyse" file={file} onFile={setFile} disabled={!!busy} />
        <div className="flex flex-col justify-between gap-6 border bg-card p-6">
          <div className="space-y-3 text-sm">
            <p className="font-semibold">What you get</p>
            <ul className="space-y-2 text-muted-foreground">
              <li>• <b className="text-foreground">AI probability</b> — calibrated chance the clip is AI-generated</li>
              <li>• <b className="text-foreground">AI content share</b> — % of the timeline classified as synthetic (catches partial splices)</li>
              <li>• <b className="text-foreground">Frame timeline</b> — where in the video the AI evidence sits</li>
              <li>• <b className="text-foreground">Forensic reasons</b> — the measured signals behind the verdict</li>
            </ul>
          </div>
          {error && <p className="border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-3 py-2 text-sm text-[var(--trace-red)]">{error}</p>}
          <Button size="lg" className="h-12" disabled={!file || !!busy} onClick={run}>
            {busy ? <><Loader2 className="size-4 animate-spin" />{busy}</> : <><ScanSearch className="size-4" />Analyse video<ArrowRight className="size-4" /></>}
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
