import { Link, useParams } from "react-router";
import { ArrowLeft, FlaskConical, Lock, ScrollText } from "lucide-react";

const EASE = [0.22, 1, 0.36, 1] as const;

type Section = { n: string; h: string; p: string[] };

const DOCS: Record<
  "privacy" | "terms" | "research",
  {
    kicker: string;
    title: string;
    intro: string;
    icon: typeof Lock;
    sections: Section[];
  }
> = {
  privacy: {
    kicker: "Legal",
    title: "Privacy",
    intro:
      "What ContextTrace stores, why, and what it never does. Written to be read, not to be skimmed past.",
    icon: Lock,
    sections: [
      {
        n: "01",
        h: "What we store",
        p: [
          "Your account record: email address, role and creation time. Passwords are never stored — sign-in uses one-time email codes.",
          "Your analysis workspace: uploaded videos, generated transcripts, alignment mappings, detected edit events and completed reports, all bound to your user id.",
        ],
      },
      {
        n: "02",
        h: "What we never do",
        p: [
          "We do not sell data, run advertising trackers, or share your uploads with third parties for any purpose other than operating the service.",
          "Model training never uses your media. The scoring model is pre-trained on synthetic corpora and evaluated on held-out clips; your uploads are never added to it.",
        ],
      },
      {
        n: "03",
        h: "Retention & deletion",
        p: [
          "Reports remain in your analysis history until you delete them. Deleting a report removes its findings; artifact retention follows your workspace settings.",
          "Guest sessions are scoped to the browser session and are not recoverable after sign-out.",
        ],
      },
      {
        n: "04",
        h: "Contact",
        p: [
          "Questions about this policy can be raised from the dashboard. Administrative requests are reviewed by the maintainers via the admin console.",
        ],
      },
    ],
  },
  terms: {
    kicker: "Legal",
    title: "Terms of use",
    intro:
      "The contract is short: use ContextTrace to understand edits, not to accuse people.",
    icon: ScrollText,
    sections: [
      {
        n: "01",
        h: "What ContextTrace is",
        p: [
          "An evidence workstation. It compares a source video with an edited derivative and reports detected edit events with timestamps, similarity and confidence.",
          "It is not a truth oracle. A high score indicates that edits with contextual impact were detected — it does not establish intent, deception or malice.",
        ],
      },
      {
        n: "02",
        h: "Acceptable use",
        p: [
          "Upload only media you have the rights to analyze. Do not use ContextTrace to harass, defame or target individuals.",
          "Publishing claims based on a report must preserve the report's caveats: confidence, coverage and the distinction between an observed edit and its interpretation.",
        ],
      },
      {
        n: "03",
        h: "No warranty",
        p: [
          "The service is provided as-is. Detection quality depends on audio quality, codecs and edit style; results are probabilistic and carry uncertainty by design.",
          "Scores and findings may change as the pipeline and models improve. Historical reports retain the pipeline version that produced them.",
        ],
      },
      {
        n: "04",
        h: "Liability",
        p: [
          "To the maximum extent permitted by law, the maintainers are not liable for decisions made solely on the basis of a ContextTrace report.",
          "The tool is intended to support human editorial and forensic judgment, not replace it.",
        ],
      },
    ],
  },
  research: {
    kicker: "Methodology",
    title: "How the score is computed",
    intro:
      "A transparent walkthrough of the detection pipeline and the evaluation that backs it.",
    icon: FlaskConical,
    sections: [
      {
        n: "01",
        h: "Signals",
        p: [
          "Sixteen features are extracted per sampled frame pair — luma statistics, edge density, blockiness, color moments and saturation deviation — chosen to expose re-encoding, splicing and synthetic-frame artifacts.",
          "Speech is transcribed with timestamps on both sides and aligned semantically; alignment gaps, reorders and non-contiguous mappings become candidate edit events. OCR cross-checks burned-in captions against the spoken track.",
        ],
      },
      {
        n: "02",
        h: "The scoring model",
        p: [
          "A logistic model over the 16 features produces a 0–100 manipulation score. The same model ships in three engines — TypeScript, Python and Java — and every engine is conformance-tested against identical fixtures to ≤1e-9 agreement.",
        ],
      },
      {
        n: "03",
        h: "Evaluation",
        p: [
          "The model is trained on a procedurally generated corpus of clean and manipulated clips and evaluated on a fresh held-out corpus every run:",
          "98.33% holdout accuracy · AUC 0.9975 · precision 96.77% · recall 100% · 5-fold CV 99.38% ± 1.25. Hard-subset clips (denoised, re-encoded, grainy) hold 95%.",
        ],
      },
      {
        n: "04",
        h: "Known limitations",
        p: [
          "Heavily denoised material narrows the feature separability and is where most residual errors concentrate.",
          "The pipeline treats ordinary editing as non-malicious by design: an observed edit event and a contextual-impact judgment are always reported separately.",
        ],
      },
    ],
  },
};

function isDocKey(k: string | undefined): k is keyof typeof DOCS {
  return k === "privacy" || k === "terms" || k === "research";
}

export default function Legal() {
  const { doc } = useParams();
  const key = isDocKey(doc) ? doc : "privacy";
  const page = DOCS[key];
  const Icon = page.icon;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-3">
            <svg viewBox="0 0 64 64" className="size-7" aria-hidden>
              <rect x="6" y="14" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="4" />
              <rect x="22" y="6" width="36" height="36" fill="none" stroke="var(--trace-red)" strokeWidth="4" />
              <rect x="26" y="30" width="8" height="8" fill="var(--trace-red)" />
            </svg>
            <span className="text-lg font-bold tracking-tight">
              Context<span className="text-[var(--trace-red)]">Trace</span>
            </span>
          </Link>
          <Link
            to="/"
            className="meta-label flex items-center gap-1.5 transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> Back
          </Link>
        </div>
      </header>

      <article className="mx-auto max-w-3xl px-6 py-16">
        <p className="meta-label flex items-center gap-2">
          <Icon className="size-4 text-[var(--trace-red)]" />
          {page.kicker}
        </p>
        <h1 className="display-lg mt-3">{page.title}</h1>
        <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
          {page.intro}
        </p>

        <div className="mt-12 space-y-px bg-border">
          {page.sections.map((s) => (
            <section key={s.n} className="bg-background py-6">
              <div className="flex gap-5">
                <span className="meta-value mt-1 shrink-0 text-[var(--trace-red)]">
                  {s.n}
                </span>
                <div>
                  <h2 className="text-lg font-bold tracking-tight">{s.h}</h2>
                  {s.p.map((para, i) => (
                    <p key={i} className="mt-3 text-sm leading-6 text-muted-foreground">
                      {para}
                    </p>
                  ))}
                </div>
              </div>
            </section>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-6">
          {(
            [
              ["privacy", "Privacy"],
              ["terms", "Terms"],
              ["research", "Methodology"],
            ] as const
          ).map(([k, label]) => (
            <Link
              key={k}
              to={`/legal/${k}`}
              className={
                "meta-label transition-colors hover:text-foreground " +
                (k === key ? "text-[var(--trace-red)]" : "")
              }
            >
              {label}
            </Link>
          ))}
          <span className="meta-label ml-auto">ContextTrace · v1.0.0</span>
        </div>
      </article>
    </div>
  );
}
