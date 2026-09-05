#!/usr/bin/env bash
set -euo pipefail

# Engram aws-prod promotion (auth.ccgtradepost.com / login.ctxhost.com).
#
# Codifies docs/runbooks/prod-promotion.md. Prod is HUMAN-DIRECTED
# (ADR-025 §11, amended 2026-08-14): a human decides each promotion. An agent
# may run this script when explicitly directed to for that specific promotion,
# after rehearsing with --dry-run and reporting the plan — but never on its own
# initiative, including inside an autonomous goal session. It just turns the
# long `gh workflow run deploy-prod.yml` command into one guarded call with the
# current cert/WAF/zone values.
#
# Deploys build from `main` HEAD — what is merged is what ships.

REPO="${ENGRAM_REPO:-cortex-mesh/engram}"

# The certificate inputs are resolved from this live stack immediately before
# dispatch. Do not add static ARN defaults here: an ACM replacement makes them
# stale while still looking syntactically valid.
STACK="${STACK:-engram-prod-web}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-Z099959326CYRBW3F5PTA}"
BUDGET_ALERT_EMAIL="${BUDGET_ALERT_EMAIL:-ops@example.com}"
CERT_STACK_NAME="engram-prod-cert"
CERT_STACK_REGION="us-east-1"
PROD_HOSTED_ZONE_ID="Z099959326CYRBW3F5PTA"
# This chooses local AWS credentials only. It does not change the fixed live
# cert-stack name, region, account validation, or certificate/WebACL provenance.
AWS_PROFILE_NAME="${ENGRAM_AWS_PROFILE:-cortex}"
PROD_ACCOUNT_ID="782369544445"
PROD_REGION="us-west-2"
ENROLLMENT_SIGNING_SECRET_ID="cortex/prod/engram/enrollment-signing"
RUNTIME_SECRET_ID="cortex/prod/engram/runtime"

# A pair of explicit inputs is permitted only for a reviewed exception passed
# on this invocation. The acknowledgement is intentionally a command-line flag,
# so inherited environment variables cannot silently turn stale values into
# production deploy inputs.
EXPLICIT_CERTIFICATE_ARN="${CERTIFICATE_ARN:-}"
EXPLICIT_WEB_ACL_ARN="${WEB_ACL_ARN:-}"

# The cert stack must always be dispatched alone because it produces the inputs
# consumed by the web stack. --full covers the remaining prod stacks only.
FULL_STACK="engram-prod-data engram-prod-web engram-prod-ops"
KNOWN_STACKS="engram-prod-cert $FULL_STACK"

YES=0
WATCH=0
FULL=0
REF_INPUT=
BOOTSTRAP_CERT=0
REVIEWED_CERT_OVERRIDE=0
DRY_RUN=0
VALIDATED_STACKS=()

usage() {
  cat <<'EOF'
Usage: scripts/promote-prod.sh [--dry-run] [--yes] [--watch] [--full] [--ref <commit>] [--bootstrap-cert] [--reviewed-cert-override]

Dispatches .github/workflows/deploy-prod.yml to promote main HEAD to aws-prod.

  --dry-run run every precondition and print the exact dispatch inputs, then
            exit WITHOUT dispatching. This is the rehearsal: it resolves live
            cert-stack outputs, checks CI, the live prod migration gate, and the
            Cite enrollment secrets, so a green dry run means the real run's
            preconditions hold. Cannot be combined with --yes or --watch, which
            only make sense when actually dispatching.
  --yes     skip the interactive confirmation
  --watch   follow the dispatched run to completion (gh run watch)
  --full    deploy data+web+ops instead of just web. Treat data-stack changes
            as their own reviewed event; migrations are separately human-gated.
            The cert stack is always a separate dispatch.
  --ref <commit>
            deploy an older commit instead of main HEAD. It must already be
            merged (an ancestor of origin/main) and CI-green, so this stages
            reviewed code — it never ships anything main has not accepted.
            Needed when main cannot be shipped in one step, e.g. removing a
            cross-stack export: CloudFormation refuses to delete an export
            while another stack still imports it, so the importing stack must
            be deployed from an earlier commit first. See
            docs/runbooks/prod-promotion.md.
  --bootstrap-cert
            dispatch engram-prod-cert alone with blank certificate/WebACL
            inputs for a first deployment or disaster-recovery bootstrap.
  --reviewed-cert-override
            acknowledge human review of a CERTIFICATE_ARN + WEB_ACL_ARN pair
            supplied for this invocation.

Certificate and WebACL inputs are read from the live engram-prod-cert
CloudFormation outputs using the AWS profile selected by ENGRAM_AWS_PROFILE
(default: "cortex"). To use reviewed explicit values, set CERTIFICATE_ARN and WEB_ACL_ARN together and pass
--reviewed-cert-override. The live source is fixed to the engram-prod-cert
stack in the fixed region us-east-1; the profile override changes credentials
only. Other overrides: STACK, HOSTED_ZONE_ID, BUDGET_ALERT_EMAIL, ENGRAM_REPO.

Preconditions (checked): gh authed, origin/main CI green on HEAD, no pending
Prisma migration in the not-yet-shipped diff, and the Cite enrollment signing
secret + runtime consumer credential are present. Rehearse them all with
--dry-run. See docs/runbooks/prod-promotion.md.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --watch) WATCH=1 ;;
    --full) FULL=1 ;;
    --ref) shift; [ "$#" -gt 0 ] || { echo "error: --ref needs a commit" >&2; exit 2; }; REF_INPUT="$1" ;;
    --bootstrap-cert) BOOTSTRAP_CERT=1 ;;
    --reviewed-cert-override) REVIEWED_CERT_OVERRIDE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# STACK is user-controlled input. Disable pathname expansion before splitting
# it so validation and workflow dispatch operate on the same stack names.
set -f

# --yes ("don't ask before dispatching") and --watch ("follow the dispatched
# run") both assert an intent to dispatch, which --dry-run contradicts. Reject
# the combination rather than silently honouring one: the dangerous misreading
# is someone believing `--dry-run --yes` is the guarded way to promote.
if [ "$DRY_RUN" -eq 1 ] && { [ "$YES" -eq 1 ] || [ "$WATCH" -eq 1 ]; }; then
  echo "error: --dry-run cannot be combined with --yes or --watch; it never dispatches. Aborting." >&2
  exit 2
fi

if [ "$FULL" -eq 1 ] && [ "$BOOTSTRAP_CERT" -eq 1 ]; then
  echo "error: --full and --bootstrap-cert cannot be used together. Aborting." >&2
  exit 2
fi
if [ "$BOOTSTRAP_CERT" -eq 1 ]; then
  if [ -n "$EXPLICIT_CERTIFICATE_ARN" ] || [ -n "$EXPLICIT_WEB_ACL_ARN" ] || [ "$REVIEWED_CERT_OVERRIDE" -eq 1 ]; then
    echo "error: --bootstrap-cert requires blank certificate/WebACL inputs; do not supply overrides or --reviewed-cert-override. Aborting." >&2
    exit 2
  fi
  STACK="$CERT_STACK_NAME"
elif [ "$FULL" -eq 1 ]; then
  STACK="$FULL_STACK"
fi

validate_stack_set() {
  local s
  local IFS=$' \t\n'

  VALIDATED_STACKS=()
  for s in $STACK; do
    [[ " $KNOWN_STACKS " == *" $s "* ]] || {
      echo "error: unknown stack '$s' (expected one of: $KNOWN_STACKS). Aborting." >&2
      exit 1
    }
    VALIDATED_STACKS+=("$s")
  done
  [ "${#VALIDATED_STACKS[@]}" -gt 0 ] || {
    echo "error: stack set must contain at least one known stack. Aborting." >&2
    exit 1
  }

  # Dispatch exactly the words we validated, with a predictable separator.
  STACK="$(IFS=' '; printf '%s' "${VALIDATED_STACKS[*]}")"
}

stack_includes_cert_stack() {
  local s

  # validate_stack_set above exits for an empty set; bash 3.2 expands an empty
  # array fatally under set -u, so that ordering is intentionally load-bearing.
  for s in "${VALIDATED_STACKS[@]}"; do
    [ "$s" = "$CERT_STACK_NAME" ] && return 0
  done
  return 1
}

validate_stack_set

if stack_includes_cert_stack && [ "${#VALIDATED_STACKS[@]}" -ne 1 ]; then
  echo "error: requested stack set includes ${CERT_STACK_NAME} and other stacks. Deploy ${CERT_STACK_NAME} alone, then re-run the routine web promotion. Aborting." >&2
  exit 1
fi

if [ "$HOSTED_ZONE_ID" != "$PROD_HOSTED_ZONE_ID" ]; then
  echo "error: HOSTED_ZONE_ID must be the prod ctxhost.com zone ${PROD_HOSTED_ZONE_ID}. Aborting." >&2
  exit 1
fi

command -v gh >/dev/null || { echo "error: gh CLI not found" >&2; exit 1; }
command -v git >/dev/null || { echo "error: git not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated (gh auth login)" >&2; exit 1; }

validate_promotion_inputs() {
  local certificate_arn="$1"
  local web_acl_arn="$2"

  [[ "$certificate_arn" =~ ^arn:aws:acm:us-east-1:${PROD_ACCOUNT_ID}:certificate/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
    echo "error: certificate ARN is not an us-east-1 ACM certificate in prod account ${PROD_ACCOUNT_ID}. Aborting." >&2
    exit 1
  }
  [[ "$web_acl_arn" =~ ^arn:aws:wafv2:us-east-1:${PROD_ACCOUNT_ID}:global/webacl/[A-Za-z0-9_-]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
    echo "error: WebACL ARN is not a global us-east-1 WAFv2 WebACL in prod account ${PROD_ACCOUNT_ID}. Aborting." >&2
    exit 1
  }
}

resolve_live_output() {
  local output_key="$1"
  local output_value

  if ! output_value="$(aws cloudformation describe-stacks \
    --stack-name "$CERT_STACK_NAME" \
    --region "$CERT_STACK_REGION" \
    --profile "$AWS_PROFILE_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue | [0]" \
    --output text)"; then
    echo "error: could not read ${output_key} from live stack ${CERT_STACK_NAME} in ${CERT_STACK_REGION} (profile ${AWS_PROFILE_NAME}). Aborting." >&2
    exit 1
  fi
  if [ -z "$output_value" ] || [ "$output_value" = "None" ] || [ "$output_value" = "null" ]; then
    echo "error: live stack ${CERT_STACK_NAME} has no ${output_key} output. Aborting." >&2
    exit 1
  fi
  printf '%s\n' "$output_value"
}

if [ "$BOOTSTRAP_CERT" -eq 1 ]; then
  CERTIFICATE_ARN=""
  WEB_ACL_ARN=""
  INPUT_SOURCE="bootstrap cert-stack dispatch (blank certificate/WebACL inputs)"
elif [ -n "$EXPLICIT_CERTIFICATE_ARN" ] || [ -n "$EXPLICIT_WEB_ACL_ARN" ]; then
  if [ -z "$EXPLICIT_CERTIFICATE_ARN" ] || [ -z "$EXPLICIT_WEB_ACL_ARN" ]; then
    echo "error: CERTIFICATE_ARN and WEB_ACL_ARN must be supplied together; refusing a mixed live/stale input set." >&2
    exit 1
  fi
  if [ "$REVIEWED_CERT_OVERRIDE" -ne 1 ]; then
    echo "error: explicit certificate/WebACL overrides require --reviewed-cert-override after human review. Aborting." >&2
    exit 1
  fi
  CERTIFICATE_ARN="$EXPLICIT_CERTIFICATE_ARN"
  WEB_ACL_ARN="$EXPLICIT_WEB_ACL_ARN"
  INPUT_SOURCE="reviewed explicit overrides"

  if command -v aws >/dev/null; then
    live_resolution_stderr="$(mktemp)"
    if LIVE_CERTIFICATE_ARN="$(resolve_live_output CertificateArn 2>"$live_resolution_stderr")" && \
      LIVE_WEB_ACL_ARN="$(resolve_live_output WebAclArn 2>>"$live_resolution_stderr")"; then
      if [ "$CERTIFICATE_ARN" != "$LIVE_CERTIFICATE_ARN" ]; then
        echo "warning: overriding live certificate_arn '$LIVE_CERTIFICATE_ARN' with '$CERTIFICATE_ARN'." >&2
      fi
      if [ "$WEB_ACL_ARN" != "$LIVE_WEB_ACL_ARN" ]; then
        echo "warning: overriding live web_acl_arn '$LIVE_WEB_ACL_ARN' with '$WEB_ACL_ARN'." >&2
      fi
    else
      echo "warning: could not resolve live cert-stack outputs for comparison; continuing with reviewed explicit overrides." >&2
      sed 's/^/         /' "$live_resolution_stderr" >&2
    fi
    rm -f "$live_resolution_stderr"
  else
    echo "warning: AWS CLI not found; cannot compare reviewed explicit overrides with live cert-stack outputs." >&2
  fi
else
  if stack_includes_cert_stack; then
    echo "error: requested stack set includes ${CERT_STACK_NAME}; use reviewed explicit certificate/WebACL overrides after the cert-stack change is reviewed. Aborting." >&2
    exit 1
  fi
  command -v aws >/dev/null || { echo "error: AWS CLI not found; cannot resolve live cert-stack outputs" >&2; exit 1; }
  CERTIFICATE_ARN="$(resolve_live_output CertificateArn)"
  WEB_ACL_ARN="$(resolve_live_output WebAclArn)"
  INPUT_SOURCE="live ${CERT_STACK_NAME} CloudFormation outputs"
fi
if [ "$BOOTSTRAP_CERT" -ne 1 ]; then
  validate_promotion_inputs "$CERTIFICATE_ARN" "$WEB_ACL_ARN"
fi

echo "==> Checking preconditions on $REPO ..."
git fetch origin main --quiet
HEAD_SHA="$(git rev-parse origin/main)"
echo "    origin/main HEAD: ${HEAD_SHA:0:7} $(git log -1 --format='%s' "$HEAD_SHA")"

# TARGET_SHA is what actually ships. It is main HEAD unless --ref stages an
# earlier commit, and every precondition below is evaluated against it rather
# than HEAD so a staged promotion is gated exactly as strictly as a normal one.
if [ -n "$REF_INPUT" ]; then
  git fetch origin --quiet
  TARGET_SHA="$(git rev-parse --verify "${REF_INPUT}^{commit}" 2>/dev/null)" || {
    echo "error: --ref '$REF_INPUT' is not a commit this checkout knows. Fetch it first. Aborting." >&2
    exit 1
  }
  # The safety property: only reviewed, merged code reaches prod. An ancestor
  # of main has been through PR review and the branch protections; an arbitrary
  # commit has not.
  if ! git merge-base --is-ancestor "$TARGET_SHA" "$HEAD_SHA"; then
    echo "error: --ref ${TARGET_SHA:0:7} is not an ancestor of origin/main ${HEAD_SHA:0:7}." >&2
    echo "       Only code already merged to main may be promoted. Aborting." >&2
    exit 1
  fi
  if [ "$TARGET_SHA" = "$HEAD_SHA" ]; then
    echo "    --ref resolves to main HEAD; this is an ordinary promotion."
  else
    BEHIND="$(git rev-list --count "$TARGET_SHA..$HEAD_SHA")"
    echo "    STAGED promotion: shipping ${TARGET_SHA:0:7} $(git log -1 --format='%s' "$TARGET_SHA")"
    echo "                      ($BEHIND commit(s) behind main — main is NOT being shipped)"
  fi
else
  TARGET_SHA="$HEAD_SHA"
fi

# 1. CI must be green for the code that will ship — which is TARGET_SHA, not
#    necessarily main HEAD.
if [ "$TARGET_SHA" != "$HEAD_SHA" ]; then
  # Staged promotion. main's own CI state is deliberately NOT consulted: it
  # describes commits this run is explicitly not shipping, so gating on it
  # would block a staged promotion whenever main happened to be red or still
  # building — exactly when staging is most likely to be needed. The target was
  # merged through a PR, so it has a CI run of its own; require that.
  TARGET_CI="$(gh run list --repo "$REPO" --workflow CI --limit 100 \
    --json headSha,conclusion \
    --jq "[.[] | select(.headSha==\"$TARGET_SHA\" and .conclusion==\"success\")] | length" 2>/dev/null || echo 0)"
  if [ "${TARGET_CI:-0}" -lt 1 ]; then
    echo "error: no successful CI run found for --ref ${TARGET_SHA:0:7}." >&2
    echo "       Only a commit whose own CI passed may be staged. Aborting." >&2
    exit 1
  fi
  echo "    CI: green on target ${TARGET_SHA:0:7} ✓ (main's CI state is not consulted for a staged promotion)"
else
  # Routine promotion. The Auto Version workflow pushes a trivial
  # "chore(version): bump" commit as the new main HEAD which has no CI run of
  # its own, so we key off the latest CI run and require it to be (a) success
  # and (b) an ancestor of HEAD (i.e. HEAD is that commit or only version-bump
  # commits sit on top of it).
  read -r CI_STATE CI_SHA <<<"$(gh run list --repo "$REPO" --branch main --workflow CI --limit 1 \
    --json headSha,conclusion,status \
    --jq '.[0] | "\(.status)/\(.conclusion) \(.headSha)"' 2>/dev/null || true)"
  case "$CI_STATE" in
    completed/success) : ;;
    ""|*/null|*null) echo "error: no completed CI run found on main (still running?). Re-run when CI is green." >&2; exit 1 ;;
    *) echo "error: latest main CI is '$CI_STATE' (${CI_SHA:0:7}), not success. Aborting." >&2; exit 1 ;;
  esac
  if [ "$CI_SHA" != "$HEAD_SHA" ] && ! git merge-base --is-ancestor "$CI_SHA" "$HEAD_SHA" 2>/dev/null; then
    echo "error: green CI commit ${CI_SHA:0:7} is not an ancestor of HEAD ${HEAD_SHA:0:7} — HEAD has un-CI'd code. Aborting." >&2
    exit 1
  fi
  echo "    CI: green (${CI_SHA:0:7}), reachable from HEAD ✓"
fi

# 2. Migrations are a separate, human-approved event — never fold one silently
#    into a routine promotion. The authoritative question is "has prod APPLIED
#    them", which only prod can answer; a git diff cannot.
#
#    This used to be `git diff -- prisma/migrations/**` against the last
#    successful prod deploy. That proxy deadlocks: once a migration is applied
#    via the bastion, its FILES remain in the diff forever, so the check fires
#    on every subsequent promotion — and because it blocks the deploy, the last
#    successful-deploy SHA never advances to clear it. Hit for real on
#    2026-07-31 after 0026/0027 were applied (prod verified 27/27, live gate
#    green) and there is no override flag for it. See ADR-032 / ADR-033.
#
#    `prisma/manual-migrations/**` is NOT prisma-tracked, so prod's applied set
#    cannot vouch for it; those always block.
LAST_PROD_DEPLOY_SHA="$(gh run list --repo "$REPO" --workflow deploy-prod.yml \
  --json headSha,conclusion --jq '[.[] | select(.conclusion=="success")][0].headSha' 2>/dev/null || true)"
if [ -n "$LAST_PROD_DEPLOY_SHA" ] && git cat-file -e "$LAST_PROD_DEPLOY_SHA" 2>/dev/null; then
  if git diff --name-only "$LAST_PROD_DEPLOY_SHA" "$TARGET_SHA" -- 'prisma/manual-migrations/**' | grep -q .; then
    echo "error: manual migration in the diff since last prod deploy (${LAST_PROD_DEPLOY_SHA:0:7})." >&2
    echo "       prisma/manual-migrations/** is not prisma-tracked, so prod cannot confirm it was" >&2
    echo "       applied. Apply and verify it as its own reviewed event. Aborting." >&2
    exit 1
  fi
fi

# Authoritative, live check (ADR-032): diff THIS checkout's migrations against
# the set prod reports as applied. Fails closed on 5xx / malformed responses.
if ! bash "$(dirname "$0")/check-prod-migration-gate.sh"; then
  echo "error: prod schema is not current with this build." >&2
  echo "       Apply the pending migrations first (human-gated bastion —" >&2
  echo "       docs/runbooks/prod-db-migration-verify-apply.md), then re-run. Aborting." >&2
  exit 1
fi
echo "    Migrations: prod schema current with this build ✓"

# Production stack dynamic references are resolved by CloudFormation during a
# stack update, not at Lambda request time. Fail before dispatch with the two
# Cite requirements that this PR introduces rather than discovering them in a
# rolled-back shared-IdP deployment.
if ! stack_includes_cert_stack; then
  if ! aws secretsmanager describe-secret \
    --secret-id "$ENROLLMENT_SIGNING_SECRET_ID" \
    --region "$PROD_REGION" \
    --profile "$AWS_PROFILE_NAME" >/dev/null 2>&1; then
    echo "error: required Cite enrollment signing secret '$ENROLLMENT_SIGNING_SECRET_ID' is absent or unreadable." >&2
    echo "       Create it through docs/runbooks/enrollment-signing-secret-provisioning.md before promotion. Aborting." >&2
    exit 1
  fi
  # The stack used to inject the five signing fields as {{resolve:...}} refs, so
  # a missing or malformed secret failed the stack update — ADR-034 §8.2's
  # deploy-time gate. Those refs are gone: their combined size exceeded Lambda's
  # configuration-request limit, and prod now receives only the secret NAME and
  # loads the fields at runtime. Existence alone is therefore no longer proof of
  # a usable key, so validate the contract here instead. This is a stronger gate
  # than the one it replaces — CloudFormation only checked that each JSON key
  # resolved, never that the values formed a working key.
  if ! enrollment_secret_json="$(aws secretsmanager get-secret-value \
    --secret-id "$ENROLLMENT_SIGNING_SECRET_ID" \
    --region "$PROD_REGION" \
    --profile "$AWS_PROFILE_NAME" \
    --query SecretString --output text 2>/dev/null)"; then
    echo "error: Cite enrollment signing secret '$ENROLLMENT_SIGNING_SECRET_ID' is unreadable." >&2
    exit 1
  fi
  # python3, not node: check-prod-migration-gate.sh already depends on it, and
  # it is present at /usr/bin/python3 in the minimal environments this script
  # runs under.
  # Capture python's own exit code. `if ! cmd; then status=$?` would record the
  # status of the negation (always 0 there), collapsing "expired window" into
  # "malformed contract" and reporting the wrong remediation.
  enrollment_secret_status=0
  printf '%s' "$enrollment_secret_json" | python3 -c '
import sys, json
from datetime import datetime, timezone

try:
    parsed = json.load(sys.stdin)
except Exception:
    sys.exit(1)

for field in ("kid", "privateKeyPem", "publicKeyPem", "not_before", "not_after"):
    value = parsed.get(field)
    if not isinstance(value, str) or not value.strip():
        sys.exit(1)

if "BEGIN" not in parsed["privateKeyPem"] or "BEGIN" not in parsed["publicKeyPem"]:
    sys.exit(1)


def instant(raw):
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


try:
    not_before, not_after = instant(parsed["not_before"]), instant(parsed["not_after"])
except ValueError:
    sys.exit(1)
if not_before.tzinfo is None or not_after.tzinfo is None:
    sys.exit(1)

# The window must still be open, or the authority mints nothing and the surface
# degrades to 503 immediately after an otherwise successful promotion.
now = datetime.now(timezone.utc)
if now < not_before or now >= not_after:
    sys.exit(2)
' || enrollment_secret_status=$?
  if [ "$enrollment_secret_status" -ne 0 ]; then
    if [ "$enrollment_secret_status" -eq 2 ]; then
      echo "error: Cite enrollment signing key is outside its validity window." >&2
      echo "       Rotate it before promotion — see docs/runbooks/enrollment-signing-secret-provisioning.md. Aborting." >&2
    else
      echo "error: Cite enrollment signing secret '$ENROLLMENT_SIGNING_SECRET_ID' does not satisfy the five-field contract." >&2
      echo "       Expected kid, privateKeyPem, publicKeyPem, not_before, not_after. Aborting." >&2
    fi
    exit 1
  fi
  if ! runtime_secret_json="$(aws secretsmanager get-secret-value \
    --secret-id "$RUNTIME_SECRET_ID" \
    --region "$PROD_REGION" \
    --profile "$AWS_PROFILE_NAME" \
    --query SecretString --output text 2>/dev/null)"; then
    echo "error: required runtime secret '$RUNTIME_SECRET_ID' is unreadable." >&2
    echo "       See docs/runbooks/enrollment-signing-secret-provisioning.md. Aborting." >&2
    exit 1
  fi
  if ! printf '%s' "$runtime_secret_json" | grep -Eq '"ENGRAM_AXON_ENROLLMENT_API_KEY"[[:space:]]*:[[:space:]]*"[[:space:]]*[^[:space:]"]'; then
    echo "error: runtime secret '$RUNTIME_SECRET_ID' lacks a non-empty ENGRAM_AXON_ENROLLMENT_API_KEY." >&2
    echo "       Add that key before promotion; see docs/runbooks/enrollment-signing-secret-provisioning.md. Aborting." >&2
    exit 1
  fi
  echo "    Cite enrollment secrets: signing secret and runtime consumer key present ✓"
fi

echo
echo "==> Ready to dispatch deploy-prod.yml:"
echo "      stack               = $STACK"
echo "      ref                 = $TARGET_SHA"
echo "      hosted_zone_id      = $HOSTED_ZONE_ID"
echo "      certificate_arn     = $CERTIFICATE_ARN"
echo "      web_acl_arn         = $WEB_ACL_ARN"
echo "      input source        = $INPUT_SOURCE"
echo "      budget_alert_email  = $BUDGET_ALERT_EMAIL"
echo "    Ships ${TARGET_SHA:0:7} to auth.ccgtradepost.com / login.ctxhost.com."
echo

# Everything above this point is read-only: precondition checks and resolution
# of the dispatch inputs. Exiting here is what makes --dry-run a faithful
# rehearsal — the plan printed above is byte-for-byte the plan the real run
# dispatches, because it is produced by the same code path.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN — all preconditions passed. Nothing was dispatched."
  echo "          Re-run without --dry-run to promote."
  exit 0
fi

if [ "$YES" -ne 1 ]; then
  printf 'Dispatch prod deploy? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

echo "==> Dispatching ..."
gh workflow run deploy-prod.yml --repo "$REPO" \
  -f stack="$STACK" \
  -f ref="$TARGET_SHA" \
  -f hosted_zone_id="$HOSTED_ZONE_ID" \
  -f certificate_arn="$CERTIFICATE_ARN" \
  -f web_acl_arn="$WEB_ACL_ARN" \
  -f budget_alert_email="$BUDGET_ALERT_EMAIL"

echo "==> Dispatched. Recent runs:"
sleep 3
gh run list --repo "$REPO" --workflow deploy-prod.yml --limit 3

if [ "$WATCH" -eq 1 ]; then
  RUN_ID="$(gh run list --repo "$REPO" --workflow deploy-prod.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
  echo "==> Watching run $RUN_ID ..."
  gh run watch "$RUN_ID" --repo "$REPO" --exit-status
fi

cat <<EOF

==> After the run goes green, verify (docs/runbooks/prod-promotion.md §Verify):
    - https://auth.ccgtradepost.com/login?client_id=tradepost-web  renders (expected branding)
    - Full sign-in round-trip from https://ccgtradepost.com with the demo account
    - login.ctxhost.com unaffected for other clients (spot-check one)
EOF
