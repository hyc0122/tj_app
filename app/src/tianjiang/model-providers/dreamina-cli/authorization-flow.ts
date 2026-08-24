import crypto from "node:crypto";

import { inspectLogin } from "./capability-probe";
import { resolveDreaminaExecutable } from "./provider";
import { runDreaminaCommand } from "./process-runner";
import { writeDreaminaRuntimeState } from "./runtime-state-store";
import { resolveDreaminaExternalTarget } from "./external-link-policy";

export interface DreaminaAuthorizationMaterial {
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  pollIntervalSeconds: number;
  authorizationId: string;
}

export type DreaminaAuthorizationStartResult =
  | { state: "already_logged_in" }
  | ({ state: "authorization_required" } & DreaminaAuthorizationMaterial);

interface AuthorizationSession {
  deviceCode: string;
  expiresAt: number;
  pollIntervalSeconds: number;
}

const sessions = new Map<string, AuthorizationSession>();

interface ParsedAuthorizationFields {
  verificationUri?: string;
  userCode?: string;
  deviceCode?: string;
  expiresIn?: number;
  interval?: number;
}

function parseAuthorizationFields(text: string): ParsedAuthorizationFields {
  // 中文注释：兼容 JSON、嵌套 auth 对象和 CLI 混合文本，但不向外暴露 device_code。
  const parsed = parseAuthorizationJson(text);
  return {
    verificationUri: stringField(parsed, "verification_uri", "verificationUri")
      ?? text.match(/["']?(?:verification_uri|verificationUri|verification uri)["']?\s*[:=]\s*["']?(https:\/\/[^\s"',}]+)/i)?.[1],
    userCode: stringField(parsed, "user_code", "userCode")
      ?? text.match(/["']?(?:user_code|userCode|user code)["']?\s*[:=]\s*["']?([A-Z0-9-]+)/i)?.[1],
    deviceCode: stringField(parsed, "device_code", "deviceCode")
      ?? text.match(/["']?(?:device_code|deviceCode|device code)["']?\s*[:=]\s*["']?([A-Za-z0-9._-]+)/i)?.[1],
    expiresIn: numberField(parsed, "expires_in", "expiresIn")
      ?? numberFromText(text, "expires_in", "expiresIn")
      ?? 300,
    interval: numberField(parsed, "interval", "poll_interval")
      ?? numberFromText(text, "interval", "poll_interval")
      ?? 5,
  };
}

function parseAuthorizationJson(text: string): Record<string, unknown> | undefined {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const auth = record.auth;
    return auth && typeof auth === "object" && !Array.isArray(auth)
      ? { ...record, ...(auth as Record<string, unknown>) }
      : record;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown> | undefined, ...names: string[]): string | undefined {
  const value = names.map((name) => record?.[name]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, ...names: string[]): number | undefined {
  const value = names.map((name) => record?.[name]).find((item) => Number.isFinite(Number(item)));
  return value === undefined ? undefined : Number(value);
}

function numberFromText(text: string, ...names: string[]): number | undefined {
  const namePattern = names.map((name) => name.replace("_", "[_ ]?")).join("|");
  const value = text.match(new RegExp(`["']?(?:${namePattern})["']?\\s*[:=]\\s*([0-9]+)`, "i"))?.[1];
  return value === undefined ? undefined : Number(value);
}

export async function startDreaminaAuthorization(): Promise<DreaminaAuthorizationStartResult> {
  const executablePath = await resolveDreaminaExecutable();
  const account = await inspectLogin(executablePath);
  if (account.loggedIn) return { state: "already_logged_in" };
  const result = await runDreaminaCommand({
    executablePath,
    args: ["login", "--headless"],
    timeoutKind: "session",
  });
  // 中文注释：必须从原始 stdout 解析 device_code，禁止进入白名单结构化输出或日志。
  const parsed = parseAuthorizationFields(result.stdout);
  if (!parsed.verificationUri || !parsed.userCode || !parsed.deviceCode) {
    throw new Error("CLI 未返回完整授权材料");
  }
  const trusted = resolveDreaminaExternalTarget({ kind: "authorization", url: parsed.verificationUri });
  if (!trusted.ok) throw new Error(trusted.reason);
  const authorizationId = crypto.randomUUID();
  const expiresAt = Date.now() + Math.max(30, parsed.expiresIn ?? 300) * 1000;
  sessions.set(authorizationId, {
    deviceCode: parsed.deviceCode,
    expiresAt,
    pollIntervalSeconds: Math.max(1, parsed.interval ?? 5),
  });
  await writeDreaminaRuntimeState({ account: { state: "authorizing", refreshedAt: Date.now() } });
  return {
    state: "authorization_required",
    verificationUri: trusted.url.split("?")[0] ? trusted.url : parsed.verificationUri,
    userCode: parsed.userCode,
    expiresAt,
    pollIntervalSeconds: Math.max(1, parsed.interval ?? 5),
    authorizationId,
  };
}

export async function checkDreaminaAuthorization(authorizationId: string): Promise<{
  state: "authorizing" | "logged_in" | "expired" | "failed";
}> {
  const session = sessions.get(authorizationId);
  if (!session) return { state: "expired" };
  if (Date.now() > session.expiresAt) {
    sessions.delete(authorizationId);
    await writeDreaminaRuntimeState({ account: { state: "expired", refreshedAt: Date.now() } });
    return { state: "expired" };
  }
  const executablePath = await resolveDreaminaExecutable();
  await runDreaminaCommand({
    executablePath,
    args: ["login", "checklogin", `--device_code=${session.deviceCode}`, "--poll=0"],
    timeoutKind: "session",
  });
  // 中文注释：checklogin 的文本可能是泛化成功，必须以 user_credit 再次核验账号真值。
  const account = await inspectLogin(executablePath);
  if (account.loggedIn) {
    sessions.delete(authorizationId);
    // 中文注释：授权完成必须以 user_credit 复核后的字段为准，缺失积分不得伪造。
    await writeDreaminaRuntimeState({
      account: {
        state: "logged_in",
        points: account.creditBalance == null ? undefined : String(account.creditBalance),
        reason: account.creditBalance == null ? "CLI 未返回积分" : undefined,
        refreshedAt: Date.now(),
      },
    }, { replaceAccount: true });
    return { state: "logged_in" };
  }
  return { state: "authorizing" };
}

export function clearDreaminaAuthorizationSessions(): void {
  sessions.clear();
}
