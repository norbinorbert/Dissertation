import {
  DEFAULT_SETTINGS,
  isActiveForHost,
  loadSettings,
  onSettingsChanged,
  type Settings,
} from "../shared/settings";
import { errorMessage, log, setDebugLogging } from "../shared/log";

type Listener = (settings: Settings, previous: Settings) => void;

/** Hostnames this frame belongs to: its own plus every ancestor frame (Chrome exposes them). */
function frameHostnames(): string[] {
  const hosts = new Set<string>();
  if (location.hostname) hosts.add(location.hostname);
  const ancestors = location.ancestorOrigins;
  if (ancestors) {
    for (let i = 0; i < ancestors.length; i++) {
      try {
        const host = new URL(ancestors[i]).hostname;
        if (host) hosts.add(host);
      } catch {
        // Opaque origins ("null") carry no hostname.
      }
    }
  }
  return Array.from(hosts);
}

export class SettingsStore {
  settings: Settings = DEFAULT_SETTINGS;
  readonly ready: Promise<void>;
  private readonly listeners = new Set<Listener>();
  private readonly hostnames = frameHostnames();

  constructor() {
    this.ready = loadSettings()
      .then((settings) => this.update(settings))
      .catch((error) => log.warn("Could not load settings, using defaults:", errorMessage(error)));
    onSettingsChanged((settings) => this.update(settings));
  }

  /** True when the extension should act in this frame (enabled and no involved site is excluded). */
  get active(): boolean {
    return this.hostnames.every((host) => isActiveForHost(this.settings, host)) && this.settings.enabled;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(settings: Settings): void {
    const previous = this.settings;
    this.settings = settings;
    setDebugLogging(settings.debug);
    for (const listener of this.listeners) listener(settings, previous);
  }
}
