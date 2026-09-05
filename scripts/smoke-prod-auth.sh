#!/usr/bin/env bash
#
# Engram prod auth-integration smoke: prove every registered consumer app can
# still start a login. Read-only — issues no writes and completes no sign-in.
#
#   ./scripts/smoke-prod-auth.sh                 # check prod
#   ./scripts/smoke-prod-auth.sh --save baseline.txt
#   ./scripts/smoke-prod-auth.sh --compare baseline.txt
#
# Run it BEFORE a promotion (--save) and AFTER (--compare). The comparison is
# the real check: a client that worked before and doesn't now is a dropped
# integration, which is the failure mode that actually costs us.
#
# WHY THIS EXISTS
# Engram prod has essentially no end users, so "downtime" is cheap. What is not
# cheap is silently dropping an app's ability to authenticate: every consumer
# app (Tradepost, Cite/Axon, FieldOps, Synapse native) delegates login here, and
# a broken client registration locks users out of that app with no signal from
# Engram itself. The old runbook said "spot-check one" other client — which is
# exactly how such a break reaches production unnoticed.
#
# THE INVARIANT: THE INVENTORY IS APPEND-ONLY
# We own and operate every consumer app, its infrastructure, and its code, so
# there is never a legitimate reason to remove a client registration or a
# redirect URI. Entries below are added, never deleted. Any promotion that
# turns a passing row into a failing one is a regression, not a planned change.
# This mirrors cortex ADR-128's additive-auto / destructive-human split at the
# auth-contract layer.
#
# HOW THE PROBE WORKS
#   valid client + registered redirect  -> 307 to /api/auth/continue
#   unknown client OR bad redirect      -> 400 invalid_client
# So a 307 means the registration is intact and the login surface is reachable.
# No credentials are needed and no session is created.
#
set -uo pipefail

MODE=check
BASELINE=""
case "${1:-}" in
  --save)    MODE=save;    BASELINE="${2:?--save needs a path}" ;;
  --compare) MODE=compare; BASELINE="${2:?--compare needs a path}" ;;
  --help|-h) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "")        ;;
  *)         echo "unknown option: $1" >&2; exit 2 ;;
esac

# Each consumer app authenticates on ITS OWN branded auth host. login.ctxhost.com
# is NOT a consumer app's host — it is the ctxhost suite's own auth entry, in
# front of platform.ctxhost.com and the tenant workspace hosts.
#
# host | client_id | app | a registered redirect_uri
# APPEND ONLY. Add a row when a new app integrates; never delete one.
INVENTORY=(
  "auth.ccgtradepost.com|tradepost-web|tradepost|https://ccgtradepost.com/auth/callback"
  "auth.citethemove.com|axon-web|axon|https://app.citethemove.com/auth/callback"
)

# Registered in the prod DB but not yet reachable, because the branded auth host
# and/or the app host is not provisioned. Reported, never failed — an unbuilt
# host is not a regression. Promote a row into INVENTORY once its host is live.
PENDING=(
  # fieldops-web: client + redirect registered by migrations 0026/0027 and the
  # `fieldops` AppKey exists, but auth.fieldops.club (branded auth host) and
  # app.fieldops.club both NXDOMAIN — both are FieldOps M4 work. The
  # registration is inert until then.
  "auth.fieldops.club|fieldops-web|fieldops|https://app.fieldops.club/auth/callback"
)

# Suite surfaces that must stay reachable. These use browser cookie SSO rather
# than native PKCE, so they are checked for reachability, not via /authorize.
SUITE_HOSTS=(
  "login.ctxhost.com"
  "platform.ctxhost.com"
)

urlenc() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }

# A fixed, syntactically valid S256 challenge. Nothing is exchanged for it.
CHALLENGE=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM

probe() {
  local host="$1" cid="$2" app="$3" ru="$4"
  curl -s -m 15 -o /dev/null -w '%{http_code}' \
    "https://${host}/authorize?client_id=${cid}&app=${app}&redirect_uri=$(urlenc "$ru")&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=smoke" \
    2>/dev/null || echo "000"
}

RESULTS=""
FAIL=0

printf '== engram prod auth-integration smoke ==\n'
printf 'engram version: %s\n\n' \
  "$(curl -s -m 10 https://login.ctxhost.com/api/health 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])' 2>/dev/null || echo unknown)"

printf -- '-- consumer app integrations (must all be ok) --\n'
for row in "${INVENTORY[@]}"; do
  IFS='|' read -r host cid app ru <<<"$row"
  code=$(probe "$host" "$cid" "$app" "$ru")
  if [ "$code" = "307" ]; then verdict=ok; else verdict=BROKEN; FAIL=$((FAIL+1)); fi
  printf '  %-22s %-14s %-10s %s  %s\n' "$host" "$cid" "$app" "$code" "$verdict"
  RESULTS+="${host} ${cid} ${app} ${verdict}"$'\n'
done

printf -- '\n-- suite surfaces (cookie SSO; reachability only) --\n'
for host in "${SUITE_HOSTS[@]}"; do
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://${host}/" 2>/dev/null || echo 000)
  case "$code" in
    2??|3??) verdict=ok ;;
    *)       verdict=BROKEN; FAIL=$((FAIL+1)) ;;
  esac
  printf '  %-22s %-25s %s  %s\n' "$host" "" "$code" "$verdict"
  RESULTS+="${host} - suite ${verdict}"$'\n'
done

if [ "${#PENDING[@]}" -gt 0 ]; then
  printf -- '\n-- pending (registered, host not provisioned; informational) --\n'
  for row in "${PENDING[@]}"; do
    IFS='|' read -r host cid app ru <<<"$row"
    if [ -n "$(dig +short "$host" 2>/dev/null | tail -1)" ]; then
      code=$(probe "$host" "$cid" "$app" "$ru")
      note="host now resolves — code ${code}; if 307, move this row into INVENTORY"
    else
      note="NXDOMAIN — not yet provisioned"
    fi
    printf '  %-22s %-14s %-10s %s\n' "$host" "$cid" "$app" "$note"
  done
fi

printf '\n'

case "$MODE" in
  save)
    printf '%s' "$RESULTS" > "$BASELINE"
    printf 'baseline saved: %s\n' "$BASELINE"
    printf '(failures here are pre-existing state, not promotion damage)\n'
    exit 0
    ;;
  compare)
    [ -f "$BASELINE" ] || { echo "no baseline at $BASELINE" >&2; exit 2; }
    printf '== compare vs %s ==\n' "$BASELINE"
    regressed=0
    while read -r host cid app verdict; do
      [ -n "${host:-}" ] || continue
      now=$(printf '%s' "$RESULTS" | awk -v h="$host" -v c="$cid" '$1==h && $2==c {print $4}')
      if [ "$verdict" = "ok" ] && [ "$now" != "ok" ]; then
        printf '  REGRESSION: %s %s worked before, now %s\n' "$host" "$cid" "${now:-missing}"
        regressed=$((regressed+1))
      elif [ "$verdict" != "ok" ] && [ "$now" = "ok" ]; then
        printf '  recovered:  %s %s now ok\n' "$host" "$cid"
      fi
    done < "$BASELINE"
    if [ "$regressed" -gt 0 ]; then
      printf '\nFAIL: %d integration(s) regressed — roll back (see docs/runbooks/prod-promotion.md)\n' "$regressed"
      exit 1
    fi
    printf '  no regressions\n\nPASS\n'
    exit 0
    ;;
  check)
    if [ "$FAIL" -gt 0 ]; then
      printf 'FAIL: %d integration(s) not reachable\n' "$FAIL"
      exit 1
    fi
    printf 'PASS: all %d integrations reachable\n' "${#INVENTORY[@]}"
    exit 0
    ;;
esac
