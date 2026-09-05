import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = "scripts/provision-enrollment-signing-secret.sh";

describe("enrollment signing secret provisioning", () => {
  it("is dry-run by default and names a dedicated production secret", () => {
    const result = spawnSync("bash", [script, "--environment", "aws-prod"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.stdout).toContain("cortex/prod/engram/enrollment-signing");
    expect(result.stdout).not.toContain("PRIVATE KEY");
  });

  it("validates a supplied interval during the dry run, not only under --apply", () => {
    const result = spawnSync(
      "bash",
      [
        script,
        "--environment",
        "aws-prod",
        "--not-before",
        "2027-01-01T00:00:00Z",
        "--not-after",
        "2026-01-01T00:00:00Z",
      ],
      { encoding: "utf8" },
    );
    // Previously this exited 0: the rehearsal could not fail while --apply did.
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--not-after must be after --not-before");
  });

  it("reports create-vs-rotate and generates nothing during a dry run", () => {
    const result = spawnSync(
      "bash",
      [
        script,
        "--environment",
        "aws-prod",
        "--not-before",
        "2026-01-01T00:00:00Z",
        "--not-after",
        "2027-01-01T00:00:00Z",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("is well-formed");
    expect(result.stdout).toMatch(/would (CREATE|ROTATE)/);
    expect(result.stdout).toContain("nothing written");
    expect(result.stdout).not.toContain("PRIVATE KEY");
  });

  it("requires the interval flags together even in a dry run", () => {
    const result = spawnSync(
      "bash",
      [script, "--environment", "aws-prod", "--not-before", "2026-01-01T00:00:00Z"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must be supplied together");
  });

  it("rejects an invalid signing interval before generating key material or calling AWS", () => {
    const result = spawnSync(
      "bash",
      [
        script,
        "--environment",
        "aws-prod",
        "--not-before",
        "2027-01-01T00:00:00Z",
        "--not-after",
        "2026-01-01T00:00:00Z",
        "--apply",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--not-after must be after --not-before");
  });

  it("defines one atomic key-and-window secret contract and documents its controller-only apply path", () => {
    const source = readFileSync(script, "utf8");
    const runbook = readFileSync(
      "docs/runbooks/enrollment-signing-secret-provisioning.md",
      "utf8",
    );
    for (const key of [
      "kid",
      "privateKeyPem",
      "publicKeyPem",
      "not_before",
      "not_after",
    ]) {
      expect(source).toContain(key);
      expect(runbook).toContain(key);
    }
    expect(source).toContain("--apply");
    expect(source).toContain("--confirm-overlap-kid");
    expect(source).toContain("--not-after must be after --not-before");
    expect(runbook).toContain("Never reuse");
    expect(runbook).toContain("--confirm-overlap-kid");
  });
});
