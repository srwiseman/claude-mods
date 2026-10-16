import { expect, mock, test } from 'claude-code/testing'

import { applyOutput, applyPlan, emptyBoard, foldCall, headsOf, ordered, phaseOf, replay, roundPullRequests, subcommandOf } from '../hooks/board'
import type { Row } from '../hooks/board'

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

test('replays a round from the session history, as if the mod had watched it', async () => {
  const bash = (command: string, out: unknown) => ({
    tool: 'Bash',
    input: { command },
    result: { stdout: JSON.stringify(out), stderr: '', interrupted: false },
  })
  const rows: Row[] = [
    { role: 'user', text: '/workstreams:start milestone 7', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool: 'Skill', input: { skill: 'workstreams:start' }, text: 'ok' },
        bash(`${SCRIPT} rounds --milestone 7 --json`, { rounds: [{ plan: '<plan> m7', issues: [{ number: 41 }] }] }),
        bash(`${SCRIPT} pr-state 301 --json`, { pullRequest: 301, head: 'a', state: 'done', verdict: 'green' }),
        bash(`${SCRIPT} pr-state 302 --json`, { pullRequest: 302, head: 'b', state: 'fixing', unresolvedThreads: 2 }),
        { tool: 'Monitor', input: { command: `${SCRIPT} watch --heads a,b,c` }, result: { taskId: 'w9', timeoutMs: 3_600_000 } },
        { tool: 'Read', input: { file_path: '/p/workstreams/skills/start/tick.md' }, text: '…' },
        // A call still running when history was read has no outcome, and is skipped.
        { tool: 'Skill', input: { skill: 'workstreams:review' } },
      ],
    },
  ]
  const board = replay(rows, 1000)
  expect(board.plan).toBe('<plan> m7')
  expect(board.phase).toBe('tick')
  expect(board.phaseAt).toBe(null)
  expect(board.script).toBe('/plugins/workstreams/scripts/workstreams.ts')
  expect(board.watch).toEqual({ taskId: 'w9', armedAt: null, deadline: null, heads: ['a', 'b', 'c'] })
  expect(ordered(board.layers).map(layer => [layer.head, layer.state])).toEqual([
    ['a', 'done'],
    ['b', 'fixing'],
    ['c', null],
  ])

  // The watch's task notification takes the watch down.
  const ended = replay([...rows, { role: 'user', text: '<task-notification>w9 completed</task-notification>', toolUses: [] }], 1000)
  expect(ended.watch).toBe(null)
})

test('Refresh finds the round pull requests the way the orchestrator does', async () => {
  let board = applyOutput(emptyBoard(), 'rounds', { rounds: [{ plan: 'p', issues: [{ number: 41 }, { number: 42 }] }] }, 1)
  board = foldCall(board, { tool: 'Monitor', input: { command: `${SCRIPT} watch --heads planned` }, result: {} }, 1)
  const pulls = [
    { number: 300, headRefName: 'a', closingIssuesReferences: [{ number: 41 }] },
    { number: 310, headRefName: 'a', closingIssuesReferences: [{ number: 41 }] },
    { number: 305, headRefName: 'planned', closingIssuesReferences: [] },
    { number: 306, headRefName: 'other', closingIssuesReferences: [{ number: 99 }] },
  ]
  // The newest per branch: 310 replaces 300; 305 by its head; 306 is not this round's.
  expect(roundPullRequests(board, pulls)).toEqual([305, 310])
})

test('an empty board offers Refresh', async ($, on) => {
  mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'workstreams-board', surface, ...PANE })
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No workstreams round/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the plan comment adds each planned layer, in plan order, and only for this round', async () => {
  const plan = 'Round 22 plan, approved 2026-10-14T23:13Z.\n\n**A1**\n- Branch: `wktr-263-isolated-agents`, off `main`\n**A2**\n- Branch: `wktr-449-guard-cd`, on `wktr-263-isolated-agents`\n**B1**\n- Branch: `wktr-443-mark-head`, off `main`'
  const view = (stdout: string) => ({ tool: 'Bash', input: { command: 'gh issue view 438 --json comments --jq x' }, result: { stdout } })

  // Before rounds names the plan, an issue's text is not taken for one.
  expect(foldCall(emptyBoard(), view(plan), 1).layers).toEqual([])

  const board = applyOutput(emptyBoard(), 'rounds', { rounds: [{ plan: 'Round 22 plan, approved 2026-10-14T23:13Z.', issues: [] }] }, 1)
  expect(ordered(foldCall(board, view(plan), 1).layers).map(layer => layer.head)).toEqual([
    'wktr-263-isolated-agents',
    'wktr-449-guard-cd',
    'wktr-443-mark-head',
  ])
  expect(foldCall(board, view('Round 21 plan\n- Branch: `old`'), 1)).toBe(board)
  expect(applyPlan(board, 'no branches here', 1)).toBe(board)
})
