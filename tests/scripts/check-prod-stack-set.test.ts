import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const STACK_SET_GATE = resolve("scripts/check-prod-stack-set.sh");

const CERTIFICATE_ARN = "arn:aws:acm:us-east-1:782369544445:certificate/11111111-1111-1111-1111-111111111111";
const WEB_ACL_ARN = "arn:aws:wafv2:us-east-1:782369544445:global/webacl/engram-prod/11111111-1111-1111-1111-111111111111";
const HOSTED_ZONE_ID = "Z099959326CYRBW3F5PTA";
const BUDGET_ALERT_EMAIL = "ops@example.com";

function checkStackSet(
  stackSet: string,
  certificateArn = CERTIFICATE_ARN,
  webAclArn = WEB_ACL_ARN,
  hostedZoneId = HOSTED_ZONE_ID,
  budgetAlertEmail = BUDGET_ALERT_EMAIL,
) {
  return spawnSync("/bin/bash", [STACK_SET_GATE, stackSet, certificateArn, webAclArn, hostedZoneId, budgetAlertEmail], {
    encoding: "utf8",
  });
}

describe("deploy-prod server-side cert-stack isolation gate", () => {
  it.each(["engram-prod-cert engram-prod-web", "engram-prod-web engram-prod-cert", "engram-prod-cert\tengram-prod-data"]) (
    "rejects a cert stack combined with another stack: %s",
    (stackSet) => {
      const result = checkStackSet(stackSet);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("includes engram-prod-cert and other stacks");
    },
  );

  it.each(["engram-prod-cert", "engram-prod-web", "engram-prod-data engram-prod-web engram-prod-ops"])(
    "permits an isolated or non-cert stack set: %s",
    (stackSet) => {
      const result = checkStackSet(stackSet);

      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    "engram-prod-*",
    "cortex-*",
    "engram-prod-web;id>/tmp/pwned",
    "engram-prod-web\${IFS}engram-prod-data",
  ])("rejects a non-allowlisted stack selector: %s", (stackSet) => {
    const result = checkStackSet(stackSet);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown stack");
  });

  it.each(["engram-prod-cert", "engram-prod-data", "engram-prod-ops", "engram-prod-data engram-prod-ops"])(
    "permits blank inputs for a stack set with no web consumer: %s",
    (stackSet) => {
      const result = checkStackSet(stackSet, "", "");

      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("rejects blank inputs when the stack set includes the web consumer", () => {
    const result = checkStackSet("engram-prod-data engram-prod-web", "", "");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("are required when deploying engram-prod-web");
  });

  it("rejects blank or unpaired inputs for non-cert deployments", () => {
    const blank = checkStackSet("engram-prod-web", "", "");
    const unpaired = checkStackSet("engram-prod-web", CERTIFICATE_ARN, "");

    expect(blank.status).not.toBe(0);
    expect(blank.stderr).toContain("are required when deploying engram-prod-web");
    expect(unpaired.status).not.toBe(0);
    expect(unpaired.stderr).toContain("must be supplied together");
  });

  it.each([
    ["garbage ARNs", "not-an-acm-arn", "not-a-web-acl-arn", "certificate ARN is not an us-east-1 ACM certificate"],
    [
      "a dev-account-shaped WebACL ARN",
      CERTIFICATE_ARN,
      "arn:aws:wafv2:us-east-1:111111111111:global/webacl/engram-dev/11111111-1111-1111-1111-111111111111",
      "WebACL ARN is not a global us-east-1 WAFv2 WebACL",
    ],
  ])("rejects %s", (_description, certificateArn, webAclArn, expectedError) => {
    const result = checkStackSet("engram-prod-web", certificateArn, webAclArn);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  it("rejects a non-prod hosted zone or malformed budget alert email", () => {
    const wrongZone = checkStackSet("engram-prod-web", CERTIFICATE_ARN, WEB_ACL_ARN, "Z0000000000000000000");
    const malformedEmail = checkStackSet("engram-prod-web", CERTIFICATE_ARN, WEB_ACL_ARN, HOSTED_ZONE_ID, "not-an-email");

    expect(wrongZone.status).not.toBe(0);
    expect(wrongZone.stderr).toContain("hosted_zone_id must be the prod ctxhost.com zone");
    expect(malformedEmail.status).not.toBe(0);
    expect(malformedEmail.stderr).toContain("budget_alert_email must be a non-empty email address");
  });
});
