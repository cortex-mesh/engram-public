import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const entrypoint = join(root, "docker-entrypoint.sh");
let serverDirectory = "";
let overrideScript = "";

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  server.close();
  await once(server, "close");
  return port;
}

function emptyEnrollmentEnvironment(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return Object.assign({}, process.env, overrides, {
    NODE_ENV: "production",
    ENGRAM_AXON_ENROLLMENT_API_KEY: "",
    ENGRAM_ENROLLMENT_SIGNING_KEY_ID: "",
    ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY: "",
    ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY: "",
    ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: "",
    ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "",
    ENGRAM_SERVER_SCRIPT: overrideScript,
  }) as NodeJS.ProcessEnv;
}

describe("Docker production entrypoint", () => {
  beforeAll(() => {
    serverDirectory = mkdtempSync(join(tmpdir(), "engram-entrypoint-"));
    writeFileSync(join(serverDirectory, "server.js"), `
      import { createServer } from "node:http";
      const server = createServer((_request, response) => response.end("default"));
      server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("default"));
    `);
    overrideScript = join(serverDirectory, "override.mjs");
    writeFileSync(overrideScript, `
      import { createServer } from "node:http";
      const server = createServer((_request, response) => response.end("override"));
      server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("override"));
    `);
  });

  it("is wired into the Docker image and starts production with every enrollment variable explicitly empty", async () => {
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain('ENTRYPOINT ["./docker-entrypoint.sh"]');
    const port = await unusedPort();
    const child = spawn("sh", [entrypoint], {
      cwd: serverDirectory,
      env: { ...emptyEnrollmentEnvironment(), PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("entrypoint did not start server")), 5000);
      child.once("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("default")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => reject(new Error(chunk.toString())));
    });
    await expect(fetch(`http://127.0.0.1:${port}`)).resolves.toMatchObject({ status: 200 });
    child.kill("SIGTERM");
    await once(child, "exit");
  });

  it("ignores an environment-selected server script in production", async () => {
    const port = await unusedPort();
    const child = spawn("sh", [entrypoint], {
      cwd: serverDirectory,
      env: { ...emptyEnrollmentEnvironment(), PORT: String(port), ENGRAM_SERVER_SCRIPT: overrideScript },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("entrypoint did not start default server")), 5000);
      child.once("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("default")) {
          clearTimeout(timeout);
          resolve();
        }
        if (chunk.toString().includes("override")) reject(new Error("production honored ENGRAM_SERVER_SCRIPT"));
      });
      child.stderr.on("data", (chunk: Buffer) => reject(new Error(chunk.toString())));
    });
    child.kill("SIGTERM");
    await once(child, "exit");
  });
});
