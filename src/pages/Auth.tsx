import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { useAuth } from "@/hooks/use-auth";
import { ArrowRight, Loader2, Mail, UserX } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect, { replace: true });
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      setStep({ email: formData.get("email") as string });
    } catch (error) {
      console.error("Email sign-in error:", error);
      setError(
        error instanceof Error
          ? error.message
          : "Failed to send verification code. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      navigate(redirect, { replace: true });
    } catch (error) {
      console.error("OTP verification error:", error);
      setError("The verification code you entered is incorrect.");
      setOtp("");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGuestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signIn("anonymous");
      navigate(redirect, { replace: true });
    } catch (error) {
      console.error("Guest login error:", error);
      setError(
        `Failed to sign in as guest: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left: typographic panel */}
      <div className="relative hidden flex-col justify-between border-r bg-foreground p-10 text-background lg:flex">
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
        <div>
          <p className="meta-label text-background/60">Source vs. edit analysis</p>
          <h1 className="display-lg mt-4 max-w-md">
            Evidence, timestamps, confidence — preserved.
          </h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-background/60">
            Sign in to run source-versus-edit comparisons and keep every report
            in your analysis history.
          </p>
        </div>
        <p className="meta-label text-background/40">
          Identifies evidence consistent with contextual change — does not establish intent.
        </p>
      </div>

      {/* Right: sign-in card */}
      <div className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">
          <div className="lg:hidden">
            <Link to="/" className="flex items-center gap-3">
              <span className="text-lg font-bold tracking-tight">
                Context<span className="text-[var(--trace-red)]">Trace</span>
              </span>
            </Link>
          </div>

          {step === "signIn" ? (
            <>
              <p className="meta-label">Authentication</p>
              <h2 className="display-lg mt-2 text-3xl">Sign in</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Enter your email to log in or sign up. New accounts are created
                automatically.
              </p>
              <form onSubmit={handleEmailSubmit} className="mt-8 space-y-4">
                <div className="relative">
                  <Mail className="absolute left-3 top-3 size-4 text-muted-foreground" />
                  <Input
                    name="email"
                    type="email"
                    required
                    placeholder="name@institution.org"
                    className="h-12 pl-9"
                    disabled={isLoading}
                  />
                </div>
                {error && (
                  <p className="border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-3 py-2 text-sm text-[var(--trace-red)]">
                    {error}
                  </p>
                )}
                <Button type="submit" className="h-12 w-full text-base" disabled={isLoading}>
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      Continue with email <ArrowRight className="size-4" />
                    </>
                  )}
                </Button>
              </form>

              <div className="my-6 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="meta-label">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <Button
                type="button"
                variant="outline"
                className="h-12 w-full"
                onClick={handleGuestLogin}
                disabled={isLoading}
              >
                <UserX className="size-4" />
                Continue as guest
              </Button>

              <p className="meta-label mt-10 leading-5">
                Reports are stored under your account. Guests get a session-scoped workspace.
              </p>
            </>
          ) : (
            <>
              <p className="meta-label">Verification</p>
              <h2 className="display-lg mt-2 text-3xl">Check your email</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                A 6-digit code was sent to <span className="meta-value text-foreground">{step.email}</span>
              </p>
              <form onSubmit={handleOtpSubmit} className="mt-8 space-y-5">
                <input type="hidden" name="email" value={step.email} />
                <input type="hidden" name="code" value={otp} />
                <div className="flex justify-center">
                  <InputOTP
                    value={otp}
                    onChange={setOtp}
                    maxLength={6}
                    disabled={isLoading}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && otp.length === 6 && !isLoading) {
                        (e.target as HTMLElement).closest("form")?.requestSubmit();
                      }
                    }}
                  >
                    <InputOTPGroup>
                      {Array.from({ length: 6 }).map((_, index) => (
                        <InputOTPSlot key={index} index={index} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                {error && (
                  <p className="border border-[var(--trace-red)]/40 bg-[var(--trace-red-soft)] px-3 py-2 text-sm text-[var(--trace-red)]">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  className="h-12 w-full text-base"
                  disabled={isLoading || otp.length !== 6}
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      Verify code <ArrowRight className="size-4" />
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => setStep("signIn")}
                  disabled={isLoading}
                >
                  Use a different email
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
