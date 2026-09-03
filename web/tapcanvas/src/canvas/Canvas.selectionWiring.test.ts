import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function collectCallExpressions(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

function findVariableDeclaration(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  let match: ts.VariableDeclaration | undefined
  const visit = (node: ts.Node) => {
    if (
      !match
      && ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name
    ) {
      match = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return match
}

describe('Canvas confirmed node selection wiring', () => {
  it('真实 Canvas 点击处理器必须接入先固化选中态再发布焦点的契约', () => {
    const canvasPath = resolve(process.cwd(), 'src/canvas/Canvas.tsx')
    const sourceText = readFileSync(canvasPath, 'utf8')
    const sourceFile = ts.createSourceFile(
      canvasPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )

    const onNodeClickDeclaration = findVariableDeclaration(sourceFile, 'onNodeClick')
    expect(onNodeClickDeclaration, 'Canvas.tsx 必须声明 onNodeClick').toBeDefined()

    const calls = onNodeClickDeclaration
      ? collectCallExpressions(onNodeClickDeclaration)
      : []
    const contractCall = calls.find((call) => (
      ts.isIdentifier(call.expression)
      && call.expression.text === 'commitConfirmedNodeSelectionAndFocus'
    ))
    expect(contractCall, '删除真实 Canvas 点击接线时本测试必须失败').toBeDefined()

    const input = contractCall?.arguments[0]
    expect(input && ts.isObjectLiteralExpression(input)).toBe(true)
    if (!input || !ts.isObjectLiteralExpression(input)) return

    const propertyNames = new Set(input.properties.flatMap((property) => {
      if (!('name' in property) || !property.name) return []
      return [property.name.getText(sourceFile)]
    }))
    expect([...propertyNames]).toEqual(expect.arrayContaining([
      'clickedNodeId',
      'clickedNodeType',
      'hasSelectionModifier',
      'flushPendingSelection',
      'readSoleSelectedNodeId',
      'setFocusedNodeId',
      'setFocusRequestedNodeId',
    ]))
  })
})
