# Runbook: Engram prod promotion (auth.ccgtradepost.com / login.ctxhost.com)

How Engram app code reaches **aws-prod**. Written 2026-07-20 to close the gap
found when promoting the Tradepost auth theme: dev auto-deploys on merge, but
prod had no documented routine path.

## Policy (ADR-025 §11 — binding)

- **Prod never auto-deploys from a merge.** The dispatch-only workflow
  (`.github/workflows/deploy-prod.yml`) is the only sanctioned path.
- **Human-directed.** Roland (or a human he designates) decides each promotion.
  An agent **may** dispatch the workflow when explicitly directed to for that
  specific promotion, and must rehearse with `--dry-run` and report the plan
  first. An agent **never** promotes on its own initiative — not on a merge, not
  on a schedule, not inside an autonomous goal session. "Deploy when ready" is
  not a direction to promote. **No actor runs `cdk deploy`** directly against
  prod; the guarded workflow is the only path. (Amended 2026-08-14, ADR-025 §11;
  previously the dispatch itself was human-executed.)
- Deploys build from **`main` HEAD** (the workflow checks out `main`). What is
  merged is what ships.

## Topology (verified 2026-07-20)

Engram prod is **serverless** (no prod app-host EC2): CloudFront + Lambda via
app-scoped CDK stacks, all live in account `782369544445` / `us-west-2`:

| Stack | Purpose |
|---|---|
| `engram-prod-web` | the app (Lambda + CloudFront) — **routine promotions deploy this one** |
| `engram-prod-data` | RDS + proxy (schema/data — rarely touched; migrations are human-gated) |
| `engram-prod-ops` | alarms, budgets, log retention |
| `engram-prod-cert` (us-east-1) | ACM cert + CloudFront WAF |

Runtime secrets: `cortex/prod/engram/{runtime,oauth-google,jwt-rs256,email,db-admin}`
in Secrets Manager. Public hosts: `auth.ccgtradepost.com` (Tradepost's custom
domain) and `login.ctxhost.com`.

Current production consumers are Engram itself and Tradepost. Axon is expected
to join this prod surface next. Gyrus and Nexus are not current prod promotion
targets; their active hosted targets remain aws-dev and on-prem-host/on-prem.

## Preconditions (all required)

1. The change is **merged to `main`**, CI green on the head SHA.
2. The change is **live-verified on aws-dev** (`login.dev.ctxhost.com`) —
   including a real sign-in round-trip for auth-affecting changes.
3. No pending Prisma migration in the diff (migrations are a separate,
   human-approved event per the suite guardrail — never bundle one silently
   into a routine promotion).
4. Roland's explicit GO.
5. **Auth-integration baseline captured** —
   `./scripts/smoke-prod-auth.sh --save /tmp/prod-auth-baseline.txt`. Without a
   baseline taken *before* the dispatch there is nothing to compare against
   afterward, and a dropped integration becomes a judgment call instead of a
   diff. Failures in the baseline are pre-existing state, not a blocker.

> **Gotcha (CI-green precondition):** the `npm audit --audit-level=moderate`
> step in the required CI job fails *dynamically* when a new advisory is
> published against an already-installed dep — no code change needed. When it
> does, main CI goes red: the aws-dev auto-deploy is silently skipped **and**
> `promote-prod.sh`'s CI-green precondition will refuse to dispatch. Fix by
> bumping/overriding the pinned dep (see PR #189 for the pattern), not by
> relaxing the gate.

## Routine promotion (app code only)

**Always promote with the script — never hand-type the dispatch.** Immediately
before the preconditions and dispatch, it reads `CertificateArn` and `WebAclArn`
from the live `engram-prod-cert` CloudFormation stack in `us-east-1`. It uses
the `cortex` AWS profile by default; set `ENGRAM_AWS_PROFILE` to select a
different local credential profile without changing the fixed stack, region,
account validation, or input provenance. It refuses to dispatch if either
output is absent or has the wrong prod account/region/scope. It has no baked-in
certificate or WebACL ARN. It then
enforces the preconditions above (origin/main CI green + reachable
from HEAD, no pending Prisma migration in the diff) and prints the verify
checklist:

```bash
scripts/promote-prod.sh --dry-run  # rehearse: all preconditions, no dispatch
scripts/promote-prod.sh            # confirms interactively, then dispatches the web stack
scripts/promote-prod.sh --watch    # also follows the run to completion
scripts/promote-prod.sh --yes      # skip the confirmation prompt (still runs preconditions)
```

**Always start with `--dry-run`.** It runs every precondition — live cert-stack
resolution, CI green and reachable from HEAD, the live prod migration gate, and
the Cite enrollment secrets — then prints the exact dispatch inputs and exits
without dispatching. The plan it prints is produced by the same code path as the
real run, so a green dry run means the real run's preconditions hold. It cannot
be combined with `--yes` or `--watch`, which assert an intent to dispatch;
`--dry-run --yes` is rejected rather than silently doing one or the other.

A dry run that fails has done its job. The most common stop is the migration
gate reporting a migration in this build that prod has not applied — apply it
first via [`prod-db-migration-verify-apply.md`](prod-db-migration-verify-apply.md),
then rehearse again.

The script is the sanctioned path for a human to run; it does **not** relax the
human-dispatch rule — an agent still never invokes it on its own initiative.

### Removing a cross-stack export — `exportValue()`, not `--ref`

CloudFormation refuses to delete an export while another stack still imports it:

```
Cannot delete export engram-prod-data:ExportsOutputFnGetAttRdsProxy...Endpoint
as it is in use by engram-prod-web.
```

It refuses *before* changing anything, so the deploy rolls back and prod is
untouched. Hit for real on **2026-08-14** removing the RDS Proxy.

**The trap: the export is generated from a *reference*, not a resource.** CDK
emitted it only because `EngramProdWebStack` read `prodData.proxy.endpoint`.
Repointing `DATABASE_URL` at the instance deleted that reference and therefore
the export — even though the proxy resource itself was untouched.

That is why **`--ref` alone does not fix this**, and it was tried:

- Splitting the change across two commits does not help. *Every* variant where
  the web stack stops referencing the proxy drops the export, so promoting the
  earlier commit fails identically.
- Reverting does not help, for the same reason.
- Reordering stacks in one dispatch does not help: CDK deploys the producing
  stack first, and the consumer has not yet stopped importing.

**The fix is `Stack.exportValue()`**, which pins an export alive after its last
reference disappears:

```bash
# 1. Ship the resource STILL PRESENT, plus exportValue() pinning its export,
#    with the consumer repointed. Nothing is deleted; the consumer stops
#    importing. Ordinary promotion — main HEAD, no --ref.
scripts/promote-prod.sh --full --dry-run
scripts/promote-prod.sh --full

# 2. Verify, then ship the removal of the resource AND the exportValue() call
#    together. The export is now unimported and deletes cleanly.
scripts/promote-prod.sh --full
```

The export **name** is load-bearing — CloudFormation matches on it, and the live
consumer imports that exact string. While the pin is in place, assert the
synthesized name in a CDK template test rather than trusting `exportValue()` to
reproduce it; if it ever emits a different name, the live export is deleted rather
than retained and you are back at the same wall. That test is removed in step 2
along with the export it guarded.

Both deploys completed with **zero downtime** — 90/90 and 191/191 health samples
returned 200. The rule that blocks the delete is the same one that prevents the
outage.

**Treat an export-in-use failure as an availability incident.** While it held,
aws-prod could not deploy *anything*: `engram-prod-web` alone also failed, because
the replacement import it needed was published by the same blocked data-stack
update. An urgent auth hotfix could not have shipped.

### Staged promotion (`--ref`) — shipping an earlier commit

`--ref` promotes a commit that is already merged and CI-green, for cases where
main HEAD should not ship yet. It is a real capability and worth having — it is
simply **not** the answer to export removal above.

```bash
scripts/promote-prod.sh --full --ref <sha> --dry-run
scripts/promote-prod.sh --full --ref <sha>
```

**`--ref` does not weaken the promotion gate.** The commit must be an ancestor of
`origin/main` — so it has been through PR review and branch protection — and must
have its own green CI run. Both are enforced by the script *and* independently by
the `Enforce ref is reachable from main` step on the runner, because the Actions
UI can dispatch the workflow directly without the script. An arbitrary or
unmerged ref is refused in both places.

The migration drift gate runs on the runner after checkout, so it is evaluated
against the ref being shipped, not against main.

**When you do not need `--ref`:** ordinary app-code promotions, and any infra
change that only adds or modifies resources — which is most of them. Reach for it
when a change must be observed working in one state before advancing to the next.
**Not** for an export still in use: that is the `exportValue()` case above, and
`--ref` was tried against it and failed.

### Cert/WAF exceptions and break-glass

Normal app-code promotions must use live stack outputs. A human may use an
explicit **reviewed pair** only when the deployment review identifies a reason
not to use the current outputs (for example, a cert-stack-related change whose
target values were reviewed). Both values and the acknowledgement are required:

```bash
CERTIFICATE_ARN="arn:aws:acm:us-east-1:782369544445:certificate/<reviewed-id>" \
WEB_ACL_ARN="arn:aws:wafv2:us-east-1:782369544445:global/webacl/<reviewed-name>/<reviewed-id>" \
scripts/promote-prod.sh --reviewed-cert-override
```

Supplying only one value, omitting the command-line review acknowledgement, a
wrong region, a malformed ARN, or a different-account ARN fails before
dispatch. This is **not** a dev-vs-prod guard: aws-dev and aws-prod use the
same AWS account, so a same-account us-east-1 ACM certificate or global WebACL
can still be the wrong environment. When a reviewed pair differs from the
current live outputs, the script prints that diff before dispatch; inability to
read the live outputs is a warning for this intentional exception, not a block.
`--full` deploys `engram-prod-data engram-prod-web engram-prod-ops`; it never
includes the cert stack. Deploy `engram-prod-cert` alone as its own reviewed
human dispatch. For a normal cert/WAF update after data already exists, then
rerun the routine web promotion so it re-reads the newly live outputs.

### Cert bootstrap (first deployment or DR only)

When `engram-prod-cert` has never produced outputs (or its outputs are
unavailable during disaster recovery), a human may use the sanctioned bootstrap
mode. It dispatches `STACK=engram-prod-cert` alone and deliberately sends blank
certificate and WebACL inputs, allowing CDK to synthesize the cert stack while
omitting its web consumer. Do not combine it with overrides or any other stack:

```bash
scripts/promote-prod.sh --bootstrap-cert
```

After it completes and the certificate and WebACL outputs exist, run the full
bootstrap promotion below. It reads those fresh outputs, creates the data stack
before its web consumer, and deploys ops too:

```bash
scripts/promote-prod.sh --full
```

For a human-only break-glass dispatch when the script itself cannot run, read
the outputs immediately before dispatch, record the values in the change review,
and use those variables rather than copying an old command:

```bash
set -euo pipefail

if ! CERTIFICATE_ARN="$(aws cloudformation describe-stacks --stack-name engram-prod-cert \
  --region us-east-1 --profile cortex \
  --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue | [0]" --output text)"; then
  echo "error: could not read CertificateArn from engram-prod-cert; refusing break-glass dispatch." >&2
  exit 1
fi
if ! WEB_ACL_ARN="$(aws cloudformation describe-stacks --stack-name engram-prod-cert \
  --region us-east-1 --profile cortex \
  --query "Stacks[0].Outputs[?OutputKey=='WebAclArn'].OutputValue | [0]" --output text)"; then
  echo "error: could not read WebAclArn from engram-prod-cert; refusing break-glass dispatch." >&2
  exit 1
fi

for name in CERTIFICATE_ARN WEB_ACL_ARN; do
  value="${!name}"
  if [ -z "$value" ] || [ "$value" = "None" ] || [ "$value" = "null" ]; then
    echo "error: live $name is empty or unavailable; refusing break-glass dispatch." >&2
    exit 1
  fi
done
[[ "$CERTIFICATE_ARN" =~ ^arn:aws:acm:us-east-1:782369544445:certificate/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
  echo "error: live CertificateArn is not a prod us-east-1 ACM certificate; refusing break-glass dispatch." >&2
  exit 1
}
[[ "$WEB_ACL_ARN" =~ ^arn:aws:wafv2:us-east-1:782369544445:global/webacl/[A-Za-z0-9_-]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
  echo "error: live WebAclArn is not a prod global us-east-1 WebACL; refusing break-glass dispatch." >&2
  exit 1
}

STACK="engram-prod-web"
gh workflow run deploy-prod.yml --repo cortex-mesh/engram \
  -f stack="$STACK" \
  -f hosted_zone_id="Z099959326CYRBW3F5PTA" \
  -f certificate_arn="$CERTIFICATE_ARN" \
  -f web_acl_arn="$WEB_ACL_ARN" \
  -f budget_alert_email="<Roland's alert email>"
```

Never dispatch the cert and web stacks together: deploy `engram-prod-cert`
alone as a reviewed human event, then use the routine promotion to deploy
`engram-prod-web` with freshly read live outputs. The GitHub Actions runner
guards against accidental invalid or combined stack sets, including one that
combines the cert stack with another stack. This runner-side guard is not a
defense against an actor who can already dispatch an arbitrary workflow ref;
the checkout's `ref: main` pins deployed code, not the workflow definition used
by `workflow_dispatch`. Because it runs before AWS credentials are configured,
the guard validates only stack names and ARN shape (region, prod account, and
format); it cannot establish that a well-formed ARN exists or is the current
`engram-prod-cert` output. Treat data-stack changes as their own reviewed event
too.

## What we actually protect

Engram prod has essentially no end users besides Roland, so brief **downtime is
cheap** — don't add ceremony to avoid it. What is *not* cheap is silently
**dropping an application integration**: every consumer app (Tradepost, Cite,
FieldOps, Synapse native) delegates login here, and a broken client
registration locks users out of *that app* with no signal from Engram itself.
Calibrate effort accordingly — verify integrations hard, tolerate a blip.

**The client inventory is append-only.** We own and operate every consumer app,
its infrastructure, and its code, so there is never a legitimate reason to
remove a client registration or a redirect URI. A promotion that turns a working
integration into a broken one is always a regression, never a planned change.
(This mirrors cortex ADR-128's additive-auto / destructive-human split, applied
to the auth contract instead of the schema.)

Each consumer app authenticates on **its own branded auth host**.
`login.ctxhost.com` is *not* a consumer app's host — it is the ctxhost suite's
own auth entry, in front of `platform.ctxhost.com` and the tenant hosts.

| App | Branded auth host | Client |
|---|---|---|
| Tradepost | `auth.ccgtradepost.com` | `tradepost-web` |
| Cite / Axon | `auth.citethemove.com` | `axon-web` |
| FieldOps | `auth.fieldops.club` — **not provisioned yet** (M4) | `fieldops-web` |
| ctxhost suite | `login.ctxhost.com` → `platform.ctxhost.com` | cookie SSO |

## Verify (baseline before, compare after)

The check that matters is a **before/after diff**, not a judgment call:

```bash
# BEFORE dispatching:
./scripts/smoke-prod-auth.sh --save /tmp/prod-auth-baseline.txt

# AFTER the workflow goes green:
./scripts/smoke-prod-auth.sh --compare /tmp/prod-auth-baseline.txt
```

It exits non-zero if any integration that worked before is broken now. It is
read-only — it starts a login per client and never completes one, so it needs no
credentials and creates no session. (A registered client + registered redirect
returns `307` to `/api/auth/continue`; an unknown client or unregistered
redirect returns `400 invalid_client`.)

Then, once per promotion:

1. Full round-trip: sign in from `https://ccgtradepost.com` with the demo
   account (`~/.secrets/demo-tenant-test.env`) and confirm the session lands
   back on the app. Never use the `cortex` org for verification.
2. For theme changes, check branding renders in both appearance modes, and that
   bare `/login` still shows the default Engram look.
3. CloudFront may serve cached HTML briefly; if a stale page persists past a
   few minutes, check the web stack's invalidation behavior before assuming a
   bad deploy.

**A new app's first promotion** is the one case where a row *appears*: add it to
`INVENTORY` in the smoke script in the same PR that registers the client, so the
next promotion protects it.

## Rollback

Deploys track `main`, so rollback is **revert-then-redispatch**:

1. `git revert` the offending commit(s) on a branch → PR → merge (CI green).
2. Re-dispatch the routine promotion above.

There is no SHA-pinned rollback slot (unlike Tradepost's
`/tradepost/prod/previous-sha`); the git history is the ledger.

## Related

- Tradepost prod promotion: `tradepost/docs/runbooks/prod-promotion.md`
  (`scripts/promote-prod.sh` — SHA-pinned, guarded, agent-runnable on GO;
  a *different* policy from Engram's human-dispatch-only rule above).
- ADR-025 (aws-prod serverless deployment) — the binding design.
- `docs/runbooks/cdk-deploy.md` — stack topology / first-rollout notes.
