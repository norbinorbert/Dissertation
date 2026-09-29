/**
 * Content script entry point. Runs at document_start in every frame; the stylesheet
 * declared in the manifest already blurs all <img>/<video> elements by then, so this
 * script's job is to analyse media and lift the blur (or draw boxes) as results arrive.
 */
import type { Settings } from "../shared/settings";
import { log } from "../shared/log";
import { EngineClient } from "./engine-client";
import { ImageProcessor } from "./image-processor";
import type { MediaElement } from "./media-state";
import { MediaTracker, type MediaTrackerDelegate } from "./media-tracker";
import { Overlay } from "./overlay";
import { SettingsStore } from "./settings-store";
import { VideoProcessor } from "./video-processor";

/** Present on <html> while the extension is inactive in this frame; disables all blur rules. */
const OFF_ATTRIBUTE = "data-oc-off";
const POLICY_ATTRIBUTE = "data-oc-policy";
const BLUR_VARIABLE = "--oc-blur";

/** Same rules as content.css, but for shadow roots the document stylesheet cannot reach. */
function shadowStylesheetText(settings: Settings, active: boolean): string {
  if (!active) return "";
  const blur = `filter: blur(${settings.blurRadius}px) !important; clip-path: inset(0) !important;`;
  const selectors = ['img:not([data-oc-state])', 'video:not([data-oc-state])', 'video:fullscreen[data-oc-state="censored"]'];
  if (settings.unprocessablePolicy === "blur") {
    selectors.push('img[data-oc-state="failed"]', 'video[data-oc-state="failed"]');
  }
  return `${selectors.join(",\n")} { ${blur} }`;
}

class CensorController implements MediaTrackerDelegate {
  private readonly engine = new EngineClient();
  private readonly overlay = new Overlay();
  private readonly images: ImageProcessor;
  private readonly videos: VideoProcessor;
  private readonly tracker: MediaTracker;
  private readonly shadowSheet: CSSStyleSheet | null;
  private readonly shadowStyleElements = new WeakMap<ShadowRoot, HTMLStyleElement>();
  private readonly shadowRoots = new Set<WeakRef<ShadowRoot>>();
  private running = false;
  private shutDown = false;

  constructor(private readonly settings: SettingsStore) {
    this.images = new ImageProcessor(this.engine, this.overlay, settings);
    this.videos = new VideoProcessor(this.engine, this.overlay, settings);
    this.tracker = new MediaTracker(this);
    this.shadowSheet = this.createSheet();
    this.engine.onContextInvalidated = () => this.shutdown();
    this.engine.onReady = () => {
      this.images.retryTransientFailures();
      this.videos.retryTransientFailures();
    };
  }

  applySettings(settings: Settings): void {
    if (this.shutDown) return;
    const root = document.documentElement;
    root.style.setProperty(BLUR_VARIABLE, `${settings.blurRadius}px`);
    root.setAttribute(POLICY_ATTRIBUTE, settings.unprocessablePolicy);
    const active = this.settings.active;
    this.updateShadowStyles(shadowStylesheetText(settings, active));
    if (active) {
      this.start();
      this.images.settingsChanged();
      this.videos.settingsChanged();
    } else {
      this.stop();
    }
  }

  private start(): void {
    document.documentElement.removeAttribute(OFF_ATTRIBUTE);
    if (this.running) return;
    this.running = true;
    log.debug("Active in", location.href);
    this.tracker.start();
  }

  private stop(): void {
    document.documentElement.setAttribute(OFF_ATTRIBUTE, "");
    if (!this.running) return;
    this.running = false;
    this.tracker.stop();
    this.images.clear();
    this.videos.clear();
    this.overlay.clear();
    this.engine.disconnect();
    log.debug("Inactive in", location.href);
  }

  /** The extension was reloaded or removed: this script can no longer do anything useful. */
  private shutdown(): void {
    if (this.shutDown) return;
    log.warn("Extension context invalidated; releasing all media.");
    this.stop();
    this.updateShadowStyles("");
    this.overlay.destroy();
    this.shutDown = true;
  }

  // ---- shadow DOM styling ----------------------------------------------------------

  private createSheet(): CSSStyleSheet | null {
    try {
      return new CSSStyleSheet();
    } catch {
      return null;
    }
  }

  private updateShadowStyles(css: string): void {
    if (this.shadowSheet) {
      try {
        this.shadowSheet.replaceSync(css);
      } catch {
        // Ignore; individual <style> fallbacks below still get updated.
      }
    }
    for (const ref of Array.from(this.shadowRoots)) {
      const root = ref.deref();
      if (!root) {
        this.shadowRoots.delete(ref);
        continue;
      }
      const style = this.shadowStyleElements.get(root);
      if (style) style.textContent = css;
    }
  }

  onShadowRoot(root: ShadowRoot): void {
    const css = shadowStylesheetText(this.settings.settings, this.settings.active);
    if (this.shadowSheet) {
      try {
        if (!root.adoptedStyleSheets.includes(this.shadowSheet)) {
          root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.shadowSheet];
        }
        return;
      } catch {
        // Fall through to a <style> element.
      }
    }
    if (this.shadowStyleElements.has(root)) return;
    const style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);
    this.shadowStyleElements.set(root, style);
    this.shadowRoots.add(new WeakRef(root));
  }

  // ---- MediaTrackerDelegate ----------------------------------------------------------

  onAdded(element: MediaElement): void {
    if (element instanceof HTMLImageElement) this.images.add(element);
    else this.videos.add(element);
  }

  onRemoved(element: MediaElement): void {
    if (element instanceof HTMLImageElement) this.images.remove(element);
    else this.videos.remove(element);
  }

  onSourceChanged(element: MediaElement): void {
    if (element instanceof HTMLImageElement) this.images.sourceChanged(element);
    else this.videos.sourceChanged(element);
  }

  onNearChanged(element: MediaElement, near: boolean): void {
    if (element instanceof HTMLImageElement) this.images.setNear(element, near);
    else this.videos.setNear(element, near);
  }

  onResized(element: MediaElement): void {
    if (element instanceof HTMLImageElement) this.images.resized(element);
    else this.videos.resized(element);
  }

  onImageLoaded(image: HTMLImageElement): void {
    this.images.loaded(image);
  }

  onImageError(image: HTMLImageElement): void {
    this.images.errored(image);
  }

  onVideoEvent(video: HTMLVideoElement, type: string): void {
    this.videos.handleEvent(video, type);
  }
}

function main(): void {
  // Only HTML documents render <img>/<video>; skip XML/SVG documents.
  if (!(document.documentElement instanceof HTMLElement)) return;
  const settings = new SettingsStore();
  const controller = new CensorController(settings);
  settings.ready.then(() => controller.applySettings(settings.settings));
  settings.subscribe((current) => controller.applySettings(current));
}

main();
