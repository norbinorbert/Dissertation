import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

const TARGET_CLASSES = ["person", "dog", "cat"];
const MIN_SCORE = 0.5;

async function startCensoring() {
  console.log("[Censor PoC] Loading AI Model...");
  await tf.setBackend("webgl");
  const model = await cocoSsd.load();
  console.log("[Censor PoC] Model loaded. Scanning images...");

  const images = document.querySelectorAll("img");
  for (const img of Array.from(images)) {
    if (img.complete && img.naturalWidth > 50) {
      processImage(img, model);
    } else {
      img.addEventListener("load", () => {
        if (img.naturalWidth > 50) processImage(img, model);
      });
    }
  }
}

// Fetch a clean Data URL via the background service worker
async function fetchCleanImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "fetchImage", url }, (response) => {
      if (chrome.runtime.lastError || response?.error) {
        return reject(response?.error || chrome.runtime.lastError);
      }
      const cleanImg = new Image();
      cleanImg.crossOrigin = "anonymous";
      cleanImg.onload = () => resolve(cleanImg);
      cleanImg.onerror = (err) => reject(err);
      cleanImg.src = response.dataUrl;
    });
  });
}

async function processImage(
  img: HTMLImageElement,
  model: cocoSsd.ObjectDetection,
) {
  try {
    let imageToScan: HTMLImageElement = img;

    // If it's a remote URL, bypass CORS by fetching via background script
    if (img.src.startsWith("http")) {
      imageToScan = await fetchCleanImage(img.src);
    }

    const predictions = await model.detect(imageToScan);

    for (const pred of predictions) {
      console.log(
        `[Censor PoC] Detected ${pred.class} ${Math.round(pred.score * 100)}%)`,
      );
      if (TARGET_CLASSES.includes(pred.class) && pred.score >= MIN_SCORE) {
        drawBlackBox(img, pred.bbox);
      }
    }
  } catch (error) {
    console.warn("[Censor PoC] Could not process image:", img.src, error);
  }
}

function drawBlackBox(
  img: HTMLImageElement,
  bbox: [number, number, number, number],
) {
  const [x, y, width, height] = bbox;
  const rect = img.getBoundingClientRect();

  const scaleX = rect.width / img.naturalWidth;
  const scaleY = rect.height / img.naturalHeight;

  const censorBox = document.createElement("div");
  censorBox.style.position = "absolute";
  censorBox.style.backgroundColor = "black";
  censorBox.style.zIndex = "999999";

  censorBox.style.left = `${rect.left + window.scrollX + x * scaleX}px`;
  censorBox.style.top = `${rect.top + window.scrollY + y * scaleY}px`;
  censorBox.style.width = `${width * scaleX}px`;
  censorBox.style.height = `${height * scaleY}px`;

  document.body.appendChild(censorBox);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startCensoring);
} else {
  startCensoring();
}
