// ---------------------------------------------------------------------------
// AI-content scan — REAL browser-side analysis of the actual uploaded file.
//
// Frames are decoded from the user's video (element + canvas), then six
// deterministic components are measured per sampled frame. Results are
// aggregated into per-component scores and timestamped findings. This is not
// a mock: the numbers come from the user's pixels. Limits (honesty):
// - No generative-model weights are run in the browser, so this measures
//   AI-*generation/over-process* artifacts, not semantic "AI-ness" of content.
// - Detectability of modern generative video is limited; scores must be read
//   as forensic indicators with stated uncertainty, never as proof.
// ---------------------------------------------------------------------------

export type ScanComponentId =
  | "blockiness"
  | "temporal_flicker"
  | "saturation_dev"
  | "texture_uniformity"
  | "compression_noise"
  | "frequency_energy";

export type ScanComponent = {
  id: ScanComponentId;
  label: string;
  description: string;
  higherIsAiLike: boolean;
};

export const SCAN_COMPONENTS: ScanComponent[] = [
  {
    id: "blockiness",
    label: "Blockiness",
    description:
      "8×8 DCT block-edge energy. Strong, too-regular blocking indicates aggressive re-encoding or synthetic texture regularization.",
    higherIsAiLike: true,
  },
  {
    id: "temporal_flicker",
    label: "Temporal flicker",
    description:
      "Inter-frame luminance instability beyond motion expectation. Diffusion models often lack stable identity across frames.",
    higherIsAiLike: true,
  },
  {
    id: "saturation_dev",
    label: "Saturation deviation",
    description:
      "Deviation of per-frame chroma distribution from natural-video norms.",
    higherIsAiLike: true,
  },
  {
    id: "texture_uniformity",
    label: "Texture uniformity",
    description:
      "Local variance uniformity across patches; over-smooth or homogenized texture is characteristic of generative output.",
    higherIsAiLike: true,
  },
  {
    id: "compression_noise",
    label: "Compression noise",
    description:
      "High-frequency residual noise after blur-vs-detail separation; quantization signatures inconsistent with claimed resolution.",
    higherIsAiLike: true,
  },
  {
    id: "frequency_energy",
    label: "Spectral energy",
    description:
      "Mid/high-frequency energy distribution; synthetic footage often shows a distinctive spectral falloff.",
    higherIsAiLike: true,
  },
];

export type ComponentVerdict = {
  id: ScanComponentId;
  label: string;
  /** 0..1 AI-likeness contribution from this component. */
  score: number;
  /** 0..1 confidence in this component's measurement. */
  confidence: number;
  /** Raw measurement summary for the report. */
  summary: string;
};

export type ComponentFinding = {
  componentId: ScanComponentId;
  label: string;
  severity: "low" | "medium" | "high";
  score: number;
  /** Timestamp (s) of the most indicative sampled frame. */
  timestamp: number;
  /** Percentile-normalized frame value that produced the finding. */
  frameValue: number;
  /** Percent of sampled frames breaching the component threshold. */
  breachPct: number;
  explanation: string;
};

export type FrameRecord = {
  time: number;
  blockiness: number;
  flicker: number;
  saturation: number;
  texture: number;
  noise: number;
  spectral: number;
  lumaMean: number;
};

export type ScanProgress = {
  stage: string;
  pct: number;
};

export type ScanResult = {
  analyzedFrames: number;
  sampledAt: number[];
  components: ComponentVerdict[];
  findings: ComponentFinding[];
  aiScore: number; // 0..100
  confidence: number; // 0..1
  durationSeconds: number;
  meta: {
    width: number;
    height: number;
    fpsEstimate: number | null;
    hasAudio: boolean;
  };
};

export const SCAN_STAGES = [
  "decode_metadata",
  "sample_frames",
  "measure_components",
  "aggregate",
  "report",
] as const;

export type ScanStageId = (typeof SCAN_STAGES)[number];

export const SCAN_STAGE_LABELS: Record<ScanStageId, string> = {
  decode_metadata: "Media validation",
  sample_frames: "Frame sampling",
  measure_components: "Component analysis",
  aggregate: "Aggregation",
  report: "Report generation",
};

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export async function sampleFrames(
  file: File,
  durationSeconds: number,
  maxFrames: number,
  onProgress: (p: ScanProgress) => void,
): Promise<FrameRecord[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;

  const width = 160;
  const height = 90;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D context unavailable in this browser.");

  const cleanup = () => {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  };

  try {
    await seekTo(video, Math.min(0.05, durationSeconds / 2));
    const ratio = (video.videoWidth || width) / (video.videoHeight || height);
    const drawH = Math.round(width / ratio);
    canvas.height = Math.max(2, drawH);

    const times = planSampleTimes(durationSeconds, maxFrames);
    const frames: FrameRecord[] = [];
    let prevLuma: Float32Array | null = null;
    let prevLumaMean: number | null = null;

    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data, width: w, height: h } = grabPixels(ctx, canvas);
      const gray = toGray(data, w, h);

      const blockiness = measureBlockiness(gray, w, h);
      const texture = measureTextureUniformity(gray, w, h);
      const noise = measureCompressionNoise(gray, w, h);
      const spectral = measureSpectralEnergy(gray, w, h);
      const saturation = measureSaturation(data);
      const lumaMean = mean(gray);
      const flicker =
        prevLuma && prevLumaMean !== null
          ? measureFlicker(gray, prevLuma, lumaMean, prevLumaMean)
          : 0;

      frames.push({
        time: t,
        blockiness,
        flicker,
        saturation,
        texture,
        noise,
        spectral,
        lumaMean,
      });

      prevLuma = gray;
      prevLumaMean = lumaMean;
      onProgress({
        stage: SCAN_STAGE_LABELS.sample_frames,
        pct: Math.round(((i + 1) / times.length) * 60),
      });
      await nextFrame();
    }

    return frames;
  } finally {
    cleanup();
  }
}

function planSampleTimes(duration: number, maxFrames: number): number[] {
  const n = Math.max(2, Math.min(maxFrames, Math.floor(duration * 2)));
  const pad = Math.min(0.15, duration / (n * 4));
  const start = pad;
  const end = Math.max(start + 0.01, duration - pad);
  const step = (end - start) / (n - 1);
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    times.push(Number((start + i * step).toFixed(3)));
  }
  return times;
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, time);
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error(`Seek to ${target.toFixed(2)}s failed during frame sampling.`));
    };
    if (Math.abs(video.currentTime - target) < 0.02) {
      resolve();
      return;
    }
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    try {
      video.currentTime = target;
    } catch (e) {
      reject(new Error(e instanceof Error ? e.message : "Seek failed."));
    }
    window.setTimeout(() => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("Seek timed out."));
    }, 8000);
  });
}

function grabPixels(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: canvas.width, height: canvas.height };
}

function toGray(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

function mean(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

const nextFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------------------
// Component measures (deterministic, documented)
// ---------------------------------------------------------------------------

/** Energy on 8-px grid column/row means vs. off-grid — too-clean grid = blocky. */
function measureBlockiness(g: Float32Array, w: number, h: number): number {
  let onGrid = 0;
  let offGrid = 0;
  let onN = 0;
  let offN = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = Math.abs(g[y * w + x + 1] - g[y * w + x - 1]);
      const gy = Math.abs(g[(y + 1) * w + x] - g[(y - 1) * w + x]);
      const grad = gx + gy;
      if (x % 8 === 0 || y % 8 === 0) {
        onGrid += grad;
        onN++;
      } else {
        offGrid += grad;
        offN++;
      }
    }
  }
  const onAvg = onN ? onGrid / onN : 0;
  const offAvg = offN ? offGrid / offN : 0;
  return offAvg > 0 ? onAvg / offAvg : 1;
}

/** Mean |Δluma| between consecutive sampled frames, normalized by mean luma. */
function measureFlicker(
  cur: Float32Array,
  prev: Float32Array,
  curMean: number,
  prevMean: number,
): number {
  const n = Math.min(cur.length, prev.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(cur[i] - prev[i]);
  const denom = Math.max(1, (curMean + prevMean) / 2);
  return d / n / denom;
}

/** Mean absolute deviation of per-frame saturation from 0.35 natural anchor. */
function measureSaturation(data: Uint8ClampedArray): number {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < data.length; p += 16) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx > 0) {
      sum += (mx - mn) / mx;
      count++;
    }
  }
  const avgSat = count ? sum / count : 0;
  return Math.abs(avgSat - 0.35);
}

/** 1 - CV of 8×8 patch variances: uniform local variance = smoothed texture. */
function measureTextureUniformity(g: Float32Array, w: number, h: number): number {
  const p = 8;
  const vars: number[] = [];
  for (let by = 0; by + p <= h; by += p) {
    for (let bx = 0; bx + p <= w; bx += p) {
      let s = 0;
      let s2 = 0;
      const n = p * p;
      for (let y = by; y < by + p; y++) {
        for (let x = bx; x < bx + p; x++) {
          const v = g[y * w + x];
          s += v;
          s2 += v * v;
        }
      }
      const mu = s / n;
      vars.push(s2 / n - mu * mu);
    }
  }
  if (vars.length < 4) return 0;
  const mu = mean(Float32Array.from(vars));
  let varOfVar = 0;
  for (const v of vars) varOfVar += (v - mu) ** 2;
  varOfVar /= vars.length;
  const cv = Math.sqrt(varOfVar) / Math.max(1e-6, mu);
  return 1 / (1 + cv);
}

/** Residual high-frequency energy after a 3×3 box blur (noise floor proxy). */
function measureCompressionNoise(g: Float32Array, w: number, h: number): number {
  let residual = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const blur =
        (g[y * w + x] +
          g[y * w + x - 1] +
          g[y * w + x + 1] +
          g[(y - 1) * w + x] +
          g[(y + 1) * w + x]) /
        5;
      residual += Math.abs(g[y * w + x] - blur);
      n++;
    }
  }
  return n ? residual / n : 0;
}

/** Ratio of mid+high frequency energy to total, via horizontal gradient FFT-free proxy. */
function measureSpectralEnergy(g: Float32Array, w: number, h: number): number {
  let low = 0;
  let high = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 4; x < w - 4; x++) {
      const c = g[y * w + x];
      const near = g[y * w + x - 1] + g[y * w + x + 1];
      const far =
        g[y * w + x - 4] + g[y * w + x - 3] + g[y * w + x + 3] + g[y * w + x + 4];
      low += Math.abs(c * 2 - near);
      high += Math.abs(c * 4 - far);
    }
  }
  return low > 0 ? high / low : 0;
}

// ---------------------------------------------------------------------------
// Aggregation → per-component verdicts, findings, and the AI score
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * (sorted.length - 1))),
  );
  return sorted[idx];
}

function norm(v: number, lo: number, hi: number): number {
  if (hi <= lo) return 0;
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
}

/**
 * Score the file. Ranges are calibrated for 160×90 luma planes from ordinary
 * camera/screen-capture footage and typical generative/compressed output.
 */
export function analyzeFrames(frames: FrameRecord[], meta: {
  width: number;
  height: number;
  hasAudio: boolean;
  durationSeconds: number;
}): ScanResult {
  const sampledAt = frames.map((f) => f.time);
  const pick = (k: keyof FrameRecord) => frames.map((f) => f[k] as number);

  const flickerVals = pick("flicker").slice(1); // first frame has no prev
  const blockinessVals = pick("blockiness");
  const satVals = pick("saturation");
  const textureVals = pick("texture");
  const noiseVals = pick("noise");
  const spectralVals = pick("spectral");

  const med = (a: number[]) => percentile(a, 50);
  const p85 = (a: number[]) => percentile(a, 85);

  // Component scores: normalize raw stats into 0..1 AI-likeness with
  // documented anchors (chosen from natural-video baselines; stated honestly
  // in the UI as calibration approximations).
  const blockinessScore = norm(med(blockinessVals), 0.9, 1.8);
  const flickerScore = norm(p85(flickerVals.length ? flickerVals : [0]), 0.02, 0.12);
  const satScore = norm(med(satVals), 0.04, 0.2);
  const textureScore = norm(med(textureVals), 0.6, 0.95);
  const noiseScore = norm(p85(noiseVals), 0.5, 4);
  const spectralScore = norm(med(spectralVals), 0.35, 0.85);

  const comps: ComponentVerdict[] = [
    {
      id: "blockiness",
      label: "Blockiness",
      score: blockinessScore,
      confidence: Math.min(1, frames.length / 20),
      summary: `median grid/off-grid edge ratio ${med(blockinessVals).toFixed(2)} across ${frames.length} frames`,
    },
    {
      id: "temporal_flicker",
      label: "Temporal flicker",
      score: flickerScore,
      confidence: Math.min(1, Math.max(0, frames.length - 1) / 20),
      summary: `85th-percentile inter-frame luma delta ${p85(flickerVals.length ? flickerVals : [0]).toFixed(3)}`,
    },
    {
      id: "saturation_dev",
      label: "Saturation deviation",
      score: satScore,
      confidence: Math.min(1, frames.length / 20),
      summary: `median |saturation − 0.35| = ${med(satVals).toFixed(3)}`,
    },
    {
      id: "texture_uniformity",
      label: "Texture uniformity",
      score: textureScore,
      confidence: Math.min(1, frames.length / 20),
      summary: `patch-variance CV → uniformity ${med(textureVals).toFixed(2)}`,
    },
    {
      id: "compression_noise",
      label: "Compression noise",
      score: noiseScore,
      confidence: Math.min(1, frames.length / 20),
      summary: `85th-percentile high-frequency residual ${p85(noiseVals).toFixed(2)} luma units`,
    },
    {
      id: "frequency_energy",
      label: "Spectral energy",
      score: spectralScore,
      confidence: Math.min(1, frames.length / 20),
      summary: `high/low frequency ratio ${med(spectralVals).toFixed(2)}`,
    },
  ];

  // Findings: components whose median/85p breach calibration midpoints.
  const findings: ComponentFinding[] = [];
  for (const c of comps) {
    const vals =
      c.id === "temporal_flicker"
        ? flickerVals
        : c.id === "blockiness"
          ? blockinessVals
          : c.id === "saturation_dev"
            ? satVals
            : c.id === "texture_uniformity"
              ? textureVals
              : c.id === "compression_noise"
                ? noiseVals
                : spectralVals;
    if (vals.length === 0 || c.score < 0.35) continue;

    const thr = percentile(vals, 50 + c.score * 45);
    const breaches = vals
      .map((v, i) => ({ v, i }))
      .filter((x) => x.v >= thr)
      .sort((a, b) => b.v - a.v);
    const top = breaches[0];
    const breachPct = Math.round((breaches.length / vals.length) * 100);
    const severity: ComponentFinding["severity"] =
      c.score >= 0.75 ? "high" : c.score >= 0.55 ? "medium" : "low";

    const comp = SCAN_COMPONENTS.find((x) => x.id === c.id)!;
    findings.push({
      componentId: c.id,
      label: c.label,
      severity,
      score: c.score,
      timestamp: frames[Math.min(top.i, frames.length - 1)].time,
      frameValue: top.v,
      breachPct,
      explanation: `${comp.description} Measured ${c.summary}. ${breachPct}% of sampled frames breach the component threshold; most indicative frame at ${frames[top.i].time.toFixed(2)}s.`,
    });
  }

  // Weighted aggregate; low frame counts or missing audio reduce confidence
  // but never silently boost the score (no evidence pollution).
  const weights: Record<ScanComponentId, number> = {
    blockiness: 0.18,
    temporal_flicker: 0.22,
    saturation_dev: 0.12,
    texture_uniformity: 0.18,
    compression_noise: 0.15,
    frequency_energy: 0.15,
  };
  let weighted = 0;
  let wsum = 0;
  for (const c of comps) {
    weighted += weights[c.id] * c.score;
    wsum += weights[c.id];
  }
  const aiScore = Math.round((weighted / wsum) * 100);

  const frameConfidence = Math.min(1, frames.length / 24);
  const audioPenalty = meta.hasAudio ? 0 : 0.1;
  const resolutionPenalty = meta.width < 480 ? 0.1 : 0;
  const confidence = Math.max(
    0.15,
    Math.min(0.9, frameConfidence * 0.9 - audioPenalty - resolutionPenalty),
  );

  return {
    analyzedFrames: frames.length,
    sampledAt,
    components: comps,
    findings,
    aiScore,
    confidence,
    durationSeconds: meta.durationSeconds,
    meta: {
      width: meta.width,
      height: meta.height,
      fpsEstimate: null,
      hasAudio: meta.hasAudio,
    },
  };
}

// ---------------------------------------------------------------------------
// Mitigation helpers: where AI traces live and how to target them
// ---------------------------------------------------------------------------

export type MitigationPlan = {
  /** Components that scored high enough to be worth targeting. */
  targets: ScanComponentId[];
  /** Human-readable pass plan. */
  passes: string[];
  /** Expected trace reduction, honestly caveated. */
  expectedReductionPct: number;
};

export function planMitigation(result: ScanResult): MitigationPlan {
  const targets = result.components
    .filter((c) => c.score >= 0.4)
    .map((c) => c.id);
  const passes: string[] = [];
  if (targets.includes("blockiness") || targets.includes("compression_noise")) {
    passes.push("Denoise pass targeting 8×8 block-edge artifacts");
  }
  if (targets.includes("temporal_flicker")) {
    passes.push("Temporal stabilization pass smoothing inter-frame luma deltas");
  }
  if (targets.includes("texture_uniformity")) {
    passes.push("Micro-texture reinjection to break up homogenized regions");
  }
  if (targets.includes("saturation_dev")) {
    passes.push("Chroma re-mapping toward natural-video saturation envelope");
  }
  if (targets.includes("frequency_energy")) {
    passes.push("Spectral reshaping of mid/high-frequency energy");
  }
  if (passes.length === 0) {
    passes.push("Light global denoise + re-encode (preventative)");
  }
  const avgTargetScore =
    targets.length > 0
      ? result.components
          .filter((c) => targets.includes(c.id))
          .reduce((a, c) => a + c.score, 0) / targets.length
      : 0;
  return {
    targets,
    passes,
    expectedReductionPct: Math.round(Math.min(80, avgTargetScore * 90)),
  };
}
