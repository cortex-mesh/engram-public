# Hosted App Login and App-Switcher Troubleshooting

Use this when a hosted suite user can authenticate with Engram but cannot open
or stay inside a tenant app such as Gyrus at
`https://<org>.dev.ctxhost.com/<app>`.

Engram owns two separate parts of that flow:

- Login/continue decides whether a requested redirect target is allowed and
  where the browser should land after authentication.
- `/api/me/app-switcher` tells Nexus and the shared `@cortex-mesh/app-header`
  which apps the current user may see for the active org.

A user can pass login and still be routed away from an app if the app-switcher
payload does not include that app.

## Known Incident: Gyrus, 2026-07-23

Symptoms:

- A Cortex org member could sign in with email/password and Google.
- Direct navigation to `https://cortex.dev.ctxhost.com/gyrus` returned HTTP
  `200`, then the browser moved back to `https://cortex.dev.ctxhost.com/`.
- Nexus either omitted Gyrus or the shared app header treated Gyrus as
  unavailable.

Root cause:

- The Cortex org and user entitlement rows were correct.
- Engram's production-mode app catalog hid Gyrus because
  `NEXT_PUBLIC_GYRUS_URL` was absent from the `engram-dev-runtime` secret.
- `/api/me/app-switcher` returned only `nexus`.
- The shared app header saw `currentApp="gyrus"` but no `gyrus` app entitlement
  in the switcher payload, so it navigated the user back to Nexus.

Fix:

- Set `NEXT_PUBLIC_GYRUS_URL=https://cortex.dev.ctxhost.com/gyrus` in
  `engram-dev-runtime`.
- Redeploy Engram aws-dev.
- Verify `/api/me/app-switcher` returns both `nexus` and `gyrus`.

## Failure Signatures

| Symptom | Engram surface to check |
| --- | --- |
| Login API returns `postLoginTarget` as `/`, `/account`, or Nexus root | Redirect validation/default landing |
| Browser reaches `/gyrus` with HTTP `200`, then moves to tenant root | `/api/me/app-switcher` is missing the current app |
| Nexus app tile missing | `/api/me/app-switcher` app list or Nexus registry |
| `/no-access?reason=missing_entitlement` | Missing/disabled `OrgAppEntitlement` |
| `/no-access?reason=user_app_revoked` | `UserAppEntitlement.enabled=false` |
| App visible for owner/admin but not member | Restricted app with no per-user allow |
| Continue redirect loop | Access/refresh cookie handling or duplicate stale cookies |

## Login Target Check

Email/password login should preserve an allowed app redirect:

```bash
curl -sk -i \
  -H 'Content-Type: application/json' \
  --data '{"email":"<email>","password":"<password>","redirectUri":"https://cortex.dev.ctxhost.com/gyrus"}' \
  https://login.dev.ctxhost.com/api/auth/login
```

Expected:

```json
{
  "postLoginTarget": "https://cortex.dev.ctxhost.com/gyrus"
}
```

If the target is rewritten unexpectedly, check:

- `ENGRAM_ALLOWED_ORIGINS`
- `PLATFORM_APPS` in `src/lib/apps.ts`
- app-specific `NEXT_PUBLIC_*_URL` values
- `NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING`

## App-Switcher Check

From an authenticated browser session on the tenant host:

```js
await fetch("https://login.dev.ctxhost.com/api/me/app-switcher", {
  credentials: "include",
  headers: { Accept: "application/json" },
}).then((res) => res.json());
```

Expected for a Cortex Gyrus member:

```json
{
  "org": { "slug": "cortex" },
  "apps": [
    { "key": "nexus", "url": "https://cortex.dev.ctxhost.com/" },
    { "key": "gyrus", "url": "https://cortex.dev.ctxhost.com/gyrus" }
  ]
}
```

If the current app is missing here, consumers should be expected to eject the
user. The shared app header intentionally redirects non-superadmins away from
an app not present in `apps`.

## Runtime URL Contract

In production mode, Engram does not fall back to development app URLs. An app
must have a configured public URL or it is omitted from app-switcher output and
redirect allowlists.

Required hosted app URL variables:

- `NEXT_PUBLIC_DASHBOARD_URL`
- `NEXT_PUBLIC_SYNAPSE_URL`
- `NEXT_PUBLIC_THOUGHTS_URL`
- `NEXT_PUBLIC_AXON_URL`
- `NEXT_PUBLIC_PULSE_URL`
- `NEXT_PUBLIC_GYRUS_URL`

For aws-dev Gyrus:

```text
NEXT_PUBLIC_GYRUS_URL=https://cortex.dev.ctxhost.com/gyrus
```

Read the dev runtime bundle without printing the whole secret into logs:

```bash
export AWS_PROFILE=cortex AWS_REGION=us-west-2

aws secretsmanager get-secret-value \
  --secret-id engram-dev-runtime \
  --query SecretString \
  --output text > /tmp/engram-dev-runtime.json

jq '{
  ENGRAM_ALLOWED_ORIGINS,
  NEXT_PUBLIC_DASHBOARD_URL,
  NEXT_PUBLIC_GYRUS_URL,
  NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING
}' /tmp/engram-dev-runtime.json
```

If a value is missing, update only that key and redeploy Engram:

```bash
jq '.NEXT_PUBLIC_GYRUS_URL = "https://cortex.dev.ctxhost.com/gyrus"' \
  /tmp/engram-dev-runtime.json > /tmp/engram-dev-runtime.updated.json

aws secretsmanager put-secret-value \
  --secret-id engram-dev-runtime \
  --secret-string file:///tmp/engram-dev-runtime.updated.json

rm /tmp/engram-dev-runtime.json /tmp/engram-dev-runtime.updated.json

gh -R cortex-mesh/engram workflow run deploy.yml \
  --ref main \
  -f deploy_aws_dev=true \
  -f deploy_rocky=false
```

## Entitlement Checks

For non-superadmin users, `/api/me/app-switcher` starts from org app
entitlements and then applies user overrides.

Rules:

- No `OrgAppEntitlement` row, or `enabled=false`: app is absent.
- `accessMode=ALL_MEMBERS`: all org members are allowed unless explicitly
  denied by `UserAppEntitlement.enabled=false`.
- `accessMode=RESTRICTED`: org `OWNER`/`ADMIN` are allowed; org `MEMBER` needs
  `UserAppEntitlement.enabled=true`.
- Platform `SUPERADMIN` sees every catalog app.

The aws-dev RDS is VPC-private, so inspect it through SSM on the app host:

```bash
export AWS_PROFILE=cortex AWS_REGION=us-west-2

INSTANCE_ID="$(aws ec2 describe-instances \
  --filters Name=tag:Name,Values=cortex-dev-app-host Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text)"
```

Run read-only SQL inside the Engram container:

```bash
CHECK_EMAIL="<email>"
CHECK_APP="gyrus"

aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment 'inspect hosted app access' \
  --parameters "commands=[\"CHECK_EMAIL='$CHECK_EMAIL' CHECK_APP='$CHECK_APP' docker exec -e CHECK_EMAIL -e CHECK_APP engram node -e \\\"const {Pool}=require('pg'); const u=new URL(process.env.DATABASE_URL); u.searchParams.delete('sslmode'); const pool=new Pool({connectionString:u.toString(),ssl:{rejectUnauthorized:false}}); (async()=>{const r=await pool.query('select u.email,u.\\\\\\\"emailVerified\\\\\\\",u.role as platform_role,o.slug,m.role as org_role,oe.enabled as org_app_enabled,oe.\\\\\\\"accessMode\\\\\\\" as org_access_mode,ue.enabled as user_app_enabled from \\\\\\\"User\\\\\\\" u join \\\\\\\"OrgMember\\\\\\\" m on m.\\\\\\\"userId\\\\\\\"=u.id join \\\\\\\"Organization\\\\\\\" o on o.id=m.\\\\\\\"orgId\\\\\\\" left join \\\\\\\"OrgAppEntitlement\\\\\\\" oe on oe.\\\\\\\"orgId\\\\\\\"=o.id and oe.\\\\\\\"appKey\\\\\\\"=$2::\\\\\\\"AppKey\\\\\\\" left join \\\\\\\"UserAppEntitlement\\\\\\\" ue on ue.\\\\\\\"userId\\\\\\\"=u.id and ue.\\\\\\\"orgId\\\\\\\"=o.id and ue.\\\\\\\"appKey\\\\\\\"=$2::\\\\\\\"AppKey\\\\\\\" where lower(u.email)=lower($1)', [process.env.CHECK_EMAIL, process.env.CHECK_APP || 'gyrus']); console.log(JSON.stringify(r.rows,null,2)); await pool.end();})().catch(e=>{console.error(e);process.exit(1)})\\\"\"]" \
  --query 'Command.CommandId' \
  --output text
```

Poll the command:

```bash
aws ssm get-command-invocation \
  --command-id "<command-id>" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
```

For a restricted Gyrus member, expected fields are:

```json
{
  "org_app_enabled": true,
  "org_access_mode": "RESTRICTED",
  "user_app_enabled": true
}
```

## Browser Verification

Use Playwright or an equivalent browser trace to distinguish HTTP redirects
from client-side routing. Capture:

- top-level document requests and responses
- `/api/auth/login`
- `/api/auth/continue`
- `/api/me/app-switcher`
- final URL after the app has hydrated

The critical signature from the 2026-07-23 Gyrus incident was:

```text
GET https://cortex.dev.ctxhost.com/gyrus -> 200
GET https://login.dev.ctxhost.com/api/me/app-switcher -> 200, apps=[nexus]
client navigation to https://cortex.dev.ctxhost.com/
```

That means the target app loaded successfully and the app-switcher payload
caused the post-load ejection.

## Cleanup

- Delete any temp files containing Secrets Manager JSON.
- Do not commit test-user passwords.
- Record whether the fix was code, runtime configuration, data entitlement, or
  consumer registry. These deploy and roll back differently.
