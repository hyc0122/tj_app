import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import http from "node:http";

import { PACKAGED_LEGAL_DOCUMENTS } from "../../src/tianjiang/legal/default-legal-documents";
import {
  parseLegalDocuments,
  type PublicLegalDocument,
} from "../../src/tianjiang/legal/legal-document-contract";
import {
  LegalDocumentCache,
  legalDocumentCachePath,
} from "../../src/tianjiang/legal/legal-document-cache";
import { LegalDocumentClient } from "../../src/tianjiang/legal/legal-document-client";
import { CENTRAL_API_URL } from "../../src/tianjiang/auth/central-session";
import legalDocumentsRouter from "../../src/routes/tianjiang/public/legal-documents";

const privacyFixture: PublicLegalDocument = {
  documentType: "privacy_policy",
  title: "隐私政策",
  content: "隐私正文",
  version: "v1",
  updatedAt: "2026-08-01T00:00:00Z",
};

test("公开协议只保留冻结字段并剥离敏感键", () => {
  const documents = parseLegalDocuments([
    {
      documentType: "user_agreement",
      title: "用户协议",
      content: "正文",
      version: "v1",
      updatedAt: "2026-08-01T00:00:00Z",
      updatedBy: 888,
      token: "forbidden",
      password: "secret",
    },
    privacyFixture,
  ]);
  assert.deepEqual(Object.keys(documents[0]).sort(), [
    "content",
    "documentType",
    "title",
    "updatedAt",
    "version",
  ]);
  assert.equal("token" in documents[0], false);
  assert.equal("password" in documents[0], false);
  assert.equal("updatedBy" in documents[0], false);
});

test("只接受两种固定类型且恰好各一份", () => {
  assert.throws(
    () => parseLegalDocuments([privacyFixture]),
    /恰好|缺少|无效/,
  );
  assert.throws(
    () => parseLegalDocuments([
      { ...privacyFixture, documentType: "user_agreement" },
      privacyFixture,
      { ...privacyFixture, documentType: "terms" as "privacy_policy" },
    ]),
    /恰好|类型/,
  );
  assert.throws(
    () => parseLegalDocuments([
      {
        documentType: "terms_of_service",
        title: "x",
        content: "y",
        version: "v",
        updatedAt: "2026-08-01T00:00:00Z",
      },
      privacyFixture,
    ]),
    /类型无效/,
  );
});

test("正文 UTF-8 不得超过 64 KiB；默认示例含法务提示且无 TODO", () => {
  const huge = "a".repeat(65_537);
  assert.throws(
    () => parseLegalDocuments([
      {
        documentType: "user_agreement",
        title: "用户协议",
        content: huge,
        version: "v1",
        updatedAt: "2026-08-01T00:00:00Z",
      },
      privacyFixture,
    ]),
    /64 KiB/,
  );

  for (const doc of PACKAGED_LEGAL_DOCUMENTS) {
    const firstLine = doc.content.split(/\r?\n/)[0] ?? "";
    assert.match(firstLine, /此为初始示例内容，正式发布前需完成法务审核/);
    assert.doesNotMatch(doc.content, /\bTODO\b|\bTBD\b/);
    assert.ok(doc.title.includes("初始示例"));
  }
  assert.equal(PACKAGED_LEGAL_DOCUMENTS.length, 2);
  const packagedPrivacy = PACKAGED_LEGAL_DOCUMENTS.find(
    (doc) => doc.documentType === "privacy_policy",
  );
  assert.match(
    packagedPrivacy?.content ?? "",
    /当前用户本地数据中，不在团队间共享，也不得跨账号同步或写入日志/,
  );
});

test("协议同步固定中央主机、ETag、原子缓存与降级", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-legal-"));
  try {
    const cache = new LegalDocumentCache(root);
    const cacheFile = legalDocumentCachePath(root);
    assert.equal(
      path.normalize(path.dirname(cacheFile)),
      path.normalize(path.join(root, "public-cache")),
    );

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let mode: "200" | "304" | "network" | "invalid" = "200";
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      calls.push({ url, headers });
      if (mode === "network") throw new TypeError("fetch failed");
      if (mode === "304") {
        return new Response(null, { status: 304, headers: { etag: '"etag-1"' } });
      }
      if (mode === "invalid") {
        return new Response(JSON.stringify({ code: 0, data: { documents: [] } }), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"bad"' },
        });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: {
          documents: [
            {
              documentType: "user_agreement",
              title: "用户协议",
              content: "网络正文",
              version: "net-1",
              updatedAt: "2026-08-01T01:00:00Z",
              updatedBy: 1,
              token: "nope",
            },
            {
              documentType: "privacy_policy",
              title: "隐私政策",
              content: "网络隐私",
              version: "net-1",
              updatedAt: "2026-08-01T01:00:00Z",
            },
          ],
        },
        msg: "ok",
      }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-1"' },
      });
    };

    const client = new LegalDocumentClient(cache, fetcher);

    // 首次离线：packaged
    mode = "network";
    const offlineFirst = await client.getLatest();
    assert.equal(offlineFirst.source, "packaged");
    assert.equal(offlineFirst.stale, true);
    assert.equal(offlineFirst.documents[0].title, PACKAGED_LEGAL_DOCUMENTS[0].title);

    // 200 写入缓存
    mode = "200";
    const online = await client.getLatest();
    assert.equal(online.source, "network");
    assert.equal(online.stale, false);
    assert.equal(online.documents[0].content, "网络正文");
    assert.ok(fs.existsSync(cacheFile));
    assert.equal(calls.at(-1)?.url, `${CENTRAL_API_URL}/api/tianjiang/v1/public/legal-documents`);
    assert.doesNotMatch(calls.at(-1)?.url ?? "", /attacker|localhost/);

    // 再次请求带 If-None-Match
    mode = "304";
    const notModified = await client.getLatest();
    assert.equal(notModified.source, "cache");
    assert.equal(notModified.stale, false);
    assert.equal(calls.at(-1)?.headers["if-none-match"], '"etag-1"');

    // 网络失败返回缓存 stale
    mode = "network";
    const stale = await client.getLatest();
    assert.equal(stale.source, "cache");
    assert.equal(stale.stale, true);

    // 无效响应不覆盖旧缓存
    const before = fs.readFileSync(cacheFile, "utf8");
    mode = "invalid";
    const invalid = await client.getLatest();
    assert.equal(invalid.source, "cache");
    assert.equal(fs.readFileSync(cacheFile, "utf8"), before);

    // 原子写入：无残留临时文件
    const dir = path.dirname(cacheFile);
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 清理竞态忽略
    }
  }
});

test("renderer 协议代理固定路径且始终返回 source/stale", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tj-legal-route-"));
  const cache = new LegalDocumentCache(root);
  const client = new LegalDocumentClient(cache, async () => {
    throw new TypeError("offline");
  });
  // 注入测试客户端，避免真实出网。
  (legalDocumentsRouter as unknown as { __setClientForTest?: (c: LegalDocumentClient) => void })
    .__setClientForTest?.(client);

  const app = express();
  app.use("/api/tianjiang/public/legal-documents", legalDocumentsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await httpGetJson(port, "/api/tianjiang/public/legal-documents");
    assert.equal(response.status, 200);
    const body = response.body as {
      code: number;
      data: { documents: unknown[]; source: string; stale: boolean };
      message: string;
    };
    assert.equal(body.code, 0);
    assert.equal(body.data.source, "packaged");
    assert.equal(body.data.stale, true);
    assert.equal(body.data.documents.length, 2);
    assert.equal(body.message, "协议内容已就绪");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function httpGetJson(
  port: number,
  pathname: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET" },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : null,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}
