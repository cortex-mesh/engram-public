import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function commandForStep(workflow: string, stepName: string): string {
  const match = workflow.match(new RegExp(`- name: ${stepName}\\n[\\s\\S]*?\\n        run: ([^\\n]+)`));
  if (!match) throw new Error(`missing ${stepName} command`);
  return match[1];
}

describe("prod deployment workflow", () => {
  it("defaults to the routine web promotion and invokes the runner-side isolation gate before CDK", () => {
    const workflow = readFileSync(resolve(".github/workflows/deploy-prod.yml"), "utf8");

    expect(workflow).toContain('default: "engram-prod-web"');
    expect(workflow).toContain("certificate_arn:\n        description: \"us-east-1 ACM certificate ARN after engram-prod-cert deploy\"\n        required: false");
    expect(workflow).toContain("web_acl_arn:\n        description: \"us-east-1 CloudFront WebACL ARN after engram-prod-cert deploy\"\n        required: false");
    expect(workflow).toContain("STACK_SET: ${{ inputs.stack }}");
    expect(workflow).toContain("CERTIFICATE_ARN: ${{ inputs.certificate_arn }}");
    expect(workflow).toContain("WEB_ACL_ARN: ${{ inputs.web_acl_arn }}");
    expect(workflow).toContain("HOSTED_ZONE_ID: ${{ inputs.hosted_zone_id }}");
    expect(workflow).toContain("BUDGET_ALERT_EMAIL: ${{ inputs.budget_alert_email }}");
    expect(workflow).toContain('run: bash scripts/check-prod-stack-set.sh "$STACK_SET" "$CERTIFICATE_ARN" "$WEB_ACL_ARN" "$HOSTED_ZONE_ID" "$BUDGET_ALERT_EMAIL"');
    expect(workflow.indexOf("- name: Enforce cert-stack isolation")).toBeLessThan(workflow.indexOf("- name: Migration drift gate"));
    expect(workflow.indexOf("- name: Enforce cert-stack isolation")).toBeLessThan(workflow.indexOf("- name: CDK diff"));
    expect(workflow.indexOf("- name: Enforce cert-stack isolation")).toBeLessThan(workflow.indexOf("- name: CDK deploy"));

    const diffCommand = commandForStep(workflow, "CDK diff");
    const deployCommand = commandForStep(workflow, "CDK deploy");

    // Assert the full commands, not merely flag presence: changing diff to
    // --exclusively would hide a web-to-data dependency change from review.
    expect(diffCommand).toBe("npx cdk diff $STACK_SET");
    expect(diffCommand).not.toContain("--exclusively");
    expect(deployCommand).toBe("npx cdk deploy --exclusively --require-approval never $STACK_SET");
    expect(deployCommand).toContain("--exclusively");
    expect(deployCommand).toContain("--require-approval never");
  });

  it("checks out the requested ref and defaults it to main", () => {
    const workflow = readFileSync(resolve(".github/workflows/deploy-prod.yml"), "utf8");

    expect(workflow).toContain("ref: ${{ inputs.ref }}");
    expect(workflow).toContain('default: "main"');
    // Ancestry cannot be proven from the default shallow clone.
    expect(workflow).toContain("fetch-depth: 0");
  });

  it("refuses a ref that is not reachable from main, before anything is built or deployed", () => {
    const workflow = readFileSync(resolve(".github/workflows/deploy-prod.yml"), "utf8");

    // The Actions UI can dispatch directly, bypassing scripts/promote-prod.sh,
    // so the runner must enforce this itself rather than trusting the script.
    expect(workflow).toContain("- name: Enforce ref is reachable from main");
    expect(workflow).toContain('git merge-base --is-ancestor "$resolved" origin/main');

    const gate = workflow.indexOf("- name: Enforce ref is reachable from main");
    expect(gate).toBeGreaterThan(-1);
    for (const later of ["- name: Migration drift gate", "- name: CDK diff", "- name: CDK deploy", "- name: Build OpenNext artifact"]) {
      expect(gate).toBeLessThan(workflow.indexOf(later));
    }
  });

  it("normalizes the stack input before skipping the migration drift gate for the isolated cert bootstrap only", () => {
    const workflow = readFileSync(resolve(".github/workflows/deploy-prod.yml"), "utf8");

    expect(workflow).toContain("- name: Migration drift gate\n        env:\n          STACK_SET: ${{ inputs.stack }}");
    expect(workflow).toContain('normalized_stack_set="$(printf \'%s\' "$STACK_SET" | xargs)"');
    expect(workflow).toContain('if [ "$normalized_stack_set" = "engram-prod-cert" ]; then');
  });
});
