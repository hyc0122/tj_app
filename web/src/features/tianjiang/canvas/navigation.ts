export const CANVAS_STARTER_KINDS = [
  "blank",
  "novel-upload",
  "storyboard-guide",
  "text-to-image",
  "first-frame-to-video",
] as const;

export type CanvasStarterKind = (typeof CANVAS_STARTER_KINDS)[number];

export const CANVAS_EMPTY_STATE_CARDS = [
  "novel-upload",
  "storyboard-guide",
  "text-to-image",
  "first-frame-to-video",
] as const;

export function canvasHomePath(): string {
  return "/infinite-canvas";
}

export function canvasEditorPath(projectUuid: string): string {
  return `/infinite-canvas/${encodeURIComponent(projectUuid)}`;
}
