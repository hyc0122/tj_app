import fs from "node:fs";
import path from "node:path";

import getPath from "@/utils/getPath";
import { currentUserStorage, userStorageRoot } from "../runtime/user-storage-context";

export class ModelPromptPathError extends Error {
  readonly status = 400;
  constructor(message = "提示词路径非法") {
    super(message);
    this.name = "ModelPromptPathError";
  }
}

/** 中文注释：账号级提示词根，禁止落到共享 data/modelPrompt 造成串号。 */
export function accountModelPromptRoot(): string {
  const identity = currentUserStorage();
  if (!identity) throw new Error("缺少中央用户存储上下文");
  const root = path.join(userStorageRoot(getPath(), identity), "modelPrompt");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function assertSafePromptName(name: string): string {
  const value = String(name ?? "").trim();
  if (
    !value
    || value.includes("\0")
    || value.includes("..")
    || value.includes("/")
    || value.includes("\\")
    || path.isAbsolute(value)
    || /^[a-zA-Z]:/.test(value)
    || value.startsWith("\\\\")
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  ) {
    throw new ModelPromptPathError();
  }
  return value;
}

export function assertSafeRelativePromptPath(relative: string): string {
  const value = String(relative ?? "").trim().replace(/\\/g, "/");
  if (
    !value
    || value.includes("\0")
    || value.includes("..")
    || path.isAbsolute(value)
    || /^[a-zA-Z]:/.test(value)
    || value.startsWith("//")
    || !/^(image|video)\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(value)
  ) {
    throw new ModelPromptPathError();
  }
  return value;
}

export function resolveAccountModelPromptFile(relativeOrName: {
  type?: "image" | "video";
  name?: string;
  relativePath?: string;
}): string {
  const root = path.resolve(accountModelPromptRoot());
  const relative = relativeOrName.relativePath
    ? assertSafeRelativePromptPath(relativeOrName.relativePath)
    : `${relativeOrName.type}/${assertSafePromptName(relativeOrName.name ?? "")}.md`;
  const resolved = path.resolve(root, ...relative.split("/"));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new ModelPromptPathError();
  }
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ModelPromptPathError();
  }
  return resolved;
}

export async function readBoundModelPromptContent(vendorId: string, model: string): Promise<string> {
  const { accountDatabase } = await import("@/utils/db");
  const row = await accountDatabase()("o_modelPrompt").where({ vendorId, model }).first();
  if (!row?.path) return "";
  try {
    const file = resolveAccountModelPromptFile({ relativePath: String(row.path).replace(/\\/g, "/") });
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
