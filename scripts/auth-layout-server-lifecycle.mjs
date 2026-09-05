import { spawn } from "node:child_process";

export async function stopDevServer(devServer) {
  if (!devServer?.pid || devServer.exitCode !== null || devServer.signalCode !== null) return;

  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", ["/pid", String(devServer.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: true,
    });
    await new Promise((resolve) => taskkill.once("close", resolve));
    return;
  }

  const exited = new Promise((resolve) => devServer.once("close", resolve));
  try {
    process.kill(-devServer.pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  await exited;
}
