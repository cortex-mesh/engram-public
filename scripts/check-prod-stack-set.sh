#!/usr/bin/env bash
set -euo pipefail

# Server-side gate for deploy-prod.yml. The cert stack produces the inputs the
# web stack consumes, so deploying it with another stack would use stale inputs.
# This runs before AWS credentials are configured, so it validates only stack
# names and input shape; it cannot prove a well-formed ARN is live or current.
STACK_SET="${1:-}"
CERTIFICATE_ARN="${2:-}"
WEB_ACL_ARN="${3:-}"
HOSTED_ZONE_ID="${4:-}"
BUDGET_ALERT_EMAIL="${5:-}"
CERT_STACK_NAME="engram-prod-cert"
KNOWN_STACKS="engram-prod-cert engram-prod-data engram-prod-web engram-prod-ops"
PROD_ACCOUNT_ID="782369544445"
PROD_HOSTED_ZONE_ID="Z099959326CYRBW3F5PTA"

set -f
IFS=$' \t\n'
STACK_COUNT=0
INCLUDES_CERT_STACK=0
INCLUDES_WEB_STACK=0

for stack in $STACK_SET; do
  case " $KNOWN_STACKS " in
    *" $stack "*) ;;
    *)
      echo "error: unknown stack '$stack' (expected one of: $KNOWN_STACKS). Aborting." >&2
      exit 1
      ;;
  esac
  STACK_COUNT=$((STACK_COUNT + 1))
  [ "$stack" = "$CERT_STACK_NAME" ] && INCLUDES_CERT_STACK=1
  [ "$stack" = "engram-prod-web" ] && INCLUDES_WEB_STACK=1
done

if [ "$STACK_COUNT" -eq 0 ]; then
  echo "error: stack set must contain at least one stack. Aborting." >&2
  exit 1
fi

if [ "$INCLUDES_CERT_STACK" -eq 1 ] && [ "$STACK_COUNT" -ne 1 ]; then
  echo "error: requested stack set includes ${CERT_STACK_NAME} and other stacks. Deploy ${CERT_STACK_NAME} alone, then dispatch the routine web promotion. Aborting." >&2
  exit 1
fi

if [ "$HOSTED_ZONE_ID" != "$PROD_HOSTED_ZONE_ID" ]; then
  echo "error: hosted_zone_id must be the prod ctxhost.com zone ${PROD_HOSTED_ZONE_ID}. Aborting." >&2
  exit 1
fi

[[ "$BUDGET_ALERT_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || {
  echo "error: budget_alert_email must be a non-empty email address. Aborting." >&2
  exit 1
}

if [ -z "$CERTIFICATE_ARN" ] && [ -z "$WEB_ACL_ARN" ]; then
  # The cert, data, and ops stacks do not consume the cert/WebACL pair. Web
  # does, so it remains fail-closed until the cert stack has live outputs.
  if [ "$INCLUDES_WEB_STACK" -eq 0 ]; then
    exit 0
  fi
  echo "error: certificate_arn and web_acl_arn are required when deploying engram-prod-web. Aborting." >&2
  exit 1
fi

if [ -z "$CERTIFICATE_ARN" ] || [ -z "$WEB_ACL_ARN" ]; then
  echo "error: certificate_arn and web_acl_arn must be supplied together. Aborting." >&2
  exit 1
fi

[[ "$CERTIFICATE_ARN" =~ ^arn:aws:acm:us-east-1:${PROD_ACCOUNT_ID}:certificate/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
  echo "error: certificate ARN is not an us-east-1 ACM certificate in prod account ${PROD_ACCOUNT_ID}. Aborting." >&2
  exit 1
}
[[ "$WEB_ACL_ARN" =~ ^arn:aws:wafv2:us-east-1:${PROD_ACCOUNT_ID}:global/webacl/[A-Za-z0-9_-]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
  echo "error: WebACL ARN is not a global us-east-1 WAFv2 WebACL in prod account ${PROD_ACCOUNT_ID}. Aborting." >&2
  exit 1
}
