#!/usr/bin/env node
/**
 * 维护者显式刷新即梦批准发行清单。禁止被产品 UI 调用。
 * 官方 version.json 经常 404 且 CLI 只返回 commit 脏标签，身份以内容 SHA-256 为准。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "lf3-static.bytednsdoc.com";
const PREFIX = "/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/";
const VERSION_URL = `https://${HOST}${PREFIX}version.json`;
const WINDOWS_URL = `https://${HOST}${PREFIX}dreamina_cli_windows_amd64.exe`;

function assertApproved(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error(`拒绝非 HTTPS: ${raw}`);
  if (parsed.username || parsed.password) throw new Error(`拒绝带凭据 URL: ${parsed.host}`);
  if (parsed.hostname !== HOST) throw new Error(`拒绝非官方 host: ${parsed.hostname}`);
  if (!parsed.pathname.startsWith(PREFIX)) throw new Error(`拒绝非官方路径: ${parsed.pathname}`);
  return parsed;
}

async function fetchApproved(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    assertApproved(current);
    const response = await fetch(current, { redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      if (!next) throw new Error("重定向缺少 Location");
      current = new URL(next, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`${current} HTTP ${response.status}`);
    return { url: current, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  throw new Error("重定向次数过多");
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function inspectPeMachine(buffer) {
  if (buffer.length < 0x88 || buffer.toString("ascii", 0, 2) !== "MZ") return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length) return null;
  if (buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return null;
  return buffer.readUInt16LE(peOffset + 4);
}

function parseOfficialLabel(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === "string" && parsed.version && parsed.version !== "unknown") {
      return parsed.version;
    }
  } catch {
    // 非 JSON 标签忽略。
  }
  return undefined;
}

const platforms = process.argv.includes("--platform")
  ? process.argv.filter((_, index, list) => list[index - 1] === "--platform")
  : ["windows-x64"];

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "resources", "dreamina-cli", "approved-releases.json");
const previous = fs.existsSync(out) ? fs.readFileSync(out) : null;

try {
  const versionMeta = await fetchApproved(VERSION_URL).then((item) => {
    try {
      return JSON.parse(item.bytes.toString("utf8"));
    } catch {
      return {};
    }
  }).catch(() => null);

  const semantic = versionMeta && typeof versionMeta === "object"
    ? String(versionMeta.version ?? versionMeta.latest ?? "")
    : "";
  const officialSemver = /^\d+\.\d+\.\d+/.test(semantic) ? semantic : "";

  const releases = [];
  if (platforms.includes("windows-x64")) {
    const downloaded = await fetchApproved(WINDOWS_URL);
    if (inspectPeMachine(downloaded.bytes) !== 0x8664) {
      throw new Error("官方 Windows 发行物不是 x64 PE");
    }
    const digest = sha256(downloaded.bytes);
    if (!digest || digest.length !== 64) throw new Error("无法计算官方发行物内容身份");
    releases.push({
      releaseId: digest,
      ...(officialSemver ? { version: officialSemver } : {}),
      platform: "windows-x64",
      url: WINDOWS_URL,
      size: downloaded.bytes.length,
      sha256: digest,
      publishedAt: new Date().toISOString(),
    });
  }

  if (platforms.includes("linux-x64")) {
    const linuxUrl = versionMeta?.linuxUrl
      || versionMeta?.linux_x64
      || versionMeta?.linux
      || versionMeta?.downloads?.["linux-x64"];
    if (typeof linuxUrl !== "string") {
      throw new Error("官方 version.json 未提供 Linux x64 发行物，拒绝猜测 URL");
    }
    assertApproved(linuxUrl);
    const downloaded = await fetchApproved(linuxUrl);
    const digest = sha256(downloaded.bytes);
    releases.push({
      releaseId: digest,
      ...(officialSemver ? { version: officialSemver } : {}),
      platform: "linux-x64",
      url: linuxUrl,
      size: downloaded.bytes.length,
      sha256: digest,
      publishedAt: new Date().toISOString(),
    });
  }

  if (releases.length === 0) throw new Error("未取得任何可校验发行物");
  if (releases.some((item) => !item.releaseId || item.releaseId === "unknown")) {
    throw new Error("拒绝写入 unknown 发行身份");
  }

  const manifest = {
    schemaVersion: 1,
    sourceVersionUrl: VERSION_URL,
    releases,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  const temporary = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, payload);
  fs.renameSync(temporary, out);
  console.log(payload);
} catch (error) {
  if (previous) fs.writeFileSync(out, previous);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

void parseOfficialLabel;
