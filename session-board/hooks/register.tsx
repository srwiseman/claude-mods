import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Done, Issue, Need, Upcoming } from '../types'
import { findIssueRef, findPrUrl, githubIssueArgv, isIssueRead, issuePrompt, parseIssueReply } from './issue'
import type { IssueRef } from './issue'

const PANE = 'session-board'
const done = atom({ plugin: 'session-board', key: 'done' } as const, [])
const activity = atom({ plugin: 'session-board', key: 'activity' } as const, { edits: 0, commands: 0 })
const upcoming = atom({ plugin: 'session-board', key: 'upcoming' } as const, [])
const needs = atom({ plugin: 'session-board', key: 'needs' } as const, [])
const spend = atom({ plugin: 'session-board', key: 'spend' } as const, { limits: [] })
const issue = atom({ plugin: 'session-board', key: 'issue' } as const, null as Issue | null)

// The last two parts of a path, enough to say which file without the person's folders
const shortPath = (path: unknown) => String(path ?? '').split('/').slice(-2).join('/') || 'a file'
const oneLine = (text: unknown, max = 60) => {
  const line = (String(text ?? '').split('\n')[0] ?? '').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' }
const money = (usd: number) => (usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(0)}`)
const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// The log outlives the process: saved per session in the store, restored when the session comes back
const STORE_PREFIX = 'board:'
const KEEP_DAYS = 30
type Saved = { done: Done[]; activity: Activity; issue?: Issue | null; savedAt: number }

const save = async ($: EngineInterface) => {
  const saved: Saved = {
    done: await read($, done),
    activity: await read($, activity),
    issue: await read($, issue),
    savedAt: await $.clock.now(),
  }
  await $.store.set(STORE_PREFIX + (await $.session.id()), saved)
}

const restore = async ($: EngineInterface) => {
  const saved = (await $.store.get(STORE_PREFIX + (await $.session.id()))) as Saved | undefined
  if (saved && (await read($, done)).length === 0) {
    await update($, done, () => saved.done)
    await update($, activity, () => saved.activity)
  }
  if (saved?.issue && !(await read($, issue))) {
    await update($, issue, () => saved.issue ?? null)
  }
}

// Drops saved boards of sessions untouched for a month
const prune = async ($: EngineInterface) => {
  const cutoff = (await $.clock.now()) - KEEP_DAYS * 24 * 60 * 60 * 1000
  for (const key of await $.store.keys()) {
    if (!key.startsWith(STORE_PREFIX)) continue
    const saved = (await $.store.get(key)) as Saved | undefined
    if (!saved || saved.savedAt < cutoff) await $.store.delete(key)
  }
}

// Reads a GitHub issue with the person's own gh; null where gh is missing, logged out, or it is not GitHub
const fetchGithubIssue = async ($: EngineInterface, ref: IssueRef): Promise<string | null> => {
  const repo = await $.session.repo()
  if (!ref.number || (!ref.repo && !repo?.remote?.includes('github.com'))) {
    return null
  }
  try {
    const run = await $.process.run(githubIssueArgv(ref), { cwd: repo?.root, timeoutMs: 15000 })
    return run.exitCode === 0 ? run.stdout : null
  } catch {
    return null
  }
}

// Turns an issue's raw text into the few words the board shows
const summarizeIssue = async ($: EngineInterface, text: string, ref: IssueRef | null) => {
  const reply = await $.model.complete({
    model: 'claude-haiku-4-5-20251001',
    prompt: issuePrompt(ref?.key ?? '', text),
    maxTokens: 200,
    timeoutMs: 20000,
  })
  return reply.isAnswered ? parseIssueReply(reply.text, ref) : null
}

// Shows an issue by key at once, then fills in its summary from the tracker when gh can reach it
const followIssue = async ($: EngineInterface, ref: IssueRef) => {
  const current = await read($, issue)
  if (current?.key === ref.key && !current.isPending) {
    return
  }
  await update($, issue, () => ({ key: ref.key, url: ref.url, title: '', summary: '', isPinned: true, isPending: true }))
  const text = await fetchGithubIssue($, ref)
  if (text) {
    await learnIssue($, text, ref, true)
  }
  await save($)
}

// Summarizes an issue's text onto the board, keeping a PR already linked to the same issue
const learnIssue = async ($: EngineInterface, text: string, ref: IssueRef | null, isPinned: boolean) => {
  const summary = await summarizeIssue($, text, ref)
  if (!summary) {
    return
  }
  const at = await $.clock.now()
  await update($, issue, current => {
    // A pinned issue stays until the person names another; Claude reading a different one leaves it
    if (current?.isPinned && !isPinned && current.key !== summary.key) {
      return current
    }
    const pr = current?.key === summary.key ? current.pr : undefined
    return { ...summary, url: summary.url ?? (current?.key === summary.key ? current.url : undefined), pr, isPinned: isPinned || current?.isPinned, at }
  })
  await save($)
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

"done": 0 to 2 results of THIS turn. Each is one past-tense sentence of at most 12 words saying what now exists or works and why it matters, in plain words anyone understands. Describe outcomes, never commands, file names, commit ids or test counts. Good: "Published the mod to GitHub so it installs on any machine". Bad: "Ran git push", "Edited register.tsx". Only things actually finished. Use [] when the turn only answered a question, investigated, or failed.

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
  // The main loop's latest turn, so a summary that lands after a newer turn began is dropped
  let currentTurn = ''
  // This turn's request and what changed during it, read when the turn ends
  let request = ''
  let actions: string[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'board',
      description: 'Show the session board: what got done, what is next, and what needs you',
    })
    await $.command.register({
      name: 'issue',
      description: 'Set the issue the board shows: a number, key or link, pasted issue text, or "clear"',
      argumentHint: '<#123 | ENG-42 | link | text | clear>',
    })
    await restore($)
    const usage = await $.session.usage()
    await update($, spend, () => ({ usd: usage.cost?.usd, limits: usage.rateLimits }))
    void prune($).catch(() => undefined)
    void $.ui.open({ id: PANE, title: 'Session' })

    return next(e)
  })

  // The engine reports when the cost grows or a usage window moves
  on('session.measure', async ($, e, next) => {
    await update($, spend, () => ({ usd: e.cost?.usd, limits: e.rateLimits }))

    return next(e)
  })

  // A /clear starts a new conversation under a new id: start the board over too
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, done, () => [])
      await update($, activity, () => ({ edits: 0, commands: 0 }))
      await update($, needs, () => [])
      await update($, upcoming, () => [])
      await update($, issue, () => null)
      await showNeedCount($)
    }

    return next(e)
  })

  // Another pane (the diff panel, say) closing brings the board back, unless the person closed it
  let closedByPerson = false
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      closedByPerson = e.origin.kind === 'person'
    } else if (!closedByPerson) {
      void $.ui.open({ id: PANE, title: 'Session' })
    }

    return closed
  })

  on('command.run', { command: 'board' }, async $ => {
    closedByPerson = false
    await $.ui.open({ id: PANE, title: 'Session' })

    return { text: 'Session board opened.' }
  })

  on('command.run', { command: 'issue' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await update($, issue, () => null)
      await save($)
      return { text: 'Issue cleared from the board.' }
    }
    if (!arg) {
      const current = await read($, issue)
      return { text: current ? `Board shows ${current.key}: ${current.title || '(details pending)'}` : 'No issue on the board. Try /issue #123.' }
    }
    const ref = findIssueRef(arg.length < 200 ? `issue ${arg}` : arg)
    if (ref && arg.length < 200) {
      void followIssue($, ref).catch(() => undefined)
      return { text: `Board now follows ${ref.key}.` }
    }
    void learnIssue($, arg, ref, true).catch(() => undefined)
    return { text: 'Summarizing that issue onto the board.' }
  })

  // The person acted, so the "your move" items are settled; a prompt naming an issue puts it on the board
  on('prompt.submit', async ($, e, next) => {
    const ref = findIssueRef(e.text)
    if (ref) {
      void followIssue($, ref).catch(() => undefined)
    }
    await dropNeeds($, n => n.id === 'turn' || n.id === 'notify')

    return next(e)
  })

  // Fires only when a permission dialog is really put to the person, never for what a mode decides alone
  on('classic.PermissionRequest', async ($, e, next) => {
    const input = (e.tool_input ?? {}) as Record<string, unknown>
    const subject = input.description ?? input.command ?? input.file_path ?? input.url ?? ''
    await addNeed($, `perm:${e.tool_name}`, `Approve ${e.tool_name}${subject ? `: ${oneLine(subject, 50)}` : ''}`)

    return next(e)
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

      const input = e as unknown as Record<string, unknown>
      if (ran.text && isIssueRead(e.tool, input)) {
        void learnIssue($, ran.text, findIssueRef(`issue ${JSON.stringify(input)}`), false).catch(() => undefined)
      }
      const opensPr =
        (e.tool === 'Bash' && /\bgh\s+pr\s+create\b/.test(e.command)) || /create_?pull_?request/i.test(e.tool)
      const pr = opensPr && ran.text ? findPrUrl(ran.text) : null
      if (pr) {
        await update($, issue, current => (current ? { ...current, pr } : current))
        await save($)
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
      // The call went ahead or was refused: any dialog for it is answered
      await dropNeeds($, n => n.id === id || n.id === `perm:${e.tool}`)
    }
  })

  // Raised for the main loop only, however the turn began: a typed prompt, a wakeup, a task's notice
  on('turn.start', async ($, e, next) => {
    currentTurn = e.turnId
    if (e.text) {
      request = e.text
    }
    await dropNeeds($, n => n.id === 'turn')

    return next(e)
  })

  // Every turn ends here in every kind of session, so the log is written from this
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      return next(e)
    }

    const turnActions = actions
    actions = []
    const turnAtEnd = currentTurn
    const answer = e.reason === 'answer' ? e.answer : ''
    if (answer || turnActions.length) {
      // Summarized in the background so the turn's end is not held up
      void summarizeTurn($, request, turnActions, answer)
        .then(async summary => {
          if (summary.done.length) {
            const at = await $.clock.now()
            await update($, done, list => [...list, ...summary.done.map(text => ({ text, at }))].slice(-50))
          }
          await save($)
          if (summary.ask && answer && currentTurn === turnAtEnd) {
            await addNeed($, 'turn', summary.ask)
          }
        })
        .catch(() => undefined)
    }

    return next(e)
  })

  // Claude Code is waiting on the person (idle, or a permission dialog)
  on('classic.Notification', async ($, e, next) => {
    // Idle reminders repeat what the turn summary already says, so only real dialogs count
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
      await addNeed($, 'notify', oneLine(e.message, 60))
    }

    return next(e)
  })

  // Where settings hooks run, each turn end carries the true list of scheduled and background work
  on('classic.Stop', async ($, e, next) => {
    // The turn is over, so no dialog from it is still open
    await dropNeeds($, n => n.id.startsWith('perm:') || n.id === 'notify')
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
    const cost = await read($, spend)
    const working = await read($, issue)
    // Usage windows only come with a subscription, where the dollar figure is what the API would charge
    const isPlan = cost.limits.some(l => l.kind !== 'spend_limit')

    return (
      <Box flexDirection="column">
        {working && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="cyan">
              {fit(`Working on ${working.key}${working.state ? ` · ${working.state}` : ''}`)}
            </Text>
            {working.isPending ? (
              <Text dimColor wrap="wrap">  Details appear once Claude reads the issue.</Text>
            ) : (
              <>
                <Text wrap="wrap">  {working.title}</Text>
                {working.summary && <Text dimColor wrap="wrap">  {working.summary}</Text>}
              </>
            )}
            {working.pr && <Text color="green">{fit(`  PR #${working.pr.number} opened`)}</Text>}
          </Box>
        )}
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
            <Button
              key="clear"
              label="Clear log"
              onPress={async () => {
                await update($, done, () => [])
                await save($)
              }}
            />
          </Box>
        )}

        <Text> </Text>
        <Text bold>Cost</Text>
        {cost.usd === undefined && <Text dimColor>  No figure yet.</Text>}
        {cost.usd !== undefined && (
          <Text>{fit(`  ${money(cost.usd)} this session${isPlan ? ' (API-equivalent)' : ''}`)}</Text>
        )}
        {cost.limits.map(l => (
          <Text color={l.percentUsed >= 80 ? 'yellow' : undefined} dimColor={l.percentUsed < 80}>
            {fit(
              `  ${LIMIT_NAMES[l.kind] ?? l.kind}: ${Math.round(l.percentUsed)}% used` +
                (l.resetsAt ? `, resets ${clockTime(Date.parse(l.resetsAt))}` : ''),
            )}
          </Text>
        ))}
      </Box>
    )
  })
}
