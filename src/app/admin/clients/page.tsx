import Link from "next/link";

import CreateOrganizationForm from "@/components/admin/create-organization-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdminPageSuperadmin } from "@/lib/admin-server-auth";
import { listAdminClients } from "@/lib/admin-console";

export default async function AdminClientsPage() {
  await requireAdminPageSuperadmin();
  const clients = await listAdminClients();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <p className="text-sm text-muted-foreground">
          View every hosted organization, its member count, and its currently enabled apps
          and feature flags.
        </p>
      </div>

      <CreateOrganizationForm />

      <Card>
        <CardHeader>
          <CardTitle>Client directory</CardTitle>
          <CardDescription>Organizations are the source-of-truth client records for CORTEX.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Members</th>
                <th className="px-3 py-2 font-medium">Apps</th>
                <th className="px-3 py-2 font-medium">Features</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id} className="border-b border-border/60 align-top">
                  <td className="px-3 py-3">
                    <div className="font-medium">{client.name}</div>
                    <div className="text-xs text-muted-foreground">{client.slug}.ctxhost.com</div>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{client.memberCount}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-2">
                      {client.enabledApps.length > 0 ? (
                        client.enabledApps.map((app) => (
                          <span key={app} className="rounded-full bg-accent px-2 py-1 text-xs text-foreground">
                            {app}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">No apps enabled</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-2">
                      {client.enabledFeatures.length > 0 ? (
                        client.enabledFeatures.map((feature) => (
                          <span
                            key={feature}
                            className="rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground"
                          >
                            {feature}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">No features enabled</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {new Date(client.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Link href={`/admin/clients/${client.id}`} className="font-medium text-primary hover:underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
