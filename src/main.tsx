import '@vly-ai/integrations';
import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { RequireRole } from "@/components/RequireRole";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import { motion } from "framer-motion";
import "./index.css";

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const NewAnalysis = lazy(() => import("./pages/NewAnalysis.tsx"));
const ScanWorkbench = lazy(() => import("./pages/ScanWorkbench.tsx"));
const AnalysisProgress = lazy(() => import("./pages/AnalysisProgress.tsx"));
const AnalysisReport = lazy(() => import("./pages/AnalysisReport.tsx"));
const History = lazy(() => import("./pages/History.tsx"));
const Admin = lazy(() => import("./pages/Admin.tsx"));
const Legal = lazy(() => import("./pages/Legal.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

/** Document title per route (centralized so pages stay lean). */
function titleForPath(pathname: string): string {
  if (pathname === "/") return "ContextTrace — Source vs. Edit Analysis";
  if (pathname.startsWith("/auth")) return "Sign in · ContextTrace";
  if (pathname.startsWith("/analysis/new")) return "New Analysis · ContextTrace";
  if (/^\/analysis\/[^/]+\/progress/.test(pathname))
    return "Analysis Progress · ContextTrace";
  if (/^\/analysis\/[^/]+/.test(pathname)) return "Analysis Report · ContextTrace";
  if (pathname.startsWith("/scan")) return "AI-Scan · ContextTrace";
  if (pathname.startsWith("/history")) return "Analysis History · ContextTrace";
  if (pathname.startsWith("/admin")) return "Admin · ContextTrace";
  if (pathname.startsWith("/legal/privacy")) return "Privacy · ContextTrace";
  if (pathname.startsWith("/legal/terms")) return "Terms of use · ContextTrace";
  if (pathname.startsWith("/legal/research")) return "Methodology · ContextTrace";
  if (pathname.startsWith("/legal")) return "Legal · ContextTrace";
  return "Page not found · ContextTrace";
}

/** Fade/slide-in transition on every route change, plus per-route document
 *  title and scroll restoration. Exit animations are intentionally omitted
 *  so lazy chunks never block navigation. */
function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  useEffect(() => {
    document.title = titleForPath(location.pathname);
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return (
    <motion.div
      key={location.pathname}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in WebContainer environment). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);



function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          <RouteSyncer />
          <Suspense fallback={<RouteLoading />}>
            <PageTransition>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route
                  path="/auth"
                  element={<AuthPage redirectAfterAuth="/dashboard" />}
                />
                <Route path="/legal/:doc" element={<Legal />} />
                <Route path="/legal" element={<Legal />} />
                <Route
                  path="/dashboard"
                  element={
                    <RequireAuth>
                      <Dashboard />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/analysis/new"
                  element={
                    <RequireAuth>
                      <NewAnalysis />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/scan"
                  element={
                    <RequireAuth>
                      <ScanWorkbench />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/scan/:jobId"
                  element={
                    <RequireAuth>
                      <ScanWorkbench />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/analysis/:jobId/progress"
                  element={
                    <RequireAuth>
                      <AnalysisProgress />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/analysis/:jobId"
                  element={
                    <RequireAuth>
                      <AnalysisReport />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/history"
                  element={
                    <RequireAuth>
                      <History />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <RequireRole role="admin">
                      <Admin />
                    </RequireRole>
                  }
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </PageTransition>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
