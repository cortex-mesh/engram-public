#!/usr/bin/env bash
#
# Apply pending Prisma migrations to aws-prod via a one-shot, self-destroying
# bastion in the prod VPC. See docs/runbooks/prod-db-migration-verify-apply.md
# and ADR-033 (pinned runtime + fail-closed execution).
#
#   ./scripts/prod-db-migrate.sh --dry-run    # read-only; ALWAYS run this first
#   ./scripts/prod-db-migrate.sh              # applies to PRODUCTION
#
# Prerequisites:
#   - Roland's explicit approval for this specific migration (ADR-025 §11).
#   - A pre-migration RDS snapshot; set SNAPSHOT_ID so the dry run can prove it.
#   - A bundle at $BUNDLE_PATH containing prisma/schema.prisma + prisma/migrations
#     built from the exact commit you intend to apply, e.g. from a clean checkout:
#         tar czf /tmp/prisma-bundle.tgz prisma/schema.prisma prisma/migrations
#
# After it exits 0, you are STILL NOT DONE: verify out-of-band against
# https://login.ctxhost.com/api/health/migrations (ADR-033 §4). SSM reporting
# "Success" is not evidence that the schema moved.
#
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-cortex}" AWS_REGION="${AWS_REGION:-us-west-2}"

# --- prod connection facts (see runbook; these are infra IDs, not secrets) ---
SECRET_ARN=arn:aws:secretsmanager:us-west-2:782369544445:secret:cortex/prod/engram/db-admin-sJqeUv
SUBNET=subnet-0507dd4ecb315aab8   # engram-prod-data/Vpc/private-egress (NAT -> SSM works)
SG=sg-0237c9db8cab68e40           # the app's Lambda SG, allowed direct to Postgres
# The RDS Proxy was removed (it cost ~$22/mo to pool a workload peaking at 9
# connections); this is the instance endpoint the app itself now uses. The
# Lambda SG above carries the direct ingress rule that makes it reachable.
DB_HOST=engram-prod-data-postgres9dc8bb04-gqakzxdm5onq.cd6cloglllof.us-west-2.rds.amazonaws.com
HEALTH_URL=https://login.ctxhost.com/api/health/migrations

# --- knobs ---
ROLE="${ROLE:-engram-prod-migrate-temp-$(date +%Y%m%d%H%M%S)}"
BUNDLE_PATH="${BUNDLE_PATH:-/tmp/prisma-bundle.tgz}"
SNAPSHOT_ID="${SNAPSHOT_ID:-}"
PRISMA_VER="${PRISMA_VER:-7.8.0}"

# ADR-033 §1: pin the Node runtime; never inherit the AMI's. AL2023 ships Node
# 18, which prisma 7 refuses to run on (needs ^20.19 || ^22.12 || >=24). Node 22
# LTS matches the documented tech stack and deploy-prod.yml's node-version: 22.
# Pinned as a literal, not a `latest-*` URL — a prod-mutating run must be
# reproducible. Moving to 24 is a deliberate fleet-wide upgrade, not a side
# effect of a migration.
NODE_VER="${NODE_VER:-v22.23.2}"

IID=""
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ ! -f "$BUNDLE_PATH" ]; then
  echo "FATAL: no prisma bundle at $BUNDLE_PATH (see header for how to build it)" >&2
  exit 1
fi

bundle_migrations() {
  tar tzf "$BUNDLE_PATH" 2>/dev/null | grep -oE '[0-9]{4}_[a-z0-9_]+' | sort -u
}

if [ "$DRY_RUN" = "1" ]; then
  echo "===== DRY RUN — no resource is created, no prod write occurs ====="
  echo
  echo "WOULD CREATE:"
  echo "  IAM role + instance profile : $ROLE"
  echo "    - AmazonSSMManagedInstanceCore"
  echo "    - inline secret-read scoped to: $SECRET_ARN"
  echo "  EC2 t3.micro in             : $SUBNET  (sg $SG), IMDSv2 required"
  echo "    tag purpose=migrate-verify-temp"
  echo
  echo "WOULD APPLY (prisma migrate deploy over SSM against $DB_HOST):"
  APPLIED=$(curl -s -m 10 "$HEALTH_URL" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["dbLatestApplied"])' 2>/dev/null)
  echo "  prod dbLatestApplied : ${APPLIED:-<unreachable>}"
  echo "  bundle contains      : $(bundle_migrations | wc -l | tr -d ' ') migrations"
  echo "  would apply          :"
  if [ -n "$APPLIED" ]; then
    bundle_migrations | awk -v a="$APPLIED" '$0 > a' | sed 's/^/      /'
  else
    echo "      <cannot compute — health endpoint unreachable>"
  fi
  echo
  echo "RUNTIME ON BASTION (ADR-033 §1):"
  echo "  AL2023 default node : v18.x — REJECTED by prisma@$PRISMA_VER"
  echo "  pinned node (LTS)   : $NODE_VER  (installed from nodejs.org tarball)"
  printf '  tarball reachable   : '
  curl -fsI -m 10 "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" >/dev/null 2>&1 \
    && echo "yes" || echo "NO — check NODE_VER"
  echo
  echo "PRE-FLIGHT (read-only):"
  printf '  subnet          : '; aws ec2 describe-subnets --subnet-ids "$SUBNET" --query 'Subnets[0].Tags[?Key==`Name`].Value|[0]' --output text 2>&1
  printf '  security group  : '; aws ec2 describe-security-groups --group-ids "$SG" --query 'SecurityGroups[0].GroupName' --output text 2>&1
  printf '  AMI resolves    : '; aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text 2>&1
  printf '  secret readable : '; aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text 2>/dev/null | python3 -c 'import sys,json;print("yes, has password" if "password" in json.load(sys.stdin) else "MISSING password key")' 2>&1
  printf '  role name free  : '; aws iam get-role --role-name "$ROLE" >/dev/null 2>&1 && echo "NO — already exists" || echo "yes"
  printf '  stale temp EC2  : '; R=$(aws ec2 describe-instances --filters Name=tag:purpose,Values=migrate-verify-temp Name=instance-state-name,Values=running,pending --query 'Reservations[].Instances[].InstanceId' --output text 2>&1); echo "${R:-none}"
  printf '  snapshot        : '
  if [ -n "$SNAPSHOT_ID" ]; then
    aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" --query 'DBSnapshots[0].Status' --output text 2>&1
  else
    echo "SNAPSHOT_ID unset — take a pre-migration snapshot first"
  fi
  echo
  echo "TEARDOWN ON EXIT: terminate instance, delete profile/policy/role, print absence proof."
  echo "AFTER APPLY: verify $HEALTH_URL — SSM 'Success' is not proof (ADR-033 §4)."
  echo "===== DRY RUN COMPLETE — re-run without --dry-run to execute ====="
  exit 0
fi

cleanup() {
  set +e
  echo "===== TEARDOWN ====="
  if [ -n "$IID" ]; then
    aws ec2 terminate-instances --instance-ids "$IID" >/dev/null 2>&1 && echo "terminate requested: $IID"
  fi
  aws iam remove-role-from-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE" >/dev/null 2>&1
  aws iam delete-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1
  aws iam delete-role-policy --role-name "$ROLE" --policy-name secret-read >/dev/null 2>&1
  aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null 2>&1
  aws iam delete-role --role-name "$ROLE" >/dev/null 2>&1
  echo "--- absence proof ---"
  aws iam get-role --role-name "$ROLE" >/dev/null 2>&1 && echo "!! ROLE STILL EXISTS" || echo "role: NoSuchEntity OK"
  aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1 && echo "!! PROFILE STILL EXISTS" || echo "instance-profile: NoSuchEntity OK"
  if [ -n "$IID" ]; then
    echo -n "instance state: "
    aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null
  fi
}
trap cleanup EXIT

echo "===== 1. IAM role (scoped) ====="
aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null || exit 1
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore || exit 1
aws iam put-role-policy --role-name "$ROLE" --policy-name secret-read --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$SECRET_ARN\"}]}" || exit 1
aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null || exit 1
aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE" || exit 1
echo "created; secret scope = $SECRET_ARN"
sleep 15

echo "===== 2. launch instance ====="
AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text) || exit 1
echo "ami=$AMI"
for attempt in 1 2 3 4 5; do
  OUT=$(aws ec2 run-instances --image-id "$AMI" --instance-type t3.micro \
    --subnet-id "$SUBNET" --security-group-ids "$SG" \
    --iam-instance-profile Name="$ROLE" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=purpose,Value=migrate-verify-temp},{Key=Name,Value=engram-prod-migrate-temp}]' \
    --query 'Instances[0].InstanceId' --output text 2>&1)
  case "$OUT" in i-*) IID="$OUT"; break;; *) echo "attempt $attempt: $OUT"; sleep 10;; esac
done
[ -n "$IID" ] || { echo "FAILED to launch"; exit 1; }
echo "instance=$IID"

echo "===== 3. wait for SSM ====="
P=""
for i in $(seq 1 40); do
  P=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$IID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
  echo "  ssm ping: $P"
  [ "$P" = "Online" ] && break
  sleep 15
done
[ "$P" = "Online" ] || { echo "SSM never came online"; exit 1; }

echo "===== 4. prisma migrate deploy ====="
B64=$(base64 -i "$BUNDLE_PATH" | tr -d '\n')
python3 - "$B64" "$SECRET_ARN" "$DB_HOST" "$NODE_VER" "$PRISMA_VER" > /tmp/remote-cmd.json <<'PYEOF'
import json, sys, base64
b64, secret_arn, db_host, node_ver, prisma_ver = sys.argv[1:6]

# ADR-033 §5: Prisma 7 requires datasource.url in the *config file*; a
# DATABASE_URL env var is NOT enough, and engram's schema.prisma datasource
# block deliberately carries no url. The bundle ships only schema + migrations
# (not prisma.config.ts, which imports dotenv), so synthesize a minimal config.
# Base64'd because nothing survives quoting through the SSM command list.
CONFIG = """import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
"""
cfg_b64 = base64.b64encode(CONFIG.encode()).decode()

cmds = [
  # ADR-033 §2: pipefail is load-bearing. Without it, `cmd | tail` returns
  # tail's exit status and a failed migration reports SSM Success.
  "set -eo pipefail",
  "dnf install -y tar xz >/dev/null 2>&1 || true",
  # ADR-033 §1: pinned Node, not the AMI's.
  "curl -fsSL https://nodejs.org/dist/%s/node-%s-linux-x64.tar.xz -o /tmp/node.tar.xz" % (node_ver, node_ver),
  "mkdir -p /opt/node && tar xJf /tmp/node.tar.xz -C /opt/node --strip-components=1",
  "export PATH=/opt/node/bin:$PATH",
  "echo \"node: $(node -v)  npm: $(npm -v)\"",
  "node -e 'const m=+process.versions.node.split(\".\")[0]; if(m<20){console.error(\"FATAL: node \"+process.versions.node+\" too old for prisma 7\"); process.exit(1);} console.log(\"node major \"+m+\" OK for prisma 7\")'",
  "mkdir -p /tmp/eg && cd /tmp/eg",
  "echo '%s' | base64 -d > b.tgz" % b64,
  "cd /tmp/eg && tar xzf b.tgz && echo 'migrations on box:' && ls prisma/migrations | tail -3",
  # Local install, not npx: `import ... from "prisma/config"` must resolve from
  # /tmp/eg, and npx's temp cache dir is not on that resolution path.
  "cd /tmp/eg && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund --loglevel=error prisma@%s 2>&1 | tail -3" % prisma_ver,
  "cd /tmp/eg && echo '%s' | base64 -d > prisma.config.mjs && echo '--- config ---' && cat prisma.config.mjs" % cfg_b64,
  # The instance reads the secret itself, so the password never transits SSM logs.
  "PW=$(aws secretsmanager get-secret-value --secret-id %s --query SecretString --output text --region us-west-2 | python3 -c 'import sys,json,urllib.parse; print(urllib.parse.quote(json.load(sys.stdin)[\"password\"], safe=\"\"))')" % secret_arn,
  "export DATABASE_URL=\"postgresql://engram:${PW}@%s:5432/engram?sslmode=require\"" % db_host,
  # ADR-033 §3: PRE is expected to exit 1 (migrations pending) — tolerate it.
  "echo '--- PRE STATUS (non-zero expected: migrations pending) ---'",
  "cd /tmp/eg && { ./node_modules/.bin/prisma migrate status --config prisma.config.mjs 2>&1 || true; } | tail -20",
  "echo '--- APPLYING ---'",
  "cd /tmp/eg && ./node_modules/.bin/prisma migrate deploy --config prisma.config.mjs 2>&1 | tail -30",
  # ADR-033 §3: POST is NOT tolerated. Under `set -e` its exit 0 is the
  # machine-checked assertion that nothing remains pending.
  "echo '--- POST STATUS (hard assertion: must exit 0 = nothing pending) ---'",
  "cd /tmp/eg && ./node_modules/.bin/prisma migrate status --config prisma.config.mjs 2>&1 | tail -15",
  "echo '--- POST STATUS EXIT 0 — no pending migrations remain ---'",
  "rm -rf /tmp/eg",
]
json.dump({"commands": cmds, "executionTimeout": ["1800"]}, sys.stdout)
PYEOF
CID=$(aws ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript --parameters file:///tmp/remote-cmd.json --timeout-seconds 1800 --query 'Command.CommandId' --output text) || exit 1
echo "command=$CID"
S=""
for i in $(seq 1 80); do
  S=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null)
  echo "  status: $S"
  case "$S" in Success|Failed|TimedOut|Cancelled) break;; esac
  sleep 15
done
echo "===== STDOUT ====="
aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardOutputContent --output text 2>/dev/null
echo "===== STDERR (tail) ====="
aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardErrorContent --output text 2>/dev/null | tail -20
echo "===== final: $S ====="
echo
echo "!! NOT DONE YET (ADR-033 §4): SSM status is not proof the schema moved."
echo "   Verify out-of-band:  curl -s $HEALTH_URL | python3 -m json.tool"
echo "   dbLatestApplied must equal the migration you intended to apply."
[ "$S" = "Success" ] || exit 1
