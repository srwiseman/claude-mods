import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PANE = { bodyColumns: 60 } as unknown as RenderPropsOf['Pane']
const settle = () => new Promise(r => setTimeout(r, 50))

const world = (on: On, summary: (prompt: string) => object) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 6, 15, 30) })
  on('ui.status', () => ({ value: undefined }) as never)
  on('classic.Notification', () => ({}))
  on('classic.Stop', () => ({}))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('tool.check', () => ({ decision: 'ask' as const }))
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
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
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
    expect(await ui.find({ text: /Needs you \(1\)/ })).toBeDefined()

    await $.prompt.submit({ text: 'ok go' } as never)
    expect(await ui.find({ text: /Needs you \(0\)/ })).toBeDefined()
  })
}

test('a question-only turn logs nothing but surfaces the ask', async ($, on) => {
  world(on, () => ({ done: [], ask: 'Decide: install mod as a plugin?' }))
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Two ways. Want me to set up option 1?' } as never)
  await settle()

  expect(await ui.find({ text: /Done this session \(0\)/ })).toBeDefined()
  expect(await ui.find({ text: /⚑ Decide: install mod as a plugin\?/ })).toBeDefined()
})
