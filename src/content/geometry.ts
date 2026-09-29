/**
 * Geometry helpers that map the intrinsic pixel grid of an image/video onto the
 * rectangle where the browser actually paints it (border, padding, object-fit,
 * object-position) in viewport coordinates.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Axis-aligned box in [0, 1] coordinates relative to the media's intrinsic size. */
export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type PositionComponent = { kind: "percent"; value: number } | { kind: "length"; value: number };

export interface PaintStyle {
  objectFit: string;
  positionX: PositionComponent;
  positionY: PositionComponent;
  insetLeft: number;
  insetTop: number;
  insetRight: number;
  insetBottom: number;
}

const KEYWORD_PERCENT: Record<string, number> = {
  left: 0,
  top: 0,
  center: 50,
  right: 100,
  bottom: 100,
};

function parseComponent(token: string | undefined, fallback: number): PositionComponent {
  if (!token) return { kind: "percent", value: fallback };
  if (token in KEYWORD_PERCENT) return { kind: "percent", value: KEYWORD_PERCENT[token] };
  if (token.endsWith("%")) {
    const value = parseFloat(token);
    return { kind: "percent", value: Number.isFinite(value) ? value : fallback };
  }
  const value = parseFloat(token);
  return Number.isFinite(value) ? { kind: "length", value } : { kind: "percent", value: fallback };
}

/** Parses the computed `object-position` (Chrome serialises it as two space separated values). */
export function parseObjectPosition(value: string): { x: PositionComponent; y: PositionComponent } {
  const tokens = value.trim().split(/\s+/);
  // "top left" style keyword pairs may be swapped relative to the x/y order.
  if (tokens.length === 2 && (tokens[0] === "top" || tokens[0] === "bottom") && !(tokens[1] === "top" || tokens[1] === "bottom")) {
    tokens.reverse();
  }
  return { x: parseComponent(tokens[0], 50), y: parseComponent(tokens[1], 50) };
}

const px = (value: string): number => parseFloat(value) || 0;

export function readPaintStyle(element: Element): PaintStyle {
  const cs = getComputedStyle(element);
  const position = parseObjectPosition(cs.objectPosition || "50% 50%");
  return {
    objectFit: cs.objectFit || "fill",
    positionX: position.x,
    positionY: position.y,
    insetLeft: px(cs.borderLeftWidth) + px(cs.paddingLeft),
    insetTop: px(cs.borderTopWidth) + px(cs.paddingTop),
    insetRight: px(cs.borderRightWidth) + px(cs.paddingRight),
    insetBottom: px(cs.borderBottomWidth) + px(cs.paddingBottom),
  };
}

function offset(component: PositionComponent, free: number): number {
  return component.kind === "percent" ? (free * component.value) / 100 : component.value;
}

/**
 * Returns where the intrinsic image is painted, given the element's border box.
 * The result may extend beyond the content box for `object-fit: cover` / `none`.
 */
export function paintedRect(borderBox: Rect, style: PaintStyle, intrinsic: Size): Rect {
  const contentLeft = borderBox.left + style.insetLeft;
  const contentTop = borderBox.top + style.insetTop;
  const contentWidth = Math.max(0, borderBox.width - style.insetLeft - style.insetRight);
  const contentHeight = Math.max(0, borderBox.height - style.insetTop - style.insetBottom);

  if (!intrinsic.width || !intrinsic.height) {
    return { left: contentLeft, top: contentTop, width: contentWidth, height: contentHeight };
  }

  let width = contentWidth;
  let height = contentHeight;
  const scaleX = contentWidth / intrinsic.width;
  const scaleY = contentHeight / intrinsic.height;
  switch (style.objectFit) {
    case "contain": {
      const scale = Math.min(scaleX, scaleY);
      width = intrinsic.width * scale;
      height = intrinsic.height * scale;
      break;
    }
    case "cover": {
      const scale = Math.max(scaleX, scaleY);
      width = intrinsic.width * scale;
      height = intrinsic.height * scale;
      break;
    }
    case "none":
      width = intrinsic.width;
      height = intrinsic.height;
      break;
    case "scale-down": {
      const scale = Math.min(1, scaleX, scaleY);
      width = intrinsic.width * scale;
      height = intrinsic.height * scale;
      break;
    }
    default:
      // "fill" stretches to the content box.
      break;
  }

  return {
    left: contentLeft + offset(style.positionX, contentWidth - width),
    top: contentTop + offset(style.positionY, contentHeight - height),
    width,
    height,
  };
}

export function intersectRects(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function viewportRect(): Rect {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

export function rectFromDom(rect: DOMRect): Rect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Grows a normalized box by `padX`/`padY` (in normalized units) and clamps it to the image. */
export function expandBox(box: NormalizedBox, padX: number, padY: number): NormalizedBox {
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  return {
    x,
    y,
    width: Math.min(1, box.x + box.width + padX) - x,
    height: Math.min(1, box.y + box.height + padY) - y,
  };
}
