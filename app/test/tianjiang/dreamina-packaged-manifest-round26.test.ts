/**
 * Round26 RED：批准发行清单必须从 Electron resourcesPath 解析，并进入真实 builder 资源映射。
 * 本测试只使用工作树 .tmp 夹具，不下载官方 CLI，也不读取用户数据。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import {
  defaultApprovedManifestPath,
  readApprovedReleaseManifest,
} from "../../src/tianjiang/model-providers/dreamina-cli/approved-release-manifest";

const appRoot = path.resolve(__dirname, "../..");
const projectRoot = path.resolve(appRoot, "..");
const sourceManifest = path.join(appRoot, "resources", "dreamina-cli", "approved-releases.json");
const requireFromApp = createRequire(path.join(appRoot, "package.json"));
const { load } = requireFromApp("js-yaml") as { load: (source: string) => unknown };

function withPackagedResources<T>(callback: (resourcesRoot: string) => T): T {
  const root = fs.mkdtempSync(path.join(projectRoot, ".tmp", "dreamina-packaged-manifest-"));
  const manifestDirectory = path.join(root, "dreamina-cli");
  const packagedManifest = path.join(manifestDirectory, "approved-releases.json");
  fs.mkdirSync(manifestDirectory, { recursive: true });
  fs.copyFileSync(sourceManifest, packagedManifest);

  const original = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    enumerable: false,
    value: root,
  });
  try {
    return callback(root);
  } finally {
    if (original) Object.defineProperty(process, "resourcesPath", original);
    else Reflect.deleteProperty(process, "resourcesPath");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("打包运行态默认清单必须来自 process.resourcesPath", () => {
  withPackagedResources((resourcesRoot) => {
    const expected = path.join(resourcesRoot, "dreamina-cli", "approved-releases.json");
    assert.equal(
      defaultApprovedManifestPath(),
      expected,
      "打包运行态不得继续指向源码 app/resources",
    );
    const parsed = readApprovedReleaseManifest();
    assert.ok(parsed.releases.some((release) => release.platform === "windows-x64"));
  });
});

test("Electron Builder 必须把批准清单复制到精确的打包路径", () => {
  const document = load(fs.readFileSync(path.join(appRoot, "electron-builder.yml"), "utf8")) as {
    extraResources?: Array<{ from?: string; to?: string }>;
  };
  const mappings = document.extraResources ?? [];
  assert.ok(
    mappings.some((item) => (
      item.from === "resources/dreamina-cli/approved-releases.json"
      && item.to === "dreamina-cli/approved-releases.json"
    )),
    `缺少批准清单 extraResources 映射，实际=${JSON.stringify(mappings)}`,
  );
});
