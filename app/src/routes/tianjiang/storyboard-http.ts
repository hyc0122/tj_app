import express from "express";
import { z } from "zod";

import {
  assertPreviewDigest,
  buildImportPreview,
  shotsToCsv,
  type ImportFormat,
} from "@/tianjiang/storyboard/import-export";
import { StoryboardService } from "@/tianjiang/storyboard/storyboard-service";
import { sharedAssetGateway } from "@/tianjiang/storyboard/shared-asset-gateway";
import { projectOperationPort } from "@/tianjiang/runtime/project-operation-port";
import { runWithProjectStorage } from "@/tianjiang/runtime/user-storage-context";
import { db as activeDb } from "@/utils/db";
import { RuntimePermissionError } from "@/tianjiang/runtime/sync-coordinator";

const router = express.Router();
const projectUuid = z.string().uuid();
const formatSchema = z.enum(["txt", "csv", "xlsx"]);

const PUBLIC_IMPORT_ERROR_MESSAGES = {
  STORYBOARD_IMPORT_TOO_LARGE: "导入文件超过 2MB 限制",
  STORYBOARD_IMPORT_CONTENT_CHANGED: "导入内容已变化，请重新预览",
  STORYBOARD_IMPORT_UNSUPPORTED_FORMAT: "不支持的导入格式",
  STORYBOARD_IMPORT_HAS_ERRORS: "导入内容仍有错误，禁止写入",
  STORYBOARD_EXPORT_UNSUPPORTED_FORMAT: "当前仅支持 CSV/TXT 导出",
  STORYBOARD_IMPORT_FORBIDDEN: "当前身份不能写入该项目",
} as const;

const GENERIC_IMPORT_ERROR = "分镜导入导出失败";

function writeError(res: express.Response, error: unknown): void {
  const published = toPublicImportError(error);
  res.status(published.status).send({
    code: published.code,
    message: published.message,
  });
}

export function toPublicImportError(error: unknown): { status: number; code: string; message: string } {
  // 中文注释：只按稳定错误码白名单映射公开中文文案，禁止用黑名单过滤后回显原文。
  const fallbackStatus = resolveImportErrorStatus(error);
  if (error instanceof RuntimePermissionError) {
    return {
      status: 403,
      code: "STORYBOARD_IMPORT_FORBIDDEN",
      message: PUBLIC_IMPORT_ERROR_MESSAGES.STORYBOARD_IMPORT_FORBIDDEN,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      code: "STORYBOARD_IMPORT_UNSUPPORTED_FORMAT",
      message: PUBLIC_IMPORT_ERROR_MESSAGES.STORYBOARD_IMPORT_UNSUPPORTED_FORMAT,
    };
  }
  const rawCode = typeof (error as { code?: unknown })?.code === "string"
    ? String((error as { code: string }).code).trim()
    : "";
  if (rawCode in PUBLIC_IMPORT_ERROR_MESSAGES) {
    const code = rawCode as keyof typeof PUBLIC_IMPORT_ERROR_MESSAGES;
    return {
      status: fallbackStatus,
      code,
      message: PUBLIC_IMPORT_ERROR_MESSAGES[code],
    };
  }
  return {
    status: fallbackStatus,
    code: String(fallbackStatus),
    message: GENERIC_IMPORT_ERROR,
  };
}

function resolveImportErrorStatus(error: unknown): number {
  if (typeof (error as { status?: unknown })?.status === "number") {
    return Number((error as { status: number }).status);
  }
  if (error instanceof RuntimePermissionError) return 403;
  return 400;
}

function buildCommitMessage(unmatchedCount: number): string {
  if (unmatchedCount <= 0) return "导入已提交";
  return `导入已提交，${unmatchedCount} 个关键词未匹配到资产`;
}

router.post("/:projectUuid/import/preview", async (req, res) => {
  try {
    const format = formatSchema.parse(req.body?.format) as ImportFormat;
    const preview = await buildImportPreview(
      format,
      String(req.body?.contentBase64 ?? ""),
      req.body?.txtDelimiter,
    );
    res.status(200).send({ code: 0, data: preview, message: "导入预览完成" });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/:projectUuid/import/commit", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String(req.params.projectUuid ?? ""));
    const format = formatSchema.parse(req.body?.format) as ImportFormat;
    const contentBase64 = String(req.body?.contentBase64 ?? "");
    const digest = String(req.body?.previewDigest ?? "");
    const txtDelimiter = req.body?.txtDelimiter;
    const buffer = assertPreviewDigest(format, contentBase64, digest, txtDelimiter);
    const preview = await buildImportPreview(format, contentBase64, txtDelimiter);
    if (preview.errors.length) {
      throw Object.assign(new Error("导入内容仍有错误，禁止写入"), {
        status: 422,
        code: "STORYBOARD_IMPORT_HAS_ERRORS",
      });
    }
    const mode = req.body?.mode === "insertAfter" ? "insertAfter" : "append";
    const afterShotUuid = typeof req.body?.afterShotUuid === "string" ? req.body.afterShotUuid : null;
    const session = (req as { centralSession?: never }).centralSession;
    const sourceUuid = sharedAssetGateway.resolveSourceProjectUuid(session, uuid);
    const created = await projectOperationPort.withProject(
      session,
      uuid,
      "write",
      async () => {
        const service = new StoryboardService(uuid);
        const existing = await service.listShots();
        const cursor = mode === "insertAfter" ? afterShotUuid : (existing.at(-1)?.shotUuid ?? null);
        const resolvedAssets = new Map<string, { assetUuid: string; assetType: "role" | "scene" | "tool" | "clip" | "audio" }>();
        // 中文注释：必须在写事务外一次性解析资产，避免 pool=1 时事务内二次查询超时。
        await runWithProjectStorage(sourceUuid, async () => {
          for (const row of preview.rows) {
            for (const [assetType, names] of Object.entries(row.assetNames ?? {})) {
              for (const name of names) {
                const key = `${assetType}:${name}`;
                if (resolvedAssets.has(key)) continue;
                const asset = await activeDb("o_assets").where({ name, type: assetType }).first();
                if (!asset?.assetUuid) continue;
                resolvedAssets.set(key, {
                  assetUuid: String(asset.assetUuid),
                  assetType: (asset.type as "role" | "scene" | "tool" | "clip" | "audio") || "role",
                });
              }
            }
          }
        });
        const committed = await service.commitImportRows({
          sourceProjectUuid: sourceUuid,
          resolveAsset: async (name, type) => resolvedAssets.get(`${type}:${name}`) ?? null,
          rows: preview.rows.map((row, index) => ({
            afterShotUuid: index === 0 ? cursor : null,
            sourceText: row.sourceText,
            visualDescription: row.visualDescription,
            imagePrompt: row.imagePrompt,
            videoPrompt: row.videoPrompt,
            negativePrompt: row.negativePrompt,
            durationMs: row.durationMs,
            assetNames: row.assetNames,
          })),
        });
        return {
          inserted: committed.shots,
          bytes: buffer.length,
          unmatchedCount: committed.unmatchedNames.length,
          unmatchedKeywords: committed.unmatchedNames,
        };
      },
    );
    res.status(200).send({
      code: 0,
      data: created,
      message: buildCommitMessage(Number(created.unmatchedCount ?? 0)),
    });
  } catch (error) {
    writeError(res, error);
  }
});

router.post("/:projectUuid/export", async (req, res) => {
  try {
    const uuid = projectUuid.parse(String(req.params.projectUuid ?? ""));
    const format = formatSchema.parse(req.body?.format ?? "csv");
    const shots = await projectOperationPort.withProject(
      (req as { centralSession?: never }).centralSession,
      uuid,
      "read",
      async () => new StoryboardService(uuid).listShots(),
    );
    if (format === "csv" || format === "txt") {
      const csv = shotsToCsv([...shots]);
      res.status(200).type("text/csv").send(csv);
      return;
    }
    throw Object.assign(new Error("当前仅支持 CSV/TXT 导出"), {
      status: 400,
      code: "STORYBOARD_EXPORT_UNSUPPORTED_FORMAT",
    });
  } catch (error) {
    writeError(res, error);
  }
});

export default router;
