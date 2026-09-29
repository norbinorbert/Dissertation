/**
 * Finds every <img> and <video> in the document (including open and closed shadow
 * roots) and reports lifecycle events for them. Pure observation: no state changes.
 */
import type { MediaElement } from "./media-state";

export interface MediaTrackerDelegate {
  onAdded(element: MediaElement): void;
  onRemoved(element: MediaElement): void;
  /** src/srcset/poster (or a <source> child) changed. */
  onSourceChanged(element: MediaElement): void;
  /** Element entered/left the area around the viewport that is worth processing. */
  onNearChanged(element: MediaElement, near: boolean): void;
  onResized(element: MediaElement): void;
  onImageLoaded(image: HTMLImageElement): void;
  onImageError(image: HTMLImageElement): void;
  onVideoEvent(video: HTMLVideoElement, type: string): void;
  /** A shadow root was discovered; the delegate may inject styles into it. */
  onShadowRoot(root: ShadowRoot): void;
}

type Root = Document | ShadowRoot;

const VIDEO_EVENTS = [
  "loadedmetadata",
  "loadeddata",
  "emptied",
  "play",
  "playing",
  "pause",
  "seeking",
  "seeked",
  "ended",
  "timeupdate",
  "encrypted",
  "resize",
];
const RESOURCE_EVENTS = ["load", "error"];
const SOURCE_ATTRIBUTES = ["src", "srcset", "sizes", "poster"];
/** Process media this far outside the viewport (fraction of viewport height) ahead of time. */
const NEAR_ROOT_MARGIN = "50% 0px 50% 0px";
const SWEEP_INTERVAL_MS = 3000;

function isMedia(node: Node): node is MediaElement {
  return node instanceof HTMLImageElement || node instanceof HTMLVideoElement;
}

function shadowRootOf(element: Element): ShadowRoot | null {
  if (!(element instanceof HTMLElement)) return null;
  try {
    const opener = chrome.dom?.openOrClosedShadowRoot;
    if (opener) return opener(element) ?? null;
  } catch {
    // Not available in this context; fall back to open roots only.
  }
  return element.shadowRoot;
}

export class MediaTracker {
  private readonly tracked = new Set<MediaElement>();
  private readonly roots = new Map<Root, MutationObserver>();
  private readonly intersection: IntersectionObserver;
  private readonly resize: ResizeObserver;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly delegate: MediaTrackerDelegate) {
    this.intersection = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (isMedia(entry.target) && this.tracked.has(entry.target)) {
            this.delegate.onNearChanged(entry.target, entry.isIntersecting);
          }
        }
      },
      { rootMargin: NEAR_ROOT_MARGIN, threshold: 0 },
    );
    this.resize = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (isMedia(entry.target) && this.tracked.has(entry.target)) this.delegate.onResized(entry.target);
      }
    });
  }

  get elements(): Iterable<MediaElement> {
    return this.tracked;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attachRoot(document);
    this.scan(document);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const root of Array.from(this.roots.keys())) this.detachRoot(root);
    this.intersection.disconnect();
    this.resize.disconnect();
    for (const element of Array.from(this.tracked)) {
      this.tracked.delete(element);
      this.delegate.onRemoved(element);
    }
  }

  // ---- roots ------------------------------------------------------------------

  private attachRoot(root: Root): void {
    if (this.roots.has(root)) return;
    const observer = new MutationObserver(this.handleMutations);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: SOURCE_ATTRIBUTES,
    });
    this.roots.set(root, observer);
    for (const type of RESOURCE_EVENTS) root.addEventListener(type, this.handleResourceEvent, true);
    for (const type of VIDEO_EVENTS) root.addEventListener(type, this.handleVideoEvent, true);
    if (root instanceof ShadowRoot) this.delegate.onShadowRoot(root);
  }

  private detachRoot(root: Root): void {
    const observer = this.roots.get(root);
    if (!observer) return;
    observer.disconnect();
    this.roots.delete(root);
    for (const type of RESOURCE_EVENTS) root.removeEventListener(type, this.handleResourceEvent, true);
    for (const type of VIDEO_EVENTS) root.removeEventListener(type, this.handleVideoEvent, true);
  }

  // ---- discovery --------------------------------------------------------------

  private scan(node: Node): void {
    if (node instanceof Element) this.visit(node);
    else if (!(node instanceof Document || node instanceof ShadowRoot)) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let current = walker.nextNode();
    while (current) {
      this.visit(current as Element);
      current = walker.nextNode();
    }
  }

  private visit(element: Element): void {
    if (isMedia(element)) this.track(element);
    const shadow = shadowRootOf(element);
    if (shadow && !this.roots.has(shadow)) {
      this.attachRoot(shadow);
      this.scan(shadow);
    }
  }

  private track(element: MediaElement): void {
    if (this.tracked.has(element)) return;
    this.tracked.add(element);
    this.intersection.observe(element);
    this.resize.observe(element);
    this.delegate.onAdded(element);
  }

  private untrack(element: MediaElement): void {
    if (!this.tracked.delete(element)) return;
    this.intersection.unobserve(element);
    this.resize.unobserve(element);
    this.delegate.onRemoved(element);
  }

  private handleRemovedSubtree(node: Element): void {
    const candidates: MediaElement[] = [];
    if (isMedia(node)) candidates.push(node);
    node.querySelectorAll("img, video").forEach((media) => candidates.push(media as MediaElement));
    for (const media of candidates) {
      // Nodes that were merely moved are still connected and stay tracked.
      if (this.tracked.has(media) && !media.isConnected) this.untrack(media);
    }
  }

  /** Catches what the observers cannot see: late-attached shadow roots and detached media. */
  private sweep(): void {
    if (document.hidden) return;
    for (const element of Array.from(this.tracked)) {
      if (!element.isConnected) this.untrack(element);
    }
    for (const root of Array.from(this.roots.keys())) {
      if (root instanceof ShadowRoot && !root.host.isConnected) {
        this.detachRoot(root);
        continue;
      }
      const elements = root.querySelectorAll("*");
      for (let i = 0; i < elements.length; i++) {
        const shadow = shadowRootOf(elements[i]);
        if (shadow && !this.roots.has(shadow)) {
          this.attachRoot(shadow);
          this.scan(shadow);
        }
      }
    }
  }

  // ---- event handlers ----------------------------------------------------------

  private readonly handleMutations = (records: MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === "attributes") {
        this.handleAttributeChange(record.target as Element);
        continue;
      }
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) this.scan(node);
      });
      record.removedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) this.handleRemovedSubtree(node as Element);
      });
    }
  };

  private handleAttributeChange(target: Element): void {
    if (isMedia(target)) {
      if (this.tracked.has(target)) this.delegate.onSourceChanged(target);
      return;
    }
    if (target instanceof HTMLSourceElement) {
      const parent = target.parentElement;
      const media = parent instanceof HTMLPictureElement ? parent.querySelector("img") : parent;
      if (media && isMedia(media) && this.tracked.has(media)) this.delegate.onSourceChanged(media);
    }
  }

  private readonly handleResourceEvent = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLImageElement) {
      if (!this.tracked.has(target)) return;
      if (event.type === "load") this.delegate.onImageLoaded(target);
      else this.delegate.onImageError(target);
    } else if (target instanceof HTMLVideoElement && event.type === "error") {
      if (this.tracked.has(target)) this.delegate.onVideoEvent(target, "error");
    }
  };

  private readonly handleVideoEvent = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLVideoElement && this.tracked.has(target)) {
      this.delegate.onVideoEvent(target, event.type);
    }
  };
}
