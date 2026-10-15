import { expect, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { chipLabel, extractCopyables, mergeHistory } from '../hooks/extract'

const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, view: {} } as unknown as RenderPropsOf['AbovePrompt']
const ended = (answer: string, extra: object = {}) =>
  ({ answer, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as never

let copied = ''
let toasts: string[] = []
let sections: string[] = []

const world = (on: On) => {
  copied = ''
  toasts = []
  sections = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.copy', (_$, e) => ((copied = e.text), { value: { isCopied: true } }) as never)
  on('ui.toast', (_$, e) => (toasts.push(String(e.text)), { value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  // What the engine (or another mod) draws above the prompt beneath the chips
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['other band'] }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }) as never)
}

test('finds commands, ids, paths and URLs, and skips plain words', () => {
  const reply = [
    'Pushed to `main`. Run `git push -u origin feat/login` next; the run id is `wf_abc123`.',
    'Config lives at `~/.claude/settings.json`, it is `true` by default.',
    'Docs: https://code.claude.com/docs/en/plugins. See [the PR](https://github.com/acme/app/pull/60).',
    '',
    '```bash',
    '$ npm ci',
    'added 312 packages',
    '$ npm test',
    '```',
    '',
    '```ts',
    'const x = 1',
    '```',
  ].join('\n')

  expect(extractCopyables(reply)).toEqual([
    'git push -u origin feat/login',
    'wf_abc123',
    '~/.claude/settings.json',
    'https://code.claude.com/docs/en/plugins',
    'https://github.com/acme/app/pull/60',
    'npm ci\nnpm test',
    'const x = 1',
  ])
})

test('skips diffs and long blocks, keeps inline code inside fences out', () => {
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
  const reply = '```diff\n- a\n+ b\n```\n\n```\n' + long + '\n```\n\n```sh\necho `date`\n```'
  expect(extractCopyables(reply)).toEqual(['echo `date`'])
})

test('keeps the newest reply first, without repeats, nine at most', () => {
  expect(mergeHistory(['b', 'c'], ['a', 'b'], 9)).toEqual(['b', 'c', 'a'])
  expect(mergeHistory(['x'], ['1', '2', '3', '4', '5', '6', '7', '8', '9'], 9)).toHaveLength(9)
})

test('labels a chip by its first line, cut to fit', () => {
  expect(chipLabel('npm ci\nnpm test', 40)).toBe('npm ci +1 lines')
  expect(chipLabel('a'.repeat(60), 20)).toBe('a'.repeat(19) + '…')
})

test('shows chips above the band beneath, and a digit copies one', async ($, on) => {
  world(on)
  const band = await $.ui.mount({ plugin: 'copy-chips', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /Copy/ })).toBeUndefined()
  expect(await band.find({ text: /other band/ })).toBeDefined()

  // The reply's chips draw in the band already mounted
  await $.turn.complete(ended('Run `npm run build` then open https://localhost:3000/admin.'))
  expect(await band.find({ text: /npm run build/ })).toBeDefined()
  expect(await band.find({ text: /other band/ })).toBeDefined()

  await $.ui.press({ plugin: 'copy-chips', key: 'chip:1' })
  expect(copied).toBe('https://localhost:3000/admin')
  expect(toasts.at(-1)).toContain('Copied')

  // The next reply's items go first
  await $.turn.complete(ended('The id is `cus_9f8e7d`.'))
  expect(await band.find({ text: /cus_9f8e7d/ })).toBeDefined()
  await $.ui.press({ plugin: 'copy-chips', key: 'chip:0' })
  expect(copied).toBe('cus_9f8e7d')
})

test("ignores subagents' reports and interrupted turns", async ($, on) => {
  world(on)
  await $.turn.complete(ended('Run `rm -rf build/`', { agentId: 'a1' }))
  await $.turn.complete(ended('Run `make all`', { isAborted: true, reason: 'aborted' }))
  const band = await $.ui.mount({ plugin: 'copy-chips', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /Copy/ })).toBeUndefined()
})

test('/chips hides and shows the chips; /chips clear empties them', async ($, on) => {
  world(on)
  await $.turn.complete(ended('Run `npm run build`.'))
  await $.command.run({ command: 'chips', args: '' } as never)
  let band = await $.ui.mount({ plugin: 'copy-chips', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /npm run build/ })).toBeUndefined()

  await $.command.run({ command: 'chips', args: '' } as never)
  band = await $.ui.mount({ plugin: 'copy-chips', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /npm run build/ })).toBeDefined()

  await $.command.run({ command: 'chips', args: 'clear' } as never)
  band = await $.ui.mount({ plugin: 'copy-chips', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /npm run build/ })).toBeUndefined()
})

test('asks Claude to put copyable values in code spans', async ($, on) => {
  world(on)
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  const ours = composed.sections.find(s => s.id === 'copy-chips:guidance')
  expect(ours?.scope).toBe('session')
  expect(ours?.text).toContain('inline code')
})
