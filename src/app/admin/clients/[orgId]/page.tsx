import { notFound } from "next/navigation";

import AppAccessManager from "@/components/admin/app-access-manager";
import EntitlementToggle from "@/components/admin/entitlement-toggle";
import OrganizationMembersManager from "@/components/admin/organization-members-manager";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdminPageSuperadmin } from "@/lib/admin-server-auth";
import { getAdminClientDetail } from "@/lib/admin-console";

export default async function AdminClientDetailPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  await requireAdminPageSuperadmin();
  const { orgId } = await params;
  const client = await getAdminClientDetail(orgId);

  if (!client) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
        <p className="text-sm text-muted-foreground">
          {client.slug}.ctxhost.com · created {new Date(client.createdAt).toLocaleDateString()}
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Users and roles</CardTitle>
            <CardDescription>
              Add users to this client, change their org role, or remove them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrganizationMembersManager orgId={client.id} members={client.members} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Apps</CardTitle>
              <CardDescription>Enable or disable hosted app access for this client.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {client.apps.map((app) => (
                <div key={app.key} className="rounded-xl border border-border p-4">
                  <div className="mb-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="font-medium">{app.name}</div>
                      <div className="text-sm text-muted-foreground">{app.description}</div>
                    </div>
                    <EntitlementToggle
                      endpoint={`/api/orgs/${client.id}/app-entitlements`}
                      body={{ appKey: app.key }}
                      enabled={app.enabled}
                      label={`${app.name} app access`}
                    />
                  </div>
                  <AppAccessManager
                    orgId={client.id}
                    appKey={app.key}
                    appName={app.name}
                    appEnabled={app.enabled}
                    accessMode={app.accessMode}
                    members={client.members}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Feature flags</CardTitle>
              <CardDescription>Enable or disable org-level feature rollout inside an app.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {client.features.length === 0 ? (
                <div className="text-sm text-muted-foreground">No org-level feature flags are currently registered.</div>
              ) : (
                client.features.map((feature) => (
                  <div key={`${feature.appKey}:${feature.featureKey}`} className="rounded-xl border border-border p-4">
                    <div className="mb-2 flex items-center justify-between gap-4">
                      <div>
                        <div className="font-medium">{feature.appName} · {feature.featureName}</div>
                        <div className="text-sm text-muted-foreground">{feature.description}</div>
                      </div>
                      <EntitlementToggle
                        endpoint={`/api/orgs/${client.id}/feature-entitlements`}
                        body={{ appKey: feature.appKey, featureKey: feature.featureKey }}
                        enabled={feature.enabled}
                        disabled={!feature.appEnabled}
                        label={`${feature.appName} ${feature.featureName} feature`}
                      />
                    </div>
                    {!feature.appEnabled ? (
                      <div className="text-xs text-muted-foreground">
                        Enable the {feature.appName} app first before changing this feature flag.
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
