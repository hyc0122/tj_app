import express from "express";

import { success } from "@/lib/responseFormat";
import { getModelCatalogVersion } from "@/tianjiang/model-providers/model-catalog-invalidation";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  const { getSettingsCalibrationState } = await import("@/tianjiang/sync/profile-settings-adapter");
  const { currentUserStorage } = await import("@/tianjiang/runtime/user-storage-context");
  const identity = currentUserStorage();
  res.status(200).send(success({
    accountScopeId: identity ? `account:${identity.userId}` : "",
    catalogVersion: getModelCatalogVersion(),
    calibrationState: getSettingsCalibrationState(),
  }));
});
