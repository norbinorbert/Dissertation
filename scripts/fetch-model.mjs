#!/usr/bin/env node
// Downloads the coco-ssd (lite_mobilenet_v2) graph model into public/model so the
// extension ships the weights itself instead of fetching them from Google's CDN at runtime.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_BASE_URL =
  "https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelDir = path.join(rootDir, "public", "model");
const manifestPath = path.join(modelDir, "model.json");

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function download(relativePath) {
  const url = new URL(relativePath, MODEL_BASE_URL);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function shardPaths(manifest) {
  return manifest.weightsManifest.flatMap((group) => group.paths);
}

async function main() {
  await mkdir(modelDir, { recursive: true });

  let manifest;
  if (await exists(manifestPath)) {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const missing = [];
    for (const shard of shardPaths(manifest)) {
      if (!(await exists(path.join(modelDir, shard)))) missing.push(shard);
    }
    if (missing.length === 0) {
      console.log(`[fetch-model] Model already present in ${path.relative(rootDir, modelDir)}`);
      return;
    }
  }

  console.log(`[fetch-model] Downloading model manifest from ${MODEL_BASE_URL}`);
  const manifestBuffer = await download("model.json");
  manifest = JSON.parse(manifestBuffer.toString("utf8"));
  await writeFile(manifestPath, manifestBuffer);

  const shards = shardPaths(manifest);
  for (const [index, shard] of shards.entries()) {
    const target = path.join(modelDir, shard);
    if (await exists(target)) continue;
    console.log(`[fetch-model] Downloading ${shard} (${index + 1}/${shards.length})`);
    await writeFile(target, await download(shard));
  }
  console.log(`[fetch-model] Done. Model stored in ${path.relative(rootDir, modelDir)}`);
}

main().catch((error) => {
  console.error("[fetch-model]", error.message);
  console.error(
    "[fetch-model] The extension falls back to loading the model from the network at runtime when public/model is missing.",
  );
  process.exitCode = 1;
});
