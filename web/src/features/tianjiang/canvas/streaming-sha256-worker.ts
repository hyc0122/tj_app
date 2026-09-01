/// <reference lib="webworker" />
import { createSHA256 } from "hash-wasm";

interface HashRequest {
  requestId: string;
  file?: File;
}

/** 中文注释：2GiB 上限只通过 File.stream 分块喂给 hash-wasm，禁止 arrayBuffer 整文件读入。 */
self.onmessage = async (event: MessageEvent<HashRequest>) => {
  const { requestId, file } = event.data;
  if (!file) {
    self.postMessage({ requestId, error: "missing-file" });
    return;
  }
  try {
    const hasher = await createSHA256();
    hasher.init();
    const reader = file.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) hasher.update(value);
      self.postMessage({ requestId, progressBytes: value?.byteLength ?? 0 });
    }
    self.postMessage({ requestId, sha256: hasher.digest("hex") });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : "hash-failed",
    });
  }
};
