import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
  await awaitSettingsDependentRead();
  const data = await u.accountDb("o_vendorConfig").select("*");

  // 逐供应商隔离错误：单个模板异常不得拖垮整表，也不得删除数据库记录。
  const list = (
    await Promise.all(
      data.map(async (item) => {
        try {
          let vendor: ReturnType<typeof u.vendor.getVendor> | null = null;
          try {
            vendor = u.vendor.getVendor(item.id!);
          } catch (loadError: any) {
            return {
              id: item.id,
              enable: item.enable,
              models: [],
              inputValues: {},
              configured: false,
              description: "",
              inputs: [],
              author: "",
              name: String(item.id ?? "unknown"),
              version: "1.0",
              loadError: typeof loadError?.message === "string"
                ? loadError.message
                : "供应商模板加载失败",
            };
          }
          if (!vendor) {
            // 模板缺失：返回可诊断项，禁止删除 o_vendorConfig 行。
            return {
              id: item.id,
              enable: item.enable,
              models: [],
              inputValues: {},
              configured: false,
              description: "",
              inputs: [],
              author: "",
              name: String(item.id ?? "unknown"),
              version: "1.0",
              loadError: "供应商模板不存在或无法解析",
            };
          }
          const storedInputs = JSON.parse(item.inputValues ?? "{}") as Record<string, unknown>;
          const inputValues = Object.fromEntries(
            Object.entries(storedInputs).filter(
              ([key, value]) =>
                /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(key)
                && typeof value === "string",
            ),
          ) as Record<string, string>;
          let models: any[] = [];
          try {
            models = await u.vendor.getModelList(item.id!);
          } catch {
            models = [];
          }
          return {
            id: item.id,
            enable: item.enable,
            models,
            // 设置页属于当前认证账号的本地 db2 数据源，可直接显示和编辑本人配置。
            inputValues,
            configured: Object.values(inputValues).some((value) => value.length > 0),
            description: vendor.description ?? "",
            inputs: vendor.inputs,
            author: vendor.author,
            name: vendor.name,
            version: vendor.version ?? "1.0",
          };
        } catch (error: any) {
          return {
            id: item.id,
            enable: item.enable,
            models: [],
            inputValues: {},
            configured: false,
            description: "",
            inputs: [],
            author: "",
            name: String(item.id ?? "unknown"),
            version: "1.0",
            loadError: typeof error?.message === "string" ? error.message : "供应商项处理失败",
          };
        }
      }),
    )
  ).filter((i) => Boolean(i));

  list.sort((a, b) => (a!.id === "tianjiang" ? -1 : b!.id === "tianjiang" ? 1 : 0));
  res.status(200).send(success(list));
});
