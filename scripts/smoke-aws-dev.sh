#!/usr/bin/env bash
# Post-deploy smoke checks for the AWS dev rollout of Engram + Pulse.
#
# Validates:
#   - Engram health endpoint is up and reports the expected version (if pinned)
#   - Pulse health endpoint is up
#   - ADR-009 per-user app entitlement routes exist on Engram (return 401 unauth, not 404)
#   - Authed /account page returns 200 (not 307 → /login) for a valid session cookie
#     (only when SMOKE_EMAIL + SMOKE_PASSWORD are set)
#
# Usage:
#   scripts/smoke-aws-dev.sh                       # run all public-facing checks
#   EXPECTED_ENGRAM_VERSION=0.19.0 scripts/smoke-aws-dev.sh
#   ENGRAM_BASE=http://localhost:3104 scripts/smoke-aws-dev.sh   # run against host-local
#   SMOKE_EMAIL=demo.owner@ctxhost.local SMOKE_PASSWORD=… scripts/smoke-aws-dev.sh
#
# Exit codes: 0 = all checks pass, 1 = any check failed.

set -uo pipefail

ENGRAM_BASE="${ENGRAM_BASE:-https://login.dev.ctxhost.com}"
PULSE_BASE="${PULSE_BASE:-https://cortex.dev.ctxhost.com/pulse}"
EXPECTED_ENGRAM_VERSION="${EXPECTED_ENGRAM_VERSION:-}"
SMOKE_EMAIL="${SMOKE_EMAIL:-}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-}"

# Public probe IDs — safe to hit unauthenticated. The entitlement route returns
# 401 even for non-existent userIds, which is exactly what we want to verify
# (route exists, just rejects us). Use cortex orgId because that org definitely
# exists on AWS dev; userId is a syntactically valid placeholder.
PROBE_ORG_ID="${PROBE_ORG_ID:-cmo95brco000201ozvrgx7cxk}"
PROBE_USER_ID="${PROBE_USER_ID:-00000000-0000-0000-0000-000000000000}"

PASS=0
FAIL=0

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }

check() {
    local name="$1"; shift
    if "$@"; then
        green "✓ $name"
        PASS=$((PASS + 1))
    else
        red "✗ $name"
        FAIL=$((FAIL + 1))
    fi
}

http_status() {
    curl -s -o /dev/null -w '%{http_code}' "$1"
}

engram_health_ok() {
    local body
    body=$(curl -fsS "${ENGRAM_BASE}/api/health") || return 1
    echo "  body: ${body}"
    echo "$body" | grep -q '"status":"ok"' || return 1
    if [[ -n "$EXPECTED_ENGRAM_VERSION" ]]; then
        echo "$body" | grep -q "\"version\":\"${EXPECTED_ENGRAM_VERSION}\"" || {
            echo "  expected version ${EXPECTED_ENGRAM_VERSION} not found in body"
            return 1
        }
    fi
}

pulse_health_ok() {
    local body
    body=$(curl -fsS "${PULSE_BASE}/api/health") || return 1
    echo "  body: ${body}"
    echo "$body" | grep -q '"status":"ok"' || return 1
}

entitlement_route_exists() {
    local code
    code=$(http_status "${ENGRAM_BASE}/api/orgs/${PROBE_ORG_ID}/users/${PROBE_USER_ID}/app-entitlements")
    echo "  GET app-entitlements -> ${code}"
    [[ "$code" == "401" ]]
}

entitlement_users_route_exists() {
    local code
    code=$(http_status "${ENGRAM_BASE}/api/orgs/${PROBE_ORG_ID}/app-entitlements/pulse/users")
    echo "  GET app-entitlements/pulse/users -> ${code}"
    [[ "$code" == "401" ]]
}

entitlement_delete_route_exists() {
    # Unauth DELETE on a known path. Method-Not-Allowed (405) would mean the
    # route doesn't accept DELETE; 404 would mean the path is missing entirely.
    # We expect 401 (auth gate fires before method dispatch).
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
        "${ENGRAM_BASE}/api/orgs/${PROBE_ORG_ID}/users/${PROBE_USER_ID}/app-entitlements/pulse")
    echo "  DELETE app-entitlements/pulse -> ${code}"
    [[ "$code" == "401" ]]
}

# Verify that authenticated requests to page routes work (not 307→/login loop).
# This catches the Next.js standalone cookies() regression where server components
# couldn't read the session cookie even with a valid token.
#
# Note: POST /api/auth/login is rate-limited. Repeated smoke runs may get 429
# ("rate-limited", not "broken") — retry after ~60 s or set ENGRAM_RATE_LIMIT_DISABLED=1
# in a dedicated test environment.
authed_pages_ok() {
    local jar
    jar=$(mktemp)
    trap 'rm -f "${jar}"' RETURN

    local login_code
    login_code=$(curl -s -c "${jar}" -o /dev/null -w '%{http_code}' \
        -X POST "${ENGRAM_BASE}/api/auth/login" \
        -H 'Content-Type: application/json' \
        -H "Origin: ${ENGRAM_BASE}" \
        -d "{\"email\":\"${SMOKE_EMAIL}\",\"password\":\"${SMOKE_PASSWORD}\"}")
    echo "  POST /api/auth/login -> ${login_code}"
    if [[ "$login_code" == "429" ]]; then
        echo "  (rate-limited — retry after ~60 s)"
        return 1
    fi
    if [[ "$login_code" != "200" ]]; then
        return 1
    fi

    # /account page must render (200) — exercises the force-dynamic fix for
    # cookies() in standalone builds (account/page.tsx).
    local account_code
    account_code=$(curl -s -b "${jar}" -o /dev/null -w '%{http_code}' \
        "${ENGRAM_BASE}/account")
    echo "  GET /account (authed) -> ${account_code}"

    # / must redirect somewhere that is NOT /login — exercises the
    # try/catch fix in page.tsx that previously swallowed NEXT_REDIRECT.
    local root_loc
    root_loc=$(curl -s -b "${jar}" -o /dev/null -w '%{redirect_url}' \
        "${ENGRAM_BASE}/")
    echo "  GET / (authed) redirect_url -> ${root_loc}"
    local root_ok=1
    [[ -n "$root_loc" && "$root_loc" != *"/login"* ]] || root_ok=0

    [[ "$account_code" == "200" && "$root_ok" -eq 1 ]]
}

echo "== smoke checks =="
echo "engram base: ${ENGRAM_BASE}"
echo "pulse base:  ${PULSE_BASE}"
echo

check "engram health responds" engram_health_ok
check "pulse health responds" pulse_health_ok
check "ADR-009 GET/PUT entitlement route exists" entitlement_route_exists
check "ADR-009 GET app-entitlements/<appKey>/users route exists" entitlement_users_route_exists
check "ADR-009 DELETE entitlement route exists" entitlement_delete_route_exists
if [[ -n "$SMOKE_EMAIL" && -n "$SMOKE_PASSWORD" ]]; then
    check "authed page routes: /account=200 and /=redirect-not-to-login" authed_pages_ok
else
    echo "  (skipping authed page checks — set SMOKE_EMAIL + SMOKE_PASSWORD to enable)"
fi

echo
echo "== summary =="
echo "passed: ${PASS}"
echo "failed: ${FAIL}"

[[ "$FAIL" -eq 0 ]]
