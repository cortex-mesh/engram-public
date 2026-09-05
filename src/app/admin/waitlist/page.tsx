import AdminWaitlistQueue from "@/components/admin/admin-waitlist-queue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdminPageSuperadmin } from "@/lib/admin-server-auth";
import { listAdminWaitlistRequestPage } from "@/lib/admin-console";

export default async function AdminWaitlistPage({
  searchParams,
}: {
  searchParams?: Promise<{ cursor?: string; visibility?: string }>;
} = {}) {
  await requireAdminPageSuperadmin();
  const params = await searchParams;
  const waitlistPage = await listAdminWaitlistRequestPage({
    cursor: params?.cursor ?? null,
    visibility: params?.visibility ?? null,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Waitlist</h1>
        <p className="text-sm text-muted-foreground">
          Review client-tagged access requests and approve identity-only users.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Access requests</CardTitle>
          <CardDescription>
            Batch approval sends a set-password email. Accounts stay inactive until email control is proven.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AdminWaitlistQueue page={waitlistPage} />
        </CardContent>
      </Card>
    </div>
  );
}
