import { CENSOR_CLASSES, type CensorClass } from "./classes";

/** What to do with media the engine could not analyse (tainted video, DRM, fetch errors). */
export type UnprocessablePolicy = "blur" | "show";

export interface Settings {
  /** Master switch. When off, no media is blurred or censored anywhere. */
  enabled: boolean;
  /** Hostnames (and their subdomains) where the extension is switched off. */
  disabledSites: string[];
  /** Which of the supported classes are currently censored. */
  classes: Record<CensorClass, boolean>;
  /** Minimum detection confidence (0..1) for a box to be drawn. */
  minScore: number;
  /** Blur radius in CSS pixels applied to unprocessed media. */
  blurRadius: number;
  unprocessablePolicy: UnprocessablePolicy;
  /** Media smaller than this (rendered or intrinsic, in CSS px) is ignored. */
  minMediaSize: number;
  /** Verbose console logging in content scripts and the engine. */
  debug: boolean;
}

export const SETTINGS_STORAGE_KEY = "settings";

/** The engine never reports detections below this score, whatever the user setting is. */
export const MIN_SCORE_FLOOR = 0.3;
export const MIN_SCORE_CEILING = 0.95;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  disabledSites: [],
  classes: Object.fromEntries(CENSOR_CLASSES.map((name) => [name, true])) as Record<
    CensorClass,
    boolean
  >,
  minScore: 0.5,
  blurRadius: 20,
  unprocessablePolicy: "blur",
  minMediaSize: 32,
  debug: false,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Extracts a lowercase hostname from user input such as "https://www.example.com/a" or
 * "Example.com". Returns null when the input does not look like a hostname.
 */
export function normalizeHostname(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

/** Fills gaps and repairs invalid values so callers can rely on every field. */
export function normalizeSettings(raw: unknown): Settings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const rawClasses = (input.classes && typeof input.classes === "object" ? input.classes : {}) as Record<
    string,
    unknown
  >;
  const classes = { ...DEFAULT_SETTINGS.classes };
  for (const name of CENSOR_CLASSES) {
    if (typeof rawClasses[name] === "boolean") classes[name] = rawClasses[name] as boolean;
  }
  const disabledSites = Array.isArray(input.disabledSites)
    ? Array.from(
        new Set(
          input.disabledSites
            .filter((site): site is string => typeof site === "string")
            .map(normalizeHostname)
            .filter((site): site is string => site !== null),
        ),
      )
    : [];

  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_SETTINGS.enabled,
    disabledSites,
    classes,
    minScore: clamp(asNumber(input.minScore, DEFAULT_SETTINGS.minScore), MIN_SCORE_FLOOR, MIN_SCORE_CEILING),
    blurRadius: clamp(Math.round(asNumber(input.blurRadius, DEFAULT_SETTINGS.blurRadius)), 4, 80),
    unprocessablePolicy: input.unprocessablePolicy === "show" ? "show" : "blur",
    minMediaSize: clamp(Math.round(asNumber(input.minMediaSize, DEFAULT_SETTINGS.minMediaSize)), 8, 512),
    debug: input.debug === true,
  };
}

export function isSiteDisabled(settings: Settings, hostname: string): boolean {
  const host = hostname.toLowerCase();
  return settings.disabledSites.some((site) => host === site || host.endsWith(`.${site}`));
}

export function isActiveForHost(settings: Settings, hostname: string): boolean {
  return settings.enabled && !isSiteDisabled(settings, hostname);
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.sync.set({ [SETTINGS_STORAGE_KEY]: next });
  return next;
}

/** Subscribes to settings updates. Returns an unsubscribe function. */
export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "sync" || !(SETTINGS_STORAGE_KEY in changes)) return;
    listener(normalizeSettings(changes[SETTINGS_STORAGE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
