import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { withCanvasGenerationContext } from './generationAssetContext'

describe('天将画布生成上下文', () => {
  it('运行器必须把当前项目和当前节点写入收费任务上下文', () => {
    const request = withCanvasGenerationContext({
      kind: 'text_to_image',
      prompt: '测试',
      extras: { modelKey: 'jiasu:seedream-4' },
    }, {
      currentProject: { id: '1fd5b137-a845-4f03-842d-7706cbeb9431' },
      currentChapter: null,
      currentFlow: {
        id: 'flow-1',
        source: 'server',
        ownerType: 'project',
        ownerId: '1fd5b137-a845-4f03-842d-7706cbeb9431',
      },
    }, 'node-image-1')

    expect(request.extras?.generationContext).toEqual({
      projectId: '1fd5b137-a845-4f03-842d-7706cbeb9431',
      flowId: 'flow-1',
      nodeId: 'node-image-1',
    })
  })

  it('远程运行器必须把当前 ctx.id 传给上下文构造器', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/runner/remoteRunner.ts'), 'utf8')
    expect(source).toContain('runTaskByVendor(options.vendor, options.request, ctx.id)')
  })
})
