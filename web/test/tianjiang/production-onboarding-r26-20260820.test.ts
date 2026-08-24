import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_GUIDE_ROUTE,
  PRODUCTION_GUIDE_VERSION,
  createProductionGuideController,
} from "@/views/production/production-guide";

type MockClient = {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
};

function createClient(): MockClient {
  return {
    get: vi.fn(),
    put: vi.fn(),
  };
}

describe("R26 视频生产新手引导稳定生命周期", () => {
  it("同版本完成后自动隐藏；未完成只自动显示一次", async () => {
    const client = createClient();
    client.get.mockResolvedValueOnce({
      code: 0,
      data: { guideId: "production", completedRevision: 0 },
    });
    const controller = createProductionGuideController(client);
    expect(controller.current.value).toBe(-1);
    await controller.initialize();
    expect(controller.current.value).toBe(0);

    client.put.mockResolvedValue({ code: 0, data: { completedRevision: 1 } });
    await controller.complete();
    expect(controller.current.value).toBe(-1);
    expect(client.put).toHaveBeenCalledWith(PRODUCTION_GUIDE_ROUTE, {
      completedRevision: PRODUCTION_GUIDE_VERSION,
    });

    const remountClient = createClient();
    remountClient.get.mockResolvedValue({
      code: 0,
      data: { guideId: "production", completedRevision: PRODUCTION_GUIDE_VERSION },
    });
    const remounted = createProductionGuideController(remountClient);
    await remounted.initialize();
    expect(remounted.current.value).toBe(-1);
  });

  it("手动重播只从第一步显示，不清除或降低服务端完成 revision", async () => {
    const client = createClient();
    client.get.mockResolvedValue({
      code: 0,
      data: { guideId: "production", completedRevision: PRODUCTION_GUIDE_VERSION },
    });
    const controller = createProductionGuideController(client);
    await controller.initialize();
    expect(controller.current.value).toBe(-1);

    controller.replayOnce();
    expect(controller.current.value).toBe(0);
    expect(client.put).not.toHaveBeenCalled();

    client.put.mockResolvedValue({ code: 0, data: { completedRevision: 1 } });
    await controller.complete();
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(client.put.mock.calls[0]?.[1]).toEqual({
      completedRevision: PRODUCTION_GUIDE_VERSION,
    });
  });

  it("保存失败不假完成并给出脱敏中文提示，重试成功后才隐藏且重启不再自动显示", async () => {
    const loadClient = createClient();
    loadClient.get.mockRejectedValue(new Error("E:\\secret\\state.json cookie=abc"));
    const controller = createProductionGuideController(loadClient);
    await expect(controller.initialize()).resolves.toBeUndefined();
    expect(controller.current.value).toBe(-1);

    const saveClient = createClient();
    saveClient.get.mockResolvedValue({
      code: 0,
      data: { guideId: "production", completedRevision: 0 },
    });
    saveClient.put
      .mockRejectedValueOnce(new Error("E:\\private\\db.sqlite SELECT * cookie=abc sk-secret stack.ts:42"))
      .mockResolvedValueOnce({
        code: 0,
        data: { guideId: "production", completedRevision: PRODUCTION_GUIDE_VERSION },
      });
    const saving = createProductionGuideController(saveClient);
    await saving.initialize();
    saving.current.value = 2;
    // 模拟 t-guide 在 finish/skip/close 回调前先把 v-model 置为关闭态。
    saving.current.value = -1;
    await expect(saving.complete()).resolves.toBe(false);
    expect(saving.current.value).toBe(2);
    const errorMessage = (saving as typeof saving & {
      errorMessage?: { value: string };
    }).errorMessage?.value ?? "";
    expect(errorMessage).toBe("新手引导完成状态保存失败，请重试");
    expect(errorMessage).not.toMatch(/private|sqlite|select|cookie|secret|stack/i);

    await expect(saving.complete()).resolves.toBe(true);
    expect(saving.current.value).toBe(-1);
    expect(saveClient.put).toHaveBeenCalledTimes(2);

    const restartedClient = createClient();
    restartedClient.get.mockResolvedValue({
      code: 0,
      data: { guideId: "production", completedRevision: PRODUCTION_GUIDE_VERSION },
    });
    const restarted = createProductionGuideController(restartedClient);
    await restarted.initialize();
    expect(restarted.current.value).toBe(-1);
  });

  it("页面不再绑定组件不存在的 close 事件，新手提示按钮紧邻自动排版且不依赖 localStorage", () => {
    const guideSource = readFileSync(
      path.join(process.cwd(), "src/views/production/production-guide.ts"),
      "utf8",
    );
    const pageSource = readFileSync(
      path.join(process.cwd(), "src/views/production/index.vue"),
      "utf8",
    );
    expect(guideSource).not.toMatch(/localStorage|productionGuideStorageKey/);
    expect(pageSource).not.toContain('@close="completeProductionGuide"');
    expect(pageSource).toContain("ProductionGuideControls");
    expect(pageSource).toContain('class="guide-replay-btn"');
    expect(pageSource).toContain('@click="replayProductionGuideOnce"');
    expect(pageSource.indexOf("guide-replay-btn")).toBeGreaterThan(
      pageSource.indexOf("guide-layout-btn"),
    );
    expect(pageSource).not.toMatch(/activeAccountKey\s*\|\|\s*["']anon["']/);
  });

  it("所有生产工作台语言包都有新手提示文案", () => {
    const localeFiles = [
      "en.json",
      "ja_JP.json",
      "ru_RU.json",
      "th_TH.json",
      "vi-VN.json",
      "zh-CN.json",
      "zh-TW.json",
    ];
    for (const file of localeFiles) {
      const locale = JSON.parse(readFileSync(
        path.join(process.cwd(), "src/locales/language", file),
        "utf8",
      ));
      expect(locale.workbench.production.guideReplay).toBeTruthy();
    }
  });
});
