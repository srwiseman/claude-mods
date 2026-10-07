import { expect, mock, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const PANE = { bodyColumns: 60 } as unknown as RenderPropsOf['Pane']

for (const surface of ['terminal', 'desktop'] as const) {
  test(`tallies changes, schedule and needs on ${surface}`, async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 6, 15, 30) })
    on('ui.status', () => ({ value: undefined }) as never)
    on('classic.Notification', () => ({}))
    on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
    on('tool.check', () => ({ decision: 'ask' as const }))
    on('tool.call', (_$, e) => {
      if (e.tool === 'ScheduleWakeup') {
        return { result: { scheduledFor: Date.UTC(2026, 9, 6, 16, 0), clampedDelaySeconds: 1800, wasClamped: false } }
      }
      return { result: {} as never }
    })

    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 1800, reason: 'check the CI run', prompt: 'check CI', noop: false })
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })

    const ui = await $.ui.mount({ plugin: 'session-board', surface, component: 'Pane', props: PANE, requestId: 'session-board' })

    expect(await ui.find({ text: /Edited app\.ts ×2/ })).toBeDefined()
    expect(await ui.find({ text: /1 file touched \(2 edits\)/ })).toBeDefined()
    expect(await ui.find({ text: /Wake at .*check the CI run/ })).toBeDefined()
    expect(await ui.find({ text: /Needs you \(1\)/ })).toBeDefined()

    await $.prompt.submit({ text: 'ok go' } as never)
    expect(await ui.find({ text: /Needs you \(0\)/ })).toBeDefined()
  })
}

test('turns the end of a turn into a short to-do, or nothing', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.status', () => ({ value: undefined }) as never)
  on('classic.Stop', () => ({}))
  on('model.complete', (_$, e) =>
    e.prompt.includes('Want me to set up option 1?')
      ? ({ value: { isAnswered: true, text: 'Decide: install mod as a plugin?', usage: {} } } as never)
      : ({ value: { isAnswered: true, text: 'NONE', usage: {} } } as never),
  )

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'session-board' })

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'All done, tests pass.' } as never)
  await new Promise(r => setTimeout(r, 50))
  expect(await ui.find({ text: /Needs you \(0\)/ })).toBeDefined()

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Two ways to do it. Want me to set up option 1?' } as never)
  await new Promise(r => setTimeout(r, 50))
  expect(await ui.find({ text: /⚑ Decide: install mod as a plugin\?/ })).toBeDefined()
})
