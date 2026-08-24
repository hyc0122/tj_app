export type VendorSecretRequester = (
  path: string,
  body?: unknown,
  options?: unknown,
) => Promise<unknown>;

/**
 * 设置页直接使用当前认证账号列表返回的 inputValues，不增加 reveal/确认协议。
 * 组件卸载时仍主动抹除内存引用，且保存只能作用于当前供应商。
 */
export class VendorSecretSession {
  #activeVendorId?: string;
  #loadedVendorId?: string;
  #values: Record<string, string> = {};

  private switchVendor(vendorId?: string): void {
    this.clear();
    this.#activeVendorId = vendorId;
  }

  isLoaded(vendorId?: string): boolean {
    return Boolean(vendorId) && vendorId === this.#loadedVendorId;
  }

  activate(
    vendorId: string,
    inputValues: Record<string, string>,
  ): Record<string, string> {
    this.switchVendor(vendorId);
    this.#loadedVendorId = vendorId;
    this.#values = cloneStringRecord(inputValues);
    return this.values(vendorId);
  }

  values(vendorId: string): Record<string, string> {
    return this.isLoaded(vendorId) ? { ...this.#values } : {};
  }

  async save(
    vendorId: string,
    inputValues: Record<string, string>,
    request: VendorSecretRequester,
  ): Promise<void> {
    if (!this.isLoaded(vendorId) || vendorId !== this.#activeVendorId) {
      throw new Error("只能保存当前供应商配置");
    }
    const normalized = cloneStringRecord(inputValues);
    await request("/setting/vendorConfig/updateVendorInputs", {
      id: vendorId,
      inputValues: normalized,
    });
    const { modelCatalogStore } = await import("@/features/models/modelCatalogStore");
    modelCatalogStore.invalidateAll();
    this.#values = normalized;
  }

  clear(): void {
    for (const key of Object.keys(this.#values)) this.#values[key] = "";
    this.#values = {};
    this.#loadedVendorId = undefined;
  }

  dispose(): void {
    this.clear();
    this.#activeVendorId = undefined;
  }
}

function cloneStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(key) && typeof item === "string"),
  ) as Record<string, string>;
}
