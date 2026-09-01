/**
 * 将 IPv6 展开成 8 个 16 位分组。
 * 中文注释：安全边界不能只匹配字符串前缀，否则展开形式的 IPv4-mapped IPv6 会绕过私网检查。
 */
export function expandIpv6Segments(input: string): number[] | undefined {
  const raw = input.trim().toLowerCase().split("%")[0] ?? "";
  if (!raw || raw.split("::").length > 2) return undefined;

  let normalized = raw;
  const lastColon = normalized.lastIndexOf(":");
  const dottedTail = lastColon >= 0 ? normalized.slice(lastColon + 1) : "";
  if (dottedTail.includes(".")) {
    const octets = dottedTail.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return undefined;
    }
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const hasCompression = normalized.includes("::");
  const [head = "", tail = ""] = normalized.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = hasCompression ? 8 - headParts.length - tailParts.length : 0;
  if ((hasCompression && missing < 1) || (!hasCompression && headParts.length !== 8)) return undefined;
  const parts = hasCompression
    ? [...headParts, ...Array.from({ length: missing }, () => "0"), ...tailParts]
    : headParts;
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.map((part) => Number.parseInt(part, 16));
}

/** 提取 IPv4-mapped IPv6 或 RFC 6052 well-known NAT64 中的 IPv4 地址。 */
export function extractEmbeddedIpv4Address(input: string): string | undefined {
  const parts = expandIpv6Segments(input);
  if (!parts) return undefined;
  const mapped = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  const nat64 = parts[0] === 0x0064
    && parts[1] === 0xff9b
    && parts.slice(2, 6).every((part) => part === 0);
  if (!mapped && !nat64) return undefined;
  return `${parts[6]! >>> 8}.${parts[6]! & 0xff}.${parts[7]! >>> 8}.${parts[7]! & 0xff}`;
}
