import type { Knex } from "knex";

import { runLegacyDatabaseRepairs } from "@/lib/fixDB";
import { getInitialTableSchemas } from "@/lib/initDB";
import rawVendorData from "@/lib/vendor.json";
import u from "@/utils";
import getPath from "@/utils/getPath";
import {
  CURRENT_VENDOR_ID,
  LEGACY_VENDOR_ID,
} from "../identity/product-identity";
import {
  migrateLegacyVendorIdentity,
  migrateLegacyVendorSourceFile,
} from "./product-identity-migration";
import {
  migrateJiasuProviderModelCatalogV44,
  migrateJiasuProviderV4,
} from "./jiasu-provider-migration";
import { migrateProviderImageRecovery } from "./provider-image-recovery-migration";
import { migrateDefaultVideoPromptToChinese } from "./video-prompt-language-migration";
import {
  migrateOAssetsImageRatio,
  migrateOStoryboardShotAssetVoiceEnabled,
  migrateOStoryboardShotEra,
  migrateOVideoGenerationTaskUuid,
  migrateOVideoGenerationTaskUuidUnique,
  migrateStoryboardGenerationEnqueueIdempotency,
  migrateStoryboardProjectSchema,
  migrateStoryboardVideoPromptTemplateSettings,
} from "./storyboard-project-migration";
import {
  migrateCanvasProjectSchema,
  migrateCanvasSceneCreationProgressColumns,
} from "./canvas-project-migration";
import { migrateCanvasAccountStagingReservations } from "../canvas/canvas-import-staging-reservation-store";
import {
  migrateDreaminaCliAccountSchema,
  migrateDreaminaCliEnabled,
  migrateDreaminaCliPauseReason,
  migrateDreaminaCliPollSeconds,
  migrateDreaminaDispatchEnqueueIdempotency,
} from "./dreamina-cli-account-migration";
import { migrateDreaminaCliRuntimeStateSchema } from "./dreamina-cli-runtime-state-migration";
import type { SqliteMigration } from "./sqlite-migrator";

export type ApplicationDatabaseRole = "account" | "project";

export interface ApplicationMigrationOptions {
  role: ApplicationDatabaseRole;
  skipEmbeddingInit: boolean;
}

/**
 * 旧 initDB 中每张表各占一个不可变版本，表、索引和该表默认数据同事务提交。
 * 已存在的真实旧表只登记版本，不重建、不覆盖原行或主键。
 * skipEmbeddingInit 只控制既有向量初始化，绝不参与数据库归属判断。
 */
export function buildApplicationMigrations(
  options: ApplicationMigrationOptions,
): SqliteMigration[] {
  const tableMigrations = getInitialTableSchemas(options.skipEmbeddingInit).map((schema, index) => ({
    version: index + 1,
    name: `baseline-${schema.name.replace(/^o_/, "").replace(/[^a-z0-9]+/gi, "-")}`,
    checksumSource: `${CURRENT_VENDOR_ID}-baseline-table-v1:${schema.name}`,
    compatibleChecksumSources: [
      `${LEGACY_VENDOR_ID}-baseline-table-v1:${schema.name}`,
    ],
    up: async (database: Knex | Knex.Transaction) => {
      if (await database.schema.hasTable(schema.name)) return;
      await database.schema.createTable(schema.name, schema.builder);
      if (schema.initData) await schema.initData(database as Knex);
    },
  }));
  return [
    ...tableMigrations,
    {
      version: tableMigrations.length + 1,
      name: "legacy-schema-and-default-repairs",
      checksumSource: `${CURRENT_VENDOR_ID}-fixdb-v1:columns-defaults-prompts-vendor-metadata`,
      compatibleChecksumSources: [
        `${LEGACY_VENDOR_ID}-fixdb-v1:columns-defaults-prompts-vendor-metadata`,
      ],
      up: async (database) => {
        await runLegacyDatabaseRepairs(database as Knex);
      },
    },
    {
      version: tableMigrations.length + 2,
      name: "generation-task-recovery-metadata",
      checksumSource: "o_tasks provider remoteTaskId projectUuid requestDigest createdAt lastPollAt generationStatus manualRetryRequired recoveryAttemptedAt v1",
      up: async (database) => {
        const columns: Array<[string, "string" | "text" | "integer"]> = [
          ["provider", "string"],
          ["remoteTaskId", "string"],
          ["projectUuid", "string"],
          ["requestDigest", "string"],
          ["createdAt", "integer"],
          ["lastPollAt", "integer"],
          ["generationStatus", "string"],
          ["manualRetryRequired", "integer"],
          ["recoveryAttemptedAt", "integer"],
        ];
        for (const [column, type] of columns) {
          if (await database.schema.hasColumn("o_tasks", column)) continue;
          await database.schema.alterTable("o_tasks", (table) => {
            if (type === "integer") table.integer(column);
            else if (type === "text") table.text(column);
            else table.string(column);
          });
        }
      },
    },
    {
      version: tableMigrations.length + 3,
      name: "generation-task-status-hint",
      checksumSource: "o_tasks remoteStatusHint v1",
      up: async (database) => {
        if (await database.schema.hasColumn("o_tasks", "remoteStatusHint")) return;
        await database.schema.alterTable("o_tasks", (table) => {
          // 只保存不含主机、查询参数和凭据的创建端点路径，供重启后选择状态接口。
          table.string("remoteStatusHint");
        });
      },
    },
    {
      version: tableMigrations.length + 4,
      name: "product-machine-identity-v1",
      checksumSource: "tianjiang vendor ids model prefixes and references v1",
      up: async (database) => {
        await migrateLegacyVendorIdentity(database);
        migrateLegacyVendorSourceFile(getPath("vendor"));
      },
    },
    {
      version: tableMigrations.length + 5,
      name: "legacy-mutation-journal-v1",
      // 中文注释：与产物同库的 mutation journal，作为 sidecar 之外的权威事实
      checksumSource: "o_legacyMutationJournal source status createdAt updatedAt v1",
      up: async (database) => {
        if (await database.schema.hasTable("o_legacyMutationJournal")) return;
        await database.schema.createTable("o_legacyMutationJournal", (table) => {
          table.increments("id").primary();
          table.string("source").notNullable();
          table.string("status").notNullable(); // pending | cleared
          table.integer("createdAt").notNullable();
          table.integer("updatedAt").notNullable();
        });
      },
    },
    {
      version: tableMigrations.length + 6,
      name: "legacy-mutation-journal-generation-v1",
      // 中文注释：mutation generation 单调递增，中央确认后仅清 <= captured
      checksumSource: "o_legacyMutationJournal generation column v1",
      up: async (database) => {
        if (!(await database.schema.hasTable("o_legacyMutationJournal"))) {
          await database.schema.createTable("o_legacyMutationJournal", (table) => {
            table.increments("id").primary();
            table.string("source").notNullable();
            table.string("status").notNullable();
            table.integer("generation").notNullable().defaultTo(1);
            table.integer("createdAt").notNullable();
            table.integer("updatedAt").notNullable();
          });
          return;
        }
        const hasCol = await database.schema.hasColumn("o_legacyMutationJournal", "generation");
        if (!hasCol) {
          await database.schema.alterTable("o_legacyMutationJournal", (table) => {
            table.integer("generation").notNullable().defaultTo(1);
          });
        }
      },
    },
    {
      version: tableMigrations.length + 7,
      name: "jiasu-provider-v4",
      checksumSource: "tianjiang provider jiasu api v4 preserve account secrets models enable v1",
      up: async (database) => {
        await migrateJiasuProviderV4(database, {
          builtinSource: rawVendorData["tianjiang.ts"],
          readInstalledVersion: () => {
            const code = u.vendor.getCode("tianjiang");
            if (!code) return undefined;
            try {
              return String(u.vendor.getVendor("tianjiang")?.version ?? "");
            } catch {
              // 损坏或无法执行的旧内置源码按待修复版本处理。
              return undefined;
            }
          },
          writeInstalledSource: (source) => u.vendor.writeCode("tianjiang", source),
        });
      },
    },
    {
      version: tableMigrations.length + 8,
      name: "provider-image-routing-v1",
      checksumSource: "jiasu v4.1 brand links documented presets and volcengine media route v1",
      up: async (database) => {
        await migrateProviderImageRecovery(database, {
          builtinSources: {
            tianjiang: rawVendorData["tianjiang.ts"],
            volcengine: rawVendorData["volcengine.ts"],
          },
          readInstalledVersion: (providerId) => {
            const code = u.vendor.getCode(providerId);
            if (!code) return undefined;
            try {
              return String(u.vendor.getVendor(providerId)?.version ?? "");
            } catch {
              // 无法执行的旧动态源码按待修复版本处理，数据库私有配置不受影响。
              return undefined;
            }
          },
          writeInstalledSource: (providerId, source) => u.vendor.writeCode(providerId, source),
        });
      },
    },
    {
      version: tableMigrations.length + 9,
      name: "video-prompt-default-zh-v1",
      checksumSource: "unchanged builtin video prompt defaults migrate to Chinese output v1",
      up: async (database) => {
        // 只升级精确命中的旧默认提示词，用户 useData 与修改过的 data 都必须保留。
        await migrateDefaultVideoPromptToChinese(database);
      },
    },
    {
      version: tableMigrations.length + 10,
      name: options.role === "account"
        ? "database-role-account-v1"
        : "database-role-project-v1",
      // 角色标记不能按表是否存在猜测，错误角色再次打开必须在此处校验和漂移。
      checksumSource: options.role === "account"
        ? "application-database-role-account-v1"
        : "application-database-role-project-v1",
      up: async () => {
        // 纯角色标记，不写业务表。
      },
    },
    ...(options.role === "project"
      ? [
          {
            version: tableMigrations.length + 11,
            name: "storyboard-project-schema-v1",
            checksumSource: "stable o_assets.assetUuid and five storyboard project tables v1",
            up: migrateStoryboardProjectSchema,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 12,
            name: "storyboard-generation-enqueue-idempotency-v1",
            checksumSource: "storyboard generation operation idempotency ready protocol v1",
            up: migrateStoryboardGenerationEnqueueIdempotency,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 13,
            name: "o-assets-image-ratio-v1",
            checksumSource: "append o_assets.imageRatio 16:9 9:16 v1",
            up: migrateOAssetsImageRatio,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 14,
            name: "storyboard-shot-asset-voice-enabled-v1",
            checksumSource: "append o_storyboardShotAsset.voiceEnabled default true v1",
            up: migrateOStoryboardShotAssetVoiceEnabled,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 15,
            name: "storyboard-shot-era-v1",
            checksumSource: "append o_storyboardShot.era empty default v1",
            up: migrateOStoryboardShotEra,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 16,
            name: "storyboard-video-prompt-template-settings-v1",
            checksumSource: "append o_storyboardWorkspaceSettings videoPromptTemplateId content v1",
            up: migrateStoryboardVideoPromptTemplateSettings,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 17,
            name: "o-video-generation-task-uuid-v1",
            checksumSource: "append o_video.generationTaskUuid workbench dreamina history v1",
            up: migrateOVideoGenerationTaskUuid,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 18,
            name: "o-video-generation-task-uuid-unique-v1",
            checksumSource: "unique o_video.generationTaskUuid where not null v1",
            up: migrateOVideoGenerationTaskUuidUnique,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 19,
            name: "generation-task-result-locator-v1",
            checksumSource: "o_tasks resultLocator pending_finalize artifact v1",
            up: async (database) => {
              if (await database.schema.hasColumn("o_tasks", "resultLocator")) return;
              await database.schema.alterTable("o_tasks", (table) => {
                table.text("resultLocator");
              });
            },
          } satisfies SqliteMigration,
          {
            // 中文注释：运行时 resultLocator 与画布表都是同一未发布基线后的新迁移，必须使用不同的递增版本。
            version: tableMigrations.length + 20,
            name: "canvas-project-schema-v1",
            checksumSource: "personal canvas project sqlite schema v1",
            up: migrateCanvasProjectSchema,
          } satisfies SqliteMigration,
          {
            // 中文注释：计划必须耐久保存；独立迁移确保已安装 canvas-project-schema-v1 的项目也能升级。
            version: tableMigrations.length + 21,
            name: "canvas-durable-plans-v1",
            checksumSource: "durable canvas AI mutation plans v1",
            up: async (database) => {
              await database.raw(`
                CREATE TABLE IF NOT EXISTS canvas_plans (
                  plan_uuid TEXT PRIMARY KEY,
                  project_uuid TEXT NOT NULL,
                  base_revision INTEGER NOT NULL,
                  source TEXT NOT NULL CHECK (source IN ('home','chat')),
                  digest TEXT NOT NULL,
                  plan_json TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  created_at TEXT NOT NULL
                )
              `);
            },
          } satisfies SqliteMigration,
          {
            // 中文注释：beta.25 曾修改已登记迁移的实现体；旧库不会重跑，必须追加新版本补列。
            version: tableMigrations.length + 22,
            name: "canvas-scene-creation-progress-v1",
            checksumSource: "append canvas scene creation progress columns v1",
            up: migrateCanvasSceneCreationProgressColumns,
          } satisfies SqliteMigration,
        ]
      : [
          {
            version: tableMigrations.length + 11,
            name: "dreamina-cli-account-v1",
            checksumSource: "dreamina cli account settings session dispatch v1",
            up: migrateDreaminaCliAccountSchema,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 12,
            name: "dreamina-cli-runtime-state-v1",
            checksumSource: "dreamina cli account runtime state cache v1",
            up: migrateDreaminaCliRuntimeStateSchema,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 13,
            name: "dreamina-dispatch-enqueue-idempotency-v1",
            checksumSource: "dreamina dispatch project operation item ready protocol v1",
            up: migrateDreaminaDispatchEnqueueIdempotency,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 14,
            name: "dreamina-cli-enabled-v1",
            checksumSource: "append o_dreaminaCliSettings.enabled default on v1",
            up: migrateDreaminaCliEnabled,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 15,
            name: "dreamina-cli-pause-reason-v1",
            checksumSource: "append o_dreaminaCliSettings.pauseReason migrate legacy paused to manual_pause v1",
            up: migrateDreaminaCliPauseReason,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 16,
            name: "dreamina-cli-poll-seconds-v1",
            checksumSource: "append o_dreaminaCliSettings.pollSeconds default 30 range 5 300 v1",
            up: migrateDreaminaCliPollSeconds,
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 17,
            name: "jiasu-provider-model-catalog-v4-4",
            checksumSource: "upgrade installed tianjiang provider source below 4.4 for remote model catalog v1",
            up: async (database) => {
              await migrateJiasuProviderModelCatalogV44(database, {
                builtinSource: rawVendorData["tianjiang.ts"],
                readInstalledVersion: () => {
                  const code = u.vendor.getCode("tianjiang");
                  if (!code) return undefined;
                  try {
                    return String(u.vendor.getVendor("tianjiang")?.version ?? "");
                  } catch {
                    // 损坏或无法执行的旧动态源码按待修复版本处理。
                    return undefined;
                  }
                },
                writeInstalledSource: (source) => u.vendor.writeCode("tianjiang", source),
              });
            },
          } satisfies SqliteMigration,
          {
            version: tableMigrations.length + 18,
            name: "generation-task-result-locator-v1",
            checksumSource: "o_tasks resultLocator pending_finalize artifact v1",
            up: async (database) => {
              if (!(await database.schema.hasTable("o_tasks"))) return;
              if (await database.schema.hasColumn("o_tasks", "resultLocator")) return;
              await database.schema.alterTable("o_tasks", (table) => {
                table.text("resultLocator");
              });
            },
          } satisfies SqliteMigration,
          {
            // 中文注释：账号级画布导入预留表排在 resultLocator 之后，避免复用同一迁移版本。
            version: tableMigrations.length + 19,
            name: "canvas-import-staging-reservations-v1",
            checksumSource: "account local canvas import staging reservations not in project snapshot v1",
            up: migrateCanvasAccountStagingReservations,
          } satisfies SqliteMigration,
        ]),
  ];
}
