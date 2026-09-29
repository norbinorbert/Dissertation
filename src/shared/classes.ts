/**
 * The COCO classes this extension censors. coco-ssd can recognise 80 classes; only
 * detections of these five are ever reported to content scripts.
 */
export const CENSOR_CLASSES = ["person", "dog", "cat", "knife", "bottle"] as const;

export type CensorClass = (typeof CENSOR_CLASSES)[number];

export function isCensorClass(name: string): name is CensorClass {
  return (CENSOR_CLASSES as readonly string[]).includes(name);
}
