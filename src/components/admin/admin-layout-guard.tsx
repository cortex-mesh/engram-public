"use client";

// Auth guard for the /admin section. The parent layout.tsx is a server
// component so it can export `force-dynamic`, but cookies() and headers()
// from next/headers both return empty in the Next.js 16.2.x standalone build.
// This client component fetches auth via /api/users/me (a route handler that
// reads request.cookies directly) — same pattern as /account/page.tsx.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import AdminShell from "@/components/admin/admin-shell";
import { isPlatformSuperadmin } from "@/lib/authorization";
import type { Viewer } from "@/lib/viewer";

export default function AdminLayoutGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      const res = await fetch("/api/users/me");
      if (res.status === 401 || res.status === 403 || !res.ok) {
        router.replace("/login");
        return;
      }
      const data = await res.json();
      const user: Viewer = {
        id: data.user.id,
        email: data.user.email,
        username: data.user.username,
        displayName: data.user.displayName,
        role: data.user.role,
        emailVerified: data.user.emailVerified,
        avatarUrl: data.user.avatarUrl ?? null,
        oauthProviders: (data.oauthAccounts ?? []).map((a: { provider: string }) => a.provider),
        hasPassword: data.user.hasPassword ?? false,
      };
      if (!isPlatformSuperadmin(user.role)) {
        router.replace("/account");
        return;
      }
      setViewer(user);
      setChecking(false);
    }

    void checkAuth();
  }, [router]);

  if (checking || !viewer) {
    return null;
  }

  return <AdminShell viewer={viewer}>{children}</AdminShell>;
}
