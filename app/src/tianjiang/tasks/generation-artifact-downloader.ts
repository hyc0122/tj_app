/**
 * 受控 HTTPS 产物下载器。
 * 禁止信任供应商响应里的 localPath/filePath；只接受 https URL，并校验 SSRF、私网、重定向、大小、类型、摘要与真实路径。
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import { extractEmbeddedIpv4Address } from "../security/ip-address";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

import getPath from "@/utils/getPath";
import { currentUserStorage, userStorageRoot } from "../runtime/user-storage-context";
import {
  inferArtifactMediaType,
  type GenerationArtifactMediaType,
  type NormalizedGenerationArtifact,
} from "./generation-task-artifacts";
import { assertGenerationArtifactMagic } from "./generation-artifact-magic";
import knex, { type Knex } from "knex";
import { parseGenerationResultLocator } from "./generation-result-locator";

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 15_000;

export interface PinnedHttpsRequest {
  url: URL;
  pinnedIp: string;
  servername: string;
  headers: { host: string; [key: string]: string };
}

export interface ArtifactDownloaderHooks {
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<string[]>;
  stagingRoot?: string;
  maxBytes?: number;
  /** 测试用：拦截已固定 IP 的请求。生产路径必须走真实 TLS/SNI。 */
  request?: (input: PinnedHttpsRequest) => Promise<Response>;
  /** 仅 NODE_TEST_CONTEXT：允许把环回地址当作已固定的本机 TLS 测试目标。 */
  allowLoopbackPin?: boolean;
  tlsCa?: string | Buffer | Array<string | Buffer>;
}

let testHooks: ArtifactDownloaderHooks | undefined;

export function setGenerationArtifactDownloaderForTests(hooks: ArtifactDownloaderHooks | null): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  testHooks = hooks ?? undefined;
}

export class UnsafeGenerationArtifactUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeGenerationArtifactUrlError";
  }
}

const STAGING_FILE_PREFIX = "gen-";

export async function downloadGenerationArtifact(input: {
  remoteUrl: string;
  mediaType: GenerationArtifactMediaType;
  expectedSha256?: string;
  expectedByteLength?: number;
  maxBytes?: number;
}): Promise<NormalizedGenerationArtifact> {
  const stagingRoot = resolveStagingRoot();
  fs.mkdirSync(stagingRoot, { recursive: true });
  const tempName = `${STAGING_FILE_PREFIX}${crypto.randomUUID()}.part`;
  const tempPath = path.join(stagingRoot, tempName);
  const maxBytes = input.maxBytes ?? testHooks?.maxBytes ?? DEFAULT_MAX_BYTES;
  let bytesWritten = 0;
  let contentType: string | undefined;
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(tempPath, "wx", 0o600);
  const headerChunks: Buffer[] = [];
  try {
    const response = await fetchValidatedHttps(input.remoteUrl, 0);
    contentType = response.headers.get("content-type") ?? undefined;
    assertContentType(input.mediaType, contentType);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new UnsafeGenerationArtifactUrlError("产物超过允许大小");
    }
    if (input.expectedByteLength && Number.isFinite(declared) && declared !== input.expectedByteLength) {
      throw new UnsafeGenerationArtifactUrlError("产物大小与供应商声明不一致");
    }
    if (!response.body) throw new UnsafeGenerationArtifactUrlError("产物响应缺少正文");
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesWritten += value.byteLength;
      if (bytesWritten > maxBytes) throw new UnsafeGenerationArtifactUrlError("产物超过允许大小");
      hash.update(value);
      const chunk = Buffer.from(value);
      if (headerChunks.reduce((sum, item) => sum + item.length, 0) < 64) headerChunks.push(chunk.subarray(0, 64));
      fs.writeSync(handle, chunk);
    }
    if (bytesWritten <= 0) throw new UnsafeGenerationArtifactUrlError("产物文件为空");
    if (input.expectedByteLength && bytesWritten !== input.expectedByteLength) {
      throw new UnsafeGenerationArtifactUrlError("产物大小与供应商声明不一致");
    }
    const header = Buffer.concat(headerChunks).subarray(0, 64);
    assertGenerationArtifactMagic(input.mediaType, header);
    fs.fsyncSync(handle);
  } catch (error) {
    try { fs.closeSync(handle); } catch { /* ignore */ }
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  fs.closeSync(handle);

  const digest = hash.digest("hex");
  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== digest) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    throw new UnsafeGenerationArtifactUrlError("产物摘要不匹配");
  }
  const realPath = fs.realpathSync.native(tempPath);
  const realRoot = fs.realpathSync.native(stagingRoot);
  if (realPath !== path.join(realRoot, path.basename(realPath)) && !realPath.startsWith(realRoot + path.sep)) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
    throw new UnsafeGenerationArtifactUrlError("产物真实路径逃逸暂存目录");
  }
  return {
    mediaType: input.mediaType,
    sourceKind: "local_path",
    localPath: realPath,
    contentType,
    sha256: digest,
    byteLength: bytesWritten,
  };
}

export async function materializeGenerationArtifact(
  artifact: NormalizedGenerationArtifact,
): Promise<NormalizedGenerationArtifact> {
  if (artifact.sourceKind === "local_path") {
    if (!artifact.localPath) throw new UnsafeGenerationArtifactUrlError("本地产物路径缺失");
    assertManagedLocalArtifactPath(artifact.localPath);
    const bytes = fs.readFileSync(artifact.localPath);
    assertGenerationArtifactMagic(artifact.mediaType, bytes);
    if (artifact.sha256) {
      const digest = crypto.createHash("sha256").update(bytes).digest("hex");
      if (digest !== artifact.sha256.toLowerCase()) {
        throw new UnsafeGenerationArtifactUrlError("产物摘要不匹配");
      }
    }
    if (artifact.byteLength && bytes.length !== artifact.byteLength) {
      throw new UnsafeGenerationArtifactUrlError("产物大小与供应商声明不一致");
    }
    return {
      ...artifact,
      sha256: artifact.sha256 ?? crypto.createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
    };
  }
  if (artifact.sourceKind !== "remote_url" || !artifact.remoteUrl) {
    throw new UnsafeGenerationArtifactUrlError("不支持的产物来源");
  }
  return downloadGenerationArtifact({
    remoteUrl: artifact.remoteUrl,
    mediaType: artifact.mediaType,
    expectedSha256: artifact.sha256,
    expectedByteLength: artifact.byteLength,
  });
}

export function isOwnedGenerationStagingPath(localPath: string): boolean {
  try {
    const resolved = fs.realpathSync.native(localPath);
    const stagingRoot = fs.realpathSync.native(resolveStagingRoot());
    const name = path.basename(resolved);
    if (!name.startsWith(STAGING_FILE_PREFIX)) return false;
    return resolved === path.join(stagingRoot, name) || resolved.startsWith(stagingRoot + path.sep);
  } catch {
    return false;
  }
}

export function assertPersistableStagingPath(stagingPath: string): void {
  if (!isOwnedGenerationStagingPath(stagingPath)) {
    throw new UnsafeGenerationArtifactUrlError("stagingPath 只能引用本账号受管 generation-staging 中的 gen-* 文件");
  }
}

export async function stageInlineGenerationArtifact(input: {
  bytes: Buffer;
  mediaType: GenerationArtifactMediaType;
  contentType?: string;
}): Promise<NormalizedGenerationArtifact> {
  if (input.bytes.length <= 0) throw new UnsafeGenerationArtifactUrlError("产物文件为空");
  assertGenerationArtifactMagic(input.mediaType, input.bytes);
  const stagingRoot = resolveStagingRoot();
  fs.mkdirSync(stagingRoot, { recursive: true });
  const dest = path.join(stagingRoot, `${STAGING_FILE_PREFIX}${crypto.randomUUID()}`);
  fs.writeFileSync(dest, input.bytes, { mode: 0o600 });
  const realPath = fs.realpathSync.native(dest);
  assertPersistableStagingPath(realPath);
  return {
    mediaType: input.mediaType,
    sourceKind: "local_path",
    localPath: realPath,
    contentType: input.contentType,
    sha256: crypto.createHash("sha256").update(input.bytes).digest("hex"),
    byteLength: input.bytes.length,
  };
}

export async function cleanupOwnedStagingFile(localPath: string | undefined): Promise<void> {
  if (!localPath || !isOwnedGenerationStagingPath(localPath)) return;
  try { fs.rmSync(localPath, { force: true }); } catch { /* ignore */ }
}

export async function cleanupStaleGenerationStaging(
  database?: Knex | Knex[],
  now = Date.now(),
  maxAgeMs = 60 * 60 * 1000,
): Promise<number> {
  let stagingRoot: string;
  try {
    stagingRoot = resolveStagingRoot();
  } catch {
    return 0;
  }
  if (!fs.existsSync(stagingRoot)) return 0;
  const referenced = new Set<string>();
  const databases = database ? (Array.isArray(database) ? database : [database]) : [];
  for (const item of databases) {
    await addUnfinishedStagingReferences(item, referenced);
  }
  const discoveredReferencesComplete = await addDiscoveredProjectStagingReferences(referenced);
  // 中文注释：只要有一个项目库无法核对，就无法证明任何旧文件未被引用；本轮必须失败安全地停止回收。
  if (!discoveredReferencesComplete) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(stagingRoot)) {
    if (!name.startsWith(STAGING_FILE_PREFIX)) continue;
    const full = path.join(stagingRoot, name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      const real = fs.realpathSync.native(full);
      if (referenced.has(path.resolve(full)) || referenced.has(real)) continue;
      fs.rmSync(full, { force: true });
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

async function addUnfinishedStagingReferences(database: Knex, referenced: Set<string>): Promise<void> {
  // 中文注释：数据库读取错误必须向上传播；把错误伪装成“没有表”会导致清理器误删仍被任务引用的文件。
  if (!await database.schema.hasTable("o_tasks")) return;
  const rows = await database("o_tasks")
    .select("resultLocator")
    .whereNotNull("resultLocator")
    .where("state", "进行中")
    .whereIn("generationStatus", ["polling", "temporary_failure", "pending_finalize"]);
  for (const row of rows) {
    const locator = parseGenerationResultLocator((row as { resultLocator?: string }).resultLocator);
    if (!locator?.stagingPath || !isOwnedGenerationStagingPath(locator.stagingPath)) continue;
    referenced.add(path.resolve(locator.stagingPath));
    try { referenced.add(fs.realpathSync.native(locator.stagingPath)); } catch { /* ignore */ }
  }
}

async function addDiscoveredProjectStagingReferences(referenced: Set<string>): Promise<boolean> {
  const context = currentUserStorage();
  if (!context) return true;
  const projectsRoot = path.join(userStorageRoot(getPath(), context), "projects");
  if (!fs.existsSync(projectsRoot)) return true;
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const databasePath = path.join(projectsRoot, entry.name, "project.sqlite");
    if (!fs.existsSync(databasePath)) continue;
    const client = knex({
      client: "better-sqlite3",
      connection: { filename: databasePath },
      useNullAsDefault: true,
    });
    try {
      await addUnfinishedStagingReferences(client, referenced);
    } catch {
      // 中文注释：项目库损坏或暂时被占用时不能证明 staging 未被引用，停止本轮删除。
      return false;
    } finally {
      await client.destroy().catch(() => undefined);
    }
  }
  return true;
}

function assertManagedLocalArtifactPath(localPath: string): void {
  if (!isOwnedGenerationStagingPath(localPath)) {
    throw new UnsafeGenerationArtifactUrlError("禁止使用不受管的本地产物路径");
  }
}

function resolveStagingRoot(): string {
  if (testHooks?.stagingRoot) return path.resolve(testHooks.stagingRoot);
  const context = currentUserStorage();
  if (!context) throw new Error("缺少用户存储上下文，无法创建产物暂存目录");
  return path.join(userStorageRoot(getPath(), context), "generation-staging");
}

async function fetchValidatedHttps(urlString: string, redirectCount: number): Promise<Response> {
  if (redirectCount > MAX_REDIRECTS) throw new UnsafeGenerationArtifactUrlError("重定向次数过多");
  const parsed = parseHttpsUrl(urlString);
  const addresses = await resolvePublicAddresses(parsed.hostname);
  if (addresses.length === 0) throw new UnsafeGenerationArtifactUrlError("产物主机名无法解析为公网地址");
  const pinnedIp = addresses[0]!;
  const response = await performPinnedHttpsRequest(parsed, pinnedIp);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new UnsafeGenerationArtifactUrlError("重定向缺少 Location");
    const next = new URL(location, parsed.href).href;
    return fetchValidatedHttps(next, redirectCount + 1);
  }
  if (!response.ok) throw new UnsafeGenerationArtifactUrlError(`产物下载失败: HTTP ${response.status}`);
  return response;
}

async function performPinnedHttpsRequest(parsed: URL, pinnedIp: string): Promise<Response> {
  if (testHooks?.request) {
    return testHooks.request({
      url: parsed,
      pinnedIp,
      servername: parsed.hostname,
      headers: { host: parsed.host },
    });
  }
  if (testHooks?.fetch) {
    return testHooks.fetch(parsed.href, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      headers: {
        accept: "video/*,image/*,audio/*",
        host: parsed.host,
      },
    });
  }
  return pinnedHttpsGet(parsed, pinnedIp);
}

function pinnedHttpsGet(parsed: URL, pinnedIp: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const port = parsed.port ? Number(parsed.port) : 443;
    const req = https.request({
      host: pinnedIp,
      family: net.isIPv6(pinnedIp) ? 6 : 4,
      port,
      method: "GET",
      path: `${parsed.pathname}${parsed.search}`,
      servername: parsed.hostname,
      headers: {
        Host: parsed.host,
        Accept: "video/*,image/*,audio/*",
      },
      timeout: CONNECT_TIMEOUT_MS,
      rejectUnauthorized: true,
      ca: testHooks?.tlsCa,
    }, (res) => {
      resolve(incomingMessageToResponse(res));
    });
    req.on("error", (error) => {
      reject(error instanceof Error ? error : new UnsafeGenerationArtifactUrlError("产物下载失败"));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new UnsafeGenerationArtifactUrlError("连接超时"));
    });
    req.end();
  });
}

function incomingMessageToResponse(res: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return new Response(Readable.toWeb(res as unknown as Readable) as BodyInit, {
    status: res.statusCode ?? 0,
    headers,
  });
}

function parseHttpsUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new UnsafeGenerationArtifactUrlError("产物 URL 无效");
  }
  if (parsed.protocol !== "https:") throw new UnsafeGenerationArtifactUrlError("产物必须使用 HTTPS");
  if (parsed.username || parsed.password) throw new UnsafeGenerationArtifactUrlError("产物 URL 禁止携带凭据");
  const allowTestLoopback = Boolean(process.env.NODE_TEST_CONTEXT && testHooks?.allowLoopbackPin);
  if (parsed.port && parsed.port !== "443") {
    const port = Number(parsed.port);
    if (!allowTestLoopback || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new UnsafeGenerationArtifactUrlError("产物 URL 端口不受支持");
    }
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new UnsafeGenerationArtifactUrlError("禁止下载本机或环回地址");
  }
  if (
    hostname === "metadata.google.internal"
    || hostname.endsWith(".internal")
    || hostname.endsWith(".local")
  ) {
    throw new UnsafeGenerationArtifactUrlError("禁止下载内部主机");
  }
  if (net.isIP(hostname) && isBlockedAddress(hostname) && !isAllowedTestLoopback(hostname)) {
    throw new UnsafeGenerationArtifactUrlError("禁止下载私网或保留地址");
  }
  return parsed;
}

function isAllowedTestLoopback(address: string): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT && testHooks?.allowLoopbackPin && isLoopbackAddress(address));
}

function isLoopbackAddress(address: string): boolean {
  const ip = normalizeIp(address);
  if (net.isIPv4(ip)) {
    const first = Number(ip.split(".")[0]);
    return first === 127;
  }
  return ip === "::1";
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname) && !isAllowedTestLoopback(hostname)) {
      throw new UnsafeGenerationArtifactUrlError("禁止下载私网或保留地址");
    }
    return [hostname];
  }
  const lookup = testHooks?.lookup ?? defaultLookup;
  const addresses = await lookup(hostname);
  const allowed = addresses.filter((address) => !isBlockedAddress(address) || isAllowedTestLoopback(address));
  if (allowed.length !== addresses.length) {
    throw new UnsafeGenerationArtifactUrlError("禁止下载解析到私网或保留地址的主机");
  }
  return allowed;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export function isBlockedAddress(address: string): boolean {
  const ip = normalizeIp(address);
  if (!ip) return true;
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true;
}

function normalizeIp(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const embeddedIpv4 = extractEmbeddedIpv4Address(trimmed);
  if (embeddedIpv4) return embeddedIpv4;
  return trimmed;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const compacted = ip;
  if (compacted === "::" || compacted === "::1") return true;
  const first = parseIPv6Head(compacted);
  if (first === undefined) return true;
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

function parseIPv6Head(ip: string): number | undefined {
  const head = ip.split(":")[0];
  if (!head) return 0;
  const value = Number.parseInt(head, 16);
  return Number.isFinite(value) ? value : undefined;
}

function assertContentType(mediaType: GenerationArtifactMediaType, contentType?: string): void {
  const raw = String(contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!raw || raw === "application/octet-stream") return;
  if (mediaType === "video" && raw.startsWith("video/")) return;
  if (mediaType === "image" && raw.startsWith("image/")) return;
  if (mediaType === "audio" && raw.startsWith("audio/")) return;
  throw new UnsafeGenerationArtifactUrlError("产物内容类型与媒体类型不匹配");
}

export function inferMediaTypeFromLocator(locator: string, contentType?: string): GenerationArtifactMediaType {
  return inferArtifactMediaType(locator, contentType);
}
