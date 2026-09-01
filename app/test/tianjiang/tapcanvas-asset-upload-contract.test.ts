import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  resolveTapCanvasAssetType,
  uploadTapCanvasAsset,
} from '../../src/tianjiang/canvas/tapcanvas-asset-upload'
import { projectDirectory } from '../../src/tianjiang/data/paths'
import {
  currentUserStorage,
  runWithProjectStorage,
} from '../../src/tianjiang/runtime/user-storage-context'
import { db, initializeCanvasWorkspace } from '../../src/utils/db'
import getPath from '../../src/utils/getPath'
import { runWithTemporaryAccount } from './helpers/worktree-runtime'

const PROJECT_UUID = '6ed09466-092f-4662-9713-159eb211b75f'

test('TapCanvas 素材上传只接受可校验的图片、视频、音频和文档容器', () => {
  assert.equal(resolveTapCanvasAssetType('image/png', 'scene.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).extension, 'png')
  assert.equal(resolveTapCanvasAssetType('video/mp4', 'shot.mp4', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])).kind, 'video')
  assert.equal(resolveTapCanvasAssetType('application/pdf', 'script.pdf', Buffer.from('%PDF-1.7')).kind, 'document')
  assert.throws(() => resolveTapCanvasAssetType('text/html', 'x.html', Buffer.from('<html>')), /不支持/)
  assert.throws(() => resolveTapCanvasAssetType('application/octet-stream', 'x.exe', Buffer.from('MZ')), /不支持/)
})

test('TapCanvas 适配层必须提供项目级流式素材上传，客户端不得直传外部 OSS', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../../src/routes/tianjiang/tapcanvas-compat.ts'), 'utf8')
  const app = fs.readFileSync(path.resolve(__dirname, '../../src/app.ts'), 'utf8')
  const client = fs.readFileSync(path.resolve(__dirname, '../../../web/tapcanvas/src/api/server.ts'), 'utf8')
  assert.match(route, /router\.post\("\/assets\/upload"/)
  assert.match(route, /uploadTapCanvasAsset/)
  assert.match(app, /req\.path === "\/api\/tianjiang\/tapcanvas\/assets\/upload"[\s\S]*?return next\(\)/)
  assert.match(client, /TAPCANVAS_TIANJIANG_ADAPTER[\s\S]*?assets\/upload/)
})

test('TapCanvas 原始文件流写入项目并建立可同步素材索引', async () => {
  await runWithTemporaryAccount('tapcanvas-streamed-asset-upload', async () => {
    let stage = 'initialize'
    try {
    await initializeCanvasWorkspace(PROJECT_UUID)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const req = Readable.from([png]) as Readable & { headers: Record<string, string> }
    req.headers = {
      'content-type': 'image/png',
      'content-length': String(png.length),
    }
    stage = 'upload'
    const result = await runWithProjectStorage(PROJECT_UUID, () => uploadTapCanvasAsset(req as never, PROJECT_UUID, {
      declaredMime: 'image/png',
      originalName: '场景.png',
      userId: '7601',
      ownerNodeId: '00dd6f8a-e951-4fa8-8817-06d5680d310e',
    }))
    stage = 'query'
    const row = await runWithProjectStorage(PROJECT_UUID, () => db('canvas_assets').where({ asset_uuid: result.id }).first())
    assert.equal(row?.lifecycle_state, 'ready')
    assert.equal(row?.sha256, result.data.sha256)
    assert.equal(result.data.url, `/api/tianjiang/runtime/projects/${PROJECT_UUID}/files/images/${result.id}.png`)
    const context = currentUserStorage()
    assert.ok(context?.segment)
    const absolute = path.join(projectDirectory(getPath(), PROJECT_UUID, context!.segment), ...String(row.relative_path).split('/'))
    assert.deepEqual(fs.readFileSync(absolute), png)
    } catch (error) {
      throw new Error(`TapCanvas 流式素材测试失败阶段: ${stage}; ${JSON.stringify(error)}`, { cause: error })
    }
  })
})
