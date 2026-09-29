import type { CensorClass } from "./classes";

/** Name of the long-lived port content scripts open towards the inference engine. */
export const ENGINE_PORT_NAME = "object-censor/engine";

/** Path of the offscreen document hosting the model (relative to the extension root). */
export const ENGINE_DOCUMENT_PATH = "engine.html";

// ---- One-shot runtime messages (chrome.runtime.sendMessage) ----

export type RuntimeMessage =
  /** Content script → background: make sure the engine document exists and answers. */
  | { type: "engine:ensure" }
  /** Background/popup → engine: liveness + readiness probe. */
  | { type: "engine:ping" }
  /** Engine → background: nothing happened for a while, the document can be closed. */
  | { type: "engine:idle" }
  /** Engine → background: unrecoverable failure, close and recreate on next demand. */
  | { type: "engine:fatal"; error: string }
  /** Background → engine: runtime configuration (offscreen documents cannot read storage). */
  | { type: "engine:configure"; debug: boolean }
  /** Popup → background: report whether the engine is running. */
  | { type: "engine:status" };

export interface EnginePong {
  type: "engine:pong";
  ready: boolean;
  backend: string | null;
  error: string | null;
}

export interface EngineEnsureResponse {
  ok: boolean;
  error?: string;
}

export interface EngineStatusResponse {
  running: boolean;
  ready: boolean;
  backend: string | null;
  error: string | null;
}

// ---- Port protocol (content script ⇄ engine) ----

export type DetectSource =
  /** A downscaled capture of the media, encoded by the content script. */
  | { kind: "data"; dataUrl: string }
  /** A URL the engine fetches itself (cross-origin images the page cannot read). */
  | { kind: "url"; url: string };

/** Lower number = processed first. */
export const DetectPriority = {
  VideoFrame: 0,
  VisibleImage: 1,
  NearbyImage: 2,
} as const;
export type DetectPriority = (typeof DetectPriority)[keyof typeof DetectPriority];

export interface DetectRequest {
  type: "detect";
  id: number;
  source: DetectSource;
  priority: DetectPriority;
}

export interface CancelRequest {
  type: "cancel";
  id: number;
}

export type EngineClientMessage = DetectRequest | CancelRequest;

export interface Detection {
  class: CensorClass;
  score: number;
  /** [x, y, width, height] in pixels of the analysed bitmap. */
  box: [number, number, number, number];
}

export type DetectErrorCode =
  /** The URL could not be fetched (network, HTTP error, blocked). */
  | "fetch"
  /** The bytes could not be decoded as a raster image. */
  | "decode"
  /** Vector graphics or other media the engine deliberately does not analyse. */
  | "unsupported"
  /** The model failed to load or run. */
  | "model"
  | "internal";

export type EngineServerMessage =
  | {
      type: "result";
      id: number;
      /** Size of the analysed bitmap; box coordinates are relative to it. */
      width: number;
      height: number;
      detections: Detection[];
    }
  | { type: "error"; id: number; code: DetectErrorCode; error: string }
  | { type: "status"; ready: boolean; backend: string | null; error: string | null };
