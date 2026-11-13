// Server-backed AI scan contract. The browser never computes or displays the
// legacy handcrafted/logistic detector as the product score. The authoritative
// scan is performed by the FastAPI detector pipeline.

export type ScanComponentId =
  | "learned_detector"
  | "face_temporal_detector"
  | "frame_detector"
  | "temporal_consistency"
  | "forensic_support"
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
  { id: "learned_detector", label: "Learned detector", description: "Primary learned real/fake evidence aggregated over sampled frames.", higherIsAiLike: true },
  { id: "face_temporal_detector", label: "Face-video detector", description: "Face-level learned detector with temporal association.", higherIsAiLike: true },
  { id: "frame_detector", label: "Frame detector", description: "Secondary frame-level real/fake detector.", higherIsAiLike: true },
  { id: "temporal_consistency", label: "Temporal consistency", description: "Stability of detector predictions across the clip.", higherIsAiLike: false },
  { id: "forensic_support", label: "Forensic support", description: "Low-weight compression and temporal forensic measurements.", higherIsAiLike: true },
  { id: "blockiness", label: "Blockiness", description: "Supporting compression artifact measurement.", higherIsAiLike: true },
  { id: "temporal_flicker", label: "Temporal flicker", description: "Supporting inter-frame instability measurement.", higherIsAiLike: true },
  { id: "saturation_dev", label: "Saturation deviation", description: "Supporting chroma distribution measurement.", higherIsAiLike: true },
  { id: "texture_uniformity", label: "Texture uniformity", description: "Supporting local texture measurement.", higherIsAiLike: true },
  { id: "compression_noise", label: "Compression noise", description: "Supporting high-frequency residual measurement.", higherIsAiLike: true },
  { id: "frequency_energy", label: "Spectral energy", description: "Supporting frequency-domain measurement.", higherIsAiLike: true },
  { id: "glcm_contrast", label: "GLCM texture contrast", description: "Supporting texture co-occurrence measurement.", higherIsAiLike: true },
  { id: "edge_coherence", label: "Edge orientation coherence", description: "Supporting gradient-structure measurement.", higherIsAiLike: false },
  { id: "chroma_aberration", label: "Chromatic aberration proxy", description: "Supporting channel-edge measurement.", higherIsAiLike: true },
  { id: "ringing", label: "Edge ringing proxy", description: "Supporting edge overshoot/undershoot measurement.", higherIsAiLike: true },
];

export type ComponentVerdict = {
  id: ScanComponentId;
  label: string;
  score: number;
  confidence: number;
  summary: string;
};

export type ComponentFinding = {
  componentId: ScanComponentId;
  label: string;
  severity: "low" | "medium" | "high";
  score: number;
  timestamp: number;
  frameValue: number;
  breachPct: number;
  explanation: string;
};

export type ScanResult = {
  analyzedFrames: number;
  sampledAt: number[];
  components: ComponentVerdict[];
  findings: ComponentFinding[];
  aiScore: number;
  rawAiArtifactIndex?: number;
  calibratedProbability?: number | null;
  scoreType?: "calibrated_probability" | "uncalibrated_ai_artifact_index";
  learnedDetectorScore?: number;
  forensicSupportScore?: number;
  temporalAgreement?: number;
  faceCoverage?: number;
  confidence: number;
  durationSeconds: number;
  meta: { width: number; height: number; fpsEstimate?: number; hasAudio: boolean };
  modelVersion: string;
  modelTrainingNote: string;
  modelRegistry?: Record<string, unknown>;
  warnings?: string[];
  provenance?: { available: boolean; status: string; manifest?: unknown; reason?: string };
  ocrObservations?: Array<{ timestamp: number; text: string; confidence: number }>;
  ocrCoverage?: number;
};

export type ScanProgress = { stage: string; pct: number };

export type MitigationPlan = {
  targets: ScanComponentId[];
  passes: string[];
  expectedReductionPct: number;
};

export function planMitigation(result: ScanResult): MitigationPlan {
  const targets = result.components.filter((component) => component.score >= 0.4).map((component) => component.id);
  const passes: string[] = [];
  if (targets.includes("forensic_support") || targets.includes("blockiness") || targets.includes("compression_noise")) passes.push("Targeted denoise + clean re-encode");
  if (targets.includes("temporal_consistency") || targets.includes("temporal_flicker")) passes.push("Temporal stabilization");
  if (targets.includes("texture_uniformity") || targets.includes("glcm_contrast")) passes.push("Micro-texture preservation");
  if (targets.includes("saturation_dev") || targets.includes("chroma_aberration")) passes.push("Chroma normalization");
  if (targets.includes("frequency_energy") || targets.includes("ringing")) passes.push("Frequency/edge re-encode pass");
  if (!passes.length) passes.push("Light clean re-encode");
  const scored = result.components.filter((component) => targets.includes(component.id));
  const average = scored.length ? scored.reduce((sum, component) => sum + component.score, 0) / scored.length : 0;
  return { targets, passes, expectedReductionPct: Math.round(Math.min(80, average * 90)) };
}
