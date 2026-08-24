/**
 * 仅供 Round19 测试：让官方 version.json 失败，同时允许 exe 下载返回极小 PE。
 * 生产刷新脚本会因此把 version 写成 unknown；RED 要求它必须失败且不改清单。
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const HOST = "lf3-static.bytednsdoc.com";
const PREFIX = "/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/";

function peX64() {
  const buf = Buffer.alloc(0x180, 0);
  buf.write("MZ", 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80);
  buf.writeUInt16LE(0x8664, 0x84);
  return buf;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes(`${PREFIX}version.json`)) {
    return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
  }
  if (url.includes(`${PREFIX}dreamina_cli_windows_amd64.exe`)) {
    const bytes = peX64();
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      },
    });
  }
  return originalFetch(input, init);
};

void HOST;
void register;
void pathToFileURL;
