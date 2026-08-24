import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import {
  resolveReleaseTarget,
  resolveReleaseTargetId,
} from "./release-targets.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_NOTARIZATION_KEYS = new Set([
  "aftersign",
  "notarize",
  "notarization",
]);
const PLATFORM_CONFIGURATION_KEYS = ["win", "mac", "linux"];

function fail(reason) {
  throw new Error(`未签名发布合同失败：${reason}`);
}

function hasForbiddenNotarizationKey(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_NOTARIZATION_KEYS.has(key.toLowerCase())) return true;
    if (hasForbiddenNotarizationKey(child)) return true;
  }
  return false;
}

/**
 * 验证产品自身明确不签名，同时保留 Windows rcedit 资源编辑能力。
 * 返回值只含固定布尔证据，不泄露证书路径或环境变量内容。
 */
export function assertUnsignedBuilderContract(options = {}) {
  const builderConfig = options.builderConfig ?? fs.readFileSync(
    path.join(appRoot, "electron-builder.yml"),
    "utf8",
  );
  const environment = options.environment ?? process.env;
  const targetId = options.targetId ?? resolveReleaseTargetId(process.platform, process.arch);
  const target = resolveReleaseTarget(targetId);
  let parsed;
  try {
    parsed = yaml.load(builderConfig);
  } catch {
    fail("electron-builder.yml 不是有效 YAML");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("electron-builder.yml 顶层必须是对象");
  }
  if (parsed.detectUpdateChannel !== false) {
    fail("detectUpdateChannel 必须明确为布尔值 false");
  }
  for (const platformKey of PLATFORM_CONFIGURATION_KEYS) {
    const platformConfig = parsed[platformKey];
    // electron-builder 会优先采用平台级值；存在覆盖时也必须保持严格布尔 false。
    if (
      platformConfig
      && typeof platformConfig === "object"
      && Object.prototype.hasOwnProperty.call(platformConfig, "detectUpdateChannel")
      && platformConfig.detectUpdateChannel !== false
    ) {
      fail(`${platformKey}.detectUpdateChannel 必须明确为布尔值 false`);
    }
  }

  const win = parsed.win;
  const mac = parsed.mac;
  if (!win || typeof win !== "object" || win.forceCodeSigning !== false) {
    fail("Windows forceCodeSigning 必须明确为 false");
  }
  if (win.signAndEditExecutable === false) {
    fail("Windows 资源编辑不得关闭");
  }
  if (!mac || typeof mac !== "object" || mac.identity !== null) {
    fail("macOS identity 必须明确为 null");
  }
  if (mac.hardenedRuntime === true) {
    fail("macOS hardenedRuntime 不得启用");
  }
  if (hasForbiddenNotarizationKey(parsed)) {
    fail("不得配置 Apple 公证钩子");
  }

  for (const [name, rawValue] of Object.entries(environment)) {
    const value = rawValue === undefined || rawValue === null ? "" : String(rawValue).trim();
    // Windows 环境名大小写不敏感；统一转大写后再判断，禁止以混合大小写绕过。
    const normalizedName = name.toUpperCase();
    const isCertificateVariable = (
      normalizedName !== "CSC_IDENTITY_AUTO_DISCOVERY"
      && (normalizedName.startsWith("CSC_") || normalizedName.startsWith("WIN_CSC_"))
    );
    if (isCertificateVariable && value) {
      fail("检测到产品签名证书环境配置");
    }
  }
  const identityDiscoveryValues = Object.entries(environment)
    .filter(([name]) => name.toUpperCase() === "CSC_IDENTITY_AUTO_DISCOVERY")
    .map(([, value]) => String(value ?? "").trim().toLowerCase());
  if (identityDiscoveryValues.some((value) => value === "true")) {
    fail("任何目标都不得显式启用 CSC_IDENTITY_AUTO_DISCOVERY 身份发现");
  }
  if (target.platform === "macos") {
    if (
      identityDiscoveryValues.length === 0
      || identityDiscoveryValues.some((value) => value !== "false")
    ) {
      fail("macOS 身份发现 CSC_IDENTITY_AUTO_DISCOVERY 必须明确为 false");
    }
  }

  return {
    detectUpdateChannel: false,
    windowsForceCodeSigning: false,
    windowsResourceEditing: true,
    macIdentity: null,
    macHardenedRuntime: false,
    macNotarizationConfigured: false,
  };
}
