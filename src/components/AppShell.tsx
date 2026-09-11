import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import logo from "@/assets/logo.svg";
import {
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  FilePlus2,
  History,
  ScanLine,
} from "lucide-react";
import { Link, useLocation } from "react-router";

const NAV = [
  { to: "/analysis/new", label: "New Analysis", icon: FilePlus2 },
  { to: "/scan", label: "AI-Scan", icon: ScanLine },
  { to: "/history", label: "History", icon: History },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const location = useLocation();

  const navItem = (to: string, label: string, Icon: typeof LayoutDashboard) => {
    const active =
      location.pathname === to || location.pathname.startsWith(to + "/");
    return (
      <Link
        key={to}
        to={to}
        className={cn(
          "border border-transparent px-3 py-1.5 text-sm font-medium tracking-tight transition-colors hover:border-foreground/20 hover:bg-secondary",
          active &&
            "border-foreground bg-foreground text-background hover:bg-foreground hover:text-background",
        )}
      >
        <span className="inline-flex items-center gap-2">
          <Icon className="size-3.5" />
          {label}
        </span>
      </Link>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-8">
            <Link to="/dashboard" className="flex items-center gap-3">
              <img src={logo} alt="ContextTrace" className="size-7" />
              <span className="text-lg font-bold tracking-tight">
                Context<span className="text-[var(--trace-red)]">Trace</span>
              </span>
              <Badge
                variant="outline"
                className="meta-label hidden border-[var(--trace-red)]/40 text-[var(--trace-red)] sm:inline-flex"
              >
                DEMO
              </Badge>
            </Link>
            <nav className="hidden items-center gap-1 md:flex">
              {NAV.map((n) => navItem(n.to, n.label, n.icon))}
              {user?.role === "admin" && navItem("/admin", "Admin", ShieldCheck)}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="meta-value hidden text-muted-foreground lg:inline">
              {user?.email ?? "guest session"}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void signOut();
              }}
            >
              <LogOut className="size-3.5" />
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-6 py-8">{children}</main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-6 py-4">
          <p className="meta-label">
            ContextTrace · AI media-forensics workstation · v1.0.0
          </p>
          <p className="meta-label">
            Identifies evidence consistent with contextual change — does not establish intent.
          </p>
        </div>
      </footer>
    </div>
  );
}
