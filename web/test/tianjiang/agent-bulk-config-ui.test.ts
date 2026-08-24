import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "src/components/setting/components/agentConfog.vue"),
  "utf8",
);
const route = readFileSync(
  path.join(process.cwd(), "../app/src/routes/setting/agentDeploy/bulkConfigureAgents.ts"),
  "utf8",
);
const logic = readFileSync(
  path.join(process.cwd(), "../app/src/tianjiang/agent/bulk-agent-config.ts"),
  "utf8",
);

describe("一键配置全部 Agent UI 与接口契约", () => {
  it("简易与高级模式均显示一键配置按钮", () => {
    expect(source).toContain('data-testid="agent-bulk-configure"');
    expect(source).toContain("bulkConfigureAll");
    // 不得仅在 advanced 显示
    expect(source).not.toMatch(
      /v-if="agentUseModeVal\s*==\s*['\"]1['\"]"[^>]*>\s*\{\{\s*\$t\(['\"]settings\.agent\.bulkConfigureAll/,
    );
  });

  it("提交账号级 bulkConfigureAgents，只带 mode 与模型字段", () => {
    expect(source).toContain("/setting/agentDeploy/bulkConfigureAgents");
    expect(source).toMatch(/vendorId/);
    expect(source).toMatch(/modelName/);
    // 仅截取 submitBulkConfigure 函数体，避免混入旧批量设置
    const start = source.indexOf("async function submitBulkConfigure");
    expect(start).toBeGreaterThan(-1);
    const endMarker = source.indexOf("async function jumpToWebsite", start);
    const end = endMarker > start ? endMarker : start + 2500;
    const submit = source.slice(start, end);
    expect(submit).toContain("bulkConfigureAgents");
    expect(submit).toContain("mode");
    expect(submit).toContain("vendorId");
    expect(submit).toContain("modelName");
    expect(submit).not.toMatch(/deployIds|deployIdList/);
    // 一键配置 body 不传 items 数组（旧批量设置才有）
    expect(submit).not.toMatch(/post\([^)]*items\s*:/);
  });

  it("确认摘要含供应商、模型与数量", () => {
    expect(source).toContain("bulkConfirmBody");
    expect(source).toContain("DialogPlugin.confirm");
    expect(source).toContain("bulkSuccess");
  });

  it("服务端权威计算目标键并事务更新", () => {
    expect(logic).toContain("resolveBulkTargetKeys");
    expect(logic).toContain("SIMPLE_AGENT_KEYS");
    expect(logic).toContain("ttsDubbing");
    expect(logic).toContain("transaction");
    expect(logic).toMatch(/vendorId|modelName/);
    expect(route).toContain("executeBulkAgentConfig");
    expect(route).toMatch(/mode:\s*z\.enum/);
  });

  it("不新增坐标型 CSS 补丁（下拉定位由其他任务负责）", () => {
    expect(source).not.toMatch(/top:\s*\d+px.*popup|position:\s*fixed.*select/i);
    expect(source).not.toMatch(/transform:\s*translate/i);
  });
});
