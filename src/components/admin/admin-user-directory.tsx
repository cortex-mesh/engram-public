"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import type { AdminUserSummary } from "@/lib/admin-console";

export default function AdminUserDirectory({ users }: { users: AdminUserSummary[] }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [resetInfo, setResetInfo] = useState<{ email: string; temporaryPassword: string } | null>(null);

  function resetPassword(user: AdminUserSummary) {
    setError(null);
    setResetInfo(null);

    startTransition(async () => {
      try {
        const response = await fetch(`/api/admin/users/${user.id}/password`, {
          method: "POST",
          credentials: "same-origin",
        });
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; temporaryPassword?: string; user?: { email?: string } }
          | null;

        if (!response.ok) {
          throw new Error(payload?.error || "Failed to reset password.");
        }

        setResetInfo({
          email: payload?.user?.email || user.email,
          temporaryPassword: payload?.temporaryPassword || "",
        });
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to reset password.");
      }
    });
  }

  return (
    <div className="space-y-4">
      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      {resetInfo ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <div className="font-medium">Temporary password reset</div>
          <div className="mt-1 text-muted-foreground">{resetInfo.email}</div>
          <div className="mt-2 font-mono">{resetInfo.temporaryPassword}</div>
          <div className="mt-1 text-muted-foreground">
            Share it securely with the user and ask them to rotate it after first login.
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Platform role</th>
              <th className="px-3 py-2 font-medium">Organizations</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-border/60 align-top">
                <td className="px-3 py-3">
                  <div className="font-medium">{user.displayName}</div>
                  <div className="text-xs text-muted-foreground">{user.email}</div>
                  <div className="text-xs text-muted-foreground">@{user.username}</div>
                </td>
                <td className="px-3 py-3 text-muted-foreground">{user.role}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-2">
                    {user.organizations.length > 0 ? (
                      user.organizations.map((org) => (
                        <span key={org.id} className="rounded-full bg-accent px-2 py-1 text-xs text-foreground">
                          {org.name} · {org.role}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">No org memberships</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-3 text-right">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isPending || user.role === "SUPERADMIN"}
                    onClick={() => resetPassword(user)}
                  >
                    Reset password
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
