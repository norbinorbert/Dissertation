#!/usr/bin/env node
/**
 * End-to-end smoke test: loads the built extension into a headless Chromium, serves a
 * fixture page from two origins and checks that images, a video poster and shadow-DOM
 * media are blurred, analysed and censored as expected.
 *
 * Prerequisites: `npm run build`, a Chromium build (see resolveBrowserPath), network
 * access on the first run (the cat photo used as a fixture is downloaded from Wikimedia
 * Commons and cached under tests/.artifacts).
 */
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  artifactsDir,
  distDir,
  ensureFixtureImage,
  exists,
  fixtureImage,
  record as baseRecord,
  requireBuild,
  summarize,
} from "../lib/common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const FIRST_RESULT_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 60_000;

const results = [];
const record = (name, ok, detail) => baseRecord(results, name, ok, detail);

function startServer(crossOriginBase) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = (await readFile(path.join(fixturesDir, "index.html"), "utf8")).replace(
          "__CROSS_ORIGIN__",
          crossOriginBase(),
        );
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(html);
      } else if (url.pathname === "/cat.jpg") {
        response.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
        response.end(await readFile(fixtureImage));
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Google Chrome 137+ ignores --load-extension, so a Chromium build is required:
 * either Playwright's (`npx playwright-core install chromium`) or one given via CHROMIUM_PATH
 * (e.g. Chrome for Testing).
 */
async function resolveBrowserPath() {
  const candidates = [process.env.CHROMIUM_PATH, chromium.executablePath()].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(
    "No Chromium binary found. Run `npx playwright-core install chromium` or set CHROMIUM_PATH " +
      "to a Chromium / Chrome for Testing executable (Google Chrome 137+ cannot load unpacked extensions from the command line).",
  );
}

async function launchChrome() {
  const executablePath = await resolveBrowserPath();
  const userDataDir = path.join(artifactsDir, "chrome-profile");
  await mkdir(userDataDir, { recursive: true });
  return chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      "--no-first-run",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
    viewport: { width: 1400, height: 1000 },
  });
}

async function main() {
  await requireBuild();
  await ensureFixtureImage();

  let crossOriginPort = 0;
  const primary = await startServer(() => `http://127.0.0.1:${crossOriginPort}`);
  const secondary = await startServer(() => `http://localhost:${primary.port}`);
  crossOriginPort = secondary.port;
  const pageUrl = `http://localhost:${primary.port}/index.html`;

  const context = await launchChrome();
  const logs = [];
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: STEP_TIMEOUT_MS });
    const extensionId = new URL(worker.url()).host;
    console.log(`Extension loaded: ${extensionId}`);

    const page = await context.newPage();
    page.on("console", (message) => logs.push(`[page] ${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => logs.push(`[page] error: ${error.message}`));
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

    const stateOf = (id) =>
      page.evaluate((elementId) => {
        const element =
          document.getElementById(elementId) ??
          document.getElementById("shadow-host")?.shadowRoot?.getElementById(elementId);
        return element ? element.getAttribute("data-oc-state") : "<missing>";
      }, id);
    const waitForState = (id, expected, timeout = STEP_TIMEOUT_MS) =>
      page.waitForFunction(
        ([elementId, state]) => {
          const element =
            document.getElementById(elementId) ??
            document.getElementById("shadow-host")?.shadowRoot?.getElementById(elementId);
          return element && element.getAttribute("data-oc-state") === state;
        },
        [id, expected],
        { timeout },
      );
    const boxCount = () =>
      page.evaluate(() => {
        const host = document.querySelector("object-censor-overlay");
        return host?.shadowRoot ? host.shadowRoot.querySelectorAll(".box").length : 0;
      });
    const blurOf = (id) => page.evaluate((elementId) => getComputedStyle(document.getElementById(elementId)).filter, id);

    // 1. Media starts out blurred (no state attribute).
    const initialBlur = await blurOf("same-origin");
    record("unprocessed image is blurred by the injected stylesheet", /blur\(/.test(initialBlur), initialBlur);

    // 2. First result: the engine had to start, load the model and analyse the image.
    console.log("Waiting for the engine to analyse the first image (model load included)…");
    await waitForState("same-origin", "censored", FIRST_RESULT_TIMEOUT_MS);
    record("same-origin cat is censored", true);
    record("censored image is no longer blurred", !/blur\(/.test(await blurOf("same-origin")), await blurOf("same-origin"));
    const boxesAfterFirst = await boxCount();
    record("overlay contains at least one black box", boxesAfterFirst > 0, `${boxesAfterFirst} box(es)`);

    // 3. Remaining media.
    await waitForState("cross-origin", "censored");
    record("cross-origin cat is censored (engine fetched the URL)", true);
    await waitForState("plain", "clean");
    record("plain gradient is clean and unblurred", !/blur\(/.test(await blurOf("plain")));
    await waitForState("tiny", "skipped");
    record("tiny image is skipped", true);
    await waitForState("poster", "censored");
    record("video poster is censored", true);
    await waitForState("shadow-img", "censored");
    record("image inside a shadow root is censored", true);

    // 4. Source change re-runs the pipeline and drops the old boxes.
    const boxesBefore = await boxCount();
    await page.evaluate(() => {
      document.getElementById("same-origin").src = window.PLAIN_DATA_URL;
    });
    const stateRightAfter = await stateOf("same-origin");
    await waitForState("same-origin", "clean");
    const boxesAfter = await boxCount();
    record(
      "changing an image's src re-blurs it and re-analyses it",
      stateRightAfter === null || stateRightAfter === "clean",
      `state right after src change: ${stateRightAfter}`,
    );
    record("boxes of the replaced image are removed", boxesAfter < boxesBefore, `${boxesBefore} → ${boxesAfter}`);

    // 5. Disabling the site turns everything off; enabling it again re-processes.
    const updateSettings = (patch) =>
      worker.evaluate(async (changes) => {
        const { settings } = await chrome.storage.sync.get("settings");
        await chrome.storage.sync.set({ settings: { ...settings, ...changes } });
      }, patch);
    await updateSettings({ disabledSites: ["localhost"] });
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-oc-off"), null, {
      timeout: STEP_TIMEOUT_MS,
    });
    record("disabling the site removes all censoring", !/blur\(/.test(await blurOf("cross-origin")) && (await boxCount()) === 0);
    await updateSettings({ disabledSites: [] });
    await waitForState("cross-origin", "censored");
    record("re-enabling the site restores censoring", (await boxCount()) > 0);

    // 6. Engine status is reported to the popup.
    const status = await worker.evaluate(() =>
      new Promise((resolve) => chrome.runtime.sendMessage({ type: "engine:status" }, resolve)),
    );
    record("engine reports ready", Boolean(status?.ready), JSON.stringify(status));
  } catch (error) {
    record("unexpected failure", false, error.message);
    console.log("\n--- captured console output ---");
    for (const line of logs) console.log(line);
  } finally {
    await context.close();
    primary.server.close();
    secondary.server.close();
  }
  summarize(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
