/**
 * Round27 RED：分镜工作台读取模型必须投影真实候选产物和生成任务，且不得泄漏内部字段。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activateUserDatabase,
  db as activeDb,
  destroyAllDatabaseHandles,
  initializeWorkspaceProject,
  resetDatabaseRuntimeForServe,
} from "../../src/utils/db";
import {
  enterUserStorage,
  runWithProjectStorage,
  runWithUserStorage,
} from "../../src/tianjiang/runtime/user-storage-context";
import { StoryboardService } from "../../src/tianjiang/storyboard/storyboard-service";

const IDENTITY = { issuer: "https://api.j11.com.cn", userId: 9727 };
const PROJECT_UUID = "27272727-2727-4727-a727-272727272727";
const CANDIDATE_KEYS = [
  "candidateUuid",
  "createdAt",
  "mediaType",
  "relativePath",
  "selected",
];
const TASK_KEYS = [
  "createdAt",
  "mediaType",
  "modelName",
  "providerId",
  "status",
  "taskUuid",
  "updatedAt",
];

test("真实分镜读取必须同批返回候选与任务状态，并过滤路径及内部字段", async () => {
  const verificationRoot = path.resolve(
    process.cwd(),
    "..",
    ".local",
    "t",
  );
  const root = path.join(verificationRoot, `read-model-${process.pid}-${crypto.randomUUID()}`);
  const previousCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  fs.mkdirSync(root, { recursive: true });
  process.chdir(root);
  process.env.NODE_ENV = "prod";
  process.env.NODE_TEST_CONTEXT = previousTestContext || "storyboard-workbench-read-model-round27";
  resetDatabaseRuntimeForServe();
  await activateUserDatabase(IDENTITY);

  try {
    await runWithUserStorage(IDENTITY, async () => {
      enterUserStorage(IDENTITY);
      await initializeWorkspaceProject(PROJECT_UUID, {
        id: 2727,
        name: "Round27 分镜工作台读取模型",
        projectType: "storyboard" as "novel",
        userId: IDENTITY.userId,
      });

      const service = new StoryboardService(PROJECT_UUID);
      const shot = await service.insertShot({
        afterShotUuid: null,
        sourceText: "雨夜主角走入车站",
      });
      const imageCandidateUuid = "27272727-0001-4727-a727-272727272727";
      const videoCandidateUuid = "27272727-0002-4727-a727-272727272727";
      const queuedTaskUuid = "27272727-1001-4727-a727-272727272727";
      const failedTaskUuid = "27272727-1002-4727-a727-272727272727";
      const createdAt = "2026-08-15T03:04:05.000Z";
      const createdAtMs = Date.parse(createdAt);

      await runWithProjectStorage(PROJECT_UUID, async () => {
        await activeDb("o_storyboardCandidate").insert([
          {
            candidateUuid: imageCandidateUuid,
            shotUuid: shot.shotUuid,
            mediaType: "image",
            relativePath: `files/images/storyboard/${shot.shotUuid}/selected.png`,
            selected: 1,
            createdAt,
          },
          {
            candidateUuid: videoCandidateUuid,
            shotUuid: shot.shotUuid,
            mediaType: "video",
            relativePath: `files/videos/storyboard/${shot.shotUuid}/preview.mp4`,
            selected: 0,
            createdAt: "2026-08-15T03:04:06.000Z",
          },
          // 中文注释：非法候选即使存在于旧库，也不能把本机路径投影给渲染进程。
          {
            candidateUuid: "27272727-0003-4727-a727-272727272727",
            shotUuid: shot.shotUuid,
            mediaType: "image",
            relativePath: "files/../private/secret.png",
            selected: 0,
            createdAt: "2026-08-15T03:04:07.000Z",
          },
          {
            candidateUuid: "27272727-0004-4727-a727-272727272727",
            shotUuid: shot.shotUuid,
            mediaType: "image",
            relativePath: "files\\images\\private.png",
            selected: 0,
            createdAt: "2026-08-15T03:04:08.000Z",
          },
          {
            candidateUuid: "27272727-0005-4727-a727-272727272727",
            shotUuid: shot.shotUuid,
            mediaType: "video",
            relativePath: "files/C:/Users/test/private.mp4",
            selected: 0,
            createdAt: "2026-08-15T03:04:09.000Z",
          },
        ]);

        const taskBase = {
          shotUuid: shot.shotUuid,
          parentTaskUuid: null,
          originDeviceUuid: "27272727-2001-4727-a727-272727272727",
          providerTaskId: null,
          providerSessionId: null,
          paidBatchConfirmedAt: null,
          providerCompletedAt: null,
          resultLocatorDigest: null,
          progress: 0,
        };
        await activeDb("o_storyboardGenerationTask").insert([
          {
            ...taskBase,
            taskUuid: queuedTaskUuid,
            mediaType: "video",
            providerId: "dreamina-cli",
            mode: "text2video",
            modelName: "dreamina-cli:seedance2.0fast",
            parametersJson: JSON.stringify({
              prompt: "雨夜车站",
              inputPath: "C:\\Users\\test\\private-reference.png",
            }),
            requestDigest: "a".repeat(64),
            status: "queued",
            errorCode: null,
            errorSummary: null,
            createdAt: createdAtMs,
            updatedAt: createdAtMs + 100,
          },
          {
            ...taskBase,
            taskUuid: failedTaskUuid,
            mediaType: "image",
            providerId: "vendor",
            mode: "text2image",
            modelName: "vendor:image-v1",
            parametersJson: JSON.stringify({ prompt: "雨夜车站" }),
            requestDigest: "b".repeat(64),
            status: "failed",
            errorCode: "PROVIDER_FAILED",
            errorSummary: "Error: C:\\Users\\test\\private.log\n    at secret.ts:1:1",
            createdAt: createdAtMs + 200,
            updatedAt: createdAtMs + 300,
          },
        ]);
      });

      const sql: string[] = [];
      const onQuery = (event: { sql?: unknown }) => sql.push(String(event.sql ?? ""));
      await runWithProjectStorage(PROJECT_UUID, () => activeDb.on("query", onQuery));
      let listed;
      try {
        listed = await service.listShots();
      } finally {
        await runWithProjectStorage(PROJECT_UUID, () => activeDb.off("query", onQuery));
      }

      const actual = listed.find((item) => item.shotUuid === shot.shotUuid);
      assert.ok(actual);
      assert.equal(actual.candidates.length, 2);
      assert.equal(actual.candidates.find((item) => item.mediaType === "image")?.selected, true);
      assert.equal(actual.generationTasks.length, 2);
      assert.equal(
        actual.generationTasks.find((item) => item.mediaType === "video")?.status,
        "queued",
      );

      for (const candidate of actual.candidates) {
        assert.deepEqual(Object.keys(candidate).sort(), CANDIDATE_KEYS);
        assert.match(candidate.relativePath, /^files\//);
      }
      for (const task of actual.generationTasks) {
        assert.deepEqual(Object.keys(task).sort(), TASK_KEYS);
        assert.equal((task as { parametersJson?: unknown }).parametersJson, undefined);
        assert.equal((task as { providerResultJson?: unknown }).providerResultJson, undefined);
        assert.equal((task as { errorSummary?: unknown }).errorSummary, undefined);
      }

      const serialized = JSON.stringify(actual);
      assert.doesNotMatch(serialized, /parametersJson|providerResultJson|errorSummary|C:\\\\Users/i);

      // 中文注释：四张业务表各读一次，防止随着分镜数量增长形成 N+1 查询。
      for (const tableName of [
        "o_storyboardShot",
        "o_storyboardShotAsset",
        "o_storyboardCandidate",
        "o_storyboardGenerationTask",
      ]) {
        const reads = sql.filter((statement) =>
          statement.toLowerCase().includes(`from \`${tableName.toLowerCase()}\``),
        );
        assert.equal(reads.length, 1, `${tableName} 必须恰好读取一次，实际 SQL=${JSON.stringify(sql)}`);
      }

    });
  } finally {
    await destroyAllDatabaseHandles().catch(() => undefined);
    process.chdir(previousCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时保留在隔离验证目录，禁止跨出该 worktree 清理。
    }
  }
});
