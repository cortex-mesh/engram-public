"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  MessageSquare,
  ListTodo,
  TrendingUp,
  HeartPulse,
  Wallet,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import type { CortexApp } from "@/lib/apps";
import type { OrganizationSummary } from "@/lib/organizations";
import { isPlatformSuperadmin } from "@/lib/authorization";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import LogoutButton from "./logout-button";
import OrganizationManager from "./organization-manager";
import SetPasswordButton from "./set-password-button";
import type { PublicAuthClientConfig } from "@/lib/auth-client-config";

const ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard,
  MessageSquare,
  ListTodo,
  TrendingUp,
  HeartPulse,
  Wallet,
};

interface UserProfile {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  role: string;
  hasPassword: boolean;
}

interface OAuthAccount {
  provider: string;
  providerAccountId: string;
}

interface AccountClientProps {
  apps: CortexApp[];
  platformAdminUrl: string | null;
}

const DEFAULT_CLIENT_CONFIG: Pick<PublicAuthClientConfig, "clientId" | "brandName" | "brandTagline" | "securedByEngram"> = {
  clientId: null,
  brandName: "CORTEX",
  brandTagline: "Secure sign-in for your workspace",
  securedByEngram: false,
};

export default function AccountClient({ apps, platformAdminUrl }: AccountClientProps) {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [authContext, setAuthContext] = useState<{
    clientId: string | null;
  }>({ clientId: null });
  const [clientConfig, setClientConfig] = useState(DEFAULT_CLIENT_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const params = new URLSearchParams(window.location.search);
      setAuthContext({
        clientId: params.get("client_id"),
      });

      const [meRes, orgsRes, clientConfigRes] = await Promise.all([
        fetch("/api/users/me"),
        fetch("/api/orgs"),
        fetch(`/api/auth/client-config?${params.toString()}`),
      ]);

      if (meRes.status === 401 || meRes.status === 403) {
        router.push("/login");
        return;
      }

      if (!meRes.ok || !orgsRes.ok) {
        setLoading(false);
        return;
      }

      const meData = await meRes.json();
      const orgsData = await orgsRes.json();
      const resolvedClientConfig = clientConfigRes.ok
        ? await clientConfigRes.json().catch(() => DEFAULT_CLIENT_CONFIG)
        : DEFAULT_CLIENT_CONFIG;

      setUser(meData.user);
      setOauthProviders(
        (meData.oauthAccounts as OAuthAccount[]).map((a) => a.provider),
      );
      setOrganizations(orgsData.organizations ?? []);
      setClientConfig({ ...DEFAULT_CLIENT_CONFIG, ...resolvedClientConfig });
      setLoading(false);
    }

    void load();
  }, [router]);

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-8">
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Loading…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const loginUrl = typeof window !== "undefined"
    ? `${window.location.origin}/login`
    : "/login";
  const brandedClient = clientConfig.securedByEngram;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-8">
      {!brandedClient && apps.length > 0 ? (
        <Card className="gap-5">
          <CardHeader>
            <CardTitle>CORTEX Apps</CardTitle>
            <CardDescription>
              You&apos;re signed in. Launch any app below — your session works
              across the whole CORTEX suite.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {apps.map((app) => {
                const Icon = ICON_MAP[app.icon] || ExternalLink;
                return (
                  <a
                    key={app.key}
                    href={app.url}
                    className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <div className="font-medium">{app.name}</div>
                        <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {app.description}
                      </div>
                    </div>
                  </a>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="gap-5">
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Your {clientConfig.brandName} identity profile</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center gap-4">
            {user.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatarUrl}
                alt="Avatar"
                className="h-14 w-14 rounded-full border border-border"
              />
            )}
            <div>
              <div className="text-lg font-medium">
                {user.displayName || user.username}
              </div>
              <div className="text-sm text-muted-foreground">{user.email}</div>
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border border-border/70 bg-muted/20 p-4 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-muted-foreground">Username</span>
              <span className="font-mono sm:mt-1 sm:block">{user.username}</span>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-muted-foreground">Role</span>
              <span className="sm:mt-1 sm:block">{user.role}</span>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-muted-foreground">Email verified</span>
              <span className="sm:mt-1 sm:block">{user.emailVerified ? "Yes" : "No"}</span>
            </div>
            <div className="flex justify-between gap-4 sm:block">
              <span className="text-muted-foreground">Linked accounts</span>
              <span className="sm:mt-1 sm:block">
                {oauthProviders.length > 0
                  ? oauthProviders.join(", ")
                  : "None"}
              </span>
            </div>
          </div>

          {isPlatformSuperadmin(user.role) && platformAdminUrl ? (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
              <div className="font-medium">Platform admin console</div>
              <div className="mt-1 text-sm text-muted-foreground">
                You can manage hosted clients, users, apps, and feature flags across
                the suite.
              </div>
              <Link
                href={platformAdminUrl}
                className="mt-3 inline-flex rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                Open admin console
              </Link>
            </div>
          ) : null}

          {!user.hasPassword ? (
            <div className="rounded-lg border border-border p-4">
              <div className="font-medium">Add a password</div>
              <div className="mt-1 mb-3 text-sm text-muted-foreground">
                You sign in with a linked provider. Add a password to also sign
                in with your email — we&apos;ll email you a link to set it.
              </div>
              <SetPasswordButton clientId={authContext.clientId} />
            </div>
          ) : null}

          <LogoutButton loginUrl={loginUrl} />
        </CardContent>
      </Card>

      {!brandedClient ? (
        <Card className="gap-5">
          <CardHeader>
            <CardTitle>Organizations</CardTitle>
            <CardDescription>
              Minimal centralized organization management is now available for CORTEX.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrganizationManager initialOrganizations={organizations} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
