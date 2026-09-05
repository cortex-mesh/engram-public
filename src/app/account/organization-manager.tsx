"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OrganizationSummary } from "@/lib/organizations";

interface OrganizationManagerProps {
  initialOrganizations: OrganizationSummary[];
}

export default function OrganizationManager({
  initialOrganizations,
}: OrganizationManagerProps) {
  const [organizations, setOrganizations] = useState(initialOrganizations);

  async function updateOrganization(
    organizationId: string,
    updates: { name: string; slug: string },
  ) {
    const response = await fetch(`/api/orgs/${organizationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });

    const data = (await response.json()) as {
      error?: string;
      organization?: OrganizationSummary;
    };

    if (!response.ok || !data.organization) {
      throw new Error(data.error || "Failed to update organization.");
    }

    setOrganizations((current) =>
      current.map((organization) =>
        organization.id === organizationId ? data.organization! : organization,
      ),
    );
  }

  return (
    <div className="space-y-4" id="organizations">
      <div className="space-y-3">
        {organizations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            You are not a member of any organizations yet.
          </div>
        ) : (
          organizations.map((organization) => (
            <OrganizationCard
              key={organization.id}
              organization={organization}
              onSave={updateOrganization}
            />
          ))
        )}
      </div>

      <div className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
        Organization creation now lives in the platform admin console. Use the Clients page to
        provision new organizations.
      </div>
    </div>
  );
}

function OrganizationCard({
  organization,
  onSave,
}: {
  organization: OrganizationSummary;
  onSave: (organizationId: string, updates: { name: string; slug: string }) => Promise<void>;
}) {
  const [name, setName] = useState(organization.name);
  const [slug, setSlug] = useState(organization.slug);
  const [state, setState] = useState<{
    pending: boolean;
    error: string | null;
    success: string | null;
  }>({ pending: false, error: null, success: null });

  const canManage = organization.role === "OWNER" || organization.role === "ADMIN";

  async function handleSave() {
    setState({ pending: true, error: null, success: null });

    try {
      await onSave(organization.id, { name, slug });
      setState({ pending: false, error: null, success: "Organization updated." });
    } catch (error) {
      setState({
        pending: false,
        error:
          error instanceof Error ? error.message : "Failed to update organization.",
        success: null,
      });
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card/70 p-4 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium leading-tight">{organization.name}</div>
          <div className="text-sm text-muted-foreground">
            {organization.memberCount} member{organization.memberCount === 1 ? "" : "s"} • {organization.role}
          </div>
        </div>
        <div className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
          Updated {new Date(organization.updatedAt).toLocaleDateString()}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="text-muted-foreground">Name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!canManage || state.pending}
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="text-muted-foreground">Slug</span>
          <Input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            disabled={!canManage || state.pending}
          />
        </label>
      </div>

      {!canManage && (
        <p className="text-sm text-muted-foreground">
          Only organization admins and owners can update org identity details.
        </p>
      )}

      {state.error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </div>
      )}
      {state.success && (
        <div className="rounded-md bg-primary/10 px-3 py-2 text-sm text-primary">
          {state.success}
        </div>
      )}

      {canManage && (
        <Button type="button" onClick={handleSave} disabled={state.pending} size="sm">
          {state.pending ? "Saving…" : "Save changes"}
        </Button>
      )}
    </div>
  );
}
