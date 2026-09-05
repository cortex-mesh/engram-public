// force-dynamic prevents Next.js from statically pre-rendering admin pages
// during build (they call the DB). Each admin page also calls a server-side
// superadmin guard before fetching data; AdminLayoutGuard remains a UX nicety.
export const dynamic = "force-dynamic";

import AdminLayoutGuard from "@/components/admin/admin-layout-guard";
import { requireAdminPageSuperadmin } from "@/lib/admin-server-auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPageSuperadmin();
  return <AdminLayoutGuard>{children}</AdminLayoutGuard>;
}
