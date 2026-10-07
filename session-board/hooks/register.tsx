import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Done, Need, Upcoming } from '../types'

const PANE = 'session-board'
const done = atom({ plugin: 'session-board', key: 'done' } as const, [])
const activity = atom({ plugin: 'session-board', key: 'activity' } as const, { edits: 0, commands: 0 })
const upcoming = atom({ plugin: 'session-board', key: 'upcoming' } as const, [])
const needs = atom({ plugin: 'session-board', key: 'needs' } as const, [])

// The last two parts of a path, enough to say which file without the person's folders
const shortPath = (path: unknown) => String(path ?? '').split('/').slice(-2).join('/') || 'a file'
const oneLine = (text: unknown, max = 60) => {
  const line = (String(text ?? '').split('\n')[0] ?? '').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
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

const TURN_PROMPT = (request: string, actions: string[], message: string, logged: Done[]) => `You keep a running log, for a non-programmer, of what an AI coding assistant accomplished in a session.

The user's request this turn:
${request || '(none: the assistant continued on its own)'}

What the assistant did this turn:
${actions.length ? actions.map(a => `- ${a}`).join('\n') : '(no changes)'}

The assistant's final message:
${message.slice(-3000)}

Already in the log (never repeat or restate these):
${logged.length ? logged.map(d => `- ${d.text}`).join('\n') : '(empty)'}

Reply with JSON only, no prose: {"done": [...], "ask": ...}

"done": 0 to 2 results of THIS turn. Each is one past-tense sentence of at most 12 words saying what now exists or works and why it matters, in plain words anyone understands. Describe outcomes, never commands or files. Good: "Published the mod to GitHub so it installs on any machine". Bad: "Ran git push", "Edited register.tsx". Only things actually finished. Use [] when the turn only answered a question, investigated, or failed.

"ask": if the final message asks the user to answer, decide, approve or do something, that ask as a to-do of at most 9 words starting with a verb, like "Decide: install mod as plugin or env var?". Otherwise null.`

type TurnSummary = { done: string[]; ask: string | null }

// What the turn achieved and what it asks of the person, from one small model call
const summarizeTurn = async (
  $: EngineInterface,
  request: string,
  actions: string[],
  message: string,
): Promise<TurnSummary> => {
  const logged = (await read($, done)).slice(-15)
  const reply = await $.model.complete({
    model: 'claude-haiku-4-5-20251001',
    prompt: TURN_PROMPT(request.slice(0, 1500), actions.slice(-40), message, logged),
    maxTokens: 200,
    timeoutMs: 20000,
  })
  if (reply.isAnswered) {
    try {
      const json = JSON.parse(reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1)) as Partial<TurnSummary>
      return {
        done: (Array.isArray(json.done) ? json.done : []).map(d => oneLine(d, 100)).filter(Boolean).slice(0, 2),
        ask: typeof json.ask === 'string' && json.ask.trim() ? oneLine(json.ask, 70) : null,
      }
    } catch {
      // Fall through to the plain fallback below
    }
  }
  // No usable answer: log nothing, and surface the last question Claude asked, if any
  const questions = message.match(/[^.!?\n]*\?/g)
  const last = questions?.[questions.length - 1]
  return { done: [], ask: last ? oneLine(last, 70) : null }
}

export const register: Register = on => {
  // Counts the person's prompts, so a summary that lands after they replied is dropped
  let prompts = 0
  // This turn's request and what changed during it, read when the turn ends
  let request = ''
  let actions: string[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'board',
      description: 'Show the session board: what got done, what is next, and what needs you',
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
    request = e.text
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

      if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
        const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
        actions.push(`${e.tool === 'Write' ? 'wrote' : 'edited'} ${shortPath(path)}`)
        await update($, activity, a => ({ ...a, edits: a.edits + 1 }))
      } else if (e.tool === 'Bash' && !ran.isReadOnly) {
        actions.push(`ran: ${oneLine(e.description ?? e.command, 100)}`)
        await update($, activity, a => ({ ...a, commands: a.commands + 1 }))
      } else if (!ran.isReadOnly && !e.tool.startsWith('Task') && e.tool !== 'Read') {
        actions.push(`used ${e.tool}`)
      }

      if (e.tool === 'CronCreate' && ran.result) {
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
    const turnActions = actions
    actions = []
    if (message) {
      const asked = prompts
      void summarizeTurn($, request, turnActions, message)
        .then(async summary => {
          if (summary.done.length) {
            const at = await $.clock.now()
            await update($, done, list => [...list, ...summary.done.map(text => ({ text, at }))].slice(-50))
          }
          if (summary.ask && asked === prompts) {
            await addNeed($, 'turn', summary.ask)
          }
        })
        .catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, (e.props.bodyColumns ?? 40) - 2)
    const fit = (text: string) => (text.length > width ? text.slice(0, width - 1) + '…' : text)

    const log = await read($, done)
    const work = await read($, activity)
    const next = await read($, upcoming)
    const waiting = await read($, needs)

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
        <Text bold>Done this session ({log.length})</Text>
        {log.length === 0 && <Text dimColor>  Nothing finished yet.</Text>}
        {log.slice(-12).map(d => (
          <Text wrap="wrap">  ✓ {d.text}</Text>
        ))}
        {work.edits + work.commands > 0 && (
          <Text dimColor>
            {fit(`  from ${work.edits} file edit${work.edits === 1 ? '' : 's'} and ${work.commands} command${work.commands === 1 ? '' : 's'}`)}
          </Text>
        )}
        {log.length > 0 && (
          <Box marginTop={1}>
            <Button key="clear" label="Clear log" onPress={() => update($, done, () => [])} />
          </Box>
        )}
      </Box>
    )
  })
}
