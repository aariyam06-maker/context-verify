import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

export function RequireRole({
  role,
  children,
}: {
  role: "admin";
  children: ReactNode;
}) {
  const { isLoading, isAuthenticated, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  if (user && user.role !== role) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="max-w-md border p-10">
          <p className="meta-label text-[var(--trace-red)]">403 — Forbidden</p>
          <h1 className="display-lg mt-3 text-3xl font-bold tracking-tight">
            Admin access required
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            This review console is restricted to administrator accounts. Your
            account role does not grant access.
          </p>
        </div>
      </main>
    );
  }

  return children;
}
