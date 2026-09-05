import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { extractRequestedClientIds, getPublicAuthClientConfig, toUrlSearchParams, type AuthSearchParams } from "@/lib/auth-client-config";
import { brandThemeForClient } from "@/lib/auth-brand-theme";
import { resolveAuthClientForRequest } from "@/lib/auth-host-client";
import { AuthShell } from "@/components/auth/auth-shell";
import { SetPasswordForm } from "./set-password-form";

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: Promise<AuthSearchParams>;
}): Promise<Metadata> {
  const clientConfig = await resolveClientConfig(searchParams);
  return {
    title: clientConfig.brandName,
    description: clientConfig.securedByEngram ? clientConfig.brandTagline : "Almost there.",
  };
}

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams?: Promise<AuthSearchParams>;
}) {
  const clientConfig = await resolveClientConfig(searchParams);

  return (
    <AuthShell
      className="mesh-auth-shell--compact"
      brandTheme={brandThemeForClient(clientConfig.clientId)}
      brandName={clientConfig.brandName}
      brandTagline={clientConfig.securedByEngram ? clientConfig.brandTagline : "Almost there."}
      brandLogoUrl={clientConfig.brandLogoUrl}
      supportingCopy={
        clientConfig.securedByEngram
          ? `Create a password to activate your ${clientConfig.brandName} account.`
          : "Create a password to activate your account."
      }
    >
      <Suspense>
        <SetPasswordForm brandName={clientConfig.brandName} clientId={clientConfig.clientId} />
      </Suspense>
    </AuthShell>
  );
}
async function resolveClientConfig(searchParams: Promise<AuthSearchParams> | AuthSearchParams | undefined) {
  const params = toUrlSearchParams(searchParams instanceof Promise ? await searchParams : searchParams ?? {});
  const resolution = resolveAuthClientForRequest(extractRequestedClientIds(params), await headers());
  if (resolution.rejected) notFound();
  return getPublicAuthClientConfig(resolution.clientId);
}
