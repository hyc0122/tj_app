import type { IncomingMessage } from "node:http";

const MAX_MULTIPART_BYTES = 8 * 1024 * 1024;

export interface RestrictedMultipartFile {
  fieldName: string;
  filename: string;
  mime: string;
  buffer: Buffer;
}

/**
 * 只解析单个 file 字段的受控 multipart，禁止无边界的任意 JSON/base64。
 */
export async function parseSingleMultipartFile(
  req: IncomingMessage,
  options: { fieldName?: string; maxBytes?: number } = {},
): Promise<RestrictedMultipartFile> {
  const fieldName = options.fieldName ?? "file";
  const maxBytes = options.maxBytes ?? MAX_MULTIPART_BYTES;
  const contentType = String(req.headers["content-type"] ?? "");
  const boundaryMatch = contentType.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw Object.assign(new Error("请使用 multipart 上传单张图片"), { status: 400 });
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes + 64 * 1024) {
      throw Object.assign(new Error("图片超过大小上限"), { status: 400 });
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks, size);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(body, delimiter).slice(1);
  for (const part of parts) {
    if (part.length <= 4) continue;
    const headerEnd = indexOfBuffer(part, Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;
    const header = part.subarray(0, headerEnd).toString("utf8");
    if (/name="file"/i.test(header) === false && !new RegExp(`name="${fieldName}"`, "i").test(header)) {
      continue;
    }
    if (!/filename="/i.test(header)) {
      continue;
    }
    let payload = part.subarray(headerEnd + 4);
    if (payload.subarray(-2).toString() === "\r\n") payload = payload.subarray(0, -2);
    if (payload.length > maxBytes) {
      throw Object.assign(new Error("图片超过大小上限"), { status: 400 });
    }
    const filename = header.match(/filename="([^"]*)"/i)?.[1] ?? "upload.bin";
    const mime = header.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "";
    return { fieldName, filename, mime, buffer: payload };
  }
  throw Object.assign(new Error("缺少名为 file 的图片字段"), { status: 400 });
}

/**
 * 解析受控 multipart 的文本字段与多个 file。
 * 中文注释：只接受当前请求体内的文件字节，禁止任意磁盘路径或 JSON/base64 旁路。
 */
export async function parseRestrictedMultipart(
  req: IncomingMessage,
  options: { maxFileBytes?: number; maxFiles?: number; maxTotalBytes?: number } = {},
): Promise<{ fields: Record<string, string>; files: RestrictedMultipartFile[] }> {
  const maxFileBytes = options.maxFileBytes ?? MAX_MULTIPART_BYTES;
  const maxFiles = options.maxFiles ?? 30;
  const maxTotalBytes = options.maxTotalBytes ?? maxFileBytes * Math.min(maxFiles, 8) + 64 * 1024;
  const contentType = String(req.headers["content-type"] ?? "");
  const boundaryMatch = contentType.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw Object.assign(new Error("请使用 multipart 上传文件"), { status: 400 });
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxTotalBytes) {
      throw Object.assign(new Error("上传内容超过大小上限"), { status: 400 });
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks, size);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(body, delimiter).slice(1);
  const fields: Record<string, string> = {};
  const files: RestrictedMultipartFile[] = [];
  for (const part of parts) {
    if (part.length <= 4) continue;
    const headerEnd = indexOfBuffer(part, Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;
    const header = part.subarray(0, headerEnd).toString("utf8");
    const fieldName = header.match(/name="([^"]*)"/i)?.[1] ?? "";
    if (!fieldName) continue;
    let payload = part.subarray(headerEnd + 4);
    if (payload.subarray(-2).toString() === "\r\n") payload = payload.subarray(0, -2);
    const filename = header.match(/filename="([^"]*)"/i)?.[1];
    if (filename != null && filename !== "") {
      if (files.length >= maxFiles) {
        throw Object.assign(new Error("单批文件数量超过上限"), { status: 400 });
      }
      if (payload.length > maxFileBytes) {
        throw Object.assign(new Error("文件超过大小上限"), { status: 400 });
      }
      files.push({
        fieldName,
        filename,
        mime: header.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "",
        buffer: payload,
      });
      continue;
    }
    fields[fieldName] = payload.toString("utf8");
  }
  return { fields, files };
}

function splitBuffer(source: Buffer, delimiter: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  while (start <= source.length) {
    const found = indexOfBuffer(source, delimiter, start);
    if (found < 0) {
      parts.push(source.subarray(start));
      break;
    }
    parts.push(source.subarray(start, found));
    start = found + delimiter.length;
  }
  return parts;
}

function indexOfBuffer(source: Buffer, search: Buffer, from = 0): number {
  return source.indexOf(search, from);
}
