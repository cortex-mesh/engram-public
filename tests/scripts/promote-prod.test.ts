import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

// Every case here spawnSync's the real promote-prod.sh, which shells out to
// stubbed git/gh/aws/curl. That is several seconds per case even when healthy,
// and the self-hosted CI runner is frequently loaded by concurrent repo builds.
// Vitest's 5s default made the migration-precondition cases flake (observed:
// 7.2s on a busy runner, engram #216 CI). These are process-spawn tests, not
// unit tests — give them room rather than trading away the coverage.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const LIVE_CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:782369544445:certificate/b9c3639d-df1f-41ed-b5fe-2dcc37289198";
const LIVE_WEB_ACL_ARN =
  "arn:aws:wafv2:us-east-1:782369544445:global/webacl/WebAcl-wxvbylmDeGDh/34d26e10-74d1-415a-bd55-bbdc2d21c926";
const TEST_SHA = "1111111111111111111111111111111111111111";
// A secret satisfying the five-field contract with an open validity window.
// prod no longer injects these fields as environment variables (they exceeded
// Lambda's configuration-request limit), so promote-prod validates the secret
// itself — the gate that CloudFormation's dynamic references used to provide.
const VALID_ENROLLMENT_SECRET = JSON.stringify({
  kid: "cite-enrollment-test",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\\ntest\\n-----END PUBLIC KEY-----",
  not_before: "2020-01-01T00:00:00Z",
  not_after: "2099-01-01T00:00:00Z",
});
const PROMOTE_PROD_SCRIPT = resolve("scripts/promote-prod.sh");
const tempDirectories: string[] = [];

// Default stub state for the ADR-032 live migration check: prod has applied
// exactly what this checkout carries, i.e. no drift. Derived from the real
// migrations dir so adding a migration doesn't silently break unrelated tests.
const CHECKOUT_MIGRATIONS = readdirSync(resolve("prisma/migrations"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
  .map((entry) => entry.name);
const NO_DRIFT_BODY = JSON.stringify({ applied: CHECKOUT_MIGRATIONS });

function makeExecutable(directory: string, name: string, source: string) {
  const path = join(directory, name);
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function runPromotion(
  environment: Record<string, string | undefined> = {},
  arguments_ = ["--yes"],
  setup?: (directory: string) => string,
) {
  const directory = mkdtempSync(join(tmpdir(), "engram-promote-prod-"));
  tempDirectories.push(directory);
  const trace = join(directory, "gh-trace");

  makeExecutable(
    directory,
    "aws",
    `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" --profile ${environment.EXPECTED_AWS_PROFILE ?? "cortex"} "*) ;;
  *) echo "unexpected AWS profile: $*" >&2; exit 2 ;;
esac
if [ "${environment.FAKE_AWS_EXIT ?? "0"}" != "0" ]; then
  echo "simulated AWS failure" >&2
  exit "${environment.FAKE_AWS_EXIT ?? "0"}"
fi
case "$*" in
  *"secretsmanager describe-secret"*)
    if [ "${environment.FAKE_ENROLLMENT_SIGNING_SECRET_EXIT ?? "0"}" != "0" ]; then exit "${environment.FAKE_ENROLLMENT_SIGNING_SECRET_EXIT ?? "0"}"; fi
    printf '{}\\n'
    ;;
  *"secretsmanager get-secret-value"*enrollment-signing*)
    if [ "${environment.FAKE_ENROLLMENT_SECRET_EXIT ?? "0"}" != "0" ]; then exit "${environment.FAKE_ENROLLMENT_SECRET_EXIT ?? "0"}"; fi
    printf '%s\\n' '${environment.FAKE_ENROLLMENT_SECRET_JSON ?? VALID_ENROLLMENT_SECRET}'
    ;;
  *"secretsmanager get-secret-value"*)
    if [ "${environment.FAKE_RUNTIME_SECRET_EXIT ?? "0"}" != "0" ]; then exit "${environment.FAKE_RUNTIME_SECRET_EXIT ?? "0"}"; fi
    printf '%s\\n' '${environment.FAKE_RUNTIME_SECRET_JSON ?? '{"ENGRAM_AXON_ENROLLMENT_API_KEY":"test-key"}'}'
    ;;
  *CertificateArn*)
    if [ "${environment.FAKE_CERT_AWS_EXIT ?? "0"}" != "0" ]; then echo "simulated AWS failure" >&2; exit "${environment.FAKE_CERT_AWS_EXIT ?? "0"}"; fi
    printf '%s\\n' "${environment.FAKE_CERTIFICATE_ARN ?? LIVE_CERTIFICATE_ARN}"
    ;;
  *WebAclArn*)
    if [ "${environment.FAKE_CERT_AWS_EXIT ?? "0"}" != "0" ]; then echo "simulated AWS failure" >&2; exit "${environment.FAKE_CERT_AWS_EXIT ?? "0"}"; fi
    printf '%s\\n' "${environment.FAKE_WEB_ACL_ARN ?? LIVE_WEB_ACL_ARN}"
    ;;
  *) exit 2 ;;
esac
`,
  );
  makeExecutable(
    directory,
    "git",
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  fetch) exit 0 ;;
  rev-parse)
    # --verify <ref>^{commit} resolves --ref; a bare rev-parse is origin/main.
    case "$*" in
      *--verify*)
        if [ "${environment.FAKE_REF_UNKNOWN ?? "0"}" != "0" ]; then exit 128; fi
        printf '%s\\n' "${environment.FAKE_REF_SHA ?? TEST_SHA}"
        ;;
      *) printf '%s\\n' "${TEST_SHA}" ;;
    esac
    ;;
  merge-base) exit "${environment.FAKE_REF_NOT_ANCESTOR ?? "0"}" ;;
  rev-list) printf '%s\\n' "3" ;;
  log) printf '%s\\n' "test commit" ;;
  diff)
    # Honour the pathspecs faithfully. Tracked and manual migrations have
    # different policies, and a caller may ask about BOTH in one invocation —
    # so emit the union of whichever pathspecs were actually requested rather
    # than first-match-wins, which would let a buggy caller look clean.
    out=""
    case "$*" in *"prisma/migrations/**"*) out="\${out}${environment.FAKE_GIT_DIFF ?? ""}" ;; esac
    case "$*" in *"prisma/manual-migrations/**"*) out="\${out}${environment.FAKE_GIT_DIFF_MANUAL ?? ""}" ;; esac
    printf '%s' "$out"
    ;;
  cat-file) exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  makeExecutable(
    directory,
    "gh",
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s ' "$@" >> "$GH_TRACE"
printf '\\n' >> "$GH_TRACE"
if [ "$1" = auth ]; then exit 0; fi
if [ "$1" = run ] && [ "$2" = list ]; then
  case " $* " in
    # The staged-promotion lookup counts green runs for the target commit.
    *" --limit 100 "*) printf '%s\\n' "${environment.FAKE_TARGET_CI_COUNT ?? "1"}" ;;
    *" --workflow CI "*) printf '${environment.FAKE_MAIN_CI ?? "completed/success"} ${TEST_SHA}\\n' ;;
    *" --json headSha,conclusion "*) printf '%s\\n' "${environment.FAKE_LAST_PROD_SHA ?? ""}" ;;
    *) printf 'recent runs\\n' ;;
  esac
fi
`,
  );
  makeExecutable(directory, "sleep", "#!/usr/bin/env bash\nexit 0\n");
  // The migration precondition asks PROD what it has applied (ADR-032). Stub
  // curl so the suite stays hermetic — a real network call here would make the
  // tests depend on live prod state.
  makeExecutable(
    directory,
    "curl",
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' '${environment.FAKE_MIGRATION_BODY ?? NO_DRIFT_BODY}'
printf '\\n%s' "${environment.FAKE_MIGRATION_HTTP ?? "200"}"
`,
  );
  const workingDirectory = setup?.(directory) ?? resolve();

  const result = spawnSync("/bin/bash", [PROMOTE_PROD_SCRIPT, ...arguments_], {
    cwd: workingDirectory,
    encoding: "utf8",
    env: {
      ...environment,
      GH_TRACE: trace,
      NODE_ENV: "test",
      PATH: `${directory}:/usr/bin:/bin`,
    },
  });

  return {
    result,
    trace: existsSync(trace) ? readFileSync(trace, "utf8") : "",
    directory,
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("staged promotion (--ref)", () => {
  const OTHER_SHA = "2222222222222222222222222222222222222222";

  it("ships the staged commit and says so, instead of main HEAD", () => {
    const { result, trace } = runPromotion({ FAKE_REF_SHA: OTHER_SHA }, ["--ref", OTHER_SHA, "--yes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STAGED promotion: shipping 2222222");
    expect(result.stdout).toContain("main is NOT being shipped");
    expect(result.stdout).toContain(`ref                 = ${OTHER_SHA}`);
    expect(trace).toContain(`-f ref=${OTHER_SHA}`);
  });

  it("does not consult main's CI state, which describes commits it is not shipping", () => {
    // Regression: gating a staged promotion on main's CI blocked it whenever
    // main was red or still building — exactly when staging is needed most.
    const { result } = runPromotion(
      { FAKE_REF_SHA: OTHER_SHA, FAKE_MAIN_CI: "in_progress/" },
      ["--ref", OTHER_SHA, "--dry-run"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CI: green on target 2222222");
    expect(result.stdout).not.toContain("not success. Aborting");
  });

  it("refuses a commit that is not an ancestor of main, so only reviewed code ships", () => {
    const { result, trace } = runPromotion(
      { FAKE_REF_SHA: OTHER_SHA, FAKE_REF_NOT_ANCESTOR: "1" },
      ["--ref", OTHER_SHA, "--yes"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not an ancestor of origin/main");
    expect(trace).not.toContain("workflow run");
  });

  it("refuses a staged commit that has no green CI run of its own", () => {
    const { result, trace } = runPromotion(
      { FAKE_REF_SHA: OTHER_SHA, FAKE_TARGET_CI_COUNT: "0" },
      ["--ref", OTHER_SHA, "--yes"],
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no successful CI run found for --ref");
    expect(trace).not.toContain("workflow run");
  });

  it("refuses a ref the checkout cannot resolve", () => {
    const { result, trace } = runPromotion({ FAKE_REF_UNKNOWN: "1" }, ["--ref", "nope", "--yes"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not a commit this checkout knows");
    expect(trace).not.toContain("workflow run");
  });

  it("requires an argument", () => {
    const { result } = runPromotion({}, ["--ref"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--ref needs a commit");
  });

  it("still dispatches main HEAD when --ref is omitted", () => {
    const { result, trace } = runPromotion({}, ["--yes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("STAGED promotion");
    expect(trace).toContain(`-f ref=${"1111111111111111111111111111111111111111"}`);
  });
});

describe("prod promotion dry run", () => {
  // The whole point of --dry-run is that a green rehearsal proves the real
  // run's preconditions. So these assert both halves: every check ran, and
  // nothing was dispatched.
  it("runs every precondition and prints the real dispatch inputs without dispatching", () => {
    const { result, trace } = runPromotion({}, ["--dry-run"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("CI: green");
    expect(result.stdout).toContain(
      "Migrations: prod schema current with this build",
    );
    expect(result.stdout).toContain("Cite enrollment secrets:");
    // Identical plan to a real promotion — same code path produces it.
    expect(result.stdout).toContain(`certificate_arn     = ${LIVE_CERTIFICATE_ARN}`);
    expect(result.stdout).toContain(`web_acl_arn         = ${LIVE_WEB_ACL_ARN}`);
    expect(result.stdout).toContain("DRY RUN");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("fails the rehearsal on the same conditions that fail the real run", () => {
    const { result, trace } = runPromotion(
      { FAKE_RUNTIME_SECRET_JSON: '{"ENGRAM_INTERNAL_API_KEY":"other"}' },
      ["--dry-run"],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENGRAM_AXON_ENROLLMENT_API_KEY");
    expect(result.stdout).not.toContain("DRY RUN");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("refuses a signing secret that does not satisfy the five-field contract", () => {
    // prod no longer injects these fields as {{resolve:...}} env vars, so
    // CloudFormation no longer fails the stack update on a malformed secret.
    // This gate replaces that deploy-time check — and is stricter, because
    // CloudFormation only proved each JSON key resolved, never that the
    // values formed a usable key.
    const { result, trace } = runPromotion({
      FAKE_ENROLLMENT_SECRET_JSON: JSON.stringify({
        kid: "cite-enrollment-test",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----",
        not_before: "2020-01-01T00:00:00Z",
        not_after: "2099-01-01T00:00:00Z",
      }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("five-field contract");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("refuses a signing key that is outside its validity window", () => {
    // Promoting an expired key succeeds at the stack level and then answers
    // 503 on every enrollment request — a green deploy that denies users.
    const { result, trace } = runPromotion({
      FAKE_ENROLLMENT_SECRET_JSON: JSON.stringify({
        kid: "cite-enrollment-expired",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----x-----END PUBLIC KEY-----",
        not_before: "2020-01-01T00:00:00Z",
        not_after: "2021-01-01T00:00:00Z",
      }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside its validity window");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("refuses to combine --dry-run with the dispatch-intent flags", () => {
    for (const flag of ["--yes", "--watch"]) {
      const { result, trace } = runPromotion({}, ["--dry-run", flag]);

      expect(result.status, `${flag} should be rejected`).toBe(2);
      expect(result.stderr).toContain("--dry-run cannot be combined");
      expect(trace).not.toContain("workflow run deploy-prod.yml");
    }
  });
});

describe("prod promotion certificate inputs", () => {
  it("dispatches the current live cert-stack outputs instead of a baked-in ARN", () => {
    const { result, trace } = runPromotion();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "input source        = live engram-prod-cert CloudFormation outputs",
    );
    expect(trace).toContain(`certificate_arn=${LIVE_CERTIFICATE_ARN}`);
    expect(trace).toContain(`web_acl_arn=${LIVE_WEB_ACL_ARN}`);
    expect(trace).toContain("workflow run deploy-prod.yml");
  });

  it("fails closed before dispatch when the dedicated enrollment signing secret is unavailable", () => {
    const { result, trace } = runPromotion({
      FAKE_ENROLLMENT_SIGNING_SECRET_EXIT: "9",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cortex/prod/engram/enrollment-signing");
    expect(result.stderr).toContain(
      "enrollment-signing-secret-provisioning.md",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("fails closed before dispatch when the runtime secret lacks the Cite consumer credential", () => {
    const { result, trace } = runPromotion({
      FAKE_RUNTIME_SECRET_JSON: '{"ENGRAM_INTERNAL_API_KEY":"other"}',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENGRAM_AXON_ENROLLMENT_API_KEY");
    expect(result.stderr).toContain(
      "enrollment-signing-secret-provisioning.md",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("fails closed before dispatch when the runtime secret has an empty Cite consumer credential", () => {
    const { result, trace } = runPromotion({
      FAKE_RUNTIME_SECRET_JSON: '{"ENGRAM_AXON_ENROLLMENT_API_KEY":"   "}',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("non-empty ENGRAM_AXON_ENROLLMENT_API_KEY");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("allows a local AWS profile override without changing live-output provenance", () => {
    const { result, trace } = runPromotion({
      ENGRAM_AWS_PROFILE: "human-prod",
      EXPECTED_AWS_PROFILE: "human-prod",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "input source        = live engram-prod-cert CloudFormation outputs",
    );
    expect(trace).toContain(`certificate_arn=${LIVE_CERTIFICATE_ARN}`);
    expect(trace).toContain(`web_acl_arn=${LIVE_WEB_ACL_ARN}`);
  });

  it("fails locally when HOSTED_ZONE_ID differs from the runner-pinned prod zone", () => {
    const { result, trace } = runPromotion({
      HOSTED_ZONE_ID: "Z0000000000000000000",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "HOSTED_ZONE_ID must be the prod ctxhost.com zone Z099959326CYRBW3F5PTA",
    );
    expect(trace).not.toContain("auth status");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("fails closed when the authoritative stack lacks either required output", () => {
    const { result, trace } = runPromotion({ FAKE_CERTIFICATE_ARN: "None" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no CertificateArn output");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("fails closed when reading a live stack output fails", () => {
    const { result, trace } = runPromotion({ FAKE_AWS_EXIT: "9" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "could not read CertificateArn from live stack engram-prod-cert",
    );
    expect(result.stderr).toContain("simulated AWS failure");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("rejects a live output outside the fixed prod account", () => {
    const { result, trace } = runPromotion({
      FAKE_CERTIFICATE_ARN:
        "arn:aws:acm:us-east-1:000000000000:certificate/b9c3639d-df1f-41ed-b5fe-2dcc37289198",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "certificate ARN is not an us-east-1 ACM certificate in prod account",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("rejects an unpaired certificate override before dispatch", () => {
    const { result, trace } = runPromotion({
      CERTIFICATE_ARN: LIVE_CERTIFICATE_ARN,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be supplied together");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("does not let an inherited acknowledgement environment variable enable override pairs", () => {
    const { result, trace } = runPromotion({
      CERTIFICATE_ARN: LIVE_CERTIFICATE_ARN,
      WEB_ACL_ARN: LIVE_WEB_ACL_ARN,
      ENGRAM_PROMOTION_OVERRIDES_REVIEWED: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--reviewed-cert-override");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("permits a reviewed pair only with the command-line acknowledgement and shows live diffs", () => {
    const certificate =
      "arn:aws:acm:us-east-1:782369544445:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const webAcl =
      "arn:aws:wafv2:us-east-1:782369544445:global/webacl/ReviewedWebAcl/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const { result, trace } = runPromotion(
      {
        CERTIFICATE_ARN: certificate,
        WEB_ACL_ARN: webAcl,
      },
      ["--reviewed-cert-override", "--yes"],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "input source        = reviewed explicit overrides",
    );
    expect(result.stderr).toContain(
      `overriding live certificate_arn '${LIVE_CERTIFICATE_ARN}' with '${certificate}'`,
    );
    expect(result.stderr).toContain(
      `overriding live web_acl_arn '${LIVE_WEB_ACL_ARN}' with '${webAcl}'`,
    );
    expect(trace).toContain(`certificate_arn=${certificate}`);
    expect(trace).toContain(`web_acl_arn=${webAcl}`);
  });

  it("warns but permits a reviewed pair when live comparison cannot be resolved", () => {
    const { result, trace } = runPromotion(
      {
        CERTIFICATE_ARN: LIVE_CERTIFICATE_ARN,
        WEB_ACL_ARN: LIVE_WEB_ACL_ARN,
        FAKE_CERT_AWS_EXIT: "9",
      },
      ["--reviewed-cert-override", "--yes"],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "could not resolve live cert-stack outputs for comparison",
    );
    expect(result.stderr).toContain("simulated AWS failure");
    expect(trace).toContain("workflow run deploy-prod.yml");
  });

  it("validates reviewed explicit overrides before dispatch", () => {
    const { result, trace } = runPromotion(
      {
        CERTIFICATE_ARN: LIVE_CERTIFICATE_ARN,
        WEB_ACL_ARN:
          "arn:aws:wafv2:us-east-1:782369544445:regional/webacl/ReviewedWebAcl/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      },
      ["--reviewed-cert-override", "--yes"],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "WebACL ARN is not a global us-east-1 WAFv2 WebACL",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("rejects a WebACL name containing characters outside the safe name segment", () => {
    const { result, trace } = runPromotion(
      {
        CERTIFICATE_ARN: LIVE_CERTIFICATE_ARN,
        WEB_ACL_ARN:
          "arn:aws:wafv2:us-east-1:782369544445:global/webacl/Reviewed WebAcl/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      },
      ["--reviewed-cert-override", "--yes"],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "WebACL ARN is not a global us-east-1 WAFv2 WebACL",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("makes --full deploy all non-cert stacks with fresh live inputs", () => {
    const { result, trace } = runPromotion({}, ["--full", "--yes"]);

    expect(result.status, result.stderr).toBe(0);
    expect(trace).toContain(
      "stack=engram-prod-data engram-prod-web engram-prod-ops",
    );
    expect(trace).toContain(`certificate_arn=${LIVE_CERTIFICATE_ARN}`);
    expect(trace).toContain("workflow run deploy-prod.yml");
  });

  it("refuses the workflow default stack set even with reviewed explicit overrides", () => {
    const { result, trace } = runPromotion(
      {
        STACK:
          "engram-prod-cert engram-prod-data engram-prod-web engram-prod-ops",
        CERTIFICATE_ARN: LIVE_CERTIFICATE_ARN,
        WEB_ACL_ARN: LIVE_WEB_ACL_ARN,
      },
      ["--reviewed-cert-override", "--yes"],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "includes engram-prod-cert and other stacks",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("refuses tab-separated cert and web stacks even with reviewed explicit overrides", () => {
    const { result, trace } = runPromotion(
      {
        STACK: "engram-prod-cert\tengram-prod-web",
        CERTIFICATE_ARN: LIVE_CERTIFICATE_ARN,
        WEB_ACL_ARN: LIVE_WEB_ACL_ARN,
      },
      ["--reviewed-cert-override", "--yes"],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "includes engram-prod-cert and other stacks",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("permits a reviewed cert-only dispatch", () => {
    const { result, trace } = runPromotion(
      {
        STACK: "engram-prod-cert",
        CERTIFICATE_ARN: LIVE_CERTIFICATE_ARN,
        WEB_ACL_ARN: LIVE_WEB_ACL_ARN,
      },
      ["--reviewed-cert-override", "--yes"],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(trace).toContain("stack=engram-prod-cert");
    expect(trace).toContain("workflow run deploy-prod.yml");
  });

  it("dispatches a bootstrap cert deployment alone with deliberately blank inputs", () => {
    const { result, trace } = runPromotion({ STACK: "engram-prod-web" }, [
      "--bootstrap-cert",
      "--yes",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("bootstrap cert-stack dispatch");
    expect(trace).toContain("stack=engram-prod-cert");
    expect(trace).toContain("certificate_arn=");
    expect(trace).toContain("web_acl_arn=");
    expect(trace).toContain("workflow run deploy-prod.yml");
  });

  it("refuses certificate overrides in bootstrap mode", () => {
    const { result, trace } = runPromotion(
      { CERTIFICATE_ARN: LIVE_CERTIFICATE_ARN, WEB_ACL_ARN: LIVE_WEB_ACL_ARN },
      ["--bootstrap-cert", "--yes"],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--bootstrap-cert requires blank certificate/WebACL inputs",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("applies the cert-stack safeguard to a custom STACK value too", () => {
    const { result } = runPromotion({
      STACK: "engram-prod-cert engram-prod-web",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "includes engram-prod-cert and other stacks",
    );
  });

  it.each([
    ["tab", "engram-prod-cert\tengram-prod-web"],
    ["newline", "engram-prod-cert\nengram-prod-web"],
  ])(
    "applies the cert-stack safeguard to %s-separated stack values",
    (_separator, stack) => {
      const { result, trace } = runPromotion({ STACK: stack });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "includes engram-prod-cert and other stacks",
      );
      expect(trace).not.toContain("workflow run deploy-prod.yml");
    },
  );

  it("rejects a wildcard stack instead of validating expanded filenames and dispatching the raw pattern", () => {
    const { result, trace } = runPromotion(
      { STACK: "engram-prod-*" },
      ["--yes"],
      (directory) => {
        writeFileSync(join(directory, "engram-prod-data"), "");
        writeFileSync(join(directory, "engram-prod-web"), "");
        return directory;
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown stack 'engram-prod-*'");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("rejects comma-separated stack values instead of passing them through to CDK", () => {
    const { result, trace } = runPromotion({
      STACK: "engram-prod-cert,engram-prod-web",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "unknown stack 'engram-prod-cert,engram-prod-web'",
    );
    expect(result.stderr).not.toContain("requested stack set includes");
    expect(trace).not.toContain("auth status");
  });

  it.each(["engram-prod-cert-foo", "myengram-prod-cert"])(
    "rejects unknown stack %s without a false cert-stack match",
    (stack) => {
      const { result, trace } = runPromotion({ STACK: stack });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`unknown stack '${stack}'`);
      expect(result.stderr).not.toContain("requested stack set includes");
      expect(trace).not.toContain("auth status");
    },
  );
});

describe("prod promotion migration precondition (ADR-032 live check)", () => {
  it("promotes when prod has already applied the checkout's migrations", () => {
    // The 2026-07-31 deadlock: the old check diffed prisma/migrations/** against
    // the last successful prod deploy, so an APPLIED migration's files stayed in
    // the diff forever and blocked every later promotion — and since it blocked
    // the deploy, the last-deploy SHA could never advance to clear it.
    const { result, trace } = runPromotion();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Migrations: prod schema current with this build",
    );
    expect(result.stderr).not.toContain("pending Prisma migration in the diff");
    expect(trace).toContain("workflow run deploy-prod.yml");
  });

  it("promotes an APPLIED migration that is still in the git diff (the 2026-07-31 deadlock)", () => {
    // Exact reproduction: a previous prod deploy exists, prisma/migrations/**
    // files appear in the diff since it, and prod HAS applied them. The old
    // diff-based check aborted here permanently — it could never clear, because
    // clearing it required a successful deploy it was itself blocking.
    const { result, trace } = runPromotion({
      FAKE_LAST_PROD_SHA: "9893c4a19893c4a19893c4a19893c4a19893c4a1",
      FAKE_GIT_DIFF:
        "prisma/migrations/0026_register_fieldops_native_client/migration.sql\n",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("pending Prisma migration in the diff");
    expect(trace).toContain("workflow run deploy-prod.yml");
  });

  it("still blocks an untracked manual migration, which prod cannot vouch for", () => {
    const { result, trace } = runPromotion({
      FAKE_LAST_PROD_SHA: "9893c4a19893c4a19893c4a19893c4a19893c4a1",
      FAKE_GIT_DIFF_MANUAL: "prisma/manual-migrations/0099_backfill.sql\n",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("manual migration in the diff");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("refuses to promote when prod is missing a migration this build carries", () => {
    const { result, trace } = runPromotion({
      FAKE_MIGRATION_BODY: JSON.stringify({ applied: ["0001_init"] }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "migrations NOT applied to prod",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("fails closed when the prod migration endpoint 5xxs", () => {
    const { result, trace } = runPromotion({
      FAKE_MIGRATION_HTTP: "503",
      FAKE_MIGRATION_BODY: "upstream error",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "cannot confirm prod schema currency",
    );
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });

  it("fails closed on HTTP 200 with no valid applied array", () => {
    const { result, trace } = runPromotion({
      FAKE_MIGRATION_BODY: JSON.stringify({ status: "ok" }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("no valid `applied` array");
    expect(trace).not.toContain("workflow run deploy-prod.yml");
  });
});
