import { computed, type ComputedRef, type Ref } from "vue";
import type { ProviderWorkspaceItem, VendorItem } from "./types";
import { NATIVE_DREAMINA_ID } from "./types";

/** 供应商工作区只负责把本机即梦入口与账号供应商目录组合为展示列表。 */
export function createVendorWorkspaceItems(
  vendorList: Ref<VendorItem[]>,
): ComputedRef<ProviderWorkspaceItem[]> {
  return computed(() => [
    {
      kind: "native-dreamina",
      id: NATIVE_DREAMINA_ID,
      label: "即梦 CLI",
    },
    ...vendorList.value.map((vendor) => ({
      kind: "configured-vendor" as const,
      id: vendor.id,
      vendor,
    })),
  ]);
}

/** 输入分组保持模板声明顺序，必填与可选仅用于展示分区。 */
export function createVendorInputState(
  currentVendor: ComputedRef<VendorItem | undefined>,
) {
  const vendorModels = computed(
    () => currentVendor.value?.models || currentVendor.value?.model || [],
  );
  const orderedInputs = computed(() => currentVendor.value?.inputs ?? []);
  const requiredInputs = computed(
    () => orderedInputs.value.filter((input) => input.required),
  );
  const optionalInputs = computed(
    () => orderedInputs.value.filter((input) => !input.required),
  );
  return { vendorModels, orderedInputs, requiredInputs, optionalInputs };
}
