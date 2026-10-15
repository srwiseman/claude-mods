import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { chipLabel, extractCopyables, mergeHistory } from './extract'

// What the chips hold, newest reply's first; one digit each, so nine at most
const items = atom({ plugin: 'copy-chips', key: 'items' } as const, [])
const isHidden = atom({ plugin: 'copy-chips', key: 'isHidden' } as const, false)
const MAX_CHIPS = 9
const MAX_LABEL = 40

// Asks Claude to mark what you'd copy, so the chips find it rather than guess
const GUIDANCE = [
  '# Copyable values',
  'When a reply contains something the user is likely to copy and paste (a command to run, an id, a path, a URL, a branch or version name), put it in inline code or a fenced code block, exactly as it should be pasted: one copyable value per span, with no surrounding prose or `$ ` prompt inside it. Use a fenced block for multi-line commands.',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'chips',
      description: 'Copy chips above the prompt: no argument toggles them; "clear" empties them',
      argumentHint: '[clear]',
    })

    return next(e)
  })

  on('command.run', { command: 'chips' }, async ($, e) => {
    if (/^\s*clear\s*$/i.test(e.args)) {
      await update($, items, () => [])
      return { text: 'Copy chips cleared.' }
    }
    const hidden = await update($, isHidden, h => !h)
    return { text: hidden ? 'Copy chips hidden. Run /chips to show them.' : 'Copy chips shown.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'copy-chips:guidance', text: GUIDANCE, scope: 'session' }] }
  })

  on('turn.complete', async ($, e, next) => {
    // Subagents' reports go to Claude, not to you
    if (!e.agentId && !e.isAborted) {
      const fresh = extractCopyables(e.answer)
      if (fresh.length) await update($, items, old => mergeHistory(fresh, old, MAX_CHIPS))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const list = await read($, items)
    if (e.props.hasSurvey || e.props.view.agentId || !list.length || (await read($, isHidden))) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.min(MAX_LABEL, Math.max(12, e.props.bodyColumns - 8))
    const copy = async (text: string, label: string, surface: typeof e.surface) => {
      const done = await $.ui.copy({ text, surface })
      $.ui.toast(done.isCopied ? `Copied ${label}` : `Couldn't copy (${done.reason})`)
    }

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap={2}>
          <Text dimColor>Copy</Text>
          {list.map((text, i) => {
            const label = chipLabel(text, width)
            return (
              <Button
                key={`chip:${i}`}
                label={label}
                hotkey={String(i + 1)}
                plain
                onPress={press => copy(text, label, press.surface)}
              />
            )
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
