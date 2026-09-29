/**
 * chrome.runtime stand-in for running the real inference engine (dist/engine.js) in a
 * plain page. The test drives the engine through the listeners it registers.
 */
(() => {
  const connectListeners = new Set();
  const messageListeners = new Set();
  const sent = [];

  window.chrome = {
    runtime: {
      id: "fake-extension-id",
      getURL: (path) => new URL(path, location.href).href,
      onConnect: { addListener: (fn) => connectListeners.add(fn) },
      onMessage: { addListener: (fn) => messageListeners.add(fn) },
      sendMessage: async (message) => {
        sent.push(message);
        return undefined;
      },
    },
  };

  window.__engineHarness = {
    sent,
    /** Sends a one-shot runtime message and resolves with the engine's response. */
    message(message) {
      return new Promise((resolve) => {
        for (const fn of messageListeners) {
          fn(message, { id: "fake-extension-id", url: location.href }, resolve);
        }
      });
    },
    /** Opens a fake port; returns helpers to post requests and await replies by id. */
    connect() {
      const engineHandlers = new Set();
      const disconnectHandlers = new Set();
      const waiting = new Map();
      const statuses = [];
      const port = {
        name: "object-censor/engine",
        onMessage: { addListener: (fn) => engineHandlers.add(fn) },
        onDisconnect: { addListener: (fn) => disconnectHandlers.add(fn) },
        postMessage(message) {
          // Engine → client.
          if (message.type === "status") {
            statuses.push(message);
            return;
          }
          const resolve = waiting.get(message.id);
          if (resolve) {
            waiting.delete(message.id);
            resolve(message);
          }
        },
        disconnect() {
          for (const fn of disconnectHandlers) fn();
        },
      };
      for (const fn of connectListeners) fn(port);
      let nextId = 1;
      return {
        statuses,
        detect(source, priority = 1) {
          const id = nextId++;
          return new Promise((resolve) => {
            waiting.set(id, resolve);
            for (const fn of engineHandlers) fn({ type: "detect", id, source, priority });
          });
        },
        disconnect: () => port.disconnect(),
      };
    },
  };
})();
