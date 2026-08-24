import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEVICE_FILE = "tianjiang-device-id";

export function getStableDeviceUUID(dataDirectory: string): string {
  const file = path.join(dataDirectory, DEVICE_FILE);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(existing)) return existing;
  } catch {
    // 首次运行时文件不存在，进入安全创建流程。
  }
  fs.mkdirSync(dataDirectory, { recursive: true });
  const id = crypto.randomUUID();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, id, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ACL 由系统管理；文件仍仅位于当前用户数据目录。
  }
  return id;
}
