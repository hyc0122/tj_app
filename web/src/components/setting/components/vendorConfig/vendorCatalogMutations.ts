/**
 * 供应商启用/删除等变更请求（不含凭据读写）。
 */
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { modelCatalogStore } from "@/features/models/modelCatalogStore";
import type { VendorItem } from "./types";

/** 切换供应商启用状态；失败时回滚本地 enable。 */
export function enableVendorToggle(item: VendorItem, value: number): void {
  const previous = value === 1 ? 0 : 1;
  axios
    .post("/setting/vendorConfig/enableVendor", { id: item.id, enable: value })
    .then(() => {
      modelCatalogStore.invalidateAll();
    })
    .catch(() => {
      item.enable = previous;
    });
}

/** 确认后删除当前供应商并刷新列表。 */
export function confirmDeleteVendor(options: {
  vendor: VendorItem;
  onDeleted: () => void;
}): void {
  const dialog = DialogPlugin.confirm({
    theme: "danger",
    header: $t("settings.vendor.msg.deleteVendorConfirm"),
    body: $t("settings.vendor.msg.deleteVendorBody", {
      name: options.vendor.name,
    }),
    confirmBtn: {
      content: $t("settings.vendor.msg.confirmDelete"),
      theme: "danger",
    },
    cancelBtn: $t("settings.vendor.msg.cancel"),
    onConfirm: () => {
      axios
        .post("/setting/vendorConfig/deleteVendor", {
          id: options.vendor.id,
        })
        .then(() => {
          modelCatalogStore.invalidateAll();
          window.$message.success($t("settings.vendor.msg.vendorDeleted"));
          options.onDeleted();
          dialog.destroy();
        })
        .catch((error) => {
          window.$message.error(
            `${$t("settings.vendor.msg.deleteFailed")}${error.message}`,
          );
        });
    },
  });
}
