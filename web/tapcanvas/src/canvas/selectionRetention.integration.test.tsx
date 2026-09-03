// @vitest-environment jsdom

import React, { useLayoutEffect, useMemo, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ReactFlow,
  ReactFlowProvider,
  type NodeProps,
} from '@xyflow/react'
import { useFocusStore, useIsNodeFocused } from './focusStore'
import { useRFStore } from './store'
import { commitConfirmedNodeSelectionAndFocus } from './utils/accumulateSelectionChanges'
import {
  preserveTransientNodeSelection,
  resolveConfirmedFocusedNodeId,
} from './utils/selectionRetention'

function SelectionProbeNode(props: NodeProps): JSX.Element {
  const focused = useIsNodeFocused(props.id)
  return (
    <div data-testid="selection-probe-node" data-selected={props.selected ? 'true' : 'false'}>
      {focused ? <button type="button">节点下方选项</button> : <span>轻量模块</span>}
    </div>
  )
}

function SelectionHarness(): JSX.Element {
  const nodes = useRFStore((state) => state.nodes)
  const onNodesChange = useRFStore((state) => state.onNodesChange)
  const [focusRequestedNodeId, setFocusRequestedNodeId] = useState<string | null>(null)
  const nodeTypes = useMemo(() => ({ selectionProbe: SelectionProbeNode }), [])
  const focusedNodeId = resolveConfirmedFocusedNodeId({ focusRequestedNodeId, selectedNodes: nodes })

  useLayoutEffect(() => {
    useFocusStore.getState().setFocusedNodeId(focusedNodeId)
  }, [focusedNodeId])

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      selectNodesOnDrag={false}
      onNodeClick={(_event, clickedNode) => {
        commitConfirmedNodeSelectionAndFocus({
          clickedNodeId: clickedNode.id,
          clickedNodeType: clickedNode.type,
          hasSelectionModifier: false,
          flushPendingSelection: () => undefined,
          readSoleSelectedNodeId: () => {
            const selected = useRFStore.getState().nodes.filter((node) => node.selected)
            return selected.length === 1 ? selected[0]?.id ?? null : null
          },
          setFocusedNodeId: (nodeId) => useFocusStore.getState().setFocusedNodeId(nodeId),
          setFocusRequestedNodeId,
        })
      }}
      style={{ width: 800, height: 600 }}
    />
  )
}

describe('React Flow selection retention integration', () => {
  beforeEach(() => {
    useFocusStore.setState({ focusedNodeId: null, allFull: false })
    useRFStore.setState({
      nodes: [{
        id: 'image-1',
        type: 'selectionProbe',
        position: { x: 100, y: 100 },
        data: {},
        selected: false,
      }],
      edges: [],
    })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    } as DOMRect)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('点击模块并发生整图 rebase 回写后，仍保持选中且下方选项可点击', async () => {
    render(
      <ReactFlowProvider>
        <SelectionHarness />
      </ReactFlowProvider>,
    )

    fireEvent.click(await screen.findByTestId('selection-probe-node'))
    await screen.findByText('节点下方选项')

    act(() => {
      const currentNodes = useRFStore.getState().nodes
      const rebasedNodes = currentNodes.map((node) => ({
        ...node,
        data: { ...node.data, hydratedModel: 'provider:live-image' },
        selected: false,
      }))
      useRFStore.setState({
        nodes: preserveTransientNodeSelection(currentNodes, rebasedNodes),
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('selection-probe-node')).toHaveAttribute('data-selected', 'true')
      expect(screen.getByText('节点下方选项')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('节点下方选项'))
    expect(useRFStore.getState().nodes[0]?.selected).toBe(true)
  })
})
