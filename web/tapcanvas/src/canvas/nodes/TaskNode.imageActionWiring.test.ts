import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function collectCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

describe('TaskNode image action catalog wiring', () => {
  it('图层分离必须加载动作模型目录并把能力解析器传给真实执行入口', () => {
    const taskNodePath = resolve(process.cwd(), 'src/canvas/nodes/TaskNode.tsx')
    const sourceText = readFileSync(taskNodePath, 'utf8')
    const sourceFile = ts.createSourceFile(
      taskNodePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const calls = collectCalls(sourceFile)

    const actionCatalogCall = calls.find((call) => (
      ts.isIdentifier(call.expression)
      && call.expression.text === 'useModelOptionsState'
      && call.arguments[0]?.getText(sourceFile) === "'imageEdit'"
      && call.arguments[1]?.getText(sourceFile).includes('includeActionModels: true')
    ))
    expect(actionCatalogCall, 'TaskNode 必须显式加载动作模型目录').toBeDefined()

    const capabilityResolution = calls.find((call) => (
      ts.isIdentifier(call.expression)
      && call.expression.text === 'resolveCatalogActionModelOption'
      && call.arguments[0]?.getText(sourceFile).includes("requiredActionKey: 'layer_decompose'")
    ))
    expect(capabilityResolution, '图层分离只能使用声明 layer_decompose 能力的模型').toBeDefined()

    const executionCall = calls.find((call) => (
      ts.isIdentifier(call.expression)
      && call.expression.text === 'runImageLayerSplit'
      && call.arguments[0]?.getText(sourceFile).includes('resolveImageLayerModel')
    ))
    expect(executionCall, '真实图层分离执行必须接入能力目录解析器').toBeDefined()
  })
})
