// ContextTrace polyglot gateway (bun) — orchestrates the Python numeric core
// and the Java verifier behind one HTTP surface. Run: bun server/index.ts

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PY_DIR = join(ROOT, "backend", "python");
const MODEL = join(PY_DIR, "model.json");

const PORT = Number(process.env.CTXTRACE_PORT ?? 8787);

interface ScoreResponse {
  score: number;
  label: 0 | 1;
  confidence: number;
  modelVersion: string;
  engine: "python";
}

interface VerifyResponse {
  javaScore: number;
  modelDigest: string;
  featureDigest: string;
  consensus?: {
    agreed: boolean;
    medianScore: number;
    maxAbsDeviation: number;
    enginesInAgreement: number;
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function run(cmd: string[], cwd: string, timeoutMs = 60000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    try {
      const proc = Bun.spawnSync({
        cmd,
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      });
      resolve({
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
        code: proc.exitCode ?? 0,
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function python(args: string[], input?: string) {
  return run(["python3", ...args], PY_DIR, 300000).then((r) => {
    if (r.code !== 0) throw new Error(`python failed: ${r.stderr.slice(0, 500)}`);
    return r.stdout;
  });
}

function java(args: string[]) {
  return run(["java", "-cp", join(ROOT, "backend", "java"), "Verifier", ...args], ROOT).then((r) => {
    if (r.code !== 0) throw new Error(`java failed: ${r.stderr.slice(0, 500)}`);
    return r.stdout;
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

export const routes = {
  "/api/health": async () =>
    json({
      ok: true,
      service: "ctxtrace-gateway",
      model: JSON.parse(await Bun.file(MODEL).text()).version,
      engines: { python: "ready", java: "ready" },
    }),

  "/api/score": async (req: Request) => {
    const body = await readJson(req);
    const feats = body.features as number[] | undefined;
    if (!Array.isArray(feats)) return json({ error: "features[] required (19 clip features)" }, 400);
    const out = await python(["cli_score.py"], JSON.stringify({ mode: "score", features: feats }));
    const parsed = JSON.parse(out) as { score: number; label: 0 | 1; confidence: number };
    const modelVersion = JSON.parse(await Bun.file(MODEL).text()).version;
    const resp: ScoreResponse = { ...parsed, modelVersion, engine: "python" };
    return json(resp);
  },

  "/api/verify": async (req: Request) => {
    const body = await readJson(req);
    const feats = body.features as number[] | undefined;
    if (!Array.isArray(feats)) return json({ error: "features[] required" }, 400);
    const args = ["verify", feats.map((v) => String(v)).join(",")];
    const jsScore = typeof body.jsScore === "number" ? body.jsScore : undefined;
    const pyScore = typeof body.pyScore === "number" ? body.pyScore : undefined;
    if (jsScore !== undefined) args.push(String(jsScore));
    if (pyScore !== undefined) args.push(String(pyScore));
    if (jsScore !== undefined && pyScore !== undefined && typeof body.tolerance === "number")
      args.push(String(body.tolerance));
    const out = await java(args);
    return json(JSON.parse(out) as VerifyResponse);
  },

  "/api/evaluate": async () => {
    const out = await python(["evaluate.py"]);
    const text = out.trim();
    // evaluate.py prints JSON then a human-readable line; split at the last "}".
    const jsonPart = text.slice(0, text.lastIndexOf("}") + 1);
    return json(JSON.parse(jsonPart));
  },
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const route = routes[url.pathname as keyof typeof routes];
    if (!route) return json({ error: "not found", path: url.pathname }, 404);
    try {
      return await route(req);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "gateway error" }, 500);
    }
  },
});

console.log(`ctxtrace gateway on :${server.port}`);
export default server;
