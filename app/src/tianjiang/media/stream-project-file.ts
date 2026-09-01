import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { projectDirectory } from "../data/paths";
import { assertManagedPathChainHasNoLinks } from "./project-file-store";

export interface StreamedProjectFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  md5: string;
  sha256: string;
}

/** 带背压的流式落盘：边写边哈希，禁止把整个媒体读成 string。 */
export async function streamProjectFile(
  input: {
    dataRoot: string;
    projectUuid: string;
    userSegment: string;
    relativePath: string;
    chunks: AsyncIterable<Buffer> | Iterable<Buffer>;
    maxBytes: number;
  },
): Promise<StreamedProjectFile> {
  const projectRoot = projectDirectory(input.dataRoot, input.projectUuid, input.userSegment);
  const normalized = input.relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith("files/") && !normalized.startsWith(".staging/")) {
    throw Object.assign(new Error("画布文件路径不在白名单内"), { status: 422, errorCode: "CANVAS_IMPORT_REQUEST_INVALID" });
  }
  const absolutePath = path.resolve(projectRoot, ...normalized.split("/"));
  if (!absolutePath.startsWith(path.resolve(projectRoot) + path.sep)) {
    throw new Error("画布文件路径越界");
  }
  const parent = path.dirname(absolutePath);
  fs.mkdirSync(parent, { recursive: true });
  assertManagedPathChainHasNoLinks(input.dataRoot, parent);
  const md5 = crypto.createHash("md5");
  const sha256 = crypto.createHash("sha256");
  const handle = fs.openSync(absolutePath, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of input.chunks) {
      size += chunk.length;
      if (size > input.maxBytes) {
        throw Object.assign(new Error("请求体超过画布上限"), {
          status: 413,
          errorCode: "CANVAS_BODY_TOO_LARGE",
        });
      }
      md5.update(chunk);
      sha256.update(chunk);
      fs.writeSync(handle, chunk);
    }
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  let directoryHandle: number | undefined;
  try {
    directoryHandle = fs.openSync(parent, "r");
    fs.fsyncSync(directoryHandle);
  } catch {
    // 中文注释：目录 fsync 在部分 Windows 句柄上不可用，文件本身已 fsync。
  } finally {
    if (directoryHandle !== undefined) fs.closeSync(directoryHandle);
  }
  return {
    relativePath: normalized,
    absolutePath,
    size,
    md5: md5.digest("hex"),
    sha256: sha256.digest("hex"),
  };
}

export async function streamProjectFileFromBuffer(
  input: Omit<Parameters<typeof streamProjectFile>[0], "chunks"> & { data: Buffer },
): Promise<StreamedProjectFile> {
  return streamProjectFile({
    ...input,
    chunks: [input.data],
  });
}
