import { useEffect, useRef, useState } from "react";
import { FileVideo, UploadCloud, X } from "lucide-react";
import { cn } from "@/lib/utils";

const ACCEPT = ".mp4,.mov,.webm,.mkv,.avi,.m4v,video/*";
const MAX_MB = 500;

export function UploadSlot({ label, hint, file, onFile, disabled }: { label: string; hint?: string; file: File | null; onFile: (f: File | null) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const pick = (f?: File | null) => {
    setError(null);
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) { setError(`File is larger than ${MAX_MB} MB.`); return; }
    if (!/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name)) { setError("Unsupported format - use MP4, MOV, WebM, MKV, AVI or M4V."); return; }
    onFile(f);
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="meta-label">{label}</p>
      {file && url ? (
        <div className="relative border bg-card">
          <video src={url} controls muted playsInline className="aspect-video w-full bg-black object-contain" />
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <span className="meta-value inline-flex min-w-0 items-center gap-2 truncate"><FileVideo className="size-3.5 shrink-0" /><span className="truncate">{file.name}</span></span>
            <span className="meta-label shrink-0">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
            {!disabled && (
              <button type="button" aria-label="Remove video" onClick={() => onFile(null)} className="shrink-0 p-1 hover:bg-secondary"><X className="size-4" /></button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
          className={cn("flex aspect-video w-full flex-col items-center justify-center gap-3 border-2 border-dashed bg-card px-6 text-center transition-colors hover:border-foreground/60 hover:bg-secondary/60", drag && "border-[var(--trace-blue)] bg-[var(--trace-blue-soft)]")}
        >
          <UploadCloud className="size-8 text-muted-foreground" />
          <span className="text-sm font-semibold">Drop a video or click to browse</span>
          <span className="meta-label">{hint ?? "MP4 · MOV · WebM · AVI — first 10 s analysed"}</span>
        </button>
      )}
      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      {error && <p className="text-sm text-[var(--trace-red)]">{error}</p>}
    </div>
  );
}
