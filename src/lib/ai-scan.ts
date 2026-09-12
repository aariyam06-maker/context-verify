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
  | "frequency_energy"
  | "glcm_contrast"
  | "edge_coherence"
  | "chroma_aberration"
  | "ringing";

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
  {
    id: "glcm_contrast",
    label: "GLCM texture contrast",
    description:
      "Gray-level co-occurrence contrast over quantized luma; homogenized synthetic texture concentrates the co-occurrence diagonal (low contrast) while natural texture spreads mass.",
    higherIsAiLike: true,
  },
  {
    id: "edge_coherence",
    label: "Edge orientation coherence",
    description:
      "Fraction of gradient energy aligned to a preferred axis; real scenes and structures contain coherent linear edges, isotropic synthetic patches less so.",
    higherIsAiLike: false,
  },
  {
    id: "chroma_aberration",
    label: "Chromatic aberration proxy",
    description:
      "High-frequency energy in (R−G) and (B−G) as a proxy for channel-edge structure; real lens chromatic fringing produces structured channel differences.",
    higherIsAiLike: true,
  },
  {
    id: "ringing",
    label: "Edge ringing proxy",
    description:
      "Overshoot/undershoot sign alternation near strong edges; re-encoding and some synthetic pipelines introduce ringing.",
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
  glcmContrast: number;
  edgeCoherence: number;
  chromaAberration: number;
  ringing: number;
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
    fpsEstimate?: number;
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
      const glcmContrast = glcmContrastOf(gray, w, h);
      const edgeCoherence = edgeOrientationCoherenceOf(gray, w, h);
      const chromaAberration = chromaticAberrationOf(data, w, h);
      const ringing = ringingProxyOf(gray, w, h);

      frames.push({
        time: t,
        blockiness,
        flicker,
        saturation,
        texture,
        noise,
        spectral,
        lumaMean,
        glcmContrast,
        edgeCoherence,
        chromaAberration,
        ringing,
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
// v2 image-processing additions — genuinely 2D spatial forensics
// ---------------------------------------------------------------------------

/** GLCM-style contrast over 16-level quantized luma, 4-connected neighbors. */
function glcmContrastOf(g: Float32Array, w: number, h: number, bins = 16): number {
  if (h < 4 || w < 4) return 0;
  const q = new Int32Array(w * h);
  for (let i = 0; i < g.length; i++) {
    let v = Math.floor((g[i] / 256) * bins);
    if (v < 0) v = 0;
    if (v >= bins) v = bins - 1;
    q[i] = v;
  }
  const hist = new Float32Array(bins * bins);
  const idx = (a: number, b: number) => a * bins + b;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w - 1; x++) {
      hist[idx(q[row + x], q[row + x + 1])]++;
    }
  }
  for (let y = 0; y < h - 1; y++) {
    const row = y * w;
    const rowN = (y + 1) * w;
    for (let x = 0; x < w; x++) {
      hist[idx(q[row + x], q[rowN + x])]++;
    }
  }
  let s = 0;
  for (let i = 0; i < hist.length; i++) s += hist[i];
  if (s <= 0) return 0;
  let contrast = 0;
  for (let a = 0; a < bins; a++) {
    for (let b = 0; b < bins; b++) {
      const p = hist[a * bins + b] / s;
      const d = a - b;
      contrast += d * d * p;
    }
  }
  return contrast / (bins * bins);
}

/** Ratio of aligned (axis/diagonal) gradient energy to total gradient energy. */
function edgeOrientationCoherenceOf(g: Float32Array, w: number, h: number): number {
  if (h < 3 || w < 3) return 0;
  let total = 0;
  let aligned = 0;
  for (let y = 0; y < h - 1; y++) {
    const row = y * w;
    const rowN = (y + 1) * w;
    for (let x = 0; x < w - 1; x++) {
      const gx = Math.abs(g[row + x + 1] - g[row + x]);
      const gy = Math.abs(g[rowN + x] - g[row + x]);
      total += gx + gy;
      aligned += Math.max(gx, gy);
    }
  }
  if (total <= 0) return 0;
  return aligned / (total + 1e-9);
}

/** High-frequency energy of (R-G) and (B-G) as a channel-edge structure proxy. */
function chromaticAberrationOf(data: Uint8ClampedArray, w: number, h: number): number {
  function hf(channel: (p: number) => number): number {
    let s = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w * 4 + x * 4;
        const c = channel(p);
        const left = channel(p - 4);
        const right = channel(p + 4);
        const up = channel(p - w * 4);
        const dn = channel(p + w * 4);
        const blur = (left + right + up + dn) / 4;
        s += Math.abs(c - blur);
        n++;
      }
    }
    return n ? s / n : 0;
  }
  const rg = (p: number) => data[p] - data[p + 1];
  const bg = (p: number) => data[p + 2] - data[p + 1];
  return (hf(rg) + hf(bg)) / 2;
}

/** Overshoot/undershoot ringing near strong edges. */
function ringingProxyOf(g: Float32Array, w: number, h: number): number {
  if (h < 5 || w < 5) return 0;
  let ring = 0;
  let cnt = 0;
  const maxSamples = 240;
  for (let y = 1; y < h - 3 && cnt < maxSamples; y++) {
    const row = y * w;
    for (let x = 1; x < w - 3 && cnt < maxSamples; x++) {
      const gx = Math.abs(g[row + x + 1] - g[row + x]);
      const gy = Math.abs(g[row + w + x] - g[row + x]);
      if (gx > 25 || gy > 25) {
        cnt++;
        if (x + 3 < w) {
          const b0 = g[row + x + 1];
          const b1 = g[row + x + 2];
          const b2 = g[row + x + 3];
          if (b0 < b1 && b1 > b2) ring++;
        }
        if (y + 3 < h) {
          const b0 = g[row + w + x];
          const b1 = g[row + 2 * w + x];
          const b2 = g[row + 3 * w + x];
          if (b0 < b1 && b1 > b2) ring++;
        }
      }
    }
  }
  return cnt > 0 ? ring / cnt : 0;
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
    {
      id: "glcm_contrast",
      label: "GLCM texture contrast",
      score: norm(med(pick("glcmContrast")), 0.9, 2.4),
      confidence: Math.min(1, frames.length / 20),
      summary: `median GLCM contrast ${med(pick("glcmContrast")).toFixed(2)}`,
    },
    {
      id: "edge_coherence",
      label: "Edge orientation coherence",
      score: 1 - norm(med(pick("edgeCoherence")), 0.45, 0.7),
      confidence: Math.min(1, frames.length / 20),
      summary: `median aligned/total gradient ratio ${med(pick("edgeCoherence")).toFixed(2)}`,
    },
    {
      id: "chroma_aberration",
      label: "Chromatic aberration proxy",
      score: norm(med(pick("chromaAberration")), 0.4, 2.2),
      confidence: Math.min(1, frames.length / 20),
      summary: `median (R−G)/(B−G) high-freq proxy ${med(pick("chromaAberration")).toFixed(2)}`,
    },
    {
      id: "ringing",
      label: "Edge ringing proxy",
      score: norm(med(pick("ringing")), 0.04, 0.28),
      confidence: Math.min(1, frames.length / 20),
      summary: `median strong-edge ringing rate ${med(pick("ringing")).toFixed(3)}`,
    },
  ];

  // Findings: components whose median/85p breach calibration midpoints.
  const findings: ComponentFinding[] = [];
  const valByComponent: Record<string, number[]> = {
    blockiness: blockinessVals,
    temporal_flicker: flickerVals,
    saturation_dev: satVals,
    texture_uniformity: textureVals,
    compression_noise: noiseVals,
    frequency_energy: spectralVals,
    glcm_contrast: pick("glcmContrast"),
    edge_coherence: pick("edgeCoherence"),
    chroma_aberration: pick("chromaAberration"),
    ringing: pick("ringing"),
  };
  for (const c of comps) {
    const vals = valByComponent[c.id] ?? [];
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

    const comp = SCAN_COMPONENTS.find((x) => x.id === c.id) ?? null;
    findings.push({
      componentId: c.id,
      label: c.label,
      severity,
      score: c.score,
      timestamp: frames[Math.min(top.i, frames.length - 1)].time,
      frameValue: top.v,
      breachPct,
      explanation: `${comp ? comp.description : ""} Measured ${c.summary}. ${breachPct}% of sampled frames breach the component threshold; most indicative frame at ${frames[top.i].time.toFixed(2)}s.`,
    });
  }

  // Weighted aggregate; low frame counts or missing audio reduce confidence
  // but never silently boost the score (no evidence pollution).
  // Weights are calibration explanations intended to be read alongside the
  // model reasoning panel, not a second classifier.
  const weights: Record<ScanComponentId, number> = {
    blockiness: 0.14,
    temporal_flicker: 0.20,
    saturation_dev: 0.10,
    texture_uniformity: 0.16,
    compression_noise: 0.14,
    frequency_energy: 0.14,
    glcm_contrast: 0.06,
    edge_coherence: 0.04,
    chroma_aberration: 0.04,
    ringing: 0.08,
  };
  let weighted = 0;
  let wsum = 0;
  for (const c of comps) {
    const w = weights[c.id] ?? 0;
    weighted += w * c.score;
    wsum += w;
  }
  const aiScore = Math.round((weighted / (wsum || 1)) * 100);

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
  if (targets.includes("texture_uniformity") || targets.includes("glcm_contrast")) {
    passes.push("Micro-texture reinjection to break up homogenized regions");
  }
  if (targets.includes("saturation_dev") || targets.includes("chroma_aberration")) {
    passes.push("Chroma re-mapping toward natural-video saturation envelope");
  }
  if (targets.includes("frequency_energy") || targets.includes("ringing")) {
    passes.push("Spectral/edge reshaping of mid/high-frequency energy and ringing");
  }
  if (targets.includes("edge_coherence")) {
    passes.push("Edge-structure pass to restore coherent linear gradients");
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
