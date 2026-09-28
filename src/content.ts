import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

const TARGET_CLASSES = ["person", "dog", "cat"];
const MIN_SCORE = 0.5;

// Use WeakSets to track processed elements so memory is freed when elements leave the DOM
const processedImages = new WeakSet();
const processedVideos = new WeakSet();

let globalModel: cocoSsd.ObjectDetection | null = null;

async function startCensoring() {
  console.log("[Censor PoC] Loading AI Model...");
  await tf.setBackend("webgl");
  globalModel = await cocoSsd.load();
  console.log("[Censor PoC] Model loaded. Watching DOM and scroll...");

  // 1. Observe existing media & set up DOM observers
  setupObservers();
  scanExistingMedia();
}

// --- OBSERVERS FOR DYNAMIC SCROLLING --- //

// Only scan images/videos when they enter the viewport
const intersectionObserver = new IntersectionObserver(
  (entries) => {
    if (!globalModel) return;

    for (const entry of entries) {
      if (entry.isIntersecting) {
        const element = entry.target;

        if (element instanceof HTMLImageElement) {
          if (!processedImages.has(element)) {
            processedImages.add(element);
            handleImage(element, globalModel);
          }
        } else if (element instanceof HTMLVideoElement) {
          if (!processedVideos.has(element)) {
            processedVideos.add(element);
            processVideo(element, globalModel);
          }
        }
      }
    }
  },
  {
    // Pre-scan media 200px before it scrolls into view for seamless appearance
    rootMargin: "200px",
  },
);

function observeMediaElement(element: Element) {
  if (
    element instanceof HTMLImageElement ||
    element instanceof HTMLVideoElement
  ) {
    intersectionObserver.observe(element);
  }
}

function scanExistingMedia() {
  const mediaElements = document.querySelectorAll("img, video");
  mediaElements.forEach(observeMediaElement);
}

function setupObservers() {
  // MutationObserver detects newly injected images/videos (infinite scroll feeds)
  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLElement) {
          if (node.tagName === "IMG" || node.tagName === "VIDEO") {
            observeMediaElement(node);
          }
          // Check children inside added containers (e.g. new post cards)
          const nestedMedia = node.querySelectorAll?.("img, video");
          nestedMedia?.forEach(observeMediaElement);
        }
      }
    }
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Update overlay box positions when the window is resized
  window.addEventListener("resize", () => {
    document
      .querySelectorAll<HTMLElement>('[id^="censor-overlay-"]')
      .forEach((overlay) => {
        overlay.style.display = "none"; // Temporarily hide during rapid resize
      });
  });
}

// --- IMAGE HANDLING --- //

function handleImage(img: HTMLImageElement, model: cocoSsd.ObjectDetection) {
  if (img.complete && img.naturalWidth > 50) {
    processImage(img, model);
  } else {
    img.addEventListener(
      "load",
      () => {
        if (img.naturalWidth > 50) processImage(img, model);
      },
      { once: true },
    );
  }
}

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
    if (img.src.startsWith("http")) {
      imageToScan = await fetchCleanImage(img.src);
    }
    const predictions = await model.detect(imageToScan);
    drawCensorBoxes(img, predictions);
  } catch (error) {
    console.warn("[Censor PoC] Could not process image:", img.src);
  }
}

// --- VIDEO HANDLING --- //

function processVideo(video: HTMLVideoElement, model: cocoSsd.ObjectDetection) {
  video.addEventListener("play", () => runVideoDetectionLoop(video, model));
  if (!video.paused && !video.ended) {
    runVideoDetectionLoop(video, model);
  }
}

async function runVideoDetectionLoop(
  video: HTMLVideoElement,
  model: cocoSsd.ObjectDetection,
) {
  if (video.paused || video.ended) return;

  try {
    const predictions = await model.detect(video);
    drawCensorBoxes(video, predictions);
  } catch (error) {
    console.warn("[Censor PoC] Video stream blocked or paused:", error);
    return;
  }

  requestAnimationFrame(() => runVideoDetectionLoop(video, model));
}

// --- DRAWING OVERLAYS --- //

function drawCensorBoxes(
  media: HTMLImageElement | HTMLVideoElement,
  predictions: cocoSsd.DetectedObject[],
) {
  const isVideo = media instanceof HTMLVideoElement;
  const naturalWidth = isVideo
    ? (media as HTMLVideoElement).videoWidth
    : (media as HTMLImageElement).naturalWidth;
  const naturalHeight = isVideo
    ? (media as HTMLVideoElement).videoHeight
    : (media as HTMLImageElement).naturalHeight;

  if (!naturalWidth || !naturalHeight) return;

  let overlayId = media.dataset.censorId;
  if (!overlayId) {
    overlayId = "censor-overlay-" + Math.random().toString(36).substring(2, 9);
    media.dataset.censorId = overlayId;
  }

  let overlay = document.getElementById(overlayId);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.style.position = "absolute";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "999999";
    document.body.appendChild(overlay);
  }

  const rect = media.getBoundingClientRect();
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.style.display = "block";

  overlay.innerHTML = "";

  const scaleX = rect.width / naturalWidth;
  const scaleY = rect.height / naturalHeight;

  for (const pred of predictions) {
    if (TARGET_CLASSES.includes(pred.class) && pred.score >= MIN_SCORE) {
      const [x, y, width, height] = pred.bbox;
      const box = document.createElement("div");
      box.style.position = "absolute";
      box.style.backgroundColor = "black";
      box.style.left = `${x * scaleX}px`;
      box.style.top = `${y * scaleY}px`;
      box.style.width = `${width * scaleX}px`;
      box.style.height = `${height * scaleY}px`;
      overlay.appendChild(box);
    }
  }
}

// Initialize
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startCensoring);
} else {
  startCensoring();
}
