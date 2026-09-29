#!/usr/bin/env node
/**
 * Runs the real inference engine (dist/engine.js: TensorFlow.js + coco-ssd + the bundled
 * model) inside a plain page with chrome.runtime mocked, and checks that it loads the
 * model, detects the cat in the fixture photo through both source kinds (URL fetch and
 * data-URL capture), and reports the expected error codes.
 *
 * Uses the locally installed Google Chrome; WebGL runs on SwiftShader in headless mode,
 * so the first inference can take a while.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { distDir, ensureFixtureImage, record as baseRecord, requireBuild, summarize } from "../lib/common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL_READY_TIMEOUT_MS = 240_000;
const results = [];
const record = (name, ok, detail) => baseRecord(results, name, ok, detail);

const STATIC = {
  "/engine.html": { file: path.join(here, "engine.html"), type: "text/html; charset=utf-8" },
  "/mock-chrome-engine.js": { file: path.join(here, "mock-chrome-engine.js"), type: "text/javascript" },
  "/engine.js": { file: path.join(distDir, "engine.js"), type: "text/javascript" },
  "/plain.svg": { body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', type: "image/svg+xml" },
};

function startServer(fixtureImage) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    try {
      if (pathname === "/cat.jpg") {
        response.writeHead(200, { "Content-Type": "image/jpeg" });
        response.end(await readFile(fixtureImage));
      } else if (pathname.startsWith("/model/")) {
        const file = path.join(distDir, "model", path.basename(pathname));
        response.writeHead(200, { "Content-Type": pathname.endsWith(".json") ? "application/json" : "application/octet-stream" });
        response.end(await readFile(file));
      } else if (STATIC[pathname]) {
        const entry = STATIC[pathname];
        response.writeHead(200, { "Content-Type": entry.type });
        response.end(entry.body ?? (await readFile(entry.file)));
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

async function main() {
  await requireBuild();
  const fixtureImage = await ensureFixtureImage();
  const { server, port } = await startServer(fixtureImage);
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({
    channel: process.env.CHROMIUM_PATH ? undefined : "chrome",
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

  try {
    await page.goto(`${origin}/engine.html`, { waitUntil: "load" });

    console.log("Waiting for the model to load (SwiftShader WebGL is slow)…");
    const started = Date.now();
    let pong;
    while (true) {
      pong = await page.evaluate(() => window.__engineHarness.message({ type: "engine:ping" }));
      if (pong?.error) throw new Error(`Engine failed to load: ${pong.error}`);
      if (pong?.ready) break;
      if (Date.now() - started > MODEL_READY_TIMEOUT_MS) throw new Error("Model did not load in time.");
      await page.waitForTimeout(500);
    }
    record("engine answers ping and loads the bundled model", pong.ready, `${pong.backend} backend, ${Math.round((Date.now() - started) / 1000)}s`);

    await page.evaluate(() => {
      window.__client = window.__engineHarness.connect();
    });

    const isCatBox = (result) => {
      const cat = result.detections?.find((detection) => detection.class === "cat");
      if (!cat) return false;
      const [x, y, w, h] = cat.box;
      return cat.score >= 0.5 && x >= 0 && y >= 0 && w > result.width * 0.3 && h > result.height * 0.3 && x + w <= result.width + 1 && y + h <= result.height + 1;
    };

    const t0 = Date.now();
    const byUrl = await page.evaluate((url) => window.__client.detect({ kind: "url", url }), `${origin}/cat.jpg`);
    record("detects the cat when fetching the image URL itself", byUrl.type === "result" && isCatBox(byUrl), `${JSON.stringify(byUrl).slice(0, 200)} (${Date.now() - t0}ms)`);
    record("reports the analysed bitmap size", byUrl.width === 500 && Math.abs(byUrl.height - 499) <= 2, `${byUrl.width}x${byUrl.height}`);

    const byData = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 320;
      canvas.getContext("2d").drawImage(image, 0, 0, 320, 320);
      return window.__client.detect({ kind: "data", dataUrl: canvas.toDataURL("image/webp", 0.8) }, 0);
    }, `${origin}/cat.jpg`);
    record("detects the cat in a downscaled webp capture (video-frame path)", byData.type === "result" && isCatBox(byData), JSON.stringify(byData).slice(0, 200));

    const timings = [];
    for (let i = 0; i < 3; i++) {
      const start = Date.now();
      const repeat = await page.evaluate((url) => window.__client.detect({ kind: "url", url }), `${origin}/cat.jpg`);
      timings.push(Date.now() - start);
      if (repeat.type !== "result") record("repeated detection", false, JSON.stringify(repeat));
    }
    record("repeated detections keep working", timings.length === 3, `${timings.join("ms, ")}ms`);

    const svg = await page.evaluate((url) => window.__client.detect({ kind: "url", url }), `${origin}/plain.svg`);
    record("SVG sources are reported as unsupported", svg.type === "error" && svg.code === "unsupported", JSON.stringify(svg));
    const missing = await page.evaluate((url) => window.__client.detect({ kind: "url", url }), `${origin}/nope.jpg`);
    record("HTTP errors are reported as fetch errors", missing.type === "error" && missing.code === "fetch", JSON.stringify(missing));
    const garbage = await page.evaluate(() => window.__client.detect({ kind: "data", dataUrl: "data:image/png;base64,AAAA" }));
    record("undecodable captures are reported as decode errors", garbage.type === "error" && garbage.code === "decode", JSON.stringify(garbage));
    const sent = await page.evaluate(() => window.__engineHarness.sent);
    record("no fatal error was reported to the background", !sent.some((message) => message.type === "engine:fatal"), JSON.stringify(sent));
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
