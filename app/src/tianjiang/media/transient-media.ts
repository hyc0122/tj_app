import crypto from "node:crypto";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

export interface TransientMedia {
  bytes: Buffer;
  mime: string;
  extension: string;
  md5: string;
  size: number;
}

/**
 * Base64 只允许作为单次上传载荷存在；这里完成格式、大小和文件头校验，
 * 调用方随后必须落盘并仅持久化路径、对象键及摘要元数据。
 */
export function decodeTransientMedia(
  value: string,
  expectedKind?: "image" | "audio" | "video",
  maxBytes = 100 * 1024 * 1024,
): TransientMedia {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new Error("媒体上传必须是完整 Base64 data URL");
  const mime = match[1].toLowerCase();
  const extension = MIME_EXTENSIONS[mime];
  if (!extension || (expectedKind && !mime.startsWith(`${expectedKind}/`))) {
    throw new Error("不支持的媒体文件类型");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error("媒体文件为空或超过大小限制");
  if (bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) {
    throw new Error("媒体 Base64 编码无效");
  }
  if (!matchesFileSignature(bytes, extension)) throw new Error("媒体文件头与声明类型不匹配");
  return {
    bytes,
    mime,
    extension,
    md5: crypto.createHash("md5").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

export function matchesFileSignature(bytes: Buffer, extension: string): boolean {
  const ext = extension.toLowerCase().replace(/^\./, "");
  if (ext === "png") {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (ext === "jpg" || ext === "jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (ext === "gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a"
    || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (ext === "webp") {
    return bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (ext === "bmp") return bytes.subarray(0, 2).toString("ascii") === "BM";
  if (ext === "avif") {
    return bytes.subarray(4, 8).toString("ascii") === "ftyp"
      && bytes.subarray(8, 16).toString("ascii").includes("avif");
  }
  if (ext === "mp3") return bytes.subarray(0, 3).toString("ascii") === "ID3"
    || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (ext === "wav") {
    return bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WAVE";
  }
  if (ext === "flac") return bytes.subarray(0, 4).toString("ascii") === "fLaC";
  if (ext === "ogg") return bytes.subarray(0, 4).toString("ascii") === "OggS";
  if (ext === "m4a" || ext === "aac") {
    return bytes.subarray(4, 8).toString("ascii") === "ftyp"
      || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0);
  }
  if (ext === "webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (ext === "mkv") {
    return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (ext === "mp4" || ext === "mov") {
    return bytes.subarray(4, 8).toString("ascii") === "ftyp";
  }
  if (ext === "avi") {
    // 中文注释：AVI 必须同时具备 RIFF 容器和 AVI FourCC，拒绝把 WAV/WEBP 伪装成视频。
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "AVI ";
  }
  return false;
}

/** MIME 必须同时来自已验证扩展名和文件头，禁止统一伪装成 PNG/MP3/MP4。 */
export function resolveVerifiedMediaMime(relativePath: string, header: Buffer): string {
  const ext = relativePath.toLowerCase().includes(".")
    ? relativePath.toLowerCase().split(".").pop()!
    : "";
  const mime = MIME_BY_EXTENSION[ext];
  if (!mime || !matchesFileSignature(header, ext)) {
    throw Object.assign(new Error("参考素材文件头与类型不匹配"), {
      status: 400,
      code: "STORYBOARD_REFERENCE_IDENTITY_MISMATCH",
    });
  }
  return mime;
}
