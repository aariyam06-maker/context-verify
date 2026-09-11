// ---------------------------------------------------------------------------
// ContextTrace AI-model — JS port of the Python reference pipeline.
//
// FEATURE PARITY CONTRACT: every function here is numerically identical to
// backend/python/features.py (frame features) and backend/python/corpus.py
// (clip aggregation), and backend/java/Verifier.java (scoring). The bun test
// suite (tests/backend.test.ts) enforces agreement to 1e-9 across all three
// languages on shared fixtures, and the gateway exposes /api/verify for
// runtime 2-of-3 consensus.
// ---------------------------------------------------------------------------

import { CTXTRACE_MODEL, type CtxtraceModel } from "../model/ctxtrace-model.generated";

export { CTXTRACE_MODEL };

export type FrameFeatures16 = number[]; // fixed order, see FRAME_FEATURE_NAMES

export const FRAME_FEATURE_NAMES = [
  "blockiness",
  "temporal_flicker",
  "saturation_dev",
  "texture_uniformity",
  "compression_noise",
  "frequency_energy",
  "blockiness_std",
  "texture_cv",
  "luma_mean",
  "luma_std",
  "high_freq_ratio",
  "entropy",
  "noise_luma_corr",
  "blocking_anisotropy",
  "residual_kurtosis",
  "temporal_whiteness",
] as const;

export const CLIP_FEATURE_NAMES = [
  ...FRAME_FEATURE_NAMES,
  "layout_persistence",
  "flicker_consistency",
  "noise_coupling",
] as const;

const SAT_ANCHOR = 0.35;

// ---------------------------------------------------------------------------
// Frame feature extraction (RGB plane -> 16 features)
// Mirrors extract_frame_features() in backend/python/features.py.
// ---------------------------------------------------------------------------

export function extractFrameFeatures(
  rgb: ArrayLike<number>, // RGBA, length = w*h*4 (ImageData.data or float fixtures)
  w: number,
  h: number,
  prevGray: Float64Array | null,
): { features: FrameFeatures16; gray: Float64Array } {
  const n = w * h;
  const g = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    g[i] = 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
  }

  const blockiness = blockinessOf(g, w, h);
  const flicker = prevGray ? temporalFlicker(g, prevGray) : 0;
  const saturationDev = saturationDevOf(rgb, w, h);
  const [uniformity, textureCv] = textureStats(g, w, h);
  const noise = compressionNoiseOf(g, w, h);
  const spectral = spectralEnergyOf(g, w, h);
  const bstd = blockinessStdOf(g, w, h);
  let lumaMean = 0;
  for (let i = 0; i < n; i++) lumaMean += g[i];
  lumaMean /= n;
  let lumaVar = 0;
  for (let i = 0; i < n; i++) lumaVar += (g[i] - lumaMean) ** 2;
  const lumaStd = Math.sqrt(lumaVar / n);
  const hfr = highFreqRatioOf(g, w, h);
  const entropy = entropyOf(g);
  const noiseLuma = noiseLumaCorrOf(g, w, h);
  const anisotropy = blockingAnisotropyOf(g, w, h);
  const kurt = residualKurtosisOf(g, w, h);
  const whiteness = prevGray ? temporalWhitenessOf(g, prevGray, w, h) : 0;

  return {
    features: [
      blockiness,
      flicker,
      saturationDev,
      uniformity,
      noise,
      spectral,
      bstd,
      textureCv,
      lumaMean,
      lumaStd,
      hfr,
      entropy,
      noiseLuma,
      anisotropy,
      kurt,
      whiteness,
    ],
    gray: g,
  };
}

function blockinessOf(g: Float64Array, w: number, h: number): number {
  let onGrid = 0,
    offGrid = 0,
    onN = 0,
    offN = 0;
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

function temporalFlicker(cur: Float64Array, prev: Float64Array): number {
  const n = Math.min(cur.length, prev.length);
  if (n === 0) return 0;
  let d = 0,
    curSum = 0,
    prevSum = 0;
  for (let i = 0; i < n; i++) {
    d += Math.abs(cur[i] - prev[i]);
    curSum += cur[i];
    prevSum += prev[i];
  }
  const denom = Math.max(1, (curSum / n + prevSum / n) / 2);
  return d / n / denom;
}

function saturationDevOf(rgb: Uint8ClampedArray, w: number, h: number): number {
  // Python subsamples [::4, ::4] (every 4th row/col); JS stride 16 bytes = 4 px
  // within a row, plus every 4th row.
  let sum = 0,
    count = 0;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const p = (y * w + x) * 4;
      const r = rgb[p],
        gg = rgb[p + 1],
        b = rgb[p + 2];
      const mx = Math.max(r, gg, b);
      const mn = Math.min(r, gg, b);
      if (mx > 0) {
        sum += (mx - mn) / mx;
        count++;
      }
    }
  }
  const avgSat = count ? sum / count : 0;
  return Math.abs(avgSat - SAT_ANCHOR);
}

function textureStats(g: Float64Array, w: number, h: number): [number, number] {
  const p = 8;
  const vars: number[] = [];
  for (let by = 0; by + p <= h; by += p) {
    for (let bx = 0; bx + p <= w; bx += p) {
      let s = 0,
        s2 = 0;
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
  if (vars.length < 4) return [0, 0];
  let mu = 0;
  for (const v of vars) mu += v;
  mu /= vars.length;
  let vv = 0;
  for (const v of vars) vv += (v - mu) ** 2;
  vv /= vars.length;
  const cv = Math.sqrt(vv) / Math.max(1e-6, mu);
  return [1 / (1 + cv), cv];
}

function compressionNoiseOf(g: Float64Array, w: number, h: number): number {
  if (h < 3 || w < 3) return 0;
  let residual = 0,
    n = 0;
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

function spectralEnergyOf(g: Float64Array, w: number, h: number): number {
  if (w < 9) return 0;
  let low = 0,
    high = 0;
  // Python: c = g[:, 4:-4]; near = g[:, 3:-5] + g[:, 5:-3];
  //         far = g[:, 0:-8] + g[:, 1:-7] + g[:, 7:-1] + g[:, 8:]
  // Center index x = i + 4: near = g[x-1] + g[x+1];
  // far = g[x-4] + g[x-3] + g[x+3] + g[x+4]
  for (let y = 0; y < h; y++) {
    for (let x = 4; x < w - 4; x++) {
      const c = g[y * w + x];
      const near = g[y * w + x - 1] + g[y * w + x + 1];
      const far =
        g[y * w + x - 4] + g[y * w + x - 3] + g[y * w + x + 3] + g[y * w + x + 4];
      low += Math.abs(2 * c - near);
      high += Math.abs(4 * c - far);
    }
  }
  return low > 0 ? high / low : 0;
}

function blockinessStdOf(g: Float64Array, w: number, h: number): number {
  const bands: number[] = [];
  for (let by = 1; by < h - 1; by += 16) {
    let on = 0,
      onN = 0;
    const bandH = Math.min(16, h - 1 - by);
    if (bandH < 3) continue; // Python skips bands with < 3 rows
    for (let y = by; y < by + bandH; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (x % 8 === 0 || y % 8 === 0) {
          on += Math.abs(g[y * w + x + 1] - g[y * w + x - 1]);
          onN++;
        }
      }
    }
    bands.push(onN ? on / onN : 0);
  }
  if (bands.length < 2) return 0;
  let mu = 0;
  for (const v of bands) mu += v;
  mu /= bands.length;
  let vv = 0;
  for (const v of bands) vv += (v - mu) ** 2;
  return Math.sqrt(vv / bands.length);
}

function highFreqRatioOf(g: Float64Array, w: number, h: number): number {
  if (w < 5) return 0.5;
  let d1 = 0,
    d2 = 0,
    d3 = 0,
    d0 = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) d0 += Math.abs(g[i]);
  d0 = d0 / n + 1e-6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) d1 += Math.abs(g[y * w + x + 1] - g[y * w + x]);
    for (let x = 0; x < w - 2; x++) d2 += Math.abs(g[y * w + x + 2] - g[y * w + x]);
    for (let x = 0; x < w - 3; x++) d3 += Math.abs(g[y * w + x + 3] - g[y * w + x]);
  }
  d1 /= h * (w - 1);
  d2 /= h * (w - 2);
  d3 /= h * (w - 3);
  return (d1 + d2 + d3) / (3 * d0);
}

function entropyOf(g: Float64Array, bins = 64): number {
  const hist = new Float64Array(bins);
  for (let i = 0; i < g.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((g[i] / 255) * bins)));
    hist[b]++;
  }
  let s = 0;
  for (let i = 0; i < bins; i++) s += hist[i];
  if (s <= 0) return 0;
  let e = 0;
  for (let i = 0; i < bins; i++) {
    const p = hist[i] / s;
    if (p > 0) e -= p * Math.log2(p);
  }
  return e;
}

function noiseLumaCorrOf(g: Float64Array, w: number, h: number): number {
  if (h < 3 || w < 3) return 0;
  let n = 0,
    sr = 0,
    sl = 0,
    srr = 0,
    sll = 0,
    srl = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = g[y * w + x];
      const blur =
        (c + g[y * w + x - 1] + g[y * w + x + 1] + g[(y - 1) * w + x] + g[(y + 1) * w + x]) / 5;
      const r = Math.abs(c - blur);
      const l = c;
      n++;
      sr += r;
      sl += l;
      srr += r * r;
      sll += l * l;
      srl += r * l;
    }
  }
  const cov = srl / n - (sr / n) * (sl / n);
  const sdR = Math.sqrt(Math.max(0, srr / n - (sr / n) ** 2));
  const sdL = Math.sqrt(Math.max(0, sll / n - (sl / n) ** 2));
  if (sdR < 1e-9 || sdL < 1e-9) return 0;
  return cov / (sdR * sdL);
}

function blockingAnisotropyOf(g: Float64Array, w: number, h: number): number {
  if (h < 9 || w < 9) return 0;
  let gxA = 0,
    gyA = 0,
    diag1 = 0,
    diag2 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 8; x < w; x++) gxA += Math.abs(g[y * w + x] - g[y * w + x - 8]);
  for (let y = 8; y < h; y++)
    for (let x = 0; x < w; x++) gyA += Math.abs(g[y * w + x] - g[(y - 8) * w + x]);
  for (let y = 8; y < h; y++)
    for (let x = 8; x < w; x++) diag1 += Math.abs(g[y * w + x] - g[(y - 8) * w + x - 8]);
  for (let y = 8; y < h; y++)
    for (let x = 0; x < w - 8; x++) diag2 += Math.abs(g[y * w + x] - g[(y - 8) * w + x + 8]);
  const axis = (gxA / (h * (w - 8)) + gyA / ((h - 8) * w)) / 2;
  const diag = (diag1 / ((h - 8) * (w - 8)) + diag2 / ((h - 8) * (w - 8))) / 2 + 1e-9;
  return axis / diag;
}

function residualKurtosisOf(g: Float64Array, w: number, h: number): number {
  if (h < 3 || w < 3) return 0;
  let n = 0,
    s = 0,
    s2 = 0,
    s4 = 0;
  const rs: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = g[y * w + x];
      const blur =
        (c + g[y * w + x - 1] + g[y * w + x + 1] + g[(y - 1) * w + x] + g[(y + 1) * w + x]) / 5;
      rs.push(c - blur);
    }
  }
  for (const r of rs) {
    s += r;
    s2 += r * r;
    n++;
  }
  const mu = s / n;
  const varr = s2 / n - mu * mu;
  const sd = Math.sqrt(Math.max(0, varr));
  if (sd < 1e-9) return 0;
  for (const r of rs) {
    const z = r - mu;
    s4 += z ** 4;
  }
  // Pearson kurtosis: central 4th moment over sigma^4 (population).
  return s4 / n / sd ** 4;
}

function temporalWhitenessOf(
  cur: Float64Array,
  prev: Float64Array,
  w: number,
  h: number,
): number {
  if (w < 3 || h < 1) return 0;
  // lag-1 horizontal autocorrelation of |difference|
  let sA = 0,
    sB = 0,
    sAA = 0,
    sBB = 0,
    sAB = 0,
    m = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a = Math.abs(cur[y * w + x] - prev[y * w + x]);
      const b = Math.abs(cur[y * w + x + 1] - prev[y * w + x + 1]);
      sA += a;
      sB += b;
      sAA += a * a;
      sBB += b * b;
      sAB += a * b;
      m++;
    }
  }
  if (m === 0) return 0;
  const cov = sAB / m - (sA / m) * (sB / m);
  const sdA = Math.sqrt(Math.max(0, sAA / m - (sA / m) ** 2));
  const sdB = Math.sqrt(Math.max(0, sBB / m - (sB / m) ** 2));
  if (sdA < 1e-9 || sdB < 1e-9) return 0;
  return cov / (sdA * sdB);
}

// ---------------------------------------------------------------------------
// Clip aggregation (mirrors build_clip_corpus in backend/python/corpus.py)
// ---------------------------------------------------------------------------

export function aggregateClipFeatures(frames: FrameFeatures16[]): number[] {
  if (frames.length === 0) throw new Error("No frames to aggregate.");
  const d = frames[0].length;
  const means = new Array<number>(d).fill(0);
  for (const f of frames) for (let i = 0; i < d; i++) means[i] += f[i];
  for (let i = 0; i < d; i++) means[i] /= frames.length;

  // flicker_consistency: population std of temporal_flicker (index 1)
  let fm = 0;
  for (const f of frames) fm += f[1];
  fm /= frames.length;
  let fv = 0;
  for (const f of frames) fv += (f[1] - fm) ** 2;
  const flickerConsistency = Math.sqrt(fv / frames.length);

  // noise_coupling: mean noise_luma_corr (index 12)
  let nc = 0;
  for (const f of frames) nc += f[12];
  const noiseCoupling = nc / frames.length;

  // layout_persistence: 1 - cv of luma_mean (index 8)
  let lm = 0;
  for (const f of frames) lm += f[8];
  lm /= frames.length;
  let lv = 0;
  for (const f of frames) lv += (f[8] - lm) ** 2;
  const layoutPersistence = 1 - Math.sqrt(lv / frames.length) / (lm + 1e-6);

  return [...means, layoutPersistence, flickerConsistency, noiseCoupling];
}

// ---------------------------------------------------------------------------
// Model scoring (mirrors Verifier.score in backend/java/Verifier.java)
// ---------------------------------------------------------------------------

function standardize(v: number, mu: number, sigma: number): number {
  return (v - mu) / sigma;
}

function sigmoid(z: number): number {
  const c = Math.max(-35, Math.min(35, z));
  return 1 / (1 + Math.exp(-c));
}

export function scoreClipFeatures(model: CtxtraceModel, clip: number[]): number {
  const xs = clip.map((v, i) => standardize(v, model.mu[i], model.sigma[i]));
  if (model.architecture === "mlp" && model.layers) {
    let a = xs;
    const L = model.layers.length;
    for (let li = 0; li < L; li++) {
      const { W, b } = model.layers[li];
      const out = new Array<number>(b.length).fill(0);
      for (let j = 0; j < b.length; j++) {
        let z = b[j];
        for (let k = 0; k < a.length; k++) z += a[k] * W[k][j];
        out[j] = li === L - 1 ? sigmoid(z) : Math.max(0, z);
      }
      a = out;
    }
    return a[0];
  }
  if (!model.weights) throw new Error("Model missing logistic weights.");
  let z = model.bias ?? 0;
  for (let i = 0; i < xs.length; i++) z += xs[i] * model.weights[i];
  return sigmoid(z);
}

export interface ClipScanVerdict {
  aiScore: number; // 0..100
  label: 0 | 1;
  confidence: number; // 0..1 distance from the boundary
  digest: string; // sha256-like integrity digest (hex via crypto.subtle)
  modelVersion: string;
}

export async function scoreClip(model: CtxtraceModel, clip: number[]): Promise<ClipScanVerdict> {
  const p = scoreClipFeatures(model, clip);
  const thr = model.threshold;
  const label: 0 | 1 = p >= thr ? 1 : 0;
  const confidence = Math.abs(p - thr) / Math.max(thr, 1 - thr);
  const digest = await sha256Hex(clip.map((v) => v + ",").join(""));
  return {
    aiScore: Math.round(p * 100),
    label,
    confidence,
    digest,
    modelVersion: model.version,
  };
}

async function sha256Hex(data: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // FNV-1a fallback for non-secure contexts; clearly weaker, tests use subtle.
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
