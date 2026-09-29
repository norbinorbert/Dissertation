/**
 * Inference engine. Runs inside the extension's offscreen document and serves every
 * content script (all tabs, all frames) over runtime ports, so the model is loaded once.
 *
 * Only `chrome.runtime` is available in offscreen documents; settings arrive via messages.
 */
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import { isCensorClass } from "../shared/classes";
import {
  DetectPriority,
  ENGINE_PORT_NAME,
  type DetectErrorCode,
  type DetectRequest,
  type Detection,
  type EngineClientMessage,
  type EnginePong,
  type EngineServerMessage,
  type RuntimeMessage,
} from "../shared/messages";
import { MIN_SCORE_FLOOR } from "../shared/settings";
import { errorMessage, log, setDebugLogging } from "../shared/log";

const MODEL_BASE: cocoSsd.ObjectDetectionBaseModel = "lite_mobilenet_v2";
const BUNDLED_MODEL_URL = chrome.runtime.getURL("model/model.json");
/** Longest side (px) fetched images are downscaled to before inference. */
const MAX_ANALYSIS_SIDE = 640;
const MAX_DETECTIONS = 20;
const FETCH_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;
/** Consecutive model failures before the document asks to be recreated. */
const FATAL_FAILURE_THRESHOLD = 3;

class DetectError extends Error {
  constructor(
    readonly code: DetectErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Job {
  port: chrome.runtime.Port;
  request: DetectRequest;
}

interface DecodedSource {
  element: HTMLImageElement | HTMLCanvasElement;
  width: number;
  height: number;
}

class Engine {
  private model: cocoSsd.ObjectDetection | null = null;
  private loading: Promise<void> | null = null;
  private loadError: string | null = null;
  private backend: string | null = null;

  private readonly ports = new Set<chrome.runtime.Port>();
  private readonly queue: Job[] = [];
  private draining = false;
  private lastJobWasVideo = false;
  private consecutiveFailures = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly canvas = document.createElement("canvas");
  private readonly ctx = this.canvas.getContext("2d", { willReadFrequently: false })!;

  constructor() {
    this.scheduleIdleCheck();
    void this.ensureModel();
  }

  // ---- model -------------------------------------------------------------

  private ensureModel(): Promise<void> {
    if (this.model) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = this.loadModel()
      .then((model) => {
        this.model = model;
        this.loadError = null;
        log.info(`Model ready (${this.backend} backend)`);
        this.broadcastStatus();
      })
      .catch((error) => {
        this.loadError = errorMessage(error);
        log.error("Model failed to load:", this.loadError);
        this.broadcastStatus();
        throw error;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async loadModel(): Promise<cocoSsd.ObjectDetection> {
    tf.enableProdMode();
    await this.selectBackend();
    try {
      return await cocoSsd.load({ base: MODEL_BASE, modelUrl: BUNDLED_MODEL_URL });
    } catch (error) {
      log.warn("Bundled model unavailable, loading from the network:", errorMessage(error));
      return cocoSsd.load({ base: MODEL_BASE });
    }
  }

  private async selectBackend(): Promise<void> {
    for (const name of ["webgl", "cpu"]) {
      try {
        if (!(await tf.setBackend(name))) continue;
        await tf.ready();
        if (name === "webgl") {
          // Hidden documents may get their timers throttled; force synchronous GPU
          // readback instead of setTimeout-based fence polling.
          tf.env().set("WEBGL_FENCE_API_ENABLED", false);
          tf.env().set("WEBGL_DISJOINT_QUERY_TIMER_EXTENSION_VERSION", 0);
        }
        this.backend = name;
        return;
      } catch (error) {
        log.warn(`Backend "${name}" unavailable:`, errorMessage(error));
      }
    }
    throw new Error("No usable TensorFlow.js backend.");
  }

  // ---- ports -------------------------------------------------------------

  addPort(port: chrome.runtime.Port): void {
    this.ports.add(port);
    port.onMessage.addListener((message: EngineClientMessage) => this.handleMessage(port, message));
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].port === port) this.queue.splice(i, 1);
      }
    });
    this.send(port, this.statusMessage());
    void this.ensureModel().catch(() => undefined);
  }

  private handleMessage(port: chrome.runtime.Port, message: EngineClientMessage): void {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "detect":
        this.queue.push({ port, request: message });
        this.touch();
        void this.drain();
        break;
      case "cancel": {
        const index = this.queue.findIndex(
          (job) => job.port === port && job.request.id === message.id,
        );
        if (index !== -1) this.queue.splice(index, 1);
        break;
      }
    }
  }

  private send(port: chrome.runtime.Port, message: EngineServerMessage): void {
    try {
      port.postMessage(message);
    } catch {
      // The port went away; its disconnect handler cleans up.
    }
  }

  private statusMessage(): EngineServerMessage {
    return { type: "status", ready: this.model !== null, backend: this.backend, error: this.loadError };
  }

  private broadcastStatus(): void {
    const message = this.statusMessage();
    for (const port of this.ports) this.send(port, message);
  }

  pong(): EnginePong {
    return { type: "engine:pong", ready: this.model !== null, backend: this.backend, error: this.loadError };
  }

  // ---- scheduling --------------------------------------------------------

  /** Lowest priority value first, but alternate between video frames and images so neither starves. */
  private takeNextJob(): Job {
    const isVideoJob = (job: Job) => job.request.priority === DetectPriority.VideoFrame;
    const preferImages = this.lastJobWasVideo && this.queue.some((job) => !isVideoJob(job));
    let bestIndex = -1;
    let bestPriority = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i];
      if (preferImages && isVideoJob(job)) continue;
      if (job.request.priority < bestPriority) {
        bestPriority = job.request.priority;
        bestIndex = i;
      }
    }
    const [job] = this.queue.splice(bestIndex, 1);
    this.lastJobWasVideo = isVideoJob(job);
    return job;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        await this.process(this.takeNextJob());
      }
    } finally {
      this.draining = false;
      this.scheduleIdleCheck();
    }
  }

  private async process({ port, request }: Job): Promise<void> {
    try {
      await this.ensureModel().catch((error) => {
        throw new DetectError("model", errorMessage(error));
      });
      const source = await this.decode(request);
      const started = performance.now();
      const predictions = await this.model!.detect(source.element, MAX_DETECTIONS, MIN_SCORE_FLOOR);
      const detections: Detection[] = [];
      for (const prediction of predictions) {
        if (!isCensorClass(prediction.class)) continue;
        detections.push({ class: prediction.class, score: prediction.score, box: prediction.bbox });
      }
      this.consecutiveFailures = 0;
      log.debug(
        `detect #${request.id}: ${detections.length} hit(s) in ${Math.round(performance.now() - started)}ms, tensors=${tf.memory().numTensors}`,
      );
      this.send(port, {
        type: "result",
        id: request.id,
        width: source.width,
        height: source.height,
        detections,
      });
    } catch (error) {
      const code = error instanceof DetectError ? error.code : "internal";
      if (code === "internal" || code === "model") {
        this.consecutiveFailures++;
        log.warn(`detect #${request.id} failed:`, errorMessage(error));
        if (this.consecutiveFailures >= FATAL_FAILURE_THRESHOLD) {
          void chrome.runtime.sendMessage<RuntimeMessage>({ type: "engine:fatal", error: errorMessage(error) });
        }
      }
      this.send(port, { type: "error", id: request.id, code, error: errorMessage(error) });
    }
  }

  // ---- decoding ----------------------------------------------------------

  private async decode(request: DetectRequest): Promise<DecodedSource> {
    const { source } = request;
    if (source.kind === "data") {
      const image = new Image();
      image.src = source.dataUrl;
      try {
        await image.decode();
      } catch {
        throw new DetectError("decode", "Capture could not be decoded.");
      }
      if (!image.naturalWidth || !image.naturalHeight) {
        throw new DetectError("decode", "Capture has no pixels.");
      }
      return { element: image, width: image.naturalWidth, height: image.naturalHeight };
    }

    const blob = await this.fetchImage(source.url);
    const type = blob.type.toLowerCase();
    if (type === "image/svg+xml") {
      throw new DetectError("unsupported", "Vector graphics are not analysed.");
    }
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      throw new DetectError("decode", `Response (${type || "unknown type"}) is not a decodable image.`);
    }
    try {
      const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      this.canvas.width = width;
      this.canvas.height = height;
      this.ctx.drawImage(bitmap, 0, 0, width, height);
      return { element: this.canvas, width, height };
    } finally {
      bitmap.close();
    }
  }

  private async fetchImage(url: string): Promise<Blob> {
    if (!/^https?:/i.test(url)) {
      throw new DetectError("unsupported", "Only http(s) URLs can be fetched by the engine.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) throw new DetectError("fetch", `HTTP ${response.status}`);
      return await response.blob();
    } catch (error) {
      if (error instanceof DetectError) throw error;
      throw new DetectError("fetch", errorMessage(error));
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- idle handling -----------------------------------------------------

  private touch(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleCheck(): void {
    this.touch();
    this.idleTimer = setTimeout(() => {
      if (this.queue.length === 0 && !this.draining) {
        log.debug("Idle; asking the background worker to close the engine.");
        void chrome.runtime.sendMessage<RuntimeMessage>({ type: "engine:idle" });
      }
    }, IDLE_TIMEOUT_MS);
  }
}

const engine = new Engine();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === ENGINE_PORT_NAME) engine.addPort(port);
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return false;
  switch (message.type) {
    case "engine:ping":
      sendResponse(engine.pong());
      return false;
    case "engine:configure":
      setDebugLogging(message.debug);
      return false;
    default:
      return false;
  }
});
