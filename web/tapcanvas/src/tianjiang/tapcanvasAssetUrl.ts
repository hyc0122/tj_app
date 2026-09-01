/**
 * TapCanvas 静态资源必须走 Vite BASE_URL（生产为 /tapcanvas/），
 * 禁止写成站点根路径以致落入受保护 API。
 */
export function tapcanvasAssetUrl(relativePath: string): string {
  const raw = String(relativePath ?? "").trim()
  if (!raw) return withBase("")
  if (/^(blob:|data:|https?:)/i.test(raw)) return raw
  if (raw.startsWith(withBase(""))) return raw
  return withBase(raw.replace(/^\/+/, ""))
}

function withBase(suffix: string): string {
  const base = String(import.meta.env.BASE_URL || "/tapcanvas/")
  const normalizedBase = base.endsWith("/") ? base : `${base}/`
  if (!suffix) return normalizedBase
  return `${normalizedBase}${suffix.replace(/^\/+/, "")}`
}
