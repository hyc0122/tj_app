export type StoryboardExportFormat = "csv" | "txt";

const EXPORT_FILE_CONTRACT: Record<StoryboardExportFormat, { fileName: string; mimeType: string }> = {
  csv: { fileName: "storyboard-export.csv", mimeType: "text/csv;charset=utf-8" },
  txt: { fileName: "storyboard-export.txt", mimeType: "text/plain;charset=utf-8" },
};

/**
 * 只用前端白名单生成下载属性；服务端响应头、路径和文件名不会进入 DOM。
 */
export function downloadStoryboardExport(content: unknown, format: StoryboardExportFormat): void {
  if (typeof content !== "string") throw new Error("分镜导出响应无效");
  const contract = EXPORT_FILE_CONTRACT[format];
  if (!contract) throw new Error("分镜导出格式无效");

  const objectUrl = URL.createObjectURL(new Blob([content], { type: contract.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = contract.fileName;
  anchor.rel = "noopener";
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }
}
