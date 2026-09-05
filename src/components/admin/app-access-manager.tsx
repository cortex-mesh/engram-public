"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { AdminClientMember } from "@/lib/admin-console";
import type { AppAccessMode } from "@/lib/app-access";
import { isOrgManager, type AppKey } from "@/lib/authorization";

interface OverrideRow {
  user: { id: string };
  enabled: boolean;
}

export default function AppAccessManager({
  orgId,
  appKey,
  appName,
  appEnabled,
  accessMode,
  members,
}: {
  orgId: string;
  appKey: AppKey;
  appName: string;
  appEnabled: boolean;
  accessMode: AppAccessMode;
  members: AdminClientMember[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [modeError, setModeError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overridesLoaded, setOverridesLoaded] = useState(false);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [overrideError, setOverrideError] = useState<string | null>(null);

  function setAccessMode(nextMode: AppAccessMode) {
    setModeError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/orgs/${orgId}/app-entitlements/${appKey}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ accessMode: nextMode }),
        });
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) {
          throw new Error(payload?.error || `Failed to update ${appName} access mode.`);
        }
        router.refresh();
      } catch (caughtError) {
        setModeError(
          caughtError instanceof Error ? caughtError.message : `Failed to update ${appName} access mode.`,
        );
      }
    });
  }

  async function loadOverrides() {
    setOverrideError(null);
    try {
      const response = await fetch(`/api/orgs/${orgId}/app-entitlements/${appKey}/users`, {
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => null)) as
        | { userAppEntitlements?: OverrideRow[]; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || `Failed to load ${appName} member access.`);
      }
      const next = new Map<string, boolean>();
      for (const row of payload?.userAppEntitlements || []) {
        next.set(row.user.id, row.enabled);
      }
      setOverrides(next);
      setOverridesLoaded(true);
    } catch (caughtError) {
      setOverrideError(
        caughtError instanceof Error ? caughtError.message : `Failed to load ${appName} member access.`,
      );
    }
  }

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next && !overridesLoaded) {
      void loadOverrides();
    }
  }

  // nextEnabled === null removes the override (falls back to the mode's default).
  function setMemberOverride(userId: string, nextEnabled: boolean | null) {
    setOverrideError(null);
    startTransition(async () => {
      try {
        if (nextEnabled === null) {
          const response = await fetch(`/api/orgs/${orgId}/users/${userId}/app-entitlements/${appKey}`, {
            method: "DELETE",
            credentials: "same-origin",
          });
          if (!response.ok && response.status !== 404) {
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(payload?.error || "Failed to update member access.");
          }
          setOverrides((prev) => {
            const next = new Map(prev);
            next.delete(userId);
            return next;
          });
        } else {
          const response = await fetch(`/api/orgs/${orgId}/users/${userId}/app-entitlements`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ appKey, enabled: nextEnabled }),
          });
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          if (!response.ok) {
            throw new Error(payload?.error || "Failed to update member access.");
          }
          setOverrides((prev) => new Map(prev).set(userId, nextEnabled));
        }
      } catch (caughtError) {
        setOverrideError(
          caughtError instanceof Error ? caughtError.message : "Failed to update member access.",
        );
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-full border border-border text-xs font-medium">
          <button
            type="button"
            disabled={!appEnabled || isPending || accessMode === "ALL_MEMBERS"}
            onClick={() => setAccessMode("ALL_MEMBERS")}
            className={[
              "px-3 py-1 transition-colors",
              accessMode === "ALL_MEMBERS"
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
            ].join(" ")}
          >
            All members
          </button>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                disabled={!appEnabled || isPending || accessMode === "RESTRICTED"}
                className={[
                  "border-l border-border px-3 py-1 transition-colors",
                  accessMode === "RESTRICTED"
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
                ].join(" ")}
              >
                Restricted
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Restrict access to {appName}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Only this org&apos;s owners/admins and members you explicitly allow-list below will be
                  able to open {appName}. Every other member loses access immediately, including anyone
                  not yet added to the allow-list.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmOpen(false);
                    setAccessMode("RESTRICTED");
                  }}
                >
                  Restrict access
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {isPending ? <span className="text-xs text-muted-foreground">Saving…</span> : null}
        <button
          type="button"
          disabled={!appEnabled}
          onClick={toggleExpanded}
          className="text-xs font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline"
        >
          {expanded ? "Hide member access" : "Manage member access"}
        </button>
      </div>
      {modeError ? <div className="text-xs text-destructive">{modeError}</div> : null}
      {!appEnabled ? (
        <div className="text-xs text-muted-foreground">
          Enable the {appName} app first before setting its access mode.
        </div>
      ) : null}

      {expanded && appEnabled ? (
        <div className="rounded-lg border border-border">
          {!overridesLoaded && !overrideError ? (
            <div className="p-3 text-xs text-muted-foreground">Loading member access…</div>
          ) : null}
          {overrideError ? <div className="p-3 text-xs text-destructive">{overrideError}</div> : null}
          {overridesLoaded ? (
            members.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">This organization has no members yet.</div>
            ) : (
              <table className="min-w-full text-xs">
                <thead className="border-b border-border text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Member</th>
                    <th className="px-3 py-2 font-medium">Org role</th>
                    <th className="px-3 py-2 font-medium">
                      {accessMode === "RESTRICTED" ? "Allowed" : "Denied"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => {
                    const overrideEnabled = overrides.get(member.id);
                    const managerAlwaysAllowed = accessMode === "RESTRICTED" && isOrgManager(member.orgRole);
                    const checked =
                      accessMode === "RESTRICTED" ? overrideEnabled === true : overrideEnabled === false;

                    return (
                      <tr key={member.id} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2">
                          <div className="font-medium">{member.displayName}</div>
                          <div className="text-muted-foreground">{member.email}</div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {member.orgRole}
                          {managerAlwaysAllowed ? (
                            <div className="text-[10px]">Always allowed (org manager)</div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isPending}
                            onChange={(event) =>
                              setMemberOverride(
                                member.id,
                                event.target.checked ? accessMode === "RESTRICTED" : null,
                              )
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
