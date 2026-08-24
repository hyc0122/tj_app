import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { listenHttpServer } from "../../src/tianjiang/runtime/http-listener";

const workspaceRoot = path.resolve(__dirname, "../../..");
const runtimeSourcePaths = [
  "app/src/tianjiang/runtime/http-listener.ts",
  "app/src/app.ts",
  "app/scripts/main.ts",
  "app/src/utils/oss.ts",
  "web/src/bootstrap/runtime-connection.ts",
  "web/src/stores/setting.ts",
  "web/src/utils/useSocket.ts",
  "web/src/components/setting/components/requestConfig.vue",
  "scripts/electron-smoke-probe.mjs",
  "web/vite.config.ts",
] as const;

interface LoopbackSourceContract {
  file: typeof runtimeSourcePaths[number];
  expected: ReadonlyArray<{ fragment: string; count: number }>;
  patterns?: ReadonlyArray<{ label: string; value: RegExp }>;
}

const loopbackSourceContracts: readonly LoopbackSourceContract[] = [
  {
    file: "app/src/tianjiang/runtime/http-listener.ts",
    expected: [{ fragment: 'server.listen(port, "127.0.0.1")', count: 1 }],
  },
  {
    file: "app/src/app.ts",
    expected: [{
      fragment: "[服务启动成功]: http://127.0.0.1:${realPort}",
      count: 1,
    }],
  },
  {
    file: "app/scripts/main.ts",
    expected: [
      { fragment: 'void win.loadURL("http://127.0.0.1:50188")', count: 1 },
      { fragment: "url: `http://127.0.0.1:${port}/api`,", count: 1 },
    ],
  },
  {
    file: "app/src/utils/oss.ts",
    expected: [
      { fragment: "url = `http://127.0.0.1:10588/${prefix}/`", count: 1 },
      {
        fragment: "url = `http://127.0.0.1:${process.env.PORT}/${prefix}/`",
        count: 1,
      },
    ],
  },
  {
    file: "web/src/bootstrap/runtime-connection.ts",
    expected: [
      {
        fragment: "const match = /^http:\\/\\/127\\.0\\.0\\.1:([1-9]\\d{0,4})\\/api\\/?$/.exec(value);",
        count: 1,
      },
      { fragment: 'parsed.hostname === "127.0.0.1"', count: 1 },
    ],
  },
  {
    file: "web/src/stores/setting.ts",
    expected: [{
      fragment: 'const baseUrl = ref<string>("http://127.0.0.1:10588/api");',
      count: 1,
    }],
  },
  {
    file: "web/src/utils/useSocket.ts",
    expected: [{
      fragment: 'url = "http://127.0.0.1:10588"',
      count: 1,
    }],
  },
  {
    file: "web/src/components/setting/components/requestConfig.vue",
    expected: [{
      fragment: 'formData.value.baseUrl = "http://127.0.0.1:10588"',
      count: 1,
    }],
  },
  {
    file: "scripts/electron-smoke-probe.mjs",
    expected: [
      {
        fragment: "fetch(`http://127.0.0.1:${port}/json/list`)",
        count: 1,
      },
      {
        fragment: "const serviceUrlMatch = /^http:\\/\\/127\\.0\\.0\\.1:([1-9]\\d{0,4})\\/api$/.exec(",
        count: 1,
      },
    ],
  },
  {
    file: "web/vite.config.ts",
    expected: [
      { fragment: 'host: "127.0.0.1"', count: 2 },
      { fragment: "port: 50188", count: 1 },
    ],
    patterns: [
      {
        label: "server-host-port",
        value: /server:\s*\{[^}]*host:\s*["']127\.0\.0\.1["'][^}]*port:\s*50188/,
      },
      {
        label: "preview-host",
        value: /preview:\s*\{[^}]*host:\s*["']127\.0\.0\.1["']/,
      },
    ],
  },
] as const;

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("HTTP 服务监听成功时返回系统分配的真实端口", async () => {
  const server = http.createServer();
  try {
    const port = await listenHttpServer(server, 0);
    assert.ok(Number.isInteger(port) && port > 0);
    assert.deepEqual(server.address(), {
      address: "127.0.0.1",
      family: "IPv4",
      port,
    });
  } finally {
    if (server.listening) await closeServer(server);
  }
});

test("本地 runtime、握手、OSS 和 Socket URL 统一使用 127.0.0.1", () => {
  const sources = readRuntimeSources();
  assert.deepEqual(validateLoopbackContract(sources), []);

  const mutations = [
    {
      name: "HTTP listener 改为全网卡",
      file: "app/src/tianjiang/runtime/http-listener.ts",
      from: 'server.listen(port, "127.0.0.1")',
      to: 'server.listen(port, "0.0.0.0")',
    },
    {
      name: "App 启动日志改为 IPv6 环回",
      file: "app/src/app.ts",
      from: "http://127.0.0.1:${realPort}",
      to: "http://[::1]:${realPort}",
    },
    {
      name: "Electron Vite 开发端口错误",
      file: "app/scripts/main.ts",
      from: 'http://127.0.0.1:50188"',
      to: 'http://127.0.0.1:50189"',
    },
    {
      name: "Electron runtime 握手路径错误",
      file: "app/scripts/main.ts",
      from: "http://127.0.0.1:${port}/api",
      to: "http://127.0.0.1:${port}/wrong",
    },
    {
      name: "OSS 开发端口错误",
      file: "app/src/utils/oss.ts",
      from: "http://127.0.0.1:10588/${prefix}/",
      to: "http://127.0.0.1:10589/${prefix}/",
    },
    {
      name: "OSS Electron 主机改为全网卡",
      file: "app/src/utils/oss.ts",
      from: "http://127.0.0.1:${process.env.PORT}/${prefix}/",
      to: "http://0.0.0.0:${process.env.PORT}/${prefix}/",
    },
    {
      name: "Web bootstrap hostname 改为全网卡",
      file: "web/src/bootstrap/runtime-connection.ts",
      from: 'parsed.hostname === "127.0.0.1"',
      to: 'parsed.hostname === "0.0.0.0"',
    },
    {
      name: "Store 默认 API 端口错误",
      file: "web/src/stores/setting.ts",
      from: "http://127.0.0.1:10588/api",
      to: "http://127.0.0.1:10589/api",
    },
    {
      name: "Socket 默认端口错误",
      file: "web/src/utils/useSocket.ts",
      from: "http://127.0.0.1:10588",
      to: "http://127.0.0.1:10589",
    },
    {
      name: "RequestConfig 重置端口错误",
      file: "web/src/components/setting/components/requestConfig.vue",
      from: 'formData.value.baseUrl = "http://127.0.0.1:10588"',
      to: 'formData.value.baseUrl = "http://127.0.0.1:10589"',
    },
    {
      name: "Vite host 改为全网卡",
      file: "web/vite.config.ts",
      from: 'host: "127.0.0.1"',
      to: 'host: "0.0.0.0"',
    },
    {
      name: "Electron smoke CDP 路径错误",
      file: "scripts/electron-smoke-probe.mjs",
      from: "http://127.0.0.1:${port}/json/list",
      to: "http://127.0.0.1:${port}/json/wrong",
    },
  ] as const;

  for (const mutation of mutations) {
    const original = sources.get(mutation.file) ?? "";
    const mutated = original.replace(mutation.from, mutation.to);
    assert.notEqual(mutated, original, `${mutation.name}：变异夹具必须命中真实源码`);
    const mutatedSources = new Map(sources);
    mutatedSources.set(mutation.file, mutated);
    assert.notDeepEqual(
      validateLoopbackContract(mutatedSources),
      [],
      `${mutation.name}：静态门禁必须拒绝该变异`,
    );
  }
});

test("HTTP 端口监听失败必须 reject，交给 Electron 主进程显示诊断页", async () => {
  const blocker = http.createServer();
  const occupiedPort = await listenHttpServer(blocker, 0);
  const candidate = http.createServer();
  try {
    await assert.rejects(
      listenHttpServer(candidate, occupiedPort),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
  } finally {
    if (candidate.listening) await closeServer(candidate);
    await closeServer(blocker);
  }
});

function readRuntimeSources(): Map<string, string> {
  return new Map(runtimeSourcePaths.map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8"),
  ]));
}

function validateLoopbackContract(sources: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const contract of loopbackSourceContracts) {
    const source = sources.get(contract.file);
    if (source === undefined) {
      violations.push(`${contract.file}:missing-source`);
      continue;
    }
    for (const expectation of contract.expected) {
      const actualCount = source.split(expectation.fragment).length - 1;
      if (actualCount !== expectation.count) {
        violations.push(
          `${contract.file}:${expectation.fragment}:${actualCount}/${expectation.count}`,
        );
      }
    }
    for (const expectation of contract.patterns ?? []) {
      if (!expectation.value.test(source)) {
        violations.push(`${contract.file}:${expectation.label}`);
      }
    }
    if (/localhost|0\.0\.0\.0|\[?::1\]?/i.test(source)) {
      violations.push(`${contract.file}:forbidden-host`);
    }
  }
  return violations;
}
