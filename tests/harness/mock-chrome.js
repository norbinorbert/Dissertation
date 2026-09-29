/**
 * Minimal stand-in for the chrome.* APIs used by the content script, so it can run in a
 * plain web page. The fake engine answers detect requests: square captures get one hit
 * (person, centred, half the size), anything else gets none, and URL sources fail as if
 * they could not be fetched.
 */
(() => {
  const storageListeners = new Set();
  const storage = {
    settings: {
      enabled: true,
      disabledSites: [],
      classes: { person: true, dog: true, cat: true, knife: true, bottle: true },
      minScore: 0.5,
      blurRadius: 20,
      unprocessablePolicy: "blur",
      minMediaSize: 32,
      debug: true,
    },
  };

  const harness = {
    detectCalls: 0,
    imageCalls: 0,
    urlCalls: 0,
    frameCalls: 0,
    ports: 0,
    contextInvalidated: false,
    engineDelayMs: 0,
    log: [],
  };
  window.__harness = harness;

  function decode(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });
  }

  async function detect(request) {
    harness.detectCalls++;
    if (request.priority === 0) harness.frameCalls++;
    else harness.imageCalls++;
    if (harness.engineDelayMs) await new Promise((r) => setTimeout(r, harness.engineDelayMs));
    if (request.source.kind === "url") {
      harness.urlCalls++;
      return { type: "error", id: request.id, code: "fetch", error: "HTTP 403 (fake)" };
    }
    const image = await decode(request.source.dataUrl);
    const { naturalWidth: width, naturalHeight: height } = image;
    const detections = [];
    if (Math.abs(width - height) <= 2) {
      detections.push({ class: "person", score: 0.9, box: [width * 0.25, height * 0.25, width * 0.5, height * 0.5] });
    }
    return { type: "result", id: request.id, width, height, detections };
  }

  const ports = new Set();

  function createPort(name) {
    harness.ports++;
    const messageListeners = new Set();
    const disconnectListeners = new Set();
    const port = {
      name,
      onMessage: { addListener: (fn) => messageListeners.add(fn) },
      onDisconnect: { addListener: (fn) => disconnectListeners.add(fn) },
      postMessage(message) {
        if (harness.contextInvalidated) throw new Error("Attempting to use a disconnected port object");
        if (message.type !== "detect") return;
        detect(message).then((reply) => {
          for (const fn of messageListeners) fn(reply);
        });
      },
      disconnect() {
        ports.delete(port);
        for (const fn of disconnectListeners) fn();
      },
    };
    ports.add(port);
    setTimeout(() => {
      for (const fn of messageListeners) fn({ type: "status", ready: true, backend: "fake", error: null });
    }, 0);
    return port;
  }

  window.chrome = {
    runtime: {
      id: "fake-extension-id",
      lastError: undefined,
      getURL: (path) => `http://fake-extension/${path}`,
      sendMessage(message) {
        if (harness.contextInvalidated) return Promise.reject(new Error("Extension context invalidated."));
        harness.log.push(`sendMessage ${message.type}`);
        if (message.type === "engine:ensure") return Promise.resolve({ ok: true });
        return Promise.resolve(undefined);
      },
      connect: ({ name }) => createPort(name),
      onMessage: { addListener() {} },
    },
    storage: {
      sync: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (items) => {
          for (const [key, value] of Object.entries(items)) {
            const oldValue = storage[key];
            storage[key] = value;
            for (const fn of storageListeners) fn({ [key]: { oldValue, newValue: value } }, "sync");
          }
        },
      },
      onChanged: {
        addListener: (fn) => storageListeners.add(fn),
        removeListener: (fn) => storageListeners.delete(fn),
      },
    },
    dom: {
      openOrClosedShadowRoot: (element) => element.shadowRoot,
    },
  };

  window.__harness.updateSettings = (patch) =>
    window.chrome.storage.sync.set({ settings: { ...storage.settings, ...patch } });
  window.__harness.invalidateContext = () => {
    harness.contextInvalidated = true;
    window.chrome.runtime.id = undefined;
    // Chrome disconnects every port of the old extension instance when it is reloaded.
    for (const port of Array.from(ports)) port.disconnect();
  };
})();
