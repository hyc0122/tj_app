import fs from "node:fs";
import path from "node:path";

import { checksumFile } from "./checksum";

export interface RangeSource {
  readFrom(offset: number): AsyncIterable<Buffer>;
}

export async function downloadWithResume(
  source: RangeSource,
  destination: string,
  expectedSize: number,
  expectedMD5: string,
): Promise<void> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || !/^[0-9a-f]{32}$/i.test(expectedMD5)) {
    throw new Error("对象校验参数无效");
  }
  const resolvedDestination = path.resolve(destination);
  fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true });
  const partial = `${resolvedDestination}.part`;
  let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  if (offset > expectedSize) {
    fs.rmSync(partial, { force: true });
    offset = 0;
  }

  const stream = fs.createWriteStream(partial, { flags: offset === 0 ? "w" : "a" });
  try {
    for await (const chunk of source.readFrom(offset)) {
      if (!Buffer.isBuffer(chunk)) throw new Error("下载数据块格式无效");
      if (offset + chunk.length > expectedSize) throw new Error("下载对象长度超出清单");
      await writeChunk(stream, chunk);
      offset += chunk.length;
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  await closeStream(stream);

  const checksum = await checksumFile(partial);
  if (checksum.size !== expectedSize || checksum.md5.toLowerCase() !== expectedMD5.toLowerCase()) {
    fs.rmSync(partial, { force: true });
    throw new Error("对象摘要校验失败");
  }

  publishVerifiedFile(partial, resolvedDestination);
}

function writeChunk(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function publishVerifiedFile(partial: string, destination: string): void {
  const previous = `${destination}.previous`;
  fs.rmSync(previous, { force: true });
  let movedExisting = false;
  try {
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, previous);
      movedExisting = true;
    }
    // 校验完成后才切换正式文件，避免中断或摘要错误污染可用版本。
    fs.renameSync(partial, destination);
    if (movedExisting) fs.rmSync(previous, { force: true });
  } catch (error) {
    if (!fs.existsSync(destination) && movedExisting && fs.existsSync(previous)) {
      fs.renameSync(previous, destination);
    }
    throw error;
  }
}
