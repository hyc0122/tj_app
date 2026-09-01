/// <reference lib="webworker" />
self.onmessage = (event: MessageEvent<{ requestId: string; nodes: unknown[] }>) => {
  const { requestId, nodes } = event.data;
  self.postMessage({ requestId, nodes });
};
