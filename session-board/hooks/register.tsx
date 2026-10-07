import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change, Need, Upcoming } from '../types'

const PANE = 'session-board'
const changes = atom({ plugin: 'session-board', key: 'changes' } as const, [])
const upcoming = atom({ plugin: 'session-board', key: 'upcoming' } as const, [])
const needs = atom({ plugin: 'session-board', key: 'needs' } as const, [])

const baseName = (path: unknown) => String(path ?? '').split('/').pop() || 'a file'
const oneLine = (text: unknown, max = 60) => {
  const line = (String(text ?? '').split('\n')[0] ?? '').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Keeps one row per file or command, counting repeats
const tally = async ($: EngineInterface, verb: string, what: string) => {
  const at = await $.clock.now()
  const key = `${verb}:${what}`
  await update($, changes, list => {
    const found = list.find(c => c.key === key)
    const rest = list.filter(c => c.key !== key)
    const row: Change = found ? { ...found, count: found.count + 1, at } : { key, verb, what, count: 1, at }
    return [...rest, row].slice(-100)
  })
}

const addNeed = async ($: EngineInterface, id: string, label: string) => {
  const need: Need = { id, label, at: await $.clock.now() }
  await update($, needs, list => [...list.filter(n => n.id !== id), need])
  await showNeedCount($)
}

const dropNeeds = async ($: EngineInterface, test: (n: Need) => boolean) => {
  await update($, needs, list => list.filter(n => !test(n)))
  await showNeedCount($)
}

// A status line entry so "needs you" shows even when the pane is closed
const showNeedCount = async ($: EngineInterface) => {
  const count = (await read($, needs)).length
  $.ui.status(count > 0 ? `⚑ ${count} need${count === 1 ? 's' : ''} you` : undefined)
}

const putUpcoming = async ($: EngineInterface, item: Upcoming) =>
  update($, upcoming, list => [...list.filter(u => u.id !== item.id), item])

const ASK_PROMPT = `Below is the last message an AI coding assistant sent its user.
If it asks the user to answer, decide, approve, or do something, reply with ONLY that ask as a short to-do of at most 8 words, starting with a verb (for example "Decide: install mod as plugin or env var?" or "Run gcloud auth login").
If it needs nothing from the user, reply with exactly NONE.

Message:
`

// The one thing Claude's last message asks of the person, in a few words; null when it asks nothing
const summarizeAsk = async ($: EngineInterface, message: string): Promise<string | null> => {
  const reply = await $.model.complete({
    model: 'claude-haiku-4-5-20251001',
    prompt: ASK_PROMPT + message.slice(-4000),
    maxTokens: 40,
    timeoutMs: 15000,
  })
  if (reply.isAnswered) {
    const text = oneLine(reply.text.replace(/^["']|["']$/g, ''), 70)
    return text === '' || /^NONE\b/i.test(text) ? null : text
  }
  // No model answer: fall back to the last question Claude asked, if any
  const questions = message.match(/[^.!?\n]*\?/g)
  const last = questions?.[questions.length - 1]
  return last ? oneLine(last, 70) : null
}

export const register: Register = on => {
  // Counts the person's prompts, so a summary that lands after they replied is dropped
  let prompts = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'board',
      description: 'Show the session board: changes, what is next, and what needs you',
    })
    void $.ui.open({ id: PANE, title: 'Session' })

    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Session' })

    return { text: 'Session board opened.' }
  })

  // The person acted, so the "your move" items are settled
  on('prompt.submit', async ($, e, next) => {
    prompts += 1
    await dropNeeds($, n => n.id === 'turn' || n.id === 'notify')

    return next(e)
  })

  // Permission prompts: an "ask" verdict means a dialog is waiting on the person
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id) {
      const input = (e.input ?? {}) as Record<string, unknown>
      const subject = input.command ?? input.file_path ?? input.url ?? ''
      await addNeed($, e.tool_use_id, `Approve ${e.tool}${subject ? `: ${oneLine(subject, 50)}` : ''}`)
    }

    return verdict
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? ''

    if (e.tool === 'AskUserQuestion') {
      const first = e.questions?.[0]?.question
      await addNeed($, id, `Answer: ${oneLine(first ?? 'a question from Claude', 55)}`)
    } else if (e.tool === 'ExitPlanMode') {
      await addNeed($, id, 'Review and approve the plan')
    } else if (e.tool === 'Bash' && e.run_in_background) {
      await putUpcoming($, { id, label: `Running: ${oneLine(e.description ?? e.command, 50)}` })
    }

    try {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) {
        return ran
      }

      if (e.tool === 'Edit') {
        await tally($, 'Edited', baseName(e.file_path))
      } else if (e.tool === 'Write') {
        await tally($, 'Wrote', baseName(e.file_path))
      } else if (e.tool === 'NotebookEdit') {
        await tally($, 'Edited notebook', baseName(e.notebook_path))
      } else if (e.tool === 'Bash' && !ran.isReadOnly) {
        await tally($, 'Ran', oneLine(e.description ?? e.command, 50))
      } else if (e.tool === 'CronCreate' && ran.result) {
        const job = ran.result as { id: string; humanSchedule: string }
        await putUpcoming($, { id: job.id, label: `${job.humanSchedule}: ${oneLine(e.prompt, 45)}` })
      } else if (e.tool === 'CronDelete') {
        await update($, upcoming, list => list.filter(u => u.id !== e.id))
      } else if (e.tool === 'ScheduleWakeup' && ran.result) {
        const wake = ran.result as { scheduledFor: number; stopped?: boolean }
        if (wake.stopped) {
          await update($, upcoming, list => list.filter(u => u.id !== 'wakeup'))
        } else {
          const at = wake.scheduledFor
          await putUpcoming($, { id: 'wakeup', at, label: `Wake at ${clockTime(at)}: ${oneLine(e.reason, 45)}` })
        }
      }

      return ran
    } finally {
      if (id) {
        await dropNeeds($, n => n.id === id)
      }
    }
  })

  // Claude Code is waiting on the person (idle, or a permission dialog)
  on('classic.Notification', async ($, e, next) => {
    await addNeed($, 'notify', oneLine(e.message, 60))

    return next(e)
  })

  // Each turn end carries the true list of scheduled and background work
  on('classic.Stop', async ($, e, next) => {
    const known = await read($, upcoming)
    const crons: Upcoming[] = (e.session_crons ?? []).map(c => {
      const ours = known.find(u => u.id === c.id || (u.id === 'wakeup' && !c.recurring))
      return ours ?? { id: c.id, label: `${c.schedule}${c.recurring ? ' (repeats)' : ''}: ${oneLine(c.prompt, 45)}` }
    })
    const tasks: Upcoming[] = (e.background_tasks ?? []).map(t => ({
      id: t.id,
      label: `Running ${t.type}: ${oneLine(t.command ?? t.description, 45)}`,
    }))
    await update($, upcoming, () => [...crons, ...tasks])

    // Summarized in the background so the turn's end is not held up
    const message = e.last_assistant_message
    if (message) {
      const asked = prompts
      void summarizeAsk($, message).then(async ask => {
        if (ask && asked === prompts) {
          await addNeed($, 'turn', ask)
        }
      }).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, (e.props.bodyColumns ?? 40) - 2)
    const fit = (text: string) => (text.length > width ? text.slice(0, width - 1) + '…' : text)

    const changeList = await read($, changes)
    const next = await read($, upcoming)
    const waiting = await read($, needs)

    const files = changeList.filter(c => c.verb !== 'Ran').length
    const edits = changeList.filter(c => c.verb !== 'Ran').reduce((sum, c) => sum + c.count, 0)
    const runs = changeList.filter(c => c.verb === 'Ran').reduce((sum, c) => sum + c.count, 0)

    return (
      <Box flexDirection="column">
        <Text bold color={waiting.length ? 'yellow' : undefined}>
          Needs you ({waiting.length})
        </Text>
        {waiting.length === 0 && <Text dimColor>  Nothing, carry on.</Text>}
        {waiting.map(n => (
          <Text color="yellow">{fit(`  ⚑ ${n.label}`)}</Text>
        ))}

        <Text> </Text>
        <Text bold>Up next ({next.length})</Text>
        {next.length === 0 && <Text dimColor>  Nothing scheduled.</Text>}
        {next.map(u => (
          <Text>{fit(`  ⏱ ${u.label}`)}</Text>
        ))}

        <Text> </Text>
        <Text bold>Changes</Text>
        <Text dimColor>
          {fit(`  ${files} file${files === 1 ? '' : 's'} touched (${edits} edits) · ${runs} command${runs === 1 ? '' : 's'} run`)}
        </Text>
        {changeList
          .slice(-15)
          .reverse()
          .map(c => (
            <Text>{fit(`  ${c.verb === 'Ran' ? '▸' : '✎'} ${c.verb} ${c.what}${c.count > 1 ? ` ×${c.count}` : ''}`)}</Text>
          ))}
        {changeList.length > 0 && (
          <Box marginTop={1}>
            <Button key="clear" label="Clear changes" onPress={() => update($, changes, () => [])} />
          </Box>
        )}
      </Box>
    )
  })
}
