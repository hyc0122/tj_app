import fs from "node:fs";
import path from "node:path";

import {
  parseClientGuideId,
  parseGuideState,
  parseOnboardingState,
  type ClientGuideId,
  type GuideState,
  type OnboardingState,
} from "./contracts";

/**
 * 引导完成状态按 businessUserId + deviceUuid 隔离落盘。
 */
export class OnboardingStore {
  constructor(private readonly dataRoot: string) {}

  private filePath(userId: number, deviceUuid: string): string {
    const safeDevice = deviceUuid.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(
      this.dataRoot,
      "client-state",
      "onboarding",
      `user-${userId}`,
      `${safeDevice}.json`,
    );
  }

  get(userId: number, deviceUuid: string): OnboardingState | null {
    try {
      const file = this.filePath(userId, deviceUuid);
      if (!fs.existsSync(file)) return null;
      return parseOnboardingState(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  put(
    userId: number,
    deviceUuid: string,
    completedRevision: number,
  ): OnboardingState {
    const state: OnboardingState = {
      businessUserId: userId,
      deviceUuid,
      completedRevision,
      completedAt: new Date().toISOString(),
    };
    parseOnboardingState(state);
    const file = this.filePath(userId, deviceUuid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    return state;
  }

  private guideFilePath(
    guideId: ClientGuideId,
    userId: number,
    deviceUuid: string,
  ): string {
    const safeGuideId = parseClientGuideId(guideId);
    const safeDevice = deviceUuid.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(
      this.dataRoot,
      "client-state",
      "guides",
      safeGuideId,
      `user-${userId}`,
      `${safeDevice}.json`,
    );
  }

  getGuide(
    guideId: ClientGuideId,
    userId: number,
    deviceUuid: string,
  ): GuideState | null {
    const file = this.guideFilePath(guideId, userId, deviceUuid);
    try {
      return parseGuideState(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      // 中文注释：只有真正不存在才表示“未完成”；损坏或不可读必须向路由传播并保持引导隐藏。
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      throw error;
    }
  }

  putGuide(
    guideId: ClientGuideId,
    userId: number,
    deviceUuid: string,
    completedRevision: number,
  ): GuideState {
    const safeGuideId = parseClientGuideId(guideId);
    const existing = this.getGuide(safeGuideId, userId, deviceUuid);
    // 中文注释：完成版本只能单调前进，手动重播或旧 renderer 不得清除完成记录。
    if (existing && existing.completedRevision >= completedRevision) return existing;

    const state: GuideState = {
      guideId: safeGuideId,
      businessUserId: userId,
      deviceUuid,
      completedRevision,
      completedAt: new Date().toISOString(),
    };
    parseGuideState(state);
    const file = this.guideFilePath(safeGuideId, userId, deviceUuid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    return state;
  }
}
