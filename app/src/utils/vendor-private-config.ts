import type { Knex } from "knex";

interface VendorInputDefinition {
  key: string;
  type: "text" | "password" | "url";
}

/**
 * 仅供当前账号的本地受信后端和设置页受控读取。
 * 最新产品决定允许供应商密钥在当前账号隔离的 db2.sqlite 中明文保存。
 */
export async function loadVendorPrivateInputs(
  vendorId: string,
  database?: Knex,
): Promise<Record<string, string>> {
  // 密钥属于账号配置：默认读账号 db2，即使 ALS 在 projectUuid 下也不得读项目库。
  // 禁止回退全局库/默认账号；无认证上下文时 accountDatabase 失败关闭。
  const activeDatabase =
    database ?? (await import("@/utils/db")).accountDatabase();
  const row = await activeDatabase("o_vendorConfig")
    .where("id", vendorId)
    .select("inputValues")
    .first() as { inputValues?: string | null } | undefined;
  if (!row) throw new Error(`未找到供应商配置 id=${vendorId}`);
  const parsed = JSON.parse(row.inputValues ?? "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`供应商私密配置格式无效 id=${vendorId}`);
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`供应商私密配置值无效 id=${vendorId}`);
    output[key] = value;
  }
  return output;
}

/**
 * db2 可按产品决定保存当前账号明文，但动态供应商源码不是账号业务库。
 * 源码写盘前仍剥离密码型/密钥型字符串字面量，避免形成额外副本。
 */
export function sanitizeVendorSourceSecrets(
  source: string,
  inputs: VendorInputDefinition[],
  inputValues: Record<string, string>,
): string {
  let sanitized = source;
  for (const input of inputs) {
    if (
      input.type !== "password"
      && !/(?:api[-_]?key|access[-_]?key|secret|token|password|credential)/i.test(input.key)
    ) continue;
    const value = inputValues[input.key];
    if (!value) continue;
    const quoted = [
      JSON.stringify(value),
      `'${escapeQuoted(value, "'")}'`,
      `\`${escapeQuoted(value, "`")}\``,
    ];
    for (const literal of quoted) {
      sanitized = sanitized.split(literal).join(`${literal[0]}${literal.at(-1)}`);
    }
    if (sanitized.includes(value)) {
      throw new Error(`供应商源码包含无法安全移除的敏感字段 ${input.key}`);
    }
  }
  return sanitized;
}

function escapeQuoted(value: string, quote: "'" | "`"): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(quote, `\\${quote}`)
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}
