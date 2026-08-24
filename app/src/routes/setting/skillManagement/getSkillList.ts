import express from "express";
import { success, error } from "@/lib/responseFormat";
import fg from "fast-glob";
import u from "@/utils";
import {
  ensureCurrentAccountBuiltinSkills,
  resolveAccountSkillFile,
} from "@/tianjiang/skills/account-skills";

const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    const { awaitSettingsDependentRead } = await import("@/tianjiang/sync/profile-settings-adapter");
    await awaitSettingsDependentRead();
    const status = await ensureCurrentAccountBuiltinSkills(u.getPath());
    const entries = await fg("**/*.md", {
      cwd: status.skillsRoot.replace(/\\/g, "/"),
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    // 目录枚举与随后读写使用同一安全解析器，拒绝 junction/软链接逃逸。
    for (const entry of entries) {
      resolveAccountSkillFile(status.skillsRoot, entry, { mustExist: true });
    }
    res.status(200).send(success({
      entries,
      diagnostic: entries.length > 0
        ? null
        : `当前账号 Skills 目录为空；内置基线版本 ${status.manifestVersion} 未提供 Markdown 文件。`,
      builtin: {
        manifestVersion: status.manifestVersion,
        copied: status.copied.length,
        skipped: status.skipped.length,
      },
    }));
  } catch (reason) {
    res.status(503).send(error(
      reason instanceof Error ? `Skills 加载失败：${reason.message}` : "Skills 加载失败",
    ));
  }
});
