export function buildMediaDragData(item: Record<string, any>) {
  return {
    ...item,
    sourceUrl: item.url || item.id,
  };
}
