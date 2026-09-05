import { redirect } from "next/navigation";

// force-dynamic ensures this is never statically rendered at build time.
export const dynamic = "force-dynamic";

// Delegate to the /api/auth/continue route handler, which uses request.cookies
// directly (not the broken cookies() server-component API). The handler handles
// token validation, refresh rotation, and post-login target resolution — the
// same logic that was in this server component, but on a reliable code path.
export default function Home() {
  redirect("/api/auth/continue");
}
