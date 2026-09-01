import {
  parsePlatformLatest,
  parsePlatformRelease,
  type PlatformArtifactContract,
  type PlatformLatestContract,
  type PlatformReleaseContract,
} from "../../../scripts/platform-release-contract.mjs";

export type PlatformUpdateChannel = "stable" | "beta";

export const PLATFORM_CATALOG_ENDPOINTS = {
  stable: "https://cdn.j11.com.cn/desktop/stable/windows/x64/catalog/latest.json",
  beta: "https://cdn.j11.com.cn/desktop/beta/windows/x64/catalog/latest.json",
} as const;

export interface PlatformReleaseEntry {
  latest: PlatformLatestContract;
  release: PlatformReleaseContract;
}

export interface PlatformCatalogClock {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PlatformReleaseCatalogClientOptions {
  fetcher?: typeof fetch;
  clock?: PlatformCatalogClock;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_REDIRECTS = 4;
const ORIGIN = "https://cdn.j11.com.cn";

const systemClock: PlatformCatalogClock = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是严格对象`);
  }
}

function assertExactKeys(raw: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(raw).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} 含未知字段或缺少严格字段`);
  }
}

function assertArtifactShape(raw: unknown, index: number): asserts raw is Record<string, unknown> {
  assertPlainObject(raw, `artifact[${index}]`);
  assertExactKeys(raw, ["path", "fileName", "kind", "size", "sha256"], `artifact[${index}]`);
}

function assertReleaseArtifacts(release: PlatformReleaseContract): void {
  const kinds = new Map<string, PlatformArtifactContract>();
  const paths = new Set<string>();
  release.artifacts.forEach((artifact, index) => {
    assertArtifactShape(artifact, index);
    if (artifact.size <= 0) throw new Error(`artifact[${index}] 大小必须大于零`);
    if (paths.has(artifact.path)) throw new Error(`artifact[${index}] 路径重复`);
    if (kinds.has(artifact.kind)) throw new Error(`artifact kind 重复：${artifact.kind}`);
    paths.add(artifact.path);
    kinds.set(artifact.kind, artifact);
  });
  if (!kinds.has("installer")) throw new Error("平台发布缺少唯一安装包 artifact");
  if (!kinds.has("blockmap")) throw new Error("平台发布缺少唯一 blockmap artifact");
  if (kinds.size !== 2) throw new Error("平台发布包含未批准的 artifact kind");
}

function parseEntryParts(
  rawLatest: unknown,
  rawRelease: unknown,
  channel: PlatformUpdateChannel,
): PlatformReleaseEntry {
  assertPlainObject(rawLatest, "latest");
  assertExactKeys(rawLatest, ["schemaVersion", "channel", "platform", "arch", "version", "release"], "latest");
  assertPlainObject(rawRelease, "release");
  assertExactKeys(
    rawRelease,
    ["schemaVersion", "channel", "sourceChannel", "platform", "arch", "version", "tag", "commitSha", "nativeMetadata", "artifacts"],
    "release",
  );
  if (Array.isArray(rawRelease.artifacts)) {
    rawRelease.artifacts.forEach(assertArtifactShape);
  }
  // 中文注释：版本、通道、平台和路径语义只调用 Task 1 权威运行时合同，避免 TS 侧复制后漂移。
  const expected = { channel, platform: "windows", arch: "x64" } as const;
  const latest = parsePlatformLatest(rawLatest, expected);
  const release = parsePlatformRelease(rawRelease, expected);
  if (release.version !== latest.version) throw new Error("release 版本与 latest 不一致");
  if (release.channel !== latest.channel) throw new Error("release 通道与 latest 不一致");
  assertReleaseArtifacts(release);
  return { latest, release };
}

/** 缓存回读也走与网络响应相同的严格入口。 */
export function parsePlatformReleaseEntry(
  raw: unknown,
  channel: PlatformUpdateChannel,
): PlatformReleaseEntry {
  assertPlainObject(raw, "平台发布快照");
  assertExactKeys(raw, ["latest", "release"], "平台发布快照");
  return parseEntryParts(raw.latest, raw.release, channel);
}

function assertAllowedUrl(url: URL, channel: PlatformUpdateChannel): void {
  if (url.protocol !== "https:") throw new Error("Catalog URL 必须使用 HTTPS");
  if (url.origin !== ORIGIN) throw new Error("Catalog 重定向必须保持同一 HTTPS origin 且禁止自定义端口");
  if (url.username || url.password) throw new Error("Catalog URL 禁止 userinfo");
  if (url.port) throw new Error("Catalog URL 禁止显式端口");
  if (url.search || url.hash) throw new Error("Catalog URL 禁止查询参数和片段");
  const prefix = `/desktop/${channel}/windows/x64/`;
  if (!url.pathname.startsWith(prefix) || url.pathname.includes("..")) {
    throw new Error("Catalog URL 通道或路径越界");
  }
}

export class PlatformReleaseCatalogClient {
  private readonly fetcher: typeof fetch;
  private readonly clock: PlatformCatalogClock;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;

  constructor(options: PlatformReleaseCatalogClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  async fetchChannel(channel: PlatformUpdateChannel): Promise<PlatformReleaseEntry> {
    const latestRaw = await this.fetchJson(PLATFORM_CATALOG_ENDPOINTS[channel], channel);
    assertPlainObject(latestRaw, "latest");
    assertExactKeys(latestRaw, ["schemaVersion", "channel", "platform", "arch", "version", "release"], "latest");
    const latest = parsePlatformLatest(latestRaw, { channel, platform: "windows", arch: "x64" });
    // 中文注释：release URL 只能由已验证的相对对象键拼接，远端 JSON 不能注入主机或协议。
    const releaseRaw = await this.fetchJson(`${ORIGIN}/${latest.release}`, channel);
    return parseEntryParts(latestRaw, releaseRaw, channel);
  }

  private async fetchJson(
    initialUrl: string,
    channel: PlatformUpdateChannel,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = this.clock.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let current = new URL(initialUrl);
      for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
        assertAllowedUrl(current, channel);
        const response = await this.fetcher(current.toString(), {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.url) {
          try {
            assertAllowedUrl(new URL(response.url), channel);
          } catch (error) {
            this.cancelBody(response);
            throw error;
          }
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          this.cancelBody(response);
          if (!location) throw new Error("Catalog 重定向缺少 Location");
          if (redirects === this.maxRedirects) throw new Error("Catalog 重定向次数过多");
          current = new URL(location, current);
          assertAllowedUrl(current, channel);
          continue;
        }
        if (!response.ok) {
          this.cancelBody(response);
          throw new Error(`Catalog 请求失败：HTTP ${response.status}`);
        }
        return this.readBoundedJson(response);
      }
      throw new Error("Catalog 重定向次数过多");
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Catalog 请求超时或已取消");
      throw error;
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  private async readBoundedJson(response: Response): Promise<unknown> {
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      this.cancelBody(response);
      throw new Error("Catalog 响应过大");
    }
    if (!response.body) throw new Error("Catalog 响应正文为空");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxResponseBytes) {
        await reader.cancel();
        throw new Error("Catalog 响应过大");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Catalog JSON 无效");
    }
  }

  private cancelBody(response: Response): void {
    try {
      // clone/tee 的另一个分支可能仍未消费；发出取消即可，不能反向等待不受控分支。
      void response.body?.cancel().catch(() => undefined);
    } catch {
      // 中文注释：取消本身失败不覆盖原始协议/状态错误，但已明确结束对该响应的消费。
    }
  }
}
