import { spawn } from "node:child_process";
import { once } from "node:events";

import { stopDevServer } from "./auth-layout-server-lifecycle.mjs";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { detached: process.platform !== "win32" });
await once(child, "spawn");
child.kill("SIGTERM");
await once(child, "close");

if (child.signalCode !== "SIGTERM") throw new Error(`expected SIGTERM, got ${child.signalCode || child.exitCode}`);
await Promise.race([
  stopDevServer(child),
  new Promise((_, reject) => setTimeout(() => reject(new Error("already-signaled child cleanup timed out")), 1_000)),
]);
console.log("already-signaled child cleanup verified");
