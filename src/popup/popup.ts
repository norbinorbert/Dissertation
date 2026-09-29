import { CENSOR_CLASSES } from "../shared/classes";
import type { EngineStatusResponse, RuntimeMessage } from "../shared/messages";
import {
  isSiteDisabled,
  loadSettings,
  normalizeHostname,
  onSettingsChanged,
  saveSettings,
  type Settings,
} from "../shared/settings";

const enabledInput = document.getElementById("enabled") as HTMLInputElement;
const siteInput = document.getElementById("site-enabled") as HTMLInputElement;
const siteHost = document.getElementById("site-host") as HTMLElement;
const engineStatus = document.getElementById("engine-status") as HTMLElement;
const classesLabel = document.getElementById("classes") as HTMLElement;
const optionsButton = document.getElementById("open-options") as HTMLButtonElement;

let currentHost: string | null = null;

async function activeTabHost(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const url = new URL(tab.url);
    if (!/^https?:$/.test(url.protocol)) return null;
    return normalizeHostname(url.hostname);
  } catch {
    return null;
  }
}

function render(settings: Settings): void {
  enabledInput.checked = settings.enabled;
  if (currentHost) {
    siteHost.textContent = currentHost;
    siteInput.disabled = !settings.enabled;
    siteInput.checked = !isSiteDisabled(settings, currentHost);
  } else {
    siteHost.textContent = "Not available for this page";
    siteInput.disabled = true;
    siteInput.checked = false;
  }
  classesLabel.textContent = `Censoring: ${CENSOR_CLASSES.filter((name) => settings.classes[name]).join(", ") || "nothing"}`;
}

function renderEngine(status: EngineStatusResponse): void {
  if (status.error) {
    engineStatus.dataset.level = "bad";
    engineStatus.textContent = `Error: ${status.error}`;
  } else if (!status.running) {
    engineStatus.dataset.level = "";
    engineStatus.textContent = "Idle (starts when media is found)";
  } else if (status.ready) {
    engineStatus.dataset.level = "ok";
    engineStatus.textContent = `Running (${status.backend ?? "unknown"} backend)`;
  } else {
    engineStatus.dataset.level = "warn";
    engineStatus.textContent = "Loading model…";
  }
}

async function refreshEngine(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage<RuntimeMessage, EngineStatusResponse>({ type: "engine:status" });
    renderEngine(status);
  } catch (error) {
    renderEngine({ running: false, ready: false, backend: null, error: String(error) });
  }
}

enabledInput.addEventListener("change", () => {
  void saveSettings({ enabled: enabledInput.checked });
});

siteInput.addEventListener("change", async () => {
  if (!currentHost) return;
  const settings = await loadSettings();
  const disabledSites = settings.disabledSites.filter((site) => site !== currentHost);
  if (!siteInput.checked) disabledSites.push(currentHost);
  await saveSettings({ disabledSites });
});

optionsButton.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

async function init(): Promise<void> {
  currentHost = await activeTabHost();
  render(await loadSettings());
  onSettingsChanged(render);
  await refreshEngine();
  setInterval(() => void refreshEngine(), 2000);
}

void init();
