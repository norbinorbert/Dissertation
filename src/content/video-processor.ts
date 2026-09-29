import { DetectPriority, type DetectSource, type Detection } from "../shared/messages";
import { errorMessage, log } from "../shared/log";
import { captureSource, loadImage } from "./capture";
import { EngineClient, EngineClientError, type DetectResult } from "./engine-client";
import type { NormalizedBox, Size } from "./geometry";
import { isInViewport, isRenderedTooSmall, isVectorSource, setMediaState, toNormalizedBoxes } from "./media-state";
import type { Overlay } from "./overlay";
import type { SettingsStore } from "./settings-store";

/** Longest side of a captured frame (the model works at 300px). */
const FRAME_CAPTURE_SIDE = 320;
const FRAME_TIMEOUT_MS = 8000;
/** Boxes from results within this window are merged, smoothing detector flicker. */
const RESULT_HOLD_MS = 600;
/** A playing video is re-blurred when no result arrived for this long. */
const STALE_MS = 2000;
/** Extra box padding for moving content (fraction of box size). */
const MOTION_PAD_RATIO = 0.06;
const MAX_TRANSIENT_BACKOFF_MS = 5000;

type Mode = "idle" | "poster" | "frames" | "skipped" | "failed";

interface FrameResult {
  at: number;
  raw: Detection[];
  analysed: Size;
}

interface VideoRecord {
  el: HTMLVideoElement;
  near: boolean;
  mode: Mode;
  /** Once a frame has been presented the poster image is no longer what the user sees. */
  hasPresentedFrame: boolean;
  posterSource: string | null;
  posterResult: FrameResult | null;
  posterController: AbortController | null;
  frameController: AbortController | null;
  inFlight: boolean;
  stillPending: boolean;
  loopHandle: number | null;
  loopIsVideoCallback: boolean;
  results: FrameResult[];
  lastResultAt: number;
  staleTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  transientFailures: number;
  corsRetried: boolean;
  reloading: boolean;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function isPlaying(video: HTMLVideoElement): boolean {
  return !video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

export class VideoProcessor {
  private readonly records = new Map<HTMLVideoElement, VideoRecord>();

  constructor(
    private readonly engine: EngineClient,
    private readonly overlay: Overlay,
    private readonly settings: SettingsStore,
  ) {}

  add(video: HTMLVideoElement): void {
    if (this.records.has(video)) return;
    const record: VideoRecord = {
      el: video,
      near: false,
      mode: "idle",
      hasPresentedFrame: video.currentTime > 0 || !video.paused || video.played.length > 0,
      posterSource: null,
      posterResult: null,
      posterController: null,
      frameController: null,
      inFlight: false,
      stillPending: false,
      loopHandle: null,
      loopIsVideoCallback: false,
      results: [],
      lastResultAt: 0,
      staleTimer: null,
      retryTimer: null,
      transientFailures: 0,
      corsRetried: false,
      reloading: false,
    };
    this.records.set(video, record);
    setMediaState(video, null);
  }

  remove(video: HTMLVideoElement): void {
    const record = this.records.get(video);
    if (!record) return;
    this.stopAll(record);
    this.overlay.remove(video);
    this.records.delete(video);
  }

  clear(): void {
    for (const video of Array.from(this.records.keys())) {
      this.remove(video);
      setMediaState(video, null);
    }
  }

  setNear(video: HTMLVideoElement, near: boolean): void {
    const record = this.records.get(video);
    if (!record) return;
    record.near = near;
    this.overlay.setVisible(video, near);
    if (near) {
      // Whatever was detected while off-screen no longer describes the current frame.
      if (record.mode === "frames" && isPlaying(video) && performance.now() - record.lastResultAt > STALE_MS) {
        this.markStale(record);
      }
      this.evaluate(record);
    } else {
      this.stopLoop(record);
    }
  }

  sourceChanged(video: HTMLVideoElement): void {
    const record = this.records.get(video);
    if (!record || record.reloading) return;
    // A changed media source reloads the element and surfaces as emptied/loadedmetadata
    // events; only the poster needs attribute-level handling.
    setTimeout(() => {
      if (!this.records.has(video) || record.reloading) return;
      if (record.mode === "poster" && video.poster !== record.posterSource) this.reset(record);
      this.evaluate(record);
    }, 0);
  }

  resized(video: HTMLVideoElement): void {
    const record = this.records.get(video);
    if (!record) return;
    this.overlay.invalidate(video);
    if (record.mode === "skipped") this.evaluate(record);
  }

  settingsChanged(): void {
    for (const record of this.records.values()) {
      if (record.mode === "frames") this.applyFrames(record);
      else if (record.mode === "poster") this.applyPoster(record);
      else if (record.mode === "skipped") this.evaluate(record);
    }
  }

  retryTransientFailures(): void {
    for (const record of this.records.values()) {
      if (record.mode === "frames" || record.mode === "poster") {
        record.transientFailures = 0;
        this.evaluate(record);
      }
    }
  }

  handleEvent(video: HTMLVideoElement, type: string): void {
    const record = this.records.get(video);
    if (!record) return;
    switch (type) {
      case "emptied":
        if (!record.reloading) {
          this.reset(record);
          this.evaluate(record);
        }
        break;
      case "loadedmetadata":
      case "resize":
        if (video.videoWidth && video.videoHeight && record.mode === "frames") {
          this.overlay.setIntrinsic(video, { width: video.videoWidth, height: video.videoHeight });
        }
        this.evaluate(record);
        break;
      case "playing":
      case "timeupdate":
        if (video.currentTime > 0 || !video.paused) record.hasPresentedFrame = true;
        this.evaluate(record);
        break;
      case "seeking":
        record.hasPresentedFrame = true;
        if (record.mode === "frames") this.markStale(record);
        break;
      case "encrypted":
        this.fail(record, "DRM protected media cannot be analysed");
        break;
      case "error":
        // Errors during our own CORS reload are handled by the reload logic.
        break;
      default:
        // loadeddata, play, pause, seeked, ended
        this.evaluate(record);
        break;
    }
  }

  // ---- decision logic ----------------------------------------------------------------

  private evaluate(record: VideoRecord): void {
    const video = record.el;
    if (!record.near || !video.isConnected || record.reloading || record.retryTimer !== null) return;
    if (record.mode === "failed") return;

    if (video.mediaKeys) {
      this.fail(record, "DRM protected media cannot be analysed");
      return;
    }
    if (isRenderedTooSmall(video, this.settings.settings.minMediaSize)) {
      if (record.mode !== "skipped") {
        this.stopAll(record);
        this.overlay.remove(video);
        record.mode = "skipped";
        setMediaState(video, "skipped");
      }
      return;
    }
    if (record.mode === "skipped") record.mode = "idle";

    if (this.isShowingPoster(record)) {
      void this.processPoster(record);
      return;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      // Nothing is painted yet (or only a poster that is gone); stay blurred until data arrives.
      return;
    }

    this.enterFramesMode(record);
    if (isPlaying(video)) this.startLoop(record);
    else this.requestStillFrame(record);
  }

  private isShowingPoster(record: VideoRecord): boolean {
    const video = record.el;
    return Boolean(video.poster) && !record.hasPresentedFrame && video.paused && video.currentTime === 0;
  }

  private enterFramesMode(record: VideoRecord): void {
    if (record.mode === "frames") return;
    this.cancelPoster(record);
    record.mode = "frames";
    record.results = [];
    record.lastResultAt = 0;
    this.overlay.remove(record.el);
    setMediaState(record.el, null);
  }

  // ---- frame loop ----------------------------------------------------------------------

  private startLoop(record: VideoRecord): void {
    if (record.loopHandle !== null) return;
    this.scheduleStep(record);
  }

  private scheduleStep(record: VideoRecord): void {
    const video = record.el as VideoWithFrameCallback;
    if (typeof video.requestVideoFrameCallback === "function") {
      record.loopIsVideoCallback = true;
      record.loopHandle = video.requestVideoFrameCallback(() => this.step(record));
    } else {
      record.loopIsVideoCallback = false;
      record.loopHandle = requestAnimationFrame(() => this.step(record));
    }
  }

  private step(record: VideoRecord): void {
    record.loopHandle = null;
    const video = record.el;
    if (!record.near || !video.isConnected || record.mode !== "frames" || !isPlaying(video)) return;
    if (!record.inFlight && record.retryTimer === null) void this.detectFrame(record);
    this.scheduleStep(record);
  }

  private stopLoop(record: VideoRecord): void {
    if (record.loopHandle === null) return;
    const video = record.el as VideoWithFrameCallback;
    if (record.loopIsVideoCallback && typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(record.loopHandle);
    } else {
      cancelAnimationFrame(record.loopHandle);
    }
    record.loopHandle = null;
  }

  private requestStillFrame(record: VideoRecord): void {
    if (record.inFlight) record.stillPending = true;
    else void this.detectFrame(record);
  }

  private async detectFrame(record: VideoRecord): Promise<void> {
    const video = record.el;
    const capture = captureSource(video, video.videoWidth, video.videoHeight, FRAME_CAPTURE_SIDE);
    if (capture === "empty") return;
    if (capture === "tainted") {
      this.handleTaintedVideo(record);
      return;
    }

    const controller = new AbortController();
    record.frameController = controller;
    record.inFlight = true;
    try {
      const result = await this.engine.detect({ kind: "data", dataUrl: capture.dataUrl }, DetectPriority.VideoFrame, {
        signal: controller.signal,
        timeoutMs: FRAME_TIMEOUT_MS,
      });
      if (record.frameController !== controller) return;
      record.transientFailures = 0;
      this.pushFrameResult(record, result);
    } catch (error) {
      if (record.frameController !== controller) return;
      this.handleFrameFailure(record, error);
    } finally {
      if (record.frameController === controller) {
        record.frameController = null;
        record.inFlight = false;
        if (record.stillPending) {
          record.stillPending = false;
          if (record.mode === "frames" && !isPlaying(video)) void this.detectFrame(record);
        }
      }
    }
  }

  private pushFrameResult(record: VideoRecord, result: DetectResult): void {
    const now = performance.now();
    record.results.push({ at: now, raw: result.detections, analysed: { width: result.width, height: result.height } });
    record.lastResultAt = now;
    this.applyFrames(record);
    this.armStaleTimer(record);
  }

  private applyFrames(record: VideoRecord): void {
    if (record.mode !== "frames" || record.results.length === 0) return;
    const now = performance.now();
    const latest = record.results[record.results.length - 1];
    // Keep the newest result even when old: a paused frame does not change.
    record.results = record.results.filter((result) => result === latest || now - result.at <= RESULT_HOLD_MS);
    const boxes: NormalizedBox[] = [];
    for (const result of record.results) {
      boxes.push(...toNormalizedBoxes(result.raw, result.analysed, this.settings.settings));
    }
    this.showBoxes(record, boxes, this.intrinsicSize(record), MOTION_PAD_RATIO);
  }

  private handleFrameFailure(record: VideoRecord, error: unknown): void {
    const clientError =
      error instanceof EngineClientError ? error : new EngineClientError("internal", errorMessage(error));
    if (clientError.code === "aborted") return;
    if (!clientError.transient) {
      this.fail(record, clientError.message);
      return;
    }
    record.transientFailures++;
    const delay = Math.min(MAX_TRANSIENT_BACKOFF_MS, 500 * 2 ** (record.transientFailures - 1));
    log.debug(`Video frame analysis failed (${clientError.code}); retrying in ${delay}ms`);
    record.retryTimer = setTimeout(() => {
      record.retryTimer = null;
      this.evaluate(record);
    }, delay);
  }

  private armStaleTimer(record: VideoRecord): void {
    if (record.staleTimer !== null) clearTimeout(record.staleTimer);
    record.staleTimer = setTimeout(() => {
      record.staleTimer = null;
      if (record.mode === "frames" && isPlaying(record.el) && performance.now() - record.lastResultAt >= STALE_MS) {
        this.markStale(record);
      }
    }, STALE_MS + 50);
  }

  /** The visible frame is no longer covered by a recent result: hide the video again. */
  private markStale(record: VideoRecord): void {
    record.results = [];
    this.overlay.remove(record.el);
    setMediaState(record.el, null);
  }

  // ---- poster --------------------------------------------------------------------------

  private async processPoster(record: VideoRecord): Promise<void> {
    const video = record.el;
    const poster = video.poster;
    if (record.mode === "poster" && record.posterSource === poster && (record.posterResult || record.posterController)) {
      return;
    }
    this.stopLoop(record);
    this.cancelFrame(record);
    this.cancelPoster(record);
    record.mode = "poster";
    record.posterSource = poster;
    record.posterResult = null;
    record.results = [];
    this.overlay.remove(video);
    setMediaState(video, null);

    if (isVectorSource(poster)) {
      setMediaState(video, "clean");
      return;
    }

    const controller = new AbortController();
    record.posterController = controller;
    try {
      const source = await this.posterSource(poster);
      if (record.posterController !== controller) return;
      const priority = isInViewport(video) ? DetectPriority.VisibleImage : DetectPriority.NearbyImage;
      const result = await this.engine.detect(source, priority, { signal: controller.signal });
      if (record.posterController !== controller) return;
      record.posterResult = {
        at: performance.now(),
        raw: result.detections,
        analysed: { width: result.width, height: result.height },
      };
      this.applyPoster(record);
    } catch (error) {
      if (record.posterController !== controller) return;
      const clientError =
        error instanceof EngineClientError ? error : new EngineClientError("internal", errorMessage(error));
      if (clientError.code === "aborted") return;
      if (clientError.code === "unsupported") {
        setMediaState(video, "clean");
      } else if (clientError.transient) {
        record.transientFailures++;
        const delay = Math.min(MAX_TRANSIENT_BACKOFF_MS, 500 * 2 ** (record.transientFailures - 1));
        record.retryTimer = setTimeout(() => {
          record.retryTimer = null;
          record.mode = "idle";
          this.evaluate(record);
        }, delay);
      } else {
        this.fail(record, `poster could not be analysed: ${clientError.message}`);
      }
    } finally {
      if (record.posterController === controller) record.posterController = null;
    }
  }

  private async posterSource(poster: string): Promise<DetectSource> {
    if (/^https?:/i.test(poster)) return { kind: "url", url: poster };
    // data:/blob: posters can only be read from inside the page.
    const image = await loadImage(poster);
    const capture = captureSource(image, image.naturalWidth, image.naturalHeight, 480);
    if (capture === "tainted" || capture === "empty") throw new EngineClientError("decode", "Poster is not readable.");
    return { kind: "data", dataUrl: capture.dataUrl };
  }

  private applyPoster(record: VideoRecord): void {
    if (record.mode !== "poster" || !record.posterResult) return;
    const boxes = toNormalizedBoxes(record.posterResult.raw, record.posterResult.analysed, this.settings.settings);
    this.showBoxes(record, boxes, record.posterResult.analysed, 0);
  }

  // ---- shared helpers --------------------------------------------------------------------

  private showBoxes(record: VideoRecord, boxes: NormalizedBox[], intrinsic: Size, extraPad: number): void {
    const video = record.el;
    if (boxes.length > 0) {
      this.overlay.setBoxes(video, boxes, intrinsic, extraPad);
      this.overlay.setVisible(video, record.near);
      setMediaState(video, "censored");
    } else {
      this.overlay.remove(video);
      setMediaState(video, "clean");
    }
  }

  private intrinsicSize(record: VideoRecord): Size {
    const video = record.el;
    if (video.videoWidth && video.videoHeight) return { width: video.videoWidth, height: video.videoHeight };
    const latest = record.results[record.results.length - 1];
    return latest ? latest.analysed : { width: 0, height: 0 };
  }

  private handleTaintedVideo(record: VideoRecord): void {
    const video = record.el;
    if (record.corsRetried || !this.canReloadWithCors(video)) {
      this.fail(record, "cross-origin video without CORS headers; frames are not readable");
      return;
    }
    record.corsRetried = true;
    record.reloading = true;
    this.stopLoop(record);
    const wasPlaying = !video.paused;
    const time = video.currentTime;
    const rate = video.playbackRate;

    const restore = () => {
      video.currentTime = time;
      video.playbackRate = rate;
      if (wasPlaying) video.play().catch(() => undefined);
    };
    const onLoaded = () => {
      video.removeEventListener("error", onError);
      record.reloading = false;
      restore();
      this.evaluate(record);
    };
    const onError = () => {
      // The server refused the CORS request: put the element back the way it was.
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeAttribute("crossorigin");
      video.addEventListener("loadedmetadata", restore, { once: true });
      video.load();
      record.reloading = false;
      this.fail(record, "video reload with CORS failed");
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    log.debug("Reloading video with crossorigin=anonymous to allow frame capture", video.currentSrc);
    video.crossOrigin = "anonymous";
    video.load();
  }

  private canReloadWithCors(video: HTMLVideoElement): boolean {
    return (
      /^https?:/i.test(video.currentSrc) &&
      video.crossOrigin !== "anonymous" &&
      !video.mediaKeys &&
      (video.hasAttribute("src") || video.querySelector("source") !== null)
    );
  }

  private fail(record: VideoRecord, reason: string): void {
    this.stopAll(record);
    record.mode = "failed";
    this.overlay.remove(record.el);
    setMediaState(record.el, "failed");
    log.debug("Video could not be analysed:", reason, record.el.currentSrc);
  }

  private reset(record: VideoRecord): void {
    this.stopAll(record);
    record.mode = "idle";
    record.hasPresentedFrame = false;
    record.posterSource = null;
    record.posterResult = null;
    record.results = [];
    record.lastResultAt = 0;
    record.transientFailures = 0;
    this.overlay.remove(record.el);
    setMediaState(record.el, null);
  }

  private stopAll(record: VideoRecord): void {
    this.stopLoop(record);
    this.cancelFrame(record);
    this.cancelPoster(record);
    if (record.staleTimer !== null) clearTimeout(record.staleTimer);
    record.staleTimer = null;
    if (record.retryTimer !== null) clearTimeout(record.retryTimer);
    record.retryTimer = null;
  }

  private cancelFrame(record: VideoRecord): void {
    if (record.frameController) {
      record.frameController.abort();
      record.frameController = null;
    }
    record.inFlight = false;
    record.stillPending = false;
  }

  private cancelPoster(record: VideoRecord): void {
    if (record.posterController) {
      record.posterController.abort();
      record.posterController = null;
    }
  }
}
