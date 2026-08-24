import type { Knex } from "knex";

/**
 * 仅账号库追加即梦本机设置、会话映射和调度投影。
 * 不得写入项目库，也不得保存 Cookie、token 或 CLI 私有任务库路径。
 */
export async function migrateDreaminaCliAccountSchema(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasTable("o_dreaminaCliSettings")) {
    await database.raw(`
      CREATE TABLE o_dreaminaCliSettings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        executablePath TEXT,
        maxConcurrency INTEGER NOT NULL CHECK (maxConcurrency >= 1 AND maxConcurrency <= 8),
        pauseNewClaims INTEGER NOT NULL CHECK (pauseNewClaims IN (0, 1)),
        updatedAt INTEGER NOT NULL
      )
    `);
  }
  const settings = await database("o_dreaminaCliSettings").where({ id: 1 }).first();
  if (!settings) {
    await database("o_dreaminaCliSettings").insert({
      id: 1,
      executablePath: null,
      maxConcurrency: 1,
      pauseNewClaims: 0,
      updatedAt: Date.now(),
    });
  }

  if (!await database.schema.hasTable("o_dreaminaCliSession")) {
    await database.raw(`
      CREATE TABLE o_dreaminaCliSession (
        projectUuid TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        sessionName TEXT NOT NULL,
        cliVersion TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
  }

  if (!await database.schema.hasTable("o_dreaminaCliDispatch")) {
    await database.raw(`
      CREATE TABLE o_dreaminaCliDispatch (
        taskUuid TEXT PRIMARY KEY,
        projectUuid TEXT NOT NULL,
        originDeviceUuid TEXT NOT NULL,
        mediaType TEXT NOT NULL CHECK (mediaType IN ('image', 'video')),
        providerId TEXT NOT NULL CHECK (providerId = 'dreamina-cli'),
        modelName TEXT NOT NULL,
        mode TEXT NOT NULL,
        projectConcurrencyLimit INTEGER NOT NULL,
        modelConcurrencyLimit INTEGER NOT NULL,
        queueState TEXT NOT NULL CHECK (queueState IN ('queued', 'claiming', 'provider_active', 'postprocessing', 'terminal')),
        providerState TEXT NOT NULL CHECK (providerState IN ('not_sent', 'running', 'completed', 'failed', 'unknown')),
        providerResultJson TEXT,
        providerTerminalAt INTEGER,
        leaseOwner TEXT,
        leaseExpiresAt INTEGER,
        slotHeld INTEGER NOT NULL CHECK (slotHeld IN (0, 1)),
        notificationsMuted INTEGER NOT NULL CHECK (notificationsMuted IN (0, 1)),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
  }
}

/** 账号投影在完整批次 ready 前不可被领取；唯一键必须包含项目边界。 */
/** 追加即梦 CLI 启用开关；旧账号默认开启，禁止猜测其它 CLI 参数。 */
export async function migrateDreaminaCliEnabled(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (
    await database.schema.hasTable("o_dreaminaCliSettings")
    && !await database.schema.hasColumn("o_dreaminaCliSettings", "enabled")
  ) {
    await database.schema.alterTable("o_dreaminaCliSettings", (table) => {
      table.integer("enabled").notNullable().defaultTo(1);
    });
  }
}

/**
 * 为暂停领取增加稳定原因。旧 pauseNewClaims=true 来自历史手工设置，迁移时按手动暂停保留。
 * disabled 是由 enabled 派生的 API 状态，不写入数据库。
 */
export async function migrateDreaminaCliPauseReason(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasTable("o_dreaminaCliSettings")) return;
  if (!await database.schema.hasColumn("o_dreaminaCliSettings", "pauseReason")) {
    await database.schema.alterTable("o_dreaminaCliSettings", (table) => {
      table.string("pauseReason").notNullable().defaultTo("none");
    });
  }
  await database("o_dreaminaCliSettings")
    .where({ pauseNewClaims: 1 })
    .andWhere((query) => query.whereNull("pauseReason").orWhere({ pauseReason: "none" }))
    .update({ pauseReason: "manual_pause" });
}

/** 轮询间隔只保存在当前账号本机库；旧账号统一采用 30 秒。 */
export async function migrateDreaminaCliPollSeconds(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasTable("o_dreaminaCliSettings")) return;
  if (!await database.schema.hasColumn("o_dreaminaCliSettings", "pollSeconds")) {
    await database.schema.alterTable("o_dreaminaCliSettings", (table) => {
      table.integer("pollSeconds").notNullable().defaultTo(30);
    });
  }
  // 中文注释：历史异常值统一回到安全默认，避免把无界轮询参数交给真实 CLI。
  await database("o_dreaminaCliSettings")
    .whereNull("pollSeconds")
    .orWhere("pollSeconds", "<", 5)
    .orWhere("pollSeconds", ">", 300)
    .update({ pollSeconds: 30 });
}

export async function migrateDreaminaDispatchEnqueueIdempotency(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasColumn("o_dreaminaCliDispatch", "clientOperationId")) {
    await database.schema.alterTable("o_dreaminaCliDispatch", (table) => {
      table.string("clientOperationId", 36);
    });
  }
  if (!await database.schema.hasColumn("o_dreaminaCliDispatch", "operationItemIndex")) {
    await database.schema.alterTable("o_dreaminaCliDispatch", (table) => {
      table.integer("operationItemIndex");
    });
  }
  if (!await database.schema.hasColumn("o_dreaminaCliDispatch", "dispatchReady")) {
    await database.schema.alterTable("o_dreaminaCliDispatch", (table) => {
      table.integer("dispatchReady").notNullable().defaultTo(1);
    });
  }
  if (!await database.schema.hasColumn("o_dreaminaCliDispatch", "dispatchIdentityDigest")) {
    await database.schema.alterTable("o_dreaminaCliDispatch", (table) => {
      table.string("dispatchIdentityDigest", 64);
    });
  }
  await database.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dreamina_dispatch_operation_item
    ON o_dreaminaCliDispatch(projectUuid, clientOperationId, operationItemIndex)
  `);
}
