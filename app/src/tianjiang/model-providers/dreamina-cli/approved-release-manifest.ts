import fs from "node:fs";
import path from "node:path";

export interface DreaminaApprovedRelease {
  releaseId: string;
  version?: string;
  buildLabel?: string;
  platform: "windows-x64" | "linux-x64";
  url: string;
  size: number;
  sha256: string;
  publishedAt: string;
}

export interface DreaminaApprovedReleaseManifest {
  schemaVersion: 1;
  sourceVersionUrl: string;
  releases: DreaminaApprovedRelease[];
}

export const DREAMINA_OFFICIAL_HOST = "lf3-static.bytednsdoc.com";
export const DREAMINA_OFFICIAL_PREFIX =
  "/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/";
export const DREAMINA_WINDOWS_RELEASE_URL =
  `https://${DREAMINA_OFFICIAL_HOST}${DREAMINA_OFFICIAL_PREFIX}dreamina_cli_windows_amd64.exe`;
export const DREAMINA_VERSION_URL =
  `https://${DREAMINA_OFFICIAL_HOST}${DREAMINA_OFFICIAL_PREFIX}version.json`;

function isRegularManifestFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 中文注释：Electron 打包态必须锁定 resourcesPath，缺文件时直接失败；
 * 禁止静默回退到碰巧存在的源码工作树，避免发布包掩盖资源遗漏。
 */
export function resolveApprovedManifestPath(options: {
  moduleDir?: string;
  cwd?: string;
  resourcesPath?: string | null;
} = {}): string {
  const moduleDir = options.moduleDir ?? __dirname;
  const cwd = options.cwd ?? process.cwd();
  const resourcesPath = options.resourcesPath === undefined
    ? String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "").trim()
    : String(options.resourcesPath ?? "").trim();

  if (resourcesPath) {
    return path.resolve(resourcesPath, "dreamina-cli", "approved-releases.json");
  }

  const sourceCandidates = [
    path.resolve(moduleDir, "../../../../resources/dreamina-cli/approved-releases.json"),
    path.resolve(cwd, "resources/dreamina-cli/approved-releases.json"),
    path.resolve(cwd, "app/resources/dreamina-cli/approved-releases.json"),
  ];
  return sourceCandidates.find(isRegularManifestFile) ?? sourceCandidates[0];
}

export function defaultApprovedManifestPath(): string {
  return resolveApprovedManifestPath();
}

/** 中文注释：每个跳转后的 URL 都必须是 HTTPS、精确官方 host 和目录前缀。 */
export function assertApprovedDreaminaUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("批准发行地址无效");
  }
  if (parsed.protocol !== "https:") throw new Error("批准发行地址必须是 HTTPS");
  if (parsed.username || parsed.password) throw new Error("批准发行地址不得包含用户名或密码");
  if (parsed.hostname !== DREAMINA_OFFICIAL_HOST) throw new Error("批准发行地址主机不在白名单");
  if (!parsed.pathname.startsWith(DREAMINA_OFFICIAL_PREFIX)) {
    throw new Error("批准发行地址路径前缀不受信任");
  }
  return parsed;
}

export function isSemverReleaseVersion(value: string | undefined): value is string {
  return Boolean(value && value !== "unknown" && /^\d+\.\d+\.\d+/.test(value));
}

export function parseApprovedReleaseManifest(raw: unknown): DreaminaApprovedReleaseManifest {
  if (!raw || typeof raw !== "object") throw new Error("批准发行清单无效");
  const record = raw as DreaminaApprovedReleaseManifest;
  if (record.schemaVersion !== 1) throw new Error("批准发行清单版本不受支持");
  assertApprovedDreaminaUrl(record.sourceVersionUrl);
  if (!Array.isArray(record.releases)) throw new Error("批准发行清单缺少 releases");
  for (const release of record.releases) {
    if (release.platform !== "windows-x64" && release.platform !== "linux-x64") {
      throw new Error("批准发行平台不受支持");
    }
    assertApprovedDreaminaUrl(release.url);
    if (!Number.isInteger(release.size) || release.size <= 0) throw new Error("批准发行 size 无效");
    if (!/^[0-9a-f]{64}$/.test(release.sha256)) throw new Error("批准发行 sha256 必须是 64 位小写十六进制");
    if (release.version === "unknown") {
      throw new Error("批准发行版本无效，禁止 unknown");
    }
    if (release.version && !isSemverReleaseVersion(release.version) && release.version !== release.buildLabel) {
      throw new Error("批准发行 version 只能是语义版本或省略；官方无语义版本时使用 releaseId=内容 SHA");
    }
    const releaseId = String(release.releaseId ?? release.sha256);
    if (releaseId !== release.sha256) {
      throw new Error("批准发行 releaseId 必须等于内容 SHA-256");
    }
    release.releaseId = releaseId;
  }
  return record;
}

export function readApprovedReleaseManifest(filePath = defaultApprovedManifestPath()): DreaminaApprovedReleaseManifest {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parseApprovedReleaseManifest(parsed);
}

export function findApprovedRelease(
  manifest: DreaminaApprovedReleaseManifest,
  platform: DreaminaApprovedRelease["platform"],
): DreaminaApprovedRelease | undefined {
  return manifest.releases.find((item) => item.platform === platform);
}

export function approvedReleaseDirectoryName(release: DreaminaApprovedRelease, digest: string): string {
  if (isSemverReleaseVersion(release.version)) return `${release.version}-${digest.slice(0, 12)}`;
  return digest.slice(0, 12);
}

export function approvedReleaseIdentity(release: DreaminaApprovedRelease): string {
  return isSemverReleaseVersion(release.version) ? release.version : release.releaseId;
}
