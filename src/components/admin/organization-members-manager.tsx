"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminClientMember } from "@/lib/admin-console";
import type { OrgRole } from "@/lib/authorization";

const ORG_ROLES: OrgRole[] = ["OWNER", "ADMIN", "MEMBER"];

export default function OrganizationMembersManager({
  orgId,
  members,
}: {
  orgId: string;
  members: AdminClientMember[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("MEMBER");
  const [error, setError] = useState<string | null>(null);

  function updateRole(userId: string, nextRole: OrgRole) {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/orgs/${orgId}/members/${userId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ role: nextRole }),
        });
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to update member role.");
        }
        router.refresh();
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to update member role.");
      }
    });
  }

  function removeMember(userId: string) {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/orgs/${orgId}/members/${userId}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to remove member.");
        }
        router.refresh();
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to remove member.");
      }
    });
  }

  function addMember() {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/orgs/${orgId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email, role }),
        });
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to add member.");
        }
        setEmail("");
        setRole("MEMBER");
        router.refresh();
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to add member.");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border p-4">
        <div className="mb-3">
          <div className="font-medium">Add user</div>
          <div className="text-sm text-muted-foreground">
            Add an existing CORTEX user to this organization and assign an org role.
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
          <Input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="member@example.com"
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as OrgRole)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {ORG_ROLES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <Button type="button" disabled={isPending || !email.trim()} onClick={addMember}>
            {isPending ? "Saving…" : "Add member"}
          </Button>
        </div>
      </div>

      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Platform role</th>
              <th className="px-3 py-2 font-medium">Org role</th>
              <th className="px-3 py-2 font-medium">Joined</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id} className="border-b border-border/60 align-top">
                <td className="px-3 py-3">
                  <div className="font-medium">{member.displayName}</div>
                  <div className="text-xs text-muted-foreground">{member.email}</div>
                </td>
                <td className="px-3 py-3 text-muted-foreground">{member.platformRole}</td>
                <td className="px-3 py-3">
                  <select
                    value={member.orgRole}
                    onChange={(event) => updateRole(member.id, event.target.value as OrgRole)}
                    disabled={isPending}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {ORG_ROLES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  {new Date(member.joinedAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-3">
                  <Button type="button" variant="outline" disabled={isPending} onClick={() => removeMember(member.id)}>
                    Remove
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
