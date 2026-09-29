import {
  ENGINE_PORT_NAME,
  type DetectPriority,
  type DetectErrorCode,
  type DetectSource,
  type Detection,
  type EngineClientMessage,
  type EngineEnsureResponse,
  type EngineServerMessage,
  type RuntimeMessage,
} from "../shared/messages";
import { errorMessage, log } from "../shared/log";

export interface DetectResult {
  width: number;
  height: number;
  detections: Detection[];
}

export type ClientErrorCode = DetectErrorCode | "disconnected" | "timeout" | "aborted" | "unavailable";

export class EngineClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
  ) {
    super(message);
  }

  /** Whether retrying the same request later could succeed. */
  get transient(): boolean {
    return this.code === "disconnected" || this.code === "timeout" || this.code === "model" || this.code === "internal" || this.code === "unavailable";
  }
}

interface PendingRequest {
  resolve: (result: DetectResult) => void;
  reject: (error: EngineClientError) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: (() => void) | null;
  signal: AbortSignal | undefined;
}

export interface DetectOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;

/** Returns true once the extension has been reloaded/updated and this script is orphaned. */
export function isExtensionContextInvalidated(): boolean {
  try {
    return !chrome.runtime?.id;
  } catch {
    return true;
  }
}

/**
 * Connects a content script to the shared inference engine. Handles engine
 * (re)creation via the background worker, reconnection and request bookkeeping.
 */
export class EngineClient {
  private port: chrome.runtime.Port | null = null;
  private connecting: Promise<chrome.runtime.Port> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private consecutiveConnectFailures = 0;
  private nextConnectAllowedAt = 0;
  private engineReady = false;
  private invalidated = false;

  /** Invoked when the extension context disappears (extension reloaded or removed). */
  onContextInvalidated: (() => void) | null = null;
  /** Invoked whenever the engine transitions to ready (model loaded). */
  onReady: (() => void) | null = null;

  get ready(): boolean {
    return this.engineReady && this.port !== null;
  }

  get contextInvalidated(): boolean {
    return this.invalidated;
  }

  async detect(source: DetectSource, priority: DetectPriority, options: DetectOptions = {}): Promise<DetectResult> {
    if (options.signal?.aborted) throw new EngineClientError("aborted", "Aborted before sending.");
    const port = await this.getPort();
    if (options.signal?.aborted) throw new EngineClientError("aborted", "Aborted while connecting.");

    const id = this.nextId++;
    return new Promise<DetectResult>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const entry: PendingRequest = {
        resolve,
        reject,
        signal: options.signal,
        onAbort: null,
        timer: setTimeout(() => {
          this.settle(id, new EngineClientError("timeout", `No answer within ${timeoutMs}ms.`), true);
        }, timeoutMs),
      };
      if (options.signal) {
        entry.onAbort = () => this.settle(id, new EngineClientError("aborted", "Aborted."), true);
        options.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      if (!this.post(port, { type: "detect", id, source, priority })) {
        this.settle(id, new EngineClientError("disconnected", "Engine port is not usable."));
      }
    });
  }

  disconnect(): void {
    const port = this.port;
    this.port = null;
    this.engineReady = false;
    if (port) {
      try {
        port.disconnect();
      } catch {
        // Already gone.
      }
    }
    this.rejectAll(new EngineClientError("disconnected", "Client disconnected."));
  }

  // ---- connection ---------------------------------------------------------

  private getPort(): Promise<chrome.runtime.Port> {
    if (this.port) return Promise.resolve(this.port);
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<chrome.runtime.Port> {
    if (this.invalidated) throw new EngineClientError("unavailable", "Extension context invalidated.");

    const wait = this.nextConnectAllowedAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

    try {
      const response = await chrome.runtime.sendMessage<RuntimeMessage, EngineEnsureResponse | undefined>({
        type: "engine:ensure",
      });
      if (!response?.ok) {
        throw new EngineClientError("unavailable", response?.error ?? "Engine unavailable.");
      }
      const port = chrome.runtime.connect({ name: ENGINE_PORT_NAME });
      port.onMessage.addListener((message: EngineServerMessage) => this.handleMessage(message));
      port.onDisconnect.addListener(() => this.handleDisconnect(port));
      this.port = port;
      this.consecutiveConnectFailures = 0;
      this.nextConnectAllowedAt = 0;
      return port;
    } catch (error) {
      if (isExtensionContextInvalidated() || /context invalidated/i.test(errorMessage(error))) {
        this.markInvalidated();
        throw new EngineClientError("unavailable", "Extension context invalidated.");
      }
      this.consecutiveConnectFailures++;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.consecutiveConnectFailures - 1));
      this.nextConnectAllowedAt = Date.now() + backoff;
      log.warn(`Engine connection failed (retry in ${backoff}ms):`, errorMessage(error));
      throw error instanceof EngineClientError ? error : new EngineClientError("unavailable", errorMessage(error));
    }
  }

  private handleDisconnect(port: chrome.runtime.Port): void {
    if (this.port !== port) return;
    this.port = null;
    this.engineReady = false;
    if (isExtensionContextInvalidated()) {
      this.markInvalidated();
      return;
    }
    log.debug("Engine port disconnected.");
    this.rejectAll(new EngineClientError("disconnected", "Engine disconnected."));
  }

  private markInvalidated(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.port = null;
    this.rejectAll(new EngineClientError("unavailable", "Extension context invalidated."));
    this.onContextInvalidated?.();
  }

  private post(port: chrome.runtime.Port, message: EngineClientMessage): boolean {
    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      log.debug("postMessage failed:", errorMessage(error));
      if (isExtensionContextInvalidated()) this.markInvalidated();
      return false;
    }
  }

  // ---- responses ----------------------------------------------------------

  private handleMessage(message: EngineServerMessage): void {
    switch (message.type) {
      case "status": {
        const wasReady = this.engineReady;
        this.engineReady = message.ready;
        if (message.error) log.warn("Engine reported:", message.error);
        if (message.ready && !wasReady) this.onReady?.();
        break;
      }
      case "result":
        this.settle(message.id, { width: message.width, height: message.height, detections: message.detections });
        break;
      case "error":
        this.settle(message.id, new EngineClientError(message.code, message.error));
        break;
    }
  }

  private settle(id: number, outcome: DetectResult | EngineClientError, sendCancel = false): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
    if (sendCancel && this.port) this.post(this.port, { type: "cancel", id });
    if (outcome instanceof EngineClientError) entry.reject(outcome);
    else entry.resolve(outcome);
  }

  private rejectAll(error: EngineClientError): void {
    for (const id of Array.from(this.pending.keys())) this.settle(id, error);
  }
}
