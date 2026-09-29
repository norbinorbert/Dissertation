import type { Detection } from "../shared/messages";
import type { Settings } from "../shared/settings";
import type { NormalizedBox, Size } from "./geometry";

export type MediaElement = HTMLImageElement | HTMLVideoElement;

/**
 * Processing state written to `data-oc-state`; the injected stylesheet blurs media
 * without a state (and `failed` media when the policy says so).
 */
export type MediaState = "clean" | "censored" | "skipped" | "failed";

export const STATE_ATTRIBUTE = "data-oc-state";

export function setMediaState(element: Element, state: MediaState | null): void {
  if (state === null) {
    if (element.hasAttribute(STATE_ATTRIBUTE)) element.removeAttribute(STATE_ATTRIBUTE);
  } else if (element.getAttribute(STATE_ATTRIBUTE) !== state) {
    element.setAttribute(STATE_ATTRIBUTE, state);
  }
}

export function isInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

/** True when the element is rendered smaller than the configured minimum on either axis. */
export function isRenderedTooSmall(element: Element, minSize: number): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  return rect.width < minSize || rect.height < minSize;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Applies the user's class/score filters and converts pixel boxes into normalized ones. */
export function toNormalizedBoxes(detections: Detection[], analysed: Size, settings: Settings): NormalizedBox[] {
  if (!analysed.width || !analysed.height) return [];
  const boxes: NormalizedBox[] = [];
  for (const detection of detections) {
    if (!settings.classes[detection.class] || detection.score < settings.minScore) continue;
    const [x, y, width, height] = detection.box;
    const left = clamp01(x / analysed.width);
    const top = clamp01(y / analysed.height);
    const right = clamp01((x + width) / analysed.width);
    const bottom = clamp01((y + height) / analysed.height);
    if (right <= left || bottom <= top) continue;
    boxes.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return boxes;
}

const VECTOR_PATTERN = /\.svgz?(?:[?#]|$)/i;

export function isVectorSource(source: string): boolean {
  if (source.startsWith("data:")) return /^data:image\/svg\+xml/i.test(source);
  try {
    return VECTOR_PATTERN.test(new URL(source, location.href).pathname);
  } catch {
    return false;
  }
}

/** Whether a canvas in this page may read the pixels of `image` loaded from `source`. */
export function canReadImagePixels(image: HTMLImageElement, source: string): boolean {
  if (source.startsWith("data:") || source.startsWith("blob:")) return true;
  try {
    if (new URL(source, location.href).origin === location.origin) return true;
  } catch {
    return false;
  }
  // A successfully loaded image with a crossorigin attribute passed the CORS check.
  return image.crossOrigin !== null && image.complete && image.naturalWidth > 0;
}
