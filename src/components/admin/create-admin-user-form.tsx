"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OrgRole } from "@/lib/authorization";

const ORG_ROLES: OrgRole[] = ["OWNER", "ADMIN", "MEMBER"];

export default function CreateAdminUserForm({
  organizations,
}: {
  organizations: Array<{ id: string; name: string; slug: string }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgId, setOrgId] = useState("");
  const [orgRole, setOrgRole] = useState<OrgRole>("MEMBER");
  const [error, setError] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);

  function createUser() {
    setError(null);
    setTemporaryPassword(null);

    startTransition(async () => {
      try {
        const response = await fetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            email,
            displayName,
            orgId: orgId || undefined,
            orgRole: orgId ? orgRole : undefined,
          }),
        });

        const payload = (await response.json().catch(() => null)) as
          | { error?: string; temporaryPassword?: string }
          | null;

        if (!response.ok) {
          throw new Error(payload?.error || "Failed to create user.");
        }

        setEmail("");
        setDisplayName("");
        setOrgId("");
        setOrgRole("MEMBER");
        setTemporaryPassword(payload?.temporaryPassword || null);
        router.refresh();
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to create user.");
      }
    });
  }

  return (
    <div className="rounded-xl border border-border p-4 space-y-4">
      <div>
        <div className="font-medium">Create user</div>
        <div className="text-sm text-muted-foreground">
          Create a hosted-suite user and optionally attach them to a specific organization right away.
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Display name</span>
          <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Roland Parnaso" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Email</span>
          <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="roland@example.com" />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Organization</span>
          <select
            value={orgId}
            onChange={(event) => setOrgId(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">No organization yet</option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name} · {organization.slug}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Org role</span>
          <select
            value={orgRole}
            onChange={(event) => setOrgRole(event.target.value as OrgRole)}
            disabled={!orgId}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60"
          >
            {ORG_ROLES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <Button type="button" disabled={isPending || !email.trim() || !displayName.trim()} onClick={createUser}>
            {isPending ? "Creating…" : "Create user"}
          </Button>
        </div>
      </div>

      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      {temporaryPassword ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <div className="font-medium">Temporary password</div>
          <div className="mt-1 font-mono">{temporaryPassword}</div>
          <div className="mt-1 text-muted-foreground">
            Share it securely with the user and rotate it after first login.
          </div>
        </div>
      ) : null}
    </div>
  );
}
