#!/usr/bin/env node
/**
 * Runs the built content script inside a plain page (no extension loading required) with
 * chrome.* mocked (tests/harness/mock-chrome.js) and a fake detection engine, then checks
 * the observable behaviour: blur-by-default, state attributes, overlay boxes, clipping,
 * source changes, videos, shadow DOM, settings changes and extension-reload handling.
 *
 * Works with the locally installed Google Chrome (channel "chrome") because nothing needs
 * to be installed as an extension.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { distDir, record as baseRecord, requireBuild, summarize } from "../lib/common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const STEP_TIMEOUT_MS = 15_000;

const FILES = {
  "/": { file: path.join(here, "index.html"), type: "text/html; charset=utf-8" },
  "/index.html": { file: path.join(here, "index.html"), type: "text/html; charset=utf-8" },
  "/mock-chrome.js": { file: path.join(here, "mock-chrome.js"), type: "text/javascript" },
  "/content.js": { file: path.join(distDir, "content.js"), type: "text/javascript" },
  "/content.css": { file: path.join(distDir, "content.css"), type: "text/css" },
  "/icon.png": { file: path.join(distDir, "icons", "icon-128.png"), type: "image/png" },
};

const results = [];
const record = (name, ok, detail) => baseRecord(results, name, ok, detail);

function startServer() {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const entry = FILES[pathname];
    if (!entry) {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = await readFile(entry.file);
    if (entry.type.startsWith("text/html")) {
      body = body.toString("utf8").replaceAll("__PORT__", String(server.address().port));
    }
    response.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-store" });
    response.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

async function main() {
  await requireBuild();
  const { server, port } = await startServer();
  const browser = await chromium.launch({
    channel: process.env.CHROMIUM_PATH ? undefined : "chrome",
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const logs = [];
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

  // Helpers evaluated in the page.
  const find = (id) => `(document.getElementById(${JSON.stringify(id)}) ?? document.getElementById("shadow-host").shadowRoot.getElementById(${JSON.stringify(id)}))`;
  const stateOf = (id) => page.evaluate(`${find(id)}.getAttribute("data-oc-state")`);
  const filterOf = (id) => page.evaluate(`getComputedStyle(${find(id)}).filter`);
  const waitForState = (id, state, timeout = STEP_TIMEOUT_MS) =>
    page.waitForFunction(`${find(id)}.getAttribute("data-oc-state") === ${JSON.stringify(state)}`, null, { timeout });
  const boxes = () =>
    page.evaluate(() => {
      const host = document.querySelector("object-censor-overlay");
      if (!host?.shadowRoot) return [];
      return Array.from(host.shadowRoot.querySelectorAll(".group"))
        .filter((group) => group.style.display !== "none")
        .flatMap((group) => Array.from(group.querySelectorAll(".box")).map((box) => box.getBoundingClientRect().toJSON()));
    });
  const rectOf = (id) => page.evaluate(`${find(id)}.getBoundingClientRect().toJSON()`);
  /** Visible boxes whose rectangle lies (roughly) within the given element. */
  const boxesOver = async (id) => {
    const rect = await rectOf(id);
    const margin = 30;
    return (await boxes()).filter(
      (box) =>
        box.x >= rect.x - margin &&
        box.y >= rect.y - margin &&
        box.x + box.width <= rect.x + rect.width + margin &&
        box.y + box.height <= rect.y + rect.height + margin,
    );
  };
  const imageCalls = () => page.evaluate(() => window.__harness.imageCalls);
  const settle = () => page.waitForTimeout(400);
  const roughly = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });

    // Blur-by-default: an element that is never processed (clipped out of view) keeps the rule.
    const clippedFilterEarly = await filterOf("clipped");
    record("unprocessed media is blurred by the stylesheet", /blur\(/.test(clippedFilterEarly), clippedFilterEarly);

    await waitForState("square", "censored");
    record("square image (fake hit) becomes censored", true);
    record("censored image is unblurred", !/blur\(/.test(await filterOf("square")));
    await settle();
    let visibleBoxes = await boxes();
    const squareRect = await rectOf("square");
    const squareBox = visibleBoxes.find(
      (box) => box.x >= squareRect.x - 30 && box.x + box.width <= squareRect.x + squareRect.width + 30 && box.y >= squareRect.y - 30,
    );
    record("a black box is drawn inside the square image", Boolean(squareBox), JSON.stringify(squareBox));
    if (squareBox) {
      // The fake detection covers the central 50%; the overlay pads boxes by ~4% of their size.
      const expected = { x: squareRect.x + 75, y: squareRect.y + 75, size: 150 };
      const pad = Math.max(2, 0.04 * 150);
      record(
        "box geometry matches the detection (centre 50% + padding)",
        roughly(squareBox.x, expected.x - pad, 2) &&
          roughly(squareBox.y, expected.y - pad, 2) &&
          roughly(squareBox.width, expected.size + 2 * pad, 2),
        `box=${JSON.stringify(squareBox)} expected≈${JSON.stringify(expected)} pad=${pad}`,
      );
    }

    await waitForState("wide", "clean");
    record("wide image (no hit) is clean and unblurred", !/blur\(/.test(await filterOf("wide")));
    await waitForState("tiny", "skipped");
    record("tiny image is skipped", true);
    await waitForState("svg", "skipped");
    record("SVG image is skipped", true);
    await waitForState("shadow-img", "censored");
    record("image inside shadow DOM is censored", true);
    await waitForState("remote", "failed");
    record("unfetchable cross-origin image is marked failed", true);
    record("failed media stays blurred under the default policy", /blur\(/.test(await filterOf("remote")));

    // Policy change → failed media shown.
    await page.evaluate(() => window.__harness.updateSettings({ unprocessablePolicy: "show" }));
    await page.waitForFunction(`!/blur\\(/.test(getComputedStyle(${find("remote")}).filter)`, null, { timeout: STEP_TIMEOUT_MS });
    record("policy 'show' unblurs failed media", true);
    await page.evaluate(() => window.__harness.updateSettings({ unprocessablePolicy: "blur" }));

    // Video frames from a canvas stream (square → hit).
    await waitForState("stream", "censored");
    const framesSoFar = await page.evaluate(() => window.__harness.frameCalls);
    await page.waitForTimeout(600);
    const framesLater = await page.evaluate(() => window.__harness.frameCalls);
    record("video frames are analysed continuously while playing", framesLater > framesSoFar, `${framesSoFar} → ${framesLater}`);
    const videoRect = await rectOf("stream");
    visibleBoxes = await boxes();
    record(
      "a box is drawn over the playing video",
      visibleBoxes.some((box) => box.x >= videoRect.x - 30 && box.x + box.width <= videoRect.x + videoRect.width + 30 && box.y >= videoRect.y - 30 && box.y + box.height <= videoRect.y + videoRect.height + 30),
    );
    await page.evaluate(() => document.getElementById("stream").pause());
    await page.waitForTimeout(500);
    const pausedFrames = await page.evaluate(() => window.__harness.frameCalls);
    await page.waitForTimeout(600);
    record(
      "paused video stops the frame loop and stays censored",
      (await page.evaluate(() => window.__harness.frameCalls)) - pausedFrames <= 1 && (await stateOf("stream")) === "censored",
    );
    await page.evaluate(() => document.getElementById("stream").play());

    // Clipping: image inside a scroll container that is scrolled out of view.
    record("media scrolled out of an overflow container is left blurred/unprocessed", (await stateOf("clipped")) === null);
    await page.evaluate(() => {
      const scroller = document.getElementById("scroller");
      scroller.scrollTop = scroller.scrollHeight;
    });
    await waitForState("clipped", "censored");
    await settle();
    const scrollerRect = await rectOf("scroller");
    const groupRects = await page.evaluate(() => {
      const host = document.querySelector("object-censor-overlay");
      return Array.from(host.shadowRoot.querySelectorAll(".group"))
        .filter((group) => group.style.display !== "none")
        .map((group) => group.getBoundingClientRect().toJSON());
    });
    const clippedGroup = groupRects.find((rect) => rect.y >= scrollerRect.y - 1 && rect.y + rect.height <= scrollerRect.y + scrollerRect.height + 1 && rect.x >= scrollerRect.x - 1);
    record("boxes of clipped media are confined to the scroll container", Boolean(clippedGroup), JSON.stringify({ scrollerRect, groupRects }));

    // Source change re-runs the pipeline and drops old boxes.
    const beforeChange = (await boxesOver("square")).length;
    await page.evaluate(() => {
      document.getElementById("square").src = window.WIDE;
    });
    await waitForState("square", "clean");
    await settle();
    const afterChange = (await boxesOver("square")).length;
    record("changing src to a clean image removes its boxes", beforeChange > 0 && afterChange === 0, `${beforeChange} → ${afterChange}`);
    await page.evaluate(() => {
      document.getElementById("square").src = window.SQUARE_ALT;
    });
    await waitForState("square", "censored");
    record("changing src to a new image re-analyses it", true);

    // Re-assigning the same src must not flicker.
    const callsBefore = await imageCalls();
    await page.evaluate(() => {
      const image = document.getElementById("square");
      image.setAttribute("src", image.getAttribute("src"));
    });
    await page.waitForTimeout(300);
    record(
      "re-assigning an identical src does not re-analyse",
      (await imageCalls()) === callsBefore && (await stateOf("square")) === "censored",
      `image detections ${callsBefore} → ${await imageCalls()}`,
    );

    // Dynamically inserted media.
    await page.evaluate(() => {
      const image = document.createElement("img");
      image.id = "dynamic";
      image.width = 300;
      image.height = 300;
      image.src = window.SQUARE;
      document.body.appendChild(image);
    });
    await waitForState("dynamic", "censored");
    record("dynamically inserted media is processed", true);
    await settle();
    const withDynamic = (await boxesOver("dynamic")).length;
    const dynamicRect = await rectOf("dynamic");
    await page.evaluate(() => document.getElementById("dynamic").remove());
    await settle();
    const leftovers = (await boxes()).filter(
      (box) => box.x >= dynamicRect.x - 30 && box.y >= dynamicRect.y - 30 && box.y + box.height <= dynamicRect.y + dynamicRect.height + 30,
    );
    record("removed media loses its boxes", withDynamic > 0 && leftovers.length === 0, `${withDynamic} before, ${leftovers.length} after`);

    // Settings: class toggles and thresholds re-filter existing results without re-analysis.
    const callsBeforeSettings = await imageCalls();
    await page.evaluate(() => window.__harness.updateSettings({ classes: { person: false, dog: true, cat: true, knife: true, bottle: true } }));
    await waitForState("square", "clean");
    record(
      "disabling a class re-filters cached results without new detections",
      (await imageCalls()) === callsBeforeSettings,
      `image detections ${callsBeforeSettings} → ${await imageCalls()}`,
    );
    await page.evaluate(() => window.__harness.updateSettings({ classes: { person: true, dog: true, cat: true, knife: true, bottle: true } }));
    await waitForState("square", "censored");

    // Disable/enable for this site.
    await page.evaluate(() => window.__harness.updateSettings({ disabledSites: ["127.0.0.1"] }));
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-oc-off"), null, { timeout: STEP_TIMEOUT_MS });
    await settle();
    record("disabling the site removes blur and boxes", !/blur\(/.test(await filterOf("remote")) && (await boxes()).length === 0);
    await page.evaluate(() => window.__harness.updateSettings({ disabledSites: [] }));
    await waitForState("square", "censored");
    record("re-enabling restores censoring", (await boxes()).length > 0);

    // Extension reload: the orphaned script must release the page.
    await page.evaluate(() => window.__harness.invalidateContext());
    await page.evaluate(() => {
      const image = document.createElement("img");
      image.width = 300;
      image.height = 300;
      image.src = window.SQUARE;
      document.body.appendChild(image);
    });
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-oc-off"), null, { timeout: STEP_TIMEOUT_MS });
    record("orphaned content script (extension reloaded) unblurs the page", (await boxes()).length === 0);

    const errors = logs.filter((line) => line.startsWith("pageerror") || line.startsWith("error"));
    record("no uncaught errors in the page", errors.length === 0, errors.join(" | "));
  } catch (error) {
    record("unexpected failure", false, error.message);
    console.log("\n--- console ---");
    for (const line of logs) console.log(line);
  } finally {
    await browser.close();
    server.close();
  }
  summarize(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
