import crypto from "node:crypto";
import type { Knex } from "knex";

/**
 * 项目库固定追加迁移：稳定资产 UUID 与分镜五表。
 * 必须由外层迁移事务包裹；失败则整段回滚，禁止半成品表结构。
 */
export async function migrateStoryboardProjectSchema(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (await database.schema.hasTable("o_assets") && !await database.schema.hasColumn("o_assets", "assetUuid")) {
    await database.schema.alterTable("o_assets", (table) => {
      table.string("assetUuid", 36);
    });
  }
  if (await database.schema.hasTable("o_assets")) {
    const rows = await database("o_assets").select("id", "assetUuid").orderBy("id");
    for (const row of rows) {
      if (typeof row.assetUuid === "string" && row.assetUuid.length > 0) continue;
      // 按主键逐行回填，不使用名称当身份，重复执行保持原 UUID。
      await database("o_assets").where({ id: row.id }).update({
        assetUuid: crypto.randomUUID(),
      });
    }
    await database.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_o_assets_asset_uuid ON o_assets(assetUuid)",
    );
  }

  if (!await database.schema.hasTable("o_storyboardShot")) {
    await database.raw(`
      CREATE TABLE o_storyboardShot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shotUuid TEXT NOT NULL UNIQUE,
        displayOrder INTEGER NOT NULL CHECK (displayOrder > 0),
        sourceText TEXT,
        visualDescription TEXT,
        imagePrompt TEXT,
        videoPrompt TEXT,
        negativePrompt TEXT,
        shotSize TEXT,
        cameraMovement TEXT,
        composition TEXT,
        durationMs INTEGER,
        aspectRatio TEXT,
        overrideJson TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE (displayOrder)
      )
    `);
  }

  if (!await database.schema.hasTable("o_storyboardShotAsset")) {
    await database.schema.createTable("o_storyboardShotAsset", (table) => {
      table.increments("id").primary();
      table.string("shotUuid", 36).notNullable();
      table.string("sourceProjectUuid", 36).notNullable();
      table.string("assetUuid", 36).notNullable();
      table.string("assetType", 16).notNullable();
      table.string("relationRole", 32).notNullable();
      table.unique(["shotUuid", "sourceProjectUuid", "assetUuid", "relationRole"]);
    });
  }

  if (!await database.schema.hasTable("o_storyboardWorkspaceSettings")) {
    await database.schema.createTable("o_storyboardWorkspaceSettings", (table) => {
      table.integer("id").primary();
      table.text("globalImagePrompt").notNullable().defaultTo("");
      table.text("globalVideoPrompt").notNullable().defaultTo("");
      table.text("globalNegativePrompt").notNullable().defaultTo("");
      table.string("textModel");
      table.string("imageModel");
      table.string("videoModel");
      table.string("aspectRatio").notNullable().defaultTo("16:9");
      table.string("resolution").notNullable().defaultTo("");
      table.integer("durationMs").notNullable().defaultTo(4000);
      table.integer("imageConcurrency").notNullable().defaultTo(1);
      table.integer("videoConcurrency").notNullable().defaultTo(1);
    });
  }
  const settings = await database("o_storyboardWorkspaceSettings").where({ id: 1 }).first();
  if (!settings) {
    await database("o_storyboardWorkspaceSettings").insert({
      id: 1,
      globalImagePrompt: "",
      globalVideoPrompt: "",
      globalNegativePrompt: "",
      textModel: null,
      imageModel: null,
      videoModel: null,
      aspectRatio: "16:9",
      resolution: "",
      durationMs: 4000,
      imageConcurrency: 1,
      videoConcurrency: 1,
    });
  }

  if (!await database.schema.hasTable("o_storyboardCandidate")) {
    await database.schema.createTable("o_storyboardCandidate", (table) => {
      table.increments("id").primary();
      table.string("candidateUuid", 36).notNullable().unique();
      table.string("shotUuid", 36).notNullable().index();
      table.string("mediaType", 16).notNullable();
      table.string("relativePath").notNullable();
      table.integer("selected").notNullable().defaultTo(0);
      table.string("createdAt").notNullable();
    });
  }

  if (!await database.schema.hasTable("o_storyboardGenerationTask")) {
    await database.schema.createTable("o_storyboardGenerationTask", (table) => {
      table.string("taskUuid", 36).primary();
      table.string("shotUuid", 36).notNullable().index();
      table.string("parentTaskUuid", 36);
      table.string("originDeviceUuid", 36).notNullable();
      table.string("mediaType", 16).notNullable();
      table.string("providerId").notNullable();
      table.string("providerTaskId");
      table.string("providerSessionId");
      table.string("mode").notNullable();
      table.string("modelName").notNullable();
      table.text("parametersJson").notNullable();
      table.string("requestDigest").notNullable();
      table.string("status").notNullable();
      table.integer("paidBatchConfirmedAt");
      table.integer("providerCompletedAt");
      table.string("resultLocatorDigest");
      table.integer("progress").notNullable().defaultTo(0);
      table.string("errorCode");
      table.string("errorSummary");
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
    });
  }
}

/**
 * 生成入队幂等协议：项目库保存用户操作与任务集合，跨库投影完成前保持不可领取。
 */
/**
 * 追加 o_assets.imageRatio；旧行保持空值，读取时按 16:9 展示，禁止回写旧库。
 */
export async function migrateOAssetsImageRatio(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (await database.schema.hasTable("o_assets") && !await database.schema.hasColumn("o_assets", "imageRatio")) {
    await database.schema.alterTable("o_assets", (table) => {
      table.string("imageRatio", 8);
    });
  }
}

/**
 * 追加 o_storyboardShotAsset.voiceEnabled；旧行按默认 true 读取，禁止回写其他列。
 */
export async function migrateOStoryboardShotAssetVoiceEnabled(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (
    await database.schema.hasTable("o_storyboardShotAsset")
    && !await database.schema.hasColumn("o_storyboardShotAsset", "voiceEnabled")
  ) {
    await database.schema.alterTable("o_storyboardShotAsset", (table) => {
      table.integer("voiceEnabled").notNullable().defaultTo(1);
    });
  }
}

/**
 * 追加 o_storyboardShot.era；旧行保持空值，禁止从其他文本猜测时代背景。
 */
export async function migrateOStoryboardShotEra(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (
    await database.schema.hasTable("o_storyboardShot")
    && !await database.schema.hasColumn("o_storyboardShot", "era")
  ) {
    await database.schema.alterTable("o_storyboardShot", (table) => {
      table.text("era");
    });
  }
}

/**
 * 工作台历史视频绑定即梦任务 UUID；只追加列，不回填旧行。
 */
export async function migrateOVideoGenerationTaskUuid(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasTable("o_video")) return;
  if (await database.schema.hasColumn("o_video", "generationTaskUuid")) return;
  await database.schema.alterTable("o_video", (table) => {
    table.string("generationTaskUuid", 36);
  });
  await database.raw(
    "CREATE INDEX IF NOT EXISTS idx_o_video_generation_task_uuid ON o_video(generationTaskUuid)",
  );
}

/**
 * generationTaskUuid 对非空值必须唯一；旧重复绑定先确定权威行，再审计解绑冲突行。
 * 旧供应商历史允许 NULL，禁止把空值回填成伪造任务身份。
 */
export async function migrateOVideoGenerationTaskUuidUnique(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasTable("o_video")) return;
  if (!await database.schema.hasColumn("o_video", "generationTaskUuid")) {
    throw new Error("o_video.generationTaskUuid 缺失，拒绝继续迁移");
  }
  // 中文注释：修复旧重复绑定时临时撤下运行时保护；成功或失败都在 finally 恢复保护触发器。
  await dropOVideoWorkbenchReadyBindingGuards(database);
  try {
    const existing = await database("o_video")
      .whereNotNull("generationTaskUuid")
      .orderBy("id")
      .select("id", "generationTaskUuid", "projectId", "scriptId", "videoTrackId");
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const row of existing as Array<Record<string, unknown>>) {
      const value = String(row.generationTaskUuid ?? "").trim();
      if (!value) continue;
      const rows = grouped.get(value) ?? [];
      rows.push(row);
      grouped.set(value, rows);
    }
    const duplicateTaskUuids = [...grouped.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([taskUuid]) => taskUuid);
    const taskOrigins = new Map<string, { projectId: number; scriptId: number; trackId: number }>();
    if (duplicateTaskUuids.length > 0 && await database.schema.hasTable("o_storyboardGenerationTask")) {
      const tasks = await database("o_storyboardGenerationTask")
        .whereIn("taskUuid", duplicateTaskUuids)
        .select("taskUuid", "parametersJson");
      for (const task of tasks) {
        try {
          const request = JSON.parse(String(task.parametersJson ?? "{}")) as Record<string, unknown>;
          const origin = request.workbenchOrigin as Record<string, unknown> | undefined;
          if (origin?.origin === "workbench") {
            taskOrigins.set(String(task.taskUuid ?? ""), {
              projectId: Number(origin.projectId),
              scriptId: Number(origin.scriptId),
              trackId: Number(origin.trackId),
            });
          }
        } catch {
          // 中文注释：损坏的旧任务参数不阻断项目打开，回退到最早历史行作为确定性权威行。
        }
      }
    }
    for (const taskUuid of duplicateTaskUuids) {
      const rows = grouped.get(taskUuid) ?? [];
      const origin = taskOrigins.get(taskUuid);
      const authority = rows.find((row) => origin
        && Number(row.projectId) === origin.projectId
        && Number(row.scriptId) === origin.scriptId
        && Number(row.videoTrackId) === origin.trackId) ?? rows[0];
      const conflictIds = rows
        .filter((row) => Number(row.id) !== Number(authority?.id))
        .map((row) => Number(row.id));
      if (conflictIds.length === 0) continue;
      // 中文注释：固定审计码保留迁移证据，同时解除重复 UUID，避免单条旧脏数据锁死整个项目。
      await database("o_video").whereIn("id", conflictIds).update({
        generationTaskUuid: null,
        errorReason: "[DREAMINA_VIDEO_BINDING_DUPLICATE] 已解除重复的生成任务绑定",
      });
    }
    await database.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_o_video_generation_task_uuid_unique
      ON o_video(generationTaskUuid)
      WHERE generationTaskUuid IS NOT NULL AND generationTaskUuid != ''
    `);
  } finally {
    await ensureOVideoWorkbenchReadyBindingGuards(database);
  }
}

const WORKBENCH_READY_DELETE_GUARD = "trg_o_video_workbench_ready_delete_guard";
const WORKBENCH_READY_IDENTITY_GUARD = "trg_o_video_workbench_ready_identity_guard";

async function dropOVideoWorkbenchReadyBindingGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  await database.raw(`DROP TRIGGER IF EXISTS ${WORKBENCH_READY_DELETE_GUARD}`);
  await database.raw(`DROP TRIGGER IF EXISTS ${WORKBENCH_READY_IDENTITY_GUARD}`);
}

/** ready 工作台任务的历史绑定一旦生效，不允许再删除或改写身份列。 */
export async function ensureOVideoWorkbenchReadyBindingGuards(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasTable("o_video")
    || !await database.schema.hasTable("o_storyboardGenerationTask")
    || !await database.schema.hasTable("o_storyboardGenerationOperation")
    || !await database.schema.hasColumn("o_video", "generationTaskUuid")) {
    return;
  }
  const readyWorkbenchTask = `
    EXISTS (
      SELECT 1
      FROM o_storyboardGenerationTask AS task
      LEFT JOIN o_storyboardGenerationOperation AS operation
        ON operation.clientOperationId = task.clientOperationId
      WHERE task.taskUuid = OLD.generationTaskUuid
        AND json_extract(
          CASE WHEN json_valid(task.parametersJson) = 1 THEN task.parametersJson ELSE '{}'
          END,
          '$.workbenchOrigin.origin'
        ) = 'workbench'
        AND (task.enqueueReady = 1 OR operation.state = 'ready')
    )
  `;
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${WORKBENCH_READY_DELETE_GUARD}
    BEFORE DELETE ON o_video
    WHEN OLD.generationTaskUuid IS NOT NULL AND ${readyWorkbenchTask}
    BEGIN
      SELECT RAISE(ABORT, 'WORKBENCH_VIDEO_BINDING_READY_GUARD');
    END
  `);
  await database.raw(`
    CREATE TRIGGER IF NOT EXISTS ${WORKBENCH_READY_IDENTITY_GUARD}
    BEFORE UPDATE OF generationTaskUuid, projectId, scriptId, videoTrackId ON o_video
    WHEN OLD.generationTaskUuid IS NOT NULL AND ${readyWorkbenchTask}
    BEGIN
      SELECT RAISE(ABORT, 'WORKBENCH_VIDEO_BINDING_READY_GUARD');
    END
  `);
}

/**
 * 项目保存所选视频指令模板 ID/内容快照；只追加列，不覆盖旧迁移。
 */
export async function migrateStoryboardVideoPromptTemplateSettings(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasTable("o_storyboardWorkspaceSettings")) return;
  if (!await database.schema.hasColumn("o_storyboardWorkspaceSettings", "videoPromptTemplateId")) {
    await database.schema.alterTable("o_storyboardWorkspaceSettings", (table) => {
      table.integer("videoPromptTemplateId");
    });
  }
  if (!await database.schema.hasColumn("o_storyboardWorkspaceSettings", "videoPromptTemplateContent")) {
    await database.schema.alterTable("o_storyboardWorkspaceSettings", (table) => {
      table.text("videoPromptTemplateContent");
    });
  }
}

export async function migrateStoryboardGenerationEnqueueIdempotency(
  database: Knex | Knex.Transaction,
): Promise<void> {
  if (!await database.schema.hasTable("o_storyboardGenerationOperation")) {
    await database.schema.createTable("o_storyboardGenerationOperation", (table) => {
      table.string("clientOperationId", 36).primary();
      table.string("operationDigest", 64).notNullable();
      table.string("requestIntentDigest", 64).notNullable();
      table.integer("itemCount").notNullable();
      table.integer("paidBatchConfirmed").notNullable().defaultTo(0);
      table.string("state", 16).notNullable().defaultTo("preparing");
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
    });
  }
  if (!await database.schema.hasColumn("o_storyboardGenerationOperation", "requestIntentDigest")) {
    await database.schema.alterTable("o_storyboardGenerationOperation", (table) => {
      table.string("requestIntentDigest", 64);
    });
  }
  // 中文注释：早期中断版本没有请求意图列；用既有批次 SHA 回填，保证启动恢复可前滚。
  await database("o_storyboardGenerationOperation")
    .whereNull("requestIntentDigest")
    .update({ requestIntentDigest: database.ref("operationDigest") });
  if (!await database.schema.hasColumn("o_storyboardGenerationTask", "clientOperationId")) {
    await database.schema.alterTable("o_storyboardGenerationTask", (table) => {
      table.string("clientOperationId", 36);
    });
  }
  if (!await database.schema.hasColumn("o_storyboardGenerationTask", "operationItemIndex")) {
    await database.schema.alterTable("o_storyboardGenerationTask", (table) => {
      table.integer("operationItemIndex");
    });
  }
  if (!await database.schema.hasColumn("o_storyboardGenerationTask", "enqueueReady")) {
    await database.schema.alterTable("o_storyboardGenerationTask", (table) => {
      table.integer("enqueueReady").notNullable().defaultTo(1);
    });
  }
  if (!await database.schema.hasColumn("o_storyboardGenerationTask", "projectConcurrencyLimit")) {
    await database.schema.alterTable("o_storyboardGenerationTask", (table) => {
      table.integer("projectConcurrencyLimit");
    });
  }
  if (!await database.schema.hasColumn("o_storyboardGenerationTask", "modelConcurrencyLimit")) {
    await database.schema.alterTable("o_storyboardGenerationTask", (table) => {
      table.integer("modelConcurrencyLimit");
    });
  }
  await database.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_storyboard_generation_operation_item
    ON o_storyboardGenerationTask(clientOperationId, operationItemIndex)
  `);
}
