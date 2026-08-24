// @vitest-environment jsdom
/**
 * R25-fix1 RED：工作台提交必须带可重放 operation 身份，且不得丢弃 uploadData。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("R25-fix1 工作台即梦提交合同", () => {
  it("单项 generateVideo 必须提交 clientOperationId 与 uploadData", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/views/production/components/workbench/generate/composables/useGenerateActions.ts"),
      "utf8",
    );
    expect(source).toMatch(/uploadData/);
    expect(source).toMatch(/clientOperationId/);
  });

  it("批量 batchGenerateVideo 必须提交 clientOperationId 与 track uploadData", () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        "src/views/production/components/workbench/generate/components/composables/useTrackBatchActions.ts",
      ),
      "utf8",
    );
    expect(source).toMatch(/uploadData/);
    expect(source).toMatch(/clientOperationId/);
  });
});
