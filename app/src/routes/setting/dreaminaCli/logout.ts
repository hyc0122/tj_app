import express from "express";
import { z } from "zod";

import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { DREAMINA_ERROR } from "@/tianjiang/model-providers/dreamina-cli/contracts";
import { clearDreaminaAuthorizationSessions } from "@/tianjiang/model-providers/dreamina-cli/authorization-flow";
import { runDreaminaLogout } from "@/tianjiang/model-providers/dreamina-cli/provider";
import { writeDreaminaRuntimeState } from "@/tianjiang/model-providers/dreamina-cli/runtime-state-store";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    confirm: z.literal(true),
  }),
  async (_req, res) => {
    try {
      await runDreaminaLogout();
      clearDreaminaAuthorizationSessions();
      await writeDreaminaRuntimeState({
        account: { state: "logged_out", refreshedAt: Date.now() },
      });
      const { invalidateDreaminaCapabilityCache } = await import("@/tianjiang/model-providers/dreamina-cli/capability-cache");
      const { bumpModelCatalogVersion } = await import("@/tianjiang/model-providers/model-catalog-invalidation");
      invalidateDreaminaCapabilityCache();
      bumpModelCatalogVersion("dreamina-logout");
      return res.status(200).send(success({ loggedOut: true }));
    } catch (err) {
      return res.status(400).send(error(
        err instanceof Error ? err.message : "退出即梦登录失败",
        { code: DREAMINA_ERROR.definiteFailure },
        400,
      ));
    }
  },
);
