import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stopDevServer } from "./auth-layout-server-lifecycle.mjs";

const outputDir = join(tmpdir(), "auth-layout-playwright", new Date().toISOString().replace(/[:.]/g, "-"));
const providedBaseUrl = process.env.AUTH_LAYOUT_BASE_URL;
const baseUrl = providedBaseUrl || "http://localhost:3104";
const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 568, height: 320 },
  { width: 600, height: 800 },
  { width: 667, height: 375 },
  { width: 768, height: 1024 },
  { width: 780, height: 360 },
  { width: 1440, height: 900 },
];
const routes = [
  { name: "cite-login", path: "/login?client_id=axon-web", wordmark: ".mesh-auth-shell__citethemove-wordmark" },
  { name: "cite-register", path: "/register?client_id=axon-web", wordmark: ".mesh-auth-shell__citethemove-wordmark" },
  { name: "tradepost-login", path: "/login?client_id=tradepost-web", wordmark: ".mesh-auth-shell__tradepost-wordmark" },
];
const subpixelTolerance = 1;

async function isServerReady() {
  try {
    return (await fetch(`${baseUrl}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function waitForServer(server) {
  let onError;
  let onClose;
  const startupFailure = new Promise((_, reject) => {
    onError = (error) => reject(new Error(`auth layout server failed to start: ${error.message}`));
    onClose = (code, signal) => reject(new Error(`auth layout server exited before ready (${signal || `code ${code}`})`));
    server.once("error", onError);
    server.once("close", onClose);
  });

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await Promise.race([isServerReady(), startupFailure])) return;
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 1_000)), startupFailure]);
    }
    throw new Error(`auth layout server did not become ready at ${baseUrl}`);
  } finally {
    server.off("error", onError);
    server.off("close", onClose);
  }
}

let devServer;
let browser;
const results = [];
let cleanupPromise;

function cleanup() {
  cleanupPromise ??= (async () => {
    await browser?.close();
    await stopDevServer(devServer);
  })();
  return cleanupPromise;
}

for (const [signal, exitCode] of Object.entries({ SIGINT: 130, SIGTERM: 143 })) {
  process.once(signal, () => {
    void cleanup()
      .catch((error) => {
        console.error(`auth layout cleanup failed: ${error.message}`);
        process.exitCode = 1;
      })
      .finally(() => process.exit(process.exitCode ?? exitCode));
  });
}

try {
  if (providedBaseUrl) {
    if (!await isServerReady()) throw new Error(`AUTH_LAYOUT_BASE_URL is unavailable: ${baseUrl}`);
  } else {
    if (await isServerReady()) {
      throw new Error("localhost:3104 is already in use; set AUTH_LAYOUT_BASE_URL only for a server from this checkout");
    }
    devServer = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
      stdio: "inherit",
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
    });
    await waitForServer(devServer);
  }
  browser = await chromium.launch({ headless: true });
  await mkdir(outputDir, { recursive: true });
  for (const viewport of viewports) {
    for (const route of routes) {
      const errors = [];
      const consoleErrors = [];
      const context = await browser.newContext({ viewport });
      await context.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          errors.push(`HTTP ${response.status()}: ${response.url()}`);
        }
      });
      page.on("requestfailed", (request) => errors.push(`request failed: ${request.url()} (${request.failure()?.errorText || "unknown"})`));

      const response = await page.goto(`${baseUrl}${route.path}`, { waitUntil: "networkidle" });
      if (!response?.ok()) throw new Error(`${route.name} ${viewport.width}x${viewport.height}: HTTP ${response?.status()}`);
      await page.locator(".mesh-appearance-toggle").waitFor();
      await page.locator(route.wordmark).waitFor();

      const layout = await page.evaluate(({ wordmark }) => {
        const rect = (selector) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`missing ${selector}`);
          const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
          return { left, right, top, bottom, width, height };
        };
        const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const toggle = rect(".mesh-appearance-toggle");
        const mark = rect(wordmark);
        const horizontalOverflow = document.documentElement.scrollWidth > window.innerWidth;
        const controls = Array.from(document.querySelectorAll("a, button, input, select, textarea"))
          .filter((element) => !element.disabled && element.getClientRects().length > 0)
          .map((element) => {
            const box = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              label: element.getAttribute("aria-label") || element.textContent?.trim() || element.getAttribute("name") || "unnamed",
              left: box.left,
              right: box.right,
              width: box.width,
              height: box.height,
            };
          });
        return { toggle, mark, overlap: overlap(toggle, mark), horizontalOverflow, controls };
      }, { wordmark: route.wordmark });

      if (layout.overlap) throw new Error(`${route.name} ${viewport.width}x${viewport.height}: wordmark overlaps appearance control`);
      if (layout.horizontalOverflow) throw new Error(`${route.name} ${viewport.width}x${viewport.height}: horizontal overflow`);
      for (const control of layout.controls) {
        if (control.width <= 0 || control.height <= 0 || control.left < 0 || control.right > viewport.width) {
          throw new Error(`${route.name} ${viewport.width}x${viewport.height}: offscreen or clipped control ${control.tag} ${control.label}`);
        }
      }

      const controls = page.locator("a, button, input, select, textarea");
      for (let index = 0; index < await controls.count(); index += 1) {
        const control = controls.nth(index);
        if (!await control.isVisible() || await control.isDisabled()) continue;
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        if (
          !box ||
          box.x < -subpixelTolerance ||
          box.x + box.width > viewport.width + subpixelTolerance ||
          box.y < -subpixelTolerance ||
          box.y + box.height > viewport.height + subpixelTolerance
        ) {
          throw new Error(
            `${route.name} ${viewport.width}x${viewport.height}: interactive control cannot be brought onscreen ` +
              `${await control.evaluate((element) => element.tagName)} ${await control.getAttribute("aria-label") || await control.textContent() || await control.getAttribute("name") || "unnamed"} ` +
              `${JSON.stringify(box)}`,
          );
        }
      }

      await page.locator('button[aria-label="Use light appearance"]').click();
      if (await page.locator('button[aria-label="Use light appearance"]').getAttribute("aria-pressed") !== "true") {
        throw new Error(`${route.name} ${viewport.width}x${viewport.height}: appearance control did not remain interactive`);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      const screenshot = join(outputDir, `${route.name}-${viewport.width}x${viewport.height}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      if (errors.length || consoleErrors.length) {
        throw new Error(`${route.name} ${viewport.width}x${viewport.height}: ${[...errors, ...consoleErrors].join(" | ")}`);
      }
      results.push({ route: route.name, viewport, screenshot, ...layout });
      await context.close();
    }
  }
  await writeFile(join(outputDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify({ outputDir, verified: results.length }, null, 2));
} finally {
  await cleanup();
}
