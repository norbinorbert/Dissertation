import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, "..", "..");
export const distDir = path.join(rootDir, "dist");
export const artifactsDir = path.join(rootDir, "tests", ".artifacts");
export const fixtureImage = path.join(artifactsDir, "cat.jpg");

// "Cat03.jpg" from Wikimedia Commons (CC BY-SA 3.0, Von.grzanka) – downloaded on demand, never committed.
const FIXTURE_IMAGE_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/500px-Cat03.jpg";

export async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function ensureFixtureImage() {
  if (await exists(fixtureImage)) return fixtureImage;
  await mkdir(artifactsDir, { recursive: true });
  console.log(`Downloading fixture image from ${FIXTURE_IMAGE_URL}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(FIXTURE_IMAGE_URL, {
      headers: { "User-Agent": "ObjectCensorTests/1.0 (browser extension test fixture)" },
    });
    if (response.ok) {
      await writeFile(fixtureImage, Buffer.from(await response.arrayBuffer()));
      return fixtureImage;
    }
    console.warn(`Attempt ${attempt} failed: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  throw new Error("Could not download the fixture image.");
}

export async function requireBuild() {
  if (!(await exists(path.join(distDir, "manifest.json")))) {
    throw new Error("dist/ is missing – run `npm run build` first.");
  }
}

export function record(results, name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` – ${detail}` : ""}`);
}

export function summarize(results) {
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
