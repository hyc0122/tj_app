import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const taskPageSource = fs.readFileSync(
  path.resolve("src/views/task/index.vue"),
  "utf8",
);

describe("R28 即梦队列自动恢复与任务状态反馈", () => {
  it("任务中心统一刷新任务和队列，并在页面存活期间持续轮询", () => {
    expect(taskPageSource).toContain("refreshTaskCenter");
    expect(taskPageSource).toMatch(/@click=["']refreshTaskCenter["']/);
    expect(taskPageSource).toContain("setInterval");
    expect(taskPageSource).toContain("clearInterval");
    expect(taskPageSource).toContain("onUnmounted");
  });

  it("所有带原因的任务都能查看说明，而非只允许失败状态显示", () => {
    expect(taskPageSource).toMatch(/v-if=["']row\.reason\s*\|\|/);
    expect(taskPageSource).toContain("taskStateClass");
  });
});
