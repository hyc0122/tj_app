export interface CornerScapeLiteItem {
  id: number;
  state?: string;
  prompt?: string;
}

export function selectIdsByState(items: CornerScapeLiteItem[], state: string): number[] {
  return items.filter((item) => (state ? item.state === state : !item.state)).map((item) => item.id);
}

export function selectPromptEmptyIds(items: CornerScapeLiteItem[]): number[] {
  return items.filter((item) => !item.prompt?.trim()).map((item) => item.id);
}

export function collectPreviewImages(
  items: Array<{ src?: string; history?: Array<{ filePath?: string }> }>,
): string[] {
  const paths = items.flatMap((item) => [
    item.src ?? "",
    ...(item.history ?? []).map((image) => image.filePath ?? ""),
  ]);
  return [...new Set(paths.filter(Boolean))];
}
