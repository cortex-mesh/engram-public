import contract from "../../docs/contracts/cite-enrollment/v1.openapi.json";
import { describe, expect, it } from "vitest";

describe("Cite the Move enrollment contract", () => {
  it("freezes the Axon-scoped, fail-closed v1 surface", () => {
    expect(contract.openapi).toBe("3.1.0");
    expect(contract.info.version).toBe("1.0.0");
    expect(contract.info["x-contract-version"]).toBe("1.0.0");
    expect(contract.paths).toHaveProperty("/api/internal/enrollment/v1/keys");
    expect(contract.paths).toHaveProperty("/api/internal/enrollment/v1/snapshot");
    expect(contract.paths).toHaveProperty("/api/internal/enrollment/v1/events");
    expect(contract.paths).toHaveProperty("/api/internal/enrollment/v1/acknowledgements");
    expect(contract.info["x-invariants"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("axon-web"),
        expect.stringContaining("fail closed"),
        expect.stringContaining("acknowledgement"),
      ]),
    );
  });
});
