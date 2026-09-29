/**
 * Draws media into a scratch canvas and encodes a downscaled copy for the engine.
 * Reading pixels of cross-origin media without CORS approval throws a SecurityError
 * and permanently taints the canvas, so a tainted scratch canvas is thrown away.
 */

export interface Capture {
  dataUrl: string;
  width: number;
  height: number;
}

export type CaptureResult = Capture | "tainted" | "empty";

const ENCODE_MIME = "image/webp";
const ENCODE_QUALITY = 0.8;

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function getScratch(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (!scratch || !scratchCtx) {
    scratch = document.createElement("canvas");
    scratchCtx = scratch.getContext("2d", { alpha: false, willReadFrequently: false });
    if (!scratchCtx) throw new Error("2D canvas context unavailable");
  }
  return { canvas: scratch, ctx: scratchCtx };
}

function discardScratch(): void {
  scratch = null;
  scratchCtx = null;
}

export function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Captures `source` (an <img>, <video> or ImageBitmap) whose intrinsic size is
 * `sourceWidth`×`sourceHeight`, downscaled so the longest side is at most `maxSide`.
 */
export function captureSource(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxSide: number,
): CaptureResult {
  if (!sourceWidth || !sourceHeight) return "empty";
  const { width, height } = scaledSize(sourceWidth, sourceHeight, maxSide);
  const { canvas, ctx } = getScratch();
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  try {
    ctx.drawImage(source, 0, 0, width, height);
    const dataUrl = canvas.toDataURL(ENCODE_MIME, ENCODE_QUALITY);
    return { dataUrl, width, height };
  } catch (error) {
    discardScratch();
    if (error instanceof DOMException && error.name === "SecurityError") return "tainted";
    throw error;
  }
}

/** Loads a same-origin, data: or blob: URL into an image element for capturing. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url.slice(0, 80)}`));
    image.src = url;
  });
}
