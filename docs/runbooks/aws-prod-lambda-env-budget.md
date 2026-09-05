# aws-prod Lambda environment budget

**Read this before adding any environment variable to the aws-prod web stack.**

aws-prod runs Engram on Lambda (ADR-025). AWS rejects an
`UpdateFunctionConfiguration` request larger than **5120 bytes**. The function's
environment variables are the bulk of that request, so the environment has a
hard ceiling that aws-dev and on-prem do not.

Exceeding it **fails the CloudFormation stack update and rolls back**. It is not
a runtime error and not a 503: the deploy dies, prod stays on the previous
version, and nothing in the application's test suite can catch it.

```
UPDATE_FAILED  AWS::Lambda::Function  ServerFunction
Resource handler returned message: "Request must be smaller than 5120 bytes
for the UpdateFunctionConfiguration operation (Status Code: 413)"
```

## Why this is easy to miss

**aws-dev and on-prem have no such limit.** Both run Engram as a container that
reads an env file. A variable set that deploys cleanly to dev — and whose values
are individually valid — can still be undeployable in prod purely because of
total size. This is the dev/prod divergence the root `CLAUDE.md` warns about,
in its least visible form: the value is correct, the payload is too big.

**`{{resolve:secretsmanager:...}}` hides the cost.** A dynamic reference is
~90 bytes in the CloudFormation template and expands to the secret's real value
only when AWS substitutes it during the stack update. A 2.5 KB PEM looks tiny
until the moment it is too large. **Never size the budget from the template.**

## The budget

Check the live number before adding anything:

```bash
FN=$(aws cloudformation describe-stack-resources --profile cortex --region us-west-2 \
  --stack-name engram-prod-web --logical-resource-id ServerFunction6F3D7051 \
  --query 'StackResources[0].PhysicalResourceId' --output text)
aws lambda get-function-configuration --profile cortex --region us-west-2 \
  --function-name "$FN" --query 'Environment.Variables' --output json \
  | python3 -c 'import sys,json; v=json.load(sys.stdin); print(sum(len(k)+len(str(x)) for k,x in v.items()), "bytes,", len(v), "vars")'
```

As of 2026-08-04 that is **~3.6 KB of 5120**, leaving roughly 1.4 KB. The four
optional `ENGRAM_ENROLLMENT_OVERLAP_SIGNING_*` variables consume ~850 B of that
during a key rotation, so treat the practical headroom as **~550 bytes**.

The largest single consumer is `ENGRAM_JWT_PRIVATE_KEY` (~1732 B), still
injected inline. It is the first candidate to move if the budget tightens again;
doing so touches every authentication request, so it deserves its own change.

## Rule: key material never goes in the environment

Pass the **secret name** and load the contents at runtime.

That is what `ENGRAM_ENROLLMENT_SIGNING_SECRET_ID` does: ~40 bytes instead of
~3.3 KB for the five signing fields. `src/lib/enrollment-crypto.ts` fetches and
caches them on first use via `readEnrollmentSigningSecret`.

Three constraints on any runtime fetch here:

1. **Never on the startup path.** ADR-034 §8.1 — on Lambda a throw in
   `instrumentation.register()` runs at every cold start and would turn one
   client's misconfiguration into a suite-wide identity outage. Load lazily on
   the request that needs it.
2. **Fail closed.** A fetch failure must surface as the contract's `503`, never
   a cached or optimistic answer.
3. **Cache the in-flight promise, not just the result**, so concurrent first
   requests share one API call. Do not cache a *failure* — a transient Secrets
   Manager blip must not deny the surface until the next cold start.

The Lambda already holds `grantRead` on the enrollment signing secret, so moving
a value from env var to runtime fetch usually needs no IAM change. Verify.

## Guard

`infra/cdk/test/prod-stacks.test.ts` asserts no environment variable carries key
material — by value or by `SecretString:privateKeyPem`/`publicKeyPem` reference
— with `ENGRAM_JWT_PRIVATE_KEY`/`_PUBLIC_KEY` as explicit known exceptions. That
structural check, not the byte count, is what catches this regression, precisely
because a dynamic reference is small until it is deployed.

## If it happens anyway

CloudFormation rolls back on its own and prod keeps serving the previous
version; there is nothing to repair. Confirm rather than assume:

```bash
aws cloudformation describe-stacks --profile cortex --region us-west-2 \
  --stack-name engram-prod-web --query 'Stacks[0].StackStatus' --output text   # UPDATE_ROLLBACK_COMPLETE
curl -s https://login.ctxhost.com/api/health
```

A migration applied ahead of the failed promotion **stays applied**. If it was
additive, that is a benign `ahead` drift that clears when the code finally
promotes — see `prod-db-migration-verify-apply.md`.
