import { MAX_PROVIDER_FAILURE_BYTES } from "../contracts";

const SECRET_KEYS = /authorization|token|accesskey|cookie|secret|signature/i;

/** 中文注释：进入项目库的 payload 只保留白名单字段，凭据替换为 [REDACTED_SECRET]。 */
export function normalizeProviderEventPayload(input: {
  status?: string;
  eventId?: string;
  remoteTaskId?: string;
  occurredAt?: string;
  progress?: number;
  assetUuid?: string;
  failureText?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const failure = redactFailure(input.failureText ?? "");
  return {
    status: input.status ?? "",
    eventId: input.eventId ?? "",
    remoteTaskId: input.remoteTaskId ?? "",
    occurredAt: input.occurredAt ?? "",
    progress: typeof input.progress === "number" ? input.progress : 0,
    assetUuid: input.assetUuid ?? "",
    failureText: failure,
  };
}

export function redactFailure(text: string): string {
  const replaced = text
    .replace(/Bearer\s+\S+/gi, "[REDACTED_SECRET]")
    .replace(/AKIA[0-9A-Z]+/g, "[REDACTED_SECRET]")
    .replace(/https?:\/\/[^\s]+[?&][^\s]*/gi, "[REDACTED_SECRET]");
  const bytes = Buffer.from(replaced, "utf8");
  if (bytes.length <= MAX_PROVIDER_FAILURE_BYTES) return replaced;
  return bytes.subarray(0, MAX_PROVIDER_FAILURE_BYTES).toString("utf8");
}

export function stripSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretFields);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(key)) {
      result[key] = "[REDACTED_SECRET]";
      continue;
    }
    result[key] = stripSecretFields(item);
  }
  return result;
}

void MAX_PROVIDER_FAILURE_BYTES;
