import { motion } from "framer-motion";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="grid-paper flex min-h-screen flex-col"
    >
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-md border bg-card p-10">
          <p className="meta-label text-[var(--trace-red)]">Error 404</p>
          <h1 className="display-lg mt-3 text-4xl">Page not found</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            The page you requested does not exist. It may have been moved, or
            the address may be mistyped.
          </p>
          <div className="mt-8 flex gap-2">
            <Button asChild>
              <Link to="/">Go to the landing page</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/dashboard">Open dashboard</Link>
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
