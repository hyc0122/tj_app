import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isEletron } from "@/utils/getPath";
import u from "@/utils";
import path from "path";
import fs from "fs";
import {
  currentAccountSkillsRoot,
  ensureCurrentAccountBuiltinSkills,
} from "@/tianjiang/skills/account-skills";
import { requireSharedModelsRoot } from "@/tianjiang/models/shared-models-root";

const router = express.Router();

/** 固定 allowlist：前端只能传这些 key，禁止任意路径与命令拼接。 */
const FOLDER_ALLOWLIST = new Set([
  "data",
  "logs",
  "oss",
  "skills",
  "models",
  "web",
  "serve",
  "vendor",
]);

async function resolveAllowlistedFolder(key: string): Promise<string> {
  if (!FOLDER_ALLOWLIST.has(key) && key !== "") {
    throw new Error("不允许打开该目录");
  }
  // 空字符串表示数据根
  if (key === "" || key === "data") {
    return u.getPath();
  }
  if (key === "skills") {
    // 当前账号 Skills 目录（账号隔离）。
    const dataRoot = u.getPath();
    try {
      await ensureCurrentAccountBuiltinSkills(dataRoot);
    } catch {
      // 打开目录时尽量保证目录存在；安装失败仍返回账号路径。
    }
    return currentAccountSkillsRoot(dataRoot);
  }
  if (key === "models") {
    // 实际生效的共享模型目录（安装包/源码/override）。
    return requireSharedModelsRoot();
  }
  if (key === "vendor") {
    // 当前用户供应商源码目录。
    return u.getPath("vendor");
  }
  const target = u.getPath(key);
  // 二次确认仍在数据根内（skills/models 走专用解析）。
  const dataRoot = path.resolve(u.getPath());
  const resolved = path.resolve(target);
  const relative = path.relative(dataRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("目录路径越界");
  }
  return resolved;
}

async function openDirectorySafely(target: string): Promise<void> {
  fs.mkdirSync(target, { recursive: true });
  const details = fs.lstatSync(target);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("目标不是普通目录");
  }
  // Electron shell.openPath 接受绝对路径，禁止 shell 字符串拼接用户输入。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { shell } = require("electron") as {
    shell: { openPath: (p: string) => Promise<string> };
  };
  const openError = await shell.openPath(target);
  if (openError) {
    throw new Error(openError);
  }
}

export default router.post(
  "/",
  validateFields({
    path: z.string(),
  }),
  async (req, res) => {
    if (!isEletron()) {
      return res.status(400).send(error("仅支持客户端打开文件夹"));
    }
    const key = String(req.body.path ?? "");
    try {
      if (key.includes("\0") || key.includes("..") || path.isAbsolute(key) || key.includes("/") || key.includes("\\")) {
        // 仅允许 allowlist 中的简单 key；空字符串表示数据根。
        if (key !== "") {
          return res.status(400).send(error("不允许打开该目录"));
        }
      }
      if (key !== "" && !FOLDER_ALLOWLIST.has(key)) {
        return res.status(400).send(error("不允许打开该目录"));
      }
      const target = await resolveAllowlistedFolder(key);
      await openDirectorySafely(target);
      res.status(200).send(success("打开文件夹成功"));
    } catch (err: any) {
      res.status(200).send(error(err?.message || "打开文件夹失败"));
    }
  },
);
