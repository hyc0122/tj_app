import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { listNativeDreaminaModels } from "@/tianjiang/model-providers/native-provider-registry";
import { getModelCatalogVersion } from "@/tianjiang/model-providers/model-catalog-invalidation";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    type: z.enum(["text", "image", "video", "all"]),
  }),
  async (req, res) => {
    const { type } = req.body;
    const { getSettingsCalibrationState } = await import("@/tianjiang/sync/profile-settings-adapter");
    const calibrationState = getSettingsCalibrationState();
    // 供应商目录属账号配置；项目工作区内选择模型时不得读项目空白种子
    const native = listNativeDreaminaModels(type);
    const dataList = await u.accountDb("o_vendorConfig").select("id").where("enable", 1);
    const vendorRows = Array.isArray(dataList) ? dataList : [];
    const providers: Array<{ providerId: string; providerName: string; state: string; reason?: string }> = [];
    const result = await Promise.all(
      vendorRows.map(async (data) => {
        try {
          const vendorData = u.vendor.getVendor(data.id!);
          const models = await u.vendor.getModelList(data.id!);
          const filtered =
            type === "all"
              ? models.filter((item: { type: string }) => item.type !== "video")
              : models.filter((item: { type: string }) => item.type === type);
          providers.push({
            providerId: String(data.id),
            providerName: vendorData.name,
            state: "ready",
          });
          return filtered.map((item: {
            name: string;
            modelName: string;
            type: string;
            modes?: string[];
            aspectRatios?: string[];
            resolutions?: string[];
            minReferences?: number;
            maxReferences?: number;
          }) => ({
            id: data.id,
            label: item.name,
            value: item.modelName,
            type: item.type,
            name: vendorData.name,
            modes: item.modes ?? [item.type],
            aspectRatios: item.aspectRatios ?? ["16:9", "9:16"],
            resolutions: item.resolutions ?? ["1K", "2K"],
            minReferences: item.minReferences ?? 0,
            maxReferences: item.maxReferences ?? (item.type === "image" ? 4 : 1),
          }));
        } catch (error) {
          // 单个供应商模板失败不得拖垮原生目录。
          providers.push({
            providerId: String(data.id),
            providerName: String(data.id),
            state: "failed",
            reason: error instanceof Error ? error.message : "供应商目录失败",
          });
          return [];
        }
      }),
    );
    providers.push({
      providerId: "native:dreamina-cli",
      providerName: "即梦 CLI",
      state: native.some((item) => !item.disabled) ? "ready" : "not_checked",
      reason: native.find((item) => item.disabledReason)?.disabledReason,
    });
    const merged = [...result.flat(), ...native];
    if (merged.length === 0) {
      return res.status(404).send({ error: "模型未找到" });
    }
    const { currentUserStorage } = await import("@/tianjiang/runtime/user-storage-context");
    const identity = currentUserStorage();
    res.status(200).send(success({
      accountScopeId: identity ? `account:${identity.userId}` : "",
      catalogVersion: getModelCatalogVersion(),
      calibrationState,
      items: merged,
      providers,
    }));
  },
);
