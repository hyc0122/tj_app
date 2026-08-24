import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// @ts-expect-error 构建合同保持原生 ESM，不单独生成类型声明。
import { assertUnsignedBuilderContract } from "../../scripts/electron-builder-unsigned-contract.mjs";
// @ts-expect-error 打包入口保持原生 ESM，不单独生成类型声明。
import { parsePackageTarget, runCommand, resolveYarnCommand } from "../../scripts/package-electron.mjs";
// @ts-expect-error 发布目标验证器保持原生 ESM，不单独生成类型声明。
import { verifyReleaseTarget } from "../../scripts/verify-release-target.mjs";

const VERSION = "1.1.10-beta.1";
const fixtureParent = path.resolve("..", ".tmp");

type TargetFixture = {
  targetId: "windows-x64" | "macos-x64" | "macos-arm64" | "linux-x64" | "linux-arm64";
  artifacts: string[];
  metadataFile: string;
  metadataBinaries: string[];
  primaryArtifact: string;
};

const TARGET_FIXTURES: TargetFixture[] = [
  {
    targetId: "windows-x64",
    artifacts: [
      `天将漫创-${VERSION}-win-x64-setup.exe`,
      `天将漫创-${VERSION}-win-x64-setup.exe.blockmap`,
    ],
    metadataFile: "latest.yml",
    metadataBinaries: [`天将漫创-${VERSION}-win-x64-setup.exe`],
    primaryArtifact: `天将漫创-${VERSION}-win-x64-setup.exe`,
  },
  ...(["x64", "arm64"] as const).map((arch): TargetFixture => ({
    targetId: `macos-${arch}`,
    artifacts: [
      `天将漫创-${VERSION}-mac-${arch}.dmg`,
      `天将漫创-${VERSION}-mac-${arch}.zip`,
      `天将漫创-${VERSION}-mac-${arch}.zip.blockmap`,
    ],
    metadataFile: "latest-mac.yml",
    metadataBinaries: [
      `天将漫创-${VERSION}-mac-${arch}.dmg`,
      `天将漫创-${VERSION}-mac-${arch}.zip`,
    ],
    primaryArtifact: `天将漫创-${VERSION}-mac-${arch}.zip`,
  })),
  ...(["x64", "arm64"] as const).map((arch): TargetFixture => ({
    targetId: `linux-${arch}`,
    artifacts: [
      `天将漫创-${VERSION}-linux-${arch}.AppImage`,
      `天将漫创-${VERSION}-linux-${arch}.AppImage.blockmap`,
    ],
    metadataFile: "latest-linux.yml",
    metadataBinaries: [`天将漫创-${VERSION}-linux-${arch}.AppImage`],
    primaryArtifact: `天将漫创-${VERSION}-linux-${arch}.AppImage`,
  })),
];

function sha512Base64(content: Buffer): string {
  return createHash("sha512").update(content).digest("base64");
}

function createReleaseFixture(spec: TargetFixture): string {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, "unsigned-release-builder-"));
  const binaryEvidence = new Map<string, { sha512: string; size: number }>();
  for (const [index, name] of spec.artifacts.entries()) {
    const content = Buffer.from(`${spec.targetId}:${index}:${name}\n`, "utf8");
    fs.writeFileSync(path.join(root, name), content);
    if (spec.metadataBinaries.includes(name)) {
      binaryEvidence.set(name, {
        sha512: sha512Base64(content),
        size: content.length,
      });
    }
  }
  const primary = binaryEvidence.get(spec.primaryArtifact);
  assert.ok(primary);
  // 手工生成 metadata，避免测试用被测实现反推期望值。
  const metadata = [
    `version: ${VERSION}`,
    "files:",
    ...spec.metadataBinaries.flatMap((name) => {
      const evidence = binaryEvidence.get(name);
      assert.ok(evidence);
      return [
        `  - url: ${name}`,
        `    sha512: ${evidence.sha512}`,
        `    size: ${evidence.size}`,
      ];
    }),
    `path: ${spec.primaryArtifact}`,
    `sha512: ${primary.sha512}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(root, spec.metadataFile), metadata, "utf8");
  return root;
}

function withReleaseFixture(spec: TargetFixture, action: (root: string) => void): void {
  const root = createReleaseFixture(spec);
  try {
    action(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeScannedFixtureWithRetry(target: string, content: string): void {
  const retryableCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    try {
      fs.writeFileSync(target, content);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code ?? "")
        : "";
      if (!retryableCodes.has(code) || attempt === 20) throw error;
      // Windows 实时扫描器可能短暂锁住刚写出的假 EXE；只在测试夹具内有界等待。
      Atomics.wait(waitState, 0, 0, 100);
    }
  }
}

test("electron-builder 三平台配置必须固定原生 metadata 文件名并保持未签名", () => {
  const evidence = assertUnsignedBuilderContract({
    builderConfig: fs.readFileSync("electron-builder.yml", "utf8"),
    environment: {},
    targetId: "windows-x64",
  });
  assert.deepEqual(evidence, {
    detectUpdateChannel: false,
    windowsForceCodeSigning: false,
    windowsResourceEditing: true,
    macIdentity: null,
    macHardenedRuntime: false,
    macNotarizationConfigured: false,
  });
});

test("未签名发布合同拒绝缺失、启用或字符串伪装的 detectUpdateChannel", () => {
  for (const builderConfig of [
    "win:\n  forceCodeSigning: false\nmac:\n  identity: null\n",
    "detectUpdateChannel: true\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\n",
    "detectUpdateChannel: \"false\"\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\n",
  ]) {
    assert.throws(
      () => assertUnsignedBuilderContract({
        builderConfig,
        environment: {},
        targetId: "windows-x64",
      }),
      /未签名发布合同.*detectUpdateChannel.*false/,
    );
  }
});

const PLATFORM_UPDATE_CHANNEL_OVERRIDE_FIXTURES = [
  {
    name: "win 布尔 true",
    targetId: "windows-x64",
    environment: {},
    builderConfig: "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\n  detectUpdateChannel: true\nmac:\n  identity: null\n",
  },
  {
    name: "win 字符串 false",
    targetId: "windows-x64",
    environment: {},
    builderConfig: "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\n  detectUpdateChannel: \"false\"\nmac:\n  identity: null\n",
  },
  {
    name: "mac 布尔 true",
    targetId: "macos-x64",
    environment: { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    builderConfig: "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\n  detectUpdateChannel: true\n",
  },
  {
    name: "mac 字符串 false",
    targetId: "macos-x64",
    environment: { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    builderConfig: "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\n  detectUpdateChannel: \"false\"\n",
  },
  {
    name: "linux 布尔 true",
    targetId: "linux-x64",
    environment: {},
    builderConfig: "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\nlinux:\n  detectUpdateChannel: true\n",
  },
  {
    name: "linux 字符串 false",
    targetId: "linux-x64",
    environment: {},
    builderConfig: "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\nlinux:\n  detectUpdateChannel: \"false\"\n",
  },
] as const;

for (const fixture of PLATFORM_UPDATE_CHANNEL_OVERRIDE_FIXTURES) {
  test(`未签名发布合同拒绝 ${fixture.name} 的平台级 detectUpdateChannel 覆盖`, () => {
    assert.throws(
      () => assertUnsignedBuilderContract({
        builderConfig: fixture.builderConfig,
        environment: fixture.environment,
        targetId: fixture.targetId,
      }),
      /未签名发布合同.*detectUpdateChannel.*布尔值 false/,
    );
  });
}

test("平台级 detectUpdateChannel 如存在也允许显式布尔 false", () => {
  for (const builderConfig of [
    "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\n  detectUpdateChannel: false\nmac:\n  identity: null\n",
    "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\n  detectUpdateChannel: false\n",
    "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\nlinux:\n  detectUpdateChannel: false\n",
  ]) {
    assert.doesNotThrow(() => assertUnsignedBuilderContract({
      builderConfig,
      environment: {},
      targetId: "windows-x64",
    }));
  }
});

test("未签名发布合同拒绝 Windows 强制签名、Developer ID、hardened runtime 与公证钩子", () => {
  for (const builderConfig of [
    "detectUpdateChannel: false\nwin:\n  forceCodeSigning: true\nmac:\n  identity: null\n",
    "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: Developer ID Application: Example\n",
    "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\n  hardenedRuntime: true\n",
    "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\nafterSign: ./scripts/notarize.mjs\n",
  ]) {
    assert.throws(
      () => assertUnsignedBuilderContract({
        builderConfig,
        environment: {},
        targetId: "windows-x64",
      }),
      /未签名发布合同/,
    );
  }
});

test("Windows 证书环境变量按大小写不敏感规则失败关闭", () => {
  for (const name of [
    "CSC_LINK",
    "csc_link",
    "cSc_KeY_pAsSwOrD",
    "WIN_CSC_LINK",
    "win_csc_key_password",
  ]) {
    assert.throws(
      () => assertUnsignedBuilderContract({
        builderConfig: "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\n",
        environment: { [name]: "fixture" },
        targetId: "windows-x64",
      }),
      /未签名发布合同.*证书环境/,
    );
  }
});

test("身份发现规则仅对 macOS 目标生效且环境名大小写不敏感", () => {
  const contract = "detectUpdateChannel: false\nwin:\n  forceCodeSigning: false\nmac:\n  identity: null\n";
  assert.doesNotThrow(() => assertUnsignedBuilderContract({
    builderConfig: contract,
    environment: {},
    targetId: "windows-x64",
  }));
  assert.doesNotThrow(() => assertUnsignedBuilderContract({
    builderConfig: contract,
    environment: {},
    targetId: "linux-arm64",
  }));
  for (const [targetId, environment] of [
    ["windows-x64", { csc_identity_auto_discovery: "true" }],
    ["linux-arm64", { cSc_IdEnTiTy_AuTo_DiScOvErY: "true" }],
  ] as const) {
    assert.throws(
      () => assertUnsignedBuilderContract({
        builderConfig: contract,
        environment,
        targetId,
      }),
      /未签名发布合同.*身份发现/,
    );
  }
  assert.doesNotThrow(() => assertUnsignedBuilderContract({
    builderConfig: contract,
    environment: { csc_identity_auto_discovery: "false" },
    targetId: "macos-arm64",
  }));
  for (const environment of [
    {},
    { CSC_IDENTITY_AUTO_DISCOVERY: "true" },
    { cSc_IdEnTiTy_AuTo_DiScOvErY: "true" },
  ]) {
    assert.throws(
      () => assertUnsignedBuilderContract({
        builderConfig: contract,
        environment,
        targetId: "macos-x64",
      }),
      /未签名发布合同.*身份发现/,
    );
  }
});

test("五种原生目标只允许匹配的 Runner 平台和架构", () => {
  for (const [targetId, hostPlatform, hostArch, builderPlatform] of [
    ["windows-x64", "win32", "x64", "win"],
    ["macos-x64", "darwin", "x64", "mac"],
    ["macos-arm64", "darwin", "arm64", "mac"],
    ["linux-x64", "linux", "x64", "linux"],
    ["linux-arm64", "linux", "arm64", "linux"],
  ] as const) {
    assert.deepEqual(
      parsePackageTarget(["--installer", "--target", targetId], hostPlatform, hostArch),
      { targetId, builderPlatform, arch: hostArch, installer: true },
    );
  }
  assert.throws(
    () => parsePackageTarget(["--installer", "--target", "macos-x64"], "win32", "x64"),
    /本机平台|Runner/,
  );
  assert.throws(
    () => parsePackageTarget(["--installer", "--target", "linux-arm64"], "linux", "x64"),
    /本机架构|Runner/,
  );
});

test("Yarn 命令按 Runner 平台解析且不依赖改写全局平台", () => {
  // 显式注入平台，避免改写只读的 process.platform 造成脆弱测试。
  for (const [platform, expectedCommand] of [
    ["win32", "yarn.cmd"],
    ["darwin", "yarn"],
    ["linux", "yarn"],
  ] as const) {
    assert.equal(resolveYarnCommand(platform), expectedCommand);
  }
});

function createWindowsBatchArgumentFixture(): {
  root: string;
  receiverPath: string;
  commandPath: string;
  spacedCommandPath: string;
} {
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, "windows-batch-arguments-"));
  const receiverPath = path.join(root, "receive-arguments.mjs");
  const commandPath = path.join(root, "forward.cmd");
  const spacedDirectory = path.join(root, "目录 含空格");
  const spacedCommandPath = path.join(spacedDirectory, "forward.cmd");
  fs.mkdirSync(spacedDirectory, { recursive: true });
  fs.writeFileSync(
    receiverPath,
    [
      'import fs from "node:fs";',
      "const [outputPath, ...received] = process.argv.slice(2);",
      'fs.writeFileSync(outputPath, JSON.stringify(received), "utf8");',
      "",
    ].join("\n"),
    "utf8",
  );
  const batchSource = [
    "@echo off",
    // 批处理只负责把五个受控参数逐项转发给 Node 接收器。
    '"%~1" "%~2" "%~3" "%~4" "%~5"',
    "",
  ].join("\r\n");
  fs.writeFileSync(commandPath, batchSource, "utf8");
  fs.writeFileSync(spacedCommandPath, batchSource, "utf8");
  return { root, receiverPath, commandPath, spacedCommandPath };
}

test(
  "Windows 批处理命令路径含空格时仍逐字接收参数",
  { skip: process.platform !== "win32" },
  () => {
    const fixture = createWindowsBatchArgumentFixture();
    const outputPath = path.join(fixture.root, "spaced-command-arguments.json");
    try {
      runCommand("空格路径合同", fixture.root, fixture.spacedCommandPath, [
        process.execPath,
        fixture.receiverPath,
        outputPath,
        "参数 含空格",
        "末尾参数",
      ]);
      assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), [
        "参数 含空格",
        "末尾参数",
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows 批处理参数中的 cmd 元字符不得被解释",
  { skip: process.platform !== "win32" },
  () => {
    const fixture = createWindowsBatchArgumentFixture();
    const outputPath = path.join(fixture.root, "metachar-arguments.json");
    try {
      runCommand("元字符合同", fixture.root, fixture.commandPath, [
        process.execPath,
        fixture.receiverPath,
        outputPath,
        "literal&pipe|value",
        "安全尾参",
      ]);
      assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), [
        "literal&pipe|value",
        "安全尾参",
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows 批处理命令中的百分号变量必须在启动前失败关闭",
  { skip: process.platform !== "win32" },
  () => {
    const fixture = createWindowsBatchArgumentFixture();
    const outputPath = path.join(fixture.root, "percent-command-arguments.json");
    const environmentName = "TJ_BATCH_COMMAND";
    const previousValue = process.env[environmentName];
    process.env[environmentName] = fixture.root;
    let rejection: unknown;
    try {
      try {
        runCommand(
          "命令百分号合同",
          fixture.root,
          `%${environmentName}%\\forward.cmd`,
          [
            process.execPath,
            fixture.receiverPath,
            outputPath,
            "不得启动",
            "安全尾参",
          ],
        );
      } catch (error) {
        rejection = error;
      }
      assert.equal(fs.existsSync(outputPath), false, "百分号命令不得展开后启动接收器");
      assert.match(String(rejection), /百分号|%/);
    } finally {
      if (previousValue === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previousValue;
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "Windows 批处理参数中的百分号变量必须在注入前失败关闭",
  { skip: process.platform !== "win32" },
  () => {
    const fixture = createWindowsBatchArgumentFixture();
    const outputPath = path.join(fixture.root, "percent-argument-arguments.json");
    const injectionMarker = path.join(fixture.root, "percent-injection-marker.txt");
    const environmentName = "TJ_BATCH_PROBE";
    const previousValue = process.env[environmentName];
    // 当前漏洞会先展开变量，再把闭合引号后的 echo 当成额外命令执行。
    process.env[environmentName] = `literal" & echo INJECTION_PROBE>"${injectionMarker}" & echo "`;
    let rejection: unknown;
    try {
      try {
        runCommand("参数百分号合同", fixture.root, fixture.commandPath, [
          process.execPath,
          fixture.receiverPath,
          outputPath,
          `%${environmentName}%`,
          "安全尾参",
        ]);
      } catch (error) {
        rejection = error;
      }
      assert.equal(fs.existsSync(injectionMarker), false, "百分号参数不得执行注入命令");
      assert.equal(fs.existsSync(outputPath), false, "百分号参数不得启动接收器");
      assert.match(String(rejection), /百分号|%/);
    } finally {
      if (previousValue === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previousValue;
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test("Linux 核验使用 electron-builder 按 npm name 生成的内部可执行名", async () => {
  // 动态读取新增导出，让 RED 明确落在生产布局解析函数尚未提供。
  // @ts-expect-error 原生 ESM 构建脚本不单独生成类型声明。
  const packageModule = await import("../../scripts/package-electron.mjs") as any;
  assert.equal(typeof packageModule.resolveNativePackageLayout, "function");
  for (const arch of ["x64", "arm64"]) {
    const electronOutput = path.join(fixtureParent, `linux-${arch}-layout`, "dist");
    assert.deepEqual(packageModule.resolveNativePackageLayout(`linux-${arch}`, electronOutput), {
      packageRoot: path.join(
        electronOutput,
        arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`,
      ),
      resourcesRelativePath: "resources",
      // electron-builder 的 LinuxPackager 默认使用 package.json 的 name，而非 productName。
      executableRelativePath: "tianjiang",
    });
  }
});

test("五种发布目标逐文件校验版本、架构、metadata、SHA-512 与大小", () => {
  for (const spec of TARGET_FIXTURES) {
    withReleaseFixture(spec, (root) => {
      const evidence = verifyReleaseTarget({
        targetId: spec.targetId,
        outputDirectory: root,
        version: VERSION,
      });
      assert.equal(evidence.targetId, spec.targetId);
      assert.equal(evidence.version, VERSION);
      assert.deepEqual(evidence.artifacts, [...spec.artifacts, spec.metadataFile]);
      assert.equal(evidence.metadataFile, spec.metadataFile);
      assert.equal(evidence.verifiedSha512Count, spec.metadataBinaries.length);
    });
  }
});

test("发布目标硬门拒绝缺失、额外同类产物、空文件和跨目录 metadata", () => {
  const spec = TARGET_FIXTURES[0];
  withReleaseFixture(spec, (root) => {
    fs.rmSync(path.join(root, spec.primaryArtifact));
    assert.throws(
      () => verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }),
      /缺失|不存在/,
    );
  });
  withReleaseFixture(spec, (root) => {
    fs.writeFileSync(path.join(root, `天将漫创-${VERSION}-win-x64-copy.exe`), "extra");
    assert.throws(
      () => verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }),
      /额外|集合/,
    );
  });
  withReleaseFixture(spec, (root) => {
    writeScannedFixtureWithRetry(path.join(root, spec.primaryArtifact), "");
    assert.throws(
      () => verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }),
      /空文件/,
    );
  });
  withReleaseFixture(spec, (root) => {
    const metadataPath = path.join(root, spec.metadataFile);
    fs.writeFileSync(
      metadataPath,
      fs.readFileSync(metadataPath, "utf8").replace(
        `url: ${spec.primaryArtifact}`,
        `url: ../${spec.primaryArtifact}`,
      ),
      "utf8",
    );
    assert.throws(
      () => verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }),
      /跨目录|相对路径|越界/,
    );
  });
});

test("发布目标硬门拒绝符号链接产物", () => {
  const spec = TARGET_FIXTURES[0];
  withReleaseFixture(spec, (root) => {
    const target = path.join(root, spec.primaryArtifact);
    const source = path.join(root, "symlink-source");
    fs.mkdirSync(source);
    fs.rmSync(target);
    // Windows junction 无需管理员权限，lstat 仍会把它识别为符号链接。
    fs.symlinkSync(source, target, "junction");
    assert.throws(
      () => verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }),
      /符号链接/,
    );
  });
});

test("Linux arm64 归一化真实 metadata 文件名后必须重新通过完整验证", async () => {
  const spec = TARGET_FIXTURES.find((candidate) => candidate.targetId === "linux-arm64");
  assert.ok(spec);
  // @ts-expect-error 原生 ESM 发布验证脚本不单独生成类型声明。
  const releaseModule = await import("../../scripts/verify-release-target.mjs") as any;
  assert.equal(typeof releaseModule.normalizeReleaseTargetArtifacts, "function");
  withReleaseFixture(spec, (root) => {
    const generatedName = "latest-linux-arm64.yml";
    fs.renameSync(path.join(root, spec.metadataFile), path.join(root, generatedName));
    assert.throws(
      () => verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }),
      /缺失|集合/,
    );
    assert.deepEqual(releaseModule.normalizeReleaseTargetArtifacts({
      targetId: spec.targetId,
      outputDirectory: root,
      version: VERSION,
    }), {
      targetId: spec.targetId,
      removedArtifacts: [],
      renamedMetadata: { from: generatedName, to: spec.metadataFile },
    });
    assert.equal(fs.existsSync(path.join(root, generatedName)), false);
    assert.equal(
      verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }).targetId,
      spec.targetId,
    );
  });
});

test("macOS DMG blockmap 只允许清理 builder 生成的精确文件并随后复验", async () => {
  const spec = TARGET_FIXTURES.find((candidate) => candidate.targetId === "macos-x64");
  assert.ok(spec);
  // @ts-expect-error 原生 ESM 发布验证脚本不单独生成类型声明。
  const releaseModule = await import("../../scripts/verify-release-target.mjs") as any;
  assert.equal(typeof releaseModule.normalizeReleaseTargetArtifacts, "function");
  withReleaseFixture(spec, (root) => {
    const dmgBlockmap = `${spec.artifacts[0]}.blockmap`;
    fs.writeFileSync(path.join(root, dmgBlockmap), "builder blockmap", "utf8");
    assert.throws(
      () => verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }),
      /额外|集合/,
    );
    assert.deepEqual(releaseModule.normalizeReleaseTargetArtifacts({
      targetId: spec.targetId,
      outputDirectory: root,
      version: VERSION,
    }), {
      targetId: spec.targetId,
      removedArtifacts: [dmgBlockmap],
      renamedMetadata: null,
    });
    assert.equal(
      verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }).targetId,
      spec.targetId,
    );

    // 非精确名称不得被归一化误删，最终集合门必须继续失败关闭。
    const unexpected = `${spec.artifacts[0]}.copy.blockmap`;
    fs.writeFileSync(path.join(root, unexpected), "unexpected", "utf8");
    releaseModule.normalizeReleaseTargetArtifacts({
      targetId: spec.targetId,
      outputDirectory: root,
      version: VERSION,
    });
    assert.throws(
      () => verifyReleaseTarget({ targetId: spec.targetId, outputDirectory: root, version: VERSION }),
      /额外|集合/,
    );
  });
});

test("yarn pack 必须直接进入可执行的本机 installer 入口", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts.pack, "node scripts/package-electron.mjs --installer");
  assert.equal(parsePackageTarget(["--installer"], "win32", "x64").targetId, "windows-x64");
});
