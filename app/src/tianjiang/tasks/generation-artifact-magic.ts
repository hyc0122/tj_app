/**
 * 产物文件头/容器类型校验。application/octet-stream 不得单独放行。
 */
import type { GenerationArtifactMediaType } from "./generation-task-artifacts";

export function assertGenerationArtifactMagic(
  mediaType: GenerationArtifactMediaType,
  bytes: Buffer,
): void {
  if (bytes.length < 12) throw new Error("产物文件头过短");
  if (mediaType === "video") {
    if (hasMp4Ftyp(bytes) || hasWebmEbml(bytes)) return;
    throw new Error("产物不是可采用的视频容器");
  }
  if (mediaType === "image") {
    if (hasPng(bytes) || hasJpeg(bytes) || hasGif(bytes) || hasWebp(bytes)) return;
    throw new Error("产物不是可采用的图片文件");
  }
  if (hasWav(bytes) || hasMp3(bytes)) return;
  throw new Error("产物不是可采用的音频文件");
}

function hasMp4Ftyp(bytes: Buffer): boolean {
  if (bytes.length < 8) return false;
  return bytes.subarray(4, 8).toString("ascii") === "ftyp";
}

function hasWebmEbml(bytes: Buffer): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x1a
    && bytes[1] === 0x45
    && bytes[2] === 0xdf
    && bytes[3] === 0xa3;
}

function hasPng(bytes: Buffer): boolean {
  return bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
}

function hasJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function hasGif(bytes: Buffer): boolean {
  const header = bytes.subarray(0, 6).toString("ascii");
  return header === "GIF87a" || header === "GIF89a";
}

function hasWebp(bytes: Buffer): boolean {
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function hasWav(bytes: Buffer): boolean {
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WAVE";
}

function hasMp3(bytes: Buffer): boolean {
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") return true;
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}
