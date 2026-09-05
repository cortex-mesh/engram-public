"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { classifyPostLoginRedirect } from "@/lib/login-redirect";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { AuthCardIntro } from "@/components/auth/auth-card-intro";
import {
  REDIRECT_TARGET_PARAM,
  decodeRedirectTarget,
  encodeRedirectTarget,
} from "@/lib/redirect-target";

type OAuthProvider = "google" | "github";

interface AuthClientConfig {
  clientId: string | null;
  brandName: string;
  brandTagline: string;
  authProviders: OAuthProvider[];
  signupMode: "waitlist" | "open";
  securedByEngram: boolean;
}

const DEFAULT_CONFIG: AuthClientConfig = {
  clientId: null,
  brandName: "CORTEX",
  brandTagline: "One door into the mesh.",
  authProviders: ["google", "github"],
  signupMode: "waitlist",
  securedByEngram: false,
};

function clientIdFromRedirectUri(redirectUri: string): string | null {
  try {
    return new URL(redirectUri, window.location.origin).searchParams.get("client_id");
  } catch {
    return null;
  }
}

function ProviderButtons({
  providers,
  redirectUri,
  clientId,
}: {
  providers: OAuthProvider[];
  redirectUri: string;
  clientId: string | null;
}) {
  const providerParams = new URLSearchParams();
  if (redirectUri) {
    providerParams.set("redirect_uri", redirectUri);
    providerParams.set(REDIRECT_TARGET_PARAM, encodeRedirectTarget(redirectUri));
  }
  if (clientId) providerParams.set("client_id", clientId);

  const providerHref = (provider: OAuthProvider) => {
    const query = providerParams.toString();
    return `/api/auth/oauth/${provider}${query ? `?${query}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-2">
      {providers.includes("google") && (
        <Button
          variant="outline"
          className="w-full transition-transform active:translate-y-px"
          asChild
        >
          <a href={providerHref("google")}>
            <svg className="size-4" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </a>
        </Button>
      )}

      {providers.includes("github") && (
        <Button
          variant="outline"
          className="w-full transition-transform active:translate-y-px"
          asChild
        >
          <a href={providerHref("github")}>
            <svg className="size-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            Continue with GitHub
          </a>
        </Button>
      )}
    </div>
  );
}

export function buildLoginRequestContext(
  redirectUri: string,
  clientId: string | null,
): { redirectUri?: string; clientId?: string } {
  return {
    ...(redirectUri ? { redirectUri } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

export function LoginForm({ initialClientConfig }: { initialClientConfig: AuthClientConfig }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showMagicLink, setShowMagicLink] = useState(false);
  const [magicEmail, setMagicEmail] = useState("");
  const [magicSent, setMagicSent] = useState(false);
  const [magicLoading, setMagicLoading] = useState(false);
  const [clientConfig, setClientConfig] = useState<AuthClientConfig>(initialClientConfig);

  const redirectUri =
    decodeRedirectTarget(searchParams.get(REDIRECT_TARGET_PARAM)) ||
    searchParams.get("redirect_uri") ||
    "";
  const requestedClientId = useMemo(
    () => searchParams.get("client_id") || clientIdFromRedirectUri(redirectUri),
    [redirectUri, searchParams],
  );
  const authError = searchParams.get("error");
  const oauthWaitlistMessage =
    authError === "waitlist_required"
      ? "Your account is not enabled yet. Request access via the waitlist and we’ll follow up when it’s ready."
      : null;

  useEffect(() => {
    const params = new URLSearchParams();
    if (requestedClientId) params.set("client_id", requestedClientId);
    if (redirectUri) {
      params.set("redirect_uri", redirectUri);
      // Re-nesting the target here would recreate the very mangling this fix
      // removes — on the one request that decides which brand to show.
      params.set(REDIRECT_TARGET_PARAM, encodeRedirectTarget(redirectUri));
    }
    fetch(`/api/auth/client-config?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : DEFAULT_CONFIG))
      .then((config) => setClientConfig({ ...DEFAULT_CONFIG, ...config }))
      .catch(() => setClientConfig(DEFAULT_CONFIG));
  }, [redirectUri, requestedClientId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...buildLoginRequestContext(redirectUri, requestedClientId),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Invalid email or password");
        return;
      }

      const body = await res.json();
      const redirect = classifyPostLoginRedirect(
        body.postLoginTarget || "/account",
        window.location.origin,
      );
      if (redirect.kind === "external") {
        window.location.assign(redirect.target);
      } else {
        router.push(redirect.target);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMagicLoading(true);

    try {
      const res = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: magicEmail,
          ...buildLoginRequestContext(redirectUri, requestedClientId),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to send magic link");
        return;
      }

      setMagicSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setMagicLoading(false);
    }
  }

  const registerHref = `/register${requestedClientId ? `?client_id=${encodeURIComponent(requestedClientId)}` : ""}`;

  return (
    <Card className="border-border/70 bg-card/95 shadow-xl shadow-black/5 backdrop-blur-sm">
      <div className="px-6 pt-6">
        <AuthCardIntro
          eyebrow="Sign in"
          title={`Access ${clientConfig.brandName}`}
          description="Use your email, password, or a trusted provider to continue."
        />
      </div>
      <CardContent className="space-y-4 pt-6">
        {oauthWaitlistMessage && (
          <div className="mesh-notice mb-4 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary">
            {oauthWaitlistMessage}
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          <Button
            type="submit"
            disabled={loading}
            className="w-full transition-transform active:translate-y-px"
          >
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase tracking-[0.18em] text-muted-foreground/80">
            <span className="bg-card px-3 text-muted-foreground">or</span>
          </div>
        </div>

        <ProviderButtons
          providers={clientConfig.authProviders}
          redirectUri={redirectUri}
          clientId={clientConfig.clientId || requestedClientId}
        />

        {!showMagicLink ? (
          <button
            type="button"
            onClick={() => setShowMagicLink(true)}
            className="w-full rounded-sm text-center text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            Send magic link instead
          </button>
        ) : magicSent ? (
          <div className="mesh-notice rounded-md bg-primary/10 px-3 py-2 text-center text-sm text-primary">
            Check your email for a sign-in link.
          </div>
        ) : (
          <form onSubmit={handleMagicLink} className="mt-4 flex flex-col gap-2">
            <Input
              type="email"
              placeholder="you@example.com"
              value={magicEmail}
              onChange={(e) => setMagicEmail(e.target.value)}
              required
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={magicLoading}
              className="w-full transition-transform active:translate-y-px"
            >
              {magicLoading ? "Sending…" : "Send magic link"}
            </Button>
          </form>
        )}
      </CardContent>
      <CardFooter className="flex-col justify-center gap-2">
        <p className="text-sm text-muted-foreground">
          Need access?{" "}
          <Link
            href={registerHref}
            className="text-primary underline-offset-4 hover:underline"
          >
            {clientConfig.signupMode === "open" ? "Create an account" : "Join the waitlist"}
          </Link>
        </p>
        {clientConfig.securedByEngram && (
          <p className="text-xs text-muted-foreground">Secured by Engram</p>
        )}
      </CardFooter>
    </Card>
  );
}
