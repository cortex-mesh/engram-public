import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { extractRequestedClientIds, getPublicAuthClientConfig, toUrlSearchParams, type AuthSearchParams } from "@/lib/auth-client-config";
import { brandThemeForClient } from "@/lib/auth-brand-theme";
import { resolveAuthClientForRequest } from "@/lib/auth-host-client";
import { AuthShell } from "@/components/auth/auth-shell";
import { RegisterForm } from "./register-form";

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: Promise<AuthSearchParams>;
}): Promise<Metadata> {
  const clientConfig = await resolveClientConfig(searchParams);
  return {
    title: clientConfig.brandName,
    description: clientConfig.brandTagline,
  };
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams?: Promise<AuthSearchParams>;
}) {
  const initialClientConfig = await resolveClientConfig(searchParams);

  return (
    <AuthShell
      brandTheme={brandThemeForClient(initialClientConfig.clientId)}
      brandName={initialClientConfig.brandName}
      brandTagline={initialClientConfig.brandTagline}
      brandLogoUrl={initialClientConfig.brandLogoUrl}
      supportingCopy={
        initialClientConfig.securedByEngram
          ? `Request access to continue to ${initialClientConfig.brandName}.`
          : "Request access to your workspace."
      }
      showMeshFamily={!initialClientConfig.securedByEngram}
    >
      <Suspense>
        <RegisterForm initialClientConfig={initialClientConfig} />
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
