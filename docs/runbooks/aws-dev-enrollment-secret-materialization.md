# AWS-dev Cite enrollment secret materialization

How to configure the Cite enrollment signing variables for **aws-dev**, and how
to unblock the aws-dev deploy when it fails on enrollment startup validation.

For key generation and rotation see
[`enrollment-signing-secret-provisioning.md`](enrollment-signing-secret-provisioning.md).
That runbook creates the key material; **this** one gets it into the place the
deploy actually reads. Provisioning alone does not deploy — skipping this step
is what stranded aws-dev for three days in August 2026.

Export `AWS_PROFILE=cortex` before anything here.

## Why there are two secrets

The split is deliberate and is the whole source of confusion:

| Secret | Shape | Read by |
| --- | --- | --- |
| `engram-dev-enrollment-signing` | the 5-field contract: `kid`, `privateKeyPem`, `publicKeyPem`, `not_before`, `not_after` | nothing at deploy time — it is the **system of record** for the key |
| `engram-dev-runtime` | flat `ENGRAM_*` env names | **the deploy**, via `secrets_bundle` in `cortex-deploy.toml` |

`cortex-deploy.toml` sets aws-dev `secrets_bundle = "engram-dev-runtime"` and
declares each enrollment variable as a `secret_key` lookup **inside that
bundle**. It never references `engram-dev-enrollment-signing`. So creating the
signing secret has **no effect on the deploy** until its values are copied —
with renamed keys — into the runtime bundle. That copy is this runbook.

aws-prod does not need this step: its CDK web stack reads the dedicated prod
secret directly through per-key `{{resolve:secretsmanager:...}}` dynamic
references. See "Production differences" below.

## Symptom

Every aws-dev deploy fails, for every PR, in the pre-deploy hook:

```
Enrollment startup validation failed:
ENGRAM_ENROLLMENT_SIGNING_KEY_ID must be configured for Cite enrollment signing.
```

This is not Cite-specific — **no engram change can reach aws-dev** while it
holds, because `cortex-deploy.toml` runs
`node scripts/validate-enrollment-startup.mjs` as an aws-dev `pre_deploy` hook.

**It is nearly silent.** aws-dev keeps serving the last good build and reports
`upToDate: true` at `/api/health/migrations`, because the *deployed* build only
expects the migrations it shipped with. The drift monitor stays green. The only
signal is the deployed `version` falling behind `main`. When a merged change
"never reached dev", compare those two first.

Confirm the cause:

```bash
aws secretsmanager get-secret-value --secret-id engram-dev-runtime \
  --profile cortex --region us-west-2 --query SecretString --output text \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sorted(k for k in d if "ENROLLMENT" in k))'
```

An empty list means the materialization never happened.

## The variables

Six are required. Map them from the signing secret:

| Runtime bundle key | Signing secret field |
| --- | --- |
| `ENGRAM_ENROLLMENT_SIGNING_KEY_ID` | `kid` |
| `ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY` | `privateKeyPem` |
| `ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY` | `publicKeyPem` |
| `ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE` | `not_before` |
| `ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER` | `not_after` |
| `ENGRAM_AXON_ENROLLMENT_API_KEY` | — **mint it; nothing provisions it** |

`provision-enrollment-signing-secret.sh` deliberately creates key material only,
so `ENGRAM_AXON_ENROLLMENT_API_KEY` — the Cite machine credential — has no
source. Mint a fresh one per environment; **never share one across
environments**.

The manifest also declares four `ENGRAM_ENROLLMENT_OVERLAP_SIGNING_*` variables.
**Leave them absent.** The validator treats them as all-or-nothing: a partial
set is a hard failure, and a complete set asserts a second, real overlap key.
They belong to a rotation, not a first install.

## PEM encoding is load-bearing

Store the PEMs with **escaped** `\n`, never literal newlines.

The aws-dev deploy renders the env file as raw `KEY=VALUE` lines (see
`_render_env_file` in cortex `deploy/strategies/aws_dev.py`), and
`docker run --env-file` parses one variable per line. A literal newline splits
the PEM across lines and corrupts the file — a *different* failure that looks
much like the original one.

Both `scripts/validate-enrollment-startup.mjs` and `src/lib/enrollment-crypto.ts`
undo the escape with the identical `.trim().replace(/\\n/g, "\n")`, so escaped
values are correct for validation **and** runtime.

## Verify before you write

The validator is the same code the pre-deploy hook runs, so you can prove the
fix locally first. Symlink `node_modules` next to the script so `jose` resolves,
set the six variables, and run it:

```bash
node scripts/validate-enrollment-startup.mjs && echo PASS
```

Exit 0 means the deploy's gate will pass. Also run a negative control (drop
`ENGRAM_AXON_ENROLLMENT_API_KEY`) so you know the check can actually fail.

## Write the bundle

`put-secret-value` **replaces the entire** `SecretString`. Read the bundle,
merge additively, and write it back — do not hand-assemble it. Before writing,
assert that no pre-existing key changed or disappeared, and that no value
contains a literal newline. Back up the current `SecretString` to a file first;
that backup is the rollback.

## Deploy and verify

```bash
gh workflow run "Deploy Engram" --ref main -f deploy_aws_dev=true -f deploy_rocky=false
```

A green run is **not** proof. Verify live:

```bash
curl -s https://login.dev.ctxhost.com/api/health              # version == main
curl -s https://login.dev.ctxhost.com/api/health/migrations   # dbLatestApplied
```

`dbLatestApplied` is the authoritative field — it reports what the database
actually has, not what the deploy claimed (ADR-033).

## Production differences

Do **not** apply this procedure to aws-prod.

- Prod reads the dedicated `cortex/prod/engram/enrollment-signing` secret
  directly via per-key CloudFormation dynamic references, so there is no
  materialization step and **no escaping requirement** — the script's native
  real-newline JSON is correct.
- Prod's `ENGRAM_AXON_ENROLLMENT_API_KEY` still has no provisioning script and
  must be added by hand to the existing `cortex/prod/engram/runtime` secret.
- Because they are resolved at **stack-update** time, both prod values are inert
  until the next promotion — which is why they are safe to stage in advance, and
  why a missing one fails the **stack update** (and rolls back) rather than
  degrading to a runtime 503.
- Prod must have its own `kid` and its own machine credential. Never reuse dev's.
- Rehearse with `scripts/promote-prod.sh --dry-run`, which checks these
  preconditions without dispatching.
