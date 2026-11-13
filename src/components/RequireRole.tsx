import { Navigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import type { ReactNode } from "react";

export function RequireRole({ role, children }: { role: string; children: ReactNode }) {
  const { isLoading, user, isAuthenticated } = useAuth();
  if (isLoading) return <main className="min-h-screen flex items-center justify-center">Loading…</main>;
  if (!isAuthenticated) return <Navigate to="/auth" replace />;
  if (user?.role !== role) return <Navigate to="/dashboard" replace />;
  return children;
}
