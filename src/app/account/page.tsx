import AccountClient from "@/app/account/account-client";
import { getCortexApps, getOptionalPlatformAdminUrl } from "@/lib/apps";

// force-dynamic keeps runtime env resolution in the container deploy path.
export const dynamic = "force-dynamic";

export default function AccountPage() {
  return (
    <AccountClient
      apps={getCortexApps()}
      platformAdminUrl={getOptionalPlatformAdminUrl()}
    />
  );
}
