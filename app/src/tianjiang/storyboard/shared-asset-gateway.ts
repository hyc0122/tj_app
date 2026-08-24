import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { db as activeDb, prepareProjectDatabase } from "@/utils/db";
import getPath from "@/utils/getPath";
import oss from "@/utils/oss";
import { deleteProjectFile, writeProjectFileAtomic } from "@/tianjiang/media/project-file-store";
import { runWithProjectStorage, currentUserStorage } from "../runtime/user-storage-context";
import { projectOperationPort } from "../runtime/project-operation-port";
import { upsertPendingMutationJournalInTrx } from "../runtime/legacy-mutation-journal";
import type { CentralSession } from "../auth/central-session";
import { syncCoordinator } from "../runtime/runtime";
import {
  ASSET_TYPES,
  MAX_ASSET_DESCRIBE,
  MAX_ASSET_MEDIA_BYTES,
  MAX_ASSET_NAME,
  MAX_ASSET_PROMPT,
  MAX_ASSET_REMARK,
  MAX_BATCH_FILES,
  detectAllowedAudio,
  detectAllowedImage,
  displayImageRatio,
  normalizeAssetType,
  normalizeImageRatio,
  normalizeRemark,
  parseAssetImportText,
  safeAssetError,
  safeFileStem,
} from "./shared-asset-ingest";

export interface SharedAssetDto {
  assetUuid: string;
  name: string;
  type: string;
  describe: string;
  remark?: string;
  prompt?: string;
  imageRatio?: string;
  hasAudio?: boolean;
  sourceProjectUuid: string;
  /** 受保护项目媒体 URL；无图片或旧库路径不安全时省略。 */
  coverUrl?: string;
}

export interface SharedAssetList {
  sourceProjectUuid: string;
  assets: SharedAssetDto[];
}

/**
 * 跨项目资产只通过本网关读写。返回 DTO 和项目范围 URL，绝不返回来源路径或数据库句柄。
 */
const PARENT_ASSET_TYPES = ["role", "scene", "tool"] as const;

export class SharedAssetGateway {
  resolveSourceProjectUuid(session: CentralSession | undefined, consumerUuid: string): string {
    const catalog = session ? syncCoordinator.listProjects(session) : [];
    const item = catalog.find((row: { projectUuid: string; assetSourceProjectUuid?: string }) => row.projectUuid === consumerUuid);
    const source = item?.assetSourceProjectUuid?.trim();
    return source || consumerUuid;
  }

  async listAssets(session: CentralSession | undefined, consumerUuid: string): Promise<SharedAssetList> {
    const sourceUuid = this.resolveSourceProjectUuid(session, consumerUuid);
    const access = new Map([
      [consumerUuid, "read" as const],
      [sourceUuid, "read" as const],
    ]);
    return projectOperationPort.withProjects(
      session,
      [consumerUuid, sourceUuid],
      access,
      async () => runWithProjectStorage(sourceUuid, async () => {
        const rows = await activeDb("o_assets")
          .leftJoin("o_image", "o_assets.imageId", "o_image.id")
          .select(
            "o_assets.id",
            "o_assets.assetUuid",
            "o_assets.name",
            "o_assets.type",
            "o_assets.describe",
            "o_assets.remark",
            "o_assets.prompt",
            "o_assets.imageRatio",
            "o_image.filePath as coverFilePath",
          )
          .whereIn("o_assets.type", PARENT_ASSET_TYPES)
          .where((builder) => {
            builder.whereNull("o_assets.assetsId").orWhere("o_assets.assetsId", 0);
          });
        const audioRoleIds = new Set<number>();
        if (await activeDb.schema.hasTable("o_assetsRole2Audio")) {
          const roleIds = rows.filter((row) => String(row.type) === "role").map((row) => Number(row.id));
          if (roleIds.length) {
            const links = await activeDb("o_assetsRole2Audio").whereIn("assetsRoleId", roleIds).select("assetsRoleId");
            for (const link of links) audioRoleIds.add(Number(link.assetsRoleId));
          }
        }
        return {
          sourceProjectUuid: sourceUuid,
          assets: await Promise.all(rows.map(async (row) => {
            const coverFilePath = safeProjectCoverPath(row.coverFilePath);
            let coverUrl: string | undefined;
            if (coverFilePath) {
              try {
                // 中文注释：必须在来源项目上下文内生成受保护 URL，禁止把数据库路径直接交给渲染端。
                coverUrl = await oss.getSmallImageUrl(coverFilePath);
              } catch {
                // 中文注释：旧库脏路径或 URL 生成异常按无预览处理，列表其他资产仍可读取。
                coverUrl = undefined;
              }
            }
            return toAssetDto(row, sourceUuid, coverUrl, String(row.type) === "role" && audioRoleIds.has(Number(row.id)));
          })),
        };
      }),
    );
  }

  async createAsset(
    session: CentralSession | undefined,
    consumerUuid: string,
    input: {
      type: string;
      name: string;
      describe?: string;
      remark?: string;
      prompt?: string;
      imageRatio?: string;
      image?: { buffer: Buffer; mime: string };
      audio?: { buffer: Buffer; mime: string; filename?: string };
    },
  ): Promise<SharedAssetDto> {
    const type = normalizeAssetType(input.type);
    const name = String(input.name ?? "").trim();
    const describe = String(input.describe ?? "").trim();
    const remark = normalizeRemark(input.remark);
    const prompt = String(input.prompt ?? "").trim();
    const imageRatio = normalizeImageRatio(input.imageRatio);
    const imageDetected = input.image ? detectAllowedImage(input.image.buffer, input.image.mime) : null;
    const audioDetected = input.audio
      ? detectAllowedAudio(input.audio.buffer, input.audio.mime, input.audio.filename ?? "")
      : null;
    if (input.image && !imageDetected) throw safeAssetError("只允许上传 PNG、JPEG 或 WebP 图片");
    if (input.audio && type !== "role") throw safeAssetError("只有角色可以绑定音频");
    if (input.audio && !audioDetected) throw safeAssetError("角色音频只允许 mp3、wav、m4a、aac 或 ogg");
    if (input.image && input.image.buffer.length > MAX_ASSET_MEDIA_BYTES) throw safeAssetError("图片超过大小上限");
    if (input.audio && input.audio.buffer.length > MAX_ASSET_MEDIA_BYTES) throw safeAssetError("音频超过大小上限");
    if (!type || !ASSET_TYPES.has(type)) {
      throw safeAssetError("资产类型只允许角色、场景或道具");
    }
    if (!name || name.length > MAX_ASSET_NAME) {
      throw safeAssetError("资产名称必填且长度须合理");
    }
    if (describe.length > MAX_ASSET_DESCRIBE) {
      throw safeAssetError("资产描述过长");
    }
    if (remark.length > MAX_ASSET_REMARK) {
      throw safeAssetError("资产别名过长");
    }
    if (prompt.length > MAX_ASSET_PROMPT) {
      throw safeAssetError("生图提示词过长");
    }
    const sourceUuid = this.resolveSourceProjectUuid(session, consumerUuid);
    return projectOperationPort.withProjects(
      session,
      [consumerUuid, sourceUuid],
      new Map([
        [consumerUuid, "read"],
        [sourceUuid, "write"],
      ]),
      async () => runWithProjectStorage(sourceUuid, async () => {
        const assetUuid = crypto.randomUUID();
        const writtenPaths: string[] = [];
        try {
          await activeDb.transaction(async (trx) => {
            const nextId = await nextIntegerId(trx, "o_assets");
            const project = await trx("o_project").first();
            await trx("o_assets").insert({
              id: nextId,
              assetUuid,
              name,
              type,
              describe,
              remark,
              prompt,
              imageRatio,
              projectId: Number(project?.id ?? 0) || null,
              startTime: Date.now(),
            });
            const row = await trx("o_assets").where({ assetUuid }).first();
            if (imageDetected && input.image) {
              const written = writeAssetMedia(
                sourceUuid,
                `files/images/asset-${assetUuid}-${crypto.randomUUID()}.${imageDetected.extension}`,
                input.image.buffer,
              );
              writtenPaths.push(written.relativePath);
              const imageId = await nextIntegerId(trx, "o_image");
              await trx("o_image").insert({
                id: imageId,
                assetsId: row.id,
                filePath: written.relativePath,
                type,
                state: "已完成",
              });
              await trx("o_assets").where({ assetUuid }).update({ imageId });
            }
            if (audioDetected && input.audio) {
              const written = writeAssetMedia(
                sourceUuid,
                `files/audios/asset-${assetUuid}-${crypto.randomUUID()}.${audioDetected.extension}`,
                input.audio.buffer,
              );
              writtenPaths.push(written.relativePath);
              await attachRoleAudio(row, written.relativePath, name, trx);
            }
            await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
          });
        } catch (error) {
          for (const relativePath of writtenPaths) {
            try { deleteWritten(sourceUuid, relativePath); } catch { /* 原子创建失败收回新媒体 */ }
          }
          throw toSafeWriteError(error, "新建资产失败");
        }
        await journalConsumer(consumerUuid, sourceUuid);
        const stored = await activeDb("o_assets").where({ assetUuid }).first();
        let coverUrl: string | undefined;
        if (stored?.imageId) {
          const image = await activeDb("o_image").where({ id: stored.imageId }).first();
          const coverFilePath = safeProjectCoverPath(image?.filePath);
          if (coverFilePath) {
            try { coverUrl = await oss.getSmallImageUrl(coverFilePath); } catch { coverUrl = undefined; }
          }
        }
        return toAssetDto(stored, sourceUuid, coverUrl);
      }),
    );
  }

  async uploadAssetImage(
    session: CentralSession | undefined,
    consumerUuid: string,
    assetUuid: string,
    file: { buffer: Buffer; mime: string },
  ): Promise<SharedAssetDto> {
    const detected = detectAllowedImage(file.buffer, file.mime);
    if (!detected) {
      throw Object.assign(new Error("只允许上传 PNG、JPEG 或 WebP 图片"), { status: 400 });
    }
    if (file.buffer.length > MAX_ASSET_MEDIA_BYTES) {
      throw safeAssetError("图片超过大小上限");
    }
    const sourceUuid = this.resolveSourceProjectUuid(session, consumerUuid);
    return projectOperationPort.withProjects(
      session,
      [consumerUuid, sourceUuid],
      new Map([
        [consumerUuid, "read"],
        [sourceUuid, "write"],
      ]),
      async () => runWithProjectStorage(sourceUuid, async () => {
        const current = await activeDb("o_assets").where({ assetUuid }).first();
        if (!current) throw Object.assign(new Error("资产不存在或不可见"), { status: 404 });
        const context = currentUserStorage();
        if (!context) throw Object.assign(new Error("缺少中央用户存储上下文"), { status: 403 });
        const relativePath = `files/images/asset-${assetUuid}-${crypto.randomUUID()}.${detected.extension}`;
        let written: ReturnType<typeof writeProjectFileAtomic> | undefined;
        try {
          written = writeProjectFileAtomic(
            getPath(),
            sourceUuid,
            context.segment,
            relativePath,
            file.buffer,
          );
          await activeDb.transaction(async (trx) => {
            const imageId = await nextIntegerId(trx, "o_image");
            await trx("o_image").insert({
              id: imageId,
              assetsId: current.id,
              filePath: written!.relativePath,
              type: current.type,
              state: "已完成",
            });
            await trx("o_assets").where({ assetUuid }).update({ imageId });
            await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
          });
          // 中文注释：替换主图只切换 imageId，旧图必须留在 o_image 历史中。
        } catch (error) {
          if (written) {
            try {
              deleteProjectFile(getPath(), sourceUuid, context.segment, written.relativePath);
            } catch {
              // 数据库失败后必须尽量收回本次新文件。
            }
          }
          throw error;
        }
        if (consumerUuid !== sourceUuid) {
          await runWithProjectStorage(consumerUuid, async () => {
            await activeDb.transaction(async (trx) => {
              await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
            });
          });
        }
        let coverUrl: string | undefined;
        try {
          coverUrl = await oss.getSmallImageUrl(written.relativePath);
        } catch {
          coverUrl = undefined;
        }
        return {
          assetUuid,
          name: String(current.name ?? ""),
          type: String(current.type ?? ""),
          describe: String(current.describe ?? ""),
          sourceProjectUuid: sourceUuid,
          ...(coverUrl ? { coverUrl } : {}),
        };
      }),
    );
  }

  async updateAsset(
    session: CentralSession | undefined,
    consumerUuid: string,
    assetUuid: string,
    patch: { name?: string; describe?: string; remark?: string; prompt?: string; imageRatio?: string },
  ): Promise<SharedAssetDto> {
    const sourceUuid = this.resolveSourceProjectUuid(session, consumerUuid);
    return projectOperationPort.withProjects(
      session,
      [consumerUuid, sourceUuid],
      new Map([
        [consumerUuid, "read"],
        [sourceUuid, "write"],
      ]),
      async () => runWithProjectStorage(sourceUuid, async () => {
        const current = await activeDb("o_assets").where({ assetUuid }).first();
        if (!current) throw Object.assign(new Error("资产不存在或不可见"), { status: 404 });
        const nextName = patch.name !== undefined ? String(patch.name ?? "").trim() : String(current.name ?? "");
        const nextDescribe = patch.describe !== undefined ? String(patch.describe ?? "").trim() : String(current.describe ?? "");
        const nextRemark = patch.remark !== undefined ? normalizeRemark(patch.remark) : normalizeRemark(current.remark);
        const nextPrompt = patch.prompt !== undefined ? String(patch.prompt ?? "").trim() : String(current.prompt ?? "");
        if (!nextName || nextName.length > MAX_ASSET_NAME) {
          throw safeAssetError("资产名称必填且长度须合理");
        }
        if (nextDescribe.length > MAX_ASSET_DESCRIBE) throw safeAssetError("资产描述过长");
        if (nextRemark.length > MAX_ASSET_REMARK) throw safeAssetError("资产别名过长");
        if (nextPrompt.length > MAX_ASSET_PROMPT) throw safeAssetError("生图提示词过长");
        const imageRatio = patch.imageRatio !== undefined
          ? normalizeImageRatio(patch.imageRatio)
          : current.imageRatio;
        await activeDb.transaction(async (trx) => {
          await trx("o_assets").where({ assetUuid }).update({
            name: nextName,
            describe: nextDescribe,
            remark: nextRemark,
            prompt: nextPrompt,
            imageRatio,
          });
          await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
        });
        if (consumerUuid !== sourceUuid) {
          await runWithProjectStorage(consumerUuid, async () => {
            await activeDb.transaction(async (trx) => {
              await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
            });
          });
        }
        const updated = await activeDb("o_assets").where({ assetUuid }).first();
        return toAssetDto(updated, sourceUuid);
      }),
    );
  }

  async uploadAssetAudio(
    session: CentralSession | undefined,
    consumerUuid: string,
    assetUuid: string,
    file: { buffer: Buffer; mime: string; filename?: string },
  ): Promise<SharedAssetDto> {
    const detected = detectAllowedAudio(file.buffer, file.mime, file.filename ?? "");
    if (!detected) {
      throw safeAssetError("角色音频只允许 mp3、wav、m4a、aac 或 ogg");
    }
    if (file.buffer.length > MAX_ASSET_MEDIA_BYTES) {
      throw safeAssetError("音频超过大小上限");
    }
    const sourceUuid = this.resolveSourceProjectUuid(session, consumerUuid);
    return projectOperationPort.withProjects(
      session,
      [consumerUuid, sourceUuid],
      new Map([
        [consumerUuid, "read"],
        [sourceUuid, "write"],
      ]),
      async () => runWithProjectStorage(sourceUuid, async () => {
        const current = await activeDb("o_assets").where({ assetUuid }).first();
        if (!current) throw safeAssetError("资产不存在或不可见", 404);
        if (String(current.type) !== "role") {
          throw safeAssetError("只有角色可以绑定音频");
        }
        const written = writeAssetMedia(sourceUuid, `files/audios/asset-${assetUuid}-${crypto.randomUUID()}.${detected.extension}`, file.buffer);
        try {
          await attachRoleAudio(current, written.relativePath, String(current.name ?? "角色音频"));
          await journalConsumer(consumerUuid, sourceUuid);
        } catch (error) {
          try { deleteWritten(sourceUuid, written.relativePath); } catch { /* 回滚新音频文件 */ }
          throw toSafeWriteError(error, "音频保存失败");
        }
        return toAssetDto(await activeDb("o_assets").where({ assetUuid }).first(), sourceUuid);
      }),
    );
  }

  async batchUploadAssets(
    session: CentralSession | undefined,
    consumerUuid: string,
    input: { type: string; imageRatio?: string; files: Array<{ buffer: Buffer; mime: string; filename: string }> },
  ): Promise<{ created: number; updated: number; skipped: number; failed: number; assets: SharedAssetDto[] }> {
    const type = normalizeAssetType(input.type);
    const imageRatio = normalizeImageRatio(input.imageRatio);
    if (!type) throw safeAssetError("资产类型只允许角色、场景或道具");
    const files = input.files ?? [];
    if (files.length === 0) throw safeAssetError("请选择要上传的文件");
    if (files.length > MAX_BATCH_FILES) throw safeAssetError("单批文件数量超过上限");
    const grouped = new Map<string, { image?: { buffer: Buffer; mime: string; filename: string; extension: string }; audio?: { buffer: Buffer; mime: string; filename: string; extension: string } }>();
    files.forEach((file, offset) => {
      if (file.buffer.length > MAX_ASSET_MEDIA_BYTES) {
        throw safeAssetError(`第 ${offset + 1} 个文件超过大小上限`);
      }
      let name: string;
      try {
        name = safeFileStem(file.filename);
      } catch {
        throw safeAssetError(`第 ${offset + 1} 个文件名不合法`);
      }
      const image = detectAllowedImage(file.buffer, file.mime);
      const audio = detectAllowedAudio(file.buffer, file.mime, file.filename);
      if (image) {
        const current = grouped.get(name) ?? {};
        if (current.image) throw safeAssetError(`第 ${offset + 1} 个文件与同名图片重复`);
        grouped.set(name, { ...current, image: { ...file, extension: image.extension } });
        return;
      }
      if (audio) {
        if (type !== "role") throw safeAssetError(`第 ${offset + 1} 个文件：只有角色可以上传音频`);
        const current = grouped.get(name) ?? {};
        if (current.audio) throw safeAssetError(`第 ${offset + 1} 个文件与同名音频重复`);
        grouped.set(name, { ...current, audio: { ...file, extension: audio.extension } });
        return;
      }
      throw safeAssetError(`第 ${offset + 1} 个文件格式不受支持`);
    });

    const sourceUuid = this.resolveSourceProjectUuid(session, consumerUuid);
    return projectOperationPort.withProjects(
      session,
      [consumerUuid, sourceUuid],
      new Map([
        [consumerUuid, "read"],
        [sourceUuid, "write"],
      ]),
      async () => runWithProjectStorage(sourceUuid, async () => {
        const writtenPaths: string[] = [];
        try {
          let created = 0;
          let updated = 0;
          const assets: SharedAssetDto[] = [];
          await activeDb.transaction(async (trx) => {
            const project = await trx("o_project").first();
            const projectId = Number(project?.id ?? 0) || null;
            for (const [name, media] of grouped) {
              const existing = await trx("o_assets")
                .where({ type, name })
                .where((builder) => builder.whereNull("assetsId").orWhere("assetsId", 0))
                .first();
              let row = existing;
              if (!row) {
                const assetUuid = crypto.randomUUID();
                const id = await nextIntegerId(trx, "o_assets");
                await trx("o_assets").insert({
                  id,
                  assetUuid,
                  name,
                  type,
                  describe: "",
                  remark: "",
                  prompt: "",
                  imageRatio,
                  projectId,
                  startTime: Date.now(),
                });
                row = await trx("o_assets").where({ assetUuid }).first();
                created += 1;
              } else {
                await trx("o_assets").where({ id: row.id }).update({ imageRatio });
                updated += 1;
              }
              if (media.image) {
                const written = writeAssetMedia(
                  sourceUuid,
                  `files/images/asset-${row.assetUuid}-${crypto.randomUUID()}.${media.image.extension}`,
                  media.image.buffer,
                );
                writtenPaths.push(written.relativePath);
                const imageId = await nextIntegerId(trx, "o_image");
                await trx("o_image").insert({
                  id: imageId,
                  assetsId: row.id,
                  filePath: written.relativePath,
                  type,
                  state: "已完成",
                });
                await trx("o_assets").where({ id: row.id }).update({ imageId });
              }
              if (media.audio) {
                const written = writeAssetMedia(
                  sourceUuid,
                  `files/audios/asset-${row.assetUuid}-${crypto.randomUUID()}.${media.audio.extension}`,
                  media.audio.buffer,
                );
                writtenPaths.push(written.relativePath);
                await attachRoleAudio(row, written.relativePath, name, trx);
              }
              assets.push(toAssetDto(await trx("o_assets").where({ id: row.id }).first(), sourceUuid));
            }
            await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
          });
          await journalConsumer(consumerUuid, sourceUuid);
          return { created, updated, skipped: 0, failed: 0, assets };
        } catch (error) {
          for (const relativePath of writtenPaths) {
            try { deleteWritten(sourceUuid, relativePath); } catch { /* 整批失败收回新文件 */ }
          }
          throw toSafeWriteError(error, "批量上传失败");
        }
      }),
    );
  }

  async importAssetDescriptions(
    session: CentralSession | undefined,
    consumerUuid: string,
    input: { format: string; text: string },
  ): Promise<{ created: number; updated: number; skipped: number; failed: number }> {
    const parsed = parseAssetImportText(input.format, input.text);
    const sourceUuid = this.resolveSourceProjectUuid(session, consumerUuid);
    return projectOperationPort.withProjects(
      session,
      [consumerUuid, sourceUuid],
      new Map([
        [consumerUuid, "read"],
        [sourceUuid, "write"],
      ]),
      async () => runWithProjectStorage(sourceUuid, async () => {
        let created = 0;
        let updated = 0;
        await activeDb.transaction(async (trx) => {
          const project = await trx("o_project").first();
          const projectId = Number(project?.id ?? 0) || null;
          for (const record of parsed.records) {
            const existing = await trx("o_assets")
              .where({ type: record.type, name: record.name })
              .where((builder) => builder.whereNull("assetsId").orWhere("assetsId", 0))
              .first();
            if (existing) {
              await trx("o_assets").where({ id: existing.id }).update({
                remark: record.remark,
                describe: record.describe,
                prompt: record.prompt,
                imageRatio: record.imageRatio,
              });
              updated += 1;
              continue;
            }
            await trx("o_assets").insert({
              id: await nextIntegerId(trx, "o_assets"),
              assetUuid: crypto.randomUUID(),
              name: record.name,
              type: record.type,
              describe: record.describe,
              remark: record.remark,
              prompt: record.prompt,
              imageRatio: record.imageRatio,
              projectId,
              startTime: Date.now(),
            });
            created += 1;
          }
          await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
        });
        await journalConsumer(consumerUuid, sourceUuid);
        return { created, updated, skipped: parsed.skipped, failed: 0 };
      }),
    );
  }

  async deleteAsset(
    session: CentralSession | undefined,
    consumerUuid: string,
    assetUuid: string,
  ): Promise<{ dependents: Array<{ projectUuid: string; shotUuid: string }> }> {
    const sourceUuid = this.resolveSourceProjectUuid(session, consumerUuid);
    return projectOperationPort.withProjects(
      session,
      [consumerUuid, sourceUuid],
      new Map([
        [consumerUuid, "read"],
        [sourceUuid, "write"],
      ]),
      async () => {
        const dependents = await listLocalAssetDependents(assetUuid);
        if (dependents.length > 0) {
          throw Object.assign(new Error("资产仍被分镜引用，禁止删除"), {
            status: 409,
            dependents,
          });
        }
        await runWithProjectStorage(sourceUuid, async () => {
          await activeDb.transaction(async (trx) => {
            const deleted = await trx("o_assets").where({ assetUuid }).delete();
            if (!deleted) throw Object.assign(new Error("资产不存在或不可见"), { status: 404 });
            await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
          });
        });
        if (consumerUuid !== sourceUuid) {
          await runWithProjectStorage(consumerUuid, async () => {
            await activeDb.transaction(async (trx) => {
              await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
            });
          });
        }
        return { dependents: [] };
      },
    );
  }
}

async function nextIntegerId(trx: any, table: string): Promise<number> {
  const row = await trx(table).max("id as maxId").first();
  return Number(row?.maxId ?? 0) + 1;
}

function toAssetDto(row: any, sourceUuid: string, coverUrl?: string, hasAudio = false): SharedAssetDto {
  return {
    assetUuid: String(row?.assetUuid ?? ""),
    name: String(row?.name ?? ""),
    type: String(row?.type ?? ""),
    describe: String(row?.describe ?? ""),
    remark: String(row?.remark ?? ""),
    prompt: String(row?.prompt ?? ""),
    imageRatio: displayImageRatio(row?.imageRatio),
    hasAudio,
    sourceProjectUuid: sourceUuid,
    ...(coverUrl ? { coverUrl } : {}),
  };
}

function writeAssetMedia(sourceUuid: string, relativePath: string, buffer: Buffer) {
  const context = currentUserStorage();
  if (!context) throw safeAssetError("缺少中央用户存储上下文", 403);
  return writeProjectFileAtomic(getPath(), sourceUuid, context.segment, relativePath, buffer);
}

function deleteWritten(sourceUuid: string, relativePath: string): void {
  const context = currentUserStorage();
  if (!context) return;
  deleteProjectFile(getPath(), sourceUuid, context.segment, relativePath);
}

async function journalConsumer(consumerUuid: string, sourceUuid: string): Promise<void> {
  if (consumerUuid === sourceUuid) return;
  await runWithProjectStorage(consumerUuid, async () => {
    await activeDb.transaction(async (trx) => {
      await upsertPendingMutationJournalInTrx(trx, "sharedAssetGateway");
    });
  });
}

async function attachRoleAudio(parent: any, relativePath: string, audioName: string, trx = activeDb): Promise<void> {
  const audioId = await nextIntegerId(trx, "o_assets");
  const audioUuid = crypto.randomUUID();
  await trx("o_assets").insert({
    id: audioId,
    assetUuid: audioUuid,
    name: audioName,
    type: "audio",
    describe: "",
    assetsId: parent.id,
    projectId: parent.projectId ?? null,
    startTime: Date.now(),
  });
  const imageId = await nextIntegerId(trx, "o_image");
  await trx("o_image").insert({
    id: imageId,
    assetsId: audioId,
    filePath: relativePath,
    type: "audio",
    state: "已完成",
  });
  await trx("o_assets").where({ id: audioId }).update({ imageId });
  if (await trx.schema.hasTable("o_assetsRole2Audio")) {
    await trx("o_assetsRole2Audio").where({ assetsRoleId: parent.id }).delete();
    await trx("o_assetsRole2Audio").insert({ assetsRoleId: parent.id, assetsAudioId: audioId });
  }
}

function toSafeWriteError(error: unknown, fallback: string): Error {
  if (error && typeof (error as { status?: unknown }).status === "number" && error instanceof Error) {
    const message = error.message;
    if (!/[A-Za-z]:\\|\\\\|SQLITE|ENOENT|at\s+\S+\.(ts|js)/i.test(message)) return error;
  }
  return safeAssetError(fallback, typeof (error as { status?: unknown })?.status === "number" ? Number((error as { status: number }).status) : 400);
}

function safeProjectCoverPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length <= "files/".length || !value.startsWith("files/")) {
    return null;
  }
  // 中文注释：DTO 只接受规范 POSIX 项目相对路径；拒绝盘符、UNC、转义分隔符和控制字符。
  if (
    value.includes("\\")
    || value.includes(":")
    || value.includes("%")
    || value.includes("?")
    || value.includes("#")
    || /[\u0000-\u001f\u007f]/.test(value)
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.normalize(value) !== value
  ) {
    return null;
  }
  const parts = value.split("/");
  if (parts[0] !== "files" || parts.slice(1).some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return value;
}

async function listLocalAssetDependents(
  assetUuid: string,
): Promise<Array<{ projectUuid: string; shotUuid: string }>> {
  const context = currentUserStorage();
  if (!context) return [];
  const projectsRoot = path.join(getPath(), "runtime-users", context.segment, "projects");
  if (!fs.existsSync(projectsRoot)) return [];
  const dependents: Array<{ projectUuid: string; shotUuid: string }> = [];
  for (const name of fs.readdirSync(projectsRoot)) {
    const dbPath = path.join(projectsRoot, name, "project.sqlite");
    if (!fs.existsSync(dbPath)) continue;
    await prepareProjectDatabase(name);
    await runWithProjectStorage(name, async () => {
      if (!await activeDb.schema.hasTable("o_storyboardShotAsset")) return;
      const rows = await activeDb("o_storyboardShotAsset").where({ assetUuid }).select("shotUuid");
      for (const row of rows) {
        dependents.push({ projectUuid: name, shotUuid: String(row.shotUuid) });
      }
    });
  }
  return dependents;
}

export const sharedAssetGateway = new SharedAssetGateway();
