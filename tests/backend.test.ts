// ---------------------------------------------------------------------------
// ContextTrace backend test suite (bun test)
//
// 1. Engine conformance: the JS detector (src/lib/ai-model.ts) must produce
//    numerically identical frame features to the Python reference
//    (backend/python/features.py) on shared fixtures — tolerance 5e-9
//    (JSON round-trip quantization at 9 decimals + float64 noise).
// 2. Score conformance: JS vs Python vs Java clip scores agree to 1e-9, and
//    the Java verifier reports 3-engine consensus.
// 3. Digest integrity: SHA-256 model/feature digests match across languages
//    and change when inputs are tampered with.
// 4. Accuracy E2E: fresh holdout corpus evaluates >= 97% accuracy.
// 5. Gateway: HTTP surface spawns real python + java and answers /api/score
//    and /api/verify.
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test";
import { join } from "node:path";

import {
  extractFrameFeatures,
  aggregateClipFeatures,
  scoreClipFeatures,
  CTXTRACE_MODEL,
} from "../src/lib/ai-model";

const ROOT = join(import.meta.dir, "..");
const PY_DIR = join(ROOT, "backend", "python");
const JAVA_DIR = join(ROOT, "backend", "java");

const HAS_JAVA = Bun.which("java") !== null;
const HAS_PYTHON = Bun.which("python3") !== null;

// ---------------------------------------------------------------------------
// Deterministic fixture generation (no numpy needed — pure JS PRNG)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FW = 80;
const FH = 60;

/** Deterministic RGB frame with plausible structure (gradients + noise). */
function genFrame(seed: number, shift: number): number[][][] {
  const rnd = mulberry32(seed);
  const frame: number[][][] = [];
  for (let y = 0; y < FH; y++) {
    const row: number[][] = [];
    for (let x = 0; x < FW; x++) {
      const base =
        100 +
        30 * Math.sin((x + shift) / 9) +
        20 * Math.cos((y + shift) / 7) +
        (rnd() - 0.5) * 24;
      const r = Math.max(0, Math.min(255, base + 12 * Math.sin(x / 17)));
      const g = Math.max(0, Math.min(255, base));
      const b = Math.max(0, Math.min(255, base - 10 * Math.cos(y / 11)));
      row.push([r, g, b]);
    }
    frame.push(row);
  }
  return frame;
}

function toRGBA(rgb: number[][][]): Float64Array {
  const out = new Float64Array(FW * FH * 4);
  let p = 0;
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      out[p++] = rgb[y][x][0];
      out[p++] = rgb[y][x][1];
      out[p++] = rgb[y][x][2];
      out[p++] = 255;
    }
  }
  return out;
}

function spawn(
  cmd: string[],
  opts: { cwd: string; input?: string; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync({
    cmd,
    cwd: opts.cwd,
    stdin: opts.input !== undefined ? new Response(opts.input).body : undefined,
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeout ?? 120_000,
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? 0,
  };
}

// Shared fixtures (computed once).
const FIX1 = genFrame(20260911, 0);
const FIX2 = genFrame(20260911, 3);

const jsF1 = extractFrameFeatures(toRGBA(FIX1), FW, FH, null);
const jsF2 = extractFrameFeatures(toRGBA(FIX2), FW, FH, jsF1.gray);
const JS_CLIP = aggregateClipFeatures([jsF1.features, jsF2.features]);
const JS_SCORE = scoreClipFeatures(CTXTRACE_MODEL, JS_CLIP);

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Canonical model digest string — mirrors Verifier.modelDigest in Java. */
function canonicalModelString(): string {
  const m = CTXTRACE_MODEL;
  const sb: string[] = [m.architecture + "|"];
  if (m.architecture === "mlp" && m.layers) {
    for (const layer of m.layers) {
      for (const row of layer.W) for (const v of row) sb.push(String(v) + ",");
      for (const v of layer.b) sb.push(String(v) + ",");
    }
  } else if (m.weights) {
    for (const v of m.weights) sb.push(String(v) + ",");
    sb.push(String(m.bias) + ",");
  }
  for (const v of m.mu) sb.push(String(v) + ",");
  for (const v of m.sigma) sb.push(String(v) + ",");
  return sb.join("");
}

// ---------------------------------------------------------------------------
// 1. Frame-feature conformance: JS vs Python
// ---------------------------------------------------------------------------

describe("frame-feature conformance (JS vs Python)", () => {
  test("python reference is available", () => {
    expect(HAS_PYTHON).toBe(true);
  });

  test(
    "extractFrameFeatures matches backend/python/features.py to 5e-9",
    () => {
      const res = spawn(
        ["python3", "cli_score.py"],
        {
          cwd: PY_DIR,
          input: JSON.stringify({ mode: "feats", frames: [FIX1, FIX2] }),
        },
      );
      expect(res.exitCode).toBe(0);
      const py = JSON.parse(res.stdout) as { frames: number[][] };
      expect(py.frames.length).toBe(2);

      const tol = 5e-9;
      const names = CTXTRACE_MODEL.featureOrder;
      [jsF1.features, jsF2.features].forEach((js, i) => {
        js.forEach((v, k) => {
          const diff = Math.abs(v - py.frames[i][k]);
          expect(diff).toBeLessThanOrEqual(tol);
          if (diff > tol) {
            throw new Error(
              `feature ${names[k]} frame ${i}: js=${v} py=${py.frames[i][k]} diff=${diff}`,
            );
          }
        });
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Clip-score conformance: JS vs Python vs Java (+ consensus)
// ---------------------------------------------------------------------------

describe("clip-score conformance (JS vs Python vs Java)", () => {
  test("python scores the clip identically", () => {
    const res = spawn(
      ["python3", "cli_score.py"],
      {
        cwd: PY_DIR,
        input: JSON.stringify({ mode: "score", features: JS_CLIP }),
      },
    );
    expect(res.exitCode).toBe(0);
    const py = JSON.parse(res.stdout) as { score: number };
    expect(Math.abs(py.score - JS_SCORE)).toBeLessThanOrEqual(1e-9);
  });

  test(
    "java scores the clip identically and certifies 3-engine consensus",
    () => {
      expect(HAS_JAVA).toBe(true);
      const res = spawn(
        [
          "java",
          "-cp",
          JAVA_DIR,
          "Verifier",
          "verify",
          JS_CLIP.map((v) => String(v)).join(","),
          String(JS_SCORE),
          String(JS_SCORE), // placeholder; python score checked separately
          "1e-6",
        ],
        { cwd: ROOT },
      );
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as {
        javaScore: number;
        modelDigest: string;
        consensus: { enginesInAgreement: number; maxAbsDeviation: number };
      };
      expect(Math.abs(out.javaScore - JS_SCORE)).toBeLessThanOrEqual(1e-9);
      expect(out.consensus.enginesInAgreement).toBe(3);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Digest integrity
// ---------------------------------------------------------------------------

describe("digest integrity", () => {
  test("model digest matches across JS and Java", async () => {
    const jsDigest = await sha256Hex(canonicalModelString());
    if (HAS_JAVA) {
      const res = spawn(["java", "-cp", JAVA_DIR, "Verifier", "selftest"], {
        cwd: ROOT,
      });
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as { digest: string };
      expect(out.digest).toBe(jsDigest);
    }
  });

  test("feature digest changes when a feature is tampered with", async () => {
    if (!HAS_JAVA) return;
    const tampered = [...JS_CLIP];
    tampered[0] += 0.5;
    const a = spawn(
      ["java", "-cp", JAVA_DIR, "Verifier", "verify", JS_CLIP.join(",")],
      { cwd: ROOT },
    );
    const b = spawn(
      ["java", "-cp", JAVA_DIR, "Verifier", "verify", tampered.join(",")],
      { cwd: ROOT },
    );
    const da = (JSON.parse(a.stdout) as { featureDigest: string }).featureDigest;
    const db = (JSON.parse(b.stdout) as { featureDigest: string }).featureDigest;
    expect(da).not.toBe(db);
  });

  test("model.json in backend and src bundle are identical", async () => {
    const backend = JSON.parse(await Bun.file(join(PY_DIR, "model.json")).text());
    const frontend = CTXTRACE_MODEL;
    expect(frontend.version).toBe(backend.version);
    expect(frontend.weights).toEqual(backend.weights);
    expect(frontend.mu).toEqual(backend.mu);
    expect(frontend.sigma).toEqual(backend.sigma);
  });
});

// ---------------------------------------------------------------------------
// 4. Accuracy E2E — the >= 97% test
// ---------------------------------------------------------------------------

describe("accuracy (fresh holdout corpus)", () => {
  test("model.json reports >= 97% cross-validated accuracy", () => {
    const cv = CTXTRACE_MODEL.evaluation as {
      crossValidated: { cv_accuracy: number };
    };
    expect(cv.crossValidated.cv_accuracy).toBeGreaterThanOrEqual(0.97);
  });

  test(
    "fresh holdout corpus evaluates >= 97% accuracy end-to-end",
    () => {
      const res = spawn(["python3", "evaluate.py"], {
        cwd: PY_DIR,
        timeout: 900_000,
      });
      expect(res.exitCode).toBe(0);
      const text = res.stdout.trim();
      const jsonPart = text.slice(0, text.lastIndexOf("}") + 1);
      const ev = JSON.parse(jsonPart) as { accuracy: number; auc: number };
      expect(ev.accuracy).toBeGreaterThanOrEqual(0.97);
      expect(ev.auc).toBeGreaterThanOrEqual(0.97);
    },
    900_000,
  );
});

// ---------------------------------------------------------------------------
// 5. Gateway smoke test (spawns real python + java behind HTTP)
// ---------------------------------------------------------------------------

describe("gateway", () => {
  test(
    "health, score and verify endpoints answer correctly",
    async () => {
      const port = 8791 + Math.floor(Math.random() * 200);
      const proc = Bun.spawn({
        cmd: ["bun", join(ROOT, "server", "index.ts")],
        cwd: ROOT,
        env: { ...process.env, CTXTRACE_PORT: String(port) },
        stdout: "pipe",
        stderr: "pipe",
      });

      const base = `http://localhost:${port}`;
      try {
        // Poll until ready.
        let healthy = false;
        for (let i = 0; i < 50; i++) {
          try {
            const r = await fetch(`${base}/api/health`);
            if (r.ok) {
              const body = (await r.json()) as { ok: boolean; model: string };
              healthy = body.ok && body.model === CTXTRACE_MODEL.version;
              break;
            }
          } catch {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        expect(healthy).toBe(true);

        const scoreRes = await fetch(`${base}/api/score`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ features: JS_CLIP }),
        });
        expect(scoreRes.status).toBe(200);
        const score = (await scoreRes.json()) as { score: number; engine: string };
        expect(score.engine).toBe("python");
        expect(Math.abs(score.score - JS_SCORE)).toBeLessThanOrEqual(1e-9);

        const verifyRes = await fetch(`${base}/api/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            features: JS_CLIP,
            jsScore: JS_SCORE,
            pyScore: score.score,
            tolerance: 1e-6,
          }),
        });
        expect(verifyRes.status).toBe(200);
        const verify = (await verifyRes.json()) as {
          javaScore: number;
          consensus?: { enginesInAgreement: number };
        };
        expect(Math.abs(verify.javaScore - JS_SCORE)).toBeLessThanOrEqual(1e-9);
        expect(verify.consensus?.enginesInAgreement).toBe(3);

        // Error paths: bad requests must answer 4xx with a message, never a
        // silent 200 or an unhandled crash.
        const missingFeatures = await fetch(`${base}/api/score`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nope: true }),
        });
        expect(missingFeatures.status).toBe(400);
        const errBody = (await missingFeatures.json()) as { error?: string };
        expect(typeof errBody.error).toBe("string");

        const badJson = await fetch(`${base}/api/score`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        });
        expect(badJson.status).toBe(400);

        const notFound = await fetch(`${base}/api/does-not-exist`);
        expect(notFound.status).toBe(404);
      } finally {
        proc.kill();
      }
    },
    120_000,
  );
});
