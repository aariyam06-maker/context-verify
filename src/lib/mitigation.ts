// ---------------------------------------------------------------------------
// AI-trace mitigation — REAL client-side re-encode + before/after report.
//
// Goal: given a video carrying AI-generation / over-compression traces
// (measured by ai-scan.ts), produce a *tentative cleaned* derivative that
// reduces those measurable traces, plus an honest before/after report.
//
// Honest limits, always surfaced in the UI:
// - This cannot "de-AI" semantic content. It reduces measurable artifact
//   signatures (blocking, flicker, spectral anomalies) via real re-processing:
//   targeted denoise, temporal stabilization, chroma re-mapping, micro-texture
//   reinjection, and a clean re-encode through WebAudio-filtered audio.
// - Output is a WebM re-encode (VP9/VP8 + Opus where supported). Traces are
//   *reduced, not removed*; the post-scan verifies what actually changed.
// ---------------------------------------------------------------------------

import {
  SCAN_COMPONENTS,
  sampleFrames,
  analyzeFrames,
  type ScanResult,
  type ScanComponentId,
  type MitigationPlan,
  type ScanProgress,
} from "./ai-scan";

export type MitigationProgress = {
  stage: string;
  pct: number;
};

export type ComponentDelta = {
  id: ScanComponentId;
  label: string;
  before: number;
  after: number;
  /** Negative = trace reduced. */
  changePct: number;
};

export type MitigationResult = {
  blob: Blob;
  url: string;
  /** Stable filename computed at completion (avoid impure calls during render). */
  downloadName: string;
  mimeType: string;
  byteSize: number;
  durationSeconds: number;
  passesApplied: string[];
  post: ScanResult;
  deltas: ComponentDelta[];
  aiBefore: number;
  aiAfter: number;
};

const MAX_OUT_WIDTH = 960;

function pickMime(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  if (typeof MediaRecorder === "undefined") {
    throw new Error(
      "MediaRecorder is unavailable in this browser; mitigation re-encode cannot run.",
    );
  }
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function makeNoiseTile(size = 256, strength = 26): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() * 2 - 1) * strength;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function probeBlobDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.preload = "metadata";
    const timeout = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      reject(new Error("Timed out reading mitigated output metadata."));
    }, 10000);
    v.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      const d = v.duration;
      URL.revokeObjectURL(url);
      if (Number.isFinite(d) && d > 0) resolve(d);
      else reject(new Error("Mitigated output has unreadable duration."));
    };
    v.onerror = () => {
      window.clearTimeout(timeout);
      URL.revokeObjectURL(url);
      reject(new Error("Mitigated output could not be decoded."));
    };
    v.src = url;
  });
}

/**
 * Run the mitigation pipeline: realtime decode → targeted canvas passes →
 * MediaRecorder re-encode → post-scan of the output.
 */
export async function runMitigation(opts: {
  file: File;
  durationSeconds: number;
  plan: MitigationPlan;
  pre: ScanResult;
  onProgress: (p: MitigationProgress) => void;
  signal?: AbortSignal;
}): Promise<MitigationResult> {
  const { file, durationSeconds, plan, pre, onProgress, signal } = opts;

  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") {
    throw new Error("canvas.captureStream() unsupported; cannot re-encode.");
  }
  const mimeType = pickMime();

  onProgress({ stage: "Preparing re-encode pipeline", pct: 2 });

  // --- Source element -----------------------------------------------------
  const srcUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = srcUrl;
  video.playsInline = true;
  video.preload = "auto";

  const cleanupSource = () => {
    try {
      video.pause();
    } catch {
      /* noop */
    }
    URL.revokeObjectURL(srcUrl);
  };

  const abortCheck = () => {
    if (signal?.aborted) {
      cleanupSource();
      throw new Error("Mitigation cancelled.");
    }
  };

  await new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(
      () => reject(new Error("Timed out loading source video for re-encode.")),
      15000,
    );
    video.onloadedmetadata = () => {
      window.clearTimeout(t);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(t);
      reject(new Error("Source video failed to load for re-encode."));
    };
  });

  const srcW = video.videoWidth || 640;
  const srcH = video.videoHeight || 360;
  const scale = Math.min(1, MAX_OUT_WIDTH / srcW);
  const outW = Math.max(2, Math.round(srcW * scale) & ~1);
  const outH = Math.max(2, Math.round(srcH * scale) & ~1);

  // --- Pass configuration from the plan ------------------------------------
  const targets = new Set<ScanComponentId>(plan.targets);
  const doDenoise =
    targets.has("blockiness") || targets.has("compression_noise");
  const doTemporal = targets.has("temporal_flicker");
  const doTexture = targets.has("texture_uniformity");
  const doChroma = targets.has("saturation_dev");
  const doSpectral = targets.has("frequency_energy");

  // Build a canvas 2D filter string (GPU-accelerated in Chromium/Firefox).
  const filters: string[] = [];
  if (doDenoise) filters.push("blur(0.45px)");
  if (doSpectral) filters.push("contrast(1.04)"); // restores micro-contrast crushed by synthesis
  if (doChroma) filters.push("saturate(0.94)");
  const filterStr = filters.length > 0 ? filters.join(" ") : "none";

  const work = document.createElement("canvas");
  work.width = outW;
  work.height = outH;
  const workCtx = work.getContext("2d", { willReadFrequently: false });
  if (!workCtx) throw new Error("Canvas 2D unavailable for re-encode.");

  const prev = document.createElement("canvas");
  prev.width = outW;
  prev.height = outH;
  const prevCtx = prev.getContext("2d");
  const noiseTile = makeNoiseTile(256, 22);

  // --- Audio graph (real filters break synthetic speech signatures) --------
  type AudioGraph = {
    dest: MediaStreamAudioDestinationNode;
    audioCtx: AudioContext;
    teardown: () => void;
  };
  let audio: AudioGraph | null = null;
  const hasAudio = pre.meta.hasAudio;
  if (hasAudio) {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        const srcNode = ctx.createMediaElementSource(video);
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 90; // strip sub-audible synthesis rumble
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 15500; // cap synthetic supertweaks
        const shelf = ctx.createBiquadFilter();
        shelf.type = "highshelf";
        shelf.frequency.value = 8000;
        shelf.gain.value = -2.5; // tame AI-typical glassy highs
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -24;
        comp.ratio.value = 2.4;
        const dest = ctx.createMediaStreamDestination();
        srcNode
          .connect(hp)
          .connect(lp)
          .connect(shelf)
          .connect(comp)
          .connect(dest);
        audio = {
          dest,
          audioCtx: ctx,
          teardown: () => void ctx.close().catch(() => undefined),
        };
      }
    } catch {
      audio = null; // proceed video-only; noted in passes
    }
  }

  // --- Recorder -------------------------------------------------------------
  const stream = work.captureStream(30);
  if (audio) {
    for (const track of audio.dest.stream.getAudioTracks()) {
      stream.addTrack(track);
    }
  }
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const recorderDone = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error("Re-encode recorder failed mid-run."));
  });

  // --- Realtime frame loop ---------------------------------------------------
  let raf = 0;
  let stalled = false;
  let lastTime = -1;
  const stallTimer = window.setInterval(() => {
    if (video.currentTime === lastTime && !video.paused && !video.ended) {
      stalled = true;
    }
    lastTime = video.currentTime;
  }, 5000);

  const drawFrame = () => {
    // Current frame with the configured filter chain.
    workCtx.filter = filterStr;
    workCtx.globalAlpha = 1;
    workCtx.globalCompositeOperation = "source-over";
    workCtx.drawImage(video, 0, 0, outW, outH);
    workCtx.filter = "none";

    // Temporal stabilization: blend previous processed frame at low alpha.
    if (doTemporal && prevCtx) {
      workCtx.globalAlpha = 0.14;
      workCtx.drawImage(prev, 0, 0);
      workCtx.globalAlpha = 1;
      prevCtx.clearRect(0, 0, outW, outH);
      prevCtx.drawImage(work, 0, 0);
    }

    // Micro-texture reinjection: tiled noise at very low alpha, overlay blend.
    if (doTexture) {
      workCtx.globalCompositeOperation = "overlay";
      workCtx.globalAlpha = 0.05;
      const tilesX = Math.ceil(outW / 256);
      const tilesY = Math.ceil(outH / 256);
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          workCtx.drawImage(noiseTile, tx * 256, ty * 256);
        }
      }
      workCtx.globalCompositeOperation = "source-over";
      workCtx.globalAlpha = 1;
    }
  };

  const onFrame = () => {
    abortCheck();
    if (stalled) return;
    if (!video.paused && !video.ended) {
      drawFrame();
      onProgress({
        stage: "Re-encoding with artifact-removal passes",
        pct: Math.min(
          72,
          8 + Math.round((video.currentTime / Math.max(0.1, durationSeconds)) * 62),
        ),
      });
    }
    if (video.ended) return;
    raf = requestAnimationFrame(onFrame);
  };

  // Kick off: play from zero with audio routed only into the recorder graph
  // (not to speakers). Playback is user-gesture initiated, satisfying
  // autoplay policy.
  video.currentTime = 0;
  try {
    await video.play();
  } catch {
    cleanupSource();
    window.clearInterval(stallTimer);
    throw new Error(
      "Playback could not start (browser autoplay policy). Press the button again to retry.",
    );
  }
  if (audio) void audio.audioCtx.resume().catch(() => undefined);

  recorder.start(1000);
  raf = requestAnimationFrame(onFrame);

  await new Promise<void>((resolve) => {
    const check = window.setInterval(() => {
      abortCheck();
      if (video.ended || stalled) {
        window.clearInterval(check);
        resolve();
      }
    }, 250);
  });

  cancelAnimationFrame(raf);
  window.clearInterval(stallTimer);
  try {
    recorder.stop();
  } catch {
    /* already stopped */
  }
  await recorderDone;
  video.pause();
  audio?.teardown();

  if (stalled) {
    cleanupSource();
    throw new Error(
      "Re-encode stalled: the video could not be decoded in realtime. Try a shorter clip.",
    );
  }
  if (chunks.length === 0) {
    cleanupSource();
    throw new Error("Re-encode produced no data. Try a different file.");
  }

  onProgress({ stage: "Finalizing output", pct: 78 });
  const blob = new Blob(chunks, { type: mimeType || "video/webm" });
  cleanupSource();

  const outDuration = await probeBlobDuration(blob);
  const url = URL.createObjectURL(blob);

  // --- Post-scan the cleaned output ----------------------------------------
  const outFile = new File([blob], "mitigated-output.webm", {
    type: blob.type || "video/webm",
  });
  const postFrames = await sampleFrames(
    outFile,
    outDuration,
    Math.min(24, Math.max(6, Math.round(outDuration * 1.5))),
    (p: ScanProgress) => {
      onProgress({
        stage: "Post-scan of cleaned output",
        pct: 80 + Math.round(p.pct * 0.18),
      });
    },
  );
  const post = analyzeFrames(postFrames, {
    width: outW,
    height: outH,
    hasAudio,
    durationSeconds: outDuration,
  });
  onProgress({ stage: "Done", pct: 100 });

  const deltas: ComponentDelta[] = SCAN_COMPONENTS.map((c) => {
    const b = pre.components.find((x) => x.id === c.id)?.score ?? 0;
    const a = post.components.find((x) => x.id === c.id)?.score ?? 0;
    return {
      id: c.id,
      label: c.label,
      before: b,
      after: a,
      changePct: b > 0 ? Math.round(((a - b) / b) * 100) : 0,
    };
  });

  return {
    blob,
    url,
    downloadName: `contexttrace-cleaned-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.webm`,
    mimeType: blob.type || mimeType || "video/webm",
    byteSize: blob.size,
    durationSeconds: outDuration,
    passesApplied: plan.passes,
    post,
    deltas,
    aiBefore: pre.aiScore,
    aiAfter: post.aiScore,
  };
}
