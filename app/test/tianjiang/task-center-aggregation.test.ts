import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  aggregateTaskCategories,
  aggregateTaskCenterList,
  listLocalTaskProjectSources,
  listTaskCenterProjects,
  TaskCenterError,
} from "../../src/tianjiang/tasks/task-center-aggregation";
import { localLegacyProjectId } from "../../src/tianjiang/runtime/local-project-id";

const UUID_A = "11111111-1111-4111-a111-111111111111";
const UUID_B = "22222222-2222-4222-a222-222222222222";
const UUID_EMPTY = "33333333-3333-4333-a333-333333333333";
const SEGMENT_A = "a".repeat(32);
const SEGMENT_B = "b".repeat(32);

function fixtureRoot(name: string): string {
  const root = path.join(process.cwd(), "..", ".tmp", `task-center-${name}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function writeProjectDb(
  dataRoot: string,
  segment: string,
  projectUuid: string,
  tasks: Array<Record<string, unknown>>,
  options?: { corrupt?: boolean; skipTable?: boolean },
): string {
  const dir = path.join(dataRoot, "runtime-users", segment, "projects", projectUuid);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "project.sqlite");
  if (options?.corrupt) {
    fs.writeFileSync(dbPath, "not-a-sqlite");
    return dbPath;
  }
  const db = new Database(dbPath);
  if (!options?.skipTable) {
    db.exec(`
      CREATE TABLE o_tasks (
        id INTEGER PRIMARY KEY,
        projectId INTEGER,
        taskClass TEXT,
        relatedObjects TEXT,
        model TEXT,
        describe TEXT,
        state TEXT,
        startTime INTEGER,
        reason TEXT
      );
    `);
    const insert = db.prepare(
      `INSERT INTO o_tasks (id, projectId, taskClass, relatedObjects, model, describe, state, startTime, reason)
       VALUES (@id, @projectId, @taskClass, @relatedObjects, @model, @describe, @state, @startTime, @reason)`,
    );
    for (const task of tasks) insert.run(task);
  }
  db.close();
  return dbPath;
}

test("当前账号两个项目数据库任务成功聚合、排序与分页", () => {
  const root = fixtureRoot("agg");
  try {
    writeProjectDb(root, SEGMENT_A, UUID_A, [
      {
        id: 1,
        projectId: 1,
        taskClass: "image",
        relatedObjects: "a1",
        model: "m1",
        describe: "d1",
        state: "已完成",
        startTime: 100,
        reason: null,
      },
      {
        id: 2,
        projectId: 1,
        taskClass: "video",
        relatedObjects: "a2",
        model: "m2",
        describe: "d2",
        state: "进行中",
        startTime: 300,
        reason: null,
      },
    ]);
    writeProjectDb(root, SEGMENT_A, UUID_B, [
      {
        id: 1,
        projectId: 2,
        taskClass: "image",
        relatedObjects: "b1",
        model: "m3",
        describe: "d3",
        state: "生成失败",
        startTime: 200,
        reason: "fail",
      },
    ]);
    // 账号 B 同名项目库不得被账号 A 读到
    writeProjectDb(root, SEGMENT_B, UUID_A, [
      {
        id: 99,
        projectId: 9,
        taskClass: "secret",
        relatedObjects: "x",
        model: "x",
        describe: "leak",
        state: "进行中",
        startTime: 999,
        reason: null,
      },
    ]);

    const sources = listLocalTaskProjectSources({
      dataRoot: root,
      userSegment: SEGMENT_A,
      catalog: [
        { projectUuid: UUID_A, name: "项目甲" },
        { projectUuid: UUID_B, name: "项目乙" },
      ],
    });
    assert.equal(sources.length, 2);

    const page1 = aggregateTaskCenterList(sources, { page: 1, limit: 2 });
    assert.equal(page1.total, 3);
    assert.equal(page1.data.length, 2);
    // startTime 降序：300, 200, 100
    assert.equal(page1.data[0].startTime, 300);
    assert.equal(page1.data[0].projectUuid, UUID_A);
    assert.equal(page1.data[0].projectName, "项目甲");
    assert.equal(page1.data[1].startTime, 200);
    assert.equal(page1.data[1].projectUuid, UUID_B);
    assert.equal(page1.data[0].rowKey, `${UUID_A}:2`);

    const page2 = aggregateTaskCenterList(sources, { page: 2, limit: 2 });
    assert.equal(page2.data.length, 1);
    assert.equal(page2.data[0].id, 1);
    assert.equal(page2.data[0].projectUuid, UUID_A);

    const filtered = aggregateTaskCenterList(sources, {
      page: 1,
      limit: 10,
      projectUuid: UUID_B,
      taskClass: "image",
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.data[0].relatedObjects, "b1");

    const categories = aggregateTaskCategories(sources);
    assert.deepEqual(
      categories.map((item) => item.taskClass).sort(),
      ["image", "video"],
    );

    const projects = listTaskCenterProjects(sources);
    assert.equal(projects.length, 2);
    assert.ok(projects.every((item) => item.projectUuid && item.name));
    assert.equal(projects[0].id, localLegacyProjectId(projects[0].projectUuid));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A/B 账号目录严格隔离", () => {
  const root = fixtureRoot("iso");
  try {
    writeProjectDb(root, SEGMENT_A, UUID_A, [
      {
        id: 1,
        projectId: 1,
        taskClass: "a",
        relatedObjects: "a",
        model: "a",
        describe: "a",
        state: "进行中",
        startTime: 1,
        reason: null,
      },
    ]);
    writeProjectDb(root, SEGMENT_B, UUID_A, [
      {
        id: 1,
        projectId: 1,
        taskClass: "b-only",
        relatedObjects: "b",
        model: "b",
        describe: "b",
        state: "进行中",
        startTime: 2,
        reason: null,
      },
    ]);
    const sourcesA = listLocalTaskProjectSources({
      dataRoot: root,
      userSegment: SEGMENT_A,
      catalog: [{ projectUuid: UUID_A, name: "A" }],
    });
    const listA = aggregateTaskCenterList(sourcesA, { page: 1, limit: 10 });
    assert.equal(listA.total, 1);
    assert.equal(listA.data[0].taskClass, "a");
    assert.equal(listA.data.some((row) => row.taskClass === "b-only"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh 项目无 o_tasks 表时返回空列表 200 语义 data=[] total=0", () => {
  const root = fixtureRoot("empty");
  try {
    writeProjectDb(root, SEGMENT_A, UUID_EMPTY, [], { skipTable: true });
    const sources = listLocalTaskProjectSources({
      dataRoot: root,
      userSegment: SEGMENT_A,
      catalog: [{ projectUuid: UUID_EMPTY, name: "空项目" }],
    });
    const result = aggregateTaskCenterList(sources, { page: 1, limit: 10 });
    assert.deepEqual(result, { data: [], total: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("单个项目数据库损坏返回安全错误且不包含绝对路径", () => {
  const root = fixtureRoot("corrupt");
  try {
    writeProjectDb(root, SEGMENT_A, UUID_A, [], { corrupt: true });
    const sources = listLocalTaskProjectSources({
      dataRoot: root,
      userSegment: SEGMENT_A,
      catalog: [{ projectUuid: UUID_A, name: "坏库" }],
    });
    assert.throws(
      () => aggregateTaskCenterList(sources, { page: 1, limit: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof TaskCenterError);
        assert.match(error.message, /任务数据不可用/);
        assert.doesNotMatch(error.message, /runtime-users|project\.sqlite|E:\\|C:\\/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("状态与类别筛选在聚合后生效", () => {
  const root = fixtureRoot("filter");
  try {
    writeProjectDb(root, SEGMENT_A, UUID_A, [
      {
        id: 1,
        projectId: 1,
        taskClass: "image",
        relatedObjects: "1",
        model: "m",
        describe: "d",
        state: "进行中",
        startTime: 10,
        reason: null,
      },
      {
        id: 2,
        projectId: 1,
        taskClass: "video",
        relatedObjects: "2",
        model: "m",
        describe: "d",
        state: "已完成",
        startTime: 20,
        reason: null,
      },
    ]);
    const sources = listLocalTaskProjectSources({
      dataRoot: root,
      userSegment: SEGMENT_A,
      catalog: [{ projectUuid: UUID_A, name: "P" }],
    });
    const running = aggregateTaskCenterList(sources, {
      page: 1,
      limit: 10,
      state: "进行中",
    });
    assert.equal(running.total, 1);
    assert.equal(running.data[0].taskClass, "image");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("项目数据库路径包含目录联接时拒绝读取，禁止借 junction 越过当前账号目录", () => {
  const root = fixtureRoot("junction");
  const outside = fixtureRoot("junction-outside");
  try {
    writeProjectDb(outside, SEGMENT_A, UUID_A, []);
    const outsideProject = path.join(
      outside,
      "runtime-users",
      SEGMENT_A,
      "projects",
      UUID_A,
    );
    const accountProjects = path.join(root, "runtime-users", SEGMENT_A, "projects");
    fs.mkdirSync(accountProjects, { recursive: true });
    fs.symlinkSync(outsideProject, path.join(accountProjects, UUID_A), "junction");

    assert.throws(
      () => listLocalTaskProjectSources({
        dataRoot: root,
        userSegment: SEGMENT_A,
        catalog: [{ projectUuid: UUID_A, name: "越界项目" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof TaskCenterError);
        assert.equal(error.status, 403);
        assert.doesNotMatch(error.message, /runtime-users|project\.sqlite|E:\\|C:\\/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("任务中心必须把分镜生成任务映射为排队中/生成中且保留旧 o_tasks 行", async () => {
  const { mapStoryboardTaskCenterState } = await import("../../src/tianjiang/tasks/task-center-aggregation");
  assert.equal(mapStoryboardTaskCenterState("queued"), "排队中");
  assert.equal(mapStoryboardTaskCenterState("downloading"), "生成中");
  assert.equal(mapStoryboardTaskCenterState("completed"), "已完成");
  assert.equal(mapStoryboardTaskCenterState("failed_fatal"), "生成失败");
  assert.equal(mapStoryboardTaskCenterState("outcome_unknown"), "结果待确认");
  assert.equal(mapStoryboardTaskCenterState("cancelled_local"), "已取消");
  assert.equal(mapStoryboardTaskCenterState("waiting_origin_device"), "等待原设备");
});
