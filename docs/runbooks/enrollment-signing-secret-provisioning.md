# Cite enrollment signing secret provisioning

This runbook is for the controller. It creates or rotates key material only;
it does not deploy Engram, apply Prisma migrations, or change production data.

The enrollment authority has its own signing domain. Never reuse
`cortex/prod/engram/jwt-rs256`, its `kid`, or its key material. Production uses
`cortex/prod/engram/enrollment-signing`; AWS-dev CDK uses
`engram-dev-enrollment-signing`.

## Secret contract

The secret JSON is generated atomically with exactly these keys:

```text
kid
privateKeyPem
publicKeyPem
not_before
not_after
```

`not_before` and `not_after` are RFC 3339 instants with explicit offsets. Use a
new `kid` on every rotation. Before retiring a key, configure the prior public
key through the bounded overlap secret, verify consumer snapshots, and advance
retention only after the consumer acknowledges a snapshot at or beyond the new
cursor floor.

## Dry run and human-approved apply

Run from the reviewed Engram checkout. The default is dry-run and creates no
secret or key:

```bash
scripts/provision-enrollment-signing-secret.sh --environment aws-prod
```

After approval, configure and deploy the current key as the four bounded
overlap variables first. Confirm that outgoing `kid` in the rotation command,
then choose a bounded validity interval and apply:

```bash
scripts/provision-enrollment-signing-secret.sh \
  --environment aws-prod \
  --not-before 2026-08-01T00:00:00Z \
  --not-after 2027-08-01T00:00:00Z \
  --confirm-overlap-kid cite-enrollment-previous-kid \
  --apply
```

The command does not print private key material. Record the resulting secret
version and key id in the deployment evidence packet. AWS-dev follows the same
flow with `--environment aws-dev`.

## Deployment bindings

The production CDK web stack passes the dedicated secret's **name** to the
Lambda (`ENGRAM_ENROLLMENT_SIGNING_SECRET_ID`) and grants it read access to only
that secret; the function fetches the five fields at runtime and caches them.
The fields are **not** injected as environment variables — that exceeds Lambda's
5120-byte configuration-request limit and fails the stack update. See
[`aws-prod-lambda-env-budget.md`](aws-prod-lambda-env-budget.md) and ADR-034 §5. The shared runtime secret contains the machine consumer credential but
never enrollment private key material. AWS-dev deployment configuration must
materialize the same five variables from the controller-provisioned signing
secret before its pre-deploy validation hook runs.

**That AWS-dev materialization is a separate, mandatory step with its own
procedure — see
[`aws-dev-enrollment-secret-materialization.md`](aws-dev-enrollment-secret-materialization.md).**
Running this script does not perform it. AWS-dev reads the flat `ENGRAM_*` names
from the `engram-dev-runtime` bundle declared in `cortex-deploy.toml`, never
from the signing secret this script writes, so creating the secret alone leaves
every AWS-dev deploy failing on enrollment startup validation.

## Production promotion preconditions

Before a production web-stack promotion, the controller must verify both:

1. `cortex/prod/engram/enrollment-signing` exists with all five secret-contract
   keys above. It is a CloudFormation dynamic reference, so an absent secret or
   JSON key fails the **stack update** rather than degrading to a runtime 503.
2. The existing `cortex/prod/engram/runtime` secret contains a non-empty
   `ENGRAM_AXON_ENROLLMENT_API_KEY`. This is the dedicated Cite machine
   credential and is not provisioned by this key-generation script.

`scripts/promote-prod.sh` checks both conditions and fails closed with this
runbook as its remediation pointer. Do not create or change production secrets
from an agent session.

After a successful deployment, a missing, expired, or malformed runtime key
configuration causes Cite internal endpoints to return
`ENROLLMENT_STATE_UNAVAILABLE`; consumers deny access while the shared IdP
continues to issue tokens for Tradepost and FieldOps.
