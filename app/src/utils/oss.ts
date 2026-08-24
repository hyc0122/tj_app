import isPathInside from "is-path-inside";
import getPath, { isEletron } from "@/utils/getPath";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { currentUserStorage, userStorageRoot } from "@/tianjiang/runtime/user-storage-context";
import {
  deleteProjectFile,
  projectFileExists,
  readProjectFile,
  resolveProjectFilePath,
  writeProjectFileAtomic,
} from "@/tianjiang/media/project-file-store";

// 规范化路径：去除前导斜杠，并将路径分隔符统一转换为系统分隔符
function normalizeUserPath(userPath: string): string {
  // 去除前导的 / 或 \
  const trimmedPath = userPath.replace(/^[/\\]+/, "");
  // 将所有 / 替换为系统路径分隔符（path.sep）
  // 这样在 Windows 上会转为 \，在 Unix 上保持 /
  return trimmedPath.split("/").join(path.sep);
}

// 校验路径
function resolveSafeLocalPath(userPath: string, rootDir: string): string {
  const safePath = normalizeUserPath(userPath);
  const absPath = path.join(rootDir, safePath);
  if (!isPathInside(absPath, rootDir)) {
    throw new Error(`${userPath} 不在 OSS 根目录内`);
  }
  return absPath;
}

/**
 * 中文注释：账号级公共资源（美术风格/手册等）路径前缀；这些资源不得被项目化搬迁。
 * 无 projectUuid 时仍写账号 oss；有 projectUuid 时其余业务文件进入项目 files。
 */
const ACCOUNT_SCOPED_PREFIXES = [
  "artStyle/",
  "art-style/",
  "manual/",
  "account/",
  "skills/",
];

function isAccountScopedPath(userRelPath: string): boolean {
  const normalized = userRelPath.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return ACCOUNT_SCOPED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function projectContext(): { dataRoot: string; projectUuid: string; userSegment: string } | undefined {
  const context = currentUserStorage();
  if (!context?.projectUuid) return undefined;
  return {
    dataRoot: getPath(),
    projectUuid: context.projectUuid,
    userSegment: context.segment,
  };
}

/** 中文注释：把旧业务相对路径收口到项目 files 逻辑路径，供音频 DTO 与读写共用。 */
export function toProjectLogicalPath(userRelPath: string): string {
  const normalized = userRelPath.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (normalized.startsWith("files/")) return normalized;
  // 旧业务常写 <legacyProjectId>/images/...；项目上下文下去掉首段数字/id 后仍保留类型目录。
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2 && /^(images|videos|audios|thumbnails|references|imports|attachments|legacy)$/i.test(parts[1]!)) {
    return `files/${parts.slice(1).join("/")}`;
  }
  if (parts.length >= 1 && /^(images|videos|audios|thumbnails|references|imports|attachments|legacy)$/i.test(parts[0]!)) {
    return `files/${parts.join("/")}`;
  }
  return `files/attachments/${parts.join("/")}`;
}

class OSS {
  /**
   * 等待根目录初始化完成。用于保证所有文件操作在目录已创建后执行。
   * @private
   */
  private async ensureInit(): Promise<string> {
    const rootDir = currentOssRoot();
    await fs.mkdir(rootDir, { recursive: true });
    return rootDir;
  }

  /**
   * 获取指定相对路径文件的访问 URL。
   * 中文注释：项目上下文返回受保护 runtime files URL，不暴露真实磁盘路径。
   */
  async getFileUrl(userRelPath: string, prefix?: string): Promise<string> {
    const project = projectContext();
    if (project && !isAccountScopedPath(userRelPath)) {
      const logical = toProjectLogicalPath(userRelPath);
      const underFiles = logical.startsWith("files/") ? logical.slice("files/".length) : logical;
      let base = `/api/tianjiang/runtime/projects/${project.projectUuid}/files/`;
      if (process.env.NODE_ENV == "dev") {
        base = `http://127.0.0.1:10588/api/tianjiang/runtime/projects/${project.projectUuid}/files/`;
      }
      if (isEletron()) {
        base = `http://127.0.0.1:${process.env.PORT}/api/tianjiang/runtime/projects/${project.projectUuid}/files/`;
      }
      return `${base}${underFiles.split(path.sep).join("/")}`;
    }
    if (!prefix) prefix = "oss";
    await this.ensureInit();
    const safePath = normalizeUserPath(userRelPath);
    // URL 始终使用 /，所以这里需要将系统分隔符转回 /
    let url = `/${prefix}/`;
    if (process.env.ossURL && process.env.ossURL !== "") url = process.env.ossURL + `/${prefix}/`;
    if (process.env.NODE_ENV == "dev") url = `http://127.0.0.1:10588/${prefix}/`;
    if (isEletron()) url = `http://127.0.0.1:${process.env.PORT}/${prefix}/`;
    return `${url}${safePath.split(path.sep).join("/")}`;
  }

  /**
   * 读取指定路径的文件内容为 Buffer。
   */
  async getFile(userRelPath: string): Promise<Buffer> {
    const project = projectContext();
    if (project && !isAccountScopedPath(userRelPath)) {
      return readProjectFile(
        project.dataRoot,
        project.projectUuid,
        project.userSegment,
        toProjectLogicalPath(userRelPath),
      );
    }
    const rootDir = await this.ensureInit();
    return fs.readFile(resolveSafeLocalPath(userRelPath, rootDir));
  }

  /**
   * 读取图片文件并转换为 base64 编码的 Data URL。
   */
  async getImageBase64(userRelPath: string): Promise<string> {
    const data = await this.getFile(userRelPath);
    const ext = path.extname(userRelPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".tiff": "image/tiff",
      ".tif": "image/tiff",
      ".mp4": "video/mp4",
      ".mp3": "audio/mpeg",
    };

    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      throw new Error(`不支持的图片格式: ${ext}。支持的格式: ${Object.keys(mimeTypes).join(", ")}`);
    }
    const base64 = data.toString("base64");
    return `data:${mimeType};base64,${base64}`;
  }

  /**
   * 删除指定路径的文件。
   */
  async deleteFile(userRelPath: string): Promise<void> {
    const project = projectContext();
    if (project && !isAccountScopedPath(userRelPath)) {
      deleteProjectFile(
        project.dataRoot,
        project.projectUuid,
        project.userSegment,
        toProjectLogicalPath(userRelPath),
      );
      return;
    }
    const rootDir = await this.ensureInit();
    await fs.unlink(resolveSafeLocalPath(userRelPath, rootDir));
  }

  /**
   * 删除指定路径的文件夹及其所有内容。
   */
  async deleteDirectory(userRelPath: string): Promise<void> {
    const project = projectContext();
    if (project && !isAccountScopedPath(userRelPath)) {
      // 中文注释：项目上下文仅允许删除 files 内相对目录；路径安全由 resolveProjectFilePath 保证。
      const logical = toProjectLogicalPath(userRelPath);
      const absPath = resolveProjectFilePath(
        project.dataRoot,
        project.projectUuid,
        project.userSegment,
        logical.endsWith("/") ? `${logical}.keep` : `${logical}/.keep`,
      );
      const dir = path.dirname(absPath);
      await fs.rm(dir, { recursive: true, force: true });
      return;
    }
    const rootDir = await this.ensureInit();
    const absPath = resolveSafeLocalPath(userRelPath, rootDir);
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`${userRelPath} 不是文件夹`);
    }
    await fs.rm(absPath, { recursive: true, force: true });
  }

  /**
   * 将数据写入指定路径的新文件或覆盖已有文件。
   * 中文注释：存在 projectUuid 时写入项目 files，禁止继续只进入账号级 oss 根。
   */
  async writeFile(userRelPath: string, data: Buffer | string): Promise<void> {
    const project = projectContext();
    if (project && !isAccountScopedPath(userRelPath)) {
      writeProjectFileAtomic(
        project.dataRoot,
        project.projectUuid,
        project.userSegment,
        toProjectLogicalPath(userRelPath),
        data,
      );
      return;
    }
    const rootDir = await this.ensureInit();
    const absPath = resolveSafeLocalPath(userRelPath, rootDir);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    // 如果 data 是 string，则视为 base64 编码，先解码再写入
    // 自动去除可能存在的 Data URL 前缀（如 "data:image/png;base64,"）
    const buffer = typeof data === "string" ? Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64") : data;
    await fs.writeFile(absPath, buffer);
  }

  /**
   * 检查指定路径文件是否存在。
   */
  async fileExists(userRelPath: string): Promise<boolean> {
    const project = projectContext();
    if (project && !isAccountScopedPath(userRelPath)) {
      return projectFileExists(
        project.dataRoot,
        project.projectUuid,
        project.userSegment,
        toProjectLogicalPath(userRelPath),
      );
    }
    const rootDir = await this.ensureInit();
    try {
      const stat = await fs.stat(resolveSafeLocalPath(userRelPath, rootDir));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * 获取图片的缩略图 URL（最长边不超过 512px，等比缩放）。
   */
  async getSmallImageUrl(userRelPath: string): Promise<string> {
    return (await this.getFileUrl(userRelPath)) + "?size=20";
  }
}

export function currentOssRoot(): string {
  const context = currentUserStorage();
  return context
    ? path.join(userStorageRoot(getPath(), context), "oss")
    : getPath("oss");
}

export default new OSS();
