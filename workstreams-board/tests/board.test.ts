import { expect, mock, test } from 'claude-code/testing'

import { applyOutput, emptyBoard, headsOf, ordered, phaseOf, subcommandOf } from '../hooks/board'

const SCRIPT = 'node "/plugins/workstreams/scripts/workstreams.ts"'

const PANE = {
  component: 'Pane',
  requestId: 'workstreams-board',
  props: {
    title: 'Workstreams round',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('reads the subcommand, heads and phase from what the round runs', async () => {
  expect(subcommandOf(`${SCRIPT} pr-state 302 --json`)).toBe('pr-state')
  expect(subcommandOf('gh pr view 302')).toBe(null)
  expect(headsOf(`${SCRIPT} watch --heads lsp-core,lsp-diag`)).toEqual(['lsp-core', 'lsp-diag'])
  expect(phaseOf({ skill: 'workstreams:review' })).toBe('review')
  expect(phaseOf({ file_path: '/x/plugins/workstreams/skills/start/round-end.md' })).toBe('round-end')
  expect(phaseOf({ skill: 'other:review' })).toBe(null)
})

test('orders a stack bottom-up and flags only a collision between two streams', async () => {
  let board = emptyBoard()
  board = applyOutput(board, 'pr-state', { pullRequest: 303, head: 'b', state: 'review-1' }, 1)
  board = applyOutput(board, 'pr-state', { pullRequest: 301, head: 'a', state: 'done' }, 1)
  board = applyOutput(
    board,
    'intersect',
    {
      pullRequests: [
        { number: 301, head: 'a', headSha: 's1', title: 'A', stackedOn: null },
        { number: 303, head: 'b', headSha: 's3', title: 'B', stackedOn: 301 },
        { number: 304, head: 'c', headSha: 's4', title: 'C', stackedOn: 303 },
        { number: 900, head: 'other', headSha: 's9', title: 'Other', stackedOn: null },
      ],
      pairs: [
        { pullRequests: [301, 303], merge: { result: 'conflict', paths: ['x'] } },
        { pullRequests: [304, 900], merge: { result: 'conflict', paths: ['y'] } },
      ],
    },
    2,
  )
  const layers = ordered(board.layers)
  // 304 joins the round by stacking on it; 900 is another stream and stays out.
  expect(layers.map(layer => layer.pullRequest)).toEqual([301, 303, 304])
  expect(layers[0]?.conflicts).toEqual([])
  expect(layers[2]?.conflicts).toEqual([900])
})

test('the round reads fill the board and the pane draws each layer', async ($, on) => {
  mock.clock(on)
  const outputs: Record<string, unknown> = {
    rounds: { rounds: [{ name: 'r', plan: '<plan> milestone 7', plannedAt: 'x', issues: [{ number: 41 }, { number: 42 }] }] },
    'pr-state': { pullRequest: 302, head: 'lsp-diag', title: 'Diagnostics', state: 'fixing', verdict: 'red', unresolvedThreads: 3, round: 1 },
  }
  on('tool.call', { tool: 'Bash' }, async (_, e) => {
    const sub = subcommandOf(e.command) ?? ''
    return { result: { stdout: JSON.stringify(outputs[sub] ?? {}), stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'Monitor' }, async () => ({ result: { taskId: 'w1', timeoutMs: 3_600_000 } }))
  on('tool.call', { tool: 'Skill' }, async () => ({ result: { success: true, commandName: 'x' } }) as never)

  await $.tool.call({ tool: 'Skill', skill: 'workstreams:review' })
  await $.tool.call({ tool: 'Bash', command: `${SCRIPT} rounds --milestone 7 --json` })
  await $.tool.call({ tool: 'Bash', command: `${SCRIPT} pr-state 302 --json` })
  await $.tool.call({
    tool: 'Monitor',
    description: 'watch',
    timeout_ms: 3_600_000,
    command: `${SCRIPT} watch --heads lsp-core,lsp-diag`,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'workstreams-board', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /milestone 7/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3 threads/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CI red/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no pull request yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / review / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /issues #41 #42/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /watch armed/ })).toBeDefined()
    // lsp-core is planned (named by the watch) but has no pull request yet.
    expect(await ui.find({ type: 'Text', text: /^lsp-core$/ })).toBeDefined()
    await ui.unmount()
  }
})
