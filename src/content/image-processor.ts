import { DetectPriority, type DetectSource, type Detection } from "../shared/messages";
import { errorMessage, log } from "../shared/log";
import { captureSource } from "./capture";
import { EngineClient, EngineClientError } from "./engine-client";
import type { Size } from "./geometry";
import {
  canReadImagePixels,
  isInViewport,
  isRenderedTooSmall,
  isVectorSource,
  setMediaState,
  toNormalizedBoxes,
} from "./media-state";
import type { Overlay } from "./overlay";
import type { SettingsStore } from "./settings-store";

/** Longest side of the capture sent to the engine (the model itself works at 300px). */
const CAPTURE_SIDE = 480;
const MAX_TRANSIENT_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const RESULT_CACHE_LIMIT = 300;

type Status = "idle" | "pending" | "done" | "skipped" | "failed";

interface ImageRecord {
  el: HTMLImageElement;
  near: boolean;
  status: Status;
  /** Source URL the current status refers to. */
  source: string | null;
  raw: Detection[] | null;
  analysed: Size | null;
  controller: AbortController | null;
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Set when `failed` was caused by something that may resolve itself (engine down). */
  failedTransiently: boolean;
}

interface CachedResult {
  raw: Detection[];
  analysed: Size;
}

function currentSource(image: HTMLImageElement): string | null {
  return image.currentSrc || image.src || null;
}

export class ImageProcessor {
  private readonly records = new Map<HTMLImageElement, ImageRecord>();
  /** Raw results per URL so repeated images (avatars, thumbnails) are analysed once. */
  private readonly cache = new Map<string, CachedResult>();

  constructor(
    private readonly engine: EngineClient,
    private readonly overlay: Overlay,
    private readonly settings: SettingsStore,
  ) {}

  add(image: HTMLImageElement): void {
    if (this.records.has(image)) return;
    this.records.set(image, {
      el: image,
      near: false,
      status: "idle",
      source: null,
      raw: null,
      analysed: null,
      controller: null,
      attempts: 0,
      retryTimer: null,
      failedTransiently: false,
    });
    // Whatever a previous incarnation left behind is unverified.
    setMediaState(image, null);
  }

  remove(image: HTMLImageElement): void {
    const record = this.records.get(image);
    if (!record) return;
    this.cancel(record);
    this.overlay.remove(image);
    this.records.delete(image);
  }

  /** Detaches from every image, leaving the page as if the extension were not there. */
  clear(): void {
    for (const image of Array.from(this.records.keys())) {
      this.remove(image);
      setMediaState(image, null);
    }
  }

  setNear(image: HTMLImageElement, near: boolean): void {
    const record = this.records.get(image);
    if (!record) return;
    record.near = near;
    this.overlay.setVisible(image, near);
    if (near) this.evaluate(record);
    else if (record.status === "pending") {
      // Not worth finishing while off-screen; it will be re-requested when it comes back.
      this.cancel(record);
      record.status = "idle";
    }
  }

  sourceChanged(image: HTMLImageElement): void {
    const record = this.records.get(image);
    if (!record) return;
    // Pages often re-assign an identical src; only blur right away when it really differs.
    const likelySame = record.source !== null && currentSource(image) === record.source;
    if (!likelySame) this.invalidate(record);
    // currentSrc (srcset/<source> selection) updates asynchronously; confirm shortly after.
    setTimeout(() => {
      if (!this.records.has(image)) return;
      if (currentSource(image) !== record.source) this.invalidate(record);
      this.evaluate(record);
    }, 0);
  }

  loaded(image: HTMLImageElement): void {
    const record = this.records.get(image);
    if (record) this.evaluate(record);
  }

  errored(image: HTMLImageElement): void {
    const record = this.records.get(image);
    if (!record) return;
    // A broken image paints nothing but alt text.
    this.cancel(record);
    this.finish(record, currentSource(image), "skipped");
  }

  resized(image: HTMLImageElement): void {
    const record = this.records.get(image);
    if (!record) return;
    this.overlay.invalidate(image);
    if (record.status === "skipped") this.evaluate(record);
  }

  settingsChanged(): void {
    for (const record of this.records.values()) {
      if (record.status === "done") this.apply(record);
      else if (record.status === "skipped") this.evaluate(record);
    }
  }

  /** Called when the engine (re)connects; gives up-for-now images another chance. */
  retryTransientFailures(): void {
    for (const record of this.records.values()) {
      if (record.status === "failed" && record.failedTransiently) {
        record.status = "idle";
        record.attempts = 0;
        this.evaluate(record);
      }
    }
  }

  // ---- pipeline -----------------------------------------------------------------

  private evaluate(record: ImageRecord): void {
    const image = record.el;
    if (!record.near || !image.isConnected) return;

    const source = currentSource(image);
    if (record.source === source && record.status !== "idle") {
      if (record.status === "skipped" && !this.shouldSkip(image)) {
        record.status = "idle";
      } else {
        return;
      }
    } else if (record.status !== "idle") {
      this.invalidate(record);
    }

    if (record.retryTimer !== null) return;
    if (!source) {
      if (image.complete) this.finish(record, source, "skipped");
      return;
    }
    if (!image.complete) return; // the load event will bring us back
    if (image.naturalWidth === 0 || image.naturalHeight === 0 || isVectorSource(source) || this.shouldSkip(image)) {
      this.finish(record, source, "skipped");
      return;
    }
    void this.process(record, source);
  }

  private shouldSkip(image: HTMLImageElement): boolean {
    const min = this.settings.settings.minMediaSize;
    return (
      isRenderedTooSmall(image, min) ||
      (image.naturalWidth > 0 && (image.naturalWidth < min || image.naturalHeight < min))
    );
  }

  private async process(record: ImageRecord, source: string): Promise<void> {
    const image = record.el;
    record.status = "pending";
    record.source = source;
    setMediaState(image, null);
    this.overlay.remove(image);

    const cached = source.startsWith("data:") ? undefined : this.cache.get(source);
    if (cached) {
      this.complete(record, cached.raw, cached.analysed);
      return;
    }

    const detectSource = this.buildSource(image, source);
    if (!detectSource) {
      this.finish(record, source, "failed", "pixels are not readable and the URL cannot be fetched");
      return;
    }

    const controller = new AbortController();
    record.controller = controller;
    const priority = isInViewport(image) ? DetectPriority.VisibleImage : DetectPriority.NearbyImage;
    try {
      const result = await this.engine.detect(detectSource, priority, { signal: controller.signal });
      if (record.controller !== controller) return;
      record.controller = null;
      if (currentSource(image) !== source) {
        record.status = "idle";
        this.evaluate(record);
        return;
      }
      const analysed = { width: result.width, height: result.height };
      if (!source.startsWith("data:")) this.remember(source, result.detections, analysed);
      this.complete(record, result.detections, analysed);
    } catch (error) {
      if (record.controller !== controller) return;
      record.controller = null;
      this.handleFailure(record, source, error);
    }
  }

  private complete(record: ImageRecord, raw: Detection[], analysed: Size): void {
    record.raw = raw;
    record.analysed = analysed;
    record.status = "done";
    record.attempts = 0;
    record.failedTransiently = false;
    this.apply(record);
  }

  private handleFailure(record: ImageRecord, source: string, error: unknown): void {
    const clientError =
      error instanceof EngineClientError ? error : new EngineClientError("internal", errorMessage(error));
    if (clientError.code === "aborted") {
      record.status = "idle";
      return;
    }
    if (clientError.code === "unsupported") {
      this.finish(record, source, "skipped");
      return;
    }
    if (clientError.transient && record.attempts < MAX_TRANSIENT_ATTEMPTS) {
      record.attempts++;
      record.status = "idle";
      const delay = RETRY_BASE_MS * 2 ** (record.attempts - 1);
      record.retryTimer = setTimeout(() => {
        record.retryTimer = null;
        this.evaluate(record);
      }, delay);
      return;
    }
    record.failedTransiently = clientError.transient;
    this.finish(record, source, "failed", clientError.message);
  }

  private finish(record: ImageRecord, source: string | null, status: "skipped" | "failed", reason?: string): void {
    record.source = source;
    record.status = status;
    record.raw = null;
    record.analysed = null;
    this.overlay.remove(record.el);
    setMediaState(record.el, status);
    if (status === "failed") log.debug("Image could not be analysed:", reason, source);
  }

  private apply(record: ImageRecord): void {
    if (!record.raw || !record.analysed) return;
    const image = record.el;
    const boxes = toNormalizedBoxes(record.raw, record.analysed, this.settings.settings);
    if (boxes.length > 0) {
      this.overlay.setBoxes(image, boxes, { width: image.naturalWidth, height: image.naturalHeight });
      this.overlay.setVisible(image, record.near);
      setMediaState(image, "censored");
    } else {
      this.overlay.remove(image);
      setMediaState(image, "clean");
    }
  }

  private buildSource(image: HTMLImageElement, source: string): DetectSource | null {
    if (canReadImagePixels(image, source)) {
      const capture = captureSource(image, image.naturalWidth, image.naturalHeight, CAPTURE_SIDE);
      if (capture !== "tainted" && capture !== "empty") return { kind: "data", dataUrl: capture.dataUrl };
    }
    return /^https?:/i.test(source) ? { kind: "url", url: source } : null;
  }

  private remember(source: string, raw: Detection[], analysed: Size): void {
    if (this.cache.size >= RESULT_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(source, { raw, analysed });
  }

  private invalidate(record: ImageRecord): void {
    this.cancel(record);
    record.status = "idle";
    record.source = null;
    record.raw = null;
    record.analysed = null;
    record.attempts = 0;
    record.failedTransiently = false;
    this.overlay.remove(record.el);
    setMediaState(record.el, null);
  }

  private cancel(record: ImageRecord): void {
    if (record.controller) {
      record.controller.abort();
      record.controller = null;
    }
    if (record.retryTimer !== null) {
      clearTimeout(record.retryTimer);
      record.retryTimer = null;
    }
  }
}
