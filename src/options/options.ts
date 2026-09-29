import { CENSOR_CLASSES, type CensorClass } from "../shared/classes";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeHostname,
  onSettingsChanged,
  saveSettings,
  type Settings,
} from "../shared/settings";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const classesGrid = byId<HTMLDivElement>("classes");
const minScore = byId<HTMLInputElement>("min-score");
const minScoreValue = byId<HTMLSpanElement>("min-score-value");
const minSize = byId<HTMLInputElement>("min-size");
const blurRadius = byId<HTMLInputElement>("blur-radius");
const blurRadiusValue = byId<HTMLSpanElement>("blur-radius-value");
const disabledSites = byId<HTMLTextAreaElement>("disabled-sites");
const debug = byId<HTMLInputElement>("debug");
const toast = byId<HTMLSpanElement>("toast");
const resetButton = byId<HTMLButtonElement>("reset");
const policyInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="policy"]'));

const classInputs = new Map<CensorClass, HTMLInputElement>();
for (const name of CENSOR_CLASSES) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  label.append(input, document.createTextNode(name));
  classesGrid.appendChild(label);
  classInputs.set(name, input);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(): void {
  toast.classList.add("visible");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 1200);
}

function render(settings: Settings): void {
  for (const [name, input] of classInputs) input.checked = settings.classes[name];
  minScore.value = String(Math.round(settings.minScore * 100));
  minScoreValue.textContent = `${minScore.value}%`;
  minSize.value = String(settings.minMediaSize);
  blurRadius.value = String(settings.blurRadius);
  blurRadiusValue.textContent = `${settings.blurRadius}px`;
  for (const input of policyInputs) input.checked = input.value === settings.unprocessablePolicy;
  if (document.activeElement !== disabledSites) disabledSites.value = settings.disabledSites.join("\n");
  debug.checked = settings.debug;
}

function collect(): Partial<Settings> {
  const classes = { ...DEFAULT_SETTINGS.classes };
  for (const [name, input] of classInputs) classes[name] = input.checked;
  const sites = disabledSites.value
    .split(/\r?\n/)
    .map(normalizeHostname)
    .filter((site): site is string => site !== null);
  return {
    classes,
    minScore: Number(minScore.value) / 100,
    minMediaSize: Number(minSize.value),
    blurRadius: Number(blurRadius.value),
    unprocessablePolicy: policyInputs.find((input) => input.checked)?.value === "show" ? "show" : "blur",
    disabledSites: sites,
    debug: debug.checked,
  };
}

async function persist(): Promise<void> {
  const saved = await saveSettings(collect());
  render(saved);
  showToast();
}

minScore.addEventListener("input", () => {
  minScoreValue.textContent = `${minScore.value}%`;
});
blurRadius.addEventListener("input", () => {
  blurRadiusValue.textContent = `${blurRadius.value}px`;
});

for (const input of [minScore, minSize, blurRadius, debug, ...policyInputs, ...classInputs.values()]) {
  input.addEventListener("change", () => void persist());
}
disabledSites.addEventListener("blur", () => void persist());

resetButton.addEventListener("click", async () => {
  const current = await loadSettings();
  // Keep the master switch and per-site list; reset everything else.
  const saved = await saveSettings({
    ...DEFAULT_SETTINGS,
    enabled: current.enabled,
    disabledSites: current.disabledSites,
  });
  render(saved);
  showToast();
});

loadSettings().then(render);
onSettingsChanged(render);
