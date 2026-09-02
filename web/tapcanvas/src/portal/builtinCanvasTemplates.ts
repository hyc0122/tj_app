import type { Edge, Node } from '@xyflow/react'
import type { ConfiguredCanvasTemplate } from './CanvasHubTemplateRail'
import uploadNovelCover from './assets/builtin-templates/upload-novel.jpg'
import storyboardFilmCover from './assets/builtin-templates/storyboard-film.jpg'
import sentenceImageCover from './assets/builtin-templates/sentence-image.jpg'
import firstFrameVideoCover from './assets/builtin-templates/first-frame-video.jpg'
import directorConsoleCover from './assets/builtin-templates/director-console.jpg'
import aiExecutionCover from './assets/builtin-templates/ai-execution.jpg'

export const BUILTIN_CANVAS_TEMPLATE_IDS = [
  'builtin-canvas:upload-novel',
  'builtin-canvas:storyboard-film',
  'builtin-canvas:sentence-image',
  'builtin-canvas:first-frame-video',
  'builtin-canvas:director-console',
  'builtin-canvas:ai-execution',
] as const

export type BuiltinCanvasTemplateId = (typeof BUILTIN_CANVAS_TEMPLATE_IDS)[number]

export type BuiltinCanvasGraph = {
  nodes: Node[]
  edges: Edge[]
}

export type BuiltinCanvasTemplate = ConfiguredCanvasTemplate & {
  id: BuiltinCanvasTemplateId
  graph: BuiltinCanvasGraph
}

const now = '2026-09-02T00:00:00.000Z'

function taskNode(
  id: string,
  x: number,
  y: number,
  kind: string,
  label: string,
  extra: Record<string, unknown> = {},
): Node {
  return {
    id,
    type: 'taskNode',
    position: { x, y },
    data: {
      label,
      kind,
      nodeWidth: 340,
      ...extra,
    },
  }
}

function typedEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    type: 'typed',
    animated: true,
  }
}

const TEMPLATES: BuiltinCanvasTemplate[] = [
  {
    id: 'builtin-canvas:upload-novel',
    name: '上传小说',
    templateTitle: '上传小说',
    templateDescription: '导入原文后拆章，再接到分镜节点。',
    templateCoverUrl: uploadNovelCover,
    createdAt: now,
    updatedAt: now,
    access: 'owner',
    teamShared: false,
    graph: {
      nodes: [
        taskNode('tpl-novel-source', 80, 140, 'text', '小说原文', {
          prompt: '把整本小说粘贴到这里，或稍后用资产面板导入。按现有章节顺序保留标题。',
        }),
        taskNode('tpl-novel-chapter', 480, 120, 'text', '章节拆分', {
          prompt: '按原文顺序整理章节标题、起止位置和正文边界，不要改写内容。',
        }),
        taskNode('tpl-novel-board', 880, 120, 'storyboard', '章节分镜', {
          prompt: '根据当前章生成连续镜头，保持人物与场景连续。',
        }),
      ],
      edges: [
        typedEdge('tpl-novel-e1', 'tpl-novel-source', 'tpl-novel-chapter'),
        typedEdge('tpl-novel-e2', 'tpl-novel-chapter', 'tpl-novel-board'),
      ],
    },
  },
  {
    id: 'builtin-canvas:storyboard-film',
    name: '故事板成片',
    templateTitle: '故事板成片',
    templateDescription: '从故事到场景卡再到分镜成片。',
    templateCoverUrl: storyboardFilmCover,
    createdAt: now,
    updatedAt: now,
    access: 'owner',
    teamShared: false,
    graph: {
      nodes: [
        taskNode('tpl-film-story', 80, 120, 'text', '故事梗概', {
          prompt: '三句故事：开场、转折、收束。保持同一主角和同一场景。',
        }),
        taskNode('tpl-film-scene', 480, 100, 'image', '场景卡', {
          prompt: '根据故事生成一张稳定的场景定帧，先锁人物、环境和光线。',
          aspectRatio: '16:9',
        }),
        taskNode('tpl-film-board', 880, 90, 'storyboard', '分镜成片', {
          prompt: '把场景卡拆成 3 个连续镜头，说明景别、动作和情绪。',
        }),
        taskNode('tpl-film-video', 1280, 110, 'video', '成片预览', {
          prompt: '按分镜顺序做一段 5 秒预览，只允许轻微推镜。',
          videoDurationSeconds: 5,
          videoOrientation: 'landscape',
        }),
      ],
      edges: [
        typedEdge('tpl-film-e1', 'tpl-film-story', 'tpl-film-scene'),
        typedEdge('tpl-film-e2', 'tpl-film-scene', 'tpl-film-board'),
        typedEdge('tpl-film-e3', 'tpl-film-board', 'tpl-film-video'),
      ],
    },
  },
  {
    id: 'builtin-canvas:sentence-image',
    name: '一句话出图',
    templateTitle: '一句话出图',
    templateDescription: '一句话描述直接生成参考图。',
    templateCoverUrl: sentenceImageCover,
    createdAt: now,
    updatedAt: now,
    access: 'owner',
    teamShared: false,
    graph: {
      nodes: [
        taskNode('tpl-sentence-text', 120, 150, 'text', '场景一句话', {
          prompt: '黄昏海边木栈道，一位穿风衣的女生独自站在路灯下，海风吹起衣摆，电影感，柔和逆光。',
        }),
        taskNode('tpl-sentence-image', 540, 130, 'image', '首张参考图', {
          prompt: '基于输入场景做一张稳定的首张参考图。先锁定人物、环境和整体光线。',
          aspectRatio: '16:9',
        }),
      ],
      edges: [typedEdge('tpl-sentence-e1', 'tpl-sentence-text', 'tpl-sentence-image')],
    },
  },
  {
    id: 'builtin-canvas:first-frame-video',
    name: '首帧转视频',
    templateTitle: '首帧转视频',
    templateDescription: '关键帧接到短视频节点。',
    templateCoverUrl: firstFrameVideoCover,
    createdAt: now,
    updatedAt: now,
    access: 'owner',
    teamShared: false,
    graph: {
      nodes: [
        taskNode('tpl-frame-image', 120, 132, 'image', '关键帧', {
          prompt: '未来感城市天桥夜景，主角站在霓虹灯牌前，雨后地面有反射，构图稳定。',
          aspectRatio: '16:9',
        }),
        taskNode('tpl-frame-video', 556, 124, 'video', '5 秒短视频', {
          prompt: '基于输入关键帧制作一个 5 秒镜头。只允许轻微推镜、角色呼吸和衣摆摆动。',
          videoDurationSeconds: 5,
          videoOrientation: 'landscape',
        }),
      ],
      edges: [typedEdge('tpl-frame-e1', 'tpl-frame-image', 'tpl-frame-video')],
    },
  },
  {
    id: 'builtin-canvas:director-console',
    name: '导演台',
    templateTitle: '导演台',
    templateDescription: '全景参考图接入 3D 导演台。',
    templateCoverUrl: directorConsoleCover,
    createdAt: now,
    updatedAt: now,
    access: 'owner',
    teamShared: false,
    graph: {
      nodes: [
        taskNode('tpl-director-pano', 80, 140, 'image', '全景参考', {
          prompt: '宽银幕片场全景，作为导演台天空盒参考，不要加入复杂动作。',
          aspectRatio: '21:9',
        }),
        {
          id: 'tpl-director-console',
          type: 'directorConsole',
          position: { x: 520, y: 110 },
          data: {
            kind: 'directorConsole',
            label: '导演台',
            scene: {
              characters: [{
                id: 'tpl-director-char-a',
                name: '角色A',
                modelId: 'male',
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                uniformScale: 1,
                colorHex: '#4B8BFF',
              }],
              cameras: [{
                id: 'tpl-director-cam-1',
                name: '机位1',
                position: [2.2, 1.6, 2.4],
                lookAtMode: 'tpl-director-char-a',
                lookAt: [0, 1.4, 0],
                fovDeg: 35,
              }],
              aspect: '16:9',
              activeCameraId: 'tpl-director-cam-1',
            },
            activeViewpoint: 'camera',
            selectedObjectId: 'tpl-director-cam-1',
            status: 'idle',
          },
        },
      ],
      edges: [typedEdge('tpl-director-e1', 'tpl-director-pano', 'tpl-director-console')],
    },
  },
  {
    id: 'builtin-canvas:ai-execution',
    name: 'AI 执行台',
    templateTitle: 'AI 执行台',
    templateDescription: '把任务说明接到可执行的图与视频节点。',
    templateCoverUrl: aiExecutionCover,
    createdAt: now,
    updatedAt: now,
    access: 'owner',
    teamShared: false,
    graph: {
      nodes: [
        taskNode('tpl-exec-brief', 80, 120, 'text', '执行说明', {
          prompt: '当前任务：根据右侧节点只执行已保存的画布事实，不编造供应商进度。',
        }),
        taskNode('tpl-exec-image', 480, 80, 'image', '画面交付', {
          prompt: '按执行说明生成一张可验收的画面，完成后回到 AI 执行台查看记录。',
          aspectRatio: '16:9',
        }),
        taskNode('tpl-exec-video', 480, 280, 'video', '镜头交付', {
          prompt: '若需要运动，把画面交付作为首帧接到 5 秒镜头。',
          videoDurationSeconds: 5,
          videoOrientation: 'landscape',
        }),
      ],
      edges: [
        typedEdge('tpl-exec-e1', 'tpl-exec-brief', 'tpl-exec-image'),
        typedEdge('tpl-exec-e2', 'tpl-exec-image', 'tpl-exec-video'),
      ],
    },
  },
]

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function remapKnownId(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value !== 'string' || !value) return value
  const mapped = idMap.get(value)
  if (mapped) return mapped
  const next = crypto.randomUUID()
  idMap.set(value, next)
  return next
}

function cloneDirectorData(data: Record<string, unknown>, idMap: Map<string, string>): Record<string, unknown> {
  const next = deepClone(data)
  const scene = next.scene && typeof next.scene === 'object' ? next.scene as Record<string, unknown> : null
  if (scene) {
    if (Array.isArray(scene.characters)) {
      scene.characters = scene.characters.map((item) => {
        if (!item || typeof item !== 'object') return item
        const character = item as Record<string, unknown>
        return { ...character, id: remapKnownId(character.id, idMap) }
      })
    }
    if (Array.isArray(scene.cameras)) {
      scene.cameras = scene.cameras.map((item) => {
        if (!item || typeof item !== 'object') return item
        const camera = item as Record<string, unknown>
        return {
          ...camera,
          id: remapKnownId(camera.id, idMap),
          lookAtMode: typeof camera.lookAtMode === 'string' && idMap.has(camera.lookAtMode)
            ? idMap.get(camera.lookAtMode)
            : camera.lookAtMode,
        }
      })
    }
    if (typeof scene.activeCameraId === 'string') {
      scene.activeCameraId = remapKnownId(scene.activeCameraId, idMap)
    }
  }
  if (typeof next.selectedObjectId === 'string') {
    next.selectedObjectId = remapKnownId(next.selectedObjectId, idMap)
  }
  return next
}

export function isBuiltinCanvasTemplateId(id: string): id is BuiltinCanvasTemplateId {
  return (BUILTIN_CANVAS_TEMPLATE_IDS as readonly string[]).includes(id)
}

export function listBuiltinCanvasTemplates(): BuiltinCanvasTemplate[] {
  return TEMPLATES.map((template) => ({
    ...template,
    graph: deepClone(template.graph),
  }))
}

export function getBuiltinCanvasTemplate(id: string): BuiltinCanvasTemplate | null {
  const found = TEMPLATES.find((template) => template.id === id)
  return found ? { ...found, graph: deepClone(found.graph) } : null
}

export function cloneBuiltinCanvasTemplateGraph(template: Pick<BuiltinCanvasTemplate, 'graph'>): BuiltinCanvasGraph {
  const source = deepClone(template.graph)
  const idMap = new Map<string, string>()
  const nodes = source.nodes.map((node) => {
    const nextId = crypto.randomUUID()
    idMap.set(String(node.id), nextId)
    const rawData = (node.data && typeof node.data === 'object') ? node.data as Record<string, unknown> : {}
    const data = node.type === 'directorConsole' ? cloneDirectorData(rawData, idMap) : deepClone(rawData)
    return {
      ...node,
      id: nextId,
      data,
      selected: false,
    }
  })
  const edges = source.edges.map((edge) => {
    const sourceId = idMap.get(String(edge.source)) ?? crypto.randomUUID()
    const targetId = idMap.get(String(edge.target)) ?? crypto.randomUUID()
    idMap.set(String(edge.source), sourceId)
    idMap.set(String(edge.target), targetId)
    return {
      ...edge,
      id: crypto.randomUUID(),
      source: sourceId,
      target: targetId,
      selected: false,
    }
  })
  return { nodes, edges }
}
