import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { findIssueRef, fingerprint, issueRefFromRead } from '../hooks/issue'

const PANE = { bodyColumns: 60 } as unknown as RenderPropsOf['Pane']
const settle = () => new Promise(r => setTimeout(r, 250))
const USAGE = { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 48500, model: 'claude-opus-5-5' }
const ended = (answer: string, turnId = 't1', agentId?: string) =>
  ({ answer, durationMs: 1000, isAborted: false, turnId, reason: 'answer', usage: USAGE, ...(agentId ? { agentId } : {}) }) as never

const NOW = Date.UTC(2026, 9, 6, 15, 30)
const BAND = { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 120 } as unknown as RenderPropsOf['AbovePrompt']
// What the engine was asked: pane titles, and the text put on the clipboard
let titles: string[] = []
let copied = ''

// The plugin's store, kept where a test can look at it
const world = (on: On, summary: (prompt: string) => object, store = new Map<string, unknown>(), usd = 0.5) => {
  titles = []
  copied = ''
  mock.clock(on, { now: NOW })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }) as never)
  on('store.delete', (_$, e) => (store.delete(e.key), { value: undefined }) as never)
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', (_$, e) => (titles.push(String(e.title)), { value: { isPlaced: true } }) as never)
  on('ui.copy', (_$, e) => ((copied = e.text), { value: { isCopied: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  // What the engine draws above the prompt when the board has nothing to say there
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('classic.PermissionRequest', () => ({}))
  on('session.usage', () => ({ value: { startedAt: NOW, context: {}, rateLimits: [], cost: { usd } } }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }) as never)
  on('session.repo', () => ({ value: { root: '/repo', remote: 'https://github.com/acme/app.git', internal: false, name: null } }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('process.run', (_$, e) =>
    ({
      value: e.argv.join(' ') === 'git rev-parse HEAD'
        ? { exitCode: 0, stdout: 'abc123\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : e.argv.join(' ') === 'git diff --name-only abc123'
        ? { exitCode: 0, stdout: 'src/cart.ts\nsrc/checkout.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : e.argv.join(' ') === 'git ls-files --others --exclude-standard'
        ? { exitCode: 0, stdout: 'src/checkout.test.ts\nsrc/cart.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : e.argv.join(' ').startsWith('gh issue view 57')
        ? { exitCode: 0, stdout: JSON.stringify({ number: 57, title: 'Login fails after password reset', body: 'Users get a 500 after resetting their password. Expected: they can sign in.', state: 'OPEN', url: 'https://github.com/acme/app/issues/57' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : { exitCode: 1, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false },
    }) as never,
  )
  on('ui.status', () => ({ value: undefined }) as never)
  on('classic.Notification', () => ({}))
  on('classic.Stop', () => ({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('model.complete', (_$, e) =>
    ({ value: { isAnswered: true, text: JSON.stringify(summary(e.prompt)), usage: {} } }) as never,
  )
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command.startsWith('gh issue view 57')) {
      return { result: {}, text: 'title: Login fails after password reset\nstate: OPEN\nnumber: 57\n--\nUsers get a 500.' } as never
    }
    if (e.tool === 'Bash' && e.command.startsWith('gh issue view 99')) {
      return { result: {}, text: 'title: Unrelated dark mode request\nnumber: 99' } as never
    }
    if (e.tool === 'Bash' && e.command.startsWith('gh pr create')) {
      return { result: {}, text: 'https://github.com/acme/app/pull/60' } as never
    }
    if (e.tool === 'ScheduleWakeup') {
      return { result: { scheduledFor: Date.UTC(2026, 9, 6, 16, 0), clampedDelaySeconds: 1800, wasClamped: false } }
    }
    return { result: {} as never }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`logs outcomes, schedule and needs on ${surface}`, async ($, on) => {
    let sent = ''
    world(on, prompt => {
      sent = prompt
      return { done: ['Fixed the login bug so users can sign in again'], ask: null }
    })

    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/Users/someone/repo/src/auth.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the test suite' })
    await $.turn.complete(ended('Fixed it; tests pass.'))
    await settle()
    await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 1800, reason: 'check the CI run', prompt: 'check CI', noop: false })

    // The model is shown the request and the actions, never the person's home folder
    expect(sent).toContain('fix the login bug')
    expect(sent).toContain('edited src/auth.ts')
    expect(sent).toContain('ran: Run the test suite')
    expect(sent.includes('/Users/someone')).toBe(false)

    const ui = await $.ui.mount({ plugin: 'session-board', surface, component: 'Pane', props: PANE, requestId: 'session-board' })
    expect(await ui.find({ text: /✓ Fixed the login bug so users can sign in again/ })).toBeDefined()
    expect(await ui.find({ text: /1 file edit · 1 command$/ })).toBeDefined()
    expect(await ui.find({ text: /Wake at .*check the CI run/ })).toBeDefined()
    // Tool calls that no dialog was shown for (auto mode) never reach "Needs you"
    expect(await ui.find({ text: /NEEDS YOU/ })).toBeUndefined()
  })
}

test('only a dialog really shown counts, and it clears once answered', async ($, on) => {
  world(on, () => ({ done: [], ask: null }))
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  expect(await ui.find({ text: /NEEDS YOU/ })).toBeUndefined()

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push', description: 'Push to GitHub' } } as never)
  expect(await ui.find({ text: /⚑ NEEDS YOU/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  Approve Bash: Push to GitHub$/ })).toBeDefined()
  expect(titles).toContain('Session · ⚑ 1')

  await $.tool.call({ tool: 'Bash', command: 'git push', description: 'Push to GitHub' })
  expect(await ui.find({ text: /NEEDS YOU/ })).toBeUndefined()
  expect(titles[titles.length - 1]).toBe('Session')
})

test('the log is saved, restored after a restart, and reset by /clear', async ($, on) => {
  const stored = new Map<string, unknown>([
    ['board:session-1', { done: [{ text: 'Shipped the login fix', at: NOW }], activity: { edits: 3, commands: 2 }, savedAt: NOW }],
    ['board:old-session', { done: [], activity: { edits: 0, commands: 0 }, savedAt: NOW - 40 * 24 * 60 * 60 * 1000 }],
  ])
  world(on, () => ({ done: ['Added a dark mode toggle'], ask: null }), stored)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })
  expect(await ui.find({ text: /✓ Shipped the login fix/ })).toBeDefined()
  expect(await ui.find({ text: /3 file edits · 2 commands$/ })).toBeDefined()
  expect(stored.has('board:old-session')).toBe(false)

  await $.turn.complete(ended('Added it.'))
  await settle()
  const saved = stored.get('board:session-1') as { done: { text: string }[] }
  expect(saved.done.map(d => d.text)).toEqual(['Shipped the login fix', 'Added a dark mode toggle'])

  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: {} } as never)
  expect(await ui.find({ text: /Done  ·/ })).toBeUndefined()
})

test('a question-only turn logs nothing but surfaces the ask', async ($, on) => {
  world(on, () => ({ done: [], ask: 'Decide: install mod as a plugin?' }))
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.turn.complete(ended('Two ways. Want me to set up option 1?'))
  await settle()

  expect(await ui.find({ text: /Done  ·/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^  Decide: install mod as a plugin\?$/ })).toBeDefined()
})

test('shows the session cost and plan limits as they move', async ($, on) => {
  world(on, () => ({ done: [], ask: null }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })
  expect(await ui.find({ type: 'Text', text: /^\$0\.50$/ })).toBeDefined()

  await $.session.measure({
    context: {},
    cost: { usd: 3.4 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 85 }, { kind: 'seven_day', percentUsed: 12.5 }],
    changed: ['cost', 'rateLimits'],
  } as never)
  expect(await ui.find({ type: 'Text', text: /^\$3\.40 API-equiv\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5h ▓▓▓▓▓▓▓░ 85%$/ })).toBeDefined()
})

test('a subagent finishing logs nothing; an ask overtaken by a newer turn is dropped', async ($, on) => {
  let calls = 0
  world(on, () => (calls++, { done: ['Shipped it'], ask: 'Decide: ship now?' }))
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.turn.start({ text: 'ship it', turnId: 't1' })
  await $.turn.complete(ended('Subagent report', 't1', 'agent-7'))
  await settle()
  expect(calls).toBe(0)

  await $.turn.complete(ended('Ready. Ship now?', 't1'))
  await $.turn.start({ text: '', turnId: 't2' })
  await settle()
  expect(await ui.find({ text: /✓ Shipped it/ })).toBeDefined()
  expect(await ui.find({ text: /NEEDS YOU/ })).toBeUndefined()
})

test('finds issues people name, and ignores look-alikes', () => {
  expect(findIssueRef('can you take issue 57?')?.key).toBe('#57')
  expect(findIssueRef('work through #12 to a PR')?.key).toBe('#12')
  expect(findIssueRef('see https://github.com/acme/app/issues/88')).toEqual({
    key: '#88', url: 'https://github.com/acme/app/issues/88', repo: 'acme/app', number: 88,
  })
  expect(findIssueRef('pick up the ENG-42 ticket')?.key).toBe('ENG-42')
  expect(findIssueRef('https://acme.atlassian.net/browse/PAY-7')?.key).toBe('PAY-7')
  expect(findIssueRef('fix the UTF-8 bug in the parser')).toBeNull()
  expect(findIssueRef('bump to version 2.0 and ENG-42 later')).toBeNull()
  expect(findIssueRef('make the font size 12')).toBeNull()
})

test('shows the issue being worked on, links its PR, and keeps it when Claude reads another', async ($, on) => {
  world(on, prompt =>
    prompt.includes('issue tracker')
      ? prompt.includes('Login fails')
        ? { key: '#57', title: 'Login fails after password reset', summary: 'Users hit a 500 after a reset; done when they can sign in.', state: 'open' }
        : { key: '#99', title: 'Unrelated dark mode request', summary: 'Add dark mode.', state: 'open' }
      : { done: [], ask: null },
  )
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.prompt.submit({ text: "Let's work issue #57 through to a PR" } as never)
  await settle()
  expect(await ui.find({ type: 'Text', text: /^#57 Login fails after password reset$/ })).toBeDefined()
    expect(await ui.find({ text: /done when they can sign in/ })).toBeDefined()

  await $.tool.call({ tool: 'Bash', command: 'gh issue view 99', description: 'Read a related issue' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill', description: 'Open the pull request' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /^#57 Login fails after password reset$/ })).toBeDefined()
  expect(await ui.find({ text: /PR #60 ↗/ })).toBeDefined()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"href":"https://github.com/acme/app/pull/60"')
  expect(drawn).toContain('"href":"https://github.com/acme/app/issues/57"')

  await $.command.run({ command: 'issue', args: 'clear' } as never)
  expect(await ui.find({ text: /#57/ })).toBeUndefined()
})

test('shows live progress while a turn runs, and clears it when the turn ends', async ($, on) => {
  world(on, () => ({ done: ['Fixed the flaky checkout test'], ask: null }))
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.turn.start({ text: 'fix the flaky checkout test', turnId: 't1' })
  expect(await ui.find({ text: /● Working · 0s/ })).toBeDefined()
  expect(await ui.find({ text: /“fix the flaky checkout test”/ })).toBeDefined()
  expect(await ui.find({ text: /▸ Thinking/ })).toBeDefined()

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/checkout.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- checkout', description: 'Run the checkout tests' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- checkout', description: 'Run the checkout tests' })
  expect(await ui.find({ text: /✓ Run the checkout tests/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /✓ Run the checkout tests/ })).length).toBe(1)

  await $.turn.complete(ended('Fixed it.'))
  await settle()
  expect(await ui.find({ text: /● Working/ })).toBeUndefined()
  expect(await ui.find({ text: /✓ Fixed the flaky checkout test/ })).toBeDefined()
})

test('says the cost is not reported, with tokens, where the setup prices nothing', async ($, on) => {
  world(on, () => ({ done: [], ask: null }), new Map(), 0)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })
  expect(await ui.find({ type: 'Text', text: /^\$0\.00$/ })).toBeDefined()

  await $.turn.complete(ended('Done.'))
  await settle()
  expect(await ui.find({ type: 'Text', text: /^cost not reported · 50k tok$/ })).toBeDefined()
})

test('counts files changed with git, however Claude changed them', async ($, on) => {
  world(on, () => ({ done: ['Fixed checkout totals'], ask: null }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.turn.start({ text: 'fix checkout totals', turnId: 't1' })
  // Edited through the shell, as auto mode often does: no Edit tool call at all
  await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/a/b/' src/cart.ts", description: 'Fix the rounding in cart totals' })
  await $.turn.complete(ended('Fixed.'))
  await settle()

  expect(await ui.find({ text: /3 files changed · 1 command$/ })).toBeDefined()
})

test('knows which issue a read is for, from the call itself', () => {
  expect(issueRefFromRead('Bash', { command: 'gh issue view 57 --comments' })?.key).toBe('#57')
  expect(issueRefFromRead('Bash', { command: 'gh issue view 12 --repo acme/app' })).toEqual({ key: '#12', number: 12, repo: 'acme/app' })
  expect(issueRefFromRead('WebFetch', { url: 'https://github.com/acme/app/issues/88' })?.key).toBe('#88')
  expect(issueRefFromRead('mcp__github__get_issue', { owner: 'acme', repo: 'app', issue_number: 31 })?.key).toBe('#31')
  expect(issueRefFromRead('mcp__atlassian__getJiraIssue', { issueIdOrKey: 'PAY-7' })?.key).toBe('PAY-7')
  expect(fingerprint('same text')).toBe(fingerprint('same text'))
  expect(fingerprint('same text')).not.toBe(fingerprint('same text!'))
})

test('summarizes an issue once, however often Claude re-reads it', async ($, on) => {
  let issueCalls = 0
  world(on, prompt => {
    if (!prompt.includes('issue tracker')) return { done: [], ask: null }
    issueCalls++
    return { key: '#57', title: 'Login fails after password reset', summary: 'Users hit a 500 after a reset.', state: 'open' }
  })
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.prompt.submit({ text: 'take issue #57' } as never)
  await settle()
  expect(issueCalls).toBe(1)

  // Claude reads the same issue twice, then a related one, while #57 is pinned
  await $.tool.call({ tool: 'Bash', command: 'gh issue view 57', description: 'Read the issue' })
  await $.tool.call({ tool: 'Bash', command: 'gh issue view 57 --comments', description: 'Read the comments' })
  await $.tool.call({ tool: 'Bash', command: 'gh issue view 99', description: 'Read a related issue' })
  await settle()
  expect(issueCalls).toBe(1)
  expect(await ui.find({ type: 'Text', text: /^#57 Login fails after password reset$/ })).toBeDefined()
})

test('keeps Done short, expands on request, and copies the session as a write-up', async ($, on) => {
  let turn = 0
  world(on, prompt =>
    prompt.includes('issue tracker')
      ? { key: '#57', title: 'Login fails after password reset', summary: 'Users hit a 500.', state: 'open' }
      : { done: [`Result ${++turn}`], ask: null },
  )
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })
  await $.prompt.submit({ text: 'take issue #57' } as never)
  for (const id of ['t1', 't2', 't3', 't4', 't5']) {
    await $.turn.start({ text: 'go', turnId: id })
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
    await $.turn.complete(ended('ok', id))
    await settle()
  }

  expect(await ui.find({ text: /Result 5/ })).toBeDefined()
  expect(await ui.find({ text: /Result 2/ })).toBeUndefined()
  await $.ui.press({ plugin: 'session-board', key: 'more' })
  expect(await ui.find({ text: /Result 1/ })).toBeDefined()
  await $.ui.press({ plugin: 'session-board', key: 'less' })
  expect(await ui.find({ text: /Result 1/ })).toBeUndefined()

  await $.ui.press({ plugin: 'session-board', key: 'copy' })
  expect(copied).toContain('#57 Login fails after password reset (https://github.com/acme/app/issues/57)')
  expect(copied).toContain('- Result 1')
  expect(copied).toContain('- Result 5')
})

test('shows a one-line band above the prompt while working and the pane is out of sight', async ($, on) => {
  world(on, () => ({ done: [], ask: null }))
  const idle = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await idle.find({ text: /●/ })).toBeUndefined()

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  const band = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /● Working · 0s/ })).toBeDefined()

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push', description: 'Push to GitHub' } } as never)
  expect(await band.find({ text: /⚑ Approve Bash: Push to GitHub/ })).toBeDefined()
})
