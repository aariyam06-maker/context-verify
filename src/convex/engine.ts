// ---------------------------------------------------------------------------
// ContextTrace analysis engine — deterministic, explainable detection logic.
// Pure functions only: no Convex, no I/O. The pipeline passes in evidence
// produced by modality providers (speech, visual, OCR).
//
// Principle: "No evidence pollution" — missing/weak evidence never becomes a
// positive manipulation claim. A candidate is only promoted to a finding when
// supporting evidence exists and clears thresholds.
// ---------------------------------------------------------------------------

export type TranscriptSegmentInput = {
  index: number;
  startTime: number;
  endTime: number;
  text: string;
  confidence: number;
};

export type AlignmentPair = {
  sourceIndex: number;
  editedIndex: number;
  similarity: number;
  confidence: number;
  method: string;
};

export type CandidateEvent = {
  category: "Omission" | "Reordering" | "Splicing" | "Discontinuity";
  severity: "low" | "medium" | "high";
  confidence: number;
  sourceStart?: number;
  sourceEnd?: number;
  editedStart?: number;
  editedEnd?: number;
  evidenceType:
    | "speech_alignment"
    | "visual_correspondence"
    | "ocr_caption"
    | "edit_event";
  explanation: string;
  observedChange: string;
  contextualImpact: string;
  sourceSegmentIds: number[];
  editedSegmentIds: number[];
};

export type ModalityFailure = {
  stage: "speech_analysis" | "visual_evidence" | "ocr_evidence";
  reason: string;
};

export type AnalysisInput = {
  sourceSegments: TranscriptSegmentInput[];
  editedSegments: TranscriptSegmentInput[];
  sourceDuration: number;
  editedDuration: number;
  sourceHasAudio: boolean;
  editedHasAudio: boolean;
  sourceOcrText?: string[];
  editedOcrText?: string[];
  modalityFailures: ModalityFailure[];
  // Configuration (recorded in the report for reproducibility)
  matchThreshold?: number;
  strongThreshold?: number;
};

export type AnalysisResult = {
  mappings: AlignmentPair[];
  events: CandidateEvent[];
  score: number;
  evidenceCoverage: number;
  uncertainty: number;
  omissionsCount: number;
  reorderingsCount: number;
  splicesCount: number;
  discontinuitiesCount: number;
  highSeverityCount: number;
  matchThreshold: number;
  strongThreshold: number;
};

export const DEFAULT_MATCH_THRESHOLD = 0.55; // cosine-similarity floor for a pairing
export const DEFAULT_STRONG_THRESHOLD = 0.72; // confidence in the pairing itself

const DEFAULT_WEIGHTS = {
  omission: 0.35,
  reordering: 0.18,
  splice: 0.22,
  discontinuity: 0.12,
  // Speech/caption mismatches are handled as warnings in v1 (no standalone
  // event without aligned caption evidence).
  captionMismatch: 0.08,
};

// ---------------------------------------------------------------------------
// Text normalization + token similarity (stand-in for sentence embeddings in
// the deterministic engine; the provider interface is where embeddings slot in)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "at", "by", "from", "as", "is", "are", "was", "were", "be", "been", "it",
  "this", "that", "these", "those", "you", "i", "we", "they", "he", "she",
  "uh", "um",
]);

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Greedy alignment: pass 1 high-confidence anchor pairs, pass 2 thresholded
// pairs with order preservation. Mirrors FAISS top-k nearest-neighbour
// matching in the real pipeline.
// ---------------------------------------------------------------------------

export function alignTranscripts(
  source: TranscriptSegmentInput[],
  edited: TranscriptSegmentInput[],
  matchThreshold: number,
): AlignmentPair[] {
  const sourceSets = source.map((s) => tokenSet(s.text));
  const editedSets = edited.map((s) => tokenSet(s.text));

  // Score matrix
  const scores: number[][] = source.map((_, i) =>
    edited.map((_, j) => jaccardSimilarity(sourceSets[i], editedSets[j])),
  );

  // Pass 1: greedy high-confidence anchors (descending similarity, one-to-one)
  const all: { i: number; j: number; s: number }[] = [];
  for (let i = 0; i < source.length; i++) {
    for (let j = 0; j < edited.length; j++) {
      if (scores[i][j] >= matchThreshold) all.push({ i, j, s: scores[i][j] });
    }
  }
  all.sort((a, b) => b.s - a.s);

  const usedSource = new Set<number>();
  const usedEdited = new Set<number>();
  const anchors: AlignmentPair[] = [];
  for (const { i, j, s } of all) {
    if (usedSource.has(i) || usedEdited.has(j)) continue;
    usedSource.add(i);
    usedEdited.add(j);
    anchors.push({
      sourceIndex: i,
      editedIndex: j,
      similarity: s,
      confidence: confidenceFromSimilarity(s),
      method: "greedy_anchor_v1",
    });
  }

  // Pass 2: thresholded leftover pairs, preserving monotonic order where
  // possible (a leftover pair whose neighbour anchors are already crossed
  // signals reordering; it still becomes a mapping, flagged below).
  const leftovers: AlignmentPair[] = [];
  for (let i = 0; i < source.length; i++) {
    if (usedSource.has(i)) continue;
    for (let j = 0; j < edited.length; j++) {
      if (usedEdited.has(j)) continue;
      if (scores[i][j] >= matchThreshold) {
        leftovers.push({
          sourceIndex: i,
          editedIndex: j,
          similarity: scores[i][j],
          confidence: confidenceFromSimilarity(scores[i][j]) * 0.85,
          method: "greedy_residual_v1",
        });
        usedEdited.add(j);
        break;
      }
    }
  }

  return [...anchors, ...leftovers].sort(
    (a, b) => a.sourceIndex - b.sourceIndex,
  );
}

export function confidenceFromSimilarity(similarity: number): number {
  // Map cosine-like similarity to a calibrated-looking confidence in [0,1]
  return Math.max(0, Math.min(1, (similarity - 0.3) / 0.6));
}

// ---------------------------------------------------------------------------
// Detect edit events from alignment structure
// ---------------------------------------------------------------------------

export function detectEvents(
  source: TranscriptSegmentInput[],
  edited: TranscriptSegmentInput[],
  mappings: AlignmentPair[],
  input: Pick<
    AnalysisInput,
    "sourceDuration" | "editedDuration" | "modalityFailures" | "strongThreshold" | "matchThreshold"
  >,
): CandidateEvent[] {
  const events: CandidateEvent[] = [];
  const matchThreshold = input.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;

  const sourceById = new Map(source.map((s) => [s.index, s]));
  const editedById = new Map(edited.map((s) => [s.index, s]));
  const matchedSource = new Set(mappings.map((m) => m.sourceIndex));

  const fmt = (t?: number) =>
    t === undefined ? "—" : formatTimestamp(t);

  // --- Omissions: unmatched source segments (present in source, absent from
  // the edit). A non-mapping is only a *candidate*; confidence and length
  // gates prevent weak evidence from becoming a finding.
  for (const seg of source) {
    if (matchedSource.has(seg.index)) continue;
    const strength = seg.confidence;
    const duration = Math.max(0.2, seg.endTime - seg.startTime);
    // No evidence pollution: only promote to a finding if the segment itself
    // has decent ASR confidence and meaningful length.
    if (strength < 0.45 || duration < 1.0) continue;

    const severity =
      duration >= 12 ? "high" : duration >= 4 ? "medium" : "low";

    events.push({
      category: "Omission",
      severity,
      confidence: clamp01(0.55 + strength * 0.35),
      sourceStart: seg.startTime,
      sourceEnd: seg.endTime,
      evidenceType: "speech_alignment",
      explanation: `A source statement spanning ${fmt(seg.startTime)}–${fmt(
        seg.endTime,
      )} does not appear in the edited video. Transcript: "${truncate(
        seg.text,
        140,
      )}"`,
      observedChange: `Source segment at ${fmt(seg.startTime)} (${duration.toFixed(
        1,
      )}s) has no counterpart in the edited version.`,
      contextualImpact:
        "Material omitted from the edit. Whether this changes the meaning conveyed depends on the statement's role in the original narrative — review the source clip to judge.",
      sourceSegmentIds: [seg.index],
      editedSegmentIds: [],
    });
  }

  // --- Reordering: non-monotonic mapping order ------------------------------
  const byEdited = [...mappings].sort(
    (a, b) => a.editedIndex - b.editedIndex,
  );
  for (let k = 1; k < byEdited.length; k++) {
    const prev = byEdited[k - 1];
    const cur = byEdited[k];
    if (cur.sourceIndex < prev.sourceIndex) {
      const srcA = sourceById.get(prev.sourceIndex);
      const srcB = sourceById.get(cur.sourceIndex);
      const editA = editedById.get(prev.editedIndex);
      const editB = editedById.get(cur.editedIndex);
      if (!srcA || !srcB || !editA || !editB) continue;
      const avgSim = (prev.similarity + cur.similarity) / 2;
      if (avgSim < matchThreshold) continue; // weak mappings don't make findings
      events.push({
        category: "Reordering",
        severity: "medium",
        confidence: clamp01(avgSim),
        sourceStart: Math.min(srcA.startTime, srcB.startTime),
        sourceEnd: Math.max(srcA.endTime, srcB.endTime),
        editedStart: Math.min(editA.startTime, editB.startTime),
        editedEnd: Math.max(editA.endTime, editB.endTime),
        evidenceType: "speech_alignment",
        explanation: `Statements appear in the edited video in a different order than in the source: source ${fmt(
          srcA.startTime,
        )} ↔ edit ${fmt(editA.startTime)} is followed by source ${fmt(
          srcB.startTime,
        )} ↔ edit ${fmt(editB.startTime)}.`,
        observedChange: `Sequence order inverted around ${fmt(editA.startTime)}–${fmt(
          editB.startTime,
        )} (alignment similarity ${avgSim.toFixed(2)}).`,
        contextualImpact:
          "The edited sequence presents statements in an order different from the original. Reordering can alter perceived causality or emphasis; compare both clips to assess whether the conveyed meaning shifts.",
        sourceSegmentIds: [prev.sourceIndex, cur.sourceIndex],
        editedSegmentIds: [prev.editedIndex, cur.editedIndex],
      });
    }
  }

  // --- Discontinuities: adjacent edited segments mapping far apart in source
  for (let k = 1; k < byEdited.length; k++) {
    const prev = byEdited[k - 1];
    const cur = byEdited[k];
    if (cur.sourceIndex <= prev.sourceIndex) continue; // covered by reordering
    const gap =
      (sourceById.get(cur.sourceIndex)?.startTime ?? 0) -
      (sourceById.get(prev.sourceIndex)?.endTime ?? 0);
    if (gap >= 20) {
      const srcPrev = sourceById.get(prev.sourceIndex);
      const srcCur = sourceById.get(cur.sourceIndex);
      if (!srcPrev || !srcCur) continue;
      const avgSim = (prev.similarity + cur.similarity) / 2;
      if (avgSim < matchThreshold) continue;
      const gapDuration = Math.max(0, gap);
      events.push({
        category: "Discontinuity",
        severity: gapDuration >= 60 ? "high" : "medium",
        confidence: clamp01(0.5 + avgSim * 0.35),
        sourceStart: srcPrev.endTime,
        sourceEnd: srcCur.startTime,
        editedStart: editedById.get(prev.editedIndex)?.endTime,
        editedEnd: editedById.get(cur.editedIndex)?.startTime,
        evidenceType: "speech_alignment",
        explanation: `Adjacent statements in the edited video map to source regions ${(gapDuration).toFixed(
          0,
        )}s apart: edit ${fmt(
          editedById.get(prev.editedIndex)?.startTime,
        )} → edit ${fmt(editedById.get(cur.editedIndex)?.startTime)} jumps across source ${fmt(
          srcPrev.endTime,
        )}–${fmt(srcCur.startTime)}.`,
        observedChange: `Non-contiguous source mapping: ${gapDuration.toFixed(
          0,
        )}s of source material skipped between consecutive edited segments.`,
        contextualImpact:
          "The edit joins two parts of the source that were not adjacent. This is consistent with excerpting; whether it changes conveyed meaning requires reviewing the skipped material.",
        sourceSegmentIds: [prev.sourceIndex, cur.sourceIndex],
        editedSegmentIds: [prev.editedIndex, cur.editedIndex],
      });
    }
  }

  // --- Splicing: dense interleaving of matched/unmatched edited content -----
  // An edited segment with no source counterpart that sits between matched
  // segments suggests inserted material (spliced excerpt).
  const matchedEdited = new Set(mappings.map((m) => m.editedIndex));
  for (const seg of edited) {
    if (matchedEdited.has(seg.index)) continue;
    const duration = Math.max(0.2, seg.endTime - seg.startTime);
    if (seg.confidence < 0.45 || duration < 1.5) continue;
    const neighbors = edited.filter(
      (e) =>
        e.index !== seg.index &&
        matchedEdited.has(e.index) &&
        e.endTime <= seg.startTime + 0.1 &&
        e.startTime >= seg.endTime - 0.1,
    );
    if (neighbors.length === 0) continue; // not flanked by matched content
    events.push({
      category: "Splicing",
      severity: duration >= 8 ? "high" : duration >= 3 ? "medium" : "low",
      confidence: clamp01(0.5 + seg.confidence * 0.35),
      editedStart: seg.startTime,
      editedEnd: seg.endTime,
      evidenceType: "speech_alignment",
      explanation: `Edited-video speech at ${fmt(seg.startTime)}–${fmt(
        seg.endTime,
      )} has no counterpart in the source transcript and is flanked by matched content: "${truncate(
        seg.text,
        140,
      )}"`,
      observedChange: `Inserted/external material detected at ${fmt(seg.startTime)} (${duration.toFixed(1)}s).`,
      contextualImpact:
        "The edited video contains speech not present in the provided source. This can be added context or a different recording entirely; compare both clips to assess.",
      sourceSegmentIds: [],
      editedSegmentIds: [seg.index],
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// OCR caption/speech mismatch checks (supporting evidence only)
// ---------------------------------------------------------------------------

export type CaptionCheckResult = {
  mismatches: number;
  warning?: string;
};

export function checkCaptionMismatch(
  segments: TranscriptSegmentInput[],
  ocrText: string[] | undefined,
): CaptionCheckResult {
  if (!ocrText || ocrText.length === 0) return { mismatches: 0 };
  // v1: OCR text is compared against transcript tokens. Substantial overlap
  // means captions match speech; low overlap with meaningful OCR volume means
  // caption text differs from speech — recorded as a warning, not an event.
  const ocrTokens = new Set(ocrText.flatMap((t) => tokenize(t)));
  const speechTokens = new Set(
    segments.flatMap((s) => tokenize(s.text)),
  );
  if (ocrTokens.size < 4) return { mismatches: 0 };
  let intersection = 0;
  for (const t of ocrTokens) if (speechTokens.has(t)) intersection++;
  const overlap = intersection / ocrTokens.size;
  if (overlap < 0.25) {
    return {
      mismatches: 1,
      warning: `On-screen text shares little vocabulary with the transcribed speech (token overlap ${(overlap * 100).toFixed(0)}%). Captions may convey additional or different content than the audio.`,
    };
  }
  return { mismatches: 0 };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function computeScore(events: CandidateEvent[]): {
  score: number;
  highSeverityCount: number;
} {
  let penalty = 0;
  let highSeverityCount = 0;
  for (const ev of events) {
    const base =
      ev.category === "Omission"
        ? DEFAULT_WEIGHTS.omission
        : ev.category === "Reordering"
          ? DEFAULT_WEIGHTS.reordering
          : ev.category === "Splicing"
            ? DEFAULT_WEIGHTS.splice
            : DEFAULT_WEIGHTS.discontinuity;
    const severityMul = ev.severity === "high" ? 1.0 : ev.severity === "medium" ? 0.6 : 0.3;
    const confidenceMul = 0.4 + ev.confidence * 0.6;
    penalty += base * severityMul * confidenceMul;
    if (ev.severity === "high") highSeverityCount++;
  }
  const score = Math.round(clamp01(1 - penalty) * 100);
  return { score, highSeverityCount };
}

export function computeEvidenceCoverage(
  input: Pick<
    AnalysisInput,
    "sourceHasAudio" | "editedHasAudio" | "modalityFailures"
  >,
): number {
  let coverage = 1;
  if (!input.sourceHasAudio || !input.editedHasAudio) coverage -= 0.4;
  const failures = input.modalityFailures.length;
  coverage -= failures * 0.15;
  return clamp01(coverage);
}

export function computeUncertainty(
  events: CandidateEvent[],
  evidenceCoverage: number,
): number {
  if (events.length === 0) return clamp01(0.35 + (1 - evidenceCoverage) * 0.3);
  const avgConfidence =
    events.reduce((acc, e) => acc + e.confidence, 0) / events.length;
  return clamp01(0.9 - avgConfidence * 0.6 + (1 - evidenceCoverage) * 0.2);
}

// ---------------------------------------------------------------------------
// Full pipeline entry point
// ---------------------------------------------------------------------------

export function runAnalysis(input: AnalysisInput): AnalysisResult {
  const matchThreshold = input.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const strongThreshold = input.strongThreshold ?? DEFAULT_STRONG_THRESHOLD;

  const mappings = alignTranscripts(
    input.sourceSegments,
    input.editedSegments,
    matchThreshold,
  );
  const events = detectEvents(
    input.sourceSegments,
    input.editedSegments,
    mappings,
    { ...input, strongThreshold, matchThreshold },
  );
  const { score, highSeverityCount } = computeScore(events);
  const evidenceCoverage = computeEvidenceCoverage(input);
  const uncertainty = computeUncertainty(events, evidenceCoverage);

  return {
    mappings,
    events,
    score,
    evidenceCoverage,
    uncertainty,
    omissionsCount: events.filter((e) => e.category === "Omission").length,
    reorderingsCount: events.filter((e) => e.category === "Reordering").length,
    splicesCount: events.filter((e) => e.category === "Splicing").length,
    discontinuitiesCount: events.filter((e) => e.category === "Discontinuity").length,
    highSeverityCount,
    matchThreshold,
    strongThreshold,
  };
}

// ---------------------------------------------------------------------------
// Interpretation text
// ---------------------------------------------------------------------------

export function buildInterpretation(
  result: AnalysisResult,
  degraded: boolean,
): string {
  const { score, highSeverityCount, events } = result;
  const parts: string[] = [];
  if (score >= 85 && events.length === 0) {
    parts.push(
      "The edited version preserves the source's spoken content: no material structural differences were detected by speech alignment.",
    );
  } else if (score >= 70) {
    parts.push(
      "The edit is broadly consistent with the source, with minor structural differences detected by speech alignment.",
    );
  } else if (score >= 45) {
    parts.push(
      "The edit diverges materially from the source in places. Speech alignment found structural differences consistent with excerpting or re-editing.",
    );
  } else {
    parts.push(
      "The edit differs substantially from the source. Multiple structural differences consistent with heavy excerpting, reordering, or inserted material were detected.",
    );
  }
  if (highSeverityCount > 0) {
    parts.push(
      `${highSeverityCount} finding${highSeverityCount === 1 ? "" : "s"} carry high severity; review the evidence before drawing conclusions.`,
    );
  }
  if (degraded) {
    parts.push(
      "Note: one or more evidence modalities failed during processing, so this assessment rests on partial evidence.",
    );
  }
  parts.push(
    "ContextTrace identifies evidence consistent with contextual change; it does not establish intent. Ordinary editing is not automatically misleading.",
  );
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${ms}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
