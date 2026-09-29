/**
 * Draws the black censor boxes. A single fixed-position host element (with a shadow
 * root, so page CSS cannot restyle it) sits on top of the page; every censored
 * media element gets a group inside it whose geometry is re-synced each animation
 * frame while the media is on screen.
 */
import {
  intersectRects,
  paintedRect,
  readPaintStyle,
  rectFromDom,
  viewportRect,
  type NormalizedBox,
  type PaintStyle,
  type Rect,
  type Size,
} from "./geometry";

const HOST_TAG = "object-censor-overlay";
const STYLE_REFRESH_MS = 1000;
const CLIP_CHAIN_REFRESH_MS = 2000;
/** Boxes grow by this fraction of their own size (at least MIN_PAD_PX) to hide object edges. */
const PAD_RATIO = 0.04;
const MIN_PAD_PX = 2;

const SHADOW_CSS = `
:host { all: initial; }
.layer { position: absolute; inset: 0; }
.group { position: absolute; overflow: hidden; display: none; }
.content { position: absolute; }
.box { position: absolute; background: #000; }
`;

const HOST_STYLES: Record<string, string> = {
  position: "fixed",
  top: "0",
  left: "0",
  right: "0",
  bottom: "0",
  width: "auto",
  height: "auto",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  overflow: "hidden",
  display: "block",
  visibility: "visible",
  opacity: "1",
  transform: "none",
  filter: "none",
  "clip-path": "none",
  "pointer-events": "none",
  "z-index": "2147483647",
};

interface Group {
  element: Element;
  clip: HTMLDivElement;
  content: HTMLDivElement;
  boxElements: HTMLDivElement[];
  boxes: NormalizedBox[];
  intrinsic: Size;
  extraPadRatio: number;
  visible: boolean;
  style: PaintStyle | null;
  styleReadAt: number;
  clipChain: Element[];
  clipChainReadAt: number;
  lastKey: string;
}

function parentOf(node: Node): Element | null {
  const parent = node.parentNode;
  if (!parent) return null;
  if (parent instanceof ShadowRoot) return parent.host;
  return parent instanceof Element ? parent : null;
}

/** Ancestors whose overflow clips descendants; used to hide boxes over scrolled-away media. */
function computeClipChain(element: Element): Element[] {
  const chain: Element[] = [];
  let node = parentOf(element);
  while (node && node !== document.documentElement && node !== document.body) {
    const cs = getComputedStyle(node);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible" || cs.clipPath !== "none") {
      chain.push(node);
    }
    node = parentOf(node);
  }
  return chain;
}

function fullscreenContainer(): Element | null {
  const element = document.fullscreenElement;
  if (!element) return null;
  if (
    element instanceof HTMLVideoElement ||
    element instanceof HTMLImageElement ||
    element instanceof HTMLIFrameElement ||
    element instanceof HTMLCanvasElement ||
    element instanceof HTMLObjectElement ||
    element instanceof HTMLEmbedElement
  ) {
    return null;
  }
  return element;
}

function setRect(node: HTMLElement, rect: Rect): void {
  node.style.left = `${rect.left}px`;
  node.style.top = `${rect.top}px`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

export class Overlay {
  private host: HTMLElement | null = null;
  private layer: HTMLDivElement | null = null;
  private readonly groups = new Map<Element, Group>();
  private frame: number | null = null;

  /** Shows `boxes` over `element`; an empty list removes the group. */
  setBoxes(element: Element, boxes: NormalizedBox[], intrinsic: Size, extraPadRatio = 0): void {
    if (boxes.length === 0) {
      this.remove(element);
      return;
    }
    const group = this.groups.get(element) ?? this.createGroup(element);
    group.boxes = boxes;
    group.intrinsic = intrinsic;
    group.extraPadRatio = extraPadRatio;
    group.lastKey = "";
    while (group.boxElements.length < boxes.length) {
      const box = document.createElement("div");
      box.className = "box";
      group.content.appendChild(box);
      group.boxElements.push(box);
    }
    while (group.boxElements.length > boxes.length) {
      group.boxElements.pop()!.remove();
    }
    this.schedule();
  }

  setIntrinsic(element: Element, intrinsic: Size): void {
    const group = this.groups.get(element);
    if (!group) return;
    group.intrinsic = intrinsic;
    group.lastKey = "";
    this.schedule();
  }

  setVisible(element: Element, visible: boolean): void {
    const group = this.groups.get(element);
    if (!group || group.visible === visible) return;
    group.visible = visible;
    if (!visible) this.hide(group);
    else this.schedule();
  }

  /** Forces cached style/clipping information to be re-read (e.g. after a resize). */
  invalidate(element: Element): void {
    const group = this.groups.get(element);
    if (!group) return;
    group.styleReadAt = 0;
    group.clipChainReadAt = 0;
    group.lastKey = "";
    this.schedule();
  }

  remove(element: Element): void {
    const group = this.groups.get(element);
    if (!group) return;
    group.clip.remove();
    this.groups.delete(element);
  }

  clear(): void {
    for (const element of Array.from(this.groups.keys())) this.remove(element);
  }

  destroy(): void {
    this.clear();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.host?.remove();
    this.host = null;
    this.layer = null;
  }

  // ---- internals ------------------------------------------------------------

  private createGroup(element: Element): Group {
    this.mount();
    const clip = document.createElement("div");
    clip.className = "group";
    const content = document.createElement("div");
    content.className = "content";
    clip.appendChild(content);
    this.layer!.appendChild(clip);
    const group: Group = {
      element,
      clip,
      content,
      boxElements: [],
      boxes: [],
      intrinsic: { width: 0, height: 0 },
      extraPadRatio: 0,
      visible: true,
      style: null,
      styleReadAt: 0,
      clipChain: [],
      clipChainReadAt: 0,
      lastKey: "",
    };
    this.groups.set(element, group);
    return group;
  }

  private mount(): void {
    if (!this.host) {
      const host = document.createElement(HOST_TAG);
      for (const [property, value] of Object.entries(HOST_STYLES)) {
        host.style.setProperty(property, value, "important");
      }
      // Open so tests/devtools can inspect the boxes; page CSS still cannot reach inside.
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = SHADOW_CSS;
      const layer = document.createElement("div");
      layer.className = "layer";
      shadow.append(style, layer);
      this.host = host;
      this.layer = layer;
    }
    // Fullscreen renders only the fullscreen subtree, so follow it while it is active.
    const parent = fullscreenContainer() ?? document.documentElement;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
  }

  private schedule(): void {
    if (this.frame !== null || this.groups.size === 0) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    this.frame = null;
    if (this.groups.size === 0) return;
    this.mount();
    const now = performance.now();
    const viewport = viewportRect();
    let anyVisible = false;
    for (const group of this.groups.values()) {
      if (!group.visible || !group.element.isConnected) {
        this.hide(group);
        continue;
      }
      anyVisible = true;
      this.layout(group, now, viewport);
    }
    if (anyVisible) this.schedule();
  };

  private hide(group: Group): void {
    if (group.lastKey === "hidden") return;
    group.clip.style.display = "none";
    group.lastKey = "hidden";
  }

  private layout(group: Group, now: number, viewport: Rect): void {
    const domRect = group.element.getBoundingClientRect();
    if (domRect.width === 0 || domRect.height === 0) {
      this.hide(group);
      return;
    }
    if (!group.style || now - group.styleReadAt > STYLE_REFRESH_MS) {
      group.style = readPaintStyle(group.element);
      group.styleReadAt = now;
    }
    if (now - group.clipChainReadAt > CLIP_CHAIN_REFRESH_MS) {
      group.clipChain = computeClipChain(group.element);
      group.clipChainReadAt = now;
    }

    const borderBox = rectFromDom(domRect);
    let clip: Rect | null = intersectRects(borderBox, viewport);
    for (const ancestor of group.clipChain) {
      if (!clip) break;
      clip = intersectRects(clip, rectFromDom(ancestor.getBoundingClientRect()));
    }
    if (!clip) {
      this.hide(group);
      return;
    }

    const painted = paintedRect(borderBox, group.style, group.intrinsic);
    const key = [
      clip.left, clip.top, clip.width, clip.height,
      painted.left, painted.top, painted.width, painted.height,
    ]
      .map((value) => Math.round(value * 2) / 2)
      .join(",");
    if (key === group.lastKey) return;
    group.lastKey = key;

    setRect(group.clip, clip);
    group.clip.style.display = "block";
    setRect(group.content, {
      left: painted.left - clip.left,
      top: painted.top - clip.top,
      width: painted.width,
      height: painted.height,
    });

    for (let i = 0; i < group.boxes.length; i++) {
      const box = group.boxes[i];
      const width = box.width * painted.width;
      const height = box.height * painted.height;
      const pad = Math.max(MIN_PAD_PX, (PAD_RATIO + group.extraPadRatio) * Math.max(width, height));
      setRect(group.boxElements[i], {
        left: box.x * painted.width - pad,
        top: box.y * painted.height - pad,
        width: width + 2 * pad,
        height: height + 2 * pad,
      });
    }
  }
}
