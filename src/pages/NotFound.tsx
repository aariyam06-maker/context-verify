import { motion } from "framer-motion";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { ArrowRight, Compass } from "lucide-react";

const EASE = [0.22, 1, 0.36, 1] as const;

const LINKS = [
  { to: "/", label: "Landing page", hint: "Product overview" },
  { to: "/auth", label: "Sign in", hint: "Email OTP or guest" },
  { to: "/dashboard", label: "Dashboard", hint: "Signed-in workspace" },
];

export default function NotFound() {
  return (
    <div className="grid-paper flex min-h-screen flex-col">
      {/* Header strip */}
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
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
          <p className="meta-label">HTTP 404</p>
        </div>
      </header>

      <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-6 py-20">
        {/* Giant ghost 404 */}
        <motion.p
          aria-hidden
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, ease: EASE }}
          className="ct-outline pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[70%] select-none text-[34vw] font-bold leading-none opacity-60 lg:text-[24rem]"
        >
          404
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.15, ease: EASE }}
          className="relative w-full max-w-md border bg-card p-8 shadow-[0_30px_80px_-40px_oklch(0.18_0.01_260/0.35)]"
        >
          <p className="meta-label flex items-center gap-2 text-[var(--trace-red)]">
            <span className="inline-block h-[3px] w-6 bg-[var(--trace-red)]" />
            Error 404 · route not found
          </p>
          <h1 className="display-lg mt-3 text-4xl">No trace here.</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            The page you requested does not exist. It may have been moved, or
            the address may be mistyped — unlike our analyses, this one left no
            evidence behind.
          </p>

          <div className="mt-8 space-y-px border bg-border">
            {LINKS.map((l, i) => (
              <motion.div
                key={l.to}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: 0.3 + i * 0.08, ease: EASE }}
              >
                <Link
                  to={l.to}
                  className="group flex items-center justify-between gap-3 bg-background p-3 transition-colors hover:bg-secondary"
                >
                  <span>
                    <span className="block text-sm font-semibold tracking-tight">{l.label}</span>
                    <span className="meta-value text-muted-foreground">{l.hint}</span>
                  </span>
                  <ArrowRight className="size-4 text-muted-foreground transition-transform duration-300 group-hover:translate-x-1 group-hover:text-[var(--trace-red)]" />
                </Link>
              </motion.div>
            ))}
          </div>

          <div className="mt-6 flex gap-2">
            <Button asChild className="flex-1">
              <Link to="/">
                <Compass className="size-4" />
                Back to safety
              </Link>
            </Button>
          </div>
        </motion.div>
      </div>

      <footer className="border-t">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-6 py-4">
          <p className="meta-label">ContextTrace · v1.0.0</p>
          <p className="meta-label">Identifies evidence — does not establish intent.</p>
        </div>
      </footer>
    </div>
  );
}
