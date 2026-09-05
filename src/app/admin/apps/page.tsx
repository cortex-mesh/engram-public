import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdminPageSuperadmin } from "@/lib/admin-server-auth";
import { listAdminApps } from "@/lib/admin-console";

export default async function AdminAppsPage() {
  await requireAdminPageSuperadmin();
  const apps = await listAdminApps();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
        <p className="text-sm text-muted-foreground">
          Global hosted app catalog and how many clients currently have each app enabled.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {apps.map((app) => (
          <Card key={app.key}>
            <CardHeader>
              <CardTitle>{app.name}</CardTitle>
              <CardDescription>{app.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Key</span>
                <span className="font-mono">{app.key}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Enabled clients</span>
                <span>{app.enabledClientCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Feature flags</span>
                <span>{app.featureCount}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
