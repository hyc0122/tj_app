import type { InjectionKey } from "vue";
import settingStore from "@/stores/setting";
import { useVendorCatalog } from "./useVendorCatalog";
import { useVendorImport } from "./useVendorImport";
import { useVendorModels } from "./useVendorModels";
import { useVendorUpdates } from "./useVendorUpdates";

export function createVendorConfigContext() {
  const { themeSetting } = storeToRefs(settingStore());
  const catalog = useVendorCatalog();
  const models = useVendorModels(catalog);
  const vendorImport = useVendorImport(catalog);
  const vendorUpdates = useVendorUpdates(catalog);

  return {
    ...catalog,
    ...models,
    ...vendorImport,
    ...vendorUpdates,
    themeSetting,
  };
}

export type VendorConfigContext = ReturnType<typeof createVendorConfigContext>;

const vendorConfigKey: InjectionKey<VendorConfigContext> =
  Symbol("vendor-config");

export function provideVendorConfigContext(context: VendorConfigContext) {
  provide(vendorConfigKey, context);
}

export function useVendorConfigContext() {
  const context = inject(vendorConfigKey);
  if (!context) {
    throw new Error($t("settings.vendor.msg.operationFailed"));
  }
  return context;
}
