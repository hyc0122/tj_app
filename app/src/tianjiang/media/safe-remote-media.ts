import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";

import { CANVAS_LIMITS } from "../contracts";
import { CanvasRuntimeError } from "../canvas/canvas-document-service";
import { expandIpv6Segments, extractEmbeddedIpv4Address } from "../security/ip-address";

export interface SafeRemoteLookupAnswer {
  address: string;
  family: 4 | 6;
}

export interface SafeRemoteConnectInput {
  ip: string;
  port: number;
  hostname: string;
  servername: string;
  path: string;
  method: string;
  headers: Record<string, string>;
}

export interface SafeRemoteConnectResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface DownloadSafeRemoteMediaOptions {
  lookup?: (hostname: string) => Promise<SafeRemoteLookupAnswer[]>;
  connect?: (input: SafeRemoteConnectInput) => Promise<SafeRemoteConnectResult>;
  env?: NodeJS.ProcessEnv;
  maxRedirects?: number;
  maxBytes?: number;
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((part) => Number(part));
  if (nums.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return undefined;
  return ((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3];
}

function inCidrV4(ip: string, base: string, bits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === undefined || baseInt === undefined) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function ipv6PrefixMatch(ip: string, prefix: string, bits: number): boolean {
  const left = expandIpv6Segments(ip);
  const right = expandIpv6Segments(prefix);
  if (!left || !right || left.some((item) => Number.isNaN(item)) || right.some((item) => Number.isNaN(item))) {
    return false;
  }
  let remaining = bits;
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((left[index] & mask) !== (right[index] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/** 中文注释：IPv4/IPv6 全量拒绝环回、私网、链路本地、文档、组播和保留地址。 */
export function isBlockedRemoteIp(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed) return true;
  if (trimmed === "localhost") return true;
  const embeddedIpv4 = extractEmbeddedIpv4Address(trimmed);
  if (embeddedIpv4) return isBlockedRemoteIp(embeddedIpv4);
  if (net.isIP(trimmed) === 4) {
    return (
      inCidrV4(trimmed, "0.0.0.0", 8)
      || inCidrV4(trimmed, "10.0.0.0", 8)
      || inCidrV4(trimmed, "100.64.0.0", 10)
      || inCidrV4(trimmed, "127.0.0.0", 8)
      || inCidrV4(trimmed, "169.254.0.0", 16)
      || inCidrV4(trimmed, "172.16.0.0", 12)
      || inCidrV4(trimmed, "192.0.0.0", 24)
      || inCidrV4(trimmed, "192.0.2.0", 24)
      || inCidrV4(trimmed, "192.88.99.0", 24)
      || inCidrV4(trimmed, "192.168.0.0", 16)
      || inCidrV4(trimmed, "198.18.0.0", 15)
      || inCidrV4(trimmed, "198.51.100.0", 24)
      || inCidrV4(trimmed, "203.0.113.0", 24)
      || inCidrV4(trimmed, "224.0.0.0", 4)
      || inCidrV4(trimmed, "240.0.0.0", 4)
    );
  }
  if (net.isIP(trimmed) === 6) {
    if (ipv6PrefixMatch(trimmed, "::", 128) || ipv6PrefixMatch(trimmed, "::1", 128)) return true;
    if (ipv6PrefixMatch(trimmed, "fc00::", 7) || ipv6PrefixMatch(trimmed, "fe80::", 10)) return true;
    if (ipv6PrefixMatch(trimmed, "ff00::", 8) || ipv6PrefixMatch(trimmed, "2001:db8::", 32)) return true;
    if (ipv6PrefixMatch(trimmed, "2001:10::", 28) || ipv6PrefixMatch(trimmed, "100::", 64)) return true;
    return false;
  }
  return true;
}

function invalidRemote(): never {
  throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体地址指向私网", 422, false);
}

async function defaultLookup(hostname: string): Promise<SafeRemoteLookupAnswer[]> {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((item) => ({
    address: item.address,
    family: item.family === 6 ? 6 : 4,
  }));
}

function parseHttpHeaders(raw: string): { status: number; headers: Record<string, string>; rest: Buffer } {
  const splitAt = raw.indexOf("\r\n\r\n");
  if (splitAt < 0) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体响应不完整", 422, false);
  }
  const head = raw.slice(0, splitAt);
  const lines = head.split("\r\n");
  const status = Number(lines[0]?.split(" ")[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status, headers, rest: Buffer.from(raw.slice(splitAt + 4), "latin1") };
}

async function defaultConnect(input: SafeRemoteConnectInput, maxBytes: number): Promise<SafeRemoteConnectResult> {
  return await new Promise<SafeRemoteConnectResult>((resolve, reject) => {
    const socket = tls.connect({
      host: input.ip,
      port: input.port,
      servername: input.servername,
    });
    const chunks: Buffer[] = [];
    let total = 0;
    socket.once("secureConnect", () => {
      const headerLines = [
        `${input.method} ${input.path} HTTP/1.1`,
        `Host: ${input.hostname}`,
        "Connection: close",
        "Accept: */*",
      ];
      for (const [key, value] of Object.entries(input.headers)) {
        if (key.toLowerCase() === "host") continue;
        headerLines.push(`${key}: ${value}`);
      }
      socket.write(`${headerLines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes + 16_384) {
        socket.destroy();
        reject(new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体超过上限", 422, false));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const raw = Buffer.concat(chunks);
        const text = raw.toString("latin1");
        const parsed = parseHttpHeaders(text);
        resolve({
          status: parsed.status,
          headers: parsed.headers,
          body: parsed.rest.subarray(0, maxBytes),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function resolvePublicIps(
  hostname: string,
  lookup: (hostname: string) => Promise<SafeRemoteLookupAnswer[]>,
): Promise<string[]> {
  if (net.isIP(hostname) !== 0) {
    if (isBlockedRemoteIp(hostname)) invalidRemote();
    return [hostname];
  }
  const answers = await lookup(hostname);
  if (answers.length === 0) {
    throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体地址无法解析", 422, false);
  }
  const ips = answers.map((item) => item.address);
  for (const ip of ips) {
    if (isBlockedRemoteIp(ip)) invalidRemote();
  }
  return ips;
}

export async function assertSafeRemoteHttpsUrl(raw: string, lookup = defaultLookup): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体地址不合法", 422, false);
  }
  if (parsed.protocol !== "https:") {
    throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体只允许 HTTPS", 422, false);
  }
  return resolvePublicIps(parsed.hostname, lookup);
}

/**
 * 中文注释：每次重定向重新解析；TCP 只连接已校验公网 IP；TLS SNI 与 Host 保持原主机名；忽略代理环境变量。
 */
export async function downloadSafeRemoteMedia(
  raw: string,
  options: DownloadSafeRemoteMediaOptions = {},
): Promise<Buffer> {
  const env = options.env ?? process.env;
  void env.HTTPS_PROXY;
  void env.HTTP_PROXY;
  void env.ALL_PROXY;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? CANVAS_LIMITS.MAX_CANVAS_REMOTE_MEDIA_BYTES;
  const lookup = options.lookup ?? defaultLookup;
  const connect = options.connect ?? ((input: SafeRemoteConnectInput) => defaultConnect(input, maxBytes));

  let current = raw;
  for (let hops = 0; hops <= maxRedirects; hops += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体地址不合法", 422, false);
    }
    if (parsed.protocol !== "https:") {
      throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体只允许 HTTPS", 422, false);
    }
    const port = parsed.port ? Number(parsed.port) : 443;
    const ips = await resolvePublicIps(parsed.hostname, lookup);
    const ip = ips[0];
    const result = await connect({
      ip,
      port,
      hostname: parsed.hostname,
      servername: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: { Host: parsed.hostname },
    });
    if (result.status >= 300 && result.status < 400 && result.headers.location) {
      current = new URL(result.headers.location, parsed).toString();
      continue;
    }
    if (result.status < 200 || result.status >= 300) {
      throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体下载失败", 422, false);
    }
    if (result.body.length > maxBytes) {
      throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体超过上限", 422, false);
    }
    return result.body;
  }
  throw new CanvasRuntimeError("CANVAS_IMPORT_REQUEST_INVALID", "远程媒体重定向过多", 422, false);
}
