import type { Knex } from "knex";

/**
 * 仅账号库追加即梦本机运行态。不得保存 token、Cookie、device_code 或 CLI 私有库。
 * 已发布的 dreamina-cli-account-v1 校验和禁止改动，因此本表必须作为新版本追加。
 */
export async function migrateDreaminaCliRuntimeStateSchema(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasTable("o_dreaminaCliRuntimeState")) {
    await database.raw(`
      CREATE TABLE o_dreaminaCliRuntimeState (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        executablePath TEXT,
        preferredExecutionTarget TEXT NOT NULL CHECK (preferredExecutionTarget IN ('windows_native', 'wsl')),
        effectiveExecutionTarget TEXT CHECK (
          effectiveExecutionTarget IS NULL
          OR effectiveExecutionTarget IN ('windows_native', 'wsl')
        ),
        installState TEXT NOT NULL CHECK (
          installState IN ('not_installed', 'installing', 'installed', 'repair_required', 'failed')
        ),
        installVersion TEXT,
        installManaged INTEGER NOT NULL CHECK (installManaged IN (0, 1)),
        installCheckedAt INTEGER,
        installReason TEXT,
        accountState TEXT NOT NULL CHECK (
          accountState IN ('unknown', 'logged_out', 'authorizing', 'logged_in', 'expired', 'failed')
        ),
        accountPoints TEXT,
        accountPlanName TEXT,
        accountExpiresAt TEXT,
        accountRefreshedAt INTEGER,
        accountReason TEXT,
        pendingOperation TEXT NOT NULL CHECK (
          pendingOperation IN ('none', 'feature_install', 'distribution_install', 'cli_install')
        ),
        updatedAt INTEGER NOT NULL
      )
    `);
  }

  const existing = await database("o_dreaminaCliRuntimeState").where({ id: 1 }).first();
  if (existing) return;

  let executablePath: string | null = null;
  if (await database.schema.hasTable("o_dreaminaCliSettings")) {
    const settings = await database("o_dreaminaCliSettings").where({ id: 1 }).first();
    if (typeof settings?.executablePath === "string" && settings.executablePath) {
      executablePath = settings.executablePath;
    }
  }

  await database("o_dreaminaCliRuntimeState").insert({
    id: 1,
    executablePath,
    preferredExecutionTarget: "windows_native",
    effectiveExecutionTarget: null,
    installState: "not_installed",
    installVersion: null,
    installManaged: 0,
    installCheckedAt: null,
    installReason: null,
    accountState: "unknown",
    accountPoints: null,
    accountPlanName: null,
    accountExpiresAt: null,
    accountRefreshedAt: null,
    accountReason: null,
    pendingOperation: "none",
    updatedAt: Date.now(),
  });
}
