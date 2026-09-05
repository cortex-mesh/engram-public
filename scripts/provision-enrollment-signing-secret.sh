#!/usr/bin/env bash
# Generate and atomically create/rotate the dedicated Cite enrollment signing
# secret. This script is intentionally inert until a human supplies --apply.
set -euo pipefail

ENVIRONMENT=""
SECRET_ID=""
NOT_BEFORE=""
NOT_AFTER=""
REGION="us-west-2"
APPLY=0
CONFIRM_OVERLAP_KID=""

usage() {
  cat <<'USAGE'
Usage: scripts/provision-enrollment-signing-secret.sh --environment aws-dev|aws-prod \
  --not-before RFC3339 --not-after RFC3339 [--secret-id NAME] [--region REGION]
  [--confirm-overlap-kid CURRENT_KID] --apply

Without --apply the script is a dry run: it prints the target secret, validates
any interval you supplied, and reports whether --apply would CREATE or ROTATE
(rotation additionally requires --confirm-overlap-kid). It generates no key
material and writes nothing. It never prints private key material.

This script calls `aws` without a --profile flag, so it uses ambient
credentials: export AWS_PROFILE=cortex before running it.

The JSON payload is one atomic secret with exactly:
  kid, privateKeyPem, publicKeyPem, not_before, not_after
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment) ENVIRONMENT="${2:-}"; shift 2 ;;
    --secret-id) SECRET_ID="${2:-}"; shift 2 ;;
    --not-before) NOT_BEFORE="${2:-}"; shift 2 ;;
    --not-after) NOT_AFTER="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --confirm-overlap-kid) CONFIRM_OVERLAP_KID="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$ENVIRONMENT" in
  aws-dev) : "${SECRET_ID:=engram-dev-enrollment-signing}" ;;
  aws-prod) : "${SECRET_ID:=cortex/prod/engram/enrollment-signing}" ;;
  *) echo "error: --environment must be aws-dev or aws-prod" >&2; exit 2 ;;
esac

validate_interval() {
  [[ "$NOT_BEFORE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$ ]] || { echo "error: --not-before must be RFC3339 with offset" >&2; exit 2; }
  [[ "$NOT_AFTER" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$ ]] || { echo "error: --not-after must be RFC3339 with offset" >&2; exit 2; }
  node -e 'const [before, after] = process.argv.slice(1).map(Date.parse); if (!Number.isFinite(before) || !Number.isFinite(after) || before >= after) process.exit(1)' "$NOT_BEFORE" "$NOT_AFTER" || { echo "error: --not-after must be after --not-before" >&2; exit 2; }
}

if [[ "$APPLY" != 1 ]]; then
  echo "dry-run: would create or rotate dedicated enrollment signing secret $SECRET_ID in $REGION"

  # Rehearse whatever the caller actually supplied. The previous dry-run exited
  # here unconditionally, so an interval typo or a missing --confirm-overlap-kid
  # surfaced only under --apply — i.e. the rehearsal could not fail while the
  # real run did.
  if [[ -n "$NOT_BEFORE" || -n "$NOT_AFTER" ]]; then
    [[ -n "$NOT_BEFORE" && -n "$NOT_AFTER" ]] || { echo "error: --not-before and --not-after must be supplied together" >&2; exit 2; }
    validate_interval
    echo "dry-run: requested validity window $NOT_BEFORE -> $NOT_AFTER is well-formed"
  else
    echo "dry-run: no --not-before/--not-after supplied; --apply additionally requires both"
  fi

  # Create vs rotate decides whether --confirm-overlap-kid is mandatory. Probe
  # read-only; a missing/unauthorised AWS CLI must not fail the rehearsal.
  if command -v aws >/dev/null 2>&1 && aws secretsmanager describe-secret --secret-id "$SECRET_ID" --region "$REGION" >/dev/null 2>&1; then
    echo "dry-run: secret EXISTS -> --apply would ROTATE it, which also requires --confirm-overlap-kid"
    [[ -n "$CONFIRM_OVERLAP_KID" ]] || echo "dry-run: --confirm-overlap-kid is NOT set; --apply would abort"
  else
    echo "dry-run: secret not readable here -> --apply would CREATE it (no --confirm-overlap-kid needed)"
  fi

  echo "dry-run: no key material generated, nothing written"
  exit 0
fi

[[ -n "$NOT_BEFORE" && -n "$NOT_AFTER" ]] || { echo "error: --not-before and --not-after are required with --apply" >&2; exit 2; }
validate_interval

umask 077
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$WORKDIR/private.pem" >/dev/null 2>&1
openssl pkey -in "$WORKDIR/private.pem" -pubout -out "$WORKDIR/public.pem" >/dev/null 2>&1
KID="cite-enrollment-$(openssl rand -hex 12)"
export KID NOT_BEFORE NOT_AFTER
export PRIVATE_KEY="$(<"$WORKDIR/private.pem")"
export PUBLIC_KEY="$(<"$WORKDIR/public.pem")"
node -e 'process.stdout.write(JSON.stringify({kid:process.env.KID,privateKeyPem:process.env.PRIVATE_KEY,publicKeyPem:process.env.PUBLIC_KEY,not_before:process.env.NOT_BEFORE,not_after:process.env.NOT_AFTER}))' > "$WORKDIR/secret.json"

if aws secretsmanager describe-secret --secret-id "$SECRET_ID" --region "$REGION" >/dev/null 2>&1; then
  [[ -n "$CONFIRM_OVERLAP_KID" ]] || { echo "error: rotation requires --confirm-overlap-kid after the outgoing key is deployed as overlap" >&2; exit 2; }
  CURRENT_KID="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" --query SecretString --output text | node -e 'let input=""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { process.stdout.write(JSON.parse(input).kid || ""); });')"
  [[ "$CURRENT_KID" == "$CONFIRM_OVERLAP_KID" ]] || { echo "error: --confirm-overlap-kid must equal the currently active secret kid" >&2; exit 2; }
  aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://$WORKDIR/secret.json" --region "$REGION" >/dev/null
  echo "rotated dedicated enrollment signing secret $SECRET_ID"
else
  aws secretsmanager create-secret --name "$SECRET_ID" --secret-string "file://$WORKDIR/secret.json" --region "$REGION" >/dev/null
  echo "created dedicated enrollment signing secret $SECRET_ID"
fi
