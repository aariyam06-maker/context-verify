import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, Loader2, Mail, LockKeyhole, KeyRound } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";

function resolveRedirect(value: string | null, fallback = "/dashboard") {
  return value?.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

export default function Auth({ redirectAfterAuth = "/dashboard" }: { redirectAfterAuth?: string }) {
  const { isAuthenticated, signIn, tryFree, isLoading: authBusy } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const redirect = resolveRedirect(params.get("returnTo"), redirectAfterAuth);
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [demo, setDemo] = useState<Array<{ email: string; password: string; label: string; role: string }>>([]);
  useEffect(() => { void api.auth.demo().then((d) => setDemo(d.enabled ? d.accounts : [])).catch(() => setDemo([])); }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated) navigate(redirect, { replace: true });
  }, [isAuthenticated, navigate, redirect]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await signIn(email, password, mode === "register");
      navigate(redirect, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed.");
    }
  };

  const demoLogin = async (acc: { email: string; password: string }) => {
    setError(null); setMode("signin"); setEmail(acc.email); setPassword(acc.password);
    try {
      await signIn(acc.email, acc.password, false);
      navigate(redirect, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Demo sign-in failed - is the backend running on :8000?");
    }
  };

  const handleTryFree = async () => {
    setError(null);
    try {
      await tryFree();
      navigate(redirect, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to start a demo session.");
    }
  };

  return <div className="grid min-h-screen lg:grid-cols-2">
    <div className="relative hidden flex-col justify-between border-r bg-foreground p-10 text-background lg:flex">
      <Link to="/" className="flex items-center gap-3"><span className="text-lg font-bold tracking-tight">Context<span className="text-[var(--trace-red)]">Trace</span></span></Link>
      <div><p className="meta-label text-background/60">AI video forensics</p><h1 className="display-lg mt-4 max-w-md">Is it AI? Was it tampered with?</h1><p className="mt-4 max-w-md text-sm leading-6 text-background/60">Two services: AI-generated video detection for a single clip, and an evidence tamper check that tells you which of two videos is the original.</p></div>
      <p className="meta-label text-background/40">Forensic indicators with stated confidence — not legal proof.</p>
    </div>
    <div className="flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <p className="meta-label">Authentication</p>
        <h2 className="display-lg mt-2 text-3xl">{mode === "signin" ? "Welcome back" : "Try free"}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{mode === "signin" ? "Use your account to continue your protected analyses." : "Create a trial session in seconds and start analyzing without setting up an account first."}</p>
        {demo.length > 0 && (
          <div className="mt-8 border bg-card p-4">
            <p className="meta-label inline-flex items-center gap-1.5"><KeyRound className="size-3" />Demo credentials — one click</p>
            <div className="mt-3 space-y-2">
              {demo.map((acc) => (
                <button key={acc.email} type="button" disabled={authBusy} onClick={() => void demoLogin(acc)} className="flex w-full items-center justify-between gap-3 border px-3 py-2.5 text-left hover:border-foreground hover:bg-secondary">
                  <span><span className="block text-sm font-semibold">{acc.label}</span><span className="meta-value text-muted-foreground">{acc.email} · {acc.password}</span></span>
                  <ArrowRight className="size-4 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mt-4">
          <Button variant="outline" className="h-10 w-full" disabled={authBusy} onClick={handleTryFree} type="button">Or start an anonymous guest session</Button>
        </div>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="relative"><Mail className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-9" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="analyst@example.com" /></div>
          <div className="relative"><LockKeyhole className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-9" type="password" required minLength={10} autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={e => setPassword(e.target.value)} placeholder="Minimum 10 characters" /></div>
          {error && <p className="border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-3 py-2 text-sm text-[var(--trace-red)]">{error}</p>}
          <Button className="w-full h-11" disabled={authBusy} type="submit">{authBusy ? <><Loader2 className="size-4 animate-spin" /> Working…</> : <>{mode === "signin" ? "Sign in" : "Create account"}<ArrowRight className="size-4" /></>}</Button>
        </form>
        <button type="button" className="mt-5 text-sm underline underline-offset-4" onClick={() => { setMode(mode === "signin" ? "register" : "signin"); setError(null); }}>{mode === "signin" ? "Create a new account" : "Already have an account? Sign in"}</button>
      </div>
    </div>
  </div>;
}
