import crypto from "node:crypto";
import fs from "node:fs";

export interface FileChecksum {
  size: number;
  md5: string;
  crc64?: string;
}

export async function checksumFile(
  filename: string,
  options: { crc64?: boolean; highWaterMark?: number } = {},
): Promise<FileChecksum> {
  const md5 = crypto.createHash("md5");
  let size = 0;
  let crc = 0n;
  const stream = fs.createReadStream(filename, {
    highWaterMark: options.highWaterMark ?? 1024 * 1024,
  });
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    md5.update(chunk);
    if (options.crc64) crc = updateCRC64(crc, chunk);
  }
  return {
    size,
    md5: md5.digest("hex"),
    ...(options.crc64 ? { crc64: crc.toString(10) } : {}),
  };
}

export function checksumBuffer(bytes: Buffer): Required<FileChecksum> {
  return {
    size: bytes.length,
    md5: crypto.createHash("md5").update(bytes).digest("hex"),
    crc64: updateCRC64(0n, bytes).toString(10),
  };
}

// 阿里云 OSS 的 x-oss-hash-crc64ecma 使用 Go hash/crc64.ECMA 同款反射表。
const CRC64_REFLECTED_POLYNOMIAL = 0xc96c5795d7870f42n;
const UINT64_MASK = 0xffffffffffffffffn;
const CRC64_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = BigInt(index);
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1n) !== 0n
      ? (crc >> 1n) ^ CRC64_REFLECTED_POLYNOMIAL
      : crc >> 1n;
  }
  return crc & UINT64_MASK;
});

function updateCRC64(initial: bigint, chunk: Buffer): bigint {
  // Go crc64.Update 会在每个分块前后取反，因此这里可直接接续上个分块的结果。
  let crc = (~initial) & UINT64_MASK;
  for (const byte of chunk) {
    const tableIndex = Number((crc ^ BigInt(byte)) & 0xffn);
    crc = CRC64_TABLE[tableIndex] ^ (crc >> 8n);
  }
  return (~crc) & UINT64_MASK;
}
