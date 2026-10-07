import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PANE = { bodyColumns: 60 } as unknown as RenderPropsOf['Pane']
const settle = () => new Promise(r => setTimeout(r, 50))

const NOW = Date.UTC(2026, 9, 6, 15, 30)

// The plugin's store, kept where a test can look at it
const world = (on: On, summary: (prompt: string) => object, store = new Map<string, unknown>()) => {
  mock.clock(on, { now: NOW })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }) as never)
  on('store.delete', (_$, e) => (store.delete(e.key), { value: undefined }) as never)
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('classic.PermissionRequest', () => ({}))
  on('ui.status', () => ({ value: undefined }) as never)
  on('classic.Notification', () => ({}))
  on('classic.Stop', () => ({}))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('model.complete', (_$, e) =>
    ({ value: { isAnswered: true, text: JSON.stringify(summary(e.prompt)), usage: {} } }) as never,
  )
  on('tool.call', (_$, e) => {
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

    await $.prompt.submit({ text: 'fix the login bug' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/Users/someone/repo/src/auth.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the test suite' })
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Fixed it; tests pass.' } as never)
    await settle()
    await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 1800, reason: 'check the CI run', prompt: 'check CI', noop: false })

    // The model is shown the request and the actions, never the person's home folder
    expect(sent).toContain('fix the login bug')
    expect(sent).toContain('edited src/auth.ts')
    expect(sent).toContain('ran: Run the test suite')
    expect(sent.includes('/Users/someone')).toBe(false)

    const ui = await $.ui.mount({ plugin: 'session-board', surface, component: 'Pane', props: PANE, requestId: 'session-board' })
    expect(await ui.find({ text: /✓ Fixed the login bug so users can sign in again/ })).toBeDefined()
    expect(await ui.find({ text: /from 1 file edit and 1 command/ })).toBeDefined()
    expect(await ui.find({ text: /Wake at .*check the CI run/ })).toBeDefined()
    // Tool calls that no dialog was shown for (auto mode) never reach "Needs you"
    expect(await ui.find({ text: /Needs you \(0\)/ })).toBeDefined()
  })
}

test('only a dialog really shown counts, and it clears once answered', async ($, on) => {
  world(on, () => ({ done: [], ask: null }))
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  expect(await ui.find({ text: /Needs you \(0\)/ })).toBeDefined()

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push', description: 'Push to GitHub' } } as never)
  expect(await ui.find({ text: /⚑ Approve Bash: Push to GitHub/ })).toBeDefined()

  await $.tool.call({ tool: 'Bash', command: 'git push', description: 'Push to GitHub' })
  expect(await ui.find({ text: /Needs you \(0\)/ })).toBeDefined()
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
  expect(await ui.find({ text: /from 3 file edits and 2 commands/ })).toBeDefined()
  expect(stored.has('board:old-session')).toBe(false)

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Added it.' } as never)
  await settle()
  const saved = stored.get('board:session-1') as { done: { text: string }[] }
  expect(saved.done.map(d => d.text)).toEqual(['Shipped the login fix', 'Added a dark mode toggle'])

  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: {} } as never)
  expect(await ui.find({ text: /Done this session \(0\)/ })).toBeDefined()
})

test('a question-only turn logs nothing but surfaces the ask', async ($, on) => {
  world(on, () => ({ done: [], ask: 'Decide: install mod as a plugin?' }))
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Two ways. Want me to set up option 1?' } as never)
  await settle()

  expect(await ui.find({ text: /Done this session \(0\)/ })).toBeDefined()
  expect(await ui.find({ text: /⚑ Decide: install mod as a plugin\?/ })).toBeDefined()
})
