# Cite the Move production auth preparation

This is a preparation-only runbook. It neither deploys Engram nor creates DNS,
certificates, OAuth registrations, secrets, or production data.

## Infrastructure synthesis boundary

The production CDK model declares `PROD_AUTH_HOSTNAME=auth.citethemove.com` as
an ACM certificate SAN and CloudFront alias. Its synth assertions also prove
that no Route 53 record is emitted for this Cloudflare-managed hostname. This
is planning evidence only: do not run CDK deploy, create an ACM certificate,
change Cloudflare/DNS, or register provider-console callbacks at this stage.

Local non-mutating checks:

```sh
(cd infra/cdk && npm run typecheck && npm test && npm run cdk:synth)
```

## Runtime boundary

At the later human deployment gate, `ENGRAM_ALLOWED_HOSTS` must contain the
exact authorities `login.ctxhost.com,auth.citethemove.com` (plus any separately
approved existing hosts). `ENGRAM_URL` remains the canonical Engram origin;
the allowlist is what permits the Cite host to be used for public links,
provider callbacks, CORS, and cookie-write CSRF trust. Cookies remain host-only
and are not shared with `login.ctxhost.com`.

The Cite host is bound only to `axon-web`. Bare `/login`, `/register`, and
`/set-password` resolve that client. An explicit, different `client_id` is a
client-isolation error, not a fallback to another theme. The Google and GitHub
callback paths are therefore `https://auth.citethemove.com/api/auth/oauth/<provider>/callback`;
provider-console registration is a separate human action.

## Client callback reconciliation

The only allowed Cite production native redirect URI is:

`https://app.citethemove.com/auth/callback`

Before a human approval, inspect drift without mutation:

```sh
npm run reconcile:cite-production-client
```

The command requires a scoped database connection but never prints it. It
refuses to create `axon-web`, reports only redirect-URI drift, and defaults to
`dry-run`. After explicit approval, its apply mode also requires the literal
confirmation value below and transactionally enables the approved callback
while removing every other `axon-web` callback:

```sh
ENGRAM_RECONCILE_CONFIRM=citethemove-production-client \
  npm run reconcile:cite-production-client -- --apply
```

Do not run apply until the final human production gate. Re-running after a
successful application is idempotent and reports no drift.
