export type StoryboardVideoCatalogState = "checking" | "ready" | "failed";

export function catalogOptionValue(item: { id?: string; value?: string }): string {
  const id = String(item.id ?? "");
  const value = String(item.value ?? "");
  // 中文注释：原生即梦目录的 value 已是 providerId:modelName，禁止再拼一层。
  return id && value.startsWith(`${id}:`) ? value : `${id}:${value}`;
}

export function videoCatalogAvailableValues(
  items: readonly { id?: string; value?: string; type?: string; disabled?: boolean }[],
): string[] {
  return items
    .filter((item) => item.disabled !== true && (item.type === "video" || !item.type))
    .map(catalogOptionValue);
}

/** 仅字符串非空不算可用；必须 ready、目录非空且精确命中当前账号未禁用视频模型。 */
export function isStoryboardVideoModelAvailable(input: {
  catalogState: StoryboardVideoCatalogState;
  availableValues: readonly string[];
  providerModel: string;
}): boolean {
  const model = String(input.providerModel ?? "");
  return input.catalogState === "ready"
    && input.availableValues.length > 0
    && model.length > 0
    && input.availableValues.includes(model);
}
