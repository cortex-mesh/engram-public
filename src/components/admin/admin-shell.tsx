import Link from "next/link";

import type { Viewer } from "@/lib/viewer";

import AdminSidebar from "./admin-sidebar";

export default function AdminShell({
  viewer,
  children,
}: {
  viewer: Viewer;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <AdminSidebar />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">Hosted platform administration</div>
              <div className="text-sm text-muted-foreground">
                Manage clients, users, apps, and feature rollout for ctxhost.
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <Link
                href="/account"
                className="rounded-lg border border-border px-3 py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Back to account
              </Link>
              <div className="rounded-lg border border-border bg-card px-3 py-2">
                <div className="font-medium">{viewer.displayName}</div>
                <div className="text-xs text-muted-foreground">{viewer.role}</div>
              </div>
            </div>
          </div>
        </header>
        <main className="flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
