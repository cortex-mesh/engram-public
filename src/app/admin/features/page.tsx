import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdminPageSuperadmin } from "@/lib/admin-server-auth";
import { listAdminFeatures } from "@/lib/admin-console";

export default async function AdminFeaturesPage() {
  await requireAdminPageSuperadmin();
  const features = await listAdminFeatures();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Feature flags</h1>
        <p className="text-sm text-muted-foreground">
          Global feature registry and current org rollout across the hosted suite.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Feature registry</CardTitle>
          <CardDescription>
            Feature flags remain app-scoped but are rolled out centrally by the hosted platform.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Feature</th>
                <th className="px-3 py-2 font-medium">App</th>
                <th className="px-3 py-2 font-medium">Enabled clients</th>
              </tr>
            </thead>
            <tbody>
              {features.map((feature) => (
                <tr key={`${feature.appKey}:${feature.featureKey}`} className="border-b border-border/60 align-top">
                  <td className="px-3 py-3">
                    <div className="font-medium">{feature.featureName}</div>
                    <div className="text-xs text-muted-foreground">{feature.description}</div>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{feature.appName}</td>
                  <td className="px-3 py-3 text-muted-foreground">{feature.enabledClientCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
