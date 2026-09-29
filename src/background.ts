import {
  ENGINE_DOCUMENT_PATH,
  type EngineEnsureResponse,
  type EnginePong,
  type EngineStatusResponse,
  type RuntimeMessage,
} from "./shared/messages";
import { loadSettings, onSettingsChanged, saveSettings, type Settings } from "./shared/settings";
import { errorMessage, log, setDebugLogging } from "./shared/log";

const ENGINE_URL = chrome.runtime.getURL(ENGINE_DOCUMENT_PATH);
const ENGINE_STARTUP_TIMEOUT_MS = 15_000;
const ENGINE_PING_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Engine (offscreen document) lifecycle
// ---------------------------------------------------------------------------

let engineCreation: Promise<void> | null = null;

async function hasEngineDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [ENGINE_URL],
  });
  return contexts.length > 0;
}

async function pingEngine(): Promise<EnginePong | null> {
  try {
    const response = await chrome.runtime.sendMessage<RuntimeMessage, EnginePong | undefined>({
      type: "engine:ping",
    });
    return response && response.type === "engine:pong" ? response : null;
  } catch {
    // "Receiving end does not exist" until the document has registered its listener.
    return null;
  }
}

async function waitForEngine(): Promise<void> {
  const deadline = Date.now() + ENGINE_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingEngine()) return;
    await sleep(ENGINE_PING_INTERVAL_MS);
  }
  throw new Error("The inference engine did not start in time.");
}

let debugLogging = false;

async function configureEngine(): Promise<void> {
  try {
    await chrome.runtime.sendMessage<RuntimeMessage>({ type: "engine:configure", debug: debugLogging });
  } catch {
    // No engine document is listening; it will be configured when it starts.
  }
}

/** Creates the offscreen engine document if needed and resolves once it answers pings. */
function ensureEngine(): Promise<void> {
  if (engineCreation) return engineCreation;
  engineCreation = (async () => {
    if (!(await hasEngineDocument())) {
      try {
        await chrome.offscreen.createDocument({
          url: ENGINE_DOCUMENT_PATH,
          reasons: ["BLOBS"],
          justification:
            "Runs the on-device object detection model that analyses images and video frames for every tab.",
        });
      } catch (error) {
        // Creation can race with another caller; only fail if the document is still missing.
        if (!(await hasEngineDocument())) throw error;
      }
      await waitForEngine();
      await configureEngine();
    } else {
      await waitForEngine();
    }
  })().finally(() => {
    engineCreation = null;
  });
  return engineCreation;
}

async function closeEngine(reason: string): Promise<void> {
  if (!(await hasEngineDocument())) return;
  log.debug("Closing engine document:", reason);
  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    log.warn("Failed to close engine document:", errorMessage(error));
  }
}

async function getEngineStatus(): Promise<EngineStatusResponse> {
  const running = await hasEngineDocument();
  const pong = running ? await pingEngine() : null;
  return {
    running,
    ready: pong?.ready ?? false,
    backend: pong?.backend ?? null,
    error: pong?.error ?? null,
  };
}

function isFromEngine(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === ENGINE_URL;
}

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, sender, sendResponse: (response: unknown) => void) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return false;

    switch (message.type) {
      case "engine:ensure":
        ensureEngine().then(
          () => sendResponse({ ok: true } satisfies EngineEnsureResponse),
          (error) => {
            log.warn("Engine start failed:", errorMessage(error));
            sendResponse({ ok: false, error: errorMessage(error) } satisfies EngineEnsureResponse);
          },
        );
        return true;

      case "engine:status":
        getEngineStatus().then(sendResponse, (error) =>
          sendResponse({ running: false, ready: false, backend: null, error: errorMessage(error) }),
        );
        return true;

      case "engine:idle":
        if (isFromEngine(sender)) void closeEngine("idle");
        return false;

      case "engine:fatal":
        if (isFromEngine(sender)) {
          log.error("Engine reported a fatal error:", message.error);
          void closeEngine("fatal error");
        }
        return false;

      default:
        return false;
    }
  },
);

// ---------------------------------------------------------------------------
// Settings & toolbar badge
// ---------------------------------------------------------------------------

function applySettings(settings: Settings): void {
  void chrome.action.setBadgeText({ text: settings.enabled ? "" : "OFF" });
  void chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
  setDebugLogging(settings.debug);
  if (debugLogging !== settings.debug) {
    debugLogging = settings.debug;
    void configureEngine();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // Persist normalised defaults so the options page shows the effective configuration.
  saveSettings({}).then(applySettings).catch((error) => log.warn(errorMessage(error)));
});

loadSettings().then(applySettings).catch((error) => log.warn(errorMessage(error)));
onSettingsChanged(applySettings);
