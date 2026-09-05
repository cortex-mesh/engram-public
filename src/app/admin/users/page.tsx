import CreateAdminUserForm from "@/components/admin/create-admin-user-form";
import AdminUserDirectory from "@/components/admin/admin-user-directory";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdminPageSuperadmin } from "@/lib/admin-server-auth";
import { listAdminClients, listAdminUsers } from "@/lib/admin-console";

export default async function AdminUsersPage() {
  await requireAdminPageSuperadmin();
  const [users, organizations] = await Promise.all([listAdminUsers(), listAdminClients()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">
          Global hosted-suite user directory, including platform role and org memberships.
        </p>
      </div>

      <CreateAdminUserForm
        organizations={organizations.map((organization) => ({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
        }))}
      />

      <Card>
        <CardHeader>
          <CardTitle>User directory</CardTitle>
          <CardDescription>
            Platform superadmins can inspect users across all clients here and reset a user's temporary password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AdminUserDirectory users={users} />
        </CardContent>
      </Card>
    </div>
  );
}
