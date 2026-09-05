import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdminPageSuperadmin } from "@/lib/admin-server-auth";
import { getAdminOverview } from "@/lib/admin-console";

function StatCard({ label, value, description }: { label: string; value: number; description: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{description}</CardContent>
    </Card>
  );
}

export default async function AdminOverviewPage() {
  await requireAdminPageSuperadmin();
  const overview = await getAdminOverview();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Current hosted-suite control-plane summary for clients, users, app rollout,
          and feature rollout.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Clients"
          value={overview.stats.clientCount}
          description="Organizations currently provisioned for CORTEX."
        />
        <StatCard
          label="Users"
          value={overview.stats.userCount}
          description="Human identities known to the hosted platform."
        />
        <StatCard
          label="Memberships"
          value={overview.stats.membershipCount}
          description="User-to-client relationships across all orgs."
        />
        <StatCard
          label="Enabled apps"
          value={overview.stats.enabledAppCount}
          description="Org app entitlements currently enabled."
        />
        <StatCard
          label="Enabled features"
          value={overview.stats.enabledFeatureCount}
          description="Org feature entitlements currently enabled."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent clients</CardTitle>
          <CardDescription>Newest organizations currently visible to the hosted platform.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {overview.recentClients.map((client) => (
              <div
                key={client.id}
                className="flex flex-col gap-3 rounded-xl border border-border p-4 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <div className="font-medium">{client.name}</div>
                  <div className="text-sm text-muted-foreground">{client.slug}.ctxhost.com</div>
                </div>
                <div className="text-sm text-muted-foreground">
                  {client.memberCount} member{client.memberCount === 1 ? "" : "s"} · {client.enabledApps.length} app
                  {client.enabledApps.length === 1 ? "" : "s"} enabled
                </div>
                <Link
                  href={`/admin/clients/${client.id}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Open client
                </Link>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
