import crypto from "node:crypto";
import { db as activeDb } from "@/utils/db";
import { runWithProjectStorage } from "../runtime/user-storage-context";
import { upsertPendingMutationJournalInTrx } from "../runtime/legacy-mutation-journal";
import type { StoryboardWorkspaceSettings } from "./storyboard-generation-service";
import type { SharedAssetList } from "./shared-asset-gateway";
import {
  matchAssetsForPrompt,
  type MatchableAsset,
} from "./storyboard-asset-matcher";
import {
  applyLiteralReplacement,
  planLiteralReplacement,
} from "./storyboard-prompt-replace";
import type {
  AutoMatchAssetsResult,
  AutoMatchShotResult,
  BatchReplacePromptResult,
  InsertShotInput,
  ReorderShotsInput,
  StoryboardAssetBindingInput,
  StoryboardCandidateDto,
  StoryboardGenerationTaskDto,
  StoryboardShotDto,
  StoryboardShotPatch,
} from "./storyboard-contracts";

const MATCH_ASSET_BATCH_SIZE = 5;
const MAX_VIDEO_PROMPT_CHARS = 20_000;
const MAX_BATCH_REPLACE_TOTAL_CHARS = 2_000_000;

/**
 * 单项目连续分镜序列。显示序号不是主键；所有排序在同一 SQLite 事务中完成。
 */
export class StoryboardService {
  constructor(private readonly projectUuid: string) {}

  async getSettings(): Promise<StoryboardWorkspaceSettings> {
    return runWithProjectStorage(this.projectUuid, async () => {
      const row = await activeDb("o_storyboardWorkspaceSettings").where({ id: 1 }).first();
      return {
        globalImagePrompt: String(row?.globalImagePrompt ?? ""),
        globalVideoPrompt: String(row?.globalVideoPrompt ?? ""),
        globalNegativePrompt: String(row?.globalNegativePrompt ?? ""),
        textModel: row?.textModel ?? null,
        imageModel: row?.imageModel ?? null,
        videoModel: row?.videoModel ?? null,
        aspectRatio: String(row?.aspectRatio ?? "16:9"),
        resolution: String(row?.resolution ?? ""),
        durationMs: Number(row?.durationMs ?? 4000),
        imageConcurrency: Number(row?.imageConcurrency ?? 1),
        videoConcurrency: Number(row?.videoConcurrency ?? 1),
        videoPromptTemplateId: row?.videoPromptTemplateId == null ? null : Number(row.videoPromptTemplateId),
        videoPromptTemplateContent: row?.videoPromptTemplateContent ?? "",
      };
    });
  }

  async saveSettings(patch: Partial<StoryboardWorkspaceSettings>): Promise<StoryboardWorkspaceSettings> {
    return runWithProjectStorage(this.projectUuid, async () => {
      const current = await this.getSettings();
      // 中文注释：只写现有设置白名单列，禁止把未知字段展开成 SQLite 列。
      const next = applyWorkspaceSettingsPatch(current, patch);
      if (Object.prototype.hasOwnProperty.call(patch, "durationMs") || next.durationMs !== current.durationMs) {
        const { parseStoryboardVideoDurationMs } = await import("./storyboard-video-prompt");
        parseStoryboardVideoDurationMs(next.durationMs);
      }
      await activeDb("o_storyboardWorkspaceSettings").where({ id: 1 }).update(toWorkspaceSettingsRow(next));
      return next;
    });
  }

  async saveProjectArtStyle(artStyle: string | null): Promise<void> {
    return runWithProjectStorage(this.projectUuid, async () => {
      if (!await activeDb.schema.hasTable("o_project")) return;
      await activeDb("o_project").update({ artStyle: artStyle == null || artStyle === "" ? null : String(artStyle) });
    });
  }

  async getProjectArtStyle(): Promise<{ name: string; prompt: string }> {
    const project = await runWithProjectStorage(this.projectUuid, () => activeDb("o_project").first());
    const name = String(project?.artStyle ?? "").trim();
    const { resolveStoryboardStylePrompt } = await import("./storyboard-video-style");
    return { name, prompt: await resolveStoryboardStylePrompt(this.projectUuid) };
  }

  async listShots(): Promise<readonly StoryboardShotDto[]> {
    return runWithProjectStorage(this.projectUuid, async () => {
      const shots = await activeDb("o_storyboardShot").orderBy("displayOrder");
      // 中文注释：首尾帧语义依赖绑定顺序，必须按自增 id 稳定读取，禁止依赖 SQLite 查询计划。
      const bindings = await activeDb("o_storyboardShotAsset").orderBy("id").select();
      const candidateRows = await activeDb("o_storyboardCandidate")
        .orderBy("createdAt")
        .orderBy("candidateUuid");
      const generationTaskRows = await activeDb("o_storyboardGenerationTask")
        .orderBy("createdAt")
        .orderBy("taskUuid");

      // 中文注释：四张表各读一次后在内存分组，镜头数量增长时禁止退化成 N+1 查询。
      const bindingsByShot = new Map<string, any[]>();
      for (const row of bindings) {
        appendGrouped(bindingsByShot, String(row.shotUuid), row);
      }

      const candidatesByShot = new Map<string, StoryboardCandidateDto[]>();
      for (const row of candidateRows) {
        const relativePath = safeCandidateRelativePath(row.relativePath);
        if (!relativePath || !isStoryboardMediaType(row.mediaType)) continue;
        appendGrouped(candidatesByShot, String(row.shotUuid), {
          candidateUuid: String(row.candidateUuid),
          mediaType: row.mediaType,
          relativePath,
          selected: Number(row.selected) === 1,
          createdAt: String(row.createdAt),
        });
      }

      const tasksByShot = new Map<string, StoryboardGenerationTaskDto[]>();
      for (const row of generationTaskRows) {
        if (!isStoryboardMediaType(row.mediaType)) continue;
        appendGrouped(tasksByShot, String(row.shotUuid), {
          taskUuid: String(row.taskUuid),
          mediaType: row.mediaType,
          providerId: String(row.providerId),
          modelName: String(row.modelName),
          status: String(row.status),
          createdAt: Number(row.createdAt),
          updatedAt: Number(row.updatedAt),
        });
      }

      return shots.map((shot) => {
        const shotUuid = String(shot.shotUuid);
        return this.toDto(
          shot,
          bindingsByShot.get(shotUuid) ?? [],
          candidatesByShot.get(shotUuid) ?? [],
          tasksByShot.get(shotUuid) ?? [],
        );
      });
    });
  }

  async insertShot(input: InsertShotInput): Promise<StoryboardShotDto> {
    return runWithProjectStorage(this.projectUuid, async () => {
      return activeDb.transaction(async (trx) => {
        const insertOrder = await this.resolveInsertOrder(trx, input.afterShotUuid);
        const later = await trx("o_storyboardShot")
          .where("displayOrder", ">=", insertOrder)
          .orderBy("displayOrder", "desc");
        for (const row of later) {
          await trx("o_storyboardShot").where({ shotUuid: row.shotUuid }).update({
            displayOrder: Number(row.displayOrder) + 1,
            updatedAt: nowIso(),
          });
        }
        const shotUuid = crypto.randomUUID();
        const stamp = nowIso();
        await trx("o_storyboardShot").insert({
          shotUuid,
          displayOrder: insertOrder,
          sourceText: input.sourceText ?? null,
          visualDescription: input.visualDescription ?? null,
          imagePrompt: input.imagePrompt ?? null,
          videoPrompt: input.videoPrompt ?? null,
          negativePrompt: input.negativePrompt ?? null,
          durationMs: input.durationMs ?? null,
          createdAt: stamp,
          updatedAt: stamp,
        });
        const created = await trx("o_storyboardShot").where({ shotUuid }).first();
        await upsertPendingMutationJournalInTrx(trx, "storyboardService");
        return this.toDto(created, []);
      });
    });
  }

  async updateShot(shotUuid: string, patch: StoryboardShotPatch): Promise<StoryboardShotDto> {
    return runWithProjectStorage(this.projectUuid, async () => {
      const current = await activeDb("o_storyboardShot").where({ shotUuid }).first();
      if (!current) throw Object.assign(new Error("分镜不存在"), { status: 404 });
      if (Object.prototype.hasOwnProperty.call(patch, "durationMs") && patch.durationMs != null) {
        const { parseStoryboardVideoDurationMs } = await import("./storyboard-video-prompt");
        parseStoryboardVideoDurationMs(patch.durationMs);
      }
      await activeDb.transaction(async (trx) => {
        await trx("o_storyboardShot").where({ shotUuid }).update({
          ...patch,
          updatedAt: nowIso(),
        });
        await upsertPendingMutationJournalInTrx(trx, "storyboardService");
      });
      return (await this.listShots()).find((item) => item.shotUuid === shotUuid)!;
    });
  }

  async duplicateShot(shotUuid: string, afterShotUuid: string): Promise<StoryboardShotDto> {
    const current = (await this.listShots()).find((item) => item.shotUuid === shotUuid);
    if (!current) throw Object.assign(new Error("分镜不存在"), { status: 404 });
    return this.insertShot({
      afterShotUuid,
      sourceText: current.sourceText ?? undefined,
      visualDescription: current.visualDescription ?? undefined,
    });
  }

  async deleteShots(shotUuids: readonly string[]): Promise<void> {
    return runWithProjectStorage(this.projectUuid, async () => {
      await activeDb.transaction(async (trx) => {
        for (const shotUuid of shotUuids) {
          const row = await trx("o_storyboardShot").where({ shotUuid }).first();
          if (!row) throw Object.assign(new Error("分镜不存在"), { status: 400 });
        }
        const activeTask = await trx("o_storyboardGenerationTask")
          .whereIn("shotUuid", [...shotUuids])
          .whereIn("status", [
            "queued",
            "recovering",
            "submitting",
            "submitted",
            "provider_completed",
            "postprocess_failed_retryable",
          ])
          .first("taskUuid");
        if (activeTask) {
          // 中文注释：领取与删除共用项目事务序列化，确保收费前删除或领取后禁删二者只能发生其一。
          throw Object.assign(new Error("分镜存在进行中的生成任务，暂不能删除"), {
            status: 409,
            code: "STORYBOARD_SHOT_GENERATION_ACTIVE",
          });
        }
        await trx("o_storyboardShotAsset").whereIn("shotUuid", [...shotUuids]).delete();
        await trx("o_storyboardShot").whereIn("shotUuid", [...shotUuids]).delete();
        await upsertPendingMutationJournalInTrx(trx, "storyboardService");
        const remaining = await trx("o_storyboardShot").orderBy("displayOrder");
        for (const [index, row] of remaining.entries()) {
          await trx("o_storyboardShot").where({ shotUuid: row.shotUuid }).update({
            displayOrder: index + 1,
            updatedAt: nowIso(),
          });
        }
      });
    });
  }

  async reorderShots(input: ReorderShotsInput): Promise<void> {
    return runWithProjectStorage(this.projectUuid, async () => {
      await activeDb.transaction(async (trx) => {
        const existing = await trx("o_storyboardShot").select("shotUuid");
        const current = new Set(existing.map((row) => String(row.shotUuid)));
        const next = input.orderedShotUuids;
        if (new Set(next).size !== next.length) {
          throw Object.assign(new Error("分镜顺序包含重复 UUID"), { status: 409 });
        }
        if (next.length !== current.size || next.some((uuid) => !current.has(uuid))) {
          throw Object.assign(new Error("分镜顺序与当前集合不一致"), { status: 409 });
        }
        const offset = 10_000;
        for (const [index, shotUuid] of next.entries()) {
          await trx("o_storyboardShot").where({ shotUuid }).update({ displayOrder: offset + index + 1 });
        }
        for (const [index, shotUuid] of next.entries()) {
          await trx("o_storyboardShot").where({ shotUuid }).update({
            displayOrder: index + 1,
            updatedAt: nowIso(),
          });
        }
        await upsertPendingMutationJournalInTrx(trx, "storyboardService");
      });
    });
  }

  async bindAsset(shotUuid: string, input: StoryboardAssetBindingInput): Promise<void> {
    return runWithProjectStorage(this.projectUuid, async () => {
      const shot = await activeDb("o_storyboardShot").where({ shotUuid }).first();
      if (!shot) throw Object.assign(new Error("分镜不存在"), { status: 404 });
      await activeDb.transaction(async (trx) => {
        await trx("o_storyboardShotAsset").insert({
          shotUuid,
          sourceProjectUuid: input.sourceProjectUuid,
          assetUuid: input.assetUuid,
          assetType: input.assetType,
          relationRole: input.relationRole,
          voiceEnabled: 1,
        });
        await upsertPendingMutationJournalInTrx(trx, "storyboardService");
      });
    });
  }

  async unbindAsset(shotUuid: string, input: {
    assetUuid: string;
    sourceProjectUuid: string;
    assetType: string;
  }): Promise<void> {
    return runWithProjectStorage(this.projectUuid, async () => {
      const shot = await activeDb("o_storyboardShot").where({ shotUuid }).first();
      if (!shot) throw Object.assign(new Error("分镜不存在"), { status: 404 });
      await activeDb.transaction(async (trx) => {
        // 中文注释：只删除完全匹配的一条绑定，禁止按类型清空其他关联。
        const deleted = await trx("o_storyboardShotAsset").where({
          shotUuid,
          assetUuid: input.assetUuid,
          sourceProjectUuid: input.sourceProjectUuid,
          assetType: input.assetType,
        }).delete();
        if (!deleted) throw Object.assign(new Error("资产关联不存在"), { status: 404 });
        await upsertPendingMutationJournalInTrx(trx, "storyboardService");
      });
    });
  }

  async updateBindingVoice(shotUuid: string, input: {
    assetUuid: string;
    sourceProjectUuid: string;
    assetType: string;
    relationRole: string;
    voiceEnabled: boolean;
  }): Promise<StoryboardAssetBindingInput> {
    if (input.assetType !== "role") {
      throw Object.assign(new Error("只有角色绑定可以修改音色开关"), { status: 400 });
    }
    return runWithProjectStorage(this.projectUuid, async () => {
      const shot = await activeDb("o_storyboardShot").where({ shotUuid }).first();
      if (!shot) throw Object.assign(new Error("分镜不存在"), { status: 404 });
      let updated: any;
      await activeDb.transaction(async (trx) => {
        // 中文注释：只更新完全匹配的一条角色绑定，禁止按类型改写其他关联。
        const changed = await trx("o_storyboardShotAsset").where({
          shotUuid,
          assetUuid: input.assetUuid,
          sourceProjectUuid: input.sourceProjectUuid,
          assetType: "role",
          relationRole: input.relationRole,
        }).update({ voiceEnabled: input.voiceEnabled ? 1 : 0 });
        if (!changed) throw Object.assign(new Error("资产关联不存在"), { status: 404 });
        updated = await trx("o_storyboardShotAsset").where({
          shotUuid,
          assetUuid: input.assetUuid,
          sourceProjectUuid: input.sourceProjectUuid,
          assetType: "role",
          relationRole: input.relationRole,
        }).first();
        await upsertPendingMutationJournalInTrx(trx, "storyboardService");
      });
      return {
        sourceProjectUuid: String(updated.sourceProjectUuid),
        assetUuid: String(updated.assetUuid),
        assetType: updated.assetType,
        relationRole: String(updated.relationRole),
        voiceEnabled: Number(updated.voiceEnabled) !== 0,
      };
    });
  }

  async commitImportRows(input: {
    rows: ReadonlyArray<InsertShotInput & {
      afterShotUuid: string | null;
      assetNames?: Readonly<Record<string, readonly string[]>>;
    }>;
    sourceProjectUuid: string;
    resolveAsset: (name: string, type: string) => Promise<{ assetUuid: string; assetType: "role" | "scene" | "tool" | "clip" | "audio" } | null>;
  }): Promise<{ shots: StoryboardShotDto[]; unmatchedNames: string[] }> {
    return runWithProjectStorage(this.projectUuid, async () => {
      return activeDb.transaction(async (trx) => {
        const created: StoryboardShotDto[] = [];
        const unmatchedNames: string[] = [];
        let cursor = input.rows[0]?.afterShotUuid ?? null;
        for (const row of input.rows) {
          const insertOrder = await this.resolveInsertOrder(trx, cursor);
          const later = await trx("o_storyboardShot")
            .where("displayOrder", ">=", insertOrder)
            .orderBy("displayOrder", "desc");
          for (const existing of later) {
            await trx("o_storyboardShot").where({ shotUuid: existing.shotUuid }).update({
              displayOrder: Number(existing.displayOrder) + 1,
              updatedAt: nowIso(),
            });
          }
          const shotUuid = crypto.randomUUID();
          const stamp = nowIso();
          await trx("o_storyboardShot").insert({
            shotUuid,
            displayOrder: insertOrder,
            sourceText: row.sourceText ?? null,
            visualDescription: row.visualDescription ?? null,
            imagePrompt: row.imagePrompt ?? null,
            videoPrompt: row.videoPrompt ?? null,
            negativePrompt: row.negativePrompt ?? null,
            durationMs: row.durationMs ?? null,
            createdAt: stamp,
            updatedAt: stamp,
          });
          const bindings = [];
          for (const [assetType, names] of Object.entries(row.assetNames ?? {})) {
            for (const name of names) {
              const matched = await input.resolveAsset(name, assetType);
              if (!matched) {
                // 中文注释：同名资产不存在时只跳过该项绑定，不得阻断分镜写入，也不得新建资产。
                rememberUnmatchedKeyword(unmatchedNames, name);
                continue;
              }
              await trx("o_storyboardShotAsset").insert({
                shotUuid,
                sourceProjectUuid: input.sourceProjectUuid,
                assetUuid: matched.assetUuid,
                assetType: matched.assetType,
                relationRole: "appear",
              });
              bindings.push({
                sourceProjectUuid: input.sourceProjectUuid,
                assetUuid: matched.assetUuid,
                assetType: matched.assetType,
                relationRole: "appear",
              });
            }
          }
          const createdRow = await trx("o_storyboardShot").where({ shotUuid }).first();
          created.push(this.toDto(createdRow, bindings));
          cursor = shotUuid;
        }
        await upsertPendingMutationJournalInTrx(trx, "storyboardImport");
        return { shots: created, unmatchedNames };
      });
    });
  }

  async autoMatchAssets(
    shotUuids: readonly string[],
    assetList: SharedAssetList,
  ): Promise<AutoMatchAssetsResult> {
    const unique = uniqueShotUuids(shotUuids);
    if (unique.length === 0) {
      throw Object.assign(new Error("请选择要匹配资产的分镜"), { status: 400 });
    }
    const matchable = toMatchableAssets(assetList);
    return runWithProjectStorage(this.projectUuid, async () => {
      return activeDb.transaction(async (trx) => {
        const pending: Array<{
          shotUuid: string;
          sourceProjectUuid: string;
          assetUuid: string;
          assetType: string;
          relationRole: string;
          voiceEnabled: number;
        }> = [];
        const statsByShot = new Map<string, {
          matchedCount: number;
          createdBindingCount: number;
          existingBindingCount: number;
          emptyPrompt: boolean;
          conflictCount: number;
        }>();
        const conflictNames = new Set<string>();
        let matchedCount = 0;
        let createdBindingCount = 0;
        let existingBindingCount = 0;
        let emptyPromptCount = 0;
        let conflictCount = 0;
        for (const batchUuids of chunk(unique, MATCH_ASSET_BATCH_SIZE)) {
          const shots = await loadShotsByUuids(trx, batchUuids);
          const bindings = await trx("o_storyboardShotAsset").whereIn("shotUuid", [...batchUuids]).select();
          const bindingsByShot = new Map<string, any[]>();
          for (const row of bindings) {
            appendGrouped(bindingsByShot, String(row.shotUuid), row);
          }
          for (const shot of shots) {
            const shotUuid = String(shot.shotUuid);
            const videoPrompt = shot.videoPrompt == null ? "" : String(shot.videoPrompt);
            if (!videoPrompt.trim()) {
              emptyPromptCount += 1;
              statsByShot.set(shotUuid, {
                matchedCount: 0,
                createdBindingCount: 0,
                existingBindingCount: 0,
                emptyPrompt: true,
                conflictCount: 0,
              });
              continue;
            }
            const matched = matchAssetsForPrompt(videoPrompt, matchable);
            for (const name of matched.conflicts.flatMap((item) => item.assetNames)) {
              conflictNames.add(name);
            }
            const existing = bindingsByShot.get(shotUuid) ?? [];
            const existingKeys = new Set(existing.map((row) => bindingIdentity(row)));
            const hasScene = existing.some((row) => String(row.assetType) === "scene");
            let shotMatched = 0;
            let shotCreated = 0;
            let shotExisting = 0;
            for (const match of matched.matches) {
              if (match.assetType === "scene" && hasScene) continue;
              shotMatched += 1;
              const key = bindingIdentity(match);
              if (existingKeys.has(key)) {
                shotExisting += 1;
                continue;
              }
              pending.push({
                shotUuid,
                sourceProjectUuid: match.sourceProjectUuid,
                assetUuid: match.assetUuid,
                assetType: match.assetType,
                relationRole: "appear",
                voiceEnabled: 1,
              });
              existingKeys.add(key);
              shotCreated += 1;
            }
            matchedCount += shotMatched;
            createdBindingCount += shotCreated;
            existingBindingCount += shotExisting;
            conflictCount += matched.conflicts.length;
            statsByShot.set(shotUuid, {
              matchedCount: shotMatched,
              createdBindingCount: shotCreated,
              existingBindingCount: shotExisting,
              emptyPrompt: false,
              conflictCount: matched.conflicts.length,
            });
          }
        }
        for (const batch of chunk(pending, MATCH_ASSET_BATCH_SIZE)) {
          await trx("o_storyboardShotAsset").insert(batch);
        }
        if (pending.length > 0) {
          await upsertPendingMutationJournalInTrx(trx, "storyboardService");
        }
        const dtos = await this.loadSelectedShotDtos(trx, unique);
        return {
          selectedCount: unique.length,
          processedCount: unique.length,
          matchedCount,
          createdBindingCount,
          existingBindingCount,
          emptyPromptCount,
          conflictCount,
          conflictAssetNames: [...conflictNames],
          shots: dtos.map((dto) => ({
            ...dto,
            ...(statsByShot.get(dto.shotUuid) ?? {
              matchedCount: 0,
              createdBindingCount: 0,
              existingBindingCount: 0,
              emptyPrompt: true,
              conflictCount: 0,
            }),
          })),
        };
      });
    });
  }

  async batchReplacePrompt(input: {
    shotUuids: readonly string[];
    findText: string;
    replaceText: string;
  }): Promise<BatchReplacePromptResult> {
    const unique = uniqueShotUuids(input.shotUuids);
    if (unique.length === 0) {
      throw Object.assign(new Error("请选择要替换的分镜"), { status: 400 });
    }
    const findText = String(input.findText ?? "");
    const replaceText = String(input.replaceText ?? "");
    if (!findText) {
      throw Object.assign(new Error("查找文本不能为空"), { status: 400 });
    }
    if (findText === replaceText) {
      throw Object.assign(new Error("替换后内容没有变化"), { status: 400 });
    }
    return runWithProjectStorage(this.projectUuid, async () => {
      return activeDb.transaction(async (trx) => {
        const planned: Array<{ shotUuid: string; current: string; count: number; projectedLength: number }> = [];
        let replacementCount = 0;
        let totalProjectedLength = 0;
        for (const batchUuids of chunk(unique, MATCH_ASSET_BATCH_SIZE)) {
          const shots = await loadShotsByUuids(trx, batchUuids);
          for (const shot of shots) {
            const shotUuid = String(shot.shotUuid);
            const current = shot.videoPrompt == null ? "" : String(shot.videoPrompt);
            const { count, projectedLength } = planLiteralReplacement(current, findText, replaceText);
            if (count === 0) continue;
            if (projectedLength > MAX_VIDEO_PROMPT_CHARS) {
              throw Object.assign(new Error("替换后分镜提示词超过长度上限"), { status: 400 });
            }
            totalProjectedLength += projectedLength;
            if (totalProjectedLength > MAX_BATCH_REPLACE_TOTAL_CHARS) {
              throw Object.assign(new Error("本次替换后的提示词总长度超过上限"), { status: 400 });
            }
            planned.push({ shotUuid, current, count, projectedLength });
            replacementCount += count;
          }
        }
        const stamp = nowIso();
        const updates = planned.map((item) => ({
          shotUuid: item.shotUuid,
          videoPrompt: applyLiteralReplacement(item.current, findText, replaceText),
        }));
        for (const batch of chunk(updates, MATCH_ASSET_BATCH_SIZE)) {
          await batchUpdateVideoPrompts(trx, batch, stamp);
        }
        if (updates.length > 0) {
          await upsertPendingMutationJournalInTrx(trx, "storyboardService");
        }
        const dtos = await this.loadSelectedShotDtos(trx, unique);
        const countByShot = new Map(planned.map((item) => [item.shotUuid, item.count]));
        return {
          selectedCount: unique.length,
          affectedShotCount: planned.length,
          replacementCount,
          shots: dtos.map((dto) => ({
            ...dto,
            replacementCount: countByShot.get(dto.shotUuid) ?? 0,
          })),
        };
      });
    });
  }

  async selectCandidate(shotUuid: string, candidateUuid: string): Promise<void> {
    return runWithProjectStorage(this.projectUuid, async () => {
      const shot = await activeDb("o_storyboardShot").where({ shotUuid }).first();
      if (!shot) throw Object.assign(new Error("分镜不存在"), { status: 404 });
      const candidate = await activeDb("o_storyboardCandidate").where({ candidateUuid, shotUuid }).first();
      if (!candidate) throw Object.assign(new Error("候选不存在"), { status: 409 });
      await activeDb.transaction(async (trx) => {
        await trx("o_storyboardCandidate").where({ shotUuid }).update({ selected: 0 });
        await trx("o_storyboardCandidate").where({ candidateUuid }).update({ selected: 1 });
        await upsertPendingMutationJournalInTrx(trx, "storyboardService");
      });
    });
  }

  private async loadSelectedShotDtos(trx: any, shotUuids: readonly string[]): Promise<StoryboardShotDto[]> {
    const shotRows: any[] = [];
    const bindingRows: any[] = [];
    const candidateRows: any[] = [];
    const taskRows: any[] = [];
    for (const batch of chunk(shotUuids, MATCH_ASSET_BATCH_SIZE)) {
      shotRows.push(...await trx("o_storyboardShot").whereIn("shotUuid", [...batch]).select());
      bindingRows.push(...await trx("o_storyboardShotAsset").whereIn("shotUuid", [...batch]).orderBy("id").select());
      candidateRows.push(...await trx("o_storyboardCandidate")
        .whereIn("shotUuid", [...batch])
        .orderBy("createdAt")
        .orderBy("candidateUuid")
        .select());
      taskRows.push(...await trx("o_storyboardGenerationTask")
        .whereIn("shotUuid", [...batch])
        .orderBy("createdAt")
        .orderBy("taskUuid")
        .select());
    }
    const bindingsByShot = new Map<string, any[]>();
    for (const row of bindingRows) appendGrouped(bindingsByShot, String(row.shotUuid), row);
    const candidatesByShot = new Map<string, StoryboardCandidateDto[]>();
    for (const row of candidateRows) {
      const relativePath = safeCandidateRelativePath(row.relativePath);
      if (!relativePath || !isStoryboardMediaType(row.mediaType)) continue;
      appendGrouped(candidatesByShot, String(row.shotUuid), {
        candidateUuid: String(row.candidateUuid),
        mediaType: row.mediaType,
        relativePath,
        selected: Number(row.selected) === 1,
        createdAt: String(row.createdAt),
      });
    }
    const tasksByShot = new Map<string, StoryboardGenerationTaskDto[]>();
    for (const row of taskRows) {
      if (!isStoryboardMediaType(row.mediaType)) continue;
      appendGrouped(tasksByShot, String(row.shotUuid), {
        taskUuid: String(row.taskUuid),
        mediaType: row.mediaType,
        providerId: String(row.providerId),
        modelName: String(row.modelName),
        status: String(row.status),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      });
    }
    const byUuid = new Map(shotRows.map((row) => [String(row.shotUuid), row]));
    return shotUuids.map((shotUuid) => {
      const shot = byUuid.get(shotUuid);
      if (!shot) throw Object.assign(new Error("分镜不存在或不属于当前项目"), { status: 400 });
      return this.toDto(
        shot,
        bindingsByShot.get(shotUuid) ?? [],
        candidatesByShot.get(shotUuid) ?? [],
        tasksByShot.get(shotUuid) ?? [],
      );
    });
  }

  private async resolveInsertOrder(trx: any, afterShotUuid: string | null): Promise<number> {
    if (!afterShotUuid) return 1;
    const after = await trx("o_storyboardShot").where({ shotUuid: afterShotUuid }).first();
    if (!after) throw Object.assign(new Error("插入位置无效"), { status: 400 });
    return Number(after.displayOrder) + 1;
  }

  private toDto(
    shot: any,
    bindings: any[],
    candidates: readonly StoryboardCandidateDto[] = [],
    generationTasks: readonly StoryboardGenerationTaskDto[] = [],
  ): StoryboardShotDto {
    return {
      shotUuid: String(shot.shotUuid),
      displayOrder: Number(shot.displayOrder),
      sourceText: shot.sourceText ?? null,
      visualDescription: shot.visualDescription ?? null,
      imagePrompt: shot.imagePrompt ?? null,
      videoPrompt: shot.videoPrompt ?? null,
      negativePrompt: shot.negativePrompt ?? null,
      // 镜头语言必须随列表与更新响应返回，保证前端刷新后仍能恢复编辑状态。
      shotSize: shot.shotSize ?? null,
      cameraMovement: shot.cameraMovement ?? null,
      composition: shot.composition ?? null,
      era: shot.era ?? null,
      durationMs: shot.durationMs ?? null,
      aspectRatio: shot.aspectRatio ?? null,
      bindings: bindings.map((row) => ({
        sourceProjectUuid: String(row.sourceProjectUuid),
        assetUuid: String(row.assetUuid),
        assetType: row.assetType,
        relationRole: String(row.relationRole),
        voiceEnabled: row.voiceEnabled == null ? true : Number(row.voiceEnabled) !== 0,
      })),
      candidates,
      generationTasks,
    };
  }
}

function appendGrouped<T>(grouped: Map<string, T[]>, shotUuid: string, value: T): void {
  const current = grouped.get(shotUuid);
  if (current) current.push(value);
  else grouped.set(shotUuid, [value]);
}

function isStoryboardMediaType(value: unknown): value is "image" | "video" {
  return value === "image" || value === "video";
}

function safeCandidateRelativePath(value: unknown): string | null {
  const relativePath = String(value ?? "");
  if (!relativePath.startsWith("files/") || relativePath.length <= "files/".length) return null;
  // 中文注释：渲染进程只能看到项目 files/ 下的 POSIX 相对路径，旧库脏值直接跳过。
  if (relativePath.includes("..") || relativePath.includes("\\") || relativePath.includes("\0")) {
    return null;
  }
  const childPath = relativePath.slice("files/".length);
  if (childPath.includes(":") || childPath.startsWith("/") || childPath.split("/").some((part) => !part || part === ".")) {
    return null;
  }
  return relativePath;
}

function nowIso(): string {
  return new Date().toISOString();
}

const WORKSPACE_SETTINGS_KEYS = [
  "globalImagePrompt",
  "globalVideoPrompt",
  "globalNegativePrompt",
  "textModel",
  "imageModel",
  "videoModel",
  "aspectRatio",
  "resolution",
  "durationMs",
  "imageConcurrency",
  "videoConcurrency",
  "videoPromptTemplateId",
  "videoPromptTemplateContent",
] as const;

function applyWorkspaceSettingsPatch(
  current: StoryboardWorkspaceSettings,
  patch: Partial<StoryboardWorkspaceSettings> | Record<string, unknown> | null | undefined,
): StoryboardWorkspaceSettings {
  const next: StoryboardWorkspaceSettings = { ...current };
  const record = patch && typeof patch === "object" ? patch as Record<string, unknown> : {};
  for (const key of WORKSPACE_SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value === undefined) continue;
    if (key === "videoPromptTemplateId") {
      const numeric = Number(value);
      next[key] = value == null || value === "" || !Number.isInteger(numeric) ? null : numeric;
      continue;
    }
    if (key === "durationMs" || key === "imageConcurrency" || key === "videoConcurrency") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) next[key] = Math.round(numeric);
      continue;
    }
    if (key === "textModel" || key === "imageModel" || key === "videoModel") {
      next[key] = value == null || value === "" ? null : String(value);
      continue;
    }
    next[key] = String(value ?? "");
  }
  return next;
}

function toWorkspaceSettingsRow(settings: StoryboardWorkspaceSettings): Record<(typeof WORKSPACE_SETTINGS_KEYS)[number], string | number | null> {
  return {
    globalImagePrompt: settings.globalImagePrompt,
    globalVideoPrompt: settings.globalVideoPrompt,
    globalNegativePrompt: settings.globalNegativePrompt,
    textModel: settings.textModel,
    imageModel: settings.imageModel,
    videoModel: settings.videoModel,
    aspectRatio: settings.aspectRatio,
    resolution: settings.resolution,
    durationMs: settings.durationMs,
    imageConcurrency: settings.imageConcurrency,
    videoConcurrency: settings.videoConcurrency,
    videoPromptTemplateId: settings.videoPromptTemplateId ?? null,
    videoPromptTemplateContent: settings.videoPromptTemplateContent ?? "",
  };
}

function rememberUnmatchedKeyword(target: string[], name: string): void {
  const safe = String(name ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 40);
  if (!safe || target.includes(safe)) return;
  target.push(safe);
}

function uniqueShotUuids(shotUuids: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of shotUuids) {
    const shotUuid = String(raw ?? "").trim();
    if (!shotUuid || seen.has(shotUuid)) continue;
    seen.add(shotUuid);
    unique.push(shotUuid);
  }
  return unique;
}

async function loadShotsByUuids(trx: any, shotUuids: readonly string[]): Promise<any[]> {
  const rows = await trx("o_storyboardShot").whereIn("shotUuid", [...shotUuids]).select();
  const byUuid = new Map(rows.map((row: { shotUuid: string }) => [String(row.shotUuid), row]));
  if (shotUuids.some((shotUuid) => !byUuid.has(shotUuid))) {
    throw Object.assign(new Error("分镜不存在或不属于当前项目"), { status: 400 });
  }
  return shotUuids.map((shotUuid) => byUuid.get(shotUuid));
}

function toMatchableAssets(list: SharedAssetList): MatchableAsset[] {
  return list.assets.flatMap((asset) => {
    const type = String(asset.type ?? "");
    if (type !== "role" && type !== "scene" && type !== "tool") return [];
    return [{
      assetUuid: String(asset.assetUuid),
      name: String(asset.name ?? ""),
      type,
      remark: String(asset.remark ?? ""),
      sourceProjectUuid: String(asset.sourceProjectUuid || list.sourceProjectUuid),
    }];
  });
}

function bindingIdentity(row: { sourceProjectUuid?: string; assetUuid?: string; assetType?: string }): string {
  return `${row.sourceProjectUuid}:${row.assetUuid}:${row.assetType}`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function batchUpdateVideoPrompts(
  trx: any,
  rows: ReadonlyArray<{ shotUuid: string; videoPrompt: string }>,
  stamp: string,
): Promise<void> {
  if (rows.length === 0) return;
  const cases = rows.map(() => "WHEN ? THEN ?").join(" ");
  const bindings: unknown[] = [];
  for (const row of rows) {
    bindings.push(row.shotUuid, row.videoPrompt);
  }
  bindings.push(stamp, ...rows.map((row) => row.shotUuid));
  const placeholders = rows.map(() => "?").join(", ");
  await trx.raw(
    `UPDATE o_storyboardShot SET videoPrompt = CASE shotUuid ${cases} END, updatedAt = ? WHERE shotUuid IN (${placeholders})`,
    bindings,
  );
}
