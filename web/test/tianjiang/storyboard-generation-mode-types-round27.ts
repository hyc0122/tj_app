import type { StoryboardGenerationMode } from "../../src/views/storyboardProject/storyboard-workbench-types";

// 中文注释：期望值独立写死，确保 Web 类型边界不会遗漏后端 Dreamina 的任一真实视频模式。
const expectedStoryboardVideoModes = [
  "auto",
  "text2video",
  "image2video",
  "frames2video",
  "multiframe2video",
  "multimodal2video",
] as const satisfies readonly StoryboardGenerationMode[];

void expectedStoryboardVideoModes;
