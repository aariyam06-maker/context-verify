import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { RequireRole } from "@/components/RequireRole";
import React, { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import { motion } from "framer-motion";
import "./index.css";

const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const Detect = lazy(() => import("./pages/Detect.tsx"));
const Tamper = lazy(() => import("./pages/Tamper.tsx"));
const Result = lazy(() => import("./pages/Result.tsx"));
const History = lazy(() => import("./pages/History.tsx"));
const Admin = lazy(() => import("./pages/Admin.tsx"));
const Legal = lazy(() => import("./pages/Legal.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

function titleForPath(pathname: string): string {
  if (pathname === "/") return "ContextTrace — AI video & evidence-tamper detection";
  if (pathname.startsWith("/auth")) return "Try free · ContextTrace";
  if (pathname.startsWith("/detect")) return "AI Detection · ContextTrace";
  if (pathname.startsWith("/tamper")) return "Tamper Check · ContextTrace";
  if (pathname.startsWith("/result")) return "Result · ContextTrace";
  if (pathname.startsWith("/history")) return "Analysis History · ContextTrace";
  if (pathname.startsWith("/admin")) return "Admin · ContextTrace";
  if (pathname.startsWith("/legal")) return "Legal · ContextTrace";
  return "Page not found · ContextTrace";
}

function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  useEffect(() => { document.title = titleForPath(location.pathname); window.scrollTo(0, 0); }, [location.pathname]);
  return <motion.div key={location.pathname} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .25 }}>{children}</motion.div>;
}

function RouteLoading() {
  return <div className="min-h-screen flex items-center justify-center"><div className="animate-pulse text-muted-foreground">Loading…</div></div>;
}

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; message: string; stack: string }> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) { return { hasError: true, message: error.message || "Unknown runtime error", stack: error.stack || "" }; }
  componentDidCatch(error: Error) { console.error("[ContextTrace] Root crash:", error); }
  render() {
    if (this.state.hasError) return <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6"><div className="max-w-2xl w-full"><p className="text-sm font-semibold">ContextTrace runtime error</p><p className="mt-2 text-xs text-muted-foreground break-words">{this.state.message}</p><pre className="mt-3 max-h-72 overflow-auto rounded border p-3 text-[10px] leading-4 text-muted-foreground">{this.state.stack}</pre><button className="mt-4 border px-3 py-2 text-sm" onClick={() => window.location.reload()}>Reload application</button></div></div>;
    return this.props.children;
  }
}

function RouteSyncer() {
  const location = useLocation();
  useEffect(() => { window.parent?.postMessage?.({ type: "iframe-route-change", path: location.pathname }, "*"); }, [location.pathname]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <BrowserRouter>
        <RouteSyncer />
        <Suspense fallback={<RouteLoading />}>
          <PageTransition>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/auth" element={<AuthPage redirectAfterAuth="/dashboard" />} />
              <Route path="/legal/:doc" element={<Legal />} />
              <Route path="/legal" element={<Legal />} />
              <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
              <Route path="/detect" element={<RequireAuth><Detect /></RequireAuth>} />
              <Route path="/tamper" element={<RequireAuth><Tamper /></RequireAuth>} />
              <Route path="/result/:jobId" element={<RequireAuth><Result /></RequireAuth>} />
              <Route path="/history" element={<RequireAuth><History /></RequireAuth>} />
              <Route path="/admin" element={<RequireRole role="admin"><Admin /></RequireRole>} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </PageTransition>
        </Suspense>
        <Toaster />
      </BrowserRouter>
    </RootErrorBoundary>
  </StrictMode>,
);
